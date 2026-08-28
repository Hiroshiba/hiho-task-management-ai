import {
  cleanupItemsSchema,
  gidSchema,
  type CleanupItem,
  type Dependency,
  type Task,
  type TaskStatus,
} from "../../shared/domain";
import {
  projectMetadataCacheSchema,
  rankingCacheSchema,
  syncStateSchema,
  taskCacheEntriesSchema,
  type CleanupItemsCache,
  type ProjectMetadataCache,
  type RankingCache,
  type SyncState,
  type TaskCacheEntry,
} from "../../shared/storage";
import {
  viewModelCleanupItemSchema,
  viewModelOverviewSchema,
  viewModelTaskDetailSchema,
  type ViewModelBlockReason,
  type ViewModelCleanupItem,
  type ViewModelDependencyReference,
  type ViewModelOverview,
  type ViewModelTaskDetail,
  type ViewModelTaskRanking,
  type ViewModelTaskReference,
  type ViewModelTaskRow,
  type ViewModelUnavailableReasonCode,
} from "../../shared/view-model";
import {
  normalizeTaskGraph,
  type BlockStateResult,
} from "../domain";
import type { StorageDatabase } from "../storage";

const projectAreaPrefix = "TaskHub/領域/";
const dayMilliseconds = 24 * 60 * 60 * 1_000;
const jstOffsetMilliseconds = 9 * 60 * 60 * 1_000;
const statusOrder: Readonly<Record<TaskStatus, number>> = {
  not_started: 0,
  in_progress: 1,
  completed: 2,
  withdrawn: 3,
};

type ReadModelStorage = Pick<
  StorageDatabase,
  | "getTaskCache"
  | "getProjectMetadataCache"
  | "getRankingCache"
  | "getSyncState"
  | "getCleanupItems"
>;

type SelectedSnapshot = {
  readonly projectGid: string;
  readonly entries: readonly TaskCacheEntry[];
  readonly tasks: readonly Task[];
  readonly taskByGid: ReadonlyMap<string, Task>;
  readonly entryByGid: ReadonlyMap<string, TaskCacheEntry>;
  readonly metadata: ProjectMetadataCache;
  readonly ranking: RankingCache | undefined;
  readonly syncState: SyncState;
  readonly cleanupItems: CleanupItemsCache;
};

