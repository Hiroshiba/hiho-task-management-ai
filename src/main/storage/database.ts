import { z } from "zod";
import {
  PersistenceRuntime,
  storageBusyTimeoutMilliseconds,
} from "../infrastructure/persistence/persistence-runtime";
import { TaskReadPersistenceRepository } from "../infrastructure/persistence";
import {
  assertTableRowCount,
  readTableRowCount,
} from "../infrastructure/persistence/sqlite-migration";
import { DiagnosticLogStore } from "./diagnostic-log";
import { ApplicationJournalStore } from "./application-journal";
import {
  ExternalToolDefinitionStore,
  type ExternalToolDefinitionRecord,
} from "./external-tool-definitions";
import { VaultMappingStore } from "./vault-mappings";
import type {
  ApplicationJournal,
  ApplicationJournalResult,
  ApplicationJournalStage,
  CleanupItemsCache,
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
  taskCacheDiffSchema,
  taskCacheEntriesSchema,
  taskCacheEntrySchema,
} from "../../shared/storage";
import {
  canonicalizeJson,
  cleanupItemKindSchema,
  cleanupItemSchema,
  cleanupItemsSchema,
  gidSchema,
  parseCustomExternalData,
  type CleanupItemKind,
} from "../../shared/domain";
import type { SqliteDatabase } from "./types";
import { parseStorageJson, serializeStorageJson } from "./json";

export { storageSchemaVersion } from "../infrastructure/persistence/sqlite-schema";

export { storageBusyTimeoutMilliseconds };

interface CleanupItemsCacheRow {
  readonly cache_key: number;
  readonly cleanup_items_json: string;
}

const legacyProposalConflictMessagePattern =
  /^AI変更案 (\S+) の操作 (\S+) は(?:適用されませんでした|適用結果を確定できません)。理由コードは \S+ です。$/u;

function createTaskReadPersistenceContracts() {
  const cleanupKindsSchema = z.array(cleanupItemKindSchema)
    .min(1, "置換対象の要整理種別を一つ以上指定してください。")
    .superRefine((kinds, context) => {
      const seen = new Set<string>();
      kinds.forEach((kind, index) => {
        if (seen.has(kind)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じ要整理種別を重複して指定できません。",
          });
        }
        seen.add(kind);
      });
    });
  const parseEntry = (value: unknown): TaskCacheEntry => {
    const entry = taskCacheEntrySchema.parse(value);
    const externalData = entry.custom_external_data;
    if (externalData != null) {
      const parsed = parseCustomExternalData(externalData.raw);
      if (parsed.status !== externalData.status) {
        throw new Error("Custom external dataのキャッシュ状態がrawの解析結果と一致しません。");
      }
      if (externalData.status === "unknown_version"
        && (parsed.kind !== "unknown_version" || parsed.schema !== externalData.schema)) {
        throw new Error("Custom external dataのschema versionがrawの解析結果と一致しません。");
      }
    }
    return entry;
  };
  return {
    parseGid: (value: string) => gidSchema.parse(value),
    parseEntry,
    parseEntries: (value: unknown) => taskCacheEntriesSchema.parse(value),
    parseDiff: (value: unknown) => taskCacheDiffSchema.parse(value),
    parseMetadata: (value: unknown) => projectMetadataCacheSchema.parse(value),
    parseRanking: (value: unknown) => rankingCacheSchema.parse(value),
    parseSyncState: (value: unknown) => syncStateSchema.parse(value),
    parseCleanupItems: (value: unknown) => cleanupItemsSchema.parse(value),
    parseCleanupKinds: (value: unknown) => cleanupKindsSchema.parse(value),
    canonicalize: canonicalizeJson,
  };
}

