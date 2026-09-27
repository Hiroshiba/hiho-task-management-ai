import type {
  TaskReadCleanupItem,
  TaskReadEntry,
  TaskReadMetadata,
  TaskReadRanking,
  TaskSyncRepository,
  TaskReadSyncState,
} from "../../application/common/ports/task-read-repository";
import type { PersistenceRuntime } from "./persistence-runtime";

type TaskCacheRow = {
  readonly gid: string;
  readonly asana_response_json: string;
  readonly task_json: string;
  readonly custom_external_data_json: string | null;
  readonly cached_at: string;
};

type ProjectMetadataRow = {
  readonly project_gid: string;
  readonly project_json: string;
  readonly sections_json: string;
  readonly tags_json: string;
  readonly cached_at: string;
};

type RankingRow = {
  readonly app_version: string;
  readonly calculated_at: string;
  readonly ranked_tasks_json: string;
  readonly excluded_tasks_json: string;
};

type SyncStateRow = {
  readonly project_gid: string;
  readonly events_token: string | null;
  readonly last_successful_sync_at: string | null;
  readonly last_full_sync_at: string | null;
};

type CleanupRow = { readonly cache_key: number; readonly cleanup_items_json: string };

type TaskCacheDiff<Entry> = {
  readonly upsert: readonly Entry[];
  readonly missing_gids: readonly string[];
};

/** 保存形式の現行スキーマを旧契約から受け取ります。 */
export type TaskReadPersistenceContracts<
  Entry extends TaskReadEntry,
  Metadata extends TaskReadMetadata,
  Ranking extends TaskReadRanking,
  SyncState extends TaskReadSyncState,
  CleanupItems extends TaskReadCleanupItem[],
  Diff extends TaskCacheDiff<Entry>,
> = {
  readonly parseGid: (value: string) => string;
  readonly parseEntry: (value: unknown) => Entry;
  readonly parseEntries: (value: unknown) => readonly Entry[];
  readonly parseDiff: (value: unknown) => Diff;
  readonly parseMetadata: (value: unknown) => Metadata;
  readonly parseRanking: (value: unknown) => Ranking;
  readonly parseSyncState: (value: unknown) => SyncState;
  readonly parseCleanupItems: (value: unknown) => CleanupItems;
  readonly parseCleanupKinds: (value: unknown) => readonly string[];
  readonly canonicalize: (value: unknown) => string;
};

function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("SQLiteに保存されたJSONの解析に失敗しました。", { cause: error });
  }
}

function serializeStoredJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("SQLite保存用JSONの変換に失敗しました。");
  }
  return serialized;
}

/** タスク読取と同期スナップショットのSQLite保存を管理します。 */
export class TaskReadPersistenceRepository<
  Entry extends TaskReadEntry,
  Metadata extends TaskReadMetadata,
  Ranking extends TaskReadRanking,
  SyncState extends TaskReadSyncState,
  CleanupItems extends TaskReadCleanupItem[],
  Diff extends TaskCacheDiff<Entry>,
