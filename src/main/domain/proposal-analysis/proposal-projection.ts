import { z } from "zod";
import {
  areaSchema,
  dependencyScopeSchema,
  durationSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  obsidianLinkSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
  snapshotHashSchema,
} from "../task-write-values";

const absentSchema = z.object({ kind: z.literal("absent") });
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), gid: gidSchema }),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }),
]);
const parentValueSchema = z.discriminatedUnion("kind", [
  absentSchema,
  z.object({ kind: z.literal("existing"), gid: gidSchema }),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }),
]);
const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: z.string() }),
  z.object({ kind: z.literal("due_at"), due_at: z.string() }),
]);
const dueValueSchema = z.discriminatedUnion("kind", [
  absentSchema,
  z.object({ kind: z.literal("due_on"), due_on: z.string() }),
  z.object({ kind: z.literal("due_at"), due_at: z.string() }),
]);
const durationValueSchema = z.union([absentSchema, durationSchema]);
const activeStatusSchema = z.enum(["not_started", "in_progress"]);
const taskStatusSchema = z.enum(["not_started", "in_progress", "completed", "withdrawn"]);
const dependencySchema = z.object({
  target: targetSchema,
  scope: dependencyScopeSchema,
  source: identifierSchema,
});
const dependenciesSchema = z.array(dependencySchema);

const userMessageEvidenceReferenceSchema = z.object({
  kind: z.literal("user_message"), locator: z.string(), excerpt: z.string().optional(),
});
const taskEvidenceReferenceSchema = z.object({
  kind: z.literal("task"), locator: z.string(), excerpt: z.string().optional(),
});
const obsidianEvidenceReferenceSchema = z.object({
  kind: z.literal("obsidian"), locator: z.string(), excerpt: z.string().optional(),
});
const externalToolEvidenceReferenceSchema = z.object({
  kind: z.literal("external_tool"), locator: z.string(), excerpt: z.string().optional(),
});
const externalReviewEvidenceReferenceSchema = z.object({
  kind: z.literal("external_review"), locator: z.string(), excerpt: z.string().optional(),
});
const splitInstructionReferenceSchema = z.discriminatedUnion("kind", [
  userMessageEvidenceReferenceSchema,
  externalReviewEvidenceReferenceSchema,
]);
const taskOrNoteEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  taskEvidenceReferenceSchema,
  obsidianEvidenceReferenceSchema,
]);
const statusEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_explicit"), reference: userMessageEvidenceReferenceSchema }),
  z.object({ kind: z.literal("task_or_note_explicit"), reference: taskOrNoteEvidenceReferenceSchema }),
  z.object({
    kind: z.literal("external_structured_status"),
    reference: externalToolEvidenceReferenceSchema,
    status: z.enum(["closed", "completed", "cancelled"]),
  }),
  z.object({ kind: z.literal("external_review_explicit"), reference: externalReviewEvidenceReferenceSchema }),
  z.object({ kind: z.literal("children_only_all_completed"), reference: taskEvidenceReferenceSchema }),
]);

const commonShape = {
  operation_id: identifierSchema,
  baseline_snapshot_hash: snapshotHashSchema,
};
const targetedShape = { ...commonShape, target: targetSchema };
const createTaskSchema = z.object({
  operation: z.literal("create_task"),
  ...commonShape,
  temporary_ref: identifierSchema,
  creation: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("single_task") }),
    z.object({
      kind: z.literal("split_child"),
      parent: targetSchema,
      instruction_reference: splitInstructionReferenceSchema,
    }),
  ]),
  before: absentSchema,
  after: z.object({
    title: z.string(),
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
});

/** 公開変更案の検証後に使う17操作を投影します。 */
export const analysisProposalOperationSchema = z.discriminatedUnion("operation", [
  createTaskSchema,
  z.object({ operation: z.literal("update_title"), ...targetedShape, before: z.string(), after: z.string() }),
  z.object({ operation: z.literal("update_notes"), ...targetedShape, before: z.string(), after: z.string() }),
  z.object({ operation: z.literal("set_status"), ...targetedShape, before: taskStatusSchema, after: activeStatusSchema }),
  z.object({ operation: z.literal("set_importance"), ...targetedShape, before: importanceSchema, after: importanceSchema }),
  z.object({ operation: z.literal("set_due"), ...targetedShape, before: dueValueSchema, after: dueSchema }),
  z.object({ operation: z.literal("clear_due"), ...targetedShape, before: dueSchema, after: absentSchema }),
  z.object({ operation: z.literal("set_duration"), ...targetedShape, before: durationValueSchema, after: durationSchema }),
  z.object({ operation: z.literal("clear_duration"), ...targetedShape, before: durationValueSchema, after: absentSchema }),
  z.object({ operation: z.literal("set_area"), ...targetedShape, before: areaSchema, after: areaSchema }),
  z.object({ operation: z.literal("set_dependencies"), ...targetedShape, before: dependenciesSchema, after: dependenciesSchema }),
  z.object({ operation: z.literal("set_parent"), ...targetedShape, before: parentValueSchema, after: parentValueSchema }),
  z.object({ operation: z.literal("set_parent_work_mode"), ...targetedShape, before: parentWorkModeSchema, after: parentWorkModeSchema }),
  z.object({ operation: z.literal("link_obsidian"), ...targetedShape, before: absentSchema, after: obsidianLinkSchema }),
  z.object({ operation: z.literal("unlink_obsidian"), ...targetedShape, before: obsidianLinkSchema, after: absentSchema }),
  z.object({ operation: z.literal("complete"), ...targetedShape, before: activeStatusSchema, after: z.literal("completed"), status_evidence: statusEvidenceSchema }),
  z.object({ operation: z.literal("withdraw"), ...targetedShape, before: activeStatusSchema, after: z.literal("withdrawn"), status_evidence: statusEvidenceSchema }),
]);

/** 公開変更案の検証後に群と操作順を保って投影します。 */
export const analysisProposalSchema = z.object({
  title: z.string(),
  groups: z.array(z.object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operations: z.array(analysisProposalOperationSchema),
  })),
});

export type AnalysisProposal = z.infer<typeof analysisProposalSchema>;
export type AnalysisProposalOperation = z.infer<typeof analysisProposalOperationSchema>;
export type AnalysisProposalGroup = AnalysisProposal["groups"][number];
