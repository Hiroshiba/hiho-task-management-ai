import { z } from "zod";
import {
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  cleanupItemsSchema,
  dateSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  taskStatusSchema,
  type AsanaTaskResponse,
  type CleanupItem,
  type Task,
} from "../../../shared/domain";
import {
  asanaSnapshotNormalizationResultSchema,
  calculateTaskRanking,
  ingestAsanaExternalData,
  normalizeAsanaSnapshot,
  type SnapshotNormalizationResult,
} from "../../domain";
import {
  deviceSectionGidsSchema,
  projectMetadataCacheSchema,
  rankingCacheSchema,
  syncStateSchema,
  taskCacheEntriesSchema,
  type ProjectMetadataCache,
  type RankingExclusionReason,
  type RankingCache,
  type RankingScoreBreakdown,
  type SyncState,
  type TaskCacheEntry,
  type RankingTieBreak,
} from "../../../shared/storage";
import { AsanaReadClient } from "../client/client";
import { setupManifest } from "../setup/manifest";
import {
  AsanaDeltaSyncSource,
  asanaDeltaSyncResultSchema,
  type AsanaDeltaSyncResult,
} from "./delta-sync-source";
import {
  AsanaFullSyncSource,
  asanaFullSyncResultSchema,
  type AsanaFullSyncResult,
} from "./full-sync-source";
import {
  AsanaNormalizationPlanApplier,
  asanaNormalizationPlanApplierResultSchema,
} from "./normalization-plan-applier";
import { StorageDatabase } from "../../storage";
import { asanaSyncTokenSchema } from "../sync-token";

const synchronizationModeSchema = z.enum(["full", "delta"]);
const oauthMismatchManagedTaskThreshold = 10;
const fallbackReasonSchema = z.enum([
  "sync_token_missing",
  "metadata_missing",
  "events_reset",
  "unsafe_structure",
]);

const criticalErrorCodeSchema = z.enum([
  "project_membership_missing",
  "project_membership_multiple",
  "unknown_status_section",
  "custom_external_data_broken",
  "custom_external_data_unknown_schema",
  "custom_external_data_identity_mismatch",
  "dependency_cycle",
  "parent_cycle",
]);

const sortedGidArraySchema = z
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

const normalizationPlanSummarySchema = z
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

const normalizationNotificationsSchema = z
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

const coordinatorInputSchema = z
  .object({
    mode: synchronizationModeSchema,
    project_gid: gidSchema,
    section_gids: deviceSectionGidsSchema,
    device_id: identifierSchema,
    app_version: identifierSchema,
  })
  .strict();

const coordinatorResultSchema = z
  .object({
    requested_mode: synchronizationModeSchema,
    performed_mode: synchronizationModeSchema,
    fallback_reason: fallbackReasonSchema.optional(),
    synced_at: isoDateTimeSchema,
    events_token: asanaSyncTokenSchema.optional(),
    application_result: asanaNormalizationPlanApplierResultSchema,
    normalization_notifications: normalizationNotificationsSchema,
    remaining_plan: normalizationPlanSummarySchema,
    critical_errors: z.array(
      z
        .object({
          task_gid: gidSchema,
          code: criticalErrorCodeSchema,
        })
        .strict(),
    ),
    cleanup_items: cleanupItemsSchema,
    ranking_cache: rankingCacheSchema,
  })
  .strict();

export type AsanaSyncCoordinatorInput = z.infer<typeof coordinatorInputSchema>;
export type AsanaSyncCoordinatorResult = z.infer<
  typeof coordinatorResultSchema
>;
export type SyncTimestampProvider = () => string;

/** Asana同期が同時実行されたことを表すエラーです。 */
export class AsanaSyncInProgressError extends Error {
  public constructor() {
    super("Asana同期はすでに実行中です。");
    this.name = "AsanaSyncInProgressError";
  }
}

/** Asana同期コーディネーターの入力を検証するスキーマです。 */
export const asanaSyncCoordinatorInputSchema = coordinatorInputSchema;

