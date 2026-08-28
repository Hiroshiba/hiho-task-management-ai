import { z } from "zod";
import {
  blockStateSchema,
  cleanupItemKindSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependencyScopeSchema,
  gidSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
  taskStatusSchema,
} from "../domain";
import {
  rankingExclusionReasonCodeSchema,
  rankingScoreBreakdownSchema,
  rankingTieBreakSchema,
} from "../storage";

const maximumTaskCount = 10_000;
const maximumCleanupCount = 10_000;
const maximumRelationCount = 10_000;
const maximumReasonChipCount = 64;
const maximumTitleCharacters = 4_096;
const maximumNotesCharacters = 1_000_000;
const maximumMessageCharacters = 4_096;
const maximumRankingDetailBytes = 8 * 1_024 * 1_024;

const boundedTitleSchema = z.string().min(1).max(maximumTitleCharacters);
const boundedNotesSchema = z.string().max(maximumNotesCharacters);
const boundedMessageSchema = z
  .string()
  .min(1)
  .max(maximumMessageCharacters)
  .refine((value) => value.trim().length > 0, {
    message: "表示文字列を空白だけにできません。",
  });
const boundedChipSchema = boundedMessageSchema;
const boundedRankingDetailSchema = createUtf8ByteLimitedStringSchema(
  maximumRankingDetailBytes,
).refine((value) => value.trim().length > 0, {
  message: "順位計算の詳細を空白だけにできません。",
});

const uniqueGidsSchema = z
  .array(gidSchema)
  .max(maximumRelationCount)
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    gids.forEach((gid, index) => {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じGIDを重複して返せません。",
        });
      }
      seen.add(gid);
    });
  });

const dueNoneSchema = z
  .object({
    kind: z.literal("none"),
  })
  .strict();

const dueOnSchema = z
  .object({
    kind: z.literal("on"),
    value: dateSchema,
  })
  .strict();

const dueAtSchema = z
  .object({
    kind: z.literal("at"),
    value: isoDateTimeSchema,
  })
  .strict();

/** 表示用の期限を検証するスキーマです。 */
export const viewModelDueSchema = z.discriminatedUnion("kind", [
  dueNoneSchema,
  dueOnSchema,
  dueAtSchema,
]);

const blockReasonPartialSchema = z
  .object({
    code: z.literal("partial_dependency"),
    summary: z.literal("未完了の一部依存があります。"),
  })
  .strict();
const blockReasonFullSchema = z
  .object({
    code: z.literal("full_dependency"),
    summary: z.literal("未完了の完全依存があります。"),
  })
  .strict();
const blockReasonPartialParentSchema = z
  .object({
    code: z.literal("partial_parent"),
    summary: z.literal(
      "未完了の子タスクがあります。親自身の作業は続行できます。",
    ),
  })
  .strict();
const blockReasonFullChildrenOnlySchema = z
  .object({
    code: z.literal("full_children_only"),
    summary: z.literal(
      "未完了の子タスクがあるため、子タスクのみの親タスクは完全ブロックされています。",
    ),
  })
  .strict();
const blockReasonPartialMixedSchema = z
  .object({
    code: z.literal("partial_dependency_and_parent"),
    summary: z.literal(
      "未完了の一部依存と子タスクがあります。親自身の作業は続行できます。",
    ),
  })
  .strict();
const blockReasonFullMixedSchema = z
  .object({
    code: z.literal("full_dependency_and_parent"),
    summary: z.literal(
      "未完了の依存先と子タスクがあり、完全ブロックされています。",
    ),
  })
  .strict();
const blockReasonDependencyCycleSchema = z
  .object({
    code: z.literal("dependency_cycle"),
    summary: z.literal("依存関係が循環しています。"),
  })
  .strict();
const blockReasonParentCycleSchema = z
  .object({
    code: z.literal("parent_cycle"),
    summary: z.literal("親子関係が循環しています。"),
  })
  .strict();
