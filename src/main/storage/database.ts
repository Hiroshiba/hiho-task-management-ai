import BetterSqlite3 from "better-sqlite3";
import { isAbsolute } from "node:path";
import { DiagnosticLogStore } from "./diagnostic-log";
import { ApplicationJournalStore } from "./application-journal";
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
  DeviceSettings,
  DiagnosticLogEntry,
  ProjectMetadataCache,
  RankingCache,
  SyncState,
  TaskCacheDiff,
  TaskCacheEntry,
  VaultMapping,
} from "../../shared/storage";
import type { SqliteDatabase } from "./types";

export const storageSchemaVersion = 1;
export const storageBusyTimeoutMilliseconds = 5_000;

const storageTableNames = [
  "task_cache",
  "project_metadata_cache",
  "ranking_cache",
  "sync_state",
  "device_settings",
  "vault_mappings",
  "application_journal",
  "diagnostic_log",
] as const;

const storageSchemaSql = `
CREATE TABLE task_cache (
  gid TEXT PRIMARY KEY NOT NULL,
  asana_response_json TEXT NOT NULL,
  task_json TEXT NOT NULL,
  custom_external_data_json TEXT,
  cached_at TEXT NOT NULL
);
CREATE TABLE project_metadata_cache (
  project_gid TEXT PRIMARY KEY NOT NULL,
  project_json TEXT NOT NULL,
  sections_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  cached_at TEXT NOT NULL
);
CREATE TABLE ranking_cache (
  cache_key INTEGER PRIMARY KEY NOT NULL CHECK (cache_key = 1),
  app_version TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  ranked_tasks_json TEXT NOT NULL,
  excluded_tasks_json TEXT NOT NULL
);
CREATE TABLE sync_state (
  project_gid TEXT PRIMARY KEY NOT NULL,
  events_token TEXT,
  last_successful_sync_at TEXT,
  last_full_sync_at TEXT
);
CREATE TABLE device_settings (
  settings_key INTEGER PRIMARY KEY NOT NULL CHECK (settings_key = 1),
  client_id TEXT NOT NULL,
  project_gid TEXT NOT NULL,
  not_started_section_gid TEXT NOT NULL,
  in_progress_section_gid TEXT NOT NULL,
  completed_section_gid TEXT NOT NULL,
  withdrawn_section_gid TEXT NOT NULL
);
CREATE TABLE vault_mappings (
  vault_id TEXT PRIMARY KEY NOT NULL,
  absolute_path TEXT NOT NULL
);
CREATE TABLE application_journal (
  proposal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  new_task_uuid TEXT,
  target_gid TEXT,
  started_at TEXT NOT NULL,
  stage TEXT NOT NULL,
  final_result TEXT,
  PRIMARY KEY (proposal_id, operation_id),
  CHECK (
    (new_task_uuid IS NOT NULL AND target_gid IS NULL)
    OR (new_task_uuid IS NULL AND target_gid IS NOT NULL)
  )
);
CREATE TABLE diagnostic_log (
  id INTEGER PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  severity TEXT NOT NULL,
  code TEXT NOT NULL,
  http_status INTEGER,
  asana_gid TEXT,
  proposal_id TEXT,
  operation_id TEXT,
  app_version TEXT,
  codex_version TEXT
);
`;

interface TableNameRow {
  readonly name: string;
}

function validateDatabasePath(dbPath: string): void {
  if (typeof dbPath !== "string" || !isAbsolute(dbPath)) {
    throw new Error("SQLiteデータベースのパスは絶対パスで指定してください。");
  }
}

function readTableNames(database: SqliteDatabase): readonly string[] {
  const rows = database
    .prepare<[], TableNameRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
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
}

function initializeSchema(database: SqliteDatabase): void {
  const userVersion = database.pragma("user_version", { simple: true });
  if (typeof userVersion !== "number" || !Number.isInteger(userVersion)) {
    throw new Error("SQLiteのschema versionを読み取れませんでした。");
  }

  const tableNames = readTableNames(database);
  if (userVersion === 0) {
    if (tableNames.length !== 0) {
      throw new Error("SQLiteに未対応のschemaが存在します。");
    }

    const createSchema = database.transaction(() => {
      database.exec(storageSchemaSql);
      database.pragma(`user_version = ${storageSchemaVersion}`);
    });
    createSchema();
    return;
  }

  if (userVersion !== storageSchemaVersion) {
    throw new Error(`未対応のSQLite schema versionです: ${userVersion}`);
  }

  const tableNameSet = new Set(tableNames);
  const expectedTableNameSet = new Set<string>(storageTableNames);
  if (
    tableNames.length !== storageTableNames.length ||
    tableNames.some((tableName) => !expectedTableNameSet.has(tableName))
  ) {
    throw new Error("SQLiteに未対応の追加テーブルが存在します。");
  }
  storageTableNames.forEach((tableName) => {
    if (!tableNameSet.has(tableName)) {
      throw new Error(`SQLiteのテーブルが不足しています: ${tableName}`);
    }
  });
}

/** SQLite永続化層を開き、対象スキーマを初期化します。 */
export class StorageDatabase {
  private readonly database: SqliteDatabase;
  private readonly taskCacheStore: TaskCacheStore;
  private readonly projectMetadataCacheStore: ProjectMetadataCacheStore;
  private readonly rankingCacheStore: RankingCacheStore;
  private readonly syncStateStore: SyncStateStore;
  private readonly deviceSettingsStore: DeviceSettingsStore;
  private readonly vaultMappingStore: VaultMappingStore;
  private readonly applicationJournalStore: ApplicationJournalStore;
  private readonly diagnosticLogStore: DiagnosticLogStore;

  public constructor(dbPath: string) {
    validateDatabasePath(dbPath);
    const database = new BetterSqlite3(dbPath);
    try {
      assertPragmas(database);
      initializeSchema(database);
    } catch (error) {
      database.close();
      throw error;
    }

    this.database = database;
    this.taskCacheStore = new TaskCacheStore(database);
    this.projectMetadataCacheStore = new ProjectMetadataCacheStore(database);
    this.rankingCacheStore = new RankingCacheStore(database);
    this.syncStateStore = new SyncStateStore(database);
    this.deviceSettingsStore = new DeviceSettingsStore(database);
    this.vaultMappingStore = new VaultMappingStore(database);
    this.applicationJournalStore = new ApplicationJournalStore(database);
    this.diagnosticLogStore = new DiagnosticLogStore(database);
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

  /** 適用ジャーナルを新規作成します。 */
  public createApplicationJournal(entry: ApplicationJournal): void {
    this.applicationJournalStore.create(entry);
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

  /** 指定された適用ジャーナルを読み出します。 */
  public getApplicationJournal(
    proposalId: string,
    operationId: string,
  ): ApplicationJournal | undefined {
    return this.applicationJournalStore.get(proposalId, operationId);
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

  /** 再構築可能なキャッシュだけを全消去します。 */
  public clearCaches(): void {
    const clear = this.database.transaction(() => {
      this.database.exec(
        "DELETE FROM task_cache; DELETE FROM project_metadata_cache; DELETE FROM ranking_cache; DELETE FROM sync_state; DELETE FROM diagnostic_log;",
      );
    });
    clear();
  }
}
