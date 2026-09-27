type CachedTask = {
  readonly gid: string;
  readonly child_gids: readonly string[];
  readonly parent_gid?: string | null | undefined;
};

type CachedEntry<TTask extends CachedTask> = {
  readonly gid: string;
  readonly task: TTask;
  readonly asana_response: {
    readonly projects: readonly { readonly gid: string }[];
    readonly memberships: readonly { readonly project: { readonly gid: string } }[];
  };
};

type SnapshotStorage<TEntry, TMetadata, TRanking, TSync, TCleanup> = {
  readonly getTaskCache: () => readonly TEntry[];
  readonly getProjectMetadataCache: (projectGid: string) => TMetadata | undefined;
  readonly getSyncState: (projectGid: string) => TSync | undefined;
  readonly getCleanupItems: () => TCleanup | undefined;
  readonly getRankingCache: () => TRanking | undefined;
};

type SnapshotParsers<
  TEntry extends CachedEntry<CachedTask>,
  TMetadata extends { readonly project: { readonly gid: string } },
  TRanking,
  TSync extends {
    readonly project_gid: string;
    readonly last_successful_sync_at?: string | null | undefined;
  },
  TCleanup,
> = {
  readonly projectGid: (value: string) => string;
  readonly entries: (value: unknown) => readonly TEntry[];
  readonly metadata: (value: unknown) => TMetadata;
  readonly ranking: (value: unknown) => TRanking;
  readonly syncState: (value: unknown) => TSync;
  readonly cleanupItems: (value: unknown) => TCleanup;
  readonly compareStrings: (left: string, right: string) => number;
};

/** GIDを検証しながらタスクの索引を作ります。 */
export function createTaskMap<TTask extends CachedTask>(
  tasks: readonly TTask[],
): ReadonlyMap<string, TTask> {
  const taskByGid = new Map<string, TTask>();
  tasks.forEach((task) => {
    if (taskByGid.has(task.gid)) {
      throw new Error("タスクキャッシュに同じGIDが重複しています。");
    }
    taskByGid.set(task.gid, task);
  });
  return taskByGid;
}

function createEntryMap<TEntry extends { readonly gid: string }>(
  entries: readonly TEntry[],
): ReadonlyMap<string, TEntry> {
  const entryByGid = new Map<string, TEntry>();
  entries.forEach((entry) => {
    if (entryByGid.has(entry.gid)) {
      throw new Error("タスクキャッシュに同じGIDが重複しています。");
    }
    entryByGid.set(entry.gid, entry);
  });
  return entryByGid;
}

function isProjectMember<TEntry extends CachedEntry<CachedTask>>(
  entry: TEntry,
  projectGid: string,
): boolean {
  const response = entry.asana_response;
  return (
    response.projects.some((project) => project.gid === projectGid) ||
    response.memberships.some((membership) => membership.project.gid === projectGid)
  );
}

function selectProjectEntries<TEntry extends CachedEntry<CachedTask>>(
  entries: readonly TEntry[],
  projectGid: string,
  compareStrings: (left: string, right: string) => number,
): readonly TEntry[] {
  const entryByGid = new Map<string, TEntry>();
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

/** 保存済みキャッシュを検証して対象プロジェクトの読取スナップショットを選びます。 */
export function loadSelectedSnapshot<
  TEntry extends CachedEntry<CachedTask>,
  TMetadata extends { readonly project: { readonly gid: string } },
  TRanking,
  TSync extends {
    readonly project_gid: string;
    readonly last_successful_sync_at?: string | null | undefined;
  },
  TCleanup,
>(
  storage: SnapshotStorage<TEntry, TMetadata, TRanking, TSync, TCleanup>,
  projectGid: string,
  parsers: SnapshotParsers<TEntry, TMetadata, TRanking, TSync, TCleanup>,
): {
  readonly projectGid: string;
  readonly entries: readonly TEntry[];
  readonly tasks: readonly TEntry["task"][];
  readonly taskByGid: ReadonlyMap<string, TEntry["task"]>;
  readonly entryByGid: ReadonlyMap<string, TEntry>;
  readonly metadata: TMetadata;
  readonly ranking: TRanking | undefined;
  readonly syncState: TSync;
  readonly cleanupItems: TCleanup;
} {
  const validatedProjectGid = parsers.projectGid(projectGid);
  const entries = parsers.entries(storage.getTaskCache());
  const metadataValue = storage.getProjectMetadataCache(validatedProjectGid);
  if (metadataValue == null) {
    throw new Error("対象プロジェクトのメタデータキャッシュがありません。");
  }
  const metadata = parsers.metadata(metadataValue);
  if (metadata.project.gid !== validatedProjectGid) {
    throw new Error("プロジェクトメタデータのGIDが一致しません。");
  }

  const syncStateValue = storage.getSyncState(validatedProjectGid);
  if (syncStateValue == null) {
    throw new Error("対象プロジェクトの同期状態がありません。");
  }
  const syncState = parsers.syncState(syncStateValue);
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
  const cleanupItems = parsers.cleanupItems(cleanupItemsValue);

  const rankingValue = storage.getRankingCache();
  const ranking = rankingValue == null ? undefined : parsers.ranking(rankingValue);
  const selectedEntries = selectProjectEntries(entries, validatedProjectGid, parsers.compareStrings);
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
