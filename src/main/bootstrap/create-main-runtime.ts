import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { DiagnosticFailureDispositionError } from "../application/common/errors/diagnostic-failure";
import type { ErrorReporter } from "../application/common/errors/error-reporter";
import { parseTaskWritePlan, taskWriteReceiptSchema } from "../application/common/task-write-plan";
import { getGithubIntegrationStatus } from "../application/github-integration";
import { ProposalExecutionEngine, taskWriteExecutionResultSchema, type TaskWriteExecutionResult } from "../application/task-write";
import { createDiagnosticsHandlers, type DiagnosticsHandlers } from "../ipc/handlers/diagnostics";
import { createGithubIntegrationHandlers, type GithubIntegrationHandlers } from "../ipc/handlers/github-integration";
import { createObsidianIntegrationHandlers, type ObsidianIntegrationHandlers } from "../ipc/handlers/obsidian-integration";
import { createProposalsHandlers, type ProposalsHandlers } from "../ipc/handlers/proposals";
import { createSettingsHandlers, type SettingsHandlers } from "../ipc/handlers/settings";
import { createSystemHandlers, type SystemHandlers, type SystemHandlerWorkflow } from "../ipc/handlers/system";
import { createTasksHandlers, type TasksHandlers } from "../ipc/handlers/tasks";
import { FeatureIpcRegistry } from "../ipc/register-ipc";
import type { ProposalExecutionRepository } from "../application/common/ports/proposal-execution-repository";
import type { GuiEditExecution } from "../application/gui-edit";
import type { StoredProposalExecution } from "../application/proposal-apply";
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
  readonly system: SystemHandlerWorkflow;
  readonly ipcSecurity: {
    readonly assertTrustedSender: (event: IpcMainInvokeEvent, webContents: WebContents, rendererUrl: string) => void;
    readonly isApplicationUrl: (url: string, rendererUrl: string) => boolean;
  };
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
    readonly onGuiChanged: (listener: (execution: GuiEditExecution) => void) => () => void;
    readonly onProposalChanged: (listener: (execution: StoredProposalExecution) => void) => () => void;
  };
  readonly systemHandlers: SystemHandlers;
  readonly settingsHandlers: SettingsHandlers;
  readonly tasksHandlers: TasksHandlers;
  readonly proposalsHandlers: ProposalsHandlers;
  readonly githubIntegrationHandlers: GithubIntegrationHandlers;
  readonly obsidianIntegrationHandlers: ObsidianIntegrationHandlers;
  readonly diagnosticsHandlers: DiagnosticsHandlers;
  readonly signal: AbortSignal;
  attachWindow(ipcMain: IpcMain, webContents: WebContents, rendererUrl: string): void;
  detachWindow(webContents: WebContents): void;
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
        engineReporter,
      ),
      createId,
      now: nowProvider,
      wait: (milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }),
    });
    legacy.setTaskWriteExecution({ proposal: taskWrite.proposal, proposalWorkflow: taskWrite.proposalWorkflow, gui: taskWrite.gui, guiWorkflow: taskWrite.guiWorkflow });
    const systemHandlers = createSystemHandlers(options.system);
    const settingsHandlers = createSettingsHandlers(legacy.getSettingsHandlerWorkflows());
    const tasksHandlers = createTasksHandlers({
      taskRead: legacy.taskRead,
      guiEdit: legacy,
      taskWriteExecution: {
        getExecution: (executionId) => legacy.getGuiEditExecution(executionId),
        retryExecution: (executionId, signal) => legacy.retryGuiEditExecution(executionId, signal),
      },
    });
    const proposalsHandlers = createProposalsHandlers(legacy.getProposalsHandlerWorkflows());
    const githubIntegrationHandlers = createGithubIntegrationHandlers({ getStatus: getGithubIntegrationStatus });
    const obsidianIntegrationHandlers = createObsidianIntegrationHandlers(legacy.getObsidianHandlerWorkflow());
    const diagnosticsHandlers = createDiagnosticsHandlers(engineReporter);
    const legacyIpcPorts = legacy.getIpcPorts();
    const aiEvents = legacyIpcPorts.ai;
    const externalEvents = legacyIpcPorts.externalAgent;
    if (aiEvents?.onStatus == null || aiEvents.onDelta == null || externalEvents?.onChanged == null) {
      throw new Error("最終IPCのイベント源を取得できません。");
    }
    const onAiStatus = aiEvents.onStatus.bind(aiEvents);
    const onAiDelta = aiEvents.onDelta.bind(aiEvents);
    const onExternalChanged = externalEvents.onChanged.bind(externalEvents);
    const featureIpc = new FeatureIpcRegistry({
      signal: controller.signal,
      ...options.ipcSecurity,
      reporter: engineReporter,
      handlers: {
        system: systemHandlers,
        tasks: tasksHandlers,
        settings: settingsHandlers,
        proposals: proposalsHandlers,
        githubIntegration: githubIntegrationHandlers,
        obsidianIntegration: obsidianIntegrationHandlers,
        diagnostics: diagnosticsHandlers,
      },
      events: {
        updateState: (listener) => options.system.onUpdateState(listener),
        syncState: (listener) => legacy.taskRead.onState(listener),
        guiExecution: taskWrite.onGuiChanged,
        aiStatus: (listener) => onAiStatus(listener),
        aiDelta: (listener) => onAiDelta(listener),
        externalState: (listener) => onExternalChanged((state) => listener(state)),
        proposalExecution: taskWrite.onProposalChanged,
      },
    });
    let disposal: Promise<void> | undefined;
    return {
      legacy,
      reporter,
      taskWriteExecution: {
        repository: taskWrite.repository,
        engine: taskWrite.engine,
        onGuiChanged: taskWrite.onGuiChanged,
        onProposalChanged: taskWrite.onProposalChanged,
      },
      systemHandlers,
      settingsHandlers,
      tasksHandlers,
      proposalsHandlers,
      githubIntegrationHandlers,
      obsidianIntegrationHandlers,
      diagnosticsHandlers,
      signal: controller.signal,
      attachWindow: (ipcMain, webContents, rendererUrl) => featureIpc.attach(ipcMain, webContents, rendererUrl),
      detachWindow: (webContents) => featureIpc.detach(webContents),
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
      abort: () => {
        controller.abort();
        featureIpc.stop();
      },
      dispose: () => {
        if (disposal != null) {
          return disposal;
        }
        disposal = (async () => {
          controller.abort();
          const errors: unknown[] = [];
          try {
            featureIpc.stop();
          } catch (error) {
            errors.push(error);
          }
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