type RankingProjection =
  | {
      readonly kind: "unavailable";
      readonly rankedByGid: ReadonlyMap<
        string,
        RankingCache["ranked_tasks"][number]
      >;
      readonly excludedByGid: ReadonlyMap<
        string,
        RankingCache["excluded_tasks"][number]
      >;
    }
  | {
      readonly kind: "available";
      readonly calculatedAt: string;
      readonly rankedByGid: ReadonlyMap<
        string,
        RankingCache["ranked_tasks"][number]
      >;
      readonly excludedByGid: ReadonlyMap<
        string,
        RankingCache["excluded_tasks"][number]
      >;
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

function taskStatusOrderValue(status: TaskStatus): number {
  const value = statusOrder[status];
  if (value == null) {
    throw new Error("タスク状態の並び順を解決できません。");
  }
  return value;
}

function validateProjectGid(projectGid: string): string {
  return gidSchema.parse(projectGid);
}

function createTaskMap(tasks: readonly Task[]): ReadonlyMap<string, Task> {
  const taskByGid = new Map<string, Task>();
  tasks.forEach((task) => {
    if (taskByGid.has(task.gid)) {
      throw new Error("タスクキャッシュに同じGIDが重複しています。");
    }
    taskByGid.set(task.gid, task);
  });
  return taskByGid;
}

function createEntryMap(
  entries: readonly TaskCacheEntry[],
): ReadonlyMap<string, TaskCacheEntry> {
  const entryByGid = new Map<string, TaskCacheEntry>();
  entries.forEach((entry) => {
    if (entryByGid.has(entry.gid)) {
      throw new Error("タスクキャッシュに同じGIDが重複しています。");
    }
    entryByGid.set(entry.gid, entry);
  });
  return entryByGid;
}

function isProjectMember(entry: TaskCacheEntry, projectGid: string): boolean {
  const response = entry.asana_response;
  return (
    response.projects.some((project) => project.gid === projectGid) ||
    response.memberships.some((membership) => membership.project.gid === projectGid)
  );
}

function selectProjectEntries(
  entries: readonly TaskCacheEntry[],
  projectGid: string,
): readonly TaskCacheEntry[] {
  const entryByGid = new Map<string, TaskCacheEntry>();
  entries.forEach((entry) => {
    if (entryByGid.has(entry.gid)) {
      throw new Error("タスクキャッシュに同じGIDが重複しています。");
    }
    entryByGid.set(entry.gid, entry);
  });

  const roots = entries.filter((entry) => isProjectMember(entry, projectGid));
  if (entries.length > 0 && roots.length === 0) {
    throw new Error("タスクキャッシュに対象プロジェクトの所属がありません。");
  }

  const selectedGids = new Set<string>();
  const pendingGids = roots.map((entry) => entry.gid).sort(compareStrings);
  while (pendingGids.length > 0) {
    const gid = pendingGids.shift();
    if (gid == null) {
      throw new Error("タスクキャッシュの走査対象を取得できません。");
    }
    if (selectedGids.has(gid)) {
      continue;
    }
    const entry = entryByGid.get(gid);
    if (entry == null) {
      throw new Error("タスクキャッシュの親子参照が壊れています。");
    }
    selectedGids.add(gid);
    const childGids = [
      ...entry.task.child_gids,
      ...entries
        .filter((candidate) => candidate.task.parent_gid === gid)
        .map((candidate) => candidate.gid),
    ];
    childGids
      .filter((childGid) => entryByGid.has(childGid))
      .sort(compareStrings)
      .forEach((childGid) => {
        if (!selectedGids.has(childGid) && !pendingGids.includes(childGid)) {
          pendingGids.push(childGid);
        }
      });
  }

  if (selectedGids.size !== entries.length) {
    throw new Error("タスクキャッシュに対象外または孤立したタスクがあります。");
  }
  return entries
    .filter((entry) => selectedGids.has(entry.gid))
    .sort((left, right) => compareStrings(left.gid, right.gid));
}

function loadSelectedSnapshot(
  storage: ReadModelStorage,
  projectGid: string,
): SelectedSnapshot {
  const validatedProjectGid = validateProjectGid(projectGid);
  const entries = taskCacheEntriesSchema.parse(storage.getTaskCache());
  const metadataValue = storage.getProjectMetadataCache(validatedProjectGid);
  if (metadataValue == null) {
    throw new Error("対象プロジェクトのメタデータキャッシュがありません。");
  }
  const metadata = projectMetadataCacheSchema.parse(metadataValue);
  if (metadata.project.gid !== validatedProjectGid) {
    throw new Error("プロジェクトメタデータのGIDが一致しません。");
  }

  const syncStateValue = storage.getSyncState(validatedProjectGid);
  if (syncStateValue == null) {
    throw new Error("対象プロジェクトの同期状態がありません。");
  }
  const syncState = syncStateSchema.parse(syncStateValue);
  if (syncState.project_gid !== validatedProjectGid) {
    throw new Error("同期状態のGIDが一致しません。");
  }
  if (syncState.last_successful_sync_at == null) {
    throw new Error("最終成功同期時刻がありません。");
  }

  const cleanupItemsValue = storage.getCleanupItems();
  if (cleanupItemsValue == null) {
    throw new Error("要整理項目キャッシュがありません。");
  }
  const cleanupItems = cleanupItemsSchema.parse(cleanupItemsValue);

  const rankingValue = storage.getRankingCache();
  const ranking = rankingValue == null ? undefined : rankingCacheSchema.parse(rankingValue);
  const selectedEntries = selectProjectEntries(entries, validatedProjectGid);
  const tasks = selectedEntries.map((entry) => entry.task);
  const taskByGid = createTaskMap(tasks);
  const entryByGid = createEntryMap(selectedEntries);
  return {
    projectGid: validatedProjectGid,
    entries: selectedEntries,
    tasks,
    taskByGid,
    entryByGid,
    metadata,
    ranking,
    syncState,
    cleanupItems,
  };
}

function createAreas(metadata: ProjectMetadataCache): readonly string[] {
  const areas = new Set<string>(["未分類"]);
  metadata.tags.forEach((tag) => {
    if (!tag.name.startsWith(projectAreaPrefix)) {
      return;
    }
    const area = tag.name.slice(projectAreaPrefix.length);
    if (area.trim().length === 0) {
      throw new Error("領域タグの名前が空です。");
    }
    areas.add(area);
  });
  return [...areas].sort(compareStrings);
}

function createCleanupView(item: CleanupItem): ViewModelCleanupItem {
  const relatedTaskGids = item.related_task_gids == null
    ? {}
    : { related_task_gids: [...item.related_task_gids].sort(compareStrings) };
  if (item.task_gid == null) {
    return viewModelCleanupItemSchema.parse({
      kind: item.kind,
      message: item.message,
      scope: { scope: "global", ...relatedTaskGids },
    });
  }
  return viewModelCleanupItemSchema.parse({
    kind: item.kind,
    message: item.message,
    scope: { scope: "task", task_gid: item.task_gid, ...relatedTaskGids },
  });
}

function cleanupViewSortKey(item: ViewModelCleanupItem): readonly string[] {
  const taskGid = item.scope.scope === "task" ? item.scope.task_gid : "";
  const related = item.scope.related_task_gids == null
    ? []
    : item.scope.related_task_gids;
  return [item.kind, taskGid, item.message, ...related];
}

function compareCleanupViews(
  left: ViewModelCleanupItem,
  right: ViewModelCleanupItem,
): number {
  const leftKey = cleanupViewSortKey(left);
  const rightKey = cleanupViewSortKey(right);
  const commonLength = Math.min(leftKey.length, rightKey.length);
  for (let index = 0; index < commonLength; index += 1) {
    const leftPart = leftKey[index];
    const rightPart = rightKey[index];
    if (leftPart == null || rightPart == null) {
      throw new Error("要整理項目の並び替えキーが壊れています。");
    }
    const comparison = compareStrings(leftPart, rightPart);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return leftKey.length - rightKey.length;
}

function createCleanupViews(items: readonly CleanupItem[]): readonly ViewModelCleanupItem[] {
  return items.map(createCleanupView).sort(compareCleanupViews);
}

function createTaskCleanupViews(
  taskGid: string,
  cleanupItems: readonly ViewModelCleanupItem[],
): readonly ViewModelCleanupItem[] {
  return cleanupItems.filter((item) => {
    if (item.scope.scope === "task" && item.scope.task_gid === taskGid) {
      return true;
    }
    return item.scope.related_task_gids?.includes(taskGid) === true;
  });
}

function createRankingProjection(
  tasks: readonly Task[],
  ranking: RankingCache | undefined,
): RankingProjection {
  if (ranking == null) {
    return {
      kind: "unavailable",
      rankedByGid: new Map(),
      excludedByGid: new Map(),
    };
  }
  const taskGids = new Set(tasks.map((task) => task.gid));
  const rankedByGid = new Map<string, RankingCache["ranked_tasks"][number]>();
  ranking.ranked_tasks.forEach((rankedTask) => {
    if (!taskGids.has(rankedTask.gid) || rankedByGid.has(rankedTask.gid)) {
      throw new Error("順位キャッシュがタスク集合と一致しません。");
    }
    rankedByGid.set(rankedTask.gid, rankedTask);
  });
  const excludedByGid = new Map<string, RankingCache["excluded_tasks"][number]>();
  ranking.excluded_tasks.forEach((excludedTask) => {
    if (
      !taskGids.has(excludedTask.gid) ||
      rankedByGid.has(excludedTask.gid) ||
      excludedByGid.has(excludedTask.gid)
    ) {
      throw new Error("順位キャッシュがタスク集合と一致しません。");
    }
    excludedByGid.set(excludedTask.gid, excludedTask);
  });
  if (rankedByGid.size + excludedByGid.size !== tasks.length) {
    throw new Error("順位キャッシュが全タスクを網羅していません。");
  }
  tasks.forEach((task) => {
    if (!rankedByGid.has(task.gid) && !excludedByGid.has(task.gid)) {
      throw new Error("順位キャッシュにタスクがありません。");
    }
  });
  return {
    kind: "available",
    calculatedAt: ranking.calculated_at,
    rankedByGid,
    excludedByGid,
  };
}

function createDue(task: Task): ViewModelTaskRow["due"] {
  if (task.due_on != null) {
    return { kind: "on", value: task.due_on };
  }
  if (task.due_at != null) {
    return { kind: "at", value: task.due_at };
  }
  return { kind: "none" };
}

function addUnavailableReason(
  reasons: ViewModelUnavailableReasonCode[],
  reason: ViewModelUnavailableReasonCode,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function unavailableReasonForCleanupKind(
  kind: CleanupItem["kind"],
): ViewModelUnavailableReasonCode | undefined {
  if (kind === "custom_external_data_broken") {
    return "custom_external_data_broken";
  }
  if (kind === "oauth_app_mismatch") {
    return "custom_external_data_identity_mismatch";
  }
  if (kind === "unknown_status_section") {
    return "unknown_status_section";
  }
  if (kind === "dependency_cycle") {
    return "dependency_cycle";
  }
  if (kind === "parent_cycle") {
    return "parent_cycle";
  }
  if (kind === "children_only_completion_confirmation") {
    return "completion_confirmation";
  }
  if (kind === "missing_dependency") {
    return "missing_dependency";
  }
  return undefined;
}

function createUnavailableReasons(
  taskGid: string,
  exclusionReasons: readonly { readonly code: string }[],
  cleanupItems: readonly ViewModelCleanupItem[],
): readonly ViewModelUnavailableReasonCode[] {
  const reasons: ViewModelUnavailableReasonCode[] = [];
  cleanupItems
    .filter((item) => {
      if (item.scope.scope === "task" && item.scope.task_gid === taskGid) {
        return true;
      }
      return item.scope.related_task_gids?.includes(taskGid) === true;
    })
    .forEach((item) => {
      const reason = unavailableReasonForCleanupKind(item.kind);
      if (reason != null) {
        addUnavailableReason(reasons, reason);
      }
    });
  exclusionReasons.forEach((reason) => {
    if (reason.code === "dependency_cycle") {
      addUnavailableReason(reasons, "dependency_cycle");
    } else if (reason.code === "parent_cycle") {
      addUnavailableReason(reasons, "parent_cycle");
    } else if (reason.code === "completion_confirmation") {
      addUnavailableReason(reasons, "completion_confirmation");
    } else if (reason.code === "critical_error") {
      addUnavailableReason(reasons, "critical_error");
    }
  });
  if (reasons.length === 0) {
    addUnavailableReason(reasons, "critical_error");
  }
  return reasons;
}

function hasUnavailableCleanup(
  taskGid: string,
  cleanupItems: readonly ViewModelCleanupItem[],
): boolean {
  return cleanupItems.some((item) => {
    const appliesToTask = item.scope.scope === "task"
      ? item.scope.task_gid === taskGid
      : item.scope.related_task_gids?.includes(taskGid) === true;
    if (!appliesToTask) {
      return false;
    }
    return (
      item.kind === "custom_external_data_broken" ||
      item.kind === "oauth_app_mismatch" ||
      item.kind === "unknown_status_section" ||
      item.kind === "dependency_cycle" ||
      item.kind === "parent_cycle"
    );
  });
}

function createBlockStateProjection(
  tasks: readonly Task[],
): ReadonlyMap<string, BlockStateResult> {
  const normalized = normalizeTaskGraph({
    tasks: tasks.map((task) => ({
      gid: task.gid,
      status: task.status,
      dependencies: task.dependencies,
      child_gids: task.child_gids,
      parent_work_mode: task.parent_work_mode,
      ...(task.parent_gid == null ? {} : { parent_gid: task.parent_gid }),
    })),
  });
  const taskByGid = createTaskMap(tasks);
  const blockStateByGid = new Map<string, BlockStateResult>();
  normalized.tasks.forEach((result) => {
    const task = taskByGid.get(result.gid);
    if (task == null) {
      throw new Error("ブロック状態の対象タスクが見つかりません。");
    }
    if (task.block_state !== result.block_state) {
      throw new Error("タスクと構造化ブロック状態が一致しません。");
    }
    if (blockStateByGid.has(result.gid)) {
      throw new Error("構造化ブロック状態に同じGIDが重複しています。");
    }
    blockStateByGid.set(result.gid, result);
  });
  if (blockStateByGid.size !== tasks.length) {
    throw new Error("構造化ブロック状態が全タスクを網羅していません。");
  }
  return blockStateByGid;
}

function createBlockReason(
  task: Task,
  blockState: BlockStateResult,
): ViewModelBlockReason | undefined {
  if (task.gid !== blockState.gid || task.block_state !== blockState.block_state) {
    throw new Error("タスクと構造化ブロック理由が一致しません。");
  }
  if (blockState.dependency_cycle) {
    return { code: "dependency_cycle", summary: "依存関係が循環しています。" };
  }
  if (blockState.parent_cycle) {
    return { code: "parent_cycle", summary: "親子関係が循環しています。" };
  }
  const hasDependencyReason = blockState.dependency_reasons.length > 0;
  const hasParentReason = blockState.parent_reasons.length > 0;
  if (!hasDependencyReason && !hasParentReason) {
    if (task.block_state !== "none") {
      throw new Error("ブロック中のタスクに構造化ブロック理由がありません。");
    }
    if (blockState.completion_confirmation) {
      return {
        code: "completion_confirmation",
        summary: "子タスクの完了確認が必要です。",
      };
    }
    return undefined;
  }
  if (task.block_state === "none") {
    throw new Error("ブロックなしのタスクに未解決のブロック理由があります。");
  }
  if (hasDependencyReason && hasParentReason) {
    if (task.block_state === "full") {
      return {
        code: "full_dependency_and_parent",
        summary: "未完了の依存先と子タスクがあり、完全ブロックされています。",
      };
    }
    return {
      code: "partial_dependency_and_parent",
      summary: "未完了の一部依存と子タスクがあります。親自身の作業は続行できます。",
    };
  }
  if (hasParentReason) {
    if (task.block_state === "full") {
      if (task.parent_work_mode !== "children_only") {
        throw new Error("子タスクによる完全ブロックの親作業モードが不正です。");
      }
      return {
        code: "full_children_only",
        summary: "未完了の子タスクがあるため、子タスクのみの親タスクは完全ブロックされています。",
      };
    }
    return {
      code: "partial_parent",
      summary: "未完了の子タスクがあります。親自身の作業は続行できます。",
    };
  }
  if (task.block_state === "full") {
    return { code: "full_dependency", summary: "未完了の完全依存があります。" };
  }
  return { code: "partial_dependency", summary: "未完了の一部依存があります。" };
}

function createChildProgress(
  task: Task,
  taskByGid: ReadonlyMap<string, Task>,
): { readonly completed_count: number; readonly total_count: number } {
  const completedCount = task.child_gids.reduce((count, childGid) => {
    const child = taskByGid.get(childGid);
    if (child == null || child.status !== "completed") {
      return count;
    }
    return count + 1;
  }, 0);
  return {
    completed_count: completedCount,
    total_count: task.child_gids.length,
  };
}

function createCommonTaskRow(
  task: Task,
  childProgress: { readonly completed_count: number; readonly total_count: number },
  warningCount: number,
  reasonChips: readonly string[],
  blockReason: ViewModelBlockReason | undefined,
): Omit<Extract<ViewModelTaskRow, { kind: "ranked" }>, "kind" | "rank"> {
  return {
    gid: task.gid,
    title: task.title,
    status: task.status,
    importance: task.importance,
    due: createDue(task),
    block_state: task.block_state,
    ...(blockReason == null ? {} : { block_reason: blockReason }),
    area: task.area,
    reason_chips: [...reasonChips],
    child_progress: childProgress,
    has_dependencies: task.dependencies.length > 0,
    has_children: task.child_gids.length > 0,
    warning_count: warningCount,
  };
}

function createTaskRow(
  task: Task,
  projection: RankingProjection,
  blockStateByGid: ReadonlyMap<string, BlockStateResult>,
  cleanupItems: readonly ViewModelCleanupItem[],
  taskByGid: ReadonlyMap<string, Task>,
): ViewModelTaskRow {
  const taskWarnings = createTaskCleanupViews(task.gid, cleanupItems);
  const childProgress = createChildProgress(task, taskByGid);
  const blockState = blockStateByGid.get(task.gid);
  if (blockState == null) {
    throw new Error("タスクの構造化ブロック状態がありません。");
  }
  const ranked = projection.rankedByGid.get(task.gid);
  if (ranked != null) {
    return viewModelOverviewSchema.shape.tasks.element.parse({
      kind: "ranked",
      rank: ranked.rank,
      ...createCommonTaskRow(
        task,
        childProgress,
        taskWarnings.length,
        ranked.reason_chips,
        createBlockReason(task, blockState),
      ),
    });
  }
  const excluded = projection.excludedByGid.get(task.gid);
  if (excluded == null) {
    return viewModelOverviewSchema.shape.tasks.element.parse({
      kind: "unavailable",
      unavailable_reasons: ["ranking_unavailable"],
      ...createCommonTaskRow(
        task,
        childProgress,
        taskWarnings.length,
        [],
        createBlockReason(task, blockState),
      ),
    });
  }
  const unavailableReasons = createUnavailableReasons(
    task.gid,
    excluded.exclusion_reasons,
    cleanupItems,
  );
  if (
    excluded.exclusion_reasons.some((reason) => reason.code === "critical_error") ||
    hasUnavailableCleanup(task.gid, cleanupItems)
  ) {
    return viewModelOverviewSchema.shape.tasks.element.parse({
      kind: "unavailable",
      unavailable_reasons: unavailableReasons,
      ...createCommonTaskRow(
        task,
        childProgress,
        taskWarnings.length,
        excluded.reason_chips,
        createBlockReason(task, blockState),
      ),
    });
  }
  return viewModelOverviewSchema.shape.tasks.element.parse({
    kind: "excluded",
    exclusion_reasons: excluded.exclusion_reasons,
    ...createCommonTaskRow(
      task,
      childProgress,
      taskWarnings.length,
      excluded.reason_chips,
      createBlockReason(task, blockState),
    ),
  });
}

function taskRowKindOrder(row: ViewModelTaskRow): number {
  if (row.kind === "ranked") {
    return 0;
  }
  if (row.kind === "excluded") {
    return 1;
  }
  return 2;
}

function compareTaskRows(left: ViewModelTaskRow, right: ViewModelTaskRow): number {
  const kindComparison = taskRowKindOrder(left) - taskRowKindOrder(right);
  if (kindComparison !== 0) {
    return kindComparison;
  }
  if (left.kind === "ranked" && right.kind === "ranked" && left.rank !== right.rank) {
    return left.rank - right.rank;
  }
  const statusComparison =
    taskStatusOrderValue(left.status) - taskStatusOrderValue(right.status);
  if (statusComparison !== 0) {
    return statusComparison;
  }
  return compareStrings(left.gid, right.gid);
}

function calculateActivityElapsedDays(
  activityAnchorOn: string,
  calculatedAt: string,
): number {
  const activityEpoch = Date.parse(`${activityAnchorOn}T00:00:00.000Z`);
  const calculatedEpoch = Date.parse(calculatedAt);
  if (Number.isNaN(activityEpoch) || Number.isNaN(calculatedEpoch)) {
    throw new Error("順位計算時点または活動基準日を日数へ変換できません。");
  }
  const calculatedJst = new Date(calculatedEpoch + jstOffsetMilliseconds);
  const calculatedDayEpoch = Date.UTC(
    calculatedJst.getUTCFullYear(),
    calculatedJst.getUTCMonth(),
    calculatedJst.getUTCDate(),
  );
  const elapsedDays = Math.round(
    (calculatedDayEpoch - activityEpoch) / dayMilliseconds,
  );
  if (elapsedDays < 0) {
    throw new Error("活動基準日は順位計算日より後にできません。");
  }
  return elapsedDays;
}

function createDetailRanking(
  task: Task,
  projection: RankingProjection,
  cleanupItems: readonly ViewModelCleanupItem[],
): ViewModelTaskRanking {
  if (projection.kind === "unavailable") {
    return viewModelTaskDetailSchema.shape.ranking.parse({
      kind: "unavailable",
      reason_codes: ["ranking_unavailable"],
    });
  }
  const rankingTiming = {
    calculated_at: projection.calculatedAt,
    activity_elapsed_days: calculateActivityElapsedDays(
      task.activity_anchor_on,
      projection.calculatedAt,
    ),
  };
  const ranked = projection.rankedByGid.get(task.gid);
  if (ranked != null) {
    return viewModelTaskDetailSchema.shape.ranking.parse({
      kind: "ranked",
      rank: ranked.rank,
      ...rankingTiming,
      detail_text: ranked.detail.text,
      score_breakdown: ranked.score_breakdown,
      release_target_gids: [...ranked.release_target_gids].sort(compareStrings),
      reason_chips: ranked.reason_chips,
      tie_break: ranked.tie_break,
      exclusion_reasons: ranked.detail.exclusion_reasons,
    });
  }
  const excluded = projection.excludedByGid.get(task.gid);
  if (excluded == null) {
    throw new Error("順位キャッシュに対象タスクがありません。");
  }
  const unavailableReasons = createUnavailableReasons(
    task.gid,
    excluded.exclusion_reasons,
    cleanupItems,
  );
  if (
    excluded.exclusion_reasons.some((reason) => reason.code === "critical_error") ||
    hasUnavailableCleanup(task.gid, cleanupItems)
  ) {
    return viewModelTaskDetailSchema.shape.ranking.parse({
      kind: "unavailable",
      reason_codes: unavailableReasons,
      ...rankingTiming,
      detail_text: excluded.detail.text,
      ...(excluded.score_breakdown == null
        ? {}
        : { score_breakdown: excluded.score_breakdown }),
      release_target_gids: [...excluded.release_target_gids].sort(compareStrings),
      reason_chips: excluded.reason_chips,
      tie_break: excluded.tie_break,
      exclusion_reasons: excluded.exclusion_reasons,
    });
  }
  return viewModelTaskDetailSchema.shape.ranking.parse({
    kind: "excluded",
    ...rankingTiming,
    detail_text: excluded.detail.text,
    ...(excluded.score_breakdown == null
      ? {}
      : { score_breakdown: excluded.score_breakdown }),
    release_target_gids: [...excluded.release_target_gids].sort(compareStrings),
    reason_chips: excluded.reason_chips,
    tie_break: excluded.tie_break,
    exclusion_reasons: excluded.exclusion_reasons,
  });
}

function createTaskReference(
  gid: string,
  taskByGid: ReadonlyMap<string, Task>,
): ViewModelTaskReference {
  const task = taskByGid.get(gid);
  if (task == null) {
    return { kind: "missing", gid };
  }
  return {
    kind: "found",
    gid: task.gid,
    title: task.title,
    status: task.status,
  };
}

function createDependencyReference(
  dependency: Dependency,
  taskByGid: ReadonlyMap<string, Task>,
): ViewModelDependencyReference {
  const task = taskByGid.get(dependency.task_gid);
  if (task == null) {
    return {
      kind: "missing",
      gid: dependency.task_gid,
      scope: dependency.scope,
      source: dependency.source,
    };
  }
  return {
    kind: "found",
    gid: task.gid,
    title: task.title,
    status: task.status,
    scope: dependency.scope,
    source: dependency.source,
  };
}

function compareDependencyReferences(
  left: ViewModelDependencyReference,
  right: ViewModelDependencyReference,
): number {
  const gidComparison = compareStrings(left.gid, right.gid);
  if (gidComparison !== 0) {
    return gidComparison;
  }
  const scopeComparison = compareStrings(left.scope, right.scope);
  if (scopeComparison !== 0) {
    return scopeComparison;
  }
  return compareStrings(left.source, right.source);
}

function compareTaskReferences(
  left: ViewModelTaskReference,
  right: ViewModelTaskReference,
): number {
  return compareStrings(left.gid, right.gid);
}

function createDependents(
  taskGid: string,
  tasks: readonly Task[],
  taskByGid: ReadonlyMap<string, Task>,
): readonly ViewModelDependencyReference[] {
  const dependents: ViewModelDependencyReference[] = [];
  tasks.forEach((task) => {
    task.dependencies
      .filter((dependency) => dependency.task_gid === taskGid)
      .forEach((dependency) => {
        dependents.push(createDependencyReference({
          task_gid: task.gid,
          scope: dependency.scope,
          source: dependency.source,
        }, taskByGid));
      });
  });
  return dependents.sort(compareDependencyReferences);
}

function createTaskDetail(
  snapshot: SelectedSnapshot,
  task: Task,
  projection: RankingProjection,
  blockStateByGid: ReadonlyMap<string, BlockStateResult>,
  cleanupItems: readonly ViewModelCleanupItem[],
): ViewModelTaskDetail {
  const taskWarnings = createTaskCleanupViews(task.gid, cleanupItems);
  const entry = snapshot.entryByGid.get(task.gid);
  if (entry == null) {
    throw new Error("タスクキャッシュのAsanaレスポンスがありません。");
  }
  const dependencies = task.dependencies
    .map((dependency) => createDependencyReference(dependency, snapshot.taskByGid))
    .sort(compareDependencyReferences);
  const children = task.child_gids
    .map((gid) => createTaskReference(gid, snapshot.taskByGid))
    .sort(compareTaskReferences);
  const parent = task.parent_gid == null
    ? {}
    : { parent: createTaskReference(task.parent_gid, snapshot.taskByGid) };
  const blockState = blockStateByGid.get(task.gid);
  if (blockState == null) {
    throw new Error("タスクの構造化ブロック状態がありません。");
  }
  const blockReason = createBlockReason(task, blockState);
  return viewModelTaskDetailSchema.parse({
    project_gid: snapshot.projectGid,
    gid: task.gid,
    title: task.title,
    notes: task.notes,
    status: task.status,
    importance: task.importance,
    due: createDue(task),
    area: task.area,
    block_state: task.block_state,
    ...(blockReason == null
      ? {}
      : { block_reason: blockReason }),
    section_gid: task.section_gid,
    parent_work_mode: task.parent_work_mode,
    activity_anchor_on: task.activity_anchor_on,
    ranking: createDetailRanking(task, projection, cleanupItems),
    dependencies,
    dependents: createDependents(task.gid, snapshot.tasks, snapshot.taskByGid),
    ...parent,
    children,
    child_progress: createChildProgress(task, snapshot.taskByGid),
    has_dependencies: task.dependencies.length > 0,
    has_children: task.child_gids.length > 0,
    obsidian_links: [...task.obsidian_links],
    asana_url: entry.asana_response.permalink_url,
    cleanup_warnings: taskWarnings,
  });
}

/** StorageDatabaseから安全な読み取りDTOを生成します。 */
export class ReadModelService {
  public constructor(private readonly storage: ReadModelStorage) {}

  /** プロジェクト概要を取得します。 */
  public getOverview(projectGid: string): ViewModelOverview {
    const snapshot = loadSelectedSnapshot(this.storage, projectGid);
    const cleanupItems = createCleanupViews(snapshot.cleanupItems);
    const projection = createRankingProjection(snapshot.tasks, snapshot.ranking);
    const blockStateByGid = createBlockStateProjection(snapshot.tasks);
    const tasks = snapshot.tasks
      .map((task) =>
        createTaskRow(
          task,
          projection,
          blockStateByGid,
          cleanupItems,
          snapshot.taskByGid,
        ),
      )
      .sort(compareTaskRows);
    return viewModelOverviewSchema.parse({
      project_gid: snapshot.projectGid,
      last_successful_sync_at: snapshot.syncState.last_successful_sync_at,
      ...(snapshot.syncState.last_full_sync_at == null
        ? {}
        : { last_full_sync_at: snapshot.syncState.last_full_sync_at }),
      ranking: snapshot.ranking == null
        ? { kind: "unavailable" }
        : {
            kind: "available",
            calculated_at: snapshot.ranking.calculated_at,
            app_version: snapshot.ranking.app_version,
          },
      default_filter: "ranked",
      tasks,
      areas: createAreas(snapshot.metadata),
      cleanup_items: cleanupItems,
      cleanup_count: cleanupItems.length,
    });
  }

  /** タスク詳細を取得します。 */
  public getTaskDetail(projectGid: string, taskGid: string): ViewModelTaskDetail {
    const snapshot = loadSelectedSnapshot(this.storage, projectGid);
    const validatedTaskGid = gidSchema.parse(taskGid);
    const task = snapshot.taskByGid.get(validatedTaskGid);
    if (task == null) {
      throw new Error("指定タスクがキャッシュにありません。");
    }
    const cleanupItems = createCleanupViews(snapshot.cleanupItems);
    const projection = createRankingProjection(snapshot.tasks, snapshot.ranking);
    const blockStateByGid = createBlockStateProjection(snapshot.tasks);
    return createTaskDetail(
      snapshot,
      task,
      projection,
      blockStateByGid,
      cleanupItems,
    );
  }
}

export type { ReadModelStorage };
