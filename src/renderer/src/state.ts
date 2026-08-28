import { z } from "zod";
import {
  areaSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependenciesSchema,
  dependencyScopeSchema,
  gidSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  parentWorkModeSchema,
  taskStatusSchema,
  type Dependency,
  type Importance,
  type ObsidianLink,
  type ParentWorkMode,
  type TaskStatus,
} from "../../shared/domain";
import {
  setupStateSchema,
  type SetupState,
} from "../../shared/setup";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowProposalViewSchema,
  type AiWorkflowApprovalResult,
  type AiWorkflowProposalView,
} from "../../shared/ai-workflow";
import type {
  ViewModelOverview,
  ViewModelTaskDetail,
  ViewModelTaskRow,
} from "../../shared/view-model";
import { viewModelOverviewSchema } from "../../shared/view-model";

const rendererFailureCodeSchema = z.enum([
  "invalid_request",
  "invalid_response",
  "sender_untrusted",
  "not_configured",
  "operation_failed",
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
  z.object({ kind: z.literal("syncing") }).strict(),
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
  z
    .object({
      kind: z.literal("ready"),
      version: z.string().min(1).max(64),
    })
    .strict(),
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

export const rendererFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("normal") }).strict(),
  z.object({ kind: z.literal("include_full_block") }).strict(),
  z.object({ kind: z.literal("include_completed") }).strict(),
  z.object({ kind: z.literal("include_withdrawn") }).strict(),
  z.object({ kind: z.literal("unclassified") }).strict(),
  z.object({ kind: z.literal("area"), area: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("overdue") }).strict(),
  z.object({ kind: z.literal("completion_confirmation") }).strict(),
  z.object({ kind: z.literal("cleanup") }).strict(),
]);

/** Rendererの一覧フィルターを表す型です。 */
export type RendererFilter = z.infer<typeof rendererFilterSchema>;

export const rendererScreenStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("loading") }).strict(),
  z
    .object({
      kind: z.literal("setup"),
      setup: z.union([setupStateSchema, z.undefined()]),
    })
    .strict(),
  z.object({ kind: z.literal("dashboard") }).strict(),
  z
    .object({
      kind: z.literal("error"),
      failure: rendererFailureSchema,
    })
    .strict(),
]);

/** Renderer全体の画面状態を表す型です。 */
export type RendererScreenState = z.infer<typeof rendererScreenStateSchema>;

const rendererDueValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema }).strict(),
]);

const rendererParentValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
]);

const rendererGuiOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("update_title"),
      value: createUtf8ByteLimitedStringSchema(1_024).refine(
        (value) => value.trim().length > 0,
        "タスク名を空にできません。",
      ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_notes"),
      value: createUtf8ByteLimitedStringSchema(64 * 1024),
    })
    .strict(),
  z.object({ kind: z.literal("set_status"), value: taskStatusSchema }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("withdraw") }).strict(),
  z
    .object({
      kind: z.literal("restore"),
      value: z.enum(["not_started", "in_progress"]),
    })
    .strict(),
  z.object({ kind: z.literal("mark_activity") }).strict(),
  z.object({ kind: z.literal("set_importance"), value: importanceSchema }).strict(),
  z.object({ kind: z.literal("set_due"), value: rendererDueValueSchema }).strict(),
  z.object({ kind: z.literal("clear_due") }).strict(),
  z.object({ kind: z.literal("set_area"), value: areaSchema }).strict(),
  z.object({ kind: z.literal("set_dependencies"), value: dependenciesSchema }).strict(),
  z.object({ kind: z.literal("set_parent"), value: rendererParentValueSchema }).strict(),
  z
    .object({
      kind: z.literal("set_parent_work_mode"),
      value: parentWorkModeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("link_obsidian"), value: obsidianLinkSchema }).strict(),
  z.object({ kind: z.literal("unlink_obsidian"), value: obsidianLinkSchema }).strict(),
]);

/** Rendererから発行するGUI編集要求を検証するスキーマです。 */
export const rendererGuiEditSchema = z
  .object({
    task_gid: gidSchema,
    operation: rendererGuiOperationSchema,
  })
  .strict();

