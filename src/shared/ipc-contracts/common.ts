import { z } from "zod";

export const identifierSchema = z.string().min(1).max(200).regex(/^\S+$/u);
export const gidSchema = identifierSchema;
export const errorIdSchema = z.uuid();
export const dateSchema = z.iso.date();
export const dateTimeSchema = z.iso.datetime({ offset: true });
export const displayTextSchema = z.string().min(1).max(4_096);
export const emptyRequestSchema = z.object({}).strict();
export const completedSchema = z.object({ completed: z.literal(true) }).strict();
export const subscriptionRequestSchema = z.object({ subscription_id: identifierSchema }).strict();

export const ipcFailureSchema = z
  .object({
    kind: z.literal("error"),
    code: z.enum([
      "invalid_request",
      "not_configured",
      "authentication_required",
      "conflict",
      "not_found",
      "unavailable",
      "invalid_response",
      "sender_untrusted",
      "operation_failed",
    ]),
    message: z.string().min(1).max(160),
    error_id: errorIdSchema.optional(),
  })
  .strict();

/** 成功値と分類済みの失敗を検証します。 */
export function responseSchema<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion("kind", [z.object({ kind: z.literal("ok"), value }).strict(), ipcFailureSchema]);
}

/** 購読ごとの識別子を付けた通知を検証します。 */
export function subscriptionEventSchema<Value extends z.ZodType>(value: Value) {
  return z.object({ subscription_id: identifierSchema, value }).strict();
}

export type IpcResult<Value> = { readonly kind: "ok"; readonly value: Value } | z.infer<typeof ipcFailureSchema>;

export type IpcSubscription<Value> = (listener: (value: Value) => void) => () => void;