/** Asana同期コーディネーターの結果を検証するスキーマです。 */
export const asanaSyncCoordinatorResultSchema = coordinatorResultSchema;

/** Asana同期で利用者へ伝える正規化通知を検証するスキーマです。 */
export const asanaSyncNormalizationNotificationsSchema =
  normalizationNotificationsSchema;

type SynchronizationMode = z.infer<typeof synchronizationModeSchema>;
type FallbackReason = z.infer<typeof fallbackReasonSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
type CriticalError = z.infer<typeof criticalErrorCodeSchema>;
type NormalizationNotification = z.infer<typeof normalizationNotificationSchema>;
type NormalizationOperation = z.infer<
  typeof asanaNormalizationPlanApplierResultSchema
>["operations"][number];
type ProjectMetadataSource = Omit<ProjectMetadataCache, "cached_at">;
type EstablishedEventsToken = {
  readonly sync_token: string;
};
type MaterializedDelta = {
  readonly sync_token: string;
  readonly upsert: readonly AsanaTaskResponse[];
  readonly missing_gids: readonly string[];
  readonly workspace_tags: readonly AsanaTagResponse[];
  readonly metadata: ProjectMetadataSource;
};
type RequiredSectionInspection = {
  readonly cleanupItems: readonly CleanupItem[];
  readonly hasMissingGid: boolean;
};
type NormalizationApplicationOutcome =
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

type CollectionSnapshot = {
  readonly performed_mode: SynchronizationMode;
  readonly raw_tasks: readonly AsanaTaskResponse[];
  readonly workspace_tags: readonly AsanaTagResponse[];
  readonly metadata: ProjectMetadataSource;
  readonly events_token?: string;
  readonly inaccessible_gids: readonly string[];
  readonly fallback_reason?: FallbackReason;
};