> implements TaskSyncRepository<Entry, Metadata, Ranking, SyncState, CleanupItems> {
  public constructor(
    private readonly runtime: PersistenceRuntime,
    private readonly contracts: TaskReadPersistenceContracts<
      Entry,
      Metadata,
      Ranking,
      SyncState,
      CleanupItems,
      Diff
    >,
  ) {}

  private parseTaskCacheRow(row: TaskCacheRow): Entry {
    return this.contracts.parseEntry({
      gid: row.gid,
      asana_response: parseStoredJson(row.asana_response_json),
      task: parseStoredJson(row.task_json),
      cached_at: row.cached_at,
      ...(row.custom_external_data_json == null
        ? {}
        : { custom_external_data: parseStoredJson(row.custom_external_data_json) }),
    });
  }

  private writeTaskCacheEntry(
    entry: Entry,
    statement: { run(...params: [string, string, string, string | null, string]): unknown },
  ): void {
    statement.run(
      entry.gid,
      serializeStoredJson(entry.asana_response),
      serializeStoredJson(entry.task),
      entry.custom_external_data != null
        ? serializeStoredJson(entry.custom_external_data)
        : null,
      entry.cached_at,
    );
  }

  /** タスクキャッシュを全件置換します。 */
  public replaceTaskCache(entries: readonly Entry[]): void {
    const validatedEntries = this.contracts.parseEntries(entries).map(this.contracts.parseEntry);
    const replace = this.runtime.transaction(() => {
      this.runtime.connection.prepare("DELETE FROM task_cache").run();
      const insert = this.runtime.connection.prepare<
        [string, string, string, string | null, string]
      >("INSERT INTO task_cache (gid, asana_response_json, task_json, custom_external_data_json, cached_at) VALUES (?, ?, ?, ?, ?)");
      validatedEntries.forEach((entry) => this.writeTaskCacheEntry(entry, insert));
    });
    replace();
  }

  /** タスクキャッシュへ差分を適用します。 */
  public applyTaskCacheDiff(diff: Diff): void {
    const validatedDiff = this.contracts.parseDiff(diff);
    const validatedEntries = validatedDiff.upsert.map(this.contracts.parseEntry);
    const apply = this.runtime.transaction(() => {
      const upsert = this.runtime.connection.prepare<
        [string, string, string, string | null, string]
      >(`INSERT INTO task_cache (gid, asana_response_json, task_json, custom_external_data_json, cached_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(gid) DO UPDATE SET
           asana_response_json = excluded.asana_response_json,
           task_json = excluded.task_json,
           custom_external_data_json = excluded.custom_external_data_json,
           cached_at = excluded.cached_at`);
      const remove = this.runtime.connection.prepare<[string]>(
        "DELETE FROM task_cache WHERE gid = ?",
      );
      validatedEntries.forEach((entry) => this.writeTaskCacheEntry(entry, upsert));
      validatedDiff.missing_gids.forEach((gid) => remove.run(gid));
    });
    apply();
  }

  /** タスクキャッシュをGID順に読み出します。 */
  public getTaskCache(): readonly Entry[] {
    const rows = this.runtime.connection.prepare<[], TaskCacheRow>(
      "SELECT gid, asana_response_json, task_json, custom_external_data_json, cached_at FROM task_cache ORDER BY gid",
    ).all();
    return rows.map((row) => this.parseTaskCacheRow(row));
  }

  /** タスクキャッシュをGIDで一件読み出します。 */
  public getTaskCacheEntry(gid: string): Entry | undefined {
    const validatedGid = this.contracts.parseGid(gid);
    const row = this.runtime.connection.prepare<[string], TaskCacheRow>(
      "SELECT gid, asana_response_json, task_json, custom_external_data_json, cached_at FROM task_cache WHERE gid = ?",
    ).get(validatedGid);
    return row == null ? undefined : this.parseTaskCacheRow(row);
  }

  /** プロジェクトメタデータを保存します。 */
  public saveProjectMetadataCache(metadata: Metadata): void {
    const validated = this.contracts.parseMetadata(metadata);
    this.runtime.connection.prepare<[string, string, string, string, string]>(
      `INSERT INTO project_metadata_cache (project_gid, project_json, sections_json, tags_json, cached_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_gid) DO UPDATE SET
         project_json = excluded.project_json,
         sections_json = excluded.sections_json,
         tags_json = excluded.tags_json,
         cached_at = excluded.cached_at`,
    ).run(
      validated.project.gid,
      serializeStoredJson(validated.project),
      serializeStoredJson(validated.sections),
      serializeStoredJson(validated.tags),
      validated.cached_at,
    );
  }

  private parseProjectMetadataRow(row: ProjectMetadataRow): Metadata {
    const metadata = this.contracts.parseMetadata({
      project: parseStoredJson(row.project_json),
      sections: parseStoredJson(row.sections_json),
      tags: parseStoredJson(row.tags_json),
      cached_at: row.cached_at,
    });
    if (metadata.project.gid !== row.project_gid) {
      throw new Error("プロジェクトメタデータキャッシュのGIDが一致しません。");
    }
    return metadata;
  }

  /** プロジェクトメタデータをGIDで読み出します。 */
  public getProjectMetadataCache(projectGid: string): Metadata | undefined {
    const validatedGid = this.contracts.parseGid(projectGid);
    const row = this.runtime.connection.prepare<[string], ProjectMetadataRow>(
      "SELECT project_gid, project_json, sections_json, tags_json, cached_at FROM project_metadata_cache WHERE project_gid = ?",
    ).get(validatedGid);
    return row == null ? undefined : this.parseProjectMetadataRow(row);
  }

  /** 保存済みプロジェクトメタデータを全件読み出します。 */
  public getProjectMetadataCaches(): readonly Metadata[] {
    return this.runtime.connection.prepare<[], ProjectMetadataRow>(
      "SELECT project_gid, project_json, sections_json, tags_json, cached_at FROM project_metadata_cache ORDER BY project_gid",
    ).all().map((row) => this.parseProjectMetadataRow(row));
  }

  /** 順位キャッシュを保存します。 */
  public saveRankingCache(ranking: Ranking): void {
    const validated = this.contracts.parseRanking(ranking);
    this.runtime.connection.prepare<[number, string, string, string, string]>(
      `INSERT INTO ranking_cache (cache_key, app_version, calculated_at, ranked_tasks_json, excluded_tasks_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         app_version = excluded.app_version,
         calculated_at = excluded.calculated_at,
         ranked_tasks_json = excluded.ranked_tasks_json,
         excluded_tasks_json = excluded.excluded_tasks_json`,
    ).run(
      1,
      validated.app_version,
      validated.calculated_at,
      serializeStoredJson(validated.ranked_tasks),
      serializeStoredJson(validated.excluded_tasks),
    );
  }

  /** 順位キャッシュを読み出します。 */
  public getRankingCache(): Ranking | undefined {
    const row = this.runtime.connection.prepare<[], RankingRow>(
      "SELECT app_version, calculated_at, ranked_tasks_json, excluded_tasks_json FROM ranking_cache WHERE cache_key = 1",
    ).get();
    return row == null ? undefined : this.contracts.parseRanking({
      app_version: row.app_version,
      calculated_at: row.calculated_at,
      ranked_tasks: parseStoredJson(row.ranked_tasks_json),
      excluded_tasks: parseStoredJson(row.excluded_tasks_json),
    });
  }

  private aggregateCleanupItems(items: readonly CleanupItems[number][]): CleanupItems {
    const byValue = new Map<string, CleanupItems[number]>();
    for (const item of this.contracts.parseCleanupItems(items)) {
      byValue.set(this.contracts.canonicalize(item), item);
    }
    return this.contracts.parseCleanupItems(
      [...byValue.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([, item]) => item),
    );
  }

  private saveCleanupItems(items: CleanupItems): void {
    const validated = this.contracts.parseCleanupItems(items);
    this.runtime.connection.prepare<[number, string]>(
      `INSERT INTO cleanup_items_cache (cache_key, cleanup_items_json)
       VALUES (?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         cleanup_items_json = excluded.cleanup_items_json`,
    ).run(1, serializeStoredJson(validated));
  }

  /** 要整理項目を読み出します。 */
  public getCleanupItems(): CleanupItems | undefined {
    const row = this.runtime.connection.prepare<[], CleanupRow>(
      "SELECT cache_key, cleanup_items_json FROM cleanup_items_cache WHERE cache_key = 1",
    ).get();
    if (row == null) {
      return undefined;
    }
    if (row.cache_key !== 1) {
      throw new Error("要整理キャッシュのキーが不正です。");
    }
    return this.contracts.parseCleanupItems(parseStoredJson(row.cleanup_items_json));
  }

  private createCleanupItemsReplacement(
    existingItems: readonly CleanupItems[number][],
    kinds: readonly string[],
    replacementItems: readonly CleanupItems[number][],
  ): CleanupItems {
    const validatedExisting = this.contracts.parseCleanupItems(existingItems);
    const validatedKinds = this.contracts.parseCleanupKinds(kinds);
    const validatedReplacement = this.contracts.parseCleanupItems(replacementItems);
    const kindSet = new Set(validatedKinds);
    validatedReplacement.forEach((item, index) => {
      if (!kindSet.has(item.kind)) {
        throw new Error(`置換項目 ${index} の要整理種別 ${item.kind} は置換対象に含まれていません。`);
      }
    });
    return this.aggregateCleanupItems([
      ...validatedExisting.filter((item) => !kindSet.has(item.kind)),
      ...validatedReplacement,
    ]);
  }

  /** 指定種別の要整理項目を置換します。 */
  public replaceCleanupItemsByKinds(
    kinds: readonly string[],
    replacementItems: CleanupItems,
  ): CleanupItems {
    const replace = this.runtime.transaction(() => {
      const existing = this.getCleanupItems() ?? this.contracts.parseCleanupItems([]);
      const items = this.createCleanupItemsReplacement(existing, kinds, replacementItems);
      this.saveCleanupItems(items);
      return items;
    });
    return replace();
  }

  /** 指定種別の要整理項目を統合します。 */
  public mergeCleanupItemsByKinds(
    kinds: readonly string[],
    items: CleanupItems,
  ): CleanupItems {
    const merge = this.runtime.transaction(() => {
      const existing = this.getCleanupItems() ?? this.contracts.parseCleanupItems([]);
      const validated = this.createCleanupItemsReplacement([], kinds, items);
      const aggregated = this.aggregateCleanupItems([...existing, ...validated]);
      this.saveCleanupItems(aggregated);
      return aggregated;
    });
    return merge();
  }

  /** プロジェクトの同期状態を保存します。 */
  public saveSyncState(state: SyncState): void {
    const validated = this.contracts.parseSyncState(state);
    this.runtime.connection.prepare<[string, string | null, string | null, string | null]>(
      `INSERT INTO sync_state (project_gid, events_token, last_successful_sync_at, last_full_sync_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_gid) DO UPDATE SET
         events_token = excluded.events_token,
         last_successful_sync_at = excluded.last_successful_sync_at,
         last_full_sync_at = excluded.last_full_sync_at`,
    ).run(
      validated.project_gid,
      validated.events_token ?? null,
      validated.last_successful_sync_at ?? null,
      validated.last_full_sync_at ?? null,
    );
  }

  private parseSyncStateRow(row: SyncStateRow): SyncState {
    return this.contracts.parseSyncState({
      project_gid: row.project_gid,
      ...(row.events_token == null ? {} : { events_token: row.events_token }),
      ...(row.last_successful_sync_at == null
        ? {} : { last_successful_sync_at: row.last_successful_sync_at }),
      ...(row.last_full_sync_at == null ? {} : { last_full_sync_at: row.last_full_sync_at }),
    });
  }

  /** プロジェクトの同期状態をGIDで読み出します。 */
  public getSyncState(projectGid: string): SyncState | undefined {
    const validatedGid = this.contracts.parseGid(projectGid);
    const row = this.runtime.connection.prepare<[string], SyncStateRow>(
      "SELECT project_gid, events_token, last_successful_sync_at, last_full_sync_at FROM sync_state WHERE project_gid = ?",
    ).get(validatedGid);
    return row == null ? undefined : this.parseSyncStateRow(row);
  }

  /** 保存済み同期状態を全件読み出します。 */
  public getSyncStates(): readonly SyncState[] {
    return this.runtime.connection.prepare<[], SyncStateRow>(
      "SELECT project_gid, events_token, last_successful_sync_at, last_full_sync_at FROM sync_state ORDER BY project_gid",
    ).all().map((row) => this.parseSyncStateRow(row));
  }

  /** 同期スナップショットを一つのトランザクションで保存します。 */
  public saveSyncSnapshot(
    entries: readonly Entry[],
    metadata: Metadata,
    ranking: Ranking,
    syncState: SyncState,
    cleanupItems: CleanupItems,
  ): void {
    const validatedEntries = this.contracts.parseEntries(entries);
    const validatedMetadata = this.contracts.parseMetadata(metadata);
    const validatedRanking = this.contracts.parseRanking(ranking);
    const validatedSyncState = this.contracts.parseSyncState(syncState);
    const validatedCleanup = this.contracts.parseCleanupItems(cleanupItems);
    if (validatedMetadata.project.gid !== validatedSyncState.project_gid) {
      throw new Error("同期スナップショットのプロジェクトGIDが一致しません。");
    }
    const save = this.runtime.transaction(() => {
      const existing = this.getCleanupItems() ?? this.contracts.parseCleanupItems([]);
      const localItems = existing.filter((item) =>
        item.kind === "proposal_conflict" || item.kind === "broken_vault_link"
      );
      const aggregated = this.aggregateCleanupItems([...validatedCleanup, ...localItems]);
      this.replaceTaskCache(validatedEntries);
      this.saveProjectMetadataCache(validatedMetadata);
      this.saveRankingCache(validatedRanking);
      this.saveCleanupItems(aggregated);
      this.saveSyncState(validatedSyncState);
    });
    save();
  }

  /** 再構築可能なキャッシュを全消去します。 */
  public clearCaches(): void {
    const clear = this.runtime.transaction(() => {
      this.runtime.connection.exec(
        "DELETE FROM task_cache; DELETE FROM project_metadata_cache; DELETE FROM ranking_cache; DELETE FROM cleanup_items_cache; DELETE FROM sync_state; DELETE FROM diagnostic_log;",
      );
    });
    clear();
  }
}
