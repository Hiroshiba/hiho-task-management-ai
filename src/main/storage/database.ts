import BetterSqlite3 from "better-sqlite3";
import {
  assertSecurePersistentFileSnapshot,
  captureSecurePersistentFile,
  ensureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
} from "../local-storage-path";
import {
  assertTableRowCount,
  initializeSqliteSchema,
  readTableRowCount,
} from "../infrastructure/persistence/sqlite-migration";
import {
  aggregateCleanupItems,
  CleanupItemsCacheStore,
  replaceCleanupItemsByKinds as createCleanupItemsReplacement,
} from "./cleanup-items-cache";
import { DiagnosticLogStore } from "./diagnostic-log";
import { ApplicationJournalStore } from "./application-journal";
import {
  ExternalToolDefinitionStore,
  type ExternalToolDefinitionRecord,
} from "./external-tool-definitions";
import { ProjectMetadataCacheStore } from "./project-metadata-cache";
import { RankingCacheStore } from "./ranking-cache";
import { SyncStateStore } from "./sync-state";
import { TaskCacheStore } from "./task-cache";
import { DeviceSettingsStore } from "./device-settings";
import { VaultMappingStore } from "./vault-mappings";
import type {
  ApplicationJournal,
  ApplicationJournalResult,
  ApplicationJournalStage,
  CleanupItemsCache,
  DeviceSettings,
  DiagnosticLogEntry,
  ProjectMetadataCache,
  RankingCache,
  SyncState,
  TaskCacheDiff,
  TaskCacheEntry,
  VaultMapping,
} from "../../shared/storage";
import {
  cleanupItemsCacheSchema,
  projectMetadataCacheSchema,
  rankingCacheSchema,
  syncStateSchema,
  taskCacheEntriesSchema,
} from "../../shared/storage";
import {
  cleanupItemSchema,
  cleanupItemsSchema,
  type CleanupItemKind,
} from "../../shared/domain";
import type { SqliteDatabase } from "./types";
import { parseStorageJson, serializeStorageJson } from "./json";

export { storageSchemaVersion } from "../infrastructure/persistence/sqlite-schema";

export const storageBusyTimeoutMilliseconds = 5_000;

const databaseFileLabel = "SQLiteデータベース";
const sqliteAuxiliaryFileSuffixes: readonly string[] = [
  "-journal",
  "-shm",
  "-wal",
];

const localAsynchronousCleanupItemKinds: readonly CleanupItemKind[] = [
  "proposal_conflict",
  "broken_vault_link",
];

const localAsynchronousCleanupItemKindSet = new Set(
  localAsynchronousCleanupItemKinds,
);

interface CleanupItemsCacheRow {
  readonly cache_key: number;
  readonly cleanup_items_json: string;
}

const legacyProposalConflictMessagePattern =
  /^AI変更案 (\S+) の操作 (\S+) は(?:適用されませんでした|適用結果を確定できません)。理由コードは \S+ です。$/u;

function validateSqliteAuxiliaryFiles(dbPath: string): void {
  sqliteAuxiliaryFileSuffixes.forEach((suffix) => {
    captureSecurePersistentFile(
      `${dbPath}${suffix}`,
      `${databaseFileLabel}${suffix}`,
    );
  });
}

function closeDatabaseAfterInitializationFailure(
  database: SqliteDatabase,
  error: unknown,
): never {
  try {
    database.close();
  } catch (closeError) {
    throw new AggregateError(
      [error, closeError],
      "SQLiteの初期化と接続終了に失敗しました。",
      { cause: error },
    );
  }
  throw error;
}

