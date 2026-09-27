import { z } from "zod";
import { proposalWriteOperationSchema } from "../../domain/proposal-write-operation";
import {
  customExternalDataSchema,
  dateSchema,
  dependencyScopeSchema,
  durationSchema,
  externalTaskGidSchema,
  gidSchema,
  identifierSchema,
  importanceTagNameSchema,
  areaTagNameSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
} from "../../domain/task-write-values";

const activeStatusSchema = z.enum(["not_started", "in_progress"]);

export const taskWriteTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);

const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema }).strict(),
]);

const dueValueSchema = z.union([
  z.object({ kind: z.literal("absent") }).strict(),
  dueSchema,
]);

const parentValueSchema = z.union([
  z.object({ kind: z.literal("absent") }).strict(),
  taskWriteTargetSchema,
]);

const dependencySchema = z.object({
  target: taskWriteTargetSchema,
  scope: dependencyScopeSchema,
  source: identifierSchema,
}).strict();

const durationValueSchema = z.union([
  z.object({ kind: z.literal("absent") }).strict(),
  durationSchema,
]);

const externalChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("duration"),
    before: durationValueSchema,
    after: durationValueSchema,
  }).strict(),
  z.object({
    kind: z.literal("dependencies"),
    before: z.array(dependencySchema),
    after: z.array(dependencySchema),
  }).strict(),
  z.object({
    kind: z.literal("parent_work_mode"),
    before: parentWorkModeSchema,
    after: parentWorkModeSchema,
  }).strict(),
  z.object({
    kind: z.literal("obsidian_links"),
    action: z.enum(["add", "remove"]),
    link: obsidianLinkSchema,
  }).strict(),
  z.object({
    kind: z.literal("last_active_status"),
    after: activeStatusSchema,
  }).strict(),
  z.object({
    kind: z.literal("activity_anchor_on"),
    after: dateSchema,
  }).strict(),
]);

export const taskWriteExternalBaselineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("stored"),
    external_gid: externalTaskGidSchema,
    data: customExternalDataSchema,
  }).strict().refine(
    (baseline) => baseline.external_gid === `TaskHub:v1:task:${baseline.data.id}`,
    "Custom external dataの識別子が承認時baselineと一致しません。",
  ),
  z.object({
    kind: z.literal("created_task"),
    create_operation_id: identifierSchema,
    temporary_ref: identifierSchema,
  }).strict(),
]);

const createTaskPayloadSchema = z.object({
  target: z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
  create_uuid: z.uuid(),
  project_gid: gidSchema,
  section_gid: gidSchema,
  title: z.string().refine((value) => value.trim().length > 0),
  notes: z.string().optional(),
  due: dueSchema.optional(),
  initial_external: z.object({
    activity_date: dateSchema,
    last_active_status: activeStatusSchema,
    device_id: identifierSchema,
    created_via: identifierSchema,
    duration: durationSchema.optional(),
    dependencies: z.array(dependencySchema),
    parent_work_mode: parentWorkModeSchema,
    obsidian_links: obsidianLinksSchema,
  }).strict(),
}).strict();

const updateTaskPayloadSchema = z.object({
  target: taskWriteTargetSchema,
  update: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("title"), before: z.string(), after: z.string().refine((value) => value.trim().length > 0) }).strict(),
    z.object({ kind: z.literal("notes"), before: z.string(), after: z.string() }).strict(),
    z.object({ kind: z.literal("due_on"), before: dueValueSchema, after: dateSchema }).strict(),
    z.object({ kind: z.literal("due_at"), before: dueValueSchema, after: isoDateTimeSchema }).strict(),
    z.object({ kind: z.literal("clear_due"), before: dueSchema }).strict(),
    z.object({ kind: z.literal("completed"), before: z.boolean(), after: z.boolean() }).strict(),
  ]),
}).strict();

const sectionPayloadSchema = z.object({
  target: taskWriteTargetSchema,
  before_section_gid: gidSchema,
  after_section_gid: gidSchema,
}).strict();

