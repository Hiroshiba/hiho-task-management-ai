import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependenciesSchema,
  dependencyScopeSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  type Dependency,
  type Importance,
  type ObsidianLink,
  type ParentWorkMode,
  type TaskStatus,
} from "../../shared/domain";
import type {
  ViewModelOverview,
  ViewModelDue,
  ViewModelTaskDetail,
  ViewModelTaskRow,
} from "../../shared/view-model";
import {
  filterTaskRows as sharedFilterTaskRows,
  isTaskDueOverdue,
  taskFilterSchema,
  type TaskFilter,
} from "../../shared/view-model";

class UnreachableError extends Error {
  public constructor() {
    super("到達不能コードに到達しました。");
    this.name = "UnreachableError";
  }
}

const rendererFailureCodeSchema = z.enum([
  "invalid_request",
  "invalid_response",
  "sender_untrusted",
  "not_configured",
  "operation_failed",
  "oauth_invalid_client",
  "oauth_invalid_grant",
  "oauth_token_endpoint_rejected",
  "oauth_network_error",
  "oauth_http_rejected",
  "oauth_service_unavailable",
  "oauth_response_invalid",
  "secure_storage_unavailable",
  "oauth_session_error",
  "aborted",
  "conflict",
  "not_found",
  "authentication_required",
  "unavailable",
]);

const rendererMessageSchema = createUtf8ByteLimitedStringSchema(4 * 1024)
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "表示メッセージを空白だけにできません。",
  });

/** Rendererへ表示する失敗状態を検証するスキーマです。 */
export const rendererFailureSchema = z
  .object({
    kind: z.literal("error"),
    code: rendererFailureCodeSchema,
    message: rendererMessageSchema,
  })
  .strict();

/** Rendererが表示する失敗コードを表す型です。 */
export type RendererFailure = z.infer<typeof rendererFailureSchema>;

const rendererSyncErrorCodeSchema = z.enum([
  "payment_required",
  "rate_limited",
  "http_error",
  "transport_error",
  "response_error",
  "request_aborted",
  "sync_in_progress",
  "unexpected_error",
]);

export const rendererSyncStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting") }).strict(),
  z
    .object({
      kind: z.literal("syncing"),
      can_accept_write: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("synced"),
      synced_at: isoDateTimeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("authentication_required") }).strict(),
  z.object({ kind: z.literal("recovery_pending") }).strict(),
  z
    .object({
      kind: z.literal("error"),
      error_code: rendererSyncErrorCodeSchema,
    })
    .strict(),
]);

/** Rendererが表示する同期状態の型です。 */
export type RendererSyncState = z.infer<typeof rendererSyncStateSchema>;

export const rendererConnectionStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checking"), sync: rendererSyncStateSchema }).strict(),
  z.object({ kind: z.literal("online"), sync: rendererSyncStateSchema }).strict(),
  z.object({ kind: z.literal("offline"), sync: rendererSyncStateSchema }).strict(),
]);

/** Rendererが表示するネットワーク到達性と同期状態を表す型です。 */
export type RendererConnectionState = z.infer<typeof rendererConnectionStateSchema>;

const rendererCodexUnavailableReasonSchema = z.enum([
  "not_installed",
  "incompatible",
  "permission_denied",
  "startup_failed",
  "disabled",
  "stopped",
]);

export const rendererCodexStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("connecting") }).strict(),
  z.object({ kind: z.literal("ready") }).strict(),
  z.object({ kind: z.literal("authentication_required") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: rendererCodexUnavailableReasonSchema,
    })
    .strict(),
]);

/** Rendererが表示するCodex状態の型です。 */
export type RendererCodexState = z.infer<typeof rendererCodexStateSchema>;

export const rendererFilterSchema = taskFilterSchema;

/** Rendererの一覧フィルターを表す型です。 */
export type RendererFilter = TaskFilter;

export const rendererTaskSortSchema = z.enum([
  "execution_order",
  "due_ascending",
  "due_descending",
  "importance_descending",
  "importance_ascending",
  "duration_ascending",
  "duration_descending",
]);

/** Rendererのタスク一覧の並び順を表す型です。 */
export type RendererTaskSort = z.infer<typeof rendererTaskSortSchema>;

/** タスク状態を日本語表示へ変換します。 */
export function statusLabel(status: TaskStatus): string {
  switch (status) {
    case "not_started":
      return "未着手";
    case "in_progress":
      return "進行中";
    case "completed":
      return "完了";
    case "withdrawn":
      return "取り下げ";
  }
}

