import { z } from "zod";

/** SQLiteに保存するAsana同期状態の検証schemaを作ります。 */
export function createSyncStateSchema(
  gidSchema: z.ZodType<string>,
  isoDateTimeSchema: z.ZodType<string>,
) {
  const nonEmptyTextSchema = z.string().refine((value) => value.length > 0, {
    message: "空でない文字列を指定してください。",
  });
  return z.object({
    project_gid: gidSchema,
    events_token: nonEmptyTextSchema.optional(),
    last_successful_sync_at: isoDateTimeSchema.optional(),
    last_full_sync_at: isoDateTimeSchema.optional(),
  }).strict();
}
