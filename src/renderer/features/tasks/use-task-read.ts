import { computed, onBeforeUnmount, onMounted, onUnmounted, ref } from "vue";
import { tasksContracts, type TasksApi } from "../../../shared/ipc-contracts/tasks";
import type { IpcResult } from "../../../shared/ipc-contracts/common";
import { detailSchema } from "../../../shared/ipc-contracts/task-view";
import type { z } from "zod";
import { useDiagnosticsApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";
import { filterTaskRows, type TaskFilter, type TaskOverview } from "./task-filter";
import { sortTaskRows, taskSortSchema, type TaskSort } from "./task-presentation";

export type TaskDetail = z.infer<typeof detailSchema>;
export type TaskDataRefreshResult =
  | { readonly kind: "applied" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed" };

type ActiveSyncReload =
  | { readonly kind: "idle" }
  | { readonly kind: "initial_loading"; readonly generation: number; readonly completion: Promise<TaskDataRefreshResult> }
  | { readonly kind: "loading"; readonly sync_at: string; readonly generation: number; readonly completion: Promise<TaskDataRefreshResult> };

export type TaskReadOptions = {
  readonly onFailure: (message: string) => void;
  readonly onTaskFailure: (message: string) => void;
  readonly onTaskMissing: (taskGid: string) => void;
};

/** タスク一覧、詳細、選択と読取更新を管理します。 */
export function useTaskRead(api: TasksApi, options: TaskReadOptions) {
  const diagnostics = useDiagnosticsApi();
  const overview = ref<TaskOverview>();
  const selectedTask = ref<TaskDetail>();
  const selectedTaskGid = ref<string>();
  const filter = ref<TaskFilter>({ kind: "normal" });
  const taskSort = ref<TaskSort>(taskSortSchema.parse("execution_order"));
  const currentAsOf = ref(new Date().toISOString());
  const taskFeedback = ref<{ readonly kind: "success" | "progress" | "warning" | "failure"; readonly message: string }>();
  const visibleRows = computed(() => overview.value == null
    ? []
    : sortTaskRows(filterTaskRows(overview.value, filter.value, currentAsOf.value), taskSort.value));
  const taskReferences = computed(() => overview.value?.tasks.map((task) => ({ gid: task.gid, title: task.title })) ?? []);
  let taskDataGeneration = 0;
  let taskDetailGeneration = 0;
  let lastLoadedSuccessfulSyncAt: string | undefined;
  let activeSyncReload: ActiveSyncReload = { kind: "idle" };
  let clockTimer: number | undefined;

  onMounted(() => {
    clockTimer = window.setInterval(() => {
      currentAsOf.value = new Date().toISOString();
    }, 60_000);
  });
  onBeforeUnmount(() => {
    taskDataGeneration += 1;
    taskDetailGeneration += 1;
  });
  onUnmounted(() => {
    if (clockTimer != null) window.clearInterval(clockTimer);
  });

  function setTaskFeedback(kind: "success" | "progress" | "warning" | "failure", message: string): void {
    taskFeedback.value = { kind, message };
  }

  function clearTaskFeedback(): void {
    taskFeedback.value = undefined;
  }

  function clearTaskSelection(): void {
    taskDetailGeneration += 1;
    selectedTaskGid.value = undefined;
    selectedTask.value = undefined;
  }

  function deselectTask(): void {
    clearTaskFeedback();
    clearTaskSelection();
  }

  function captureTaskDetailContext(): { readonly generation: number; readonly taskGid: string } {
    const taskGid = selectedTaskGid.value;
    if (taskGid == null) throw new Error("タスクが選択されていません。");
    return { generation: taskDetailGeneration, taskGid };
  }

  function isCurrentTaskDetailContext(context: { readonly generation: number; readonly taskGid: string }): boolean {
    return context.generation === taskDetailGeneration && selectedTaskGid.value === context.taskGid;
  }

  async function selectTask(taskGid: string): Promise<void> {
    clearTaskFeedback();
    taskDetailGeneration += 1;
    const detailGeneration = taskDetailGeneration;
    selectedTaskGid.value = taskGid;
    selectedTask.value = undefined;
    try {
      await loadSelectedTask(taskGid, detailGeneration);
    } catch (error) {
      const errorId = await reportRendererError(diagnostics, error, "error");
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        options.onTaskFailure(`予期しないエラーが発生しました。もう一度お試しください。${errorId == null ? "" : ` エラーID ${errorId}`}`);
      }
    }
  }

  async function loadSelectedTask(taskGid: string, detailGeneration: number): Promise<void> {
    const result = apiContractDetail(await api.getDetail(taskGid));
    if (result.kind === "error") {
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        options.onTaskFailure(failureMessage(result));
        if (result.code === "not_found") {
          options.onTaskMissing(taskGid);
          setTaskFeedback("warning", "対象タスクが見つかりません。未保存の入力は再適用しません。");
          clearTaskSelection();
        }
      }
      return;
    }
    if (detailGeneration !== taskDetailGeneration || selectedTaskGid.value !== taskGid) return;
    selectedTask.value = result.value;
  }

  function commitOverview(value: TaskOverview): void {
    const previousOverview = overview.value;
    if (previousOverview != null) {
      const nextTaskGids = new Set(value.tasks.map((task) => task.gid));
      for (const previousTask of previousOverview.tasks) {
        if (!nextTaskGids.has(previousTask.gid)) options.onTaskMissing(previousTask.gid);
      }
    }
    overview.value = value;
    lastLoadedSuccessfulSyncAt = value.last_successful_sync_at;
  }

  async function executeTaskDataRefresh(
    generation: number,
    detailGeneration: number,
    taskGid: string | undefined,
  ): Promise<TaskDataRefreshResult> {
    try {
      return await performTaskDataRefresh(generation, detailGeneration, taskGid);
    } catch (error) {
      const errorId = await reportRendererError(diagnostics, error, "error");
      if (generation === taskDataGeneration) options.onFailure(`予期しないエラーが発生しました。もう一度お試しください。${errorId == null ? "" : ` エラーID ${errorId}`}`);
      return { kind: "failed" };
    }
  }

  async function performTaskDataRefresh(
    generation: number,
    detailGeneration: number,
    taskGid: string | undefined,
  ): Promise<TaskDataRefreshResult> {
    const result = apiContractOverview(await api.getOverview());
    if (result.kind === "error") {
      if (generation === taskDataGeneration) options.onFailure(failureMessage(result));
      return { kind: "failed" };
    }
    const nextOverview = result.value;
    if (generation !== taskDataGeneration) return { kind: "superseded" };
    if (taskGid == null) {
      commitOverview(nextOverview);
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value == null) {
        selectedTask.value = undefined;
      }
      return { kind: "applied" };
    }
    if (!nextOverview.tasks.some((task) => task.gid === taskGid)) {
      commitOverview(nextOverview);
      options.onTaskMissing(taskGid);
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        setTaskFeedback("warning", "対象タスクが同期で見つからなくなりました。未保存の入力は再適用しません。");
        clearTaskSelection();
      }
      return { kind: "applied" };
    }
    const detailResult = apiContractDetail(await api.getDetail(taskGid));
    if (detailResult.kind === "error") {
      if (detailResult.code === "not_found") {
        if (generation !== taskDataGeneration) return { kind: "superseded" };
        commitOverview(nextOverview);
        options.onTaskMissing(taskGid);
        if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
          setTaskFeedback("warning", "対象タスクが同期で見つからなくなりました。未保存の入力は再適用しません。");
          clearTaskSelection();
        }
        return { kind: "applied" };
      }
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) options.onTaskFailure(failureMessage(detailResult));
      return { kind: "failed" };
    }
    if (generation !== taskDataGeneration) return { kind: "superseded" };
    commitOverview(nextOverview);
    if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
      selectedTask.value = detailResult.value;
    }
    return { kind: "applied" };
  }

  function startTaskDataRefresh(): { readonly generation: number; readonly completion: Promise<TaskDataRefreshResult> } {
    taskDataGeneration += 1;
    taskDetailGeneration += 1;
    const generation = taskDataGeneration;
    return { generation, completion: executeTaskDataRefresh(generation, taskDetailGeneration, selectedTaskGid.value) };
  }

  async function reloadTaskData(): Promise<TaskDataRefreshResult> {
    activeSyncReload = { kind: "idle" };
    return startTaskDataRefresh().completion;
  }

  function startInitialTaskDataRefresh(): Promise<TaskDataRefreshResult> {
    const request = startTaskDataRefresh();
    activeSyncReload = { kind: "initial_loading", generation: request.generation, completion: request.completion };
    void finalizeSyncReload(request.generation, request.completion);
    return request.completion;
  }

  function syncTimestamp(value: string): number {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error("同期日時を比較できません。");
    return timestamp;
  }

  function loadedAtOrAfter(syncAt: string): boolean {
    return lastLoadedSuccessfulSyncAt != null && syncTimestamp(lastLoadedSuccessfulSyncAt) >= syncTimestamp(syncAt);
  }

  async function finalizeSyncReload(generation: number, completion: Promise<TaskDataRefreshResult>): Promise<void> {
    try {
      await completion;
    } finally {
      if (activeSyncReload.kind !== "idle" && activeSyncReload.generation === generation && activeSyncReload.completion === completion) {
        activeSyncReload = { kind: "idle" };
      }
    }
  }

  async function completeInitialSyncReload(syncAt: string, generation: number, completion: Promise<TaskDataRefreshResult>): Promise<TaskDataRefreshResult> {
    const result = await completion;
    if (taskDataGeneration !== generation) return reloadTaskDataAfterSuccessfulSync(syncAt);
    if (result.kind !== "applied" || loadedAtOrAfter(syncAt)) return result;
    const request = startTaskDataRefresh();
    activeSyncReload = { kind: "loading", sync_at: syncAt, generation: request.generation, completion: request.completion };
    void finalizeSyncReload(request.generation, request.completion);
    return request.completion;
  }

  function reloadTaskDataAfterSuccessfulSync(syncAt: string): Promise<TaskDataRefreshResult> {
    if (loadedAtOrAfter(syncAt)) return Promise.resolve({ kind: "unchanged" });
    if (activeSyncReload.kind === "loading" && syncTimestamp(activeSyncReload.sync_at) >= syncTimestamp(syncAt)) return activeSyncReload.completion;
    if (activeSyncReload.kind === "initial_loading" && lastLoadedSuccessfulSyncAt == null) {
      const { generation, completion } = activeSyncReload;
      const followingCompletion = completeInitialSyncReload(syncAt, generation, completion);
      activeSyncReload = { kind: "loading", sync_at: syncAt, generation, completion: followingCompletion };
      void finalizeSyncReload(generation, followingCompletion);
      return followingCompletion;
    }
    const request = startTaskDataRefresh();
    activeSyncReload = { kind: "loading", sync_at: syncAt, generation: request.generation, completion: request.completion };
    void finalizeSyncReload(request.generation, request.completion);
    return request.completion;
  }

  return { overview, selectedTask, selectedTaskGid, filter, taskSort, currentAsOf, taskFeedback,
    visibleRows, taskReferences, setTaskFeedback, clearTaskFeedback, captureTaskDetailContext, isCurrentTaskDetailContext,
    selectTask, deselectTask, reloadTaskData, startInitialTaskDataRefresh,
    reloadTaskDataAfterSuccessfulSync };
}

function apiContractOverview(value: Awaited<ReturnType<TasksApi["getOverview"]>>) {
  return tasksContracts.getOverview.response.parse(value);
}

function apiContractDetail(value: Awaited<ReturnType<TasksApi["getDetail"]>>) {
  return tasksContracts.getDetail.response.parse(value);
}

function failureMessage(failure: Extract<IpcResult<unknown>, { readonly kind: "error" }>): string {
  return `${failure.message}${failure.error_id == null ? "" : ` エラーID ${failure.error_id}`}`;
}
