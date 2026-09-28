import { z } from "zod";
import { dateSchema, dateTimeSchema, gidSchema, identifierSchema } from "./common";
import { durationSchema } from "./task-values";

const utf8TextSchema = (limit: number) => z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= limit,
  "文字数の上限を超えています。",
);
const titleSchema = utf8TextSchema(1_024).refine((value) => value.trim().length > 0, "タイトルを空にできません。");
const notesSchema = utf8TextSchema(65_536);
const reasonSchema = utf8TextSchema(4_096).refine((value) => value.trim().length > 0, "理由を空にできません。");
const evidenceTextSchema = utf8TextSchema(4_096);
const locatorSchema = evidenceTextSchema.refine((value) => value.trim().length > 0, "根拠参照を空にできません。");
const validationMessageSchema = utf8TextSchema(65_536).refine((value) => value.trim().length > 0, "検証結果を空にできません。");
const snapshotHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const activeStatusSchema = z.enum(["not_started", "in_progress"]);
const taskStatusSchema = z.enum(["not_started", "in_progress", "completed", "withdrawn"]);
const importanceSchema = z.number().int().min(1).max(5);
const parentWorkModeSchema = z.enum(["children_only", "has_own_work", "unknown"]);
const areaSchema = z.string().refine((value) => value.trim().length > 0, "領域を空にできません。");
const absentSchema = z.object({ kind: z.literal("absent") }).strict();
const existingTargetSchema = z.object({ kind: z.literal("existing"), gid: gidSchema }).strict();
const temporaryTargetSchema = z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict();
const targetSchema = z.discriminatedUnion("kind", [existingTargetSchema, temporaryTargetSchema]);
const parentSchema = z.discriminatedUnion("kind", [absentSchema, existingTargetSchema, temporaryTargetSchema]);
const dueOnSchema = z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict();
const dueAtSchema = z.object({ kind: z.literal("due_at"), due_at: dateTimeSchema }).strict();
const dueSchema = z.discriminatedUnion("kind", [dueOnSchema, dueAtSchema]);
const dueValueSchema = z.discriminatedUnion("kind", [absentSchema, dueOnSchema, dueAtSchema]);
const durationValueSchema = z.union([absentSchema, durationSchema]);
function isRelativePath(value: string): boolean {
  if (value.length === 0 || value.trim() !== value
    || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return value.split(/[\\/]/u).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
const obsidianLinkSchema = z.object({
  vault_id: identifierSchema,
  path: utf8TextSchema(1_024).refine(isRelativePath, "Vault内の相対パスを指定してください。"),
  title: utf8TextSchema(1_024).refine((value) => value.trim().length > 0, "ノートタイトルを空にできません。"),
  confidence: z.number().finite().min(0).max(1),
}).strict();
const obsidianLinksSchema = z.array(obsidianLinkSchema).max(10).superRefine((links, context) => {
  const seen = new Set<string>();
  links.forEach((link, index) => {
    const key = link.vault_id + "\u0000" + link.path;
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "同じノートを重複して指定できません。" });
    seen.add(key);
  });
});
const dependencySchema = z.object({
  target: targetSchema,
  scope: z.enum(["full", "partial"]),
  source: identifierSchema,
}).strict();
const dependenciesSchema = z.array(dependencySchema).max(64).superRefine((dependencies, context) => {
  const seen = new Set<string>();
  dependencies.forEach((dependency, index) => {
    const target = dependency.target;
    const key = target.kind === "existing" ? "existing\u0000" + target.gid : "temporary\u0000" + target.ref;
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index, "target"], message: "同じ依存先を重複して指定できません。" });
    seen.add(key);
  });
});
const evidenceReferenceSchema = z.object({
  kind: z.enum(["user_message", "task", "obsidian", "external_tool", "external_review"]),
  locator: locatorSchema,
  excerpt: evidenceTextSchema.optional(),
}).strict();
const evidenceReferencesSchema = z.array(evidenceReferenceSchema).min(1).max(16);
const userEvidenceSchema = evidenceReferenceSchema.extend({ kind: z.literal("user_message") }).strict();
const taskEvidenceSchema = evidenceReferenceSchema.extend({ kind: z.literal("task") }).strict();
const noteEvidenceSchema = evidenceReferenceSchema.extend({ kind: z.literal("obsidian") }).strict();
const toolEvidenceSchema = evidenceReferenceSchema.extend({ kind: z.literal("external_tool") }).strict();
const reviewEvidenceSchema = evidenceReferenceSchema.extend({ kind: z.literal("external_review") }).strict();
const statusEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user_explicit"), reference: userEvidenceSchema }).strict(),
  z.object({ kind: z.literal("task_or_note_explicit"), reference: z.discriminatedUnion("kind", [taskEvidenceSchema, noteEvidenceSchema]) }).strict(),
  z.object({ kind: z.literal("external_structured_status"), reference: toolEvidenceSchema, status: z.enum(["closed", "completed", "cancelled"]) }).strict(),
  z.object({ kind: z.literal("external_review_explicit"), reference: reviewEvidenceSchema }).strict(),
  z.object({ kind: z.literal("children_only_all_completed"), reference: taskEvidenceSchema }).strict(),
]);
const creationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single_task") }).strict(),
  z.object({
    kind: z.literal("split_child"),
    parent: targetSchema,
    instruction_reference: z.discriminatedUnion("kind", [userEvidenceSchema, reviewEvidenceSchema]),
  }).strict(),
]);
const createFieldsSchema = z.object({
  title: titleSchema,
  notes: notesSchema.optional(),
  status: activeStatusSchema.optional(),
  importance: importanceSchema.optional(),
  area: areaSchema.optional(),
  due: dueSchema.optional(),
  duration: durationSchema.optional(),
  parent: targetSchema.optional(),
  parent_work_mode: parentWorkModeSchema.optional(),
  dependencies: dependenciesSchema.optional(),
  obsidian_links: obsidianLinksSchema.optional(),
}).strict();
const commonShape = {
  operation_id: identifierSchema,
  baseline_snapshot_hash: snapshotHashSchema,
  reason: reasonSchema,
  basis: z.enum(["explicit", "inferred"]),
  confidence: z.number().finite().min(0).max(1),
  evidence_refs: evidenceReferencesSchema,
};
const targetedShape = { ...commonShape, target: targetSchema };
const createOperationSchema = z.object({
  operation: z.literal("create_task"),
  ...commonShape,
  temporary_ref: identifierSchema,
  creation: creationSchema,
  before: absentSchema,
  after: createFieldsSchema,
}).strict().superRefine((operation, context) => {
  if (operation.creation.kind === "single_task") {
    if (operation.after.parent != null) context.addIssue({ code: "custom", path: ["after", "parent"], message: "通常作成には親を指定できません。" });
    return;
  }
  if (operation.basis !== "explicit") context.addIssue({ code: "custom", path: ["basis"], message: "分割作成には明示的な根拠が必要です。" });
  const parent = operation.after.parent;
  if (parent == null || parent.kind !== operation.creation.parent.kind
    || (parent.kind === "existing" && operation.creation.parent.kind === "existing" && parent.gid !== operation.creation.parent.gid)
    || (parent.kind === "temporary" && operation.creation.parent.kind === "temporary" && parent.ref !== operation.creation.parent.ref)) {
    context.addIssue({ code: "custom", path: ["after", "parent"], message: "分割作成の親が一致しません。" });
  }
});