/** ブロック状態を日本語表示へ変換します。 */
export function blockLabel(blockState: "none" | "partial" | "full"): string {
  switch (blockState) {
    case "none":
      return "なし";
    case "partial":
      return "一部";
    case "full":
      return "完全";
  }
}

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

function jstDayDifference(target: string, current: string): number {
  const targetTimestamp = Date.parse(`${target}T00:00:00+09:00`);
  const currentTimestamp = Date.parse(`${current}T00:00:00+09:00`);
  if (!Number.isFinite(targetTimestamp) || !Number.isFinite(currentTimestamp)) {
    throw new Error("JSTの日付差を計算できません。");
  }
  return Math.trunc((targetTimestamp - currentTimestamp) / 86_400_000);
}

type DeadlineState = "none" | "overdue" | "today" | "future";

type DeadlineTone = "muted" | "overdue" | "today" | "future";

function deadlineState(due: ViewModelDue, asOf: string): DeadlineState {
  if (due.kind === "none") {
    return "none";
  }
  const validatedAsOf = isoDateTimeSchema.parse(asOf);
  if (isTaskDueOverdue(due, validatedAsOf)) {
    return "overdue";
  }
  const currentDate = jstCalendarDate(validatedAsOf);
  const targetDate = due.kind === "on"
    ? dateSchema.parse(due.value)
    : jstCalendarDate(isoDateTimeSchema.parse(due.value));
  return targetDate === currentDate ? "today" : "future";
}

/** 状態と期限から警告色の表示種別を決めます。 */
export function deadlineTone(
  due: ViewModelDue,
  status: TaskStatus,
  asOf: string,
): DeadlineTone {
  const state = deadlineState(due, asOf);
  if (state === "none") {
    return "muted";
  }
  if (status === "completed" || status === "withdrawn") {
    return "muted";
  }
  return state;
}

/** 期限状態に対応する表示色を返します。 */
export function deadlineToneClass(tone: DeadlineTone): string {
  switch (tone) {
    case "muted":
      return "text-slate-500 dark:text-slate-400";
    case "overdue":
      return "rounded-md bg-rose-50 px-2 py-1 text-rose-800 dark:bg-rose-950 dark:text-rose-200";
    case "today":
      return "rounded-md bg-amber-50 px-2 py-1 text-amber-800 dark:bg-amber-950 dark:text-amber-200";
    case "future":
      return "text-slate-700 dark:text-slate-300";
  }
}

/** 重要度に対応する表示色を返します。 */
export function importanceToneClass(importance: Importance): string {
  switch (importance) {
    case 1:
    case 2:
    case 3:
      return "text-slate-800 dark:text-slate-100";
    case 4:
      return "rounded-full bg-indigo-100 px-2 py-0.5 font-semibold text-indigo-800 dark:bg-indigo-950 dark:text-indigo-200";
    case 5:
      return "rounded-full bg-violet-100 px-2 py-0.5 font-semibold text-violet-800 dark:bg-violet-950 dark:text-violet-200";
  }
}

/** 期限をJSTの残日数表示へ変換します。 */
export function dueRelativeLabel(
  due: { readonly kind: "none" }
    | { readonly kind: "on"; readonly value: string }
    | { readonly kind: "at"; readonly value: string },
  asOf: string,
): string {
  if (due.kind === "none") {
    return "";
  }
  const validatedAsOf = isoDateTimeSchema.parse(asOf);
  const overdue = isTaskDueOverdue(due, validatedAsOf);
  const currentDate = jstCalendarDate(validatedAsOf);
  const targetDate = due.kind === "on" ? dateSchema.parse(due.value) : jstCalendarDate(isoDateTimeSchema.parse(due.value));
  const days = jstDayDifference(targetDate, currentDate);
  if (overdue) {
    return days === 0 ? "期限超過" : `期限超過 ${Math.abs(days)}日`;
  }
  if (days === 0) {
    return "期限は本日";
  }
  return `期限まで ${days}日`;
}

/** 一覧フィルターを適用して決定論的なタスク行を返します。 */
export function filterTaskRows(
  overview: ViewModelOverview,
  filter: RendererFilter,
  asOf: string,
): readonly ViewModelOverview["tasks"][number][] {
  return sharedFilterTaskRows(overview, filter, asOf);
}

function effectiveDueEpoch(due: ViewModelDue): number | undefined {
  switch (due.kind) {
    case "none":
      return undefined;
    case "on": {
      const value = dateSchema.parse(due.value);
      const timestamp = Date.parse(`${value}T23:59:59+09:00`);
      if (!Number.isFinite(timestamp)) {
        throw new Error("期限日を実効期限へ変換できません。");
      }
      return timestamp;
    }
    case "at": {
      const value = isoDateTimeSchema.parse(due.value);
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) {
        throw new Error("期限日時を実効期限へ変換できません。");
      }
      return timestamp;
    }
  }
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
  direction: "ascending" | "descending",
): number {
  if (left == null) {
    if (right == null) {
      return 0;
    }
    return 1;
  }
  if (right == null) {
    return -1;
  }
  return direction === "ascending" ? left - right : right - left;
}

