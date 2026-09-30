import { z } from "zod";
import { dateSchema, dateTimeSchema } from "../../../shared/ipc-contracts/common";
import { taskStatusSchema } from "../../../shared/ipc-contracts/task-values";
import { isTaskDueOverdue, jstCalendarDate, type TaskDue, type TaskOverview, type TaskRow } from "./task-filter";

export const taskSortSchema = z.enum([
  "execution_order",
  "due_ascending",
  "due_descending",
  "importance_descending",
  "importance_ascending",
  "duration_ascending",
  "duration_descending",
]);
export type TaskSort = z.infer<typeof taskSortSchema>;

/** タスク状態を日本語で表示します。 */
export function statusLabel(status: z.infer<typeof taskStatusSchema>): string {
  switch (status) {
    case "not_started": return "未着手";
    case "in_progress": return "進行中";
    case "completed": return "完了";
    case "withdrawn": return "取り下げ";
  }
}

/** ブロック状態を日本語で表示します。 */
export function blockLabel(blockState: TaskRow["block_state"]): string {
  switch (blockState) {
    case "none": return "なし";
    case "partial": return "一部";
    case "full": return "完全";
  }
}

type DeadlineTone = "muted" | "overdue" | "today" | "future";

/** 期限と完了状態に応じた表示色を選びます。 */
export function deadlineTone(due: TaskDue, status: TaskRow["status"], asOf: string): DeadlineTone {
  if (due.kind === "none" || status === "completed" || status === "withdrawn") return "muted";
  if (isTaskDueOverdue(due, asOf)) return "overdue";
  const currentDate = jstCalendarDate(asOf);
  const targetDate = due.kind === "on" ? dateSchema.parse(due.value) : jstCalendarDate(due.value);
  return targetDate === currentDate ? "today" : "future";
}

/** 期限の表示色を返します。 */
export function deadlineToneClass(tone: DeadlineTone): string {
  switch (tone) {
    case "muted": return "text-slate-500 dark:text-slate-400";
    case "overdue": return "rounded-md bg-rose-50 px-2 py-1 text-rose-800 dark:bg-rose-950 dark:text-rose-200";
    case "today": return "rounded-md bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200";
    case "future": return "text-slate-700 dark:text-slate-300";
  }
}

/** 重要度の表示色を返します。 */
export function importanceToneClass(importance: TaskRow["importance"]): string {
  switch (importance) {
    case 1:
    case 2:
    case 3: return "text-slate-800 dark:text-slate-100";
    case 4: return "rounded-full bg-indigo-100 px-2 py-0.5 font-semibold text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200";
    case 5: return "rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200";
    default: throw new Error("重要度が不正です。");
  }
}

/** 期限までの日数を日本時間で表示します。 */
export function dueRelativeLabel(due: TaskDue, asOf: string): string {
  if (due.kind === "none") return "";
  const currentDate = jstCalendarDate(asOf);
  const targetDate = due.kind === "on" ? dateSchema.parse(due.value) : jstCalendarDate(due.value);
  const currentTimestamp = Date.parse(`${currentDate}T00:00:00+09:00`);
  const targetTimestamp = Date.parse(`${targetDate}T00:00:00+09:00`);
  const days = Math.trunc((targetTimestamp - currentTimestamp) / 86_400_000);
  if (isTaskDueOverdue(due, asOf)) return days === 0 ? "期限超過" : `期限超過 ${Math.abs(days)}日`;
  return days === 0 ? "期限は本日" : `期限まで ${days}日`;
}

/** 所要時間を数値と単位で表示します。 */
export function durationLabel(duration: NonNullable<TaskRow["duration"]>): string {
  const units = { minute: "分", hour: "時間", day: "日", week: "週間", month: "ヶ月" };
  return `${duration.value}${units[duration.unit]}`;
}

/** 親作業モードを日本語で表示します。 */
export function parentWorkModeLabel(mode: "children_only" | "has_own_work" | "unknown"): string {
  switch (mode) {
    case "children_only": return "子タスクのみ";
    case "has_own_work": return "親自身の作業あり";
    case "unknown": return "不明";
  }
}

