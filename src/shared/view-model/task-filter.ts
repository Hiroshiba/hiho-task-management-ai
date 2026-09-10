import { z } from "zod";
import {
  areaSchema,
  isoDateTimeSchema,
} from "../domain";
import {
  viewModelOverviewSchema,
  type ViewModelOverview,
  type ViewModelDue,
  type ViewModelTaskRow,
} from "./schemas";

export const taskFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("normal") }).strict(),
  z.object({ kind: z.literal("include_full_block") }).strict(),
  z.object({ kind: z.literal("include_completed") }).strict(),
  z.object({ kind: z.literal("include_withdrawn") }).strict(),
  z.object({ kind: z.literal("unclassified") }).strict(),
  z.object({ kind: z.literal("area"), area: areaSchema }).strict(),
  z.object({ kind: z.literal("overdue") }).strict(),
  z.object({ kind: z.literal("completion_confirmation") }).strict(),
  z.object({ kind: z.literal("cleanup") }).strict(),
]);

export type TaskFilter = z.infer<typeof taskFilterSchema>;

function jstCalendarDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("日時をJSTの日付へ変換できません。");
  }
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Tokyo",
      year: "numeric",
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  if (year == null || month == null || day == null) {
    throw new Error("JSTの日付を取得できません。");
  }
  return `${year}-${month}-${day}`;
}

function hasReason(row: ViewModelTaskRow, code: string): boolean {
  if (row.block_reason?.code === code) {
    return true;
  }
  if (row.kind !== "excluded") {
    return false;
  }
  return row.exclusion_reasons.some((reason) => reason.code === code);
}

/** due_onとdue_atが基準時刻より前かを期限境界で判定します。 */
export function isTaskDueOverdue(due: ViewModelDue, asOf: string): boolean {
  const validatedAsOf = isoDateTimeSchema.parse(asOf);
  if (due.kind === "none") {
    return false;
  }
  if (due.kind === "on") {
    return due.value < jstCalendarDate(validatedAsOf);
  }
  const dueAt = Date.parse(due.value);
  const current = Date.parse(validatedAsOf);
  if (!Number.isFinite(dueAt) || !Number.isFinite(current)) {
    throw new Error("期限日時を比較できません。");
  }
  return dueAt < current;
}

function isOverdue(row: ViewModelTaskRow, asOf: string): boolean {
  return isTaskDueOverdue(row.due, asOf);
}

/** タスク一覧へ既存画面と同じフィルターを適用します。 */
export function filterTaskRows(
  overview: ViewModelOverview,
  filter: TaskFilter,
  asOf: string,
): readonly ViewModelTaskRow[] {
  const validatedOverview = viewModelOverviewSchema.parse(overview);
  const validatedFilter = taskFilterSchema.parse(filter);
  const validatedAsOf = isoDateTimeSchema.parse(asOf);
  return validatedOverview.tasks.filter((row) => {
    switch (validatedFilter.kind) {
      case "normal":
        return row.kind === "ranked";
      case "include_full_block":
        return row.kind === "ranked" || row.block_state === "full";
      case "include_completed":
        return row.kind === "ranked" || row.status === "completed";
      case "include_withdrawn":
        return row.kind === "ranked" || row.status === "withdrawn";
      case "unclassified":
        return row.area === "未分類";
      case "area":
        return row.area === validatedFilter.area;
      case "overdue":
        return isOverdue(row, validatedAsOf);
      case "completion_confirmation":
        return hasReason(row, "completion_confirmation");
      case "cleanup":
        return row.kind === "unavailable" || row.warning_count > 0;
    }
  });
}
