import { z } from "zod";
import {
  asanaSnapshotNormalizationInputSchema,
  asanaSnapshotNormalizationResultSchema,
  calculateTaskRanking,
  type RankingDetail,
  type RankingExclusionReason,
  type RankingScoreBreakdown,
  type RankingTieBreak,
  type RankedTaskResult,
  type ExcludedTaskResult,
  type SnapshotNormalizationInput,
  type SnapshotNormalizationResult,
} from "../../domain";
import { asanaNormalizationPlanApplierResultSchema } from "./normalization-plan";

const asanaTaskResponseSchema =
  asanaSnapshotNormalizationInputSchema.shape.tasks.element;
const dateSchema = asanaSnapshotNormalizationInputSchema.shape.activity_date;
const gidSchema = asanaSnapshotNormalizationInputSchema.shape.project_gid;
const taskStatusSchema =
  asanaSnapshotNormalizationResultSchema.shape.tasks.element.shape.status;

type AsanaTaskResponse = SnapshotNormalizationInput["tasks"][number];
type RankingCacheDetailData = Pick<
  RankingDetail,
  "exclusion_reasons" | "tie_break" | "reason_chips" | "text"
>;
type CriticalError = SnapshotNormalizationResult["critical_errors"][number]["code"];
type RankingCacheData = {
  readonly app_version: string;
  readonly calculated_at: string;
  readonly ranked_tasks: readonly (
    Pick<
      RankedTaskResult,
      "gid" | "rank" | "score_breakdown" | "release_target_gids" | "reason_chips" | "tie_break"
    > & { readonly detail: RankingCacheDetailData }
  )[];
  readonly excluded_tasks: readonly (
    Pick<
      ExcludedTaskResult,
      "gid" | "exclusion_reasons" | "score_breakdown" | "release_target_gids" | "reason_chips" | "tie_break"
    > & { readonly detail: RankingCacheDetailData }
  )[];
};

export const sortedGidArraySchema = z
  .array(gidSchema)
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const [index, gid] of gids.entries()) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じGIDを重複して指定できません。",
        });
      }
      if (previous != null && previous >= gid) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "GID順に並べて指定してください。",
        });
      }
      seen.add(gid);
      previous = gid;
    }
  });

export const normalizationPlanSummarySchema = z
  .object({
    status_write_task_gids: sortedGidArraySchema,
    external_write_task_gids: sortedGidArraySchema,
    tag_write_task_gids: sortedGidArraySchema,
  })
  .strict();

const normalizationNotificationSchema = z
  .object({
    kind: z.literal("status_reconciled"),
    task_gid: gidSchema,
    status: taskStatusSchema,
    message: z.string().min(1).max(160),
  })
  .strict();

export const normalizationNotificationsSchema = z
  .array(normalizationNotificationSchema)
  .max(10_000)
  .superRefine((notifications, context) => {
    let previousTaskGid: string | undefined;
    for (const [index, notification] of notifications.entries()) {
      if (
        previousTaskGid != null
        && previousTaskGid >= notification.task_gid
      ) {
        context.addIssue({
          code: "custom",
          path: [index, "task_gid"],
          message: "正規化通知は重複させずタスクGID順に指定してください。",
        });
      }
      previousTaskGid = notification.task_gid;
    }
  });
type NormalizationNotification = z.infer<typeof normalizationNotificationSchema>;
type NormalizationOperation = z.infer<
  typeof asanaNormalizationPlanApplierResultSchema
>["operations"][number];
export type NormalizationApplicationOutcome =
  | {
    readonly kind: "applied";
    readonly applicationResult: z.infer<
      typeof asanaNormalizationPlanApplierResultSchema
    >;
    readonly rawTasks: readonly AsanaTaskResponse[];
    readonly normalization: SnapshotNormalizationResult;
  }
  | {
    readonly kind: "skipped_missing_section";
    readonly applicationResult: z.infer<
      typeof asanaNormalizationPlanApplierResultSchema
    >;
    readonly rawTasks: readonly AsanaTaskResponse[];
    readonly normalization: SnapshotNormalizationResult;
  };
