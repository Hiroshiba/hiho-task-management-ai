import { useTasksApi } from "../../shared/api/feature-apis";
import { useTaskRead, type TaskReadOptions } from "./use-task-read";
import { useTaskSync, type TaskSyncOptions } from "./use-task-sync";

export { default as TaskFilters } from "./TaskFilters.vue";
export { default as TaskList } from "./TaskList.vue";
export { default as TaskSort } from "./TaskSort.vue";
export { createMockTasksApi } from "./mock-tasks-api";
export { cleanupKindLabel, cleanupScopeLabel, cleanupRelatedGids } from "./task-presentation";
export type { TaskDetail, TaskDataRefreshResult } from "./use-task-read";

/** タスク閲覧と同期の唯一の画面状態を生成します。 */
export function useTasks(options: TaskReadOptions & TaskSyncOptions) {
  const api = useTasksApi();
  const read = useTaskRead(api, options);
  const sync = useTaskSync(api, read, options);
  return { ...read, ...sync, getDetail: api.getDetail };
}