const blockReasonCompletionSchema = z
  .object({
    code: z.literal("completion_confirmation"),
    summary: z.literal("子タスクの完了確認が必要です。"),
  })
  .strict();

/** タスクのブロック理由の安全な要約を検証するスキーマです。 */
export const viewModelBlockReasonSchema = z.discriminatedUnion("code", [
  blockReasonPartialSchema,
  blockReasonFullSchema,
  blockReasonPartialParentSchema,
  blockReasonFullChildrenOnlySchema,
  blockReasonPartialMixedSchema,
  blockReasonFullMixedSchema,
  blockReasonDependencyCycleSchema,
  blockReasonParentCycleSchema,
  blockReasonCompletionSchema,
]);

/** 子タスクの完了数を検証するスキーマです。 */
export const viewModelChildProgressSchema = z
  .object({
    completed_count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((progress, context) => {
    if (progress.completed_count > progress.total_count) {
      context.addIssue({
        code: "custom",
        path: ["completed_count"],
        message: "完了数は子タスク総数を超えられません。",
      });
    }
  });

const taskRowBaseSchema = z
  .object({
    gid: gidSchema,
    title: boundedTitleSchema,
    status: taskStatusSchema,
    importance: importanceSchema,
    due: viewModelDueSchema,
    block_state: blockStateSchema,
    block_reason: viewModelBlockReasonSchema.optional(),
    area: boundedMessageSchema,
    reason_chips: z.array(boundedChipSchema).max(maximumReasonChipCount),
    child_progress: viewModelChildProgressSchema,
    has_dependencies: z.boolean(),
    has_children: z.boolean(),
    warning_count: z.number().int().nonnegative(),
  })
  .strict();

const rankedTaskRowSchema = taskRowBaseSchema.extend({
  kind: z.literal("ranked"),
  rank: z.number().int().positive(),
});

const excludedTaskRowSchema = taskRowBaseSchema.extend({
  kind: z.literal("excluded"),
  exclusion_reasons: z
    .array(
      z
        .object({
          code: rankingExclusionReasonCodeSchema,
          message: boundedMessageSchema,
        })
        .strict(),
    )
    .min(1)
    .max(maximumReasonChipCount),
});

const unavailableReasonCodeSchema = z.enum([
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

const uniqueUnavailableReasonCodesSchema = z
  .array(unavailableReasonCodeSchema)
  .min(1)
  .max(maximumReasonChipCount)
  .superRefine((reasons, context) => {
    const seen = new Set<string>();
    reasons.forEach((reason, index) => {
      if (seen.has(reason)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じ利用不能理由を重複して返せません。",
        });
      }
      seen.add(reason);
    });
  });

const unavailableTaskRowSchema = taskRowBaseSchema.extend({
  kind: z.literal("unavailable"),
  unavailable_reasons: uniqueUnavailableReasonCodesSchema,
});

/** 全体一覧のタスク行を検証するスキーマです。 */
export const viewModelTaskRowSchema = z.discriminatedUnion("kind", [
  rankedTaskRowSchema,
  excludedTaskRowSchema,
  unavailableTaskRowSchema,
]);

/** 順位計算の表示状態を検証するスキーマです。 */
export const viewModelRankingSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("available"),
      calculated_at: isoDateTimeSchema,
      app_version: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
    })
    .strict(),
]);

const cleanupTaskScopeSchema = z
  .object({
    scope: z.literal("task"),
    task_gid: gidSchema,
    related_task_gids: uniqueGidsSchema.optional(),
  })
  .strict();

const cleanupGlobalScopeSchema = z
  .object({
    scope: z.literal("global"),
    related_task_gids: uniqueGidsSchema.optional(),
  })
  .strict();

/** 要整理項目の表示範囲を検証するスキーマです。 */
export const viewModelCleanupScopeSchema = z.discriminatedUnion("scope", [
  cleanupTaskScopeSchema,
  cleanupGlobalScopeSchema,
]);

/** 要整理項目の表示値を検証するスキーマです。 */
export const viewModelCleanupItemSchema = z
  .object({
    kind: cleanupItemKindSchema,
    message: boundedMessageSchema,
    scope: viewModelCleanupScopeSchema,
  })
  .strict();

