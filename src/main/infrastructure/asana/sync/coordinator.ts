import { z } from "zod";
import {
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  cleanupItemsSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  type AsanaTaskResponse,
  type CleanupItem,
  type Task,
} from "../../../domain";
import {
  asanaSnapshotNormalizationResultSchema,
  ingestAsanaExternalData,
  type SnapshotNormalizationResult,
} from "../../../domain";
import { setupSectionGidsSchema } from "../../../domain/setup-state";
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
import type {
  CleanupItemsRecord as CleanupItemsCache,
  ProjectMetadataRecord as ProjectMetadataCache,
  TaskCacheRecord as TaskCacheEntry,
  TaskReadSyncState,
  TaskReadRanking,
  TaskNormalizationBaseline,
  TaskSyncRepository,
} from "../../../application/common/ports/task-read-repository";
import { asanaSyncTokenSchema } from "../sync-token";
import {
  compareStrings,
  createEmptyApplicationResult,
  createNormalizationNotifications,
  createNormalizationPlanSummary,
  createRankingCacheData,
  jstDateFromTimestamp,
  normalizationNotificationsSchema,
  normalizationPlanSummarySchema,
  protectExternalDataWrites,
  sortedGidArraySchema,
  sortedTasks,
  sortedUnique,
  type NormalizationApplicationOutcome,
} from "../sync-normalization";
import { validateAbortSignal } from "../synchronization-run";
import {
  createProjectMetadataCache,
  createProjectMetadataSource,
  createSyncState,
  createTaskCacheEntries,
  mergeDeltaTasks,
  normalizeSnapshot,
} from "../sync-snapshot";

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

const coordinatorInputSchema = z
  .object({
    mode: synchronizationModeSchema,
    project_gid: gidSchema,
    section_gids: setupSectionGidsSchema,
    device_id: identifierSchema,
    app_version: identifierSchema,
    required_task_gids: sortedGidArraySchema,
  })
  .strict();

/** 順位キャッシュの保存形式を注入してAsana同期結果を検証します。 */
function createAsanaSyncCoordinatorResultSchema(rankingCacheSchema: z.ZodType<TaskReadRanking>) {
  return z.object({
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
  }).strict();
}

export type AsanaSyncCoordinatorInput = z.infer<typeof coordinatorInputSchema>;
export type AsanaSyncCoordinatorResult = z.infer<
  ReturnType<typeof createAsanaSyncCoordinatorResultSchema>
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

/** Asana同期で利用者へ伝える正規化通知を検証するスキーマです。 */
export const asanaSyncNormalizationNotificationsSchema =
  normalizationNotificationsSchema;

type SynchronizationMode = z.infer<typeof synchronizationModeSchema>;
type FallbackReason = z.infer<typeof fallbackReasonSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
type ProjectMetadataSource = Omit<ProjectMetadataCache, "cached_at">;
type SyncState = TaskReadSyncState;
type CacheParsers = {
  readonly parseEntries: (value: unknown) => readonly TaskCacheEntry[];
  readonly parseMetadata: (value: unknown) => ProjectMetadataCache;
  readonly parseSyncState: (value: unknown) => SyncState;
};
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
type CollectionSnapshot = {
  readonly performed_mode: SynchronizationMode;
  readonly raw_tasks: readonly AsanaTaskResponse[];
  readonly workspace_tags: readonly AsanaTagResponse[];
  readonly metadata: ProjectMetadataSource;
  readonly events_token?: string;
  readonly inaccessible_gids: readonly string[];
  readonly fallback_reason?: FallbackReason;
};

function previousTasksForNormalization(
  cachedEntries: readonly TaskCacheEntry[],
  baseline: TaskNormalizationBaseline,
): { readonly external: readonly Task[]; readonly status: readonly Task[] } {
  if (baseline.kind === "none") {
    const tasks = cachedEntries
      .map((entry) => entry.task)
      .sort((left, right) => compareStrings(left.gid, right.gid));
    return { external: tasks, status: tasks };
  }
  const baselineGids = new Set(baseline.entries.map((entry) => entry.gid));
  if (cachedEntries.some((entry) => !baselineGids.has(entry.gid))) {
    throw new Error("未適用の正規化基準に保存済みタスクのGIDがありません。");
  }
  return {
    external: baseline.entries
      .flatMap((entry) => entry.previous.kind === "absent" ? [] : [entry.previous.task])
      .sort((left, right) => compareStrings(left.gid, right.gid)),
    status: baseline.entries
      .flatMap((entry) => entry.previous.kind === "present" ? [entry.previous.task] : [])
      .sort((left, right) => compareStrings(left.gid, right.gid)),
  };
}

