import { z } from "zod";
import type { TaskReadRanking } from "../../application/common/ports/task-read-repository";

type RankingSchemaDependencies = {
  readonly dateSchema: z.ZodType<string>;
  readonly gidSchema: z.ZodType<string>;
  readonly identifierSchema: z.ZodType<string>;
  readonly importanceSchema: z.ZodType<TaskReadRanking["ranked_tasks"][number]["tie_break"]["importance"]>;
  readonly isoDateTimeSchema: z.ZodType<string>;
};

/** SQLite順位キャッシュの保存形式を検証するスキーマを作ります。 */
export function createRankingCacheSchema(dependencies: RankingSchemaDependencies): z.ZodType<TaskReadRanking> {
  const { dateSchema, gidSchema, identifierSchema, importanceSchema, isoDateTimeSchema } = dependencies;
  const nonEmptyTextSchema = z.string().refine((value) => value.length > 0, {
    message: "空でない文字列を指定してください。",
  });

  const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "空白だけでない文字列を指定してください。",
  });

  /** 順位点数の内訳を検証するスキーマです。 */
  const rankingScoreBreakdownSchema = z
    .object({
      importance_points: z.number().int().nonnegative(),
      deadline_points: z.number().int().nonnegative(),
      release_points: z.number().int().nonnegative(),
      partial_block_penalty: z.number().int().nonnegative(),
      stagnation_penalty: z.number().int().nonnegative(),
      execution_points: z.number().int(),
    })
    .strict();

  /** 順位除外理由コードを検証するスキーマです。 */
  const rankingExclusionReasonCodeSchema = z.enum([
    "inactive_status",
    "full_block",
    "dependency_cycle",
    "parent_cycle",
    "completion_confirmation",
    "critical_error",
  ]);

  /** 順位除外理由のコードと説明を検証するスキーマです。 */
  const rankingExclusionReasonSchema = z
    .object({
      code: rankingExclusionReasonCodeSchema,
      message: nonBlankTextSchema,
    })
    .strict();

  /** 順位の同点判定値を検証するスキーマです。 */
  const rankingTieBreakSchema = z
    .object({
      effective_due_at: isoDateTimeSchema.optional(),
      importance: importanceSchema,
      release_points: z.number().int().nonnegative(),
      activity_anchor_on: dateSchema,
      gid: gidSchema,
    })
    .strict();

  /** 順位説明からタスク本文を除いた保存部分を検証するスキーマです。 */
  const rankingCacheDetailSchema = z
    .object({
      exclusion_reasons: z.array(rankingExclusionReasonSchema),
      tie_break: rankingTieBreakSchema,
      reason_chips: z.array(nonBlankTextSchema),
      text: nonEmptyTextSchema,
    })
    .strict();

  const rankingReleaseTargetGidsSchema = z
    .array(gidSchema)
    .superRefine((gids, context) => {
      const seen = new Set<string>();
      gids.forEach((gid, index) => {
        if (seen.has(gid)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じ解放対象タスクGIDを重複して保存できません。",
          });
        }
        seen.add(gid);
      });
    });

  const rankingCacheRankedTaskSchema = z
    .object({
      gid: gidSchema,
      rank: z.number().int().positive(),
      score_breakdown: rankingScoreBreakdownSchema,
      release_target_gids: rankingReleaseTargetGidsSchema,
      reason_chips: z.array(nonBlankTextSchema),
      tie_break: rankingTieBreakSchema,
      detail: rankingCacheDetailSchema,
    })
    .strict();

  const rankingCacheExcludedTaskSchema = z
    .object({
      gid: gidSchema,
      exclusion_reasons: z
        .array(rankingExclusionReasonSchema)
        .min(1)
        .superRefine((reasons, context) => {
          const seen = new Set<z.infer<typeof rankingExclusionReasonCodeSchema>>();
          reasons.forEach((reason, index) => {
            if (seen.has(reason.code)) {
              context.addIssue({
                code: "custom",
                path: [index],
                message: "同じ順位除外理由コードを重複して保存できません。",
              });
              return;
            }
            seen.add(reason.code);
          });
        }),
      score_breakdown: rankingScoreBreakdownSchema.optional(),
      release_target_gids: rankingReleaseTargetGidsSchema,
      reason_chips: z.array(nonBlankTextSchema),
      tie_break: rankingTieBreakSchema,
      detail: rankingCacheDetailSchema,
    })
    .strict();

  /** 順位キャッシュのスナップショットを検証するスキーマです。 */
  return z
    .object({
      app_version: identifierSchema,
      calculated_at: isoDateTimeSchema,
      ranked_tasks: z.array(rankingCacheRankedTaskSchema),
      excluded_tasks: z.array(rankingCacheExcludedTaskSchema),
    })
    .strict()
    .superRefine((cache, context) => {
      const seen = new Set<string>();
      cache.ranked_tasks.forEach((task, index) => {
        if (task.rank !== index + 1) {
          context.addIssue({
            code: "custom",
            path: ["ranked_tasks", index, "rank"],
            message: "順位キャッシュの順位は配列順の1からの連番でなければなりません。",
          });
        }
        if (seen.has(task.gid)) {
          context.addIssue({
            code: "custom",
            path: ["ranked_tasks", index, "gid"],
            message: "同じタスクGIDを順位キャッシュへ重複して保存できません。",
          });
          return;
        }
        seen.add(task.gid);
      });
      cache.excluded_tasks.forEach((task, index) => {
        if (seen.has(task.gid)) {
          context.addIssue({
            code: "custom",
            path: ["excluded_tasks", index, "gid"],
            message: "同じタスクGIDを順位キャッシュへ重複して保存できません。",
          });
          return;
        }
        seen.add(task.gid);
      });
    }) satisfies z.ZodType<TaskReadRanking>;
}
