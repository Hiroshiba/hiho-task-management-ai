import type { GuiEditOperation } from "../../../shared/ipc-contracts/task-values";
import type { TaskDraft } from "./use-task-drafts";
import type { TaskDetail } from "./use-task-read";
import { isoToDatetimeLocal } from "./task-detail-date";
import { durationUnitLabel } from "./task-duration";
import { parentWorkModeLabel, statusLabel } from "./task-presentation";

/** タスクの編集値を下書きへ変換します。 */
export function taskFormDraft(task: TaskDetail): TaskDraft {
  let dueKind: "none" | "due_on" | "due_at";
  let dueValue: string;
  if (task.due.kind === "none") {
    dueKind = "none";
    dueValue = "";
  } else if (task.due.kind === "on") {
    dueKind = "due_on";
    dueValue = task.due.value;
  } else {
    dueKind = "due_at";
    dueValue = isoToDatetimeLocal(task.due.value);
  }
  const durationUnit = task.duration?.unit ?? "none";
  const durationValue = task.duration == null ? "" : String(task.duration.value);
  return {
    editBaselineHash: task.edit_baseline_hash,
    title: task.title,
    notes: task.notes,
    status: task.status,
    importance: task.importance,
    dueKind,
    dueValue,
    durationUnit,
    durationValue,
    area: task.area,
    dependencyText: task.dependencies.map((dependency) => `${dependency.gid}:${dependency.scope}`).join(", "),
    parentGid: task.parent?.gid ?? "",
    parentWorkMode: task.parent_work_mode,
  };
}

/** 下書きとタスクの編集値を比較します。 */
export function draftDiffersFromTask(draft: TaskDraft, task: TaskDetail): boolean {
  const serverDraft = taskFormDraft(task);
  return draft.title !== serverDraft.title
    || draft.notes !== serverDraft.notes
    || draft.status !== serverDraft.status
    || draft.importance !== serverDraft.importance
    || draft.dueKind !== serverDraft.dueKind
    || draft.dueValue !== serverDraft.dueValue
    || draft.durationUnit !== serverDraft.durationUnit
    || draft.durationValue !== serverDraft.durationValue
    || draft.area !== serverDraft.area
    || draft.dependencyText !== serverDraft.dependencyText
    || draft.parentGid !== serverDraft.parentGid
    || draft.parentWorkMode !== serverDraft.parentWorkMode;
}

/** 保存した操作の値を下書きへ反映します。 */
export function applySavedOperation(
  draft: TaskDraft,
  task: TaskDetail,
  operation: GuiEditOperation,
): TaskDraft {
  const serverDraft = taskFormDraft(task);
  const nextDraft = { ...draft, editBaselineHash: task.edit_baseline_hash };
  switch (operation.kind) {
    case "update_title":
      nextDraft.title = serverDraft.title;
      break;
    case "update_notes":
      nextDraft.notes = serverDraft.notes;
      break;
    case "set_status":
    case "complete":
    case "withdraw":
    case "restore":
      nextDraft.status = serverDraft.status;
      break;
    case "set_importance":
      nextDraft.importance = serverDraft.importance;
      break;
    case "set_due":
    case "clear_due":
      nextDraft.dueKind = serverDraft.dueKind;
      nextDraft.dueValue = serverDraft.dueValue;
      break;
    case "set_duration":
    case "clear_duration":
      nextDraft.durationUnit = serverDraft.durationUnit;
      nextDraft.durationValue = serverDraft.durationValue;
      break;
    case "set_area":
      nextDraft.area = serverDraft.area;
      break;
    case "set_dependencies":
      nextDraft.dependencyText = serverDraft.dependencyText;
      break;
    case "set_parent":
      nextDraft.parentGid = serverDraft.parentGid;
      break;
    case "set_parent_work_mode":
      nextDraft.parentWorkMode = serverDraft.parentWorkMode;
      break;
    case "mark_activity":
    case "link_obsidian":
    case "unlink_obsidian":
      break;
  }
  return nextDraft;
}

type StaleDraftEntry = {
  readonly label: string;
  readonly value: string;
};

function staleDraftInput(value: string, emptyLabel: string): string {
  return value.length > 0 ? value : emptyLabel;
}

function staleDraftDue(draft: TaskDraft): string {
  if (draft.dueKind === "none") {
    return "期限なし";
  }
  return staleDraftInput(draft.dueValue, "未入力");
}

function staleDraftDuration(draft: TaskDraft): string {
  if (draft.durationUnit === "none") {
    return "未設定";
  }
  if (draft.durationValue.length === 0) {
    return `${durationUnitLabel(draft.durationUnit)}・未入力`;
  }
  return `${draft.durationValue}${durationUnitLabel(draft.durationUnit)}`;
}

/** 再適用しない下書きの表示項目を返します。 */
export function staleDraftDetails(draft: TaskDraft): readonly StaleDraftEntry[] {
  return [
    { label: "タイトル", value: staleDraftInput(draft.title, "未入力") },
    { label: "説明", value: staleDraftInput(draft.notes, "未入力") },
    { label: "状態", value: statusLabel(draft.status) },
    { label: "重要度", value: String(draft.importance) },
    { label: "期限", value: staleDraftDue(draft) },
    { label: "所要時間", value: staleDraftDuration(draft) },
    { label: "領域", value: staleDraftInput(draft.area, "未設定") },
    { label: "依存関係", value: staleDraftInput(draft.dependencyText, "なし") },
    { label: "親タスク", value: staleDraftInput(draft.parentGid, "なし") },
    { label: "親作業モード", value: parentWorkModeLabel(draft.parentWorkMode) },
  ];
}