/** 文字列を辞書順で比較します。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isStatusReconciliationOperation(
  operation: NormalizationOperation,
): boolean {
  switch (operation.operation) {
    case "move_section":
    case "set_completed":
    case "initialize_external_data":
    case "update_last_active_status":
      return true;
    case "update_activity_anchor_on":
    case "add_tag":
    case "remove_tag":
      return false;
  }
}

/** 適用後に成立した状態整合化通知を作成します。 */
export function createNormalizationNotifications(
  initialNormalization: SnapshotNormalizationResult,
  finalNormalization: SnapshotNormalizationResult,
  applicationOutcome: NormalizationApplicationOutcome,
): readonly NormalizationNotification[] {
  if (applicationOutcome.kind === "skipped_missing_section") {
    return normalizationNotificationsSchema.parse([]);
  }
  const finalTasks = new Map(
    finalNormalization.tasks.map((task) => [task.gid, task]),
  );
  const finalStatusPlans = new Map(
    finalNormalization.status_plans.map((plan) => [plan.task_gid, plan]),
  );
  const notifications: NormalizationNotification[] = [];
  for (const plan of initialNormalization.status_plans) {
    if (plan.kind !== "reconciled" || plan.notification == null) {
      continue;
    }
    const operations = applicationOutcome.applicationResult.operations.filter(
      (operation) =>
        operation.task_gid === plan.task_gid
        && isStatusReconciliationOperation(operation),
    );
    if (
      operations.length === 0
      || operations.some((operation) => operation.outcome === "conflict")
    ) {
      continue;
    }
    const finalTask = finalTasks.get(plan.task_gid);
    const finalStatusPlan = finalStatusPlans.get(plan.task_gid);
    if (finalTask == null || finalStatusPlan == null) {
      throw new Error("正規化通知対象の最終タスク状態を取得できません。");
    }
    if (
      finalTask.status !== plan.notification.status
      || finalStatusPlan.kind !== "reconciled"
      || finalStatusPlan.notification != null
    ) {
      continue;
    }
    notifications.push({
      kind: plan.notification.kind,
      task_gid: plan.task_gid,
      status: plan.notification.status,
      message: plan.notification.message,
    });
  }
  return normalizationNotificationsSchema.parse(
    notifications.sort((left, right) =>
      compareStrings(left.task_gid, right.task_gid),
    ),
  );
}
/** Asanaタスクを検証してGID順に並べます。 */
export function sortedTasks(
  tasks: readonly AsanaTaskResponse[],
): AsanaTaskResponse[] {
  return [...tasks]
    .map((task) => asanaTaskResponseSchema.parse(task))
    .sort((left, right) => compareStrings(left.gid, right.gid));
}

/** 文字列の重複を除いて辞書順に並べます。 */
export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/** 同期日時をJSTの日付へ変換します。 */
export function jstDateFromTimestamp(timestamp: string): string {
  const epoch = Date.parse(timestamp);
  if (Number.isNaN(epoch)) {
    throw new Error("同期日時をJSTの日付へ変換できません。");
  }
  const jstDate = new Date(epoch + 9 * 60 * 60 * 1000);
  const year = String(jstDate.getUTCFullYear()).padStart(4, "0");
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  return dateSchema.parse(`${year}-${month}-${day}`);
}

/** 保護条件に応じて外部データ書き込み計画を除きます。 */
export function protectExternalDataWrites(
  normalization: SnapshotNormalizationResult,
  protectionRequired: boolean,
): SnapshotNormalizationResult {
  if (!protectionRequired) {
    return asanaSnapshotNormalizationResultSchema.parse(normalization);
  }
  const emptyExternalDataWrites = Object.fromEntries(
    Object.entries(normalization.external_data_writes).map(([name, writes]) => {
      if (!Array.isArray(writes)) {
        throw new Error("外部メタデータ書き込み計画が配列ではありません。");
      }
      return [name, []];
    }),
  );
  return asanaSnapshotNormalizationResultSchema.parse({
    ...normalization,
    external_data_writes: emptyExternalDataWrites,
  });
}

/** 操作のない正規化適用結果を作成します。 */
export function createEmptyApplicationResult(): z.infer<
  typeof asanaNormalizationPlanApplierResultSchema
