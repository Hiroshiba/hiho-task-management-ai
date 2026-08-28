import { z } from "zod";
import {
  areaSchema,
  asanaTaskResponseSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependenciesSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  parentWorkModeSchema,
  taskStatusSchema,
  type Dependency,
} from "../../shared/domain";

const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);
const taskTitleSchema = createUtf8ByteLimitedStringSchema(1024).refine(
  (value) => value.trim().length > 0,
  { message: "タスク名を空にできません。" },
);
const taskNotesSchema = createUtf8ByteLimitedStringSchema(64 * 1024);

const presentDueValueSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("due_on"), due_on: dateSchema })
    .strict(),
  z
    .object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema })
    .strict(),
]);

const parentValueSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("absent") })
    .strict(),
  z
    .object({ kind: z.literal("existing"), gid: gidSchema })
    .strict(),
]);

const guiOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("update_title"),
      value: taskTitleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("update_notes"),
      value: taskNotesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_status"),
      value: taskStatusSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("complete"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("withdraw"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("restore"),
      value: activeTaskStatusSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_importance"),
      value: importanceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_due"),
      value: presentDueValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clear_due"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_area"),
      value: areaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_dependencies"),
      value: dependenciesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_parent"),
      value: parentValueSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("set_parent_work_mode"),
      value: parentWorkModeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("link_obsidian"),
      value: obsidianLinkSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unlink_obsidian"),
      value: obsidianLinkSchema,
    })
    .strict(),
]);

const sectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .superRefine((sectionGids, context) => {
    const seen = new Set<string>();
    for (const [name, gid] of Object.entries(sectionGids)) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "状態セクションGIDを重複して指定できません。",
        });
      }
      seen.add(gid);
    }
  });

const guiInputSchema = z
  .object({
    task_gid: gidSchema,
    project_gid: gidSchema,
    workspace_gid: gidSchema,
    section_gids: sectionGidsSchema,
    device_id: identifierSchema,
    created_via: identifierSchema,
    activity_date: dateSchema,
    baseline_task: asanaTaskResponseSchema,
    operation: guiOperationSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.baseline_task.gid !== input.task_gid) {
      context.addIssue({
        code: "custom",
        path: ["baseline_task", "gid"],
        message: "直前同期タスクのGIDが対象と一致しません。",
      });
    }
  });

const conflictReasonCodeSchema = z.enum([
  "baseline_changed",
  "relationship_cycle",
  "read_back_mismatch",
  "external_unreadable",
  "external_identity_mismatch",
  "merge_conflict",
  "external_capacity_exceeded",
]);

const appliedResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("applied"),
    reason_code: z.literal("applied"),
  })
  .strict();

const alreadyAppliedResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("already_applied"),
    reason_code: z.literal("already_applied"),
  })
  .strict();

const conflictResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("conflict"),
    reason_code: conflictReasonCodeSchema,
    side_effect: z.enum(["none", "possible"]),
  })
  .strict();

const offlineResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("rejected"),
    reason_code: z.literal("offline"),
  })
  .strict();

const guiResultSchema = z.discriminatedUnion("outcome", [
  appliedResultSchema,
  alreadyAppliedResultSchema,
  conflictResultSchema,
  offlineResultSchema,
]);

export type AsanaGuiEditInput = z.infer<typeof guiInputSchema>;
export type AsanaGuiEditOperation = z.infer<typeof guiOperationSchema>;
export type AsanaGuiEditResult = z.infer<typeof guiResultSchema>;
export type AsanaGuiEditSectionGids = z.infer<typeof sectionGidsSchema>;
export type AsanaGuiEditParentValue = z.infer<typeof parentValueSchema>;
export type AsanaGuiEditDependency = Dependency;

const relationGraphValidationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("valid") }).strict(),
  z
    .object({
      kind: z.literal("conflict"),
      reason_code: z.literal("relationship_cycle"),
    })
    .strict(),
]);

export type AsanaGuiEditRelationGraphValidationResult = z.infer<
  typeof relationGraphValidationResultSchema
>;

/** GUI直接編集の入力を検証するスキーマです。 */
export const asanaGuiEditInputSchema = guiInputSchema;

/** GUI直接編集の結果を検証するスキーマです。 */
export const asanaGuiEditResultSchema = guiResultSchema;

/** GUI関係グラフ検証結果を検証するスキーマです。 */
export const asanaGuiEditRelationGraphValidationResultSchema =
  relationGraphValidationResultSchema;
