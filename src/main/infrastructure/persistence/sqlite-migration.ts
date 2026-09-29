import { z } from "zod";
import {
  asanaTaskResponseSchema,
  gidSchema,
  taskSchema,
  type AsanaTaskResponse,
  type Task,
} from "../../domain";
import type { TaskNormalizationBaseline } from "../../application/common/ports/task-read-repository";
import { setupSectionGidsSchema, type SetupSectionGids } from "../../domain/setup-state";
import type { SqliteConnection, SqliteTransaction } from "./sqlite-connection";
import {
  proposalExecutionColumns,
  proposalExecutionStepColumns,
  proposalExecutionTablesSql,
  proposalExecutionV6StepColumns,
} from "./proposal-execution-schema";
import {
  applicationJournalTableSql,
  applicationJournalV3Columns,
  applicationJournalV4ColumnsWithoutRecoveryReason,
  applicationJournalV5Columns,
  legacyApplicationHistoryColumns,
  legacyApplicationHistoryTableSql,
  pendingNormalizationBaselineColumns,
  pendingNormalizationBaselineTableSql,
  storageLegacyTableNames,
  storageSchemaSql,
  storageSchemaVersion,
  storageTableNames,
  storageV7TableNames,
  storageV9TableNames,
  type ExpectedTableColumn,
  type TableInfoRow,
  type TableNameRow,
  type TableRowCount,
} from "./sqlite-schema";

type SqliteDatabase = SqliteConnection;

type CleanupItemsCacheRow = {
  readonly cache_key: number;
  readonly cleanup_items_json: string;
};

type LegacyTaskCacheRow = {
  readonly gid: string;
  readonly asana_response_json: string;
  readonly task_json: string;
};

type LegacySectionSettingsRow = {
  readonly project_gid: string;
  readonly not_started_section_gid: string;
  readonly in_progress_section_gid: string;
  readonly completed_section_gid: string;
  readonly withdrawn_section_gid: string;
};

const legacyProposalConflictMessagePattern =
  /^AI変更案 (\S+) の操作 (\S+) は(?:適用されませんでした|適用結果を確定できません)。理由コードは \S+ です。$/u;

const legacyIdentifierSchema = z.string().refine(
  (value) => value.length > 0 && value.trim() === value && !/\s/u.test(value),
  "空白を含まない空でない識別子を指定してください。",
);
const legacyRelatedTaskGidsSchema = z.array(legacyIdentifierSchema).superRefine((gids, context) => {
  const seen = new Set<string>();
  gids.forEach((gid, index) => {
    if (seen.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "同じタスクGIDを重複して指定できません。",
      });
    }
    seen.add(gid);
  });
});
const legacyCleanupItemSchema = z.object({
  kind: z.enum([
    "importance_tag_conflict",
    "area_tag_conflict",
    "unknown_status_section",
    "missing_required_section",
    "dependency_cycle",
    "missing_dependency",
    "parent_cycle",
    "parent_relation_conflict",
    "children_only_completion_confirmation",
    "missing_task",
    "custom_external_data_broken",
    "oauth_app_mismatch",
    "proposal_conflict",
    "broken_vault_link",
  ]),
  message: z.string().refine((value) => value.trim().length > 0, {
    message: "要整理項目の説明を空にできません。",
  }),
  task_gid: legacyIdentifierSchema.optional(),
  proposal_id: legacyIdentifierSchema.optional(),
  operation_id: legacyIdentifierSchema.optional(),
  related_task_gids: legacyRelatedTaskGidsSchema.optional(),
}).strict();
const legacyCleanupItemsSchema = z.array(legacyCleanupItemSchema);

function readTableNames(database: SqliteDatabase): readonly string[] {
  const rows = database
    .prepare<[], TableNameRow>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  return rows.map((row) => row.name);
}