export const proposalOperationKindSchema = z.enum([
  "create_task", "update_title", "update_notes", "set_status", "set_importance", "set_due",
  "clear_due", "set_duration", "clear_duration", "set_area", "set_dependencies",
  "set_parent", "set_parent_work_mode", "link_obsidian", "unlink_obsidian", "complete", "withdraw",
]);

/** 変更案の17操作を操作種別ごとに検証します。 */
export const proposalOperationSchema = z.discriminatedUnion("operation", [
  createOperationSchema,
  z.object({ operation: z.literal("update_title"), ...targetedShape, before: titleSchema, after: titleSchema }).strict(),
  z.object({ operation: z.literal("update_notes"), ...targetedShape, before: notesSchema, after: notesSchema }).strict(),
  z.object({ operation: z.literal("set_status"), ...targetedShape, before: taskStatusSchema, after: activeStatusSchema }).strict(),
  z.object({ operation: z.literal("set_importance"), ...targetedShape, before: importanceSchema, after: importanceSchema }).strict(),
  z.object({ operation: z.literal("set_due"), ...targetedShape, before: dueValueSchema, after: dueSchema }).strict(),
  z.object({ operation: z.literal("clear_due"), ...targetedShape, before: dueSchema, after: absentSchema }).strict(),
  z.object({ operation: z.literal("set_duration"), ...targetedShape, before: durationValueSchema, after: durationSchema }).strict(),
  z.object({ operation: z.literal("clear_duration"), ...targetedShape, before: durationValueSchema, after: absentSchema }).strict(),
  z.object({ operation: z.literal("set_area"), ...targetedShape, before: areaSchema, after: areaSchema }).strict(),
  z.object({ operation: z.literal("set_dependencies"), ...targetedShape, before: dependenciesSchema, after: dependenciesSchema }).strict(),
  z.object({ operation: z.literal("set_parent"), ...targetedShape, before: parentSchema, after: parentSchema }).strict(),
  z.object({ operation: z.literal("set_parent_work_mode"), ...targetedShape, before: parentWorkModeSchema, after: parentWorkModeSchema }).strict(),
  z.object({ operation: z.literal("link_obsidian"), ...targetedShape, before: absentSchema, after: obsidianLinkSchema }).strict(),
  z.object({ operation: z.literal("unlink_obsidian"), ...targetedShape, before: obsidianLinkSchema, after: absentSchema }).strict(),
  z.object({ operation: z.literal("complete"), ...targetedShape, basis: z.literal("explicit"), before: activeStatusSchema, after: z.literal("completed"), status_evidence: statusEvidenceSchema }).strict(),
  z.object({ operation: z.literal("withdraw"), ...targetedShape, basis: z.literal("explicit"), before: activeStatusSchema, after: z.literal("withdrawn"), status_evidence: statusEvidenceSchema }).strict(),
]);

