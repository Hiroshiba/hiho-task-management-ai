import { z } from "zod";
import { setupSectionGidsSchema } from "../../../domain/setup-state";
import { gidSchema, identifierSchema, isoDateTimeSchema } from "../../../domain";
import {
  asanaSyncNormalizationNotificationsSchema,
  type AsanaSyncCoordinatorResult,
} from "../sync";

const synchronizationModeSchema = z.enum(["full", "delta"]);
const runtimeErrorCodeSchema = z.enum([
  "authentication_required",
  "payment_required",
  "rate_limited",
  "http_error",
  "transport_error",
  "response_error",
  "events_reset",
  "request_aborted",
  "sync_in_progress",
  "unexpected_error",
]);
const runtimeRejectionReasonSchema = z.enum(["offline", "stopped"]);

const runtimeConfigurationSchema = z
  .object({
    project_gid: gidSchema,
    section_gids: setupSectionGidsSchema,
    device_id: identifierSchema,
    app_version: identifierSchema,
    initial_online: z.boolean(),
  })
  .strict();

const stateBaseShape = {
  last_successful_sync_at: isoDateTimeSchema.optional(),
  last_error_code: runtimeErrorCodeSchema.optional(),
};

const onlineStateSchema = z
  .object({
    kind: z.literal("online"),
    normalization_notifications: asanaSyncNormalizationNotificationsSchema.optional(),
    ...stateBaseShape,
  })
  .strict();
const offlineStateSchema = z
  .object({ kind: z.literal("offline"), ...stateBaseShape })
  .strict();
const syncingStateSchema = z
  .object({
    kind: z.literal("syncing"),
    requested_mode: synchronizationModeSchema,
    ...stateBaseShape,
  })
  .strict();
const authenticationRequiredStateSchema = z
  .object({
    kind: z.literal("authentication_required"),
    error_code: z.literal("authentication_required"),
    last_successful_sync_at: isoDateTimeSchema.optional(),
  })
  .strict();
const errorStateSchema = z
  .object({
    kind: z.literal("error"),
    error_code: runtimeErrorCodeSchema,
    last_successful_sync_at: isoDateTimeSchema.optional(),
  })
  .strict();

const runtimeStateSchema = z.discriminatedUnion("kind", [
  onlineStateSchema,
  offlineStateSchema,
  syncingStateSchema,
  authenticationRequiredStateSchema,
  errorStateSchema,
]);

const rejectedResultSchema = z
  .object({
    kind: z.literal("rejected"),
    reason: runtimeRejectionReasonSchema,
  })
  .strict();
const abortedResultSchema = z
  .object({ kind: z.literal("aborted"), reason: z.literal("aborted") })
  .strict();
const failedResultSchema = z
  .object({
    kind: z.literal("failed"),
    error_code: runtimeErrorCodeSchema,
  })
  .strict();

/** Asana同期結果の検証を注入してランタイム結果を作ります。 */
function createAsanaSyncRuntimeResultSchema(
  coordinatorResultSchema: z.ZodType<AsanaSyncCoordinatorResult>,
) {
  const synchronizedResultSchema = z.object({
    kind: z.literal("synchronized"),
    requested_mode: synchronizationModeSchema,
    performed_mode: synchronizationModeSchema,
    synced_at: isoDateTimeSchema,
    result: coordinatorResultSchema,
  }).strict();
  return z.discriminatedUnion("kind", [
    synchronizedResultSchema,
    rejectedResultSchema,
    abortedResultSchema,
    failedResultSchema,
  ]);
}

export type AsanaSyncRuntimeConfiguration = z.infer<
  typeof runtimeConfigurationSchema
>;
export type AsanaSyncRuntimeState = z.infer<typeof runtimeStateSchema>;
export type AsanaSyncRuntimeResult = z.infer<ReturnType<typeof createAsanaSyncRuntimeResultSchema>>;
export type AsanaSyncRuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;
export type AsanaSyncRuntimeRejectionReason = z.infer<
  typeof runtimeRejectionReasonSchema
>;
export type AsanaSyncRuntimeSynchronizationMode = z.infer<
  typeof synchronizationModeSchema
>;
export type AsanaSyncRuntimeInternalResult =
  | Exclude<AsanaSyncRuntimeResult, { kind: "failed" }>
  | (Extract<AsanaSyncRuntimeResult, { kind: "failed" }> & {
      readonly cause: unknown;
    });

/** Asana同期ランタイムの設定を検証するスキーマです。 */
export const asanaSyncRuntimeConfigurationSchema = runtimeConfigurationSchema;

/** Asana同期ランタイムの状態を検証するスキーマです。 */
export const asanaSyncRuntimeStateSchema = runtimeStateSchema;

/** Asana同期ランタイムのエラーコードを検証するスキーマです。 */
export const asanaSyncRuntimeErrorCodeSchema = runtimeErrorCodeSchema;

