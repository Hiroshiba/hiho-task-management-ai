import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import type { ErrorReporter } from "../../application/common/errors/error-reporter";
import type {
  ProposalApplicationHistory,
  ProposalApplicationHistoryRead,
  ProposalApplicationHistoryRepository,
  ProposalApplicationHistoryStep,
} from "../../application/common/ports/proposal-application-history";
import {
  historyRowSchema,
  legacyRowSchema,
  parseLegacyHistoryStep,
  parseLegacyStep,
  parseOriginalLegacyRow,
} from "./proposal-application-history-record";
import { identifierSchema } from "../../domain/primitives";
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
type ProposalIdRow = { readonly proposal_id: string };
type ChangeResult = { readonly changes: number };
type ConfirmedResult = "applied" | "not_applied" | "manually_adjusted";

function fingerprint(snapshot: string): string {
  return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

type BackupRow =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "valid";
      readonly original: ReturnType<typeof parseOriginalLegacyRow>;
      readonly snapshot: string;
      readonly version: number;
    };

function readBackupRow(
  backup: BetterSqlite3.Database | undefined,
  version: number | undefined,
  key: SourceKey,
): BackupRow {
  if (backup == null || version == null) return { kind: "missing" };
  const value = backup.prepare<[string, string], unknown>(
    "SELECT * FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
  ).get(key.proposal_id, key.operation_id);
  if (value == null) return { kind: "missing" };
  try {
    const original = parseOriginalLegacyRow(value, version);
    parseLegacyStep(original.normalized);
    return { kind: "valid", original, snapshot: JSON.stringify(value), version };
  } catch {
    return { kind: "invalid" };
  }
}

/** 旧行を版付き非実行履歴へ移し、履歴だけを復旧表示へ読み出します。 */
export class SqliteProposalApplicationHistoryRepository implements ProposalApplicationHistoryRepository {
  private readonly rejectionIds = new Map<string, string>();

  public constructor(
    private readonly runtime: PersistenceRuntime,
    private readonly reporter: ErrorReporter,
  ) {}

  private reject(key: SourceKey, cause: unknown): ProposalApplicationHistoryRead {
    const cacheKey = `${key.proposal_id}\u0000${key.operation_id}`;
    let errorId = this.rejectionIds.get(cacheKey);
    if (errorId == null) {
      errorId = this.reporter.reportErrorOnce(new Error("旧適用履歴を検証できません。", { cause }), {
        source: "service",
        diagnosticCode: "proposal.application",
        context: "diagnostic_storage",
        level: "error",
        operationId: key.operation_id,
      });
      this.rejectionIds.set(cacheKey, errorId);
    }
    return { kind: "rejected", ...key, error_id: errorId };
  }

  private getHistoryByProposal(proposalId: string): ProposalApplicationHistoryRead | undefined {
    const rows = this.runtime.connection.prepare<[string], unknown>(
      "SELECT * FROM legacy_application_history WHERE proposal_id = ? ORDER BY operation_id",
    ).all(proposalId);
    if (rows.length === 0) return undefined;
    const steps: ProposalApplicationHistoryStep[] = [];
    for (const value of rows) {
      const key = z.object({ proposal_id: identifierSchema, operation_id: identifierSchema }).parse(value);
      try {
        steps.push(parseLegacyHistoryStep(value));
      } catch (error) {
        return this.reject(key, error);
      }
    }
    steps.sort((left, right) => {
      if (left.operation_order == null && right.operation_order != null) return 1;
      if (left.operation_order != null && right.operation_order == null) return -1;
      return (left.operation_order ?? 0) - (right.operation_order ?? 0)
        || left.started_at.localeCompare(right.started_at)
        || left.operation_id.localeCompare(right.operation_id);
    });
    const state: ProposalApplicationHistory["state"] = steps.some(
      (step) => step.state === "confirmation_required",
    ) ? "confirmation_required" : steps.some(
      (step) => step.state === "synchronization_required",
    ) ? "synchronization_required" : steps.some(
      (step) => step.state === "failed",
    ) ? "failed" : "succeeded";
    return { kind: "history", history: { proposal_id: proposalId, state, steps } };
  }

  /** 指定proposalの移行済み非実行履歴を読み出します。 */
  public getByProposal(proposalId: string): ProposalApplicationHistoryRead | undefined {
    return this.getHistoryByProposal(identifierSchema.parse(proposalId));
  }