/** 要整理項目の種類を日本語で表示します。 */
export function cleanupKindLabel(kind: TaskOverview["cleanup_items"][number]["kind"]): string {
  switch (kind) {
    case "importance_tag_conflict": return "重要度タグの競合";
    case "area_tag_conflict": return "領域タグの競合";
    case "unknown_status_section": return "不明な状態セクション";
    case "missing_required_section": return "必須セクション不足";
    case "dependency_cycle": return "依存関係の循環";
    case "missing_dependency": return "依存先の欠落";
    case "parent_cycle": return "親子関係の循環";
    case "parent_relation_conflict": return "親子関係の矛盾";
    case "children_only_completion_confirmation": return "子タスク完了確認";
    case "missing_task": return "タスクの欠落";
    case "custom_external_data_broken": return "外部データ破損";
    case "oauth_app_mismatch": return "OAuthアプリ不一致";
    case "proposal_conflict": return "変更案の競合";
    case "broken_vault_link": return "Vaultリンク破損";
  }
}

/** 要整理項目の対象を表示します。 */
export function cleanupScopeLabel(item: TaskOverview["cleanup_items"][number]): string {
  return item.scope.scope === "task" ? `タスク ${item.scope.task_gid}` : "全体";
}

/** 要整理項目に関連するタスクを表示します。 */
export function cleanupRelatedGids(item: TaskOverview["cleanup_items"][number]): string {
  const gids = item.scope.related_task_gids;
  return gids == null || gids.length === 0 ? "" : `関連: ${gids.join("、")}`;
}

function effectiveDueEpoch(due: TaskDue): number | undefined {
  if (due.kind === "none") return undefined;
  if (due.kind === "on") return Date.parse(`${dateSchema.parse(due.value)}T23:59:59+09:00`);
  return Date.parse(dateTimeSchema.parse(due.value));
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined, direction: "ascending" | "descending"): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return direction === "ascending" ? left - right : right - left;
}

function durationUnitOrder(unit: NonNullable<TaskRow["duration"]>["unit"]): number {
  switch (unit) {
    case "minute": return 0;
    case "hour": return 1;
    case "day": return 2;
    case "week": return 3;
    case "month": return 4;
  }
}

function compareTaskRows(left: TaskRow, right: TaskRow, sort: Exclude<TaskSort, "execution_order">): number {
  switch (sort) {
    case "due_ascending": return compareOptionalNumbers(effectiveDueEpoch(left.due), effectiveDueEpoch(right.due), "ascending");
    case "due_descending": return compareOptionalNumbers(effectiveDueEpoch(left.due), effectiveDueEpoch(right.due), "descending");
    case "importance_descending": return right.importance - left.importance;
    case "importance_ascending": return left.importance - right.importance;
    case "duration_ascending":
    case "duration_descending": {
      const direction = sort === "duration_ascending" ? "ascending" : "descending";
      const leftDuration = left.duration;
      const rightDuration = right.duration;
      if (leftDuration == null) return rightDuration == null ? 0 : 1;
      if (rightDuration == null) return -1;
      const units = compareOptionalNumbers(durationUnitOrder(leftDuration.unit), durationUnitOrder(rightDuration.unit), direction);
      return units === 0 ? compareOptionalNumbers(leftDuration.value, rightDuration.value, direction) : units;
    }
  }
}

/** タスク行を表示順で並べた複製を返します。 */
export function sortTaskRows(rows: readonly TaskRow[], sort: TaskSort): readonly TaskRow[] {
  const validatedSort = taskSortSchema.parse(sort);
  const indexedRows = rows.map((row, index) => ({ row, index }));
  if (validatedSort === "execution_order") return indexedRows.map((entry) => entry.row);
  indexedRows.sort((left, right) => {
    const comparison = compareTaskRows(left.row, right.row, validatedSort);
    return comparison === 0 ? left.index - right.index : comparison;
  });
  return indexedRows.map((entry) => entry.row);
}
