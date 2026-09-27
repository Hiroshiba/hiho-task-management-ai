import BetterSqlite3 from "better-sqlite3";
import {
  assertSecurePersistentFileSnapshot,
  captureSecurePersistentFile,
  ensureSecurePersistentFile,
} from "./secure-file-snapshot";
import { PersistentTextFileHandle, type PersistentTextFile } from "./persistent-text-file";
import { normalizeSecurePersistentFilePath } from "./secure-path-guard";
import type { SqliteConnection } from "./sqlite-connection";
import { backupSqliteBeforeMigration } from "./sqlite-migration-backup";
import { initializeSqliteSchema } from "./sqlite-migration";

export const storageBusyTimeoutMilliseconds = 5_000;

const databaseFileLabel = "SQLiteデータベース";
const sqliteAuxiliaryFileSuffixes: readonly string[] = [
  "-journal",
  "-shm",
  "-wal",
];

function validateSqliteAuxiliaryFiles(dbPath: string): void {
  sqliteAuxiliaryFileSuffixes.forEach((suffix) => {
    captureSecurePersistentFile(
      `${dbPath}${suffix}`,
      `${databaseFileLabel}${suffix}`,
    );
  });
}

function closeDatabaseAfterInitializationFailure(
  database: BetterSqlite3.Database,
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

function assertPragmas(database: SqliteConnection): void {
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

/** SQLite接続と永続ファイルの生存期間を管理します。 */
export class PersistenceRuntime {
  private readonly database: BetterSqlite3.Database;
  public readonly migrationBackupPath: string | undefined;
  private readonly textFiles = new Set<PersistentTextFileHandle>();
  private readonly lateTextFiles = new Set<PersistentTextFileHandle>();

  public constructor(
    dbPath: string,
    migrateLegacyProposalConflictIdentifiers: (database: SqliteConnection) => void,
  ) {
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
    this.database = database;
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
      this.migrationBackupPath = backupSqliteBeforeMigration(database, normalizedDbPath);
      initializeSqliteSchema(
        database,
        (operation) => this.transaction(operation),
        migrateLegacyProposalConflictIdentifiers,
      );
      assertSecurePersistentFileSnapshot(
        normalizedDbPath,
        databaseSnapshot,
        databaseFileLabel,
      );
      validateSqliteAuxiliaryFiles(normalizedDbPath);
    } catch (error) {
      closeDatabaseAfterInitializationFailure(database, error);
    }
  }

  /** SQLite接続をSQL操作に渡します。 */
  public get connection(): SqliteConnection {
    return this.database;
  }

  /** SQLiteトランザクションを生成します。 */
  public transaction<Arguments extends unknown[], Result>(
    operation: (...args: Arguments) => Result,
  ): (...args: Arguments) => Result {
    return this.database.transaction(operation);
  }

  /** 永続テキストファイルを開きます。 */
  public openTextFile(filePath: string, label: string): PersistentTextFile {
    if (!this.database.open) {
      throw new Error("永続化ランタイムは終了しています。");
    }
    const file = new PersistentTextFileHandle(filePath, label);
    this.textFiles.add(file);
    return file;
  }

  /** Electronの終了直前まで使う永続テキストファイルを開きます。 */
  public openLateTextFile(filePath: string, label: string): PersistentTextFile {
    if (!this.database.open) {
      throw new Error("永続化ランタイムは終了しています。");
    }
    const file = new PersistentTextFileHandle(filePath, label);
    this.lateTextFiles.add(file);
    return file;
  }

  /** SQLite接続と通常の永続ファイルを閉じます。 */
  public close(): void {
    if (this.database.open) {
      this.database.close();
    }
    for (const file of this.textFiles) {
      file.close();
    }
    this.textFiles.clear();
  }

  /** Electronの終了直前まで使った永続ファイルを閉じます。 */
  public closeLateFiles(): void {
    for (const file of this.lateTextFiles) {
      file.close();
    }
    this.lateTextFiles.clear();
  }
}
