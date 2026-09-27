import { statSync } from "node:fs";
import BetterSqlite3 from "better-sqlite3";
import {
  assertSecurePersistentFileSnapshot,
  captureSecurePersistentFile,
  ensureSecurePersistentFile,
} from "./secure-file-snapshot";
import type { SqliteConnection } from "./sqlite-connection";
import { readTableRowCount } from "./sqlite-migration";

type IntegrityRow = { readonly integrity_check: string };
type TableNameRow = { readonly name: string };

function tableNames(database: SqliteConnection): readonly string[] {
  return database.prepare<[], TableNameRow>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
}

function assertBackupMatchesSource(
  source: SqliteConnection,
  backup: SqliteConnection,
  version: number,
): void {
  if (backup.pragma("user_version", { simple: true }) !== version) {
    throw new Error("移行前バックアップのschema versionが元データと一致しません。");
  }
  const sourceTables = tableNames(source);
  const backupTables = tableNames(backup);
  if (JSON.stringify(sourceTables) !== JSON.stringify(backupTables)) {
    throw new Error("移行前バックアップのテーブルが元データと一致しません。");
  }
  for (const tableName of sourceTables) {
    if (readTableRowCount(source, tableName) !== readTableRowCount(backup, tableName)) {
      throw new Error(`移行前バックアップの${tableName}件数が元データと一致しません。`);
    }
  }
  const sourceRows = source.prepare<[], unknown>(
    "SELECT * FROM application_journal ORDER BY proposal_id, operation_id",
  ).all();
  const backupRows = backup.prepare<[], unknown>(
    "SELECT * FROM application_journal ORDER BY proposal_id, operation_id",
  ).all();
  if (JSON.stringify(sourceRows) !== JSON.stringify(backupRows)) {
    throw new Error("移行前バックアップの旧適用ジャーナルが元データと一致しません。");
  }
  if (version === 8) {
    const sourceHistory = source.prepare<[], unknown>(
      "SELECT * FROM legacy_application_history ORDER BY proposal_id, operation_id",
    ).all();
    const backupHistory = backup.prepare<[], unknown>(
      "SELECT * FROM legacy_application_history ORDER BY proposal_id, operation_id",
    ).all();
    if (JSON.stringify(sourceHistory) !== JSON.stringify(backupHistory)) {
      throw new Error("移行前バックアップの旧適用履歴が元データと一致しません。");
    }
  }
}

function assertBackupReadable(backup: SqliteConnection): void {
  const version = backup.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version) || version < 3 || version > 8) {
    throw new Error("移行前バックアップのschema versionを確認できません。");
  }
  const integrity = backup.prepare<[], IntegrityRow>("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") {
    throw new Error("移行前バックアップの整合性を確認できません。");
  }
}

/** WALの確定済み内容を移行前の所有者限定SQLiteファイルへ保存します。 */
export function backupSqliteBeforeMigration(
  source: BetterSqlite3.Database,
  dbPath: string,
): string | undefined {
  const version = source.pragma("user_version", { simple: true });
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error("移行前のSQLite schema versionを読み取れません。");
  }
  if (version === 0) return undefined;
  if (version < 3 || version > 9) {
    throw new Error(`未対応のSQLite schema versionです: ${version}`);
  }
  if (version === 8) {
    const preV9Path = `${dbPath}.pre-v9.backup.sqlite3`;
    const preV9Existing = captureSecurePersistentFile(preV9Path, "SQLite v9移行前バックアップ");
    const preV9Snapshot = preV9Existing.kind === "existing"
      ? preV9Existing
      : ensureSecurePersistentFile(preV9Path, "SQLite v9移行前バックアップ");
    if (statSync(preV9Path).size === 0) {
      source.prepare<[string]>("VACUUM INTO ?").run(preV9Path);
    }
    assertSecurePersistentFileSnapshot(preV9Path, preV9Snapshot, "SQLite v9移行前バックアップ");
    const preV9 = new BetterSqlite3(preV9Path, { readonly: true, fileMustExist: true });
    try {
      assertBackupReadable(preV9);
      assertBackupMatchesSource(source, preV9, version);
    } finally {
      preV9.close();
    }
  }
  const backupPath = `${dbPath}.pre-v8.backup.sqlite3`;
  const existing = captureSecurePersistentFile(backupPath, "SQLite移行前バックアップ");
  if (version >= 8 && existing.kind === "missing") return undefined;
  const snapshot = version >= 8 || existing.kind === "existing"
    ? existing
    : ensureSecurePersistentFile(backupPath, "SQLite移行前バックアップ");
  if (version < 8 && statSync(backupPath).size === 0) {
    source.prepare<[string]>("VACUUM INTO ?").run(backupPath);
  }
  assertSecurePersistentFileSnapshot(backupPath, snapshot, "SQLite移行前バックアップ");
  const backup = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true });
  try {
    assertBackupReadable(backup);
    if (version < 8) assertBackupMatchesSource(source, backup, version);
  } finally {
    backup.close();
  }
  assertSecurePersistentFileSnapshot(backupPath, snapshot, "SQLite移行前バックアップ");
  return backupPath;
}