/** 全体一覧を検証するスキーマです。 */
export const viewModelOverviewSchema = z
  .object({
    project_gid: gidSchema,
    last_successful_sync_at: isoDateTimeSchema,
    last_full_sync_at: isoDateTimeSchema.optional(),
    ranking: viewModelRankingSchema,
    default_filter: z.literal("ranked"),
    tasks: z.array(viewModelTaskRowSchema).max(maximumTaskCount),
    areas: z.array(boundedMessageSchema).min(1).max(maximumTaskCount),
    cleanup_items: z.array(viewModelCleanupItemSchema).max(maximumCleanupCount),
    cleanup_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((overview, context) => {
    const taskGids = new Set<string>();
    const rankedRanks = new Set<number>();
    overview.tasks.forEach((task, index) => {
      if (taskGids.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "gid"],
          message: "同じタスクGIDを重複して返せません。",
        });
      }
      taskGids.add(task.gid);
      if (task.kind === "ranked") {
        if (rankedRanks.has(task.rank)) {
          context.addIssue({
            code: "custom",
            path: ["tasks", index, "rank"],
            message: "同じ順位を重複して返せません。",
          });
        }
        rankedRanks.add(task.rank);
      }
    });
    const areas = new Set<string>();
    overview.areas.forEach((area, index) => {
      if (areas.has(area)) {
        context.addIssue({
          code: "custom",
          path: ["areas", index],
          message: "同じ領域名を重複して返せません。",
        });
      }
      areas.add(area);
    });
    if (overview.cleanup_count !== overview.cleanup_items.length) {
      context.addIssue({
        code: "custom",
        path: ["cleanup_count"],
        message: "要整理件数と要整理項目数が一致しません。",
      });
    }
  });

/** タスク参照の表示値を検証するスキーマです。 */
export const viewModelTaskReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("found"),
      gid: gidSchema,
      title: boundedTitleSchema,
      status: taskStatusSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("missing"),
      gid: gidSchema,
    })
    .strict(),
]);

/** 依存関係の表示値を検証するスキーマです。 */
export const viewModelDependencyReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("found"),
      gid: gidSchema,
      title: boundedTitleSchema,
      status: taskStatusSchema,
      scope: dependencyScopeSchema,
      source: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("missing"),
      gid: gidSchema,
      scope: dependencyScopeSchema,
      source: z.string().min(1).max(256),
    })
    .strict(),
]);

const detailRankingSharedShape = {
  calculated_at: isoDateTimeSchema.optional(),
  activity_elapsed_days: z.number().int().nonnegative().optional(),
  detail_text: boundedRankingDetailSchema.optional(),
  score_breakdown: rankingScoreBreakdownSchema.optional(),
  release_target_gids: uniqueGidsSchema.optional(),
  reason_chips: z.array(boundedChipSchema).max(maximumReasonChipCount).optional(),
  tie_break: rankingTieBreakSchema.optional(),
  exclusion_reasons: z
    .array(
      z
        .object({
          code: rankingExclusionReasonCodeSchema,
          message: boundedMessageSchema,
        })
        .strict(),
    )
    .max(maximumReasonChipCount)
    .optional(),
};

const rankedDetailRankingSchema = z
  .object({
    kind: z.literal("ranked"),
    rank: z.number().int().positive(),
    ...detailRankingSharedShape,
    calculated_at: isoDateTimeSchema,
    activity_elapsed_days: z.number().int().nonnegative(),
    detail_text: boundedRankingDetailSchema,
    score_breakdown: rankingScoreBreakdownSchema,
    release_target_gids: uniqueGidsSchema,
    reason_chips: z.array(boundedChipSchema).max(maximumReasonChipCount),
    tie_break: rankingTieBreakSchema,
    exclusion_reasons: z.array(z.never()),
  })
  .strict();

