import { z } from "zod";
import {
  areaSchema,
  baselineSnapshotSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependencyScopeSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  parentWorkModeSchema,
  snapshotHashSchema,
  taskSchema,
} from "../domain";
import { proposalSchema } from "../ai";

const maximumWorkflowTasks = 10_000;
const maximumWorkflowAreas = 512;
const maximumWorkflowSelection = 256;
const maximumWorkflowRankChanges = 10_000;
const maximumWorkflowMessageBytes = 64 * 1024;
const maximumWorkflowLocatorBytes = 4 * 1024;
const maximumWorkflowNoteBytes = 64 * 1024;

const nonBlankMessageSchema = createUtf8ByteLimitedStringSchema(
  maximumWorkflowMessageBytes,
).refine((value) => value.trim().length > 0, {
  message: "メッセージを空白だけにできません。",
});

const nonBlankLocatorSchema = createUtf8ByteLimitedStringSchema(
  maximumWorkflowLocatorBytes,
).refine((value) => value.trim().length > 0, {
  message: "根拠locatorを空白だけにできません。",
});

const workflowTaskArraySchema = z
  .array(taskSchema)
  .max(maximumWorkflowTasks)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (const [index, task] of tasks.entries()) {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "ワークフローのタスクGIDを重複指定できません。",
        });
      }
      seen.add(task.gid);
    }
  });

const workflowAreaArraySchema = z
  .array(areaSchema)
  .max(maximumWorkflowAreas)
  .superRefine((areas, context) => {
    const seen = new Set<string>();
    for (const [index, area] of areas.entries()) {
      if (seen.has(area)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "ワークフローの領域を重複指定できません。",
        });
      }
      seen.add(area);
    }
  });

/** AIワークフローが同期後に参照する正規化済み状態を検証するスキーマです。 */
export const aiWorkflowSnapshotSchema = z
  .object({
    app_version: identifierSchema,
    project_gid: gidSchema,
    synced_at: isoDateTimeSchema,
    as_of: isoDateTimeSchema,
    tasks: workflowTaskArraySchema,
    areas: workflowAreaArraySchema,
  })
  .strict();

/** AIターンへ渡す利用者の要求を検証するスキーマです。 */
export const aiWorkflowTurnRequestSchema = z
  .object({
    message: nonBlankMessageSchema,
    explicit_split_request_locators: z
      .array(nonBlankLocatorSchema)
      .max(maximumWorkflowSelection)
      .superRefine((locators, context) => {
        const seen = new Set<string>();
        for (const [index, locator] of locators.entries()) {
          if (seen.has(locator)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "分割依頼locatorを重複指定できません。",
            });
          }
          seen.add(locator);
        }
      }),
  })
  .strict();

/** Codexへ注入する基準コンテキストを検証するスキーマです。 */
export const aiWorkflowTurnContextSchema = z
  .object({
    baseline_snapshot_hash: snapshotHashSchema,
    app_version: identifierSchema,
    project_gid: gidSchema,
    synced_at: isoDateTimeSchema,
    as_of: isoDateTimeSchema,
  })
  .strict();

const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);

const editableDependencySchema = z
  .object({
    target: targetSchema,
    scope: dependencyScopeSchema,
    source: identifierSchema,
  })
  .strict();

