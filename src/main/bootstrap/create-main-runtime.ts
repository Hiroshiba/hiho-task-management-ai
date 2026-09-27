import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DiagnosticFailureDispositionError } from "../application/common/errors/diagnostic-failure";
import type { ErrorReporter } from "../application/common/errors/error-reporter";
import { parseTaskWritePlan, taskWriteReceiptSchema } from "../application/common/task-write-plan";
import { ProposalExecutionEngine, taskWriteExecutionResultSchema, type TaskWriteExecutionResult } from "../application/task-write";
import type { ProposalExecutionRepository } from "../application/common/ports/proposal-execution-repository";
import { JsonlErrorReporter, writeErrorReportFailure } from "../infrastructure/logging";
import {
  ApplicationUpdateAttemptStore,
  PersistenceRuntime,
  SqliteProposalApplicationHistoryRepository,
  SqliteProposalExecutionRepository,
  WindowStateStore,
  type LegacyMigrationSummary,
} from "../infrastructure/persistence";
import {
  createLegacyRuntime,
  migrateLegacyPersistence,
  type LegacyRuntimeOptions,
  type LegacyRuntimePort,
} from "./legacy-runtime-port";
import { createTaskWriteRuntime } from "./create-task-write-runtime";

type MainRuntimeOptions = {
  readonly userDataPath: string;
  readonly secretStoragePath: string;
  readonly checkpointPath: string;
  readonly logsPath: string;
  readonly loggerFormatter: ConstructorParameters<typeof JsonlErrorReporter>[2];
  readonly legacy: Omit<LegacyRuntimeOptions, "lifecycle_signal" | "now_provider" | "create_id">;
};

function createFallbackErrorReporter(
  createId: () => string,
  redactText: (value: string) => string,
): ErrorReporter {
  const reported = new WeakMap<object, string>();
  const reportErrorOnce = (error: unknown): string => {
    const objectError = error !== null && typeof error === "object" ? error : undefined;
    const existing = objectError == null ? undefined : reported.get(objectError);
    if (existing != null) return existing;
    const errorId = createId();
    writeErrorReportFailure(new Error(`エラーID: ${errorId}`, { cause: error }), [], redactText);
    if (objectError != null) reported.set(objectError, errorId);
    return errorId;
  };
  return {
    reportErrorOnce,
    reportErrorOnceStrict: (error) => {
      reportErrorOnce(error);
      throw new Error("永続エラーログを初期化できません。", { cause: error });
    },
  };
}

const migrationFailureReasons = {
  invalid_source: "元の旧行を検証できません。",
  conflicting_history: "同じIDの履歴と元の旧行が一致しません。",
  missing_backup: "移行前バックアップがありません。",
  missing_backup_row: "移行前バックアップに元の旧行がありません。",
} satisfies Record<LegacyMigrationSummary["failures"][number]["reason"], string>;

function recordLegacyMigration(
  summary: LegacyMigrationSummary,
  reporter: ErrorReporter,
  backupPaths: PersistenceRuntime["migrationBackupPaths"],
): void {
  for (const failure of summary.failures) {
    reporter.reportErrorOnce(
      new Error(`旧適用ジャーナルの履歴移行に失敗しました。proposal ID: ${failure.proposal_id}、操作ID: ${failure.operation_id}。${migrationFailureReasons[failure.reason]}`),
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
    backup_paths: backupPaths,
    source_count: summary.source_count,
    migrated_count: summary.migrated_count,
    already_migrated_count: summary.already_migrated_count,
    failed_count: summary.failures.length,
    failed_ids: summary.failures.map((failure) => ({
      proposal_id: failure.proposal_id,
      operation_id: failure.operation_id,
    })),
  }));
}

/** Mainの単一ランタイムと資源の破棄入口です。 */
export interface MainRuntime {
  readonly legacy: LegacyRuntimePort;
  readonly reporter: ErrorReporter | undefined;
  readonly taskWriteExecution: {
    readonly repository: ProposalExecutionRepository<TaskWriteExecutionResult>;
    readonly engine: ProposalExecutionEngine<TaskWriteExecutionResult>;
  };
  readonly signal: AbortSignal;
  createWindowStateStore(): WindowStateStore;
  createApplicationUpdateAttemptStore(): ApplicationUpdateAttemptStore;
  abort(): void;
  dispose(): Promise<void>;
  closeLateFiles(): void;
}