  /** 未確認または破損した非実行履歴を読み出します。 */
  public getIncomplete(): readonly ProposalApplicationHistoryRead[] {
    const proposals = this.runtime.connection.prepare<[], ProposalIdRow>(
      "SELECT DISTINCT proposal_id FROM legacy_application_history ORDER BY proposal_id",
    ).all();
    const histories = proposals.map((row) => {
      const result = this.getHistoryByProposal(row.proposal_id);
      if (result == null) throw new Error("保存済み旧適用履歴を読み出せません。");
      return result;
    });
    return histories.filter((result) => result.kind === "rejected"
      || result.history.state === "confirmation_required"
      || result.history.state === "synchronization_required");
  }

  /** 移行されていない旧行が残る起動を拒否します。 */
  public assertNoUnmigratedJournals(): void {
    const count = this.runtime.connection.prepare<[], { readonly row_count: number }>(
      "SELECT COUNT(*) AS row_count FROM application_journal",
    ).get();
    if (count == null) throw new Error("旧適用ジャーナルの残存件数を読み取れません。");
    if (count.row_count > 0) {
      throw new Error(`旧適用ジャーナルが${count.row_count}件残っています。履歴移行を完了できないため起動を停止します。`);
    }
  }

  /** Asana実状態を確認した対象と結果を旧履歴へ比較更新します。 */
  public confirm(
    proposalId: string,
    operationId: string,
    checkedTargetId: string,
    confirmedResult: ConfirmedResult,
  ): "confirmed" | "already_confirmed" {
    const proposal = identifierSchema.parse(proposalId);
    const operation = identifierSchema.parse(operationId);
    const target = identifierSchema.parse(checkedTargetId);
    const result = historyRowSchema.shape.confirmed_result.unwrap().parse(confirmedResult);
    const confirmOne = this.runtime.transaction(() => {
      const residual = this.runtime.connection.prepare<[string, string], SourceKey>(
        "SELECT proposal_id, operation_id FROM application_journal WHERE proposal_id = ? AND operation_id = ?",
      ).get(proposal, operation);
      if (residual != null) {
        throw new Error("移行できない旧適用ジャーナルは確認操作で解除できません。");
      }
      const value = this.runtime.connection.prepare<[string, string], unknown>(
        "SELECT * FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
      ).get(proposal, operation);
      if (value == null) {
        throw new Error("確認対象の旧適用履歴がありません。");
      }
      const row = historyRowSchema.parse(value);
      const step = parseLegacyHistoryStep(row);
      const actualTargetId = step.target.kind === "task" ? step.target.gid
        : step.target.kind === "new_task" ? step.target.uuid : step.target.ref;
      if (target !== actualTargetId) {
        throw new Error("確認した対象IDが旧適用履歴の対象と一致しません。");
      }
      if (row.confirmation_state === "confirmed" || row.confirmation_state === "synchronized") {
        if (row.confirmed_result !== result) {
          throw new Error("旧適用履歴には別の確認結果が保存されています。");
        }
        return "already_confirmed";
      }
      if (row.confirmation_state !== "required") {
        throw new Error("結果が確定済みの旧適用履歴は確認できません。");
      }
      const update = this.runtime.connection.prepare<[
        ConfirmedResult, string, string,
      ], ChangeResult>(`UPDATE legacy_application_history
        SET confirmation_state = 'confirmed', confirmed_result = ?
        WHERE proposal_id = ? AND operation_id = ?
          AND confirmation_state = 'required' AND confirmed_result IS NULL`).run(result, proposal, operation);
      if (update.changes !== 1) {
        throw new Error("旧適用履歴の確認状態が競合しました。");
      }
      const saved = this.runtime.connection.prepare<[string, string], unknown>(
        "SELECT * FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
      ).get(proposal, operation);
      const savedRow = historyRowSchema.parse(saved);
      parseLegacyHistoryStep(savedRow);
      if (savedRow.confirmation_state !== "confirmed" || savedRow.confirmed_result !== result) {
        throw new Error("旧適用履歴の確認結果を再読込できません。");
      }
      return "confirmed";
    });
    return confirmOne();
  }

  /** 全件確認済みかつ旧行が残らない場合だけ専用同期を許可します。 */
  public assertSynchronizationReady(): void {
    const residual = this.runtime.connection.prepare<[], SourceKey>(
      "SELECT proposal_id, operation_id FROM application_journal LIMIT 1",
    ).get();
    if (residual != null) {
      throw new Error("移行できない旧適用ジャーナルが残っています。");
    }
    const rows = this.runtime.connection.prepare<[], unknown>(
      "SELECT * FROM legacy_application_history ORDER BY proposal_id, operation_id",
    ).all();
    let confirmedCount = 0;
    for (const value of rows) {
      const row = historyRowSchema.parse(value);
      parseLegacyHistoryStep(row);
      if (row.confirmation_state === "required") {
        throw new Error("旧適用履歴の全件確認が終わるまで専用同期を開始できません。");
      }
      if (row.confirmation_state === "confirmed") confirmedCount += 1;
    }
    if (confirmedCount === 0) {
      throw new Error("専用同期を待つ旧適用履歴がありません。");
    }
  }

