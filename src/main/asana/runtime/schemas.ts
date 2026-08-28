import { z } from "zod";
import { deviceSectionGidsSchema } from "../../../shared/storage";
import { gidSchema, identifierSchema, isoDateTimeSchema } from "../../../shared/domain";
import {
  asanaSyncCoordinatorResultSchema,
  asanaSyncNormalizationNotificationsSchema,
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
    section_gids: deviceSectionGidsSchema,
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

const synchronizedResultSchema = z
  .object({
    kind: z.literal("synchronized"),
    requested_mode: synchronizationModeSchema,
    performed_mode: synchronizationModeSchema,
    synced_at: isoDateTimeSchema,
    result: asanaSyncCoordinatorResultSchema,
  })
  .strict();
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

const runtimeResultSchema = z.discriminatedUnion("kind", [
  synchronizedResultSchema,
  rejectedResultSchema,
  abortedResultSchema,
  failedResultSchema,
]);

export type AsanaSyncRuntimeConfiguration = z.infer<
  typeof runtimeConfigurationSchema
>;
export type AsanaSyncRuntimeState = z.infer<typeof runtimeStateSchema>;
export type AsanaSyncRuntimeResult = z.infer<typeof runtimeResultSchema>;
export type AsanaSyncRuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;
export type AsanaSyncRuntimeRejectionReason = z.infer<
  typeof runtimeRejectionReasonSchema
>;
export type AsanaSyncRuntimeSynchronizationMode = z.infer<
  typeof synchronizationModeSchema
>;

/** Asana同期ランタイムの設定を検証するスキーマです。 */
export const asanaSyncRuntimeConfigurationSchema = runtimeConfigurationSchema;

/** Asana同期ランタイムの状態を検証するスキーマです。 */
export const asanaSyncRuntimeStateSchema = runtimeStateSchema;

/** Asana同期ランタイムの結果を検証するスキーマです。 */
export const asanaSyncRuntimeResultSchema = runtimeResultSchema;

/** Asana同期ランタイムのエラーコードを検証するスキーマです。 */
export const asanaSyncRuntimeErrorCodeSchema = runtimeErrorCodeSchema;
