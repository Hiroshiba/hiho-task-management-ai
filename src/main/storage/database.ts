import BetterSqlite3 from "better-sqlite3";
import {
  assertSecurePersistentFileSnapshot,
  captureSecurePersistentFile,
  ensureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
} from "../local-storage-path";
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

export const storageSchemaVersion = 5;
export const storageBusyTimeoutMilliseconds = 5_000;

const databaseFileLabel = "SQLiteデータベース";
const sqliteAuxiliaryFileSuffixes: readonly string[] = [
  "-journal",
  "-shm",
  "-wal",
];

const storageTableNames = [
  "task_cache",
  "project_metadata_cache",
  "ranking_cache",
  "cleanup_items_cache",
  "sync_state",
  "device_settings",
  "vault_mappings",
  "application_journal",
  "diagnostic_log",
  "external_tool_definitions",
] as const;

const localAsynchronousCleanupItemKinds: readonly CleanupItemKind[] = [
  "proposal_conflict",
  "broken_vault_link",
];

const localAsynchronousCleanupItemKindSet = new Set(
  localAsynchronousCleanupItemKinds,
);

const applicationJournalTableSql = `
CREATE TABLE application_journal (
  proposal_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  new_task_uuid TEXT,
  target_gid TEXT,
  target_temporary_ref TEXT,
  started_at TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (
    stage IN (
      'prepared',
      'started',
      'write_started',
      'task_created',
      'attributes_applied',
      'relations_applied',
      'read_back',
      'metadata_verified',
      'ranking_recalculated',
      'legacy_unresolved'
    )
  ),
  final_result TEXT CHECK (
    final_result IS NULL
    OR final_result IN ('applied', 'not_applied', 'unknown', 'failed')
  ),
  recovery_reason TEXT CHECK (
    recovery_reason IS NULL
    OR recovery_reason IN ('recovery_context_missing', 'journal_target_mismatch')
  ),
  group_id TEXT,
  group_order INTEGER CHECK (group_order IS NULL OR group_order >= 0),
  operation_order INTEGER CHECK (operation_order IS NULL OR operation_order >= 0),
  atomic INTEGER CHECK (atomic IS NULL OR atomic IN (0, 1)),
  project_gid TEXT,
  workspace_gid TEXT,
  section_gids_json TEXT,
  device_id TEXT,
  created_via TEXT,
  activity_date TEXT,
  temporary_ref_to_gid_json TEXT,
  baseline_source_json TEXT,
  operation_kind TEXT CHECK (
    operation_kind IS NULL
    OR operation_kind IN (
      'create_task',
      'update_title',
      'update_notes',
      'set_status',
      'set_importance',
      'set_due',
      'clear_due',
      'set_duration',
      'clear_duration',
      'set_area',
      'set_dependencies',
      'set_parent',
      'set_parent_work_mode',
      'link_obsidian',
      'unlink_obsidian',
      'complete',
      'withdraw'
    )
  ),
  operation_json TEXT,
  expected_before_json TEXT,
  expected_after_json TEXT,
  create_uuid TEXT,
  temporary_ref TEXT,
  PRIMARY KEY (proposal_id, operation_id),
  CHECK (
    (
      stage = 'legacy_unresolved'
      AND recovery_reason IS NOT NULL
    )
    OR (
      stage <> 'legacy_unresolved'
      AND recovery_reason IS NULL
    )
  ),
  CHECK (
    (
      new_task_uuid IS NOT NULL
      AND target_gid IS NULL
      AND target_temporary_ref IS NULL
    )
    OR (
      new_task_uuid IS NULL
      AND target_gid IS NOT NULL
      AND target_temporary_ref IS NULL
    )
    OR (
      new_task_uuid IS NULL
      AND target_gid IS NULL
      AND target_temporary_ref IS NOT NULL
    )
  ),
  CHECK (
    (
      operation_kind IS NULL
      AND group_id IS NULL
      AND group_order IS NULL
      AND operation_order IS NULL
      AND atomic IS NULL
      AND project_gid IS NULL
      AND workspace_gid IS NULL
      AND section_gids_json IS NULL
      AND device_id IS NULL
      AND created_via IS NULL
      AND activity_date IS NULL
      AND temporary_ref_to_gid_json IS NULL
      AND baseline_source_json IS NULL
      AND operation_json IS NULL
      AND expected_before_json IS NULL
      AND expected_after_json IS NULL
      AND create_uuid IS NULL
      AND temporary_ref IS NULL
      AND (
        (
          stage = 'legacy_unresolved'
          AND (final_result IS NULL OR final_result = 'unknown')
        )
        OR (
          final_result IS NOT NULL
          AND stage IN (
            'started',
            'task_created',
            'attributes_applied',
            'relations_applied',
            'read_back',
            'metadata_verified',
            'ranking_recalculated'
          )
        )
      )
    )
    OR (
      operation_kind IS NOT NULL
      AND group_id IS NOT NULL
      AND group_order IS NOT NULL
      AND operation_order IS NOT NULL
      AND atomic IS NOT NULL
      AND project_gid IS NOT NULL
      AND workspace_gid IS NOT NULL
      AND section_gids_json IS NOT NULL
      AND device_id IS NOT NULL
      AND created_via IS NOT NULL
      AND activity_date IS NOT NULL
      AND temporary_ref_to_gid_json IS NOT NULL
      AND baseline_source_json IS NOT NULL
      AND operation_json IS NOT NULL
      AND expected_before_json IS NOT NULL
      AND expected_after_json IS NOT NULL
      AND stage IN (
        'prepared',
        'write_started',
        'task_created',
        'attributes_applied',
        'relations_applied',
        'read_back',
        'metadata_verified',
        'ranking_recalculated'
      )
      AND (
        (
          operation_kind = 'create_task'
          AND new_task_uuid IS NOT NULL
          AND target_gid IS NULL
          AND target_temporary_ref IS NULL
          AND create_uuid IS NOT NULL
          AND temporary_ref IS NOT NULL
          AND create_uuid = new_task_uuid
        )
        OR (
          operation_kind <> 'create_task'
          AND new_task_uuid IS NULL
          AND (target_gid IS NOT NULL OR target_temporary_ref IS NOT NULL)
          AND NOT (target_gid IS NOT NULL AND target_temporary_ref IS NOT NULL)
          AND create_uuid IS NULL
          AND temporary_ref IS NULL
        )
      )
    )
  )
);
`;

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
CREATE TABLE cleanup_items_cache (
  cache_key INTEGER PRIMARY KEY NOT NULL CHECK (cache_key = 1),
  cleanup_items_json TEXT NOT NULL
);
CREATE TABLE sync_state (
  project_gid TEXT PRIMARY KEY NOT NULL,
  events_token TEXT,
  last_successful_sync_at TEXT,
  last_full_sync_at TEXT
);
CREATE TABLE device_settings (
  settings_key INTEGER PRIMARY KEY NOT NULL CHECK (settings_key = 1),
  device_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  workspace_gid TEXT NOT NULL,
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
${applicationJournalTableSql}
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
CREATE TABLE external_tool_definitions (
  tool_id TEXT PRIMARY KEY NOT NULL,
  definition_json TEXT NOT NULL,
  credential_reference_names_json TEXT NOT NULL
);
`;

interface TableNameRow {
  readonly name: string;
}

interface TableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface TableRowCount {
  readonly row_count: number;
}

interface ExpectedTableColumn {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly pk: number;
}

interface CleanupItemsCacheRow {
  readonly cache_key: number;
  readonly cleanup_items_json: string;
}

const applicationJournalV3Columns: readonly ExpectedTableColumn[] = [
  { name: "proposal_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "operation_id", type: "TEXT", notnull: 1, pk: 2 },
  { name: "new_task_uuid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "target_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "stage", type: "TEXT", notnull: 1, pk: 0 },
  { name: "final_result", type: "TEXT", notnull: 0, pk: 0 },
];

const applicationJournalV5Columns: readonly ExpectedTableColumn[] = [
  { name: "proposal_id", type: "TEXT", notnull: 1, pk: 1 },
  { name: "operation_id", type: "TEXT", notnull: 1, pk: 2 },
  { name: "new_task_uuid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "target_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "target_temporary_ref", type: "TEXT", notnull: 0, pk: 0 },
  { name: "started_at", type: "TEXT", notnull: 1, pk: 0 },
  { name: "stage", type: "TEXT", notnull: 1, pk: 0 },
  { name: "final_result", type: "TEXT", notnull: 0, pk: 0 },
  { name: "recovery_reason", type: "TEXT", notnull: 0, pk: 0 },
  { name: "group_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "group_order", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "operation_order", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "atomic", type: "INTEGER", notnull: 0, pk: 0 },
  { name: "project_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "workspace_gid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "section_gids_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "device_id", type: "TEXT", notnull: 0, pk: 0 },
  { name: "created_via", type: "TEXT", notnull: 0, pk: 0 },
  { name: "activity_date", type: "TEXT", notnull: 0, pk: 0 },
  { name: "temporary_ref_to_gid_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "baseline_source_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "operation_kind", type: "TEXT", notnull: 0, pk: 0 },
  { name: "operation_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "expected_before_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "expected_after_json", type: "TEXT", notnull: 0, pk: 0 },
  { name: "create_uuid", type: "TEXT", notnull: 0, pk: 0 },
  { name: "temporary_ref", type: "TEXT", notnull: 0, pk: 0 },
];

const applicationJournalV4ColumnsWithoutRecoveryReason =
  applicationJournalV5Columns.filter((column) => column.name !== "recovery_reason");

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

function readTableNames(database: SqliteDatabase): readonly string[] {
  const rows = database
    .prepare<[], TableNameRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

function assertStorageTableNames(tableNames: readonly string[]): void {
  const tableNameSet = new Set(tableNames);
  const expectedTableNameSet = new Set<string>(storageTableNames);
  if (
    tableNames.length !== storageTableNames.length
    || tableNames.some((tableName) => !expectedTableNameSet.has(tableName))
  ) {
    throw new Error("SQLiteに未対応の追加テーブルが存在します。");
  }
  storageTableNames.forEach((tableName) => {
    if (!tableNameSet.has(tableName)) {
      throw new Error(`SQLiteのテーブルが不足しています: ${tableName}`);
    }
  });
}

function readTableColumns(
  database: SqliteDatabase,
  tableName: string,
): readonly TableInfoRow[] {
  return database
    .prepare<[], TableInfoRow>(`PRAGMA table_info(${tableName})`)
    .all();
}

function hasExpectedTableColumns(
  actualColumns: readonly TableInfoRow[],
  expectedColumns: readonly ExpectedTableColumn[],
): boolean {
  return actualColumns.length === expectedColumns.length
    && actualColumns.every((column, index) => {
      const expectedColumn = expectedColumns[index];
      if (expectedColumn == null) {
        return false;
      }
      return column.cid === index
        && column.name === expectedColumn.name
        && column.type === expectedColumn.type
        && column.notnull === expectedColumn.notnull
        && column.dflt_value == null
        && column.pk === expectedColumn.pk;
    });
}

function assertTableColumns(
  database: SqliteDatabase,
  tableName: string,
  expectedColumns: readonly ExpectedTableColumn[],
): void {
  const actualColumns = readTableColumns(database, tableName);
  if (!hasExpectedTableColumns(actualColumns, expectedColumns)) {
    throw new Error(`SQLiteの${tableName}テーブル列が未対応です。`);
  }
}

function readTableRowCount(database: SqliteDatabase, tableName: string): number {
  const row = database
    .prepare<[], TableRowCount>(`SELECT COUNT(*) AS row_count FROM ${tableName}`)
    .get();
  if (
    row == null
    || !Number.isSafeInteger(row.row_count)
    || row.row_count < 0
  ) {
    throw new Error(`SQLiteの${tableName}テーブル行数を読み取れませんでした。`);
  }
  return row.row_count;
}

function assertTableRowCount(
  database: SqliteDatabase,
  tableName: string,
  expectedRowCount: number,
): void {
  if (readTableRowCount(database, tableName) !== expectedRowCount) {
    throw new Error(`SQLiteの${tableName}テーブル行数が移行前後で一致しません。`);
  }
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

function migrateSchemaFromV3(database: SqliteDatabase): void {
  const migrate = database.transaction(() => {
    assertStorageTableNames(readTableNames(database));
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV3Columns,
    );
    const sourceRowCount = readTableRowCount(database, "application_journal");
    migrateLegacyProposalConflictIdentifiers(database);
    database.exec(
      "ALTER TABLE application_journal RENAME TO application_journal_v3",
    );
    database.exec(applicationJournalTableSql);
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV5Columns,
    );
    database.exec(`
      INSERT INTO application_journal (
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        recovery_reason,
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      )
      SELECT
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        NULL,
        started_at,
        CASE WHEN final_result IS NULL THEN 'legacy_unresolved' ELSE stage END,
        final_result,
        CASE WHEN final_result IS NULL THEN 'recovery_context_missing' ELSE NULL END,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL
      FROM application_journal_v3;
    `);
    assertTableRowCount(database, "application_journal_v3", sourceRowCount);
    assertTableRowCount(database, "application_journal", sourceRowCount);
    database.exec("DROP TABLE application_journal_v3");
    assertStorageTableNames(readTableNames(database));
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV5Columns,
    );
    assertTableRowCount(database, "application_journal", sourceRowCount);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function migrateSchemaFromV4(database: SqliteDatabase): void {
  const migrate = database.transaction(() => {
    assertStorageTableNames(readTableNames(database));
    const sourceColumns = readTableColumns(database, "application_journal");
    const hasRecoveryReason = hasExpectedTableColumns(
      sourceColumns,
      applicationJournalV5Columns,
    );
    const hasNoRecoveryReason = hasExpectedTableColumns(
      sourceColumns,
      applicationJournalV4ColumnsWithoutRecoveryReason,
    );
    if (!hasRecoveryReason && !hasNoRecoveryReason) {
      throw new Error("SQLiteのapplication_journalテーブル列が未対応です。");
    }

    const sourceRowCount = readTableRowCount(database, "application_journal");
    migrateLegacyProposalConflictIdentifiers(database);
    database.exec(
      "ALTER TABLE application_journal RENAME TO application_journal_v4",
    );
    database.exec(applicationJournalTableSql);
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV5Columns,
    );
    const recoveryReasonProjection = hasRecoveryReason
      ? "recovery_reason"
      : "CASE WHEN stage = 'legacy_unresolved' THEN 'recovery_context_missing' ELSE NULL END";
    database.exec(`
      INSERT INTO application_journal (
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        recovery_reason,
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      )
      SELECT
        proposal_id,
        operation_id,
        new_task_uuid,
        target_gid,
        target_temporary_ref,
        started_at,
        stage,
        final_result,
        ${recoveryReasonProjection},
        group_id,
        group_order,
        operation_order,
        atomic,
        project_gid,
        workspace_gid,
        section_gids_json,
        device_id,
        created_via,
        activity_date,
        temporary_ref_to_gid_json,
        baseline_source_json,
        operation_kind,
        operation_json,
        expected_before_json,
        expected_after_json,
        create_uuid,
        temporary_ref
      FROM application_journal_v4;
    `);
    assertTableRowCount(database, "application_journal_v4", sourceRowCount);
    assertTableRowCount(database, "application_journal", sourceRowCount);
    database.exec("DROP TABLE application_journal_v4");
    assertStorageTableNames(readTableNames(database));
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV5Columns,
    );
    assertTableRowCount(database, "application_journal", sourceRowCount);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
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
      assertStorageTableNames(readTableNames(database));
      assertTableColumns(
        database,
        "application_journal",
        applicationJournalV5Columns,
      );
      database.pragma(`user_version = ${storageSchemaVersion}`);
    });
    createSchema();
    return;
  }

  if (userVersion === 3) {
    migrateSchemaFromV3(database);
    return;
  }

  if (userVersion === 4) {
    migrateSchemaFromV4(database);
    return;
  }

  if (userVersion !== storageSchemaVersion) {
    throw new Error(`未対応のSQLite schema versionです: ${userVersion}`);
  }

  assertStorageTableNames(tableNames);
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
      initializeSchema(database);
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
