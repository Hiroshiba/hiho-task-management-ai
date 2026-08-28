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

const synchronizationModeSchema = z.enum(["full", "delta"]);
const oauthMismatchManagedTaskThreshold = 10;
const fallbackReasonSchema = z.enum([
  "sync_token_missing",
  "metadata_missing",
  "events_reset",
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
    events_token: identifierSchema.optional(),
    application_result: asanaNormalizationPlanApplierResultSchema,
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

type SynchronizationMode = z.infer<typeof synchronizationModeSchema>;
type FallbackReason = z.infer<typeof fallbackReasonSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
type CriticalError = z.infer<typeof criticalErrorCodeSchema>;
type ProjectMetadataSource = Omit<ProjectMetadataCache, "cached_at">;
type EstablishedEventsToken = {
  readonly sync_token: string;
  readonly missing_gids: readonly string[];
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

function hasGlobalOAuthAppMismatch(
  cleanupItems: readonly CleanupItem[],
): boolean {
  return cleanupItems.some(
    (item) => item.kind === "oauth_app_mismatch" && item.task_gid == null,
  );
}

function isOAuthAppMismatchSuspected(
  input: AsanaSyncCoordinatorInput,
  collection: CollectionSnapshot,
): boolean {
  if (collection.performed_mode !== "full") {
    return false;
  }
  const sectionGids = new Set(
    collection.metadata.sections.map((section) => section.gid),
  );
  const allConfiguredSectionsExist = Object.values(input.section_gids).every(
    (sectionGid) => sectionGids.has(sectionGid),
  );
  const workspaceTagNames = new Set(
    collection.workspace_tags.map((tag) => tag.name),
  );
  const allConfiguredTagsExist = setupManifest.tags.every((tag) =>
    workspaceTagNames.has(tag.name),
  );
  return (
    allConfiguredSectionsExist
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
      ...missingTaskCleanupItems,
    ]),
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
  result: Extract<AsanaDeltaSyncResult, { kind: "delta" }>,
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
  result: Extract<AsanaDeltaSyncResult, { kind: "delta" }>,
): CollectionSnapshot {
  return {
    ...snapshot,
    raw_tasks: mergeDeltaTasks(snapshot.raw_tasks, result),
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
      const applicationResult = await this.planApplier.apply(
        {
          normalization_result: firstNormalization,
          asana_tasks: [...collection.raw_tasks],
          workspace_tags: [...collection.workspace_tags],
          device_id: validatedInput.device_id,
        },
        signal,
      );
      const refreshedRawTasks = await refetchAffectedTasks(
        this.readClient,
        new Map(collection.raw_tasks.map((task) => [task.gid, task])),
        applicationResult.affected_gids,
        signal,
      );
      const secondNormalization = normalizeSnapshot(
        validatedInput,
        refreshedRawTasks,
        firstNormalization.tasks,
        previousTasks,
        collection.inaccessible_gids,
        activityDate,
      );
      const finalNormalization = createFinalNormalization(
        secondNormalization,
        protectionRequired,
        createMissingTaskCleanupItems(
          previousTasks,
          refreshedRawTasks,
          existingCleanupItems,
        ),
      );
      const metadata = createProjectMetadataCache(
        collection.metadata,
        syncedAt,
      );
      const rankingCache = createRankingCache(
        finalNormalization,
        validatedInput.app_version,
        syncedAt,
      );
      const taskCacheEntries = createTaskCacheEntries(
        refreshedRawTasks,
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
        application_result: applicationResult,
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
            missing_gids: [],
          };
      return this.collectFullWithCatchUp(
        input,
        establishedToken.sync_token,
        undefined,
        signal,
        establishedToken.missing_gids,
      );
    }
    if (existingState?.events_token == null) {
      const establishedToken = await this.establishEventsToken(input, signal);
      return this.collectFullWithCatchUp(
        input,
        establishedToken.sync_token,
        "sync_token_missing",
        signal,
        establishedToken.missing_gids,
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
        "events_reset",
        signal,
        [],
      );
    }
    return {
      performed_mode: "delta",
      raw_tasks: mergeDeltaTasks(
        cachedEntries.map((entry) => entry.asana_response),
        deltaResult,
      ),
      workspace_tags: [...existingMetadata.tags],
      metadata: createProjectMetadataSource(
        existingMetadata.project,
        existingMetadata.sections,
        existingMetadata.tags,
      ),
      events_token: deltaResult.sync_token,
      inaccessible_gids: sortedUnique(deltaResult.missing_gids),
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
      missing_gids:
        initialEvents.kind === "delta" ? initialEvents.missing_gids : [],
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
      return mergeDeltaSnapshot(full, catchUp);
    }

    const retryFull = await this.collectFull(
      input,
      fallbackReason ?? "events_reset",
      signal,
      full.inaccessible_gids,
    );
    const retryCatchUp = await this.collectDeltaFromToken(
      input,
      catchUp.sync_token,
      signal,
    );
    if (retryCatchUp.kind === "full_sync_required") {
      throw new Error("フル同期後の差分同期が再びリセットされました。");
    }
    return mergeDeltaSnapshot(retryFull, retryCatchUp);
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
          not_started_section_gid: input.section_gids.not_started,
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
