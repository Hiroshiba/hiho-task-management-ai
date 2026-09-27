import type { SqliteConnection, SqliteTransaction } from "./sqlite-connection";
import {
  applicationJournalTableSql,
  applicationJournalV3Columns,
  applicationJournalV4ColumnsWithoutRecoveryReason,
  applicationJournalV5Columns,
  storageSchemaSql,
  storageSchemaVersion,
  storageTableNames,
  type ExpectedTableColumn,
  type TableInfoRow,
  type TableNameRow,
  type TableRowCount,
} from "./sqlite-schema";

type SqliteDatabase = SqliteConnection;
type MigrateLegacyCleanupIdentifiers = (database: SqliteDatabase) => void;

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

/** SQLiteテーブルの行数を検証して読み出します。 */
export function readTableRowCount(database: SqliteDatabase, tableName: string): number {
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

/** SQLiteテーブルの行数が移行前後で等しいことを検証します。 */
export function assertTableRowCount(
  database: SqliteDatabase,
  tableName: string,
  expectedRowCount: number,
): void {
  if (readTableRowCount(database, tableName) !== expectedRowCount) {
    throw new Error(`SQLiteの${tableName}テーブル行数が移行前後で一致しません。`);
  }
}

function migrateSchemaFromV3(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
  migrateLegacyProposalConflictIdentifiers: MigrateLegacyCleanupIdentifiers,
): void {
  const migrate = transaction(() => {
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

function migrateSchemaFromV4(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
  migrateLegacyProposalConflictIdentifiers: MigrateLegacyCleanupIdentifiers,
): void {
  const migrate = transaction(() => {
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

/** SQLiteの保存形式を初期化し、既存データを現行形式へ移行します。 */
export function initializeSqliteSchema(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
  migrateLegacyProposalConflictIdentifiers: MigrateLegacyCleanupIdentifiers,
): void {
  const userVersion = database.pragma("user_version", { simple: true });
  if (typeof userVersion !== "number" || !Number.isInteger(userVersion)) {
    throw new Error("SQLiteのschema versionを読み取れませんでした。");
  }

  const tableNames = readTableNames(database);
  if (userVersion === 0) {
    if (tableNames.length !== 0) {
      throw new Error("SQLiteに未対応のschemaが存在します。");
    }

    const createSchema = transaction(() => {
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
    migrateSchemaFromV3(database, transaction, migrateLegacyProposalConflictIdentifiers);
    return;
  }

  if (userVersion === 4) {
    migrateSchemaFromV4(database, transaction, migrateLegacyProposalConflictIdentifiers);
    return;
  }

  if (userVersion !== storageSchemaVersion) {
    throw new Error(`未対応のSQLite schema versionです: ${userVersion}`);
  }

  assertStorageTableNames(tableNames);
}