> {
  return asanaNormalizationPlanApplierResultSchema.parse({
    affected_gids: [],
    operations: [],
  });
}
/** 正規化結果から順位キャッシュの内容を組み立てます。 */
export function createRankingCacheData(
  normalization: SnapshotNormalizationResult,
  appVersion: string,
  asOf: string,
): RankingCacheData {
  const graphByGid = new Map(
    normalization.graph.tasks.map((task) => [task.gid, task]),
  );
  const criticalByGid = new Map<string, CriticalError[]>();
  for (const error of normalization.critical_errors) {
    const existing = criticalByGid.get(error.task_gid) ?? [];
    existing.push(error.code);
    criticalByGid.set(error.task_gid, existing);
  }
  const rankingTasks = normalization.tasks.map((task) => {
    const graphTask = graphByGid.get(task.gid);
    if (graphTask == null) {
      throw new Error("順位計算用のグラフタスクを取得できません。");
    }
    const criticalErrors = criticalByGid.get(task.gid) ?? [];
    return {
      ...task,
      ...(graphTask.dependency_cycle ? { dependency_cycle: true } : {}),
      ...(graphTask.parent_cycle ? { parent_cycle: true } : {}),
      ...(graphTask.completion_confirmation
        ? { completion_confirmation: true }
        : {}),
      ...(criticalErrors.length > 0
        ? { critical_errors: criticalErrors }
        : {}),
    };
  });
  const ranking = calculateTaskRanking({
    app_version: appVersion,
    as_of: asOf,
    tasks: rankingTasks,
  });
  return {
    app_version: ranking.app_version,
    calculated_at: ranking.calculated_at,
    ranked_tasks: ranking.ranked_tasks.map((task) => ({
      gid: task.gid,
      rank: task.rank,
      score_breakdown: task.score_breakdown,
      release_target_gids: task.release_target_gids,
      reason_chips: task.reason_chips,
      tie_break: task.tie_break,
      detail: {
        exclusion_reasons: task.detail.exclusion_reasons,
        tie_break: task.detail.tie_break,
        reason_chips: task.detail.reason_chips,
        text: createRankingDetailText(
          task.score_breakdown,
          task.detail.exclusion_reasons,
          task.detail.reason_chips,
          task.detail.tie_break,
        ),
      },
    })),
    excluded_tasks: ranking.excluded_tasks.map((task) => ({
      gid: task.gid,
      exclusion_reasons: task.exclusion_reasons,
      ...(task.score_breakdown == null
        ? {}
        : { score_breakdown: task.score_breakdown }),
      release_target_gids: task.release_target_gids,
      reason_chips: task.reason_chips,
      tie_break: task.tie_break,
      detail: {
        exclusion_reasons: task.detail.exclusion_reasons,
        tie_break: task.detail.tie_break,
        reason_chips: task.detail.reason_chips,
        text: createRankingDetailText(
          task.score_breakdown,
          task.detail.exclusion_reasons,
          task.detail.reason_chips,
          task.detail.tie_break,
        ),
      },
    })),
  };
}

function createRankingDetailText(
  scoreBreakdown: RankingScoreBreakdown | undefined,
  exclusionReasons: readonly RankingExclusionReason[],
  reasonChips: readonly string[],
  tieBreak: RankingTieBreak,
): string {
  const scoreText = scoreBreakdown == null
    ? "点数: 完全ブロックのため算出しません。"
    : `点数: 重要度${scoreBreakdown.importance_points}、期限${scoreBreakdown.deadline_points}、解放${scoreBreakdown.release_points}、一部ブロック減点${scoreBreakdown.partial_block_penalty}、停滞減点${scoreBreakdown.stagnation_penalty}、実行点${scoreBreakdown.execution_points}`;
  const exclusionText = exclusionReasons.length === 0
    ? "除外理由: なし"
    : `除外理由: ${exclusionReasons.map((reason) => reason.message).join("、")}`;
  const effectiveDueText = tieBreak.effective_due_at == null
    ? "なし"
    : tieBreak.effective_due_at;
  const tieBreakText = `タイブレーク: 実効期限${effectiveDueText}、重要度${tieBreak.importance}、解放点${tieBreak.release_points}、活動基準日${tieBreak.activity_anchor_on}、GID${tieBreak.gid}`;
  return [
    scoreText,
    exclusionText,
    `理由チップ: ${reasonChips.join("、")}`,
    tieBreakText,
  ].join("\n");
}

/** 残存する正規化計画の対象GIDを集約します。 */
export function createNormalizationPlanSummary(
  normalization: SnapshotNormalizationResult,
): z.infer<typeof normalizationPlanSummarySchema> {
  return normalizationPlanSummarySchema.parse({
    status_write_task_gids: sortedUnique(
      normalization.status_plans
        .filter((plan) => plan.kind === "reconciled" && plan.writes.length > 0)
        .map((plan) => plan.task_gid),
    ),
    external_write_task_gids: sortedUnique([
      ...normalization.external_data_writes.initialization_requests.map(
        (request) => request.task_gid,
      ),
      ...normalization.external_data_writes.last_active_status_updates.map(
        (update) => update.task_gid,
      ),
      ...normalization.external_data_writes.activity_anchor_on_updates.map(
        (update) => update.task_gid,
      ),
    ]),
    tag_write_task_gids: sortedUnique(
      normalization.tag_plans
        .filter(
          (plan) =>
            plan.added_tag_names.length > 0
            || plan.removed_tag_gids.length > 0,
        )
        .map((plan) => plan.task_gid),
    ),
  });
}