export const proposalEditValueSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create_task"), after: createFieldsSchema }).strict(),
  z.object({ operation: z.literal("update_title"), after: titleSchema }).strict(),
  z.object({ operation: z.literal("update_notes"), after: notesSchema }).strict(),
  z.object({ operation: z.literal("set_status"), after: activeStatusSchema }).strict(),
  z.object({ operation: z.literal("set_importance"), after: importanceSchema }).strict(),
  z.object({ operation: z.literal("set_due"), after: dueSchema }).strict(),
  z.object({ operation: z.literal("clear_due"), after: absentSchema }).strict(),
  z.object({ operation: z.literal("set_duration"), after: durationSchema }).strict(),
  z.object({ operation: z.literal("clear_duration"), after: absentSchema }).strict(),
  z.object({ operation: z.literal("set_area"), after: areaSchema }).strict(),
  z.object({ operation: z.literal("set_dependencies"), after: dependenciesSchema }).strict(),
  z.object({ operation: z.literal("set_parent"), after: parentSchema }).strict(),
  z.object({ operation: z.literal("set_parent_work_mode"), after: parentWorkModeSchema }).strict(),
  z.object({ operation: z.literal("link_obsidian"), after: obsidianLinkSchema }).strict(),
  z.object({ operation: z.literal("unlink_obsidian"), after: absentSchema }).strict(),
  z.object({ operation: z.literal("complete"), after: z.literal("completed") }).strict(),
  z.object({ operation: z.literal("withdraw"), after: z.literal("withdrawn") }).strict(),
]);
const uniqueIdsSchema = z.array(identifierSchema).max(256).superRefine((values, context) => {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) context.addIssue({ code: "custom", path: [index], message: "同じ識別子を重複して指定できません。" });
    seen.add(value);
  });
});
export const proposalSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("groups"), group_ids: uniqueIdsSchema.min(1) }).strict(),
  z.object({ kind: z.literal("operations"), operation_ids: uniqueIdsSchema.min(1) }).strict(),
]);
export const proposalValidationSchema = z.object({
  operations: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("valid"), group_id: identifierSchema, operation_id: identifierSchema }).strict(),
    z.object({ kind: z.literal("invalid"), group_id: identifierSchema, operation_id: identifierSchema, errors: z.array(z.object({ code: identifierSchema, message: validationMessageSchema }).strict()).min(1) }).strict(),
  ])).min(1).max(256),
  groups: z.array(z.object({ group_id: identifierSchema, atomic: z.boolean(), applicable: z.boolean(), operation_ids: uniqueIdsSchema.min(1) }).strict()).min(1).max(32),
}).strict();
const rankStateSchema = z.enum(["ranked", "excluded", "not_present"]);
const rankChangeSchema = z.object({
  task_gid: gidSchema,
  before_state: rankStateSchema,
  before_rank: z.number().int().positive().optional(),
  after_state: rankStateSchema,
  after_rank: z.number().int().positive().optional(),
}).strict().superRefine((change, context) => {
  if ((change.before_state === "ranked") !== (change.before_rank != null)) context.addIssue({ code: "custom", path: ["before_rank"], message: "基準順位の状態と値が一致しません。" });
  if ((change.after_state === "ranked") !== (change.after_rank != null)) context.addIssue({ code: "custom", path: ["after_rank"], message: "変更後順位の状態と値が一致しません。" });
});
export const proposalImpactSchema = z.object({
  impacted_task_count: z.number().int().nonnegative(),
  impacted_task_gids: z.array(gidSchema).max(10_000),
  rank_changes: z.array(rankChangeSchema).max(10_000),
}).strict().superRefine((impact, context) => {
  const gids = new Set(impact.impacted_task_gids);
  const rankGids = new Set(impact.rank_changes.map((change) => change.task_gid));
  if (gids.size !== impact.impacted_task_gids.length || gids.size !== impact.impacted_task_count
    || rankGids.size !== impact.rank_changes.length || rankGids.size !== gids.size
    || [...rankGids].some((gid) => !gids.has(gid))) {
    context.addIssue({ code: "custom", message: "順位差分と影響タスク一覧が一致しません。" });
  }
});
type ProposalOperation = z.infer<typeof proposalOperationSchema>;
type ProposalTarget = z.infer<typeof targetSchema>;
function validateTarget(target: ProposalTarget, temporaryRefs: ReadonlySet<string>, path: PropertyKey[], context: z.RefinementCtx): void {
  if (target.kind === "temporary" && !temporaryRefs.has(target.ref)) {
    context.addIssue({ code: "custom", path, message: "一時参照IDが変更案内の作成操作にありません。" });
  }
}
function validateOperationTargets(operation: ProposalOperation, temporaryRefs: ReadonlySet<string>, path: PropertyKey[], context: z.RefinementCtx): void {
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") validateTarget(operation.creation.parent, temporaryRefs, [...path, "creation", "parent"], context);
    if (operation.after.parent != null) validateTarget(operation.after.parent, temporaryRefs, [...path, "after", "parent"], context);
    operation.after.dependencies?.forEach((dependency, index) => validateTarget(dependency.target, temporaryRefs, [...path, "after", "dependencies", index, "target"], context));
    return;
  }
  validateTarget(operation.target, temporaryRefs, [...path, "target"], context);
  if (operation.operation === "set_parent") {
    if (operation.before.kind !== "absent") validateTarget(operation.before, temporaryRefs, [...path, "before"], context);
    if (operation.after.kind !== "absent") validateTarget(operation.after, temporaryRefs, [...path, "after"], context);
  }
  if (operation.operation === "set_dependencies") {
    operation.before.forEach((dependency, index) => validateTarget(dependency.target, temporaryRefs, [...path, "before", index, "target"], context));
    operation.after.forEach((dependency, index) => validateTarget(dependency.target, temporaryRefs, [...path, "after", index, "target"], context));
  }
}
const proposalGroupSchema = z.object({
  group_id: identifierSchema,
  atomic: z.boolean(),
  operations: z.array(proposalOperationSchema).min(1).max(64),
}).strict();

