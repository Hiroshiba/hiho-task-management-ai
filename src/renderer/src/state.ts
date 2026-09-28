import { z } from "zod";
import { createUtf8ByteLimitedStringSchema, isoDateTimeSchema } from "../../shared/domain";

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