function migrateLegacyProposalConflictIdentifiers(database: SqliteDatabase): void {
  const sourceRowCount = readTableRowCount(database, "cleanup_items_cache");
  const rows = database
    .prepare<[], CleanupItemsCacheRow>(
      "SELECT cache_key, cleanup_items_json FROM cleanup_items_cache ORDER BY cache_key",
    )
    .all();
  if (rows.length !== sourceRowCount) {
    throw new Error("要整理キャッシュの行数が移行前に一致しません。");
  }

  const updateStatement = database.prepare<[string, number]>(
    "UPDATE cleanup_items_cache SET cleanup_items_json = ? WHERE cache_key = ?",
  );
  rows.forEach((row) => {
    if (row.cache_key !== 1) {
      throw new Error("要整理キャッシュのキーが不正です。");
    }
    const items = parseStorageJson(row.cleanup_items_json, cleanupItemsCacheSchema);
    let hasMigratedItem = false;
    const migratedItems = items.map((item) => {
      if (
        item.kind !== "proposal_conflict"
        || item.proposal_id != null
        || item.operation_id != null
      ) {
        return item;
      }

      const matchedMessage = legacyProposalConflictMessagePattern.exec(item.message);
      if (matchedMessage == null || matchedMessage[0] !== item.message) {
        return item;
      }
      const proposalId = matchedMessage[1];
      const operationId = matchedMessage[2];
      if (proposalId == null || operationId == null) {
        throw new Error("旧形式の要整理項目から識別子を抽出できませんでした。");
      }
      const validatedItem = cleanupItemSchema.safeParse({
        ...item,
        proposal_id: proposalId,
        operation_id: operationId,
      });
      if (!validatedItem.success) {
        return item;
      }
      hasMigratedItem = true;
      return validatedItem.data;
    });
    if (!hasMigratedItem) {
      return;
    }

    const validatedItems = cleanupItemsCacheSchema.parse(migratedItems);
    const updateResult = updateStatement.run(
      serializeStorageJson(validatedItems),
      row.cache_key,
    );
    if (updateResult.changes !== 1) {
      throw new Error("要整理キャッシュの移行対象が見つかりません。");
    }
  });
  assertTableRowCount(database, "cleanup_items_cache", sourceRowCount);
}

function assertPragmas(database: SqliteDatabase): void {
  database.pragma("foreign_keys = ON");
  const foreignKeys = database.pragma("foreign_keys", { simple: true });
  if (foreignKeys !== 1) {
    throw new Error("SQLiteのforeign_keysをONに設定できませんでした。");
  }

  const journalMode = database.pragma("journal_mode = WAL", { simple: true });
  if (journalMode !== "wal") {
    throw new Error("SQLiteのjournal_modeをWALに設定できませんでした。");
  }

  database.pragma(`busy_timeout = ${storageBusyTimeoutMilliseconds}`);
  const busyTimeout = database.pragma("busy_timeout", { simple: true });
  if (busyTimeout !== storageBusyTimeoutMilliseconds) {
    throw new Error("SQLiteのbusy_timeoutを設定できませんでした。");
  }

  database.pragma("synchronous = FULL");
  const synchronous = database.pragma("synchronous", { simple: true });
  if (synchronous !== 2) {
    throw new Error("SQLiteのsynchronousをFULLに設定できませんでした。");
  }
}

/** SQLite永続化層を開き、対象スキーマを初期化します。 */
export class StorageDatabase {
  private readonly database: SqliteDatabase;
  private readonly taskCacheStore: TaskCacheStore;
  private readonly projectMetadataCacheStore: ProjectMetadataCacheStore;
  private readonly rankingCacheStore: RankingCacheStore;
  private readonly cleanupItemsCacheStore: CleanupItemsCacheStore;
  private readonly syncStateStore: SyncStateStore;
  private readonly deviceSettingsStore: DeviceSettingsStore;
  private readonly vaultMappingStore: VaultMappingStore;
  private readonly applicationJournalStore: ApplicationJournalStore;
  private readonly diagnosticLogStore: DiagnosticLogStore;
  private readonly externalToolDefinitionStore: ExternalToolDefinitionStore;