function durationUnitOrder(unit: NonNullable<ViewModelTaskRow["duration"]>["unit"]): number {
  switch (unit) {
    case "minute":
      return 0;
    case "hour":
      return 1;
    case "day":
      return 2;
    case "week":
      return 3;
    case "month":
      return 4;
  }
  throw new UnreachableError();
}

function compareTaskRows(
  left: ViewModelTaskRow,
  right: ViewModelTaskRow,
  sort: Exclude<RendererTaskSort, "execution_order">,
): number {
  switch (sort) {
    case "due_ascending":
      return compareOptionalNumbers(
        effectiveDueEpoch(left.due),
        effectiveDueEpoch(right.due),
        "ascending",
      );
    case "due_descending":
      return compareOptionalNumbers(
        effectiveDueEpoch(left.due),
        effectiveDueEpoch(right.due),
        "descending",
      );
    case "importance_descending":
      return right.importance - left.importance;
    case "importance_ascending":
      return left.importance - right.importance;
    case "duration_ascending":
    case "duration_descending": {
      const direction = sort === "duration_ascending" ? "ascending" : "descending";
      const leftDuration = left.duration;
      const rightDuration = right.duration;
      if (leftDuration == null) {
        return rightDuration == null ? 0 : 1;
      }
      if (rightDuration == null) {
        return -1;
      }
      const unitComparison = compareOptionalNumbers(
        durationUnitOrder(leftDuration.unit),
        durationUnitOrder(rightDuration.unit),
        direction,
      );
      if (unitComparison !== 0) {
        return unitComparison;
      }
      return compareOptionalNumbers(leftDuration.value, rightDuration.value, direction);
    }
  }
  throw new UnreachableError();
}

/** タスク行を指定された表示順で複製して返します。 */
export function sortTaskRows(
  rows: readonly ViewModelTaskRow[],
  sort: RendererTaskSort,
): readonly ViewModelTaskRow[] {
  const validatedSort = rendererTaskSortSchema.parse(sort);
  const indexedRows = rows.map((row, index) => ({ row, index }));
  if (validatedSort === "execution_order") {
    return indexedRows.map((entry) => entry.row);
  }
  indexedRows.sort((left, right) => {
    const comparison = compareTaskRows(left.row, right.row, validatedSort);
    return comparison === 0 ? left.index - right.index : comparison;
  });
  return indexedRows.map((entry) => entry.row);
}

/** タスク詳細が選択されていない状態を表します。 */
export type RendererSelectedTask = ViewModelTaskDetail | undefined;

/** 重要度の表示値を文字列へ変換します。 */
export function importanceLabel(importance: Importance): string {
  return `重要度 ${importance}`;
}

/** 親作業モードを日本語表示へ変換します。 */
export function parentWorkModeLabel(mode: ParentWorkMode): string {
  switch (mode) {
    case "children_only":
      return "子タスクのみ";
    case "has_own_work":
      return "親自身の作業あり";
    case "unknown":
      return "不明";
  }
}

/** 依存関係入力を画面イベント用の値へ検証します。 */
export function parseDependencyInput(value: string, current: readonly Dependency[]): Dependency[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const currentByGid = new Map(current.map((dependency) => [dependency.task_gid, dependency]));
  const entries = trimmed.split(",").map((entry) => entry.trim());
  const dependencies = entries.map((entry) => {
    const parts = entry.split(":").map((part) => part.trim());
    const gid = parts[0];
    if (gid == null || gid.length === 0 || parts.length > 2) {
      throw new Error("依存先の入力形式が不正です。");
    }
    const existing = currentByGid.get(gid);
    if (parts.length === 1) {
      if (existing == null) {
        throw new Error("新しい依存先にはfullまたはpartialを指定してください。");
      }
      return existing;
    }
    const scopeValue = parts[1];
    if (scopeValue == null || scopeValue.length === 0) {
      throw new Error("依存先のscopeを指定してください。");
    }
    const scope = dependencyScopeSchema.parse(scopeValue);
    return {
      task_gid: gid,
      scope,
      source: existing?.source ?? "renderer",
    };
  });
  return dependenciesSchema.parse(dependencies);
}

/** Obsidianリンクの編集値を検証します。 */
export function parseObsidianLink(link: ObsidianLink): ObsidianLink {
  return obsidianLinkSchema.parse(link);
}