function assertStorageTableNames(
  tableNames: readonly string[],
  expectedTableNames: readonly string[],
): void {
  const tableNameSet = new Set(tableNames);
  const expectedTableNameSet = new Set(expectedTableNames);
  if (
    tableNames.length !== expectedTableNames.length
    || tableNames.some((tableName) => !expectedTableNameSet.has(tableName))
  ) {
    throw new Error("SQLiteに未対応の追加テーブルが存在します。");
  }
  expectedTableNames.forEach((tableName) => {
    if (!tableNameSet.has(tableName)) {
      throw new Error(`SQLiteのテーブルが不足しています: ${tableName}`);
    }
  });
}

function assertExecutionTableColumns(database: SqliteDatabase): void {
  assertTableColumns(database, "proposal_executions", proposalExecutionColumns);
  assertTableColumns(database, "proposal_execution_steps", proposalExecutionStepColumns);
}

function assertHistoryTableColumns(database: SqliteDatabase): void {
  assertTableColumns(database, "legacy_application_history", legacyApplicationHistoryColumns);
}

function createNormalizationBaselineTable(database: SqliteDatabase): void {
  database.exec(pendingNormalizationBaselineTableSql);
  assertTableColumns(database, "pending_normalization_baseline", pendingNormalizationBaselineColumns);
  migrateLegacyNormalizationBaseline(database);
}

function parseLegacyCacheJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("SQLiteに保存されたJSONの解析に失敗しました。", { cause: error });
  }
}

function isLegacyStatusUnavailable(
  task: Task,
  response: AsanaTaskResponse,
  projectGid: string,
  sectionGids: SetupSectionGids,
): boolean {
  const memberships = response.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    return true;
  }
  const section = memberships[0]?.section;
  if (section == null) {
    return true;
  }
  const configuredStatus = Object.entries(sectionGids).find(
    ([, sectionGid]) => sectionGid === section.gid,
  )?.[0];
  if (configuredStatus == null) {
    return true;
  }
  const expectedCompleted = configuredStatus === "completed" || configuredStatus === "withdrawn";
  return task.section_gid !== section.gid
    || task.completed !== response.completed
    || task.status !== configuredStatus
    || response.completed !== expectedCompleted;
}

function migrateLegacyNormalizationBaseline(database: SqliteDatabase): void {
  const settings = database.prepare<[], LegacySectionSettingsRow>(
    "SELECT project_gid, not_started_section_gid, in_progress_section_gid, completed_section_gid, withdrawn_section_gid FROM device_settings WHERE settings_key = 1",
  ).get();
  if (settings == null) {
    return;
  }
  const projectGid = gidSchema.parse(settings.project_gid);
  const sectionGids = setupSectionGidsSchema.parse({
    not_started: settings.not_started_section_gid,
    in_progress: settings.in_progress_section_gid,
    completed: settings.completed_section_gid,
    withdrawn: settings.withdrawn_section_gid,
  });
  const rows = database.prepare<[], LegacyTaskCacheRow>(
    "SELECT gid, asana_response_json, task_json FROM task_cache ORDER BY gid",
  ).all();
  let hasUnavailableStatus = false;
  const entries = rows.map((row) => {
    const gid = gidSchema.parse(row.gid);
    const task = taskSchema.parse(parseLegacyCacheJson(row.task_json));
    const response = asanaTaskResponseSchema.parse(
      parseLegacyCacheJson(row.asana_response_json),
    );
    if (task.gid !== gid || response.gid !== gid) {
      throw new Error("旧タスクキャッシュのGIDが保存行と一致しません。");
    }
    const unavailable = isLegacyStatusUnavailable(task, response, projectGid, sectionGids);
    hasUnavailableStatus ||= unavailable;
    return {
      gid,
      previous: unavailable
        ? { kind: "status_unavailable", task }
        : { kind: "present", task },
    } satisfies Extract<TaskNormalizationBaseline, { readonly kind: "pending" }>["entries"][number];
  });
  if (!hasUnavailableStatus) {
    return;
  }
  const serializedEntries = JSON.stringify(entries);
  if (serializedEntries === undefined) {
    throw new Error("SQLite保存用JSONの変換に失敗しました。");
  }
  database.prepare<[string, string]>(
    "INSERT INTO pending_normalization_baseline (project_gid, entries_json) VALUES (?, ?)",
  ).run(projectGid, serializedEntries);
}

