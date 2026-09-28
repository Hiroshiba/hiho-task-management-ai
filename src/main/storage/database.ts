import { z } from "zod";
import { PersistenceRuntime } from "../infrastructure/persistence/persistence-runtime";
import { TaskReadPersistenceRepository } from "../infrastructure/persistence";
import { DiagnosticLogStore } from "./diagnostic-log";
import {
  ExternalToolDefinitionStore,
  type ExternalToolDefinitionRecord,
} from "./external-tool-definitions";
import { VaultMappingStore } from "./vault-mappings";
import type {
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
  cleanupItemsSchema,
  gidSchema,
  parseCustomExternalData,
  type CleanupItemKind,
} from "../../shared/domain";

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
  private readonly diagnosticLogStore: DiagnosticLogStore;
  private readonly externalToolDefinitionStore: ExternalToolDefinitionStore;

  public constructor(runtime: PersistenceRuntime) {
    this.runtime = runtime;
    this.taskReadContracts = createTaskReadPersistenceContracts();
    this.taskRead = new TaskReadPersistenceRepository(runtime, this.taskReadContracts);
    const database = this.runtime.connection;
    this.vaultMappingStore = new VaultMappingStore(database);
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
