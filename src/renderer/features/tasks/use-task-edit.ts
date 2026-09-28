import { computed, onMounted, onUnmounted, ref } from "vue";
import { tasksContracts, type TasksApi } from "../../../shared/ipc-contracts/tasks";
import { executionDtoSchema, type ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { useDiagnosticsApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";
import type { TaskEditMarker } from "./use-task-drafts";
import type { useTaskRead } from "./use-task-read";
import type { useTaskSync } from "./use-task-sync";

type TaskEditInput = Parameters<TasksApi["applyEdit"]>[0];
type FeedbackKind = "success" | "progress" | "warning" | "failure";
type TaskEditOptions = {
  readonly onToast: (kind: "success" | "warning", message: string) => void;
};

function executionMessage(execution: ExecutionDto): { readonly kind: FeedbackKind; readonly text: string } {
  switch (execution.state) {
    case "planned":
    case "running":
      return { kind: "progress", text: `変更を保存しています。実行ID ${execution.execution_id}` };
    case "succeeded":
      return { kind: "success", text: `変更を反映しました。実行ID ${execution.execution_id}` };
    case "failed":
      return { kind: "failure", text: `変更を完了できませんでした。実行ID ${execution.execution_id}、エラーID ${execution.error_id}` };
    case "confirmation_required":
      return { kind: "warning", text: `書き込み結果を確認できません。Asanaの状態を確認してください。実行ID ${execution.execution_id}、エラーID ${execution.error_id}` };
  }
}

function notStartedMessage(result: Extract<Extract<Awaited<ReturnType<TasksApi["applyEdit"]>>, { readonly kind: "ok" }>["value"], { readonly kind: "not_started" }>): string {
  switch (result.reason_code) {
    case "baseline_changed":
      return "最新状態と競合しました。最新内容を確認して編集し直してください。";
    case "relationship_cycle":
      return "関係が循環するため変更を開始できませんでした。";
    case "external_unreadable":
    case "external_identity_mismatch":
      return "タスクの保存情報を確認できず、変更を開始できませんでした。";
    case "offline":
      return "オフラインのため変更を開始できませんでした。";
    case "task_missing":
      return "対象タスクが見つからないため変更を開始できませんでした。";
    case "context_changed":
      return "接続先が変わったため変更を開始できませんでした。";
    case "synchronization_failed":
      return "同期が完了しなかったため変更を開始できませんでした。";
  }
}

/** GUI直接編集の送信、保存済み実行、結果表示を管理します。 */
export function useTaskEdit(api: TasksApi, read: ReturnType<typeof useTaskRead>, sync: ReturnType<typeof useTaskSync>, options: TaskEditOptions) {
  const diagnostics = useDiagnosticsApi();
  const executionInputs = new Map<string, TaskEditInput>();
  const settledExecutionIds = new Set<string>();
  const editStates = ref(new Map<string, "waiting_sync" | "saving">());
  const executions = ref(new Map<string, ExecutionDto>());
  const taskEditMarkers = ref(new Map<string, TaskEditMarker>());
  let markerGeneration = 0;
  let removeExecutionSubscription: (() => void) | undefined;
  let disposed = false;

  const selectedEditState = computed(() => {
    const gid = read.selectedTaskGid.value;
    if (gid == null) return "idle";
    return editStates.value.get(gid) ?? "idle";
  });
  const selectedExecution = computed(() => {
    const gid = read.selectedTaskGid.value;
    return gid == null ? undefined : executions.value.get(gid);
  });
  const selectedExecutionFeedback = computed(() => selectedExecution.value == null
    ? undefined : executionMessage(selectedExecution.value));
  const canSubmitSelectedEdit = computed(() => {
    if (selectedEditState.value !== "idle") return false;
    const execution = selectedExecution.value;
    if (execution?.state === "confirmation_required") return false;
    if (execution?.state === "failed" && execution.operation_results[0]?.outcome === "unknown") return false;
    return true;
  });

  onMounted(() => {
    try {
      removeExecutionSubscription = api.onExecution((value) => {
        void receiveExecution(value).catch(async (error: unknown) => {
          await reportRendererError(diagnostics, error, "error");
          read.setTaskFeedback("failure", "実行状態を確認できませんでした。");
        });
      });
    } catch (error) {
      void reportRendererError(diagnostics, error, "error");
      read.setTaskFeedback("failure", "実行状態を購読できませんでした。");
    }
  });
  onUnmounted(() => {
    disposed = true;
    removeExecutionSubscription?.();
  });

  function setMarker(taskGid: string, update: Omit<Extract<TaskEditMarker, { readonly kind: "saved" }>, "generation"> | { readonly kind: "conflict" } | { readonly kind: "missing" }): void {
    markerGeneration += 1;
    taskEditMarkers.value = new Map(taskEditMarkers.value).set(taskGid, { ...update, generation: markerGeneration });
  }

  function markTaskMissing(taskGid: string): void {
    setMarker(taskGid, { kind: "missing" });
  }

  function show(taskGid: string, kind: FeedbackKind, message: string): void {
    if (disposed) return;
    if (read.selectedTaskGid.value === taskGid) {
      if (kind === "success") {
        read.clearTaskFeedback();
        options.onToast("success", message);
      } else {
        read.setTaskFeedback(kind, message);
      }
      return;
    }
    options.onToast(kind === "success" ? "success" : "warning", message);
  }

  function finish(taskGid: string): void {
    const next = new Map(editStates.value);
    next.delete(taskGid);
    editStates.value = next;
  }

  async function settle(execution: ExecutionDto): Promise<void> {
    if (settledExecutionIds.has(execution.execution_id)) return;
    settledExecutionIds.add(execution.execution_id);
    const taskGid = execution.task_gid;
    if (taskGid == null) throw new Error("GUI編集の実行対象がありません。");
    try {
      const input = executionInputs.get(execution.execution_id);
      let detailConfirmed = execution.state !== "succeeded";
      if (execution.state === "succeeded" && input != null) {
        const detailResult = tasksContracts.getDetail.response.parse(await api.getDetail(taskGid));
        if (detailResult.kind === "ok") {
          setMarker(taskGid, { kind: "saved", operation: input.operation, detail: detailResult.value });
          detailConfirmed = true;
        } else if (detailResult.code === "not_found") {
          markTaskMissing(taskGid);
        }
      } else if (execution.state === "failed" && execution.operation_results[0]?.outcome !== "pending"
        && execution.operation_results[0]?.reason_code === "baseline_changed") {
        setMarker(taskGid, { kind: "conflict" });
      }
      const refresh = await read.reloadTaskData();
      if (execution.state === "failed" || execution.state === "confirmation_required") {
        const message = executionMessage(execution);
        show(taskGid, message.kind, message.text);
      } else if (!detailConfirmed) {
        show(taskGid, "warning", "変更は反映されましたが、最新状態を確認できません。未保存の入力を保持しています。");
      } else if (refresh.kind === "failed") {
        show(taskGid, "warning", "最新のタスク一覧を取得できませんでした。再同期してください。");
      } else {
        const message = executionMessage(execution);
        show(taskGid, message.kind, message.text);
      }
    } catch (error) {
      show(taskGid, "warning", `実行後のタスク状態を確認できません。実行ID ${execution.execution_id}。未保存の入力を保持しています。`);
      throw error;
    } finally {
      finish(taskGid);
    }
  }

  async function receiveExecution(value: ExecutionDto): Promise<void> {
    const execution = executionDtoSchema.parse(value);
    if (execution.origin !== "gui-edit" || execution.task_gid == null) throw new Error("GUI編集以外の実行通知を受け取りました。");
    if (editStates.value.has(execution.task_gid) && !executionInputs.has(execution.execution_id)) return;
    const previous = executions.value.get(execution.task_gid);
    if (previous != null) {
      if (Date.parse(previous.created_at) > Date.parse(execution.created_at)) return;
      if (previous.execution_id === execution.execution_id && Date.parse(previous.updated_at) > Date.parse(execution.updated_at)) return;
      if (previous.execution_id === execution.execution_id
        && (previous.state === "succeeded" || previous.state === "failed" || previous.state === "confirmation_required")
        && (execution.state === "planned" || execution.state === "running")) return;
      if (previous.retry_of_execution_id === execution.execution_id) return;
    }
    executions.value = new Map(executions.value).set(execution.task_gid, execution);
    if (execution.state === "planned" || execution.state === "running") {
      const message = executionMessage(execution);
      show(execution.task_gid, message.kind, message.text);
      return;
    }
    if (executionInputs.has(execution.execution_id)) await settle(execution);
    else {
      await read.reloadTaskData();
      const message = executionMessage(execution);
      show(execution.task_gid, message.kind, message.text);
    }
  }

  async function refreshExecution(executionId: string): Promise<void> {
    const result = tasksContracts.getExecution.response.parse(await api.getExecution(executionId));
    if (result.kind === "error") {
      const input = executionInputs.get(executionId);
      if (input != null) show(input.task_gid, "failure", `${result.message}${result.error_id == null ? "" : ` エラーID ${result.error_id}`}`);
      return;
    }
    await receiveExecution(result.value);
  }

  async function applyEdit(input: TaskEditInput): Promise<void> {
    const request = tasksContracts.applyEdit.request.parse(input);
    if (editStates.value.has(request.task_gid)) {
      show(request.task_gid, "progress", "このタスクの保存が完了するまで追加の編集を待っています。");
      return;
    }
    const previous = executions.value.get(request.task_gid);
    if (previous?.state === "confirmation_required"
      || previous?.state === "failed" && previous.operation_results[0]?.outcome === "unknown") {
      show(request.task_gid, "warning", "前回の書き込み結果を確認してから再試行してください。");
      return;
    }
    if (!sync.canAcceptWrite.value) {
      show(request.task_gid, "warning", "現在は編集できません。同期状態と接続を確認してください。");
      return;
    }
    editStates.value = new Map(editStates.value).set(request.task_gid, sync.syncState.value.kind === "syncing" ? "waiting_sync" : "saving");
    let executionId: string | undefined;
    try {
      const result = tasksContracts.applyEdit.response.parse(await api.applyEdit(request));
      if (result.kind === "error") {
        show(request.task_gid, "failure", `${result.message}${result.error_id == null ? "" : ` エラーID ${result.error_id}`}`);
        finish(request.task_gid);
        return;
      }
      if (result.value.kind === "not_started") {
        if (result.value.outcome === "conflict") setMarker(request.task_gid, { kind: "conflict" });
        if (result.value.reason_code === "task_missing") markTaskMissing(request.task_gid);
        show(request.task_gid, "warning", notStartedMessage(result.value));
        finish(request.task_gid);
        if (result.value.outcome === "conflict") await read.reloadTaskData();
        return;
      }
      executionId = result.value.execution.execution_id;
      executionInputs.set(executionId, request);
      await receiveExecution(result.value.execution);
      await refreshExecution(executionId);
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (executionId == null) {
        show(request.task_gid, "failure", "変更を開始できませんでした。もう一度お試しください。");
        finish(request.task_gid);
      } else if (editStates.value.has(request.task_gid)) {
        show(request.task_gid, "warning", `実行状態を確認できません。実行ID ${executionId} から状態を再確認してください。`);
      }
    }
  }

  async function retryExecution(executionId: string): Promise<void> {
    const sourceResult = tasksContracts.getExecution.response.parse(await api.getExecution(executionId));
    if (sourceResult.kind === "error") {
      read.setTaskFeedback("failure", `${sourceResult.message}${sourceResult.error_id == null ? "" : ` エラーID ${sourceResult.error_id}`}`);
      return;
    }
    const source = sourceResult.value;
    if (source.task_gid == null) throw new Error("GUI編集の再試行対象がありません。");
    if (source.state !== "failed" && source.state !== "confirmation_required") throw new Error("終了していないGUI編集は再試行できません。");
    if (editStates.value.has(source.task_gid)) return;
    editStates.value = new Map(editStates.value).set(source.task_gid, "saving");
    let retryExecutionId: string | undefined;
    try {
      const result = tasksContracts.retryExecution.response.parse(await api.retryExecution(executionId));
      if (result.kind === "error") {
        show(source.task_gid, "failure", `${result.message}${result.error_id == null ? "" : ` エラーID ${result.error_id}`}`);
        finish(source.task_gid);
        return;
      }
      const input = executionInputs.get(executionId);
      if (input != null) executionInputs.set(result.value.execution_id, input);
      retryExecutionId = result.value.execution_id;
      await receiveExecution(result.value);
      await refreshExecution(retryExecutionId);
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (retryExecutionId == null) {
        show(source.task_gid, "failure", "再試行を開始できませんでした。");
        finish(source.task_gid);
      } else if (editStates.value.has(source.task_gid)) {
        show(source.task_gid, "warning", `再試行の実行状態を確認できません。実行ID ${retryExecutionId} から状態を再確認してください。`);
      }
    }
  }

  return { applyEdit, refreshExecution, retryExecution, canSubmitSelectedEdit, selectedEditState, selectedExecution,
    selectedExecutionFeedback, taskEditMarkers, markTaskMissing };
}