function createHistoryTable(database: SqliteDatabase): void {
  database.exec(legacyApplicationHistoryTableSql);
  assertHistoryTableColumns(database);
}

function createExecutionTables(database: SqliteDatabase): void {
  database.exec(proposalExecutionTablesSql);
  createHistoryTable(database);
  createNormalizationBaselineTable(database);
  assertStorageTableNames(readTableNames(database), storageTableNames);
  assertExecutionTableColumns(database);
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

function migrateLegacyProposalConflictIdentifiers(database: SqliteDatabase): void {
  const sourceRowCount = readTableRowCount(database, "cleanup_items_cache");
  const rows = database.prepare<[], CleanupItemsCacheRow>(
    "SELECT cache_key, cleanup_items_json FROM cleanup_items_cache ORDER BY cache_key",
  ).all();
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.cleanup_items_json);
    } catch (error) {
      throw new Error("SQLiteに保存されたJSONの解析に失敗しました。", { cause: error });
    }
    const items = legacyCleanupItemsSchema.parse(parsed);
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
      const validatedItem = legacyCleanupItemSchema.safeParse({
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

    const validatedItems = legacyCleanupItemsSchema.parse(migratedItems);
    const serializedItems = JSON.stringify(validatedItems);
    if (serializedItems === undefined) {
      throw new Error("SQLite保存用JSONの変換に失敗しました。");
    }
    const updateResult = updateStatement.run(serializedItems, row.cache_key);
    if (updateResult.changes !== 1) {
      throw new Error("要整理キャッシュの移行対象が見つかりません。");
    }
  });
  assertTableRowCount(database, "cleanup_items_cache", sourceRowCount);
}

function migrateSchemaFromV3(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageLegacyTableNames);
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
    assertStorageTableNames(readTableNames(database), storageLegacyTableNames);
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV5Columns,
    );
    assertTableRowCount(database, "application_journal", sourceRowCount);
    createExecutionTables(database);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function migrateSchemaFromV4(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageLegacyTableNames);
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
    assertStorageTableNames(readTableNames(database), storageLegacyTableNames);
    assertTableColumns(
      database,
      "application_journal",
      applicationJournalV5Columns,
    );
    assertTableRowCount(database, "application_journal", sourceRowCount);
    createExecutionTables(database);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function migrateSchemaFromV5(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageLegacyTableNames);
    assertTableColumns(database, "application_journal", applicationJournalV5Columns);
    const sourceRowCount = readTableRowCount(database, "application_journal");
    createExecutionTables(database);
    assertTableRowCount(database, "application_journal", sourceRowCount);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function migrateSchemaFromV6(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageV7TableNames);
    assertTableColumns(database, "application_journal", applicationJournalV5Columns);
    assertTableColumns(database, "proposal_executions", proposalExecutionColumns);
    assertTableColumns(database, "proposal_execution_steps", proposalExecutionV6StepColumns);
    database.exec("ALTER TABLE proposal_execution_steps ADD COLUMN sync_error_code TEXT");
    assertExecutionTableColumns(database);
    createHistoryTable(database);
    createNormalizationBaselineTable(database);
    assertStorageTableNames(readTableNames(database), storageTableNames);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function migrateSchemaFromV7(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageV7TableNames);
    assertTableColumns(database, "application_journal", applicationJournalV5Columns);
    assertExecutionTableColumns(database);
    createHistoryTable(database);
    createNormalizationBaselineTable(database);
    assertStorageTableNames(readTableNames(database), storageTableNames);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function migrateSchemaFromV8(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageV9TableNames);
    assertTableColumns(database, "application_journal", applicationJournalV5Columns);
    assertExecutionTableColumns(database);
    assertHistoryTableColumns(database);
    rebuildHistoryTable(database);
    createNormalizationBaselineTable(database);
    assertStorageTableNames(readTableNames(database), storageTableNames);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function rebuildHistoryTable(database: SqliteDatabase): void {
  const sourceCount = readTableRowCount(database, "legacy_application_history");
  database.exec("ALTER TABLE legacy_application_history RENAME TO legacy_application_history_previous");
  createHistoryTable(database);
  database.exec(`INSERT INTO legacy_application_history
    SELECT * FROM legacy_application_history_previous`);
  assertTableRowCount(database, "legacy_application_history", sourceCount);
  database.exec("DROP TABLE legacy_application_history_previous");
}

