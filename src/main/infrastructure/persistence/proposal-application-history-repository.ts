import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import {
  historyRowSchema,
  legacyRowSchema,
  parseLegacyHistoryStep,
  parseLegacyStep,
  parseOriginalLegacyRow,
} from "./proposal-application-history-record";
import type { PersistenceRuntime } from "./persistence-runtime";

export type LegacyMigrationFailure = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly reason: "invalid_source" | "conflicting_history" | "missing_backup" | "missing_backup_row";
};
export type LegacyMigrationSummary = {
  readonly source_count: number;
  readonly migrated_count: number;
  readonly already_migrated_count: number;
  readonly failures: readonly LegacyMigrationFailure[];
};

type SourceKey = { readonly proposal_id: string; readonly operation_id: string };
type ChangeResult = { readonly changes: number };

function fingerprint(snapshot: string): string {
  return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

/** 旧行を版付き非実行履歴へ1件ずつ原子的かつ冪等に移します。 */
export class SqliteLegacyProposalHistoryRepository {
  public constructor(private readonly runtime: PersistenceRuntime) {}

  /** 出所と内容を照合し、履歴再読込後に限って元の旧行を削除します。 */
  public migrate(): LegacyMigrationSummary {
    const keys = this.runtime.connection.prepare<[], SourceKey>(
      "SELECT proposal_id, operation_id FROM application_journal ORDER BY proposal_id, operation_id",
    ).all();
    if (keys.length === 0) {
      return { source_count: 0, migrated_count: 0, already_migrated_count: 0, failures: [] };
    }
    const backupPath = this.runtime.migrationBackupPath;
    if (backupPath == null) {
      return {
        source_count: keys.length,
        migrated_count: 0,
        already_migrated_count: 0,
        failures: keys.map((key) => ({ ...key, reason: "missing_backup" })),
      };
    }
    const backup = new BetterSqlite3(backupPath, { readonly: true, fileMustExist: true });
    try {
      const backupVersion = backup.pragma("user_version", { simple: true });
      if (typeof backupVersion !== "number" || !Number.isInteger(backupVersion)
        || backupVersion < 3 || backupVersion > 7) {
        throw new Error("旧適用履歴の移行前バックアップの版が未対応です。");
      }
      let migratedCount = 0;
      let alreadyMigratedCount = 0;
      const failures: LegacyMigrationFailure[] = [];
      for (const key of keys) {
        const source = this.runtime.connection.prepare<[string, string], unknown>(
          "SELECT * FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
        ).get(key.proposal_id, key.operation_id);
        if (source == null) {
          throw new Error("移行対象の旧適用ジャーナルが消失しました。");
        }
        const backupSource = backup.prepare<[string, string], unknown>(
          "SELECT * FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
        ).get(key.proposal_id, key.operation_id);
        if (backupSource == null) {
          failures.push({ ...key, reason: "missing_backup_row" });
          continue;
        }
        const currentValidation = legacyRowSchema.safeParse(source);
        if (!currentValidation.success) {
          failures.push({ ...key, reason: "invalid_source" });
          continue;
        }
        let original: ReturnType<typeof parseOriginalLegacyRow>;
        try {
          original = parseOriginalLegacyRow(backupSource, backupVersion);
          parseLegacyStep(original.normalized);
        } catch {
          failures.push({ ...key, reason: "invalid_source" });
          continue;
        }
        if (JSON.stringify(currentValidation.data) !== JSON.stringify(original.normalized)) {
          const existing = this.runtime.connection.prepare<[string, string], SourceKey>(
            "SELECT proposal_id, operation_id FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
          ).get(key.proposal_id, key.operation_id);
          failures.push({ ...key, reason: existing == null ? "invalid_source" : "conflicting_history" });
          continue;
        }
        const currentSnapshot = JSON.stringify(source);
        const snapshot = JSON.stringify(backupSource);
        const hash = fingerprint(snapshot);
        const migrateOne = this.runtime.transaction(() => {
          const current = this.runtime.connection.prepare<[string, string], unknown>(
            "SELECT * FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
          ).get(key.proposal_id, key.operation_id);
          if (JSON.stringify(current) !== currentSnapshot) {
            throw new Error("移行中に旧適用ジャーナルの内容が変化しました。");
          }
          const existing = this.runtime.connection.prepare<[string, string], unknown>(
            "SELECT * FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
          ).get(key.proposal_id, key.operation_id);
          if (existing != null) {
            const history = historyRowSchema.safeParse(existing);
            if (!history.success || history.data.source_schema_version !== backupVersion
              || history.data.snapshot_sha256 !== hash
              || history.data.snapshot_json !== snapshot) {
              return "conflicting_history";
            }
            try {
              parseLegacyHistoryStep(existing);
            } catch {
              return "conflicting_history";
            }
          } else {
            this.runtime.connection.prepare<[
              string, string, number, string, string | null, string | null, string, string, string,
            ], ChangeResult>(`INSERT INTO legacy_application_history (
              proposal_id, operation_id, format_version, source_schema_version,
              source_stage, source_final_result,
              source_recovery_reason, confirmation_state, confirmed_result, snapshot_json, snapshot_sha256
            ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
              key.proposal_id,
              key.operation_id,
              backupVersion,
              original.source_stage,
              original.source_final_result,
              original.source_recovery_reason,
              original.source_final_result == null || original.source_final_result === "unknown"
                ? "required" : "not_required",
              snapshot,
              hash,
            );
          }
          const reread = this.runtime.connection.prepare<[string, string], unknown>(
            "SELECT * FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
          ).get(key.proposal_id, key.operation_id);
          const history = historyRowSchema.parse(reread);
          if (history.source_schema_version !== backupVersion
            || history.snapshot_json !== snapshot || history.snapshot_sha256 !== hash) {
            throw new Error("旧適用履歴の再読込内容が元データと一致しません。");
          }
          parseLegacyHistoryStep(reread);
          const historyCount = this.runtime.connection.prepare<[string, string], { readonly row_count: number }>(
            "SELECT COUNT(*) AS row_count FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
          ).get(key.proposal_id, key.operation_id);
          if (historyCount?.row_count !== 1) {
            throw new Error("旧適用履歴の保存件数が一致しません。");
          }
          const deleted = this.runtime.connection.prepare<[string, string], ChangeResult>(
            "DELETE FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
          ).run(key.proposal_id, key.operation_id);
          if (deleted.changes !== 1) {
            throw new Error("移行元の旧適用ジャーナルを1件だけ削除できません。");
          }
          return existing == null ? "migrated" : "already_migrated";
        });
        const result = migrateOne();
        if (result === "conflicting_history") {
          failures.push({ ...key, reason: result });
        } else if (result === "already_migrated") {
          alreadyMigratedCount += 1;
        } else {
          migratedCount += 1;
        }
      }
      if (migratedCount + alreadyMigratedCount + failures.length !== keys.length) {
        throw new Error("旧適用ジャーナルの移行件数が元の件数と一致しません。");
      }
      return {
        source_count: keys.length,
        migrated_count: migratedCount,
        already_migrated_count: alreadyMigratedCount,
        failures,
      };
    } finally {
      backup.close();
    }
  }
}