function createPendingNormalizationBaseline(
  cachedEntries: readonly TaskCacheEntry[],
  projectedEntries: readonly TaskCacheEntry[],
  baseline: TaskNormalizationBaseline,
): TaskNormalizationBaseline {
  const entries = new Map(
    (baseline.kind === "pending"
      ? baseline.entries
      : cachedEntries.map((entry) => ({
        gid: entry.gid,
        previous: { kind: "present" as const, task: entry.task },
      }))).map((entry) => [entry.gid, entry]),
  );
  for (const entry of projectedEntries) {
    if (!entries.has(entry.gid)) {
      entries.set(entry.gid, { gid: entry.gid, previous: { kind: "absent" } });
    }
  }
  return {
    kind: "pending",
    entries: [...entries.values()].sort((left, right) => compareStrings(left.gid, right.gid)),
  };
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
  private readonly repository: TaskSyncRepository<
    TaskCacheEntry,
    ProjectMetadataCache,
    TaskReadRanking,
    SyncState,
    CleanupItemsCache
  >;
  private readonly timestampProvider: SyncTimestampProvider;
  private readonly cacheParsers: CacheParsers;
  public readonly resultSchema: ReturnType<typeof createAsanaSyncCoordinatorResultSchema>;
  private synchronizationInProgress = false;

  public constructor(
    readClient: AsanaReadClient,
    fullSyncSource: AsanaFullSyncSource,
    deltaSyncSource: AsanaDeltaSyncSource,
    planApplier: AsanaNormalizationPlanApplier,
    repository: TaskSyncRepository<
      TaskCacheEntry,
      ProjectMetadataCache,
      TaskReadRanking,
      SyncState,
      CleanupItemsCache
    >,
    timestampProvider: SyncTimestampProvider,
    cacheParsers: CacheParsers,
    rankingCacheSchema: z.ZodType<TaskReadRanking>,
  ) {
    this.readClient = readClient;
    this.fullSyncSource = fullSyncSource;
    this.deltaSyncSource = deltaSyncSource;
    this.planApplier = planApplier;
    this.repository = repository;
    this.timestampProvider = timestampProvider;
    this.cacheParsers = cacheParsers;
    this.resultSchema = createAsanaSyncCoordinatorResultSchema(rankingCacheSchema);
  }

  /** 指定された方式でAsana同期を実行し、実状態をキャッシュします。 */
  public async coordinate(
    input: AsanaSyncCoordinatorInput,
    signal: AbortSignal,
  ): Promise<AsanaSyncCoordinatorResult> {
    return this.coordinateWithWriteMode(input, signal, false);
  }

  /** Asanaへ書き込まずに実状態を収集してローカルの同期状態を更新します。 */
  public async coordinateReadOnly(
    input: AsanaSyncCoordinatorInput,
    signal: AbortSignal,
  ): Promise<AsanaSyncCoordinatorResult> {
    return this.coordinateWithWriteMode(input, signal, true);
  }

  private async coordinateWithWriteMode(
    input: AsanaSyncCoordinatorInput,
    signal: AbortSignal,
    readOnly: boolean,
  ): Promise<AsanaSyncCoordinatorResult> {
    const validatedInput = coordinatorInputSchema.parse(input);
    validateAbortSignal(signal);
    if (this.synchronizationInProgress) {
      throw new AsanaSyncInProgressError();
    }
    this.synchronizationInProgress = true;
    try {
      const cachedEntries = this.repository.getTaskCache();
      const storedCleanupItems = this.repository.getCleanupItems();
      const existingCleanupItems = storedCleanupItems == null
        ? []
        : cleanupItemsSchema.parse(storedCleanupItems);
      const normalizationBaseline = this.repository.getNormalizationBaseline(
        validatedInput.project_gid,
      );
      const previousTasks = previousTasksForNormalization(cachedEntries, normalizationBaseline);
      const existingState = this.repository.getSyncState(
        validatedInput.project_gid,
      );
      const existingMetadata = this.repository.getProjectMetadataCache(
        validatedInput.project_gid,
      );
      const collection = await this.collectSnapshot(
        validatedInput,
        cachedEntries,
        existingState,
        existingMetadata,
        signal,
        readOnly,
      );
      const syncedAt = isoDateTimeSchema.parse(this.timestampProvider());
      const activityDate = jstDateFromTimestamp(syncedAt);
      const metadata = createProjectMetadataCache(
        collection.metadata,
        syncedAt,
        this.cacheParsers.parseMetadata,
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
          validatedInput.project_gid,
          validatedInput.section_gids,
          collection.raw_tasks,
          previousTasks.external,
          previousTasks.status,
          previousTasks.external,
          collection.inaccessible_gids,
          activityDate,
        ),
        protectionRequired,
      );
      const applicationOutcome: NormalizationApplicationOutcome =
        readOnly
          ? {
            kind: "read_only",
            applicationResult: createEmptyApplicationResult(),
            rawTasks: sortedTasks(collection.raw_tasks),
            normalization: firstNormalization,
          }
          : requiredSectionInspection.hasMissingGid
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
            previousTasks.external,
            activityDate,
            signal,
          );
      const finalNormalization = createFinalNormalization(
        applicationOutcome.normalization,
        protectionRequired,
        requiredSectionInspection.cleanupItems,
        createMissingTaskCleanupItems(
          previousTasks.external,
          applicationOutcome.rawTasks,
          existingCleanupItems,
        ),
      );
      const rankingCache = this.resultSchema.shape.ranking_cache.parse(
        createRankingCacheData(
          finalNormalization,
          validatedInput.app_version,
          syncedAt,
        ),
      );
      const taskCacheEntries = createTaskCacheEntries(
        applicationOutcome.rawTasks,
        finalNormalization,
        syncedAt,
        this.cacheParsers.parseEntries,
      );
      const remainingPlan = createNormalizationPlanSummary(finalNormalization);
      const normalizationApplied = applicationOutcome.kind === "applied"
        && applicationOutcome.applicationResult.operations.every(
          (operation) => operation.outcome !== "conflict",
        )
        && finalNormalization.status_plans.every((plan) => plan.kind === "reconciled")
        && remainingPlan.status_write_task_gids.length === 0
        && remainingPlan.external_write_task_gids.length === 0
        && remainingPlan.tag_write_task_gids.length === 0;
      const syncState = createSyncState(
        validatedInput.project_gid,
        collection.events_token,
        collection.performed_mode === "full"
          ? syncedAt
          : existingState?.last_full_sync_at,
        syncedAt,
        this.cacheParsers.parseSyncState,
      );
      this.repository.saveSyncSnapshot(
        taskCacheEntries,
        metadata,
        rankingCache,
        syncState,
        finalNormalization.cleanup_items,
        normalizationApplied
          ? { kind: "none" }
          : createPendingNormalizationBaseline(
            cachedEntries,
            taskCacheEntries,
            normalizationBaseline,
          ),
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
        remaining_plan: remainingPlan,
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
      return this.resultSchema.parse(result);
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
        input.project_gid,
        input.section_gids,
        rawTasks,
        normalization.tasks,
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
    readOnly: boolean,
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
        readOnly,
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
        readOnly,
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
        readOnly,
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
        readOnly,
      );
    }
    const materializedDelta = await this.materializeDelta(
      input,
      deltaResult,
      signal,
      readOnly,
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
    readOnly: boolean,
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
        affected_task_gids: sortedUnique([
          ...result.affected_task_gids,
          ...input.required_task_gids,
        ]),
      },
      signal,
      readOnly,
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
    readOnly: boolean,
  ): Promise<CollectionSnapshot> {
    const full = await this.collectFull(
      input,
      fallbackReason,
      signal,
      inaccessibleGids,
      readOnly,
    );
    const catchUp = await this.collectDeltaFromToken(
      input,
      eventsToken,
      signal,
    );
    if (catchUp.kind === "delta") {
      return mergeDeltaSnapshot(
        full,
        await this.materializeDelta(input, catchUp, signal, readOnly),
      );
    }

    const retryFull = await this.collectFull(
      input,
      catchUp.reason,
      signal,
      full.inaccessible_gids,
      readOnly,
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
      await this.materializeDelta(input, retryCatchUp, signal, readOnly),
    );
  }

  private async collectFull(
    input: AsanaSyncCoordinatorInput,
    fallbackReason: FallbackReason | undefined,
    signal: AbortSignal,
    inaccessibleGids: readonly string[],
    readOnly: boolean,
  ): Promise<CollectionSnapshot> {
    const sourceResult = asanaFullSyncResultSchema.parse(
      await this.fullSyncSource.collect(
        {
          project_gid: input.project_gid,
          section_gids: input.section_gids,
        },
        signal,
        readOnly,
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
