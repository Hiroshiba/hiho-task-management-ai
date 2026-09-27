import type { ErrorReporter } from "../common/errors/error-reporter";

type LegacyMigrationFailure = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly reason: "invalid_source" | "conflicting_history" | "missing_backup" | "missing_backup_row";
};

type LegacyMigrationSummary = {
  readonly source_count: number;
  readonly migrated_count: number;
  readonly already_migrated_count: number;
  readonly failures: readonly LegacyMigrationFailure[];
};

type LegacyMigrationPort = {
  migrate(): LegacyMigrationSummary;
};

const failureReasons = {
  invalid_source: "元の旧行を検証できません。",
  conflicting_history: "同じIDの履歴と元の旧行が一致しません。",
  missing_backup: "移行前バックアップがありません。",
  missing_backup_row: "移行前バックアップに元の旧行がありません。",
} satisfies Record<LegacyMigrationFailure["reason"], string>;

/** 旧行の移行結果をpayloadなしで記録します。 */
export function migrateLegacyFormat(
  repository: LegacyMigrationPort,
  reporter: ErrorReporter,
  backupPath: string | undefined,
): LegacyMigrationSummary {
  const result = repository.migrate();
  for (const failure of result.failures) {
    reporter.reportErrorOnce(
      new Error(`旧適用ジャーナルの履歴移行に失敗しました。proposal ID: ${failure.proposal_id}、操作ID: ${failure.operation_id}。${failureReasons[failure.reason]}`),
      {
        source: "main",
        diagnosticCode: "proposal.application",
        context: "bootstrap",
        level: "error",
        operationId: failure.operation_id,
      },
    );
  }
  console.info(JSON.stringify({
    event: "legacy_application_migration",
    backup_path: backupPath,
    source_count: result.source_count,
    migrated_count: result.migrated_count,
    already_migrated_count: result.already_migrated_count,
    failed_count: result.failures.length,
    failed_ids: result.failures.map((failure) => ({
      proposal_id: failure.proposal_id,
      operation_id: failure.operation_id,
    })),
  }));
  return result;
}