function migrateSchemaFromV9(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
): void {
  const migrate = transaction(() => {
    assertStorageTableNames(readTableNames(database), storageV9TableNames);
    assertTableColumns(database, "application_journal", applicationJournalV5Columns);
    assertExecutionTableColumns(database);
    assertHistoryTableColumns(database);
    rebuildLegacyHistoryTableIfRequired(database);
    createNormalizationBaselineTable(database);
    assertStorageTableNames(readTableNames(database), storageTableNames);
    database.pragma(`user_version = ${storageSchemaVersion}`);
  });
  migrate();
}

function rebuildLegacyHistoryTableIfRequired(database: SqliteDatabase): void {
  const historyTable = database.prepare<[], { readonly sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'legacy_application_history'",
  ).get();
  if (historyTable?.sql == null) {
    throw new Error("旧適用履歴テーブルの定義を読み取れません。");
  }
  if (!historyTable.sql.includes("source_schema_version BETWEEN 3 AND 8")) {
    if (!historyTable.sql.includes("source_schema_version BETWEEN 3 AND 7")) {
      throw new Error("旧適用履歴テーブルの出所版制約が未対応です。");
    }
    rebuildHistoryTable(database);
  }
}

/** SQLiteの保存形式を初期化し、既存データを現行形式へ移行します。 */
export function initializeSqliteSchema(
  database: SqliteDatabase,
  transaction: SqliteTransaction,
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
      assertStorageTableNames(readTableNames(database), storageTableNames);
      assertTableColumns(
        database,
        "application_journal",
        applicationJournalV5Columns,
      );
      assertExecutionTableColumns(database);
      assertHistoryTableColumns(database);
      assertTableColumns(database, "pending_normalization_baseline", pendingNormalizationBaselineColumns);
      database.pragma(`user_version = ${storageSchemaVersion}`);
    });
    createSchema();
    return;
  }

  if (userVersion === 3) {
    migrateSchemaFromV3(database, transaction);
    return;
  }

  if (userVersion === 4) {
    migrateSchemaFromV4(database, transaction);
    return;
  }

  if (userVersion === 5) {
    migrateSchemaFromV5(database, transaction);
    return;
  }

  if (userVersion === 6) {
    migrateSchemaFromV6(database, transaction);
    return;
  }

  if (userVersion === 7) {
    migrateSchemaFromV7(database, transaction);
    return;
  }

  if (userVersion === 8) {
    migrateSchemaFromV8(database, transaction);
    return;
  }

  if (userVersion === 9) {
    migrateSchemaFromV9(database, transaction);
    return;
  }

  if (userVersion !== storageSchemaVersion) {
    throw new Error(`未対応のSQLite schema versionです: ${userVersion}`);
  }

  assertStorageTableNames(tableNames, storageTableNames);
  assertTableColumns(database, "application_journal", applicationJournalV5Columns);
  assertExecutionTableColumns(database);
  assertHistoryTableColumns(database);
  assertTableColumns(database, "pending_normalization_baseline", pendingNormalizationBaselineColumns);
  transaction(() => rebuildLegacyHistoryTableIfRequired(database))();
}