/** 変更案の表示値と操作順、検証結果、順位影響を検証します。 */
export const proposalViewSchema = z.object({
  proposal_id: identifierSchema,
  revision: z.number().int().positive().optional(),
  baseline_snapshot_hash: snapshotHashSchema,
  title: titleSchema,
  groups: z.array(proposalGroupSchema).min(1).max(32),
  basic_validation: proposalValidationSchema,
  graph_validation: proposalValidationSchema,
  selected_operation_ids: uniqueIdsSchema,
  impact: proposalImpactSchema,
}).strict().superRefine((view, context) => {
  const groupIds = new Set<string>();
  const operationIds = new Set<string>();
  const temporaryRefs = new Set<string>();
  const orderedOperations = view.groups.flatMap((group) => group.operations.map((operation) => ({ group, operation })));
  if (orderedOperations.length > 256) context.addIssue({ code: "custom", path: ["groups"], message: "変更案の操作数は256件までです。" });
  view.groups.forEach((group, index) => {
    if (groupIds.has(group.group_id)) context.addIssue({ code: "custom", path: ["groups", index, "group_id"], message: "同じグループIDを重複して指定できません。" });
    groupIds.add(group.group_id);
    group.operations.forEach((operation, operationIndex) => {
      if (operationIds.has(operation.operation_id)) context.addIssue({ code: "custom", path: ["groups", index, "operations", operationIndex, "operation_id"], message: "同じ操作IDを重複して指定できません。" });
      operationIds.add(operation.operation_id);
      if (operation.operation === "create_task") {
        if (temporaryRefs.has(operation.temporary_ref)) context.addIssue({ code: "custom", path: ["groups", index, "operations", operationIndex, "temporary_ref"], message: "同じ一時参照IDを重複して指定できません。" });
        temporaryRefs.add(operation.temporary_ref);
      }
    });
  });
  view.groups.forEach((group, groupIndex) => group.operations.forEach((operation, operationIndex) => {
    if (operation.baseline_snapshot_hash !== view.baseline_snapshot_hash) context.addIssue({ code: "custom", path: ["groups", groupIndex, "operations", operationIndex, "baseline_snapshot_hash"], message: "操作と変更案の基準が一致しません。" });
    validateOperationTargets(operation, temporaryRefs, ["groups", groupIndex, "operations", operationIndex], context);
  }));
  view.selected_operation_ids.forEach((operationId, index) => {
    if (!operationIds.has(operationId)) context.addIssue({ code: "custom", path: ["selected_operation_ids", index], message: "選択した操作が変更案にありません。" });
  });
  for (const [index, validation] of [view.basic_validation, view.graph_validation].entries()) {
    const key = index === 0 ? "basic_validation" : "graph_validation";
    validation.groups.forEach((group, index) => {
      const expected = view.groups[index];
      if (expected == null || group.group_id !== expected.group_id || group.atomic !== expected.atomic
        || group.operation_ids.length !== expected.operations.length
        || group.operation_ids.some((id, operationIndex) => id !== expected.operations[operationIndex]?.operation_id)) {
        context.addIssue({ code: "custom", path: [key, "groups", index], message: "検証結果のグループ順が変更案と一致しません。" });
      } else {
        const operationResults = validation.operations.filter((operation) => operation.group_id === group.group_id);
        const validCount = operationResults.filter((operation) => operation.kind === "valid").length;
        const applicable = group.atomic ? validCount === group.operation_ids.length : validCount > 0;
        if (group.applicable !== applicable) {
          context.addIssue({ code: "custom", path: [key, "groups", index, "applicable"], message: "グループの適用可否が操作結果と一致しません。" });
        }
      }
    });
    if (validation.groups.length !== view.groups.length) context.addIssue({ code: "custom", path: [key, "groups"], message: "検証結果のグループ数が一致しません。" });
    validation.operations.forEach((operation, index) => {
      const expected = orderedOperations[index];
      if (expected == null || operation.group_id !== expected.group.group_id || operation.operation_id !== expected.operation.operation_id) {
        context.addIssue({ code: "custom", path: [key, "operations", index], message: "検証結果の操作順が変更案と一致しません。" });
      }
    });
    if (validation.operations.length !== orderedOperations.length) context.addIssue({ code: "custom", path: [key, "operations"], message: "検証結果の操作数が一致しません。" });
  }
});
export type ProposalViewDto = z.infer<typeof proposalViewSchema>;