const excludedDetailRankingSchema = z
  .object({
    kind: z.literal("excluded"),
    ...detailRankingSharedShape,
    calculated_at: isoDateTimeSchema,
    activity_elapsed_days: z.number().int().nonnegative(),
    detail_text: boundedRankingDetailSchema,
    exclusion_reasons: z
      .array(
        z
          .object({
            code: rankingExclusionReasonCodeSchema,
            message: boundedMessageSchema,
          })
          .strict(),
      )
      .min(1)
      .max(maximumReasonChipCount),
    release_target_gids: uniqueGidsSchema,
    reason_chips: z.array(boundedChipSchema).max(maximumReasonChipCount),
    tie_break: rankingTieBreakSchema,
  })
  .strict();

const unavailableDetailRankingSchema = z
  .object({
    kind: z.literal("unavailable"),
    reason_codes: uniqueUnavailableReasonCodesSchema,
    ...detailRankingSharedShape,
  })
  .strict();

/** タスク詳細の順位情報を検証するスキーマです。 */
export const viewModelTaskRankingSchema = z.discriminatedUnion("kind", [
  rankedDetailRankingSchema,
  excludedDetailRankingSchema,
  unavailableDetailRankingSchema,
]);

/** タスク詳細を検証するスキーマです。 */
export const viewModelTaskDetailSchema = z
  .object({
    project_gid: gidSchema,
    gid: gidSchema,
    title: boundedTitleSchema,
    notes: boundedNotesSchema,
    status: taskStatusSchema,
    importance: importanceSchema,
    due: viewModelDueSchema,
    area: boundedMessageSchema,
    block_state: blockStateSchema,
    block_reason: viewModelBlockReasonSchema.optional(),
    section_gid: gidSchema,
    parent_work_mode: parentWorkModeSchema,
    activity_anchor_on: dateSchema,
    ranking: viewModelTaskRankingSchema,
    dependencies: z.array(viewModelDependencyReferenceSchema).max(maximumRelationCount),
    dependents: z.array(viewModelDependencyReferenceSchema).max(maximumRelationCount),
    parent: viewModelTaskReferenceSchema.optional(),
    children: z.array(viewModelTaskReferenceSchema).max(maximumRelationCount),
    child_progress: viewModelChildProgressSchema,
    has_dependencies: z.boolean(),
    has_children: z.boolean(),
    obsidian_links: obsidianLinksSchema,
    asana_url: z
      .string()
      .url()
      .refine((value) => {
        try {
          const url = new URL(value);
          return (
            url.protocol === "https:" &&
            url.hostname.toLowerCase() === "app.asana.com" &&
            url.username.length === 0 &&
            url.password.length === 0
          );
        } catch {
          return false;
        }
      }, "AsanaのHTTPS URLを指定してください。"),
    cleanup_warnings: z.array(viewModelCleanupItemSchema).max(maximumCleanupCount),
  })
  .strict();

export type ViewModelDue = z.infer<typeof viewModelDueSchema>;
export type ViewModelBlockReason = z.infer<typeof viewModelBlockReasonSchema>;
export type ViewModelChildProgress = z.infer<typeof viewModelChildProgressSchema>;
export type ViewModelTaskRow = z.infer<typeof viewModelTaskRowSchema>;
export type ViewModelUnavailableReasonCode = z.infer<typeof unavailableReasonCodeSchema>;
export type ViewModelRanking = z.infer<typeof viewModelRankingSchema>;
export type ViewModelCleanupScope = z.infer<typeof viewModelCleanupScopeSchema>;
export type ViewModelCleanupItem = z.infer<typeof viewModelCleanupItemSchema>;
export type ViewModelOverview = z.infer<typeof viewModelOverviewSchema>;
export type ViewModelTaskReference = z.infer<typeof viewModelTaskReferenceSchema>;
export type ViewModelDependencyReference = z.infer<
  typeof viewModelDependencyReferenceSchema
>;
export type ViewModelTaskRanking = z.infer<typeof viewModelTaskRankingSchema>;
export type ViewModelTaskDetail = z.infer<typeof viewModelTaskDetailSchema>;
