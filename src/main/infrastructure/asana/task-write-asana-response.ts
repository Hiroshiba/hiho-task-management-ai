import { z } from "zod";
import { dateSchema, gidSchema, isoDateTimeSchema } from "../../domain/primitives";

const tagSchema = z.object({ gid: gidSchema, name: z.string() }).strip();
const taskSchema = z.object({
  gid: gidSchema,
  name: z.string(),
  notes: z.string(),
  completed: z.boolean(),
  due_on: dateSchema.nullable(),
  due_at: isoDateTimeSchema.nullable(),
  external: z.object({ gid: z.string(), data: z.string() }).strict().nullable(),
  memberships: z.array(z.object({
    project: z.object({ gid: gidSchema }).strip(),
    section: z.object({ gid: gidSchema }).strip().nullable(),
  }).strip()),
  tags: z.array(tagSchema),
  parent: z.object({ gid: gidSchema }).strip().nullable(),
}).strip();

export type ReadBackAsanaTask = z.infer<typeof taskSchema>;
export type ReadBackAsanaTag = z.infer<typeof tagSchema>;

/** Asana GET応答から読戻しに必要な投影を検証します。 */
export function parseReadBackAsanaTask(value: unknown): ReadBackAsanaTask {
  return taskSchema.parse(value);
}

/** Asanaのプロジェクト一覧を読戻し用の投影として検証します。 */
export function parseReadBackAsanaTasks(value: unknown): readonly ReadBackAsanaTask[] {
  return z.array(taskSchema).parse(value);
}

/** ワークスペースのタグ一覧を読戻し用に検証します。 */
export function parseReadBackAsanaTags(value: unknown): readonly ReadBackAsanaTag[] {
  return z.array(tagSchema).parse(value);
}