/** 同期中断結果を検証して作成します。 */
export function createAbortResult(): AsanaSyncRuntimeInternalResult {
  const result = abortedResultSchema.parse({
    kind: "aborted",
    reason: "aborted",
  });
  if (result.kind !== "aborted") {
    throw new Error("同期中断結果の種別が不正です。");
  }
  return result;
}

/** 同期拒否結果を検証して作成します。 */
export function createRejectedResult(
  reason: "offline" | "stopped",
): AsanaSyncRuntimeInternalResult {
  const result = rejectedResultSchema.parse({
    kind: "rejected",
    reason,
  });
  if (result.kind !== "rejected") {
    throw new Error("同期拒否結果の種別が不正です。");
  }
  return result;
}

/** 同期失敗結果を検証して作成します。 */
export function createFailedResult(
  errorCode: AsanaSyncRuntimeErrorCode,
  cause: unknown,
): AsanaSyncRuntimeInternalResult {
  const result = failedResultSchema.parse({
    kind: "failed",
    error_code: errorCode,
  });
  if (result.kind !== "failed") {
    throw new Error("同期失敗結果の種別が不正です。");
  }
  return { ...result, cause };
}

/** 同期成功結果を検証して作成します。 */
export function createSynchronizedResult(
  requestedMode: AsanaSyncRuntimeSynchronizationMode,
  result: AsanaSyncCoordinatorResult,
  coordinatorResultSchema: z.ZodType<AsanaSyncCoordinatorResult>,
): AsanaSyncRuntimeInternalResult {
  const synchronized = createAsanaSyncRuntimeResultSchema(coordinatorResultSchema).parse({
    kind: "synchronized",
    requested_mode: requestedMode,
    performed_mode: result.performed_mode,
    synced_at: result.synced_at,
    result,
  });
  if (synchronized.kind !== "synchronized") {
    throw new Error("同期成功結果の種別が不正です。");
  }
  return synchronized;
}

/** オンライン状態を検証して作成します。 */
export function createOnlineRuntimeState(
  lastSuccessfulSyncAt: string | undefined,
  lastErrorCode: AsanaSyncRuntimeErrorCode | undefined,
  normalizationNotifications:
    AsanaSyncCoordinatorResult["normalization_notifications"] | undefined,
): AsanaSyncRuntimeState {
  return asanaSyncRuntimeStateSchema.parse({
    kind: "online",
    ...(normalizationNotifications == null
      ? {}
      : { normalization_notifications: normalizationNotifications }),
    ...(lastSuccessfulSyncAt == null
      ? {}
      : { last_successful_sync_at: lastSuccessfulSyncAt }),
    ...(lastErrorCode == null
      ? {}
      : { last_error_code: lastErrorCode }),
  });
}

/** オフライン状態を検証して作成します。 */
export function createOfflineRuntimeState(
  lastSuccessfulSyncAt: string | undefined,
  lastErrorCode: AsanaSyncRuntimeErrorCode | undefined,
): AsanaSyncRuntimeState {
  return asanaSyncRuntimeStateSchema.parse({
    kind: "offline",
    ...(lastSuccessfulSyncAt == null
      ? {}
      : { last_successful_sync_at: lastSuccessfulSyncAt }),
    ...(lastErrorCode == null
      ? {}
      : { last_error_code: lastErrorCode }),
  });
}

/** 同期中状態を検証して作成します。 */
export function createSyncingRuntimeState(
  lastSuccessfulSyncAt: string | undefined,
  lastErrorCode: AsanaSyncRuntimeErrorCode | undefined,
  mode: AsanaSyncRuntimeSynchronizationMode,
): AsanaSyncRuntimeState {
  return asanaSyncRuntimeStateSchema.parse({
    kind: "syncing",
    requested_mode: mode,
    ...(lastSuccessfulSyncAt == null
      ? {}
      : { last_successful_sync_at: lastSuccessfulSyncAt }),
    ...(lastErrorCode == null
      ? {}
      : { last_error_code: lastErrorCode }),
  });
}

/** 認証要求状態を検証して作成します。 */
export function createAuthenticationRequiredRuntimeState(
  lastSuccessfulSyncAt: string | undefined,
): AsanaSyncRuntimeState {
  return asanaSyncRuntimeStateSchema.parse({
    kind: "authentication_required",
    error_code: "authentication_required",
    ...(lastSuccessfulSyncAt == null
      ? {}
      : { last_successful_sync_at: lastSuccessfulSyncAt }),
  });
}

/** エラー状態を検証して作成します。 */
export function createErrorRuntimeState(
  lastSuccessfulSyncAt: string | undefined,
  errorCode: AsanaSyncRuntimeErrorCode,
): AsanaSyncRuntimeState {
  return asanaSyncRuntimeStateSchema.parse({
    kind: "error",
    error_code: errorCode,
    ...(lastSuccessfulSyncAt == null
      ? {}
      : { last_successful_sync_at: lastSuccessfulSyncAt }),
  });
}