function compareStrings(left: string, right: string): number {
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

function createNormalizationNotifications(
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

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function sortedTasks(
  tasks: readonly AsanaTaskResponse[],
): AsanaTaskResponse[] {
  return [...tasks]
    .map((task) => asanaTaskResponseSchema.parse(task))
    .sort((left, right) => compareStrings(left.gid, right.gid));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function jstDateFromTimestamp(timestamp: string): string {
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

function uniqueCleanupItems(
  items: readonly CleanupItem[],
): CleanupItem[] {
  const byValue = new Map<string, CleanupItem>();
  for (const item of cleanupItemsSchema.parse(items)) {
    byValue.set(canonicalizeJson(item), item);
  }
  return cleanupItemsSchema.parse(
    [...byValue.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, item]) => item),
  );
}

function inspectRequiredSections(
  sectionGids: AsanaSyncCoordinatorInput["section_gids"],
  sections: readonly ProjectMetadataCache["sections"][number][],
): RequiredSectionInspection {
  const sectionsByGid = new Map(
    sections.map((section) => [section.gid, section]),
  );
  const cleanupItems: CleanupItem[] = [];
  let hasMissingGid = false;
  for (const requiredSection of setupManifest.sections) {
    const configuredGid = sectionGids[requiredSection.status];
    const actualSection = sectionsByGid.get(configuredGid);
    if (actualSection == null) {
      hasMissingGid = true;
      cleanupItems.push({
        kind: "missing_required_section",
        message: `必須セクション「${requiredSection.name}」の設定済みGID「${configuredGid}」が専用プロジェクトに存在しません。セクションを修復して再設定してください。`,
      });
      continue;
    }
    if (actualSection.name !== requiredSection.name) {
      cleanupItems.push({
        kind: "missing_required_section",
        message: `必須セクション「${requiredSection.name}」の名前が「${actualSection.name}」へ変更されています。セクション名を「${requiredSection.name}」へ戻してください。`,
      });
    }
  }
  return {
    cleanupItems: uniqueCleanupItems(cleanupItems),
    hasMissingGid,
  };
}

function hasGlobalOAuthAppMismatch(
  cleanupItems: readonly CleanupItem[],
): boolean {
  return cleanupItems.some(
    (item) => item.kind === "oauth_app_mismatch" && item.task_gid == null,
  );
}

function hasAllConfiguredSections(
  input: AsanaSyncCoordinatorInput,
  collection: CollectionSnapshot,
): boolean {
  const sectionGids = new Set(
    collection.metadata.sections.map((section) => section.gid),
  );
  return Object.values(input.section_gids).every((sectionGid) =>
    sectionGids.has(sectionGid),
  );
}

function isOAuthAppMismatchSuspected(
  input: AsanaSyncCoordinatorInput,
  collection: CollectionSnapshot,
): boolean {
  if (collection.performed_mode !== "full") {
    return false;
  }
  const workspaceTagNames = new Set(
    collection.workspace_tags.map((tag) => tag.name),
  );
  const allConfiguredTagsExist = setupManifest.tags.every((tag) =>
    workspaceTagNames.has(tag.name),
  );
  return (
    hasAllConfiguredSections(input, collection)
    && allConfiguredTagsExist
    && collection.raw_tasks.length >= oauthMismatchManagedTaskThreshold
    && collection.raw_tasks.every(
      (task) => ingestAsanaExternalData(task).kind === "missing",
    )
  );
}

function shouldProtectExternalDataWrites(
  input: AsanaSyncCoordinatorInput,
  collection: CollectionSnapshot,
  existingCleanupItems: readonly CleanupItem[],
): boolean {
  if (collection.performed_mode === "full") {
    if (!hasAllConfiguredSections(input, collection)) {
      return hasGlobalOAuthAppMismatch(existingCleanupItems);
    }
    return isOAuthAppMismatchSuspected(input, collection);
  }
  return hasGlobalOAuthAppMismatch(existingCleanupItems);
}

function protectExternalDataWrites(
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

function createMissingTaskCleanupItem(taskGid: string): CleanupItem {
  return {
    kind: "missing_task",
    task_gid: taskGid,
    message: "Asana上で削除された可能性があります。",
  };
}

function createMissingTaskCleanupItems(
  previousTasks: readonly Task[],
  rawTasks: readonly AsanaTaskResponse[],
  existingCleanupItems: readonly CleanupItem[],
): CleanupItem[] {
  const currentTaskGids = new Set(rawTasks.map((task) => task.gid));
  const newlyMissingItems = previousTasks
    .filter((task) => !currentTaskGids.has(task.gid))
    .map((task) => createMissingTaskCleanupItem(task.gid));
  const retainedItems = existingCleanupItems
    .filter((item) => item.kind === "missing_task")
    .filter((item) => {
      if (item.task_gid == null) {
        throw new Error("保存済みの消失タスク要整理項目にタスクGIDがありません。");
      }
      return !currentTaskGids.has(item.task_gid);
    });
  return uniqueCleanupItems([...newlyMissingItems, ...retainedItems]);
}

function createGlobalOAuthAppMismatchCleanupItem(): CleanupItem {
  return {
    kind: "oauth_app_mismatch",
    message: "同一のAsana OAuthアプリ設定が必要です。",
  };
}

function createFinalNormalization(
  normalization: SnapshotNormalizationResult,
  protectionRequired: boolean,
  requiredSectionCleanupItems: readonly CleanupItem[],
  missingTaskCleanupItems: readonly CleanupItem[],
): SnapshotNormalizationResult {
  const protectedNormalization = protectExternalDataWrites(
    normalization,
    protectionRequired,
  );
  const globalOAuthItems = protectionRequired
    ? [createGlobalOAuthAppMismatchCleanupItem()]
    : [];
  return asanaSnapshotNormalizationResultSchema.parse({
    ...protectedNormalization,
    cleanup_items: uniqueCleanupItems([
      ...protectedNormalization.cleanup_items,
      ...globalOAuthItems,
      ...requiredSectionCleanupItems,
      ...missingTaskCleanupItems,
    ]),
  });
}

function createEmptyApplicationResult(): z.infer<
  typeof asanaNormalizationPlanApplierResultSchema
> {
  return asanaNormalizationPlanApplierResultSchema.parse({
    affected_gids: [],
    operations: [],
  });
}

function isMetadataSufficient(
  metadata: ProjectMetadataCache | undefined,
  projectGid: string,
  sectionGids: AsanaSyncCoordinatorInput["section_gids"],
): metadata is ProjectMetadataCache {
  if (metadata == null || metadata.project.gid !== projectGid) {
    return false;
  }
  const availableSections = new Set(
    metadata.sections.map((section) => section.gid),
  );
  if (
    !Object.values(sectionGids).every((sectionGid) =>
      availableSections.has(sectionGid),
    )
  ) {
    return false;
  }
  return setupManifest.tags.every((requiredTag) =>
    metadata.tags.filter((tag) => tag.name === requiredTag.name).length === 1,
  );
}

function createProjectMetadataSource(
  project: ProjectMetadataCache["project"],
  sections: readonly ProjectMetadataCache["sections"][number][],
  tags: readonly ProjectMetadataCache["tags"][number][],
): ProjectMetadataSource {
  return {
    project: {
      gid: project.gid,
      ...(project.name == null ? {} : { name: project.name }),
    },
    sections: [...sections]
      .map((section) => ({ gid: section.gid, name: section.name }))
      .sort((left, right) => compareStrings(left.gid, right.gid)),
    tags: [...tags]
      .map((tag) => ({ gid: tag.gid, name: tag.name }))
      .sort((left, right) => compareStrings(left.gid, right.gid)),
  };
}

function createProjectMetadataCache(
  source: ProjectMetadataSource,
  cachedAt: string,
): ProjectMetadataCache {
  return projectMetadataCacheSchema.parse({
    ...source,
    cached_at: cachedAt,
  });
}

function mergeDeltaTasks(
  baseTasks: readonly AsanaTaskResponse[],
  result: MaterializedDelta,
): AsanaTaskResponse[] {
  const tasks = new Map<string, AsanaTaskResponse>();
  for (const task of baseTasks) {
    const parsedTask = asanaTaskResponseSchema.parse(task);
    tasks.set(parsedTask.gid, parsedTask);
  }
  for (const gid of result.missing_gids) {
    tasks.delete(gid);
  }
  for (const task of result.upsert) {
    const parsedTask = asanaTaskResponseSchema.parse(task);
    if (parsedTask.gid !== task.gid) {
      throw new Error("差分同期タスクのGIDを確認できません。");
    }
    tasks.set(parsedTask.gid, parsedTask);
  }
  return sortedTasks([...tasks.values()]);
}

function mergeDeltaSnapshot(
  snapshot: CollectionSnapshot,
  result: MaterializedDelta,
): CollectionSnapshot {
  return {
    ...snapshot,
    raw_tasks: mergeDeltaTasks(snapshot.raw_tasks, result),
    workspace_tags: [...result.workspace_tags],
    metadata: result.metadata,
    events_token: result.sync_token,
    inaccessible_gids: sortedUnique([
      ...snapshot.inaccessible_gids,
      ...result.missing_gids,
    ]),
  };
}

function buildCustomExternalDataCache(
  task: AsanaTaskResponse,
): TaskCacheEntry["custom_external_data"] {
  if (task.external == null) {
    return undefined;
  }
  const ingestion = ingestAsanaExternalData(task);
  switch (ingestion.kind) {
    case "missing":
      throw new Error("外部データの取込結果がAsana応答と一致しません。");
    case "valid":
      return { status: "valid", raw: task.external.data };
    case "broken":
      return { status: "broken", raw: task.external.data };
    case "identity_mismatch":
      return undefined;
    case "unknown_version":
      return {
        status: "unknown_version",
        raw: task.external.data,
        schema: ingestion.schema,
      };
  }
}

function createTaskCacheEntries(
  rawTasks: readonly AsanaTaskResponse[],
  normalization: SnapshotNormalizationResult,
  cachedAt: string,
): readonly TaskCacheEntry[] {
  const normalizedByGid = new Map(
    normalization.tasks.map((task) => [task.gid, task]),
  );
  const entries = sortedTasks(rawTasks).map((rawTask) => {
    const task = normalizedByGid.get(rawTask.gid);
    if (task == null) {
      throw new Error("正規化済みタスクをキャッシュへ対応付けできません。");
    }
    const customExternalData = buildCustomExternalDataCache(rawTask);
    const entry = {
      gid: rawTask.gid,
      asana_response: rawTask,
      task,
      cached_at: cachedAt,
      ...(customExternalData == null
        ? {}
        : { custom_external_data: customExternalData }),
    };
    return entry;
  });
  return taskCacheEntriesSchema.parse(entries);
}

function createRankingCache(
  normalization: SnapshotNormalizationResult,
  appVersion: string,
  asOf: string,
): RankingCache {
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
  return rankingCacheSchema.parse({
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
  });
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

function createNormalizationPlanSummary(
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

function createSyncState(
  projectGid: string,
  eventsToken: string | undefined,
  lastFullSyncedAt: string | undefined,
  syncedAt: string,
): SyncState {
  return syncStateSchema.parse({
    project_gid: projectGid,
    ...(eventsToken == null ? {} : { events_token: eventsToken }),
    last_successful_sync_at: syncedAt,
    ...(lastFullSyncedAt == null
      ? {}
      : { last_full_sync_at: lastFullSyncedAt }),
  });
}

async function refetchAffectedTasks(
  readClient: AsanaReadClient,
  rawTasks: Map<string, AsanaTaskResponse>,
  affectedGids: readonly string[],
  signal: AbortSignal,
): Promise<AsanaTaskResponse[]> {
  for (const taskGid of affectedGids) {
    const fetchedTask = asanaTaskResponseSchema.parse(
      await readClient.getTask(taskGid, signal),
    );
    if (fetchedTask.gid !== taskGid) {
      throw new Error("再取得したAsanaタスクGIDが対象と一致しません。");
    }
    rawTasks.set(taskGid, fetchedTask);
  }
  return sortedTasks([...rawTasks.values()]);
}

function normalizeSnapshot(
  input: AsanaSyncCoordinatorInput,
  rawTasks: readonly AsanaTaskResponse[],
  previousTasks: readonly Task[],
  activityBaselineTasks: readonly Task[],
  inaccessibleGids: readonly string[],
  activityDate: string,
): SnapshotNormalizationResult {
  return normalizeAsanaSnapshot({
    project_gid: input.project_gid,
    section_gids: input.section_gids,
    activity_date: activityDate,
    tasks: sortedTasks(rawTasks),
    previous_tasks: [...previousTasks],
    activity_baseline_tasks: [...activityBaselineTasks],
    inaccessible_gids: [...inaccessibleGids],
  });
}

function createFullCollectionSnapshot(
  sourceResult: AsanaFullSyncResult,
  fallbackReason: FallbackReason | undefined,
  inaccessibleGids: readonly string[],
): CollectionSnapshot {
  return {
    performed_mode: "full",
    raw_tasks: sortedTasks(sourceResult.tasks),
    workspace_tags: [...sourceResult.workspace_tags],
    metadata: createProjectMetadataSource(
      {
        gid: sourceResult.project.gid,
        ...(sourceResult.project.name == null
          ? {}
          : { name: sourceResult.project.name }),
      },
      sourceResult.sections.map((section) => ({
        gid: section.gid,
        name: section.name,
      })),
      sourceResult.workspace_tags.map((tag) => ({
        gid: tag.gid,
        name: tag.name,
      })),
    ),
    inaccessible_gids: sortedUnique(inaccessibleGids),
    ...(fallbackReason == null ? {} : { fallback_reason: fallbackReason }),
  };
}

/** Asana同期の収集と正規化結果の保存を調整します。 */
export class AsanaSyncCoordinator {
  private readonly readClient: AsanaReadClient;
  private readonly fullSyncSource: AsanaFullSyncSource;
  private readonly deltaSyncSource: AsanaDeltaSyncSource;
  private readonly planApplier: AsanaNormalizationPlanApplier;
  private readonly database: StorageDatabase;
  private readonly timestampProvider: SyncTimestampProvider;
  private synchronizationInProgress = false;

  public constructor(
    readClient: AsanaReadClient,
    fullSyncSource: AsanaFullSyncSource,
    deltaSyncSource: AsanaDeltaSyncSource,
    planApplier: AsanaNormalizationPlanApplier,
    database: StorageDatabase,
    timestampProvider: SyncTimestampProvider,
  ) {
    this.readClient = readClient;
    this.fullSyncSource = fullSyncSource;
    this.deltaSyncSource = deltaSyncSource;
    this.planApplier = planApplier;
    this.database = database;
    this.timestampProvider = timestampProvider;
  }

  /** 指定された方式でAsana同期を実行し、実状態をキャッシュします。 */
  public async coordinate(
    input: AsanaSyncCoordinatorInput,
    signal: AbortSignal,
  ): Promise<AsanaSyncCoordinatorResult> {
    const validatedInput = coordinatorInputSchema.parse(input);
    validateAbortSignal(signal);
    if (this.synchronizationInProgress) {
      throw new AsanaSyncInProgressError();
    }
    this.synchronizationInProgress = true;
    try {
      const cachedEntries = this.database.getTaskCache();
      const storedCleanupItems = this.database.getCleanupItems();
      const existingCleanupItems = storedCleanupItems == null
        ? []
        : cleanupItemsSchema.parse(storedCleanupItems);
      const previousTasks = cachedEntries
        .map((entry) => entry.task)
        .sort((left, right) => compareStrings(left.gid, right.gid));
      const existingState = this.database.getSyncState(
        validatedInput.project_gid,
      );
      const existingMetadata = this.database.getProjectMetadataCache(
        validatedInput.project_gid,
      );
      const collection = await this.collectSnapshot(
        validatedInput,
        cachedEntries,
        existingState,
        existingMetadata,
        signal,
      );
      const syncedAt = isoDateTimeSchema.parse(this.timestampProvider());
      const activityDate = jstDateFromTimestamp(syncedAt);
      const metadata = createProjectMetadataCache(
        collection.metadata,
        syncedAt,
      );
      const requiredSectionInspection = inspectRequiredSections(
        validatedInput.section_gids,
        metadata.sections,
      );
      const protectionRequired = shouldProtectExternalDataWrites(
        validatedInput,
        collection,
        existingCleanupItems,
      );
      const firstNormalization = protectExternalDataWrites(
        normalizeSnapshot(
          validatedInput,
          collection.raw_tasks,
          previousTasks,
          previousTasks,
          collection.inaccessible_gids,
          activityDate,
        ),
        protectionRequired,
      );
      const applicationOutcome: NormalizationApplicationOutcome =
        requiredSectionInspection.hasMissingGid
          ? {
            kind: "skipped_missing_section",
            applicationResult: createEmptyApplicationResult(),
            rawTasks: sortedTasks(collection.raw_tasks),
            normalization: firstNormalization,
          }
          : await this.applyNormalizationPlan(
            validatedInput,
            collection,
            firstNormalization,
            previousTasks,
            activityDate,
            signal,
          );
      const finalNormalization = createFinalNormalization(
        applicationOutcome.normalization,
        protectionRequired,
        requiredSectionInspection.cleanupItems,
        createMissingTaskCleanupItems(
          previousTasks,
          applicationOutcome.rawTasks,
          existingCleanupItems,
        ),
      );
      const rankingCache = createRankingCache(
        finalNormalization,
        validatedInput.app_version,
        syncedAt,
      );
      const taskCacheEntries = createTaskCacheEntries(
        applicationOutcome.rawTasks,
        finalNormalization,
        syncedAt,
      );
      const syncState = createSyncState(
        validatedInput.project_gid,
        collection.events_token,
        collection.performed_mode === "full"
          ? syncedAt
          : existingState?.last_full_sync_at,
        syncedAt,
      );
      this.database.saveSyncSnapshot(
        taskCacheEntries,
        metadata,
        rankingCache,
        syncState,
        finalNormalization.cleanup_items,
      );
      const result = {
        requested_mode: validatedInput.mode,
        performed_mode: collection.performed_mode,
        synced_at: syncedAt,
        application_result: applicationOutcome.applicationResult,
        normalization_notifications: createNormalizationNotifications(
          firstNormalization,
          finalNormalization,
          applicationOutcome,
        ),
        remaining_plan: createNormalizationPlanSummary(finalNormalization),
        critical_errors: finalNormalization.critical_errors,
        cleanup_items: finalNormalization.cleanup_items,
        ranking_cache: rankingCache,
        ...(collection.fallback_reason == null
          ? {}
          : { fallback_reason: collection.fallback_reason }),
        ...(collection.events_token == null
          ? {}
          : { events_token: collection.events_token }),
      };
      return coordinatorResultSchema.parse(result);
    } finally {
      this.synchronizationInProgress = false;
    }
  }

  private async applyNormalizationPlan(
    input: AsanaSyncCoordinatorInput,
    collection: CollectionSnapshot,
    normalization: SnapshotNormalizationResult,
    previousTasks: readonly Task[],
    activityDate: string,
    signal: AbortSignal,
  ): Promise<NormalizationApplicationOutcome> {
    const applicationResult = await this.planApplier.apply(
      {
        normalization_result: normalization,
        asana_tasks: [...collection.raw_tasks],
        workspace_tags: [...collection.workspace_tags],
        device_id: input.device_id,
      },
      signal,
    );
    const rawTasks = await refetchAffectedTasks(
      this.readClient,
      new Map(collection.raw_tasks.map((task) => [task.gid, task])),
      applicationResult.affected_gids,
      signal,
    );
    return {
      kind: "applied",
      applicationResult,
      rawTasks,
      normalization: normalizeSnapshot(
        input,
        rawTasks,
        normalization.tasks,
        previousTasks,
        collection.inaccessible_gids,
        activityDate,
      ),
    };
  }

  private async collectSnapshot(
    input: AsanaSyncCoordinatorInput,
    cachedEntries: readonly TaskCacheEntry[],
    existingState: SyncState | undefined,
    existingMetadata: ProjectMetadataCache | undefined,
    signal: AbortSignal,
  ): Promise<CollectionSnapshot> {
    if (input.mode === "full") {
      const establishedToken = existingState?.events_token == null
        ? await this.establishEventsToken(input, signal)
        : {
            sync_token: existingState.events_token,
          };
      return this.collectFullWithCatchUp(
        input,
        establishedToken.sync_token,
        undefined,
        signal,
        [],
      );
    }
    if (existingState?.events_token == null) {
      const establishedToken = await this.establishEventsToken(input, signal);
      return this.collectFullWithCatchUp(
        input,
        establishedToken.sync_token,
        "sync_token_missing",
        signal,
        [],
      );
    }
    if (
      !isMetadataSufficient(
        existingMetadata,
        input.project_gid,
        input.section_gids,
      )
    ) {
      return this.collectFullWithCatchUp(
        input,
        existingState.events_token,
        "metadata_missing",
        signal,
        [],
      );
    }
    const deltaResult = await this.collectDeltaFromToken(
      input,
      existingState.events_token,
      signal,
    );
    if (deltaResult.kind === "full_sync_required") {
      return this.collectFullWithCatchUp(
        input,
        deltaResult.sync_token,
        deltaResult.reason,
        signal,
        [],
      );
    }
    const materializedDelta = await this.materializeDelta(
      input,
      deltaResult,
      signal,
    );
    return {
      performed_mode: "delta",
      raw_tasks: mergeDeltaTasks(
        cachedEntries.map((entry) => entry.asana_response),
        materializedDelta,
      ),
      workspace_tags: [...materializedDelta.workspace_tags],
      metadata: materializedDelta.metadata,
      events_token: materializedDelta.sync_token,
      inaccessible_gids: sortedUnique(materializedDelta.missing_gids),
    };
  }

  private async establishEventsToken(
    input: AsanaSyncCoordinatorInput,
    signal: AbortSignal,
  ): Promise<EstablishedEventsToken> {
    const initialEvents = await this.collectDeltaFromToken(
      input,
      undefined,
      signal,
    );
    return {
      sync_token: initialEvents.sync_token,
    };
  }

  private async collectDeltaFromToken(
    input: AsanaSyncCoordinatorInput,
    eventsToken: string | undefined,
    signal: AbortSignal,
  ): Promise<AsanaDeltaSyncResult> {
    return asanaDeltaSyncResultSchema.parse(
      await this.deltaSyncSource.collect(
        {
          project_gid: input.project_gid,
          ...(eventsToken == null ? {} : { sync_token: eventsToken }),
        },
        signal,
      ),
    );
  }

  private async materializeDelta(
    input: AsanaSyncCoordinatorInput,
    result: Extract<AsanaDeltaSyncResult, { kind: "delta" }>,
    signal: AbortSignal,
  ): Promise<MaterializedDelta> {
    const project = await this.readClient.getProject(
      input.project_gid,
      signal,
    );
    if (project.gid !== input.project_gid) {
      throw new Error("差分同期のAsanaプロジェクトGIDが入力と一致しません。");
    }
    const sections = await this.readClient.listProjectSections(
      input.project_gid,
      signal,
    );
    const workspaceTags = await this.readClient.listWorkspaceTags(
      project.workspace.gid,
      signal,
    );
    const affectedSubtrees = await this.fullSyncSource.collectAffectedSubtrees(
      {
        project_gid: input.project_gid,
        section_gids: input.section_gids,
        available_section_gids: sections
          .map((section) => section.gid)
          .sort(compareStrings),
        affected_task_gids: result.affected_task_gids,
      },
      signal,
    );
    return {
      sync_token: result.sync_token,
      upsert: affectedSubtrees.tasks,
      missing_gids: affectedSubtrees.missing_gids,
      workspace_tags: [...workspaceTags],
      metadata: createProjectMetadataSource(
        { gid: project.gid, name: project.name },
        sections,
        workspaceTags,
      ),
    };
  }

  private async collectFullWithCatchUp(
    input: AsanaSyncCoordinatorInput,
    eventsToken: string,
    fallbackReason: FallbackReason | undefined,
    signal: AbortSignal,
    inaccessibleGids: readonly string[],
  ): Promise<CollectionSnapshot> {
    const full = await this.collectFull(
      input,
      fallbackReason,
      signal,
      inaccessibleGids,
    );
    const catchUp = await this.collectDeltaFromToken(
      input,
      eventsToken,
      signal,
    );
    if (catchUp.kind === "delta") {
      return mergeDeltaSnapshot(
        full,
        await this.materializeDelta(input, catchUp, signal),
      );
    }

    const retryFull = await this.collectFull(
      input,
      catchUp.reason,
      signal,
      full.inaccessible_gids,
    );
    const retryCatchUp = await this.collectDeltaFromToken(
      input,
      catchUp.sync_token,
      signal,
    );
    if (retryCatchUp.kind === "full_sync_required") {
      throw new Error("フル同期後の差分同期を安全に継続できません。");
    }
    return mergeDeltaSnapshot(
      retryFull,
      await this.materializeDelta(input, retryCatchUp, signal),
    );
  }

  private async collectFull(
    input: AsanaSyncCoordinatorInput,
    fallbackReason: FallbackReason | undefined,
    signal: AbortSignal,
    inaccessibleGids: readonly string[],
  ): Promise<CollectionSnapshot> {
    const sourceResult = asanaFullSyncResultSchema.parse(
      await this.fullSyncSource.collect(
        {
          project_gid: input.project_gid,
          section_gids: input.section_gids,
        },
        signal,
      ),
    );
    if (sourceResult.project.gid !== input.project_gid) {
      throw new Error("フル同期結果のプロジェクトGIDが入力と一致しません。");
    }
    return createFullCollectionSnapshot(
      sourceResult,
      fallbackReason,
      inaccessibleGids,
    );
  }
}