/** Mainの診断sink、保存資源、未移行機能を一度だけ組み立てます。 */
export function createMainRuntime(options: MainRuntimeOptions): MainRuntime {
  const nowProvider = () => new Date();
  const createId = randomUUID;
  let reporter: ErrorReporter | undefined;
  try {
    reporter = new JsonlErrorReporter(options.logsPath, [], options.loggerFormatter);
  } catch (error) {
    writeErrorReportFailure(error, [], options.loggerFormatter.redactText);
  }
  const controller = new AbortController();
  let persistence: PersistenceRuntime | undefined;
  try {
    persistence = new PersistenceRuntime(
      join(options.userDataPath, "taskhub.sqlite3"),
      migrateLegacyPersistence,
    );
    const openedPersistence = persistence;
    const files = {
      secretStorage: openedPersistence.openTextFile(options.secretStoragePath, "秘密情報ファイル"),
      checkpoint: openedPersistence.openTextFile(options.checkpointPath, "初回設定チェックポイント"),
      openExternalAgentConfigFile: (filePath: string) =>
        openedPersistence.openTextFile(filePath, "外部連携設定"),
    };
    const engineReporter = reporter ?? createFallbackErrorReporter(createId, options.loggerFormatter.redactText);
    const historyRepository = new SqliteProposalApplicationHistoryRepository(openedPersistence, engineReporter);
    recordLegacyMigration(historyRepository.migrate(), engineReporter, openedPersistence.migrationBackupPaths);
    historyRepository.assertNoUnmigratedJournals();
    const legacy = createLegacyRuntime({
      ...options.legacy,
      lifecycle_signal: controller.signal,
      now_provider: nowProvider,
      create_id: createId,
    }, openedPersistence, files, historyRepository);
    const taskWrite = createTaskWriteRuntime({
      bridge: legacy.getTaskWriteAsanaBridge(),
      historyRepository,
      reporter: engineReporter,
      createRepository: (fingerprint) => new SqliteProposalExecutionRepository<TaskWriteExecutionResult>(
        openedPersistence,
        (value) => parseTaskWritePlan(value, fingerprint),
        (value) => taskWriteReceiptSchema.parse(value),
        taskWriteExecutionResultSchema,
      ),
      createId,
      now: nowProvider,
      wait: (milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }),
    });
    legacy.setTaskWriteExecution({ proposal: taskWrite.proposal, gui: taskWrite.gui });
    let disposal: Promise<void> | undefined;
    return {
      legacy,
      reporter,
      taskWriteExecution: { repository: taskWrite.repository, engine: taskWrite.engine },
      signal: controller.signal,
      createWindowStateStore: () => new WindowStateStore(
        openedPersistence.openLateTextFile(
          join(options.userDataPath, "window-state.json"),
          "ウィンドウ状態",
        ),
      ),
      createApplicationUpdateAttemptStore: () => new ApplicationUpdateAttemptStore(
        openedPersistence.openLateTextFile(
          join(options.userDataPath, "application-update-attempt.json"),
          "アプリ本体の更新試行",
        ),
      ),
      abort: () => controller.abort(),
      dispose: () => {
        if (disposal != null) {
          return disposal;
        }
        disposal = (async () => {
          controller.abort();
          const errors: unknown[] = [];
          try {
            await legacy.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            openedPersistence.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw new AggregateError(errors, "Mainの停止と保存資源の終了に失敗しました。", {
              cause: errors[0],
            });
          }
        })().catch((error: unknown) => {
          disposal = undefined;
          throw error;
        });
        return disposal;
      },
      closeLateFiles: () => openedPersistence.closeLateFiles(),
    };
  } catch (error) {
    controller.abort();
    let failure = error;
    if (persistence != null) {
      try {
        persistence.close();
      } catch (closeError) {
        failure = new AggregateError(
          [error, closeError],
          "Mainの初期化と保存資源の終了に失敗しました。",
          { cause: error },
        );
      }
    }
    if (reporter == null) {
      writeErrorReportFailure(failure, [], options.loggerFormatter.redactText);
    } else {
      reporter.reportErrorOnce(failure, {
        source: "main",
        diagnosticCode: "app.error",
        context: "bootstrap",
        level: "error",
      });
    }
    throw new DiagnosticFailureDispositionError({
      kind: "recorded_only",
      recorded_error: failure,
      response_error: failure,
    });
  }
}