/** 旧形式の要整理項目を現行の識別子へ移行します。 */
export function migrateLegacyProposalConflictIdentifiers(database: SqliteDatabase): void {
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

/** SQLite永続化層を開き、対象スキーマを初期化します。 */
export class StorageDatabase {
  private readonly runtime: PersistenceRuntime;
  public readonly taskRead: TaskReadPersistenceRepository<
    TaskCacheEntry,
    ProjectMetadataCache,
    RankingCache,
    SyncState,
    CleanupItemsCache,
    TaskCacheDiff
  >;
  public readonly taskReadContracts: ReturnType<typeof createTaskReadPersistenceContracts>;
  private readonly vaultMappingStore: VaultMappingStore;
  private readonly applicationJournalStore: ApplicationJournalStore;
  private readonly diagnosticLogStore: DiagnosticLogStore;
  private readonly externalToolDefinitionStore: ExternalToolDefinitionStore;

  public constructor(runtime: PersistenceRuntime) {
    this.runtime = runtime;
    this.taskReadContracts = createTaskReadPersistenceContracts();
    this.taskRead = new TaskReadPersistenceRepository(runtime, this.taskReadContracts);
    const database = this.runtime.connection;
    this.vaultMappingStore = new VaultMappingStore(database);
    this.applicationJournalStore = new ApplicationJournalStore(database, this.runtime);
    this.diagnosticLogStore = new DiagnosticLogStore(database, this.runtime);
    this.externalToolDefinitionStore = new ExternalToolDefinitionStore(database, this.runtime);
  }

  /** SQLite接続を閉じます。 */
  public close(): void {
    this.runtime.close();
  }

  /** タスクキャッシュを一つのトランザクションで全件置換します。 */
  public replaceTaskCache(entries: readonly TaskCacheEntry[]): void {
    this.taskRead.replaceTaskCache(entries);
  }

  /** タスクキャッシュの差分を一つのトランザクションで適用します。 */
  public applyTaskCacheDiff(diff: TaskCacheDiff): void {
    this.taskRead.applyTaskCacheDiff(diff);
  }

  /** タスクキャッシュを全件読み出します。 */
  public getTaskCache(): readonly TaskCacheEntry[] {
    return this.taskRead.getTaskCache();
  }

  /** 同期済みタスク・メタデータ・順位・同期状態を一つのトランザクションで保存します。 */
  public saveSyncSnapshot(
    entries: readonly TaskCacheEntry[],
    metadata: ProjectMetadataCache,
    ranking: RankingCache,
    syncState: SyncState,
    cleanupItems: CleanupItemsCache,
  ): void {
    this.taskRead.saveSyncSnapshot(entries, metadata, ranking, syncState, cleanupItems);
  }

  /** GIDでタスクキャッシュを一件読み出します。 */
  public getTaskCacheEntry(gid: string): TaskCacheEntry | undefined {
    return this.taskRead.getTaskCacheEntry(gid);
  }

  /** プロジェクトメタデータキャッシュを保存します。 */
  public saveProjectMetadataCache(cache: ProjectMetadataCache): void {
    this.taskRead.saveProjectMetadataCache(cache);
  }

  /** プロジェクトメタデータキャッシュを読み出します。 */
  public getProjectMetadataCache(projectGid: string): ProjectMetadataCache | undefined {
    return this.taskRead.getProjectMetadataCache(projectGid);
  }

  /** 保存済みプロジェクトメタデータキャッシュを全件読み出します。 */
  public getProjectMetadataCaches(): readonly ProjectMetadataCache[] {
    return this.taskRead.getProjectMetadataCaches();
  }

  /** 算出済み順位キャッシュを保存します。 */
  public saveRankingCache(cache: RankingCache): void {
    this.taskRead.saveRankingCache(cache);
  }

  /** 算出済み順位キャッシュを読み出します。 */
  public getRankingCache(): RankingCache | undefined {
    return this.taskRead.getRankingCache();
  }

  /** 要整理項目キャッシュを読み出します。 */
  public getCleanupItems(): CleanupItemsCache | undefined {
    return this.taskRead.getCleanupItems();
  }

  /** 指定種別の要整理項目を一つのトランザクションで置き換えます。 */
  public replaceCleanupItemsByKinds(
    kinds: readonly CleanupItemKind[],
    replacementItems: CleanupItemsCache,
  ): CleanupItemsCache {
    return this.taskRead.replaceCleanupItemsByKinds(kinds, replacementItems);
  }

  /** 指定種別の要整理項目を一つのトランザクションで既存項目へ統合します。 */
  public mergeCleanupItemsByKinds(
    kinds: readonly CleanupItemKind[],
    items: CleanupItemsCache,
  ): CleanupItemsCache {
    return this.taskRead.mergeCleanupItemsByKinds(kinds, items);
  }

  /** プロジェクトの同期状態を保存します。 */
  public saveSyncState(state: SyncState): void {
    this.taskRead.saveSyncState(state);
  }

  /** プロジェクトの同期状態を読み出します。 */
  public getSyncState(projectGid: string): SyncState | undefined {
    return this.taskRead.getSyncState(projectGid);
  }

  /** 保存済み同期状態を全件読み出します。 */
  public getSyncStates(): readonly SyncState[] {
    return this.taskRead.getSyncStates();
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
    this.taskRead.clearCaches();
  }
}