/** Rendererから発行するGUI編集要求の型です。 */
export type RendererGuiEdit = z.infer<typeof rendererGuiEditSchema>;

const rendererQuestionSchema = z
  .object({
    question_id: z.string().min(1).max(256),
    text: rendererMessageSchema,
    options: z.array(rendererMessageSchema).min(2).max(8).optional(),
  })
  .strict();

const rendererPendingProposalSchema = z
  .object({
    message: rendererMessageSchema,
    proposal: aiWorkflowProposalViewSchema,
  })
  .strict();

export const rendererAiStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("idle"),
      pending_proposal: rendererPendingProposalSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("streaming"),
      text: createUtf8ByteLimitedStringSchema(256 * 1024),
      pending_proposal: rendererPendingProposalSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("questions"),
      message: rendererMessageSchema,
      questions: z.array(rendererQuestionSchema).max(8),
      pending_proposal: rendererPendingProposalSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("proposal"),
      message: rendererMessageSchema,
      questions: z.array(rendererQuestionSchema).max(8),
      proposal: aiWorkflowProposalViewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("applied"),
      message: rendererMessageSchema,
      result: aiWorkflowApprovalResultSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      failure: rendererFailureSchema,
      pending_proposal: rendererPendingProposalSchema.optional(),
    })
    .strict(),
]);

/** Rendererが表示するAI状態を表す型です。 */
export type RendererAiState = z.infer<typeof rendererAiStateSchema>;

/** Rendererが扱うAI変更案の型を明示します。 */
export type RendererProposal = AiWorkflowProposalView;

/** Rendererが扱うAI適用結果の型を明示します。 */
export type RendererApprovalResult = AiWorkflowApprovalResult;

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

/** 期限表示値を日本語へ変換します。 */
export function dueLabel(
  due: { readonly kind: "none" }
    | { readonly kind: "on"; readonly value: string }
    | { readonly kind: "at"; readonly value: string },
): string {
  switch (due.kind) {
    case "none":
      return "期限なし";
    case "on":
      return due.value;
    case "at":
      return due.value;
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
  const currentDate = jstCalendarDate(validatedAsOf);
  const targetDate = due.kind === "on" ? dateSchema.parse(due.value) : jstCalendarDate(isoDateTimeSchema.parse(due.value));
  const days = jstDayDifference(targetDate, currentDate);
  if (days === 0) {
    return "本日";
  }
  if (days > 0) {
    return `あと${days}日`;
  }
  return `${Math.abs(days)}日超過`;
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

function isOverdue(
  row: ViewModelTaskRow,
  asOf: string,
): boolean {
  if (row.due.kind === "none") {
    return false;
  }
  if (row.due.kind === "on") {
    return row.due.value < jstCalendarDate(asOf);
  }
  const dueAt = Date.parse(row.due.value);
  const current = Date.parse(asOf);
  if (!Number.isFinite(dueAt) || !Number.isFinite(current)) {
    throw new Error("期限日時を比較できません。");
  }
  return dueAt < current;
}

/** 一覧フィルターを適用して決定論的なタスク行を返します。 */
export function filterTaskRows(
  overview: ViewModelOverview,
  filter: RendererFilter,
  asOf: string,
): readonly ViewModelTaskRow[] {
  const validatedOverview = viewModelOverviewSchema.parse(overview);
  const validatedFilter = rendererFilterSchema.parse(filter);
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

/** 画面状態を初期設定画面へ遷移させます。 */
export function createSetupScreenState(setup: SetupState | undefined): RendererScreenState {
  return rendererScreenStateSchema.parse({ kind: "setup", setup });
}

/** 画面状態を固定エラー画面へ遷移させます。 */
export function createErrorScreenState(
  code: RendererFailure["code"],
  message: string,
): RendererScreenState {
  return rendererScreenStateSchema.parse({
    kind: "error",
    failure: rendererFailureSchema.parse({ kind: "error", code, message }),
  });
}

/** タスク詳細が選択されていない状態を表します。 */
export type RendererSelectedTask = ViewModelTaskDetail | undefined;

/** 重要度の表示値を文字列へ変換します。 */
export function importanceLabel(importance: Importance): string {
  return `重要度${importance}`;
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
