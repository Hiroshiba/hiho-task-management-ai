import type { SqliteConnection } from "./sqlite-connection";
import type { PersistenceRuntime } from "./persistence-runtime";

type DiagnosticLogRecord = {
  readonly occurred_at: string;
  readonly severity: string;
  readonly code: string;
  readonly http_status?: number | undefined;
  readonly asana_gid?: string | undefined;
  readonly proposal_id?: string | undefined;
  readonly operation_id?: string | undefined;
  readonly app_version?: string | undefined;
  readonly codex_version?: string | undefined;
};

interface DiagnosticLogRow {
  readonly id: number;
  readonly occurred_at: string;
  readonly severity: string;
  readonly code: string;
  readonly http_status: number | null;
  readonly asana_gid: string | null;
  readonly proposal_id: string | null;
  readonly operation_id: string | null;
  readonly app_version: string | null;
  readonly codex_version: string | null;
}

function validateRetentionLimit(retentionLimit: number): void {
  if (!Number.isInteger(retentionLimit) || retentionLimit < 1) {
    throw new Error("診断ログの保持上限件数は1以上の整数で指定してください。");
  }
}

function rowToDiagnosticLogEntry<Entry extends DiagnosticLogRecord>(
  row: DiagnosticLogRow,
  parseEntry: (value: unknown) => Entry,
): Entry {
  const entry = {
    occurred_at: row.occurred_at,
    severity: row.severity,
    code: row.code,
    ...(row.http_status == null ? {} : { http_status: row.http_status }),
    ...(row.asana_gid == null ? {} : { asana_gid: row.asana_gid }),
    ...(row.proposal_id == null ? {} : { proposal_id: row.proposal_id }),
    ...(row.operation_id == null ? {} : { operation_id: row.operation_id }),
    ...(row.app_version == null ? {} : { app_version: row.app_version }),
    ...(row.codex_version == null ? {} : { codex_version: row.codex_version }),
  };
  return parseEntry(entry);
}

/** 構造化診断ログのSQLite操作を提供します。 */
export class SqliteDiagnosticLogRepository<Entry extends DiagnosticLogRecord> {
  private readonly deleteOlderStatement;
  private readonly insertStatement;
  private readonly selectAllStatement;

  public constructor(
    database: SqliteConnection,
    private readonly runtime: PersistenceRuntime,
    private readonly parseEntry: (value: unknown) => Entry,
  ) {
    this.insertStatement = database.prepare<
      [string, string, string, number | null, string | null, string | null, string | null, string | null, string | null],
      unknown
    >(
      "INSERT INTO diagnostic_log (occurred_at, severity, code, http_status, asana_gid, proposal_id, operation_id, app_version, codex_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.deleteOlderStatement = database.prepare<[number]>(
      "DELETE FROM diagnostic_log WHERE id NOT IN (SELECT id FROM diagnostic_log ORDER BY id DESC LIMIT ?)",
    );
    this.selectAllStatement = database.prepare<[], DiagnosticLogRow>(
      "SELECT id, occurred_at, severity, code, http_status, asana_gid, proposal_id, operation_id, app_version, codex_version FROM diagnostic_log ORDER BY id",
    );
  }

  /** 構造化診断ログを追加し、保持上限を超えた古い行を削除します。 */
  public appendDiagnosticLog(entry: Entry, retentionLimit: number): void {
    const validatedEntry = this.parseEntry(entry);
    validateRetentionLimit(retentionLimit);
    const append = this.runtime.transaction(() => {
      this.insertStatement.run(
        validatedEntry.occurred_at,
        validatedEntry.severity,
        validatedEntry.code,
        validatedEntry.http_status == null ? null : validatedEntry.http_status,
        validatedEntry.asana_gid == null ? null : validatedEntry.asana_gid,
        validatedEntry.proposal_id == null ? null : validatedEntry.proposal_id,
        validatedEntry.operation_id == null ? null : validatedEntry.operation_id,
        validatedEntry.app_version == null ? null : validatedEntry.app_version,
        validatedEntry.codex_version == null ? null : validatedEntry.codex_version,
      );
      this.deleteOlderStatement.run(retentionLimit);
    });
    append();
  }

  /** 構造化診断ログを全件読み出します。 */
  public getDiagnosticLogs(): readonly Entry[] {
    return this.selectAllStatement.all().map((row) =>
      rowToDiagnosticLogEntry(row, this.parseEntry));
  }
}
