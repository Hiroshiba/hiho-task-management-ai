import { ref } from "vue";
import type { GuiEditOperation } from "../../../shared/ipc-contracts/task-values";
import type { TaskDetail } from "./use-task-read";

export type TaskDraft = {
  readonly editBaselineHash: string;
  readonly title: string;
  readonly notes: string;
  readonly status: "not_started" | "in_progress" | "completed" | "withdrawn";
  readonly importance: 1 | 2 | 3 | 4 | 5;
  readonly dueKind: "none" | "due_on" | "due_at";
  readonly dueValue: string;
  readonly durationUnit: "none" | "minute" | "hour" | "day" | "week" | "month";
  readonly durationValue: string;
  readonly area: string;
  readonly dependencyText: string;
  readonly parentGid: string;
  readonly parentWorkMode: "children_only" | "has_own_work" | "unknown";
};

export type TaskEditMarker =
  | { readonly kind: "saved"; readonly generation: number; readonly operation: GuiEditOperation; readonly detail: TaskDetail }
  | { readonly kind: "conflict"; readonly generation: number }
  | { readonly kind: "missing"; readonly generation: number };

/** タスクごとの未保存入力と再適用できない入力を保持します。 */
export function useTaskDrafts() {
  const drafts = new Map<string, TaskDraft>();
  const staleDrafts = ref(new Map<string, TaskDraft>());
  const acknowledgedConflicts = ref(new Map<string, number>());
  const processedMarkers = new Map<string, number>();

  function get(taskGid: string): TaskDraft | undefined {
    return drafts.get(taskGid);
  }

  function set(taskGid: string, draft: TaskDraft): void {
    drafts.set(taskGid, draft);
  }

  function remove(taskGid: string): void {
    drafts.delete(taskGid);
  }

  function moveToStale(taskGid: string): void {
    const draft = drafts.get(taskGid);
    if (draft == null) return;
    staleDrafts.value = new Map(staleDrafts.value).set(taskGid, draft);
    drafts.delete(taskGid);
  }

  function markProcessed(taskGid: string, generation: number): boolean {
    const previous = processedMarkers.get(taskGid);
    if (previous != null && previous >= generation) return false;
    processedMarkers.set(taskGid, generation);
    return true;
  }

  function acknowledgeConflict(taskGid: string, generation: number): void {
    acknowledgedConflicts.value = new Map(acknowledgedConflicts.value).set(taskGid, generation);
  }

  return { get, set, remove, moveToStale, markProcessed, acknowledgeConflict, staleDrafts, acknowledgedConflicts };
}

export type TaskDraftStore = ReturnType<typeof useTaskDrafts>;