const tagIdentitySchema = z.discriminatedUnion("category", [
  z.object({
    category: z.literal("importance"),
    target: taskWriteTargetSchema,
    workspace_gid: gidSchema,
    tag_name: importanceTagNameSchema,
  }).strict(),
  z.object({
    category: z.literal("area"),
    target: taskWriteTargetSchema,
    workspace_gid: gidSchema,
    tag_name: areaTagNameSchema,
  }).strict(),
]);

const addTagPayloadSchema = z.object({
  tag: tagIdentitySchema,
  expected_before: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("absent") }).strict(),
    z.object({ kind: z.literal("named"), tag_name: z.string() }).strict(),
    z.object({ kind: z.literal("named_or_absent"), tag_name: z.string() }).strict(),
  ]),
}).strict();

const removeTagPayloadSchema = z.object({
  tag: tagIdentitySchema,
  replacement: tagIdentitySchema,
  condition: z.literal("if_present"),
}).strict();

const parentPayloadSchema = z.object({
  target: taskWriteTargetSchema,
  expected_before: parentValueSchema,
  parent: taskWriteTargetSchema,
}).strict();

const clearParentPayloadSchema = z.object({
  target: taskWriteTargetSchema,
  expected_before: parentValueSchema,
}).strict();

const externalPayloadSchema = z.object({
  target: taskWriteTargetSchema,
  baseline: taskWriteExternalBaselineSchema,
  changes: z.array(externalChangeSchema).min(1).max(5).superRefine((changes, context) => {
    const seen = new Set<string>();
    for (const [index, change] of changes.entries()) {
      if (seen.has(change.kind)) {
        context.addIssue({ code: "custom", path: [index, "kind"], message: "同じ外部データ項目を重複して変更できません。" });
      }
      seen.add(change.kind);
    }
  }),
  device_id: identifierSchema,
}).strict();

const synchronizationPayloadSchema = z.object({
  targets: z.array(taskWriteTargetSchema).min(1),
  condition: z.enum(["verified_operation", "writer_result_available"]),
}).strict();

const proposalOperationCheckPayloadSchema = z.object({
  operation: proposalWriteOperationSchema.refine((operation) => operation.operation !== "create_task"),
  project_gid: gidSchema,
  workspace_gid: gidSchema,
  section_gids: z.object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  }).strict(),
  activity_date: dateSchema,
  external_baseline: taskWriteExternalBaselineSchema.optional(),
}).strict();

const stepShape = {
  step_id: identifierSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("operation"), operation_id: identifierSchema }).strict(),
    z.object({ kind: z.literal("execution") }).strict(),
  ]),
  executor_version: z.literal(1),
  retry_class: z.enum(["read_back_verifiable", "idempotent", "non_retryable"]),
  payload_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
};

export const taskWriteStepSchema = z.discriminatedUnion("kind", [
  z.object({ ...stepShape, kind: z.literal("proposal_operation_check"), payload: proposalOperationCheckPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_create_task"), payload: createTaskPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_update_task"), payload: updateTaskPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_add_to_section"), payload: sectionPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_add_tag"), payload: addTagPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_remove_tag"), payload: removeTagPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_set_parent"), payload: parentPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_clear_parent"), payload: clearParentPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("asana_merge_external_data"), payload: externalPayloadSchema }).strict(),
  z.object({ ...stepShape, kind: z.literal("local_synchronize"), payload: synchronizationPayloadSchema }).strict(),
]);

type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type TaskWriteStep = DeepReadonly<z.infer<typeof taskWriteStepSchema>>;
export type TaskWriteTarget = DeepReadonly<z.infer<typeof taskWriteTargetSchema>>;
export type TaskWriteExternalChange = DeepReadonly<z.infer<typeof externalChangeSchema>>;
export type TaskWriteExternalBaseline = DeepReadonly<z.infer<typeof taskWriteExternalBaselineSchema>>;
export type TaskWriteStepDraft = TaskWriteStep extends infer T
  ? T extends TaskWriteStep
    ? Omit<T, "executor_version" | "retry_class" | "payload_fingerprint">
    : never
  : never;