  public constructor(dbPath: string) {
    const normalizedDbPath = normalizeSecurePersistentFilePath(dbPath);
    captureSecurePersistentFile(normalizedDbPath, databaseFileLabel);
    validateSqliteAuxiliaryFiles(normalizedDbPath);
    const databaseSnapshot = ensureSecurePersistentFile(
      normalizedDbPath,
      databaseFileLabel,
    );
    validateSqliteAuxiliaryFiles(normalizedDbPath);
    assertSecurePersistentFileSnapshot(
      normalizedDbPath,
      databaseSnapshot,
      databaseFileLabel,
    );
    const database = new BetterSqlite3(normalizedDbPath, { fileMustExist: true });
    try {
      assertSecurePersistentFileSnapshot(
        normalizedDbPath,
        databaseSnapshot,
        databaseFileLabel,
      );
      validateSqliteAuxiliaryFiles(normalizedDbPath);
      assertPragmas(database);
      assertSecurePersistentFileSnapshot(
        normalizedDbPath,
        databaseSnapshot,
        databaseFileLabel,
      );
      validateSqliteAuxiliaryFiles(normalizedDbPath);
      initializeSqliteSchema(database, migrateLegacyProposalConflictIdentifiers);
      assertSecurePersistentFileSnapshot(
        normalizedDbPath,
        databaseSnapshot,
        databaseFileLabel,
      );
      validateSqliteAuxiliaryFiles(normalizedDbPath);
    } catch (error) {
      closeDatabaseAfterInitializationFailure(database, error);
    }

    this.database = database;
    this.taskCacheStore = new TaskCacheStore(database);
    this.projectMetadataCacheStore = new ProjectMetadataCacheStore(database);
    this.rankingCacheStore = new RankingCacheStore(database);
    this.cleanupItemsCacheStore = new CleanupItemsCacheStore(database);
    this.syncStateStore = new SyncStateStore(database);
    this.deviceSettingsStore = new DeviceSettingsStore(database);
    this.vaultMappingStore = new VaultMappingStore(database);
    this.applicationJournalStore = new ApplicationJournalStore(database);
    this.diagnosticLogStore = new DiagnosticLogStore(database);
    this.externalToolDefinitionStore = new ExternalToolDefinitionStore(database);
  }

  /** SQLite接続を閉じます。 */
  public close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  /** タスクキャッシュを一つのトランザクションで全件置換します。 */
  public replaceTaskCache(entries: readonly TaskCacheEntry[]): void {
    this.taskCacheStore.replace(entries);
  }

  /** タスクキャッシュの差分を一つのトランザクションで適用します。 */
  public applyTaskCacheDiff(diff: TaskCacheDiff): void {
    this.taskCacheStore.applyDiff(diff);
  }

  /** タスクキャッシュを全件読み出します。 */
  public getTaskCache(): readonly TaskCacheEntry[] {
    return this.taskCacheStore.getAll();
  }

  /** 同期済みタスク・メタデータ・順位・同期状態を一つのトランザクションで保存します。 */
  public saveSyncSnapshot(
    entries: readonly TaskCacheEntry[],
    metadata: ProjectMetadataCache,
    ranking: RankingCache,
    syncState: SyncState,
    cleanupItems: CleanupItemsCache,
  ): void {
    const validatedEntries = taskCacheEntriesSchema.parse(entries);
    const validatedMetadata = projectMetadataCacheSchema.parse(metadata);
    const validatedRanking = rankingCacheSchema.parse(ranking);
    const validatedSyncState = syncStateSchema.parse(syncState);
    const validatedCleanupItems = cleanupItemsCacheSchema.parse(cleanupItems);
    if (validatedMetadata.project.gid !== validatedSyncState.project_gid) {
      throw new Error("同期スナップショットのプロジェクトGIDが一致しません。");
    }
    const save = this.database.transaction(() => {
      const storedCleanupItems = this.cleanupItemsCacheStore.get();
      const existingCleanupItems = storedCleanupItems == null
        ? cleanupItemsSchema.parse([])
        : storedCleanupItems;
      const localCleanupItems = existingCleanupItems.filter((item) =>
        localAsynchronousCleanupItemKindSet.has(item.kind),
      );
      const aggregatedCleanupItems = aggregateCleanupItems([
        ...validatedCleanupItems,
        ...localCleanupItems,
      ]);
      this.taskCacheStore.replace(validatedEntries);
      this.projectMetadataCacheStore.save(validatedMetadata);
      this.rankingCacheStore.save(validatedRanking);
      this.cleanupItemsCacheStore.save(aggregatedCleanupItems);
      this.syncStateStore.save(validatedSyncState);
    });
    save();
  }

