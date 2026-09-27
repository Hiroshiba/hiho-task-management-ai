import { z } from "zod";
import { dateSchema, dateTimeSchema, displayTextSchema, gidSchema, identifierSchema } from "./common";
import { durationSchema, obsidianLinkSchema } from "./task-values";

export const proposalOperationKindSchema = z.enum([
  "create_task",
  "update_title",
  "update_notes",
  "set_status",
  "set_importance",
  "set_due",
  "clear_due",
  "set_duration",
  "clear_duration",
  "set_area",
  "set_dependencies",
  "set_parent",
  "set_parent_work_mode",
  "link_obsidian",
  "unlink_obsidian",
  "complete",
  "withdraw",
]);

export const proposalSelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z
    .object({
      kind: z.literal("groups"),
      group_ids: z.array(identifierSchema).min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("operations"),
      operation_ids: z.array(identifierSchema).min(1).max(256),
    })
    .strict(),
]);

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);
const editableDependencySchema = z
  .object({
    target: targetSchema,
    scope: z.enum(["full", "partial"]),
    source: identifierSchema,
  })
  .strict();
const parentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);
const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: dateTimeSchema }).strict(),
]);
const createFieldsSchema = z
  .object({
    title: displayTextSchema,
    notes: z.string().max(65_536).optional(),
    status: z.enum(["not_started", "in_progress"]).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    area: displayTextSchema.optional(),
    due: dueSchema.optional(),
    duration: durationSchema.optional(),
    parent: targetSchema.optional(),
    parent_work_mode: z.enum(["children_only", "has_own_work", "unknown"]).optional(),
    dependencies: z.array(editableDependencySchema).max(64).optional(),
    obsidian_links: z.array(obsidianLinkSchema).max(10).optional(),
  })
  .strict();

export const proposalAfterSchema = z.union([
  z.string().max(65_536),
  z.number().int().min(1).max(5),
  targetSchema,
  parentSchema,
  dueSchema,
  z.array(editableDependencySchema).max(64),
  obsidianLinkSchema,
  durationSchema,
  createFieldsSchema,
]);

const proposalOperationSchema = z
  .object({
    operation_id: identifierSchema,
    operation: proposalOperationKindSchema,
    target: targetSchema.optional(),
    temporary_ref: identifierSchema.optional(),
    before: z.union([proposalAfterSchema, z.object({ kind: z.literal("absent") }).strict()]).optional(),
    after: z.union([proposalAfterSchema, z.object({ kind: z.literal("absent") }).strict()]),
    reason: displayTextSchema,
    basis: z.enum(["explicit", "inferred"]),
    confidence: z.number().min(0).max(1),
    evidence_refs: z
      .array(
        z
          .object({
            kind: z.enum(["user_message", "task", "obsidian", "external_tool", "external_review"]),
            locator: displayTextSchema,
            excerpt: displayTextSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();

const proposalGroupSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operations: z.array(proposalOperationSchema).min(1).max(256),
  })
  .strict();

export const proposalViewSchema = z
  .object({
    proposal_id: identifierSchema,
    revision: z.number().int().positive().optional(),
    baseline_snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    title: displayTextSchema,
    groups: z.array(proposalGroupSchema).min(1).max(256),
    selected_operation_ids: z.array(identifierSchema).max(256),
    issues: z
      .array(
        z
          .object({
            operation_id: identifierSchema,
            code: identifierSchema,
            message: displayTextSchema,
          })
          .strict(),
      )
      .max(256),
    impacted_task_count: z.number().int().nonnegative(),
  })
  .strict();

export type ProposalViewDto = z.infer<typeof proposalViewSchema>;
