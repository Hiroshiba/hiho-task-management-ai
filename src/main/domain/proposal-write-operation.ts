import { z } from "zod";
import { dateSchema, gidSchema, identifierSchema, isoDateTimeSchema } from "./primitives";
import { areaSchema, dependencyScopeSchema, durationSchema, importanceSchema, obsidianLinkSchema, obsidianLinksSchema, parentWorkModeSchema } from "./schemas";

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);
const absentSchema = z.object({ kind: z.literal("absent") }).strict();
const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema }).strict(),
]);
const dueValueSchema = z.union([absentSchema, dueSchema]);
const durationValueSchema = z.union([absentSchema, durationSchema]);
const parentValueSchema = z.union([absentSchema, targetSchema]);
const activeStatusSchema = z.enum(["not_started", "in_progress"]);
const statusSchema = z.enum(["not_started", "in_progress", "completed", "withdrawn"]);
const dependencySchema = z.object({ target: targetSchema, scope: dependencyScopeSchema, source: identifierSchema }).strict();
const dependenciesSchema = z.array(dependencySchema).max(64).superRefine((dependencies, context) => {
  const seen = new Set<string>();
  for (const [index, dependency] of dependencies.entries()) {
    const key = dependency.target.kind === "existing" ? `existing:${dependency.target.gid}` : `temporary:${dependency.target.ref}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index, "target"], message: "同じ依存先を重複して指定できません。" });
    seen.add(key);
  }
});
const operationShape = { operation_id: identifierSchema };
const targetedOperationShape = { ...operationShape, target: targetSchema };

/** 変更案の書き込みに必要な操作項目を検証するスキーマです。 */
export const proposalWriteOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create_task"),
    ...operationShape,
    temporary_ref: identifierSchema,
    after: z.object({
      title: z.string().refine((value) => value.trim().length > 0),
      notes: z.string().optional(),
      status: activeStatusSchema.optional(),
      importance: importanceSchema.optional(),
      area: areaSchema.optional(),
      due: dueSchema.optional(),
      duration: durationSchema.optional(),
      parent: targetSchema.optional(),
      parent_work_mode: parentWorkModeSchema.optional(),
      dependencies: dependenciesSchema.optional(),
      obsidian_links: obsidianLinksSchema.optional(),
    }),
  }),
  z.object({ operation: z.literal("update_title"), ...targetedOperationShape, before: z.string(), after: z.string() }),
  z.object({ operation: z.literal("update_notes"), ...targetedOperationShape, before: z.string(), after: z.string() }),
  z.object({ operation: z.literal("set_status"), ...targetedOperationShape, before: statusSchema, after: activeStatusSchema }),
  z.object({ operation: z.literal("set_importance"), ...targetedOperationShape, before: importanceSchema, after: importanceSchema }),
  z.object({ operation: z.literal("set_due"), ...targetedOperationShape, before: dueValueSchema, after: dueSchema }),
  z.object({ operation: z.literal("clear_due"), ...targetedOperationShape, before: dueSchema, after: absentSchema }),
  z.object({ operation: z.literal("set_duration"), ...targetedOperationShape, before: durationValueSchema, after: durationSchema }),
  z.object({ operation: z.literal("clear_duration"), ...targetedOperationShape, before: durationValueSchema, after: absentSchema }),
  z.object({ operation: z.literal("set_area"), ...targetedOperationShape, before: areaSchema, after: areaSchema }),
  z.object({ operation: z.literal("set_dependencies"), ...targetedOperationShape, before: dependenciesSchema, after: dependenciesSchema }),
  z.object({ operation: z.literal("set_parent"), ...targetedOperationShape, before: parentValueSchema, after: parentValueSchema }),
  z.object({ operation: z.literal("set_parent_work_mode"), ...targetedOperationShape, before: parentWorkModeSchema, after: parentWorkModeSchema }),
  z.object({ operation: z.literal("link_obsidian"), ...targetedOperationShape, before: absentSchema, after: obsidianLinkSchema }),
  z.object({ operation: z.literal("unlink_obsidian"), ...targetedOperationShape, before: obsidianLinkSchema, after: absentSchema }),
  z.object({ operation: z.literal("complete"), ...targetedOperationShape, before: activeStatusSchema, after: z.literal("completed") }),
  z.object({ operation: z.literal("withdraw"), ...targetedOperationShape, before: activeStatusSchema, after: z.literal("withdrawn") }),
]);

export type ProposalWriteOperation = z.infer<typeof proposalWriteOperationSchema>;
