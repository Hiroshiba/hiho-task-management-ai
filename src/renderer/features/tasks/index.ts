import { computed } from "vue";
import { useTasksApi } from "../../shared/api/feature-apis";
import { useTaskRead, type TaskReadOptions } from "./use-task-read";
import { useTaskSync, type TaskSyncOptions } from "./use-task-sync";
import { useTaskDrafts } from "./use-task-drafts";
import { useTaskEdit } from "./use-task-edit";

export { default as TaskFilters } from "./TaskFilters.vue";
export { default as TaskDetail } from "./TaskDetail.vue";
export { default as TaskList } from "./TaskList.vue";
export { default as TaskSort } from "./TaskSort.vue";
export { default as TaskHeaderStatus } from "./TaskHeaderStatus.vue";
export { default as TaskWriteStatus } from "./TaskWriteStatus.vue";
export { default as TaskSyncControls } from "./TaskSyncControls.vue";
export { createMockTasksApi } from "./mock-tasks-api";
export { cleanupKindLabel, cleanupScopeLabel, cleanupRelatedGids } from "./task-presentation";
export type { TaskDataRefreshResult } from "./use-task-read";
export type { TaskDraft, TaskDraftStore, TaskEditMarker } from "./use-task-drafts";

/** タスク閲覧と同期の唯一の画面状態を生成します。 */
export function useTasks(options: Omit<TaskReadOptions, "onTaskFailure" | "onTaskMissing"> & TaskSyncOptions) {
  const api = useTasksApi();
  const read = useTaskRead(api, {
    ...options,
    onTaskFailure: (message) => read.setTaskFeedback("failure", message),
    onTaskMissing: (taskGid) => markTaskMissing(taskGid),
  });
  const sync = useTaskSync(api, read, options);
  const drafts = useTaskDrafts();
  const edit = useTaskEdit(api, read, sync, options);
  const canWriteSelectedTask = computed(() => sync.canAcceptWrite.value && edit.canSubmitSelectedEdit.value);
  const { markTaskMissing, ...editCommands } = edit;
  return { ...read, ...sync, ...editCommands, drafts, canWriteSelectedTask };
}