  /** 読取同期成功後に確認済み履歴をまとめて同期済みに進めます。 */
  public completeSynchronization(): void {
    const complete = this.runtime.transaction(() => {
      this.assertSynchronizationReady();
      const update = this.runtime.connection.prepare<[], ChangeResult>(
        "UPDATE legacy_application_history SET confirmation_state = 'synchronized' WHERE confirmation_state = 'confirmed' AND confirmed_result IS NOT NULL",
      ).run();
      if (update.changes === 0) {
        throw new Error("同期済みに進める旧適用履歴がありません。");
      }
      const remaining = this.runtime.connection.prepare<[], { readonly row_count: number }>(
        "SELECT COUNT(*) AS row_count FROM legacy_application_history WHERE confirmation_state IN ('required', 'confirmed')",
      ).get();
      if (remaining?.row_count !== 0) {
        throw new Error("専用同期後に未完了の旧適用履歴が残っています。");
      }
    });
    complete();
  }

  /** 出所と内容を照合し、履歴再読込後に限って元の旧行を削除します。 */
  public migrate(): LegacyMigrationSummary {
    const keys = this.runtime.connection.prepare<[], SourceKey>(
      "SELECT proposal_id, operation_id FROM application_journal ORDER BY proposal_id, operation_id",
    ).all();
    if (keys.length === 0) {
      return { source_count: 0, migrated_count: 0, already_migrated_count: 0, failures: [] };
    }
    const backupPaths = this.runtime.migrationBackupPaths;
    if (backupPaths.preV8Path == null && backupPaths.preV9Path == null) {
      return {
        source_count: keys.length,
        migrated_count: 0,
        already_migrated_count: 0,
        failures: keys.map((key) => ({ ...key, reason: "missing_backup" })),
      };
    }
    const preV8 = backupPaths.preV8Path == null
      ? undefined : new BetterSqlite3(backupPaths.preV8Path, { readonly: true, fileMustExist: true });
    let preV9: BetterSqlite3.Database | undefined;
    try {
      preV9 = backupPaths.preV9Path == null
        ? undefined : new BetterSqlite3(backupPaths.preV9Path, { readonly: true, fileMustExist: true });
      const preV8Version = preV8?.pragma("user_version", { simple: true });
      const preV9Version = preV9?.pragma("user_version", { simple: true });
      if (preV8 != null && (typeof preV8Version !== "number" || preV8Version < 3 || preV8Version > 7)) {
        throw new Error("旧適用履歴のv8移行前バックアップの版が未対応です。");
      }
      if (preV9 != null && preV9Version !== 8) {
        throw new Error("旧適用履歴のv9移行前バックアップの版が未対応です。");
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
        const currentValidation = legacyRowSchema.safeParse(source);
        if (!currentValidation.success) {
          failures.push({ ...key, reason: "invalid_source" });
          continue;
        }
        const currentNormalized = JSON.stringify(currentValidation.data);
        const oldRow = readBackupRow(preV8, typeof preV8Version === "number" ? preV8Version : undefined, key);
        const v8Row = readBackupRow(preV9, typeof preV9Version === "number" ? preV9Version : undefined, key);
        const selected = oldRow.kind === "valid" && JSON.stringify(oldRow.original.normalized) === currentNormalized
          ? oldRow
          : v8Row.kind === "valid" && JSON.stringify(v8Row.original.normalized) === currentNormalized
            ? v8Row : undefined;
        if (selected == null) {
          failures.push({ ...key, reason: oldRow.kind === "missing" && v8Row.kind === "missing"
            ? "missing_backup_row" : "invalid_source" });
          continue;
        }
        const currentSnapshot = JSON.stringify(source);
        const snapshot = selected.snapshot;
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
            if (!history.success || history.data.source_schema_version !== selected.version
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
              selected.version,
              selected.original.source_stage,
              selected.original.source_final_result,
              selected.original.source_recovery_reason,
              selected.original.source_final_result == null || selected.original.source_final_result === "unknown"
                ? "required" : "not_required",
              snapshot,
              hash,
            );
          }
          const reread = this.runtime.connection.prepare<[string, string], unknown>(
            "SELECT * FROM legacy_application_history WHERE proposal_id = ? AND operation_id = ?",
          ).get(key.proposal_id, key.operation_id);
          const history = historyRowSchema.parse(reread);
          if (history.source_schema_version !== selected.version
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
      preV8?.close();
      preV9?.close();
    }
  }
}