const editableDependenciesSchema = z
  .array(editableDependencySchema)
  .max(64)
  .superRefine((dependencies, context) => {
    const seen = new Set<string>();
    for (const [index, dependency] of dependencies.entries()) {
      const target = dependency.target.kind === "existing"
        ? dependency.target.gid
        : dependency.target.ref;
      const key = `${dependency.target.kind}\u0000${target}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "target"],
          message: "同じ依存先を重複指定できません。",
        });
      }
      seen.add(key);
    }
  });

const editableParentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
  z.object({ kind: z.literal("temporary"), ref: identifierSchema }).strict(),
]);

const editableDueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("due_on"), due_on: dateSchema }).strict(),
  z.object({ kind: z.literal("due_at"), due_at: isoDateTimeSchema }).strict(),
]);

const editableCreateFieldsSchema = z
  .object({
    title: nonBlankMessageSchema,
    notes: createUtf8ByteLimitedStringSchema(maximumWorkflowNoteBytes).optional(),
    status: z.enum(["not_started", "in_progress"]).optional(),
    importance: importanceSchema.optional(),
    area: areaSchema.optional(),
    due: editableDueSchema.optional(),
    parent: targetSchema.optional(),
    parent_work_mode: parentWorkModeSchema.optional(),
    dependencies: editableDependenciesSchema.optional(),
    obsidian_links: z.array(obsidianLinkSchema).max(10).optional(),
  })
  .strict();

const editableAfterSchema = z.union([
  createUtf8ByteLimitedStringSchema(maximumWorkflowNoteBytes),
  importanceSchema,
  targetSchema,
  editableParentSchema,
  editableDueSchema,
  editableDependenciesSchema,
  obsidianLinkSchema,
  editableCreateFieldsSchema,
]);

/** 利用者が変更できる操作後値を検証するスキーマです。 */
export const aiWorkflowOperationEditSchema = z
  .object({
    proposal_id: identifierSchema,
    operation_id: identifierSchema,
    after: editableAfterSchema,
    evidence_locator: nonBlankLocatorSchema,
  })
  .strict();

const uniqueIdentifierArraySchema = z
  .array(identifierSchema)
  .max(maximumWorkflowSelection)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "識別子を重複指定できません。",
        });
      }
      seen.add(value);
    }
  });

const allSelectionSchema = z
  .object({ kind: z.literal("all") })
  .strict();
const groupSelectionSchema = z
  .object({ kind: z.literal("groups"), group_ids: uniqueIdentifierArraySchema.min(1) })
  .strict();
const operationSelectionSchema = z
  .object({ kind: z.literal("operations"), operation_ids: uniqueIdentifierArraySchema.min(1) })
  .strict();

/** AI変更案の選択範囲を検証するスキーマです。 */
export const aiWorkflowSelectionSchema = z.discriminatedUnion("kind", [
  allSelectionSchema,
  groupSelectionSchema,
  operationSelectionSchema,
]);

/** AI変更案の選択要求を検証するスキーマです。 */
export const aiWorkflowSelectionRequestSchema = z
  .object({
    proposal_id: identifierSchema,
    selection: aiWorkflowSelectionSchema,
  })
  .strict();

/** AI変更案の承認要求を検証するスキーマです。 */
export const aiWorkflowApprovalRequestSchema = z
  .object({
    proposal_id: identifierSchema,
    selection: aiWorkflowSelectionSchema,
  })
  .strict();

const workflowValidationErrorSchema = z
  .object({
    code: identifierSchema,
    message: nonBlankMessageSchema,
  })
  .strict();

const workflowValidOperationSchema = z
  .object({
    kind: z.literal("valid"),
    group_id: identifierSchema,
    operation_id: identifierSchema,
  })
  .strict();

const workflowInvalidOperationSchema = z
  .object({
    kind: z.literal("invalid"),
    group_id: identifierSchema,
    operation_id: identifierSchema,
    errors: z.array(workflowValidationErrorSchema).min(1),
  })
  .strict();

const workflowOperationValidationSchema = z.discriminatedUnion("kind", [
  workflowValidOperationSchema,
  workflowInvalidOperationSchema,
]);

const workflowGroupValidationSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    applicable: z.boolean(),
    operation_ids: uniqueIdentifierArraySchema.min(1),
  })
  .strict();

const workflowValidationSchema = z
  .object({
    operations: z.array(workflowOperationValidationSchema).min(1),
    groups: z.array(workflowGroupValidationSchema).min(1),
  })
  .strict();

const rankPresenceSchema = z.enum(["ranked", "excluded", "not_present"]);

const rankChangeSchema = z
  .object({
    task_gid: gidSchema,
    before_state: rankPresenceSchema,
    before_rank: z.number().int().positive().optional(),
    after_state: rankPresenceSchema,
    after_rank: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((change, context) => {
    if (change.before_state === "ranked" && change.before_rank == null) {
      context.addIssue({
        code: "custom",
        path: ["before_rank"],
        message: "基準順位がない状態をrankedとして指定できません。",
      });
    }
    if (change.before_state !== "ranked" && change.before_rank != null) {
      context.addIssue({
        code: "custom",
        path: ["before_rank"],
        message: "基準順位がある状態だけbefore_rankを指定できます。",
      });
    }
    if (change.after_state === "ranked" && change.after_rank == null) {
      context.addIssue({
        code: "custom",
        path: ["after_rank"],
        message: "変更後順位がない状態をrankedとして指定できません。",
      });
    }
    if (change.after_state !== "ranked" && change.after_rank != null) {
      context.addIssue({
        code: "custom",
        path: ["after_rank"],
        message: "変更後順位がある状態だけafter_rankを指定できます。",
      });
    }
  });

/** AI変更案の順位への予測影響を検証するスキーマです。 */
export const aiWorkflowImpactSchema = z
  .object({
    impacted_task_count: z.number().int().nonnegative(),
    impacted_task_gids: z.array(gidSchema).max(maximumWorkflowRankChanges),
    rank_changes: z.array(rankChangeSchema).max(maximumWorkflowRankChanges),
  })
  .strict()
  .superRefine((impact, context) => {
    if (impact.impacted_task_count !== impact.impacted_task_gids.length) {
      context.addIssue({
        code: "custom",
        path: ["impacted_task_count"],
        message: "影響タスク数がGID一覧の件数と一致しません。",
      });
    }
    const gids = new Set(impact.impacted_task_gids);
    const changeGids = new Set<string>();
    for (const [index, change] of impact.rank_changes.entries()) {
      if (!gids.has(change.task_gid)) {
        context.addIssue({
          code: "custom",
          path: ["rank_changes", index, "task_gid"],
          message: "順位差分のタスクが影響タスク一覧にありません。",
        });
      }
      if (changeGids.has(change.task_gid)) {
        context.addIssue({
          code: "custom",
          path: ["rank_changes", index, "task_gid"],
          message: "同じタスクの順位差分を重複指定できません。",
        });
      }
      changeGids.add(change.task_gid);
    }
    for (const gid of gids) {
      if (!changeGids.has(gid)) {
        context.addIssue({
          code: "custom",
          path: ["rank_changes"],
          message: "影響タスクに順位差分がありません。",
        });
      }
    }
  });

const proposalViewSchema = z
  .object({
    proposal_id: identifierSchema,
    baseline_snapshot_hash: snapshotHashSchema,
    proposal: proposalSchema,
    basic_validation: workflowValidationSchema,
    graph_validation: workflowValidationSchema,
    selected_operation_ids: uniqueIdentifierArraySchema,
    impact: aiWorkflowImpactSchema,
  })
  .strict()
  .superRefine((view, context) => {
    const operationIds = new Set(
      view.proposal.groups.flatMap((group) =>
        group.operations.map((operation) => operation.operation_id)),
    );
    for (const [index, operationId] of view.selected_operation_ids.entries()) {
      if (!operationIds.has(operationId)) {
        context.addIssue({
          code: "custom",
          path: ["selected_operation_ids", index],
          message: "選択された操作が変更案にありません。",
        });
      }
    }
  });

/** Rendererへ公開するAI変更案を検証するスキーマです。 */
export const aiWorkflowProposalViewSchema = proposalViewSchema;

const questionSchema = z
  .object({
    question_id: identifierSchema,
    text: nonBlankMessageSchema,
    options: z.array(nonBlankMessageSchema).min(2).max(8).optional(),
  })
  .strict();

const workflowProposalTurnSchema = z
  .object({
    kind: z.literal("proposal"),
    message: nonBlankMessageSchema,
    questions: z.array(questionSchema).max(8),
    proposal: proposalViewSchema,
    retry_count: z.number().int().nonnegative().max(1),
  })
  .strict();

const workflowNoProposalTurnSchema = z
  .object({
    kind: z.literal("no_proposal"),
    message: nonBlankMessageSchema,
    questions: z.array(questionSchema).max(8),
    retry_count: z.number().int().nonnegative().max(1),
  })
  .strict();

/** AIターンのRenderer向け結果を検証するスキーマです。 */
export const aiWorkflowTurnResultSchema = z.discriminatedUnion("kind", [
  workflowProposalTurnSchema,
  workflowNoProposalTurnSchema,
]);

const applicationOperationSchema = z
  .object({
    group_id: identifierSchema,
    operation_id: identifierSchema,
    task_gid: gidSchema.optional(),
    outcome: z.enum(["applied", "already_applied", "not_applied", "unknown"]),
    reason_code: identifierSchema,
  })
  .strict();

const applicationGroupSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    outcome: z.enum(["applied", "already_applied", "not_applied", "partially_applied", "unknown"]),
    operation_ids: uniqueIdentifierArraySchema.min(1),
  })
  .strict();

const applicationSummarySchema = z
  .object({
    outcome: z.enum(["applied", "already_applied", "not_applied", "partially_applied", "unknown"]),
    operations: z.array(applicationOperationSchema).min(1),
    groups: z.array(applicationGroupSchema).min(1),
  })
  .strict();

/** AI変更案の承認結果を検証するスキーマです。 */
export const aiWorkflowApprovalResultSchema = z
  .object({
    proposal_id: identifierSchema,
    application: applicationSummarySchema,
  })
  .strict();

export type AiWorkflowSnapshot = z.infer<typeof aiWorkflowSnapshotSchema>;
export type AiWorkflowTurnRequest = z.infer<typeof aiWorkflowTurnRequestSchema>;
export type AiWorkflowTurnContext = z.infer<typeof aiWorkflowTurnContextSchema>;
export type AiWorkflowOperationEdit = z.infer<typeof aiWorkflowOperationEditSchema>;
export type AiWorkflowSelection = z.infer<typeof aiWorkflowSelectionSchema>;
export type AiWorkflowSelectionRequest = z.infer<
  typeof aiWorkflowSelectionRequestSchema
>;
export type AiWorkflowApprovalRequest = z.infer<
  typeof aiWorkflowApprovalRequestSchema
>;
export type AiWorkflowImpact = z.infer<typeof aiWorkflowImpactSchema>;
export type AiWorkflowProposalView = z.infer<typeof proposalViewSchema>;
export type AiWorkflowTurnResult = z.infer<typeof aiWorkflowTurnResultSchema>;
export type AiWorkflowApprovalResult = z.infer<
  typeof aiWorkflowApprovalResultSchema
>;
export type AiWorkflowBaselineSnapshot = z.infer<typeof baselineSnapshotSchema>;