  /** GIDでタスクキャッシュを一件読み出します。 */
  public getTaskCacheEntry(gid: string): TaskCacheEntry | undefined {
    return this.taskCacheStore.get(gid);
  }

  /** プロジェクトメタデータキャッシュを保存します。 */
  public saveProjectMetadataCache(cache: ProjectMetadataCache): void {
    this.projectMetadataCacheStore.save(cache);
  }

  /** プロジェクトメタデータキャッシュを読み出します。 */
  public getProjectMetadataCache(projectGid: string): ProjectMetadataCache | undefined {
    return this.projectMetadataCacheStore.get(projectGid);
  }

  /** 保存済みプロジェクトメタデータキャッシュを全件読み出します。 */
  public getProjectMetadataCaches(): readonly ProjectMetadataCache[] {
    return this.projectMetadataCacheStore.getAll();
  }

  /** 算出済み順位キャッシュを保存します。 */
  public saveRankingCache(cache: RankingCache): void {
    this.rankingCacheStore.save(cache);
  }

  /** 算出済み順位キャッシュを読み出します。 */
  public getRankingCache(): RankingCache | undefined {
    return this.rankingCacheStore.get();
  }

  /** 要整理項目キャッシュを読み出します。 */
  public getCleanupItems(): CleanupItemsCache | undefined {
    return this.cleanupItemsCacheStore.get();
  }

  /** 指定種別の要整理項目を一つのトランザクションで置き換えます。 */
  public replaceCleanupItemsByKinds(
    kinds: readonly CleanupItemKind[],
    replacementItems: CleanupItemsCache,
  ): CleanupItemsCache {
    const replace = this.database.transaction(() => {
      const storedItems = this.cleanupItemsCacheStore.get();
      const existingItems = storedItems == null
        ? cleanupItemsSchema.parse([])
        : storedItems;
      const aggregatedItems = createCleanupItemsReplacement(
        existingItems,
        kinds,
        replacementItems,
      );
      this.cleanupItemsCacheStore.save(aggregatedItems);
      return aggregatedItems;
    });
    return replace();
  }

  /** 指定種別の要整理項目を一つのトランザクションで既存項目へ統合します。 */
  public mergeCleanupItemsByKinds(
    kinds: readonly CleanupItemKind[],
    items: CleanupItemsCache,
  ): CleanupItemsCache {
    const merge = this.database.transaction(() => {
      const storedItems = this.cleanupItemsCacheStore.get();
      const existingItems = storedItems == null
        ? cleanupItemsSchema.parse([])
        : storedItems;
      const validatedItems = createCleanupItemsReplacement([], kinds, items);
      const aggregatedItems = aggregateCleanupItems([
        ...existingItems,
        ...validatedItems,
      ]);
      this.cleanupItemsCacheStore.save(aggregatedItems);
      return aggregatedItems;
    });
    return merge();
  }

  /** プロジェクトの同期状態を保存します。 */
  public saveSyncState(state: SyncState): void {
    this.syncStateStore.save(state);
  }

  /** プロジェクトの同期状態を読み出します。 */
  public getSyncState(projectGid: string): SyncState | undefined {
    return this.syncStateStore.get(projectGid);
  }

  /** 保存済み同期状態を全件読み出します。 */
  public getSyncStates(): readonly SyncState[] {
    return this.syncStateStore.getAll();
  }

  /** 秘密情報を含まない端末設定を保存します。 */
  public saveDeviceSettings(settings: DeviceSettings): void {
    this.deviceSettingsStore.save(settings);
  }

  /** 保存済み端末設定を読み出します。 */
  public getDeviceSettings(): DeviceSettings | undefined {
    return this.deviceSettingsStore.get();
  }

  /** 端末設定を削除します。 */
  public clearDeviceSettings(): void {
    this.deviceSettingsStore.clear();
  }

  /** Vaultと端末絶対パスの対応を保存します。 */
  public saveVaultMapping(mapping: VaultMapping): void {
    this.vaultMappingStore.save(mapping);
  }

  /** Vaultマッピングを削除します。 */
  public deleteVaultMapping(vaultId: string): void {
    this.vaultMappingStore.delete(vaultId);
  }

