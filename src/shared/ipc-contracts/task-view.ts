import { z } from "zod";
import { dateSchema, dateTimeSchema, displayTextSchema, gidSchema, identifierSchema } from "./common";
import { durationSchema, dueSchema, obsidianLinkSchema, taskStatusSchema } from "./task-values";

const blockReasonSchema = z
  .object({
    code: z.enum([
      "partial_dependency",
      "full_dependency",
      "partial_parent",
      "full_children_only",
      "partial_dependency_and_parent",
      "full_dependency_and_parent",
      "dependency_cycle",
      "parent_cycle",
      "completion_confirmation",
    ]),
    summary: displayTextSchema,
  })
  .strict();
const childProgressSchema = z
  .object({
    completed_count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative(),
  })
  .strict()
  .refine((value) => value.completed_count <= value.total_count);
const exclusionReasonSchema = z
  .object({
    code: z.enum([
      "inactive_status",
      "full_block",
      "dependency_cycle",
      "parent_cycle",
      "completion_confirmation",
      "critical_error",
    ]),
    message: displayTextSchema,
  })
  .strict();
const unavailableReasonSchema = z.enum([
  "ranking_unavailable",
  "critical_error",
  "custom_external_data_broken",
  "custom_external_data_unknown_schema",
  "custom_external_data_identity_mismatch",
  "unknown_status_section",
  "dependency_cycle",
  "parent_cycle",
  "completion_confirmation",
  "missing_dependency",
]);
const cleanupItemSchema = z
  .object({
    kind: z.enum([
      "importance_tag_conflict",
      "area_tag_conflict",
      "unknown_status_section",
      "missing_required_section",
      "dependency_cycle",
      "missing_dependency",
      "parent_cycle",
      "parent_relation_conflict",
      "children_only_completion_confirmation",
      "missing_task",
      "custom_external_data_broken",
      "oauth_app_mismatch",
      "proposal_conflict",
      "broken_vault_link",
    ]),
    message: displayTextSchema,
    scope: z.discriminatedUnion("scope", [
      z
        .object({
          scope: z.literal("task"),
          task_gid: gidSchema,
          related_task_gids: z.array(gidSchema).optional(),
        })
        .strict(),
      z
        .object({
          scope: z.literal("global"),
          related_task_gids: z.array(gidSchema).optional(),
        })
        .strict(),
    ]),
  })
  .strict();

const taskRowShape = {
  gid: gidSchema,
  title: displayTextSchema,
  status: taskStatusSchema,
  importance: z.number().int().min(1).max(5),
  duration: durationSchema.optional(),
  due: dueSchema,
  area: displayTextSchema,
  block_state: z.enum(["none", "partial", "full"]),
  block_reason: blockReasonSchema.optional(),
  reason_chips: z.array(displayTextSchema).max(64),
  child_progress: childProgressSchema,
  has_dependencies: z.boolean(),
  has_children: z.boolean(),
  warning_count: z.number().int().nonnegative(),
};

const taskRowSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...taskRowShape,
      kind: z.literal("ranked"),
      rank: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...taskRowShape,
      kind: z.literal("excluded"),
      exclusion_reasons: z.array(exclusionReasonSchema).min(1),
    })
    .strict(),
  z
    .object({
      ...taskRowShape,
      kind: z.literal("unavailable"),
      unavailable_reasons: z.array(unavailableReasonSchema).min(1),
    })
    .strict(),
]);

export const overviewSchema = z
  .object({
    project_gid: gidSchema,
    last_successful_sync_at: dateTimeSchema,
    last_full_sync_at: dateTimeSchema.optional(),
    ranking: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("available"),
          calculated_at: dateTimeSchema,
          app_version: displayTextSchema,
        })
        .strict(),
      z.object({ kind: z.literal("unavailable") }).strict(),
    ]),
    tasks: z.array(taskRowSchema).max(10_000),
    default_filter: z.literal("ranked"),
    areas: z.array(displayTextSchema).max(10_000),
    cleanup_items: z.array(cleanupItemSchema).max(10_000),
    cleanup_count: z.number().int().nonnegative(),
  })
  .strict();

const taskReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("found"),
      gid: gidSchema,
      title: displayTextSchema,
      status: taskStatusSchema,
    })
    .strict(),
  z.object({ kind: z.literal("missing"), gid: gidSchema }).strict(),
]);
const dependencyReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("found"),
      gid: gidSchema,
      title: displayTextSchema,
      status: taskStatusSchema,
      scope: z.enum(["full", "partial"]),
      source: identifierSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("missing"),
      gid: gidSchema,
      scope: z.enum(["full", "partial"]),
      source: identifierSchema,
    })
    .strict(),
]);
const scoreBreakdownSchema = z
  .object({
    importance_points: z.number().int().nonnegative(),
    deadline_points: z.number().int().nonnegative(),
    release_points: z.number().int().nonnegative(),
    partial_block_penalty: z.number().int().nonnegative(),
    stagnation_penalty: z.number().int().nonnegative(),
    execution_points: z.number().int(),
  })
  .strict();
const tieBreakSchema = z
  .object({
    effective_due_at: dateTimeSchema.optional(),
    importance: z.number().int().min(1).max(5),
    release_points: z.number().int().nonnegative(),
    activity_anchor_on: dateSchema,
    gid: gidSchema,
  })
  .strict();
const rankingShape = {
  calculated_at: dateTimeSchema.optional(),
  activity_elapsed_days: z.number().int().nonnegative().optional(),
  detail_text: displayTextSchema.optional(),
  score_breakdown: scoreBreakdownSchema.optional(),
  release_target_gids: z.array(gidSchema).optional(),
  reason_chips: z.array(displayTextSchema).optional(),
  tie_break: tieBreakSchema.optional(),
  exclusion_reasons: z.array(exclusionReasonSchema).optional(),
};

export const detailSchema = z
  .object({
    project_gid: gidSchema,
    gid: gidSchema,
    edit_baseline_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    title: displayTextSchema,
    notes: z.string().max(1_000_000),
    status: taskStatusSchema,
    importance: z.number().int().min(1).max(5),
    duration: durationSchema.optional(),
    due: dueSchema,
    area: displayTextSchema,
    block_state: z.enum(["none", "partial", "full"]),
    block_reason: blockReasonSchema.optional(),
    section_gid: gidSchema,
    parent_work_mode: z.enum(["children_only", "has_own_work", "unknown"]),
    activity_anchor_on: dateSchema,
    ranking: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("ranked"),
          rank: z.number().int().positive(),
          ...rankingShape,
        })
        .strict(),
      z.object({ kind: z.literal("excluded"), ...rankingShape }).strict(),
      z
        .object({
          kind: z.literal("unavailable"),
          reason_codes: z.array(unavailableReasonSchema).min(1),
          ...rankingShape,
        })
        .strict(),
    ]),
    dependencies: z.array(dependencyReferenceSchema).max(10_000),
    dependents: z.array(dependencyReferenceSchema).max(10_000),
    parent: taskReferenceSchema.optional(),
    children: z.array(taskReferenceSchema).max(10_000),
    child_progress: childProgressSchema,
    has_dependencies: z.boolean(),
    has_children: z.boolean(),
    obsidian_links: z.array(obsidianLinkSchema).max(10),
    asana_url: z.url(),
    cleanup_warnings: z.array(cleanupItemSchema).max(10_000),
  })
  .strict();