  /** 保存済みVaultマッピングを全件読み出します。 */
  public getVaultMappings(): readonly VaultMapping[] {
    return this.vaultMappingStore.getAll();
  }

  /** 選択済み操作の復旧計画を一つのトランザクションで保存します。 */
  public prepareApplicationJournals(entries: readonly ApplicationJournal[]): void {
    this.applicationJournalStore.prepare(entries);
  }

  /** 作成済みタスクのGIDを適用ジャーナルへ保存します。 */
  public recordApplicationJournalTaskCreated(
    proposalId: string,
    operationId: string,
    temporaryRef: string,
    taskGid: string,
  ): void {
    this.applicationJournalStore.recordCreatedTask(
      proposalId,
      operationId,
      temporaryRef,
      taskGid,
    );
  }

  /** 適用ジャーナルの適用段階を更新します。 */
  public updateApplicationJournalStage(
    proposalId: string,
    operationId: string,
    stage: ApplicationJournalStage,
  ): void {
    this.applicationJournalStore.updateStage(proposalId, operationId, stage);
  }

  /** 適用ジャーナルの最終結果を更新します。 */
  public completeApplicationJournal(
    proposalId: string,
    operationId: string,
    finalResult: ApplicationJournalResult,
  ): void {
    this.applicationJournalStore.complete(proposalId, operationId, finalResult);
  }

  /** 処理済みジャーナルの破損causeをメモリ上から削除します。 */
  public clearApplicationJournalRecoveryCause(
    proposalId: string,
    operationId: string,
  ): void {
    this.applicationJournalStore.clearRecoveryCause(proposalId, operationId);
  }

  /** 指定された適用ジャーナルを読み出します。 */
  public getApplicationJournal(
    proposalId: string,
    operationId: string,
  ): ApplicationJournal | undefined {
    return this.applicationJournalStore.get(proposalId, operationId);
  }

  /** 指定されたproposalの適用ジャーナルを全件読み出します。 */
  public getApplicationJournalsByProposal(
    proposalId: string,
  ): readonly ApplicationJournal[] {
    return this.applicationJournalStore.getByProposal(proposalId);
  }

  /** 未完了の適用ジャーナルを全件読み出します。 */
  public getIncompleteApplicationJournals(): readonly ApplicationJournal[] {
    return this.applicationJournalStore.getIncomplete();
  }

  /** 構造化診断ログを追加し、保持上限を超えた古い行を削除します。 */
  public appendDiagnosticLog(entry: DiagnosticLogEntry, retentionLimit: number): void {
    this.diagnosticLogStore.append(entry, retentionLimit);
  }

  /** 構造化診断ログを全件読み出します。 */
  public getDiagnosticLogs(): readonly DiagnosticLogEntry[] {
    return this.diagnosticLogStore.getAll();
  }

  /** 外部ツール定義を保存します。 */
  public saveExternalToolDefinition(record: ExternalToolDefinitionRecord): void {
    this.externalToolDefinitionStore.save(record);
  }

  /** 外部ツール定義を一つのトランザクションで置き換えます。 */
  public replaceExternalToolDefinitions(
    records: readonly ExternalToolDefinitionRecord[],
  ): void {
    this.externalToolDefinitionStore.replace(records);
  }

  /** 外部ツール定義を削除します。 */
  public deleteExternalToolDefinition(toolId: string): void {
    this.externalToolDefinitionStore.delete(toolId);
  }

  /** 外部ツール定義を全件読み出します。 */
  public getExternalToolDefinitions(): readonly ExternalToolDefinitionRecord[] {
    return this.externalToolDefinitionStore.getAll();
  }

  /** 再構築可能なキャッシュだけを全消去します。 */
  public clearCaches(): void {
    const clear = this.database.transaction(() => {
      this.database.exec(
        "DELETE FROM task_cache; DELETE FROM project_metadata_cache; DELETE FROM ranking_cache; DELETE FROM cleanup_items_cache; DELETE FROM sync_state; DELETE FROM diagnostic_log;",
      );
    });
    clear();
  }
}
