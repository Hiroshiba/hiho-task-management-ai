import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { DiagnosticFailureDispositionError } from "../application/common/errors/diagnostic-failure";
import type { ErrorReporter } from "../application/common/errors/error-reporter";
import type { TaskWriteExecutorRegistry } from "../application/common/ports/task-write-executor";
import type { ProposalExecution, ProposalExecutionRepository } from "../application/common/ports/proposal-execution-repository";
import { guiTaskWriteResultSchema, type GuiTaskWriteResult } from "../application/common/gui-task-write-result";
import { TaskWriteSynchronizationError } from "../application/common/task-write-synchronization-error";
import { parseTaskWritePlan, taskWriteReceiptSchema } from "../application/common/task-write-plan";
import {
  buildTaskWriteExecutionResult,
  ProposalExecutionEngine,
  proposalTaskWriteResultSchema,
  type ProposalTaskWriteResult,
  taskWriteExecutionResultSchema,
  type TaskWriteExecutionResult,
} from "../application/task-write";
import { AsanaTaskWriteCallAdapter, AsanaTaskWriteReadBackAdapter } from "../infrastructure/asana";
import { JsonlErrorReporter, writeErrorReportFailure } from "../infrastructure/logging";
import {
  ApplicationUpdateAttemptStore,
  PersistenceRuntime,
  SqliteLegacyProposalExecutionRepository,
  SqliteProposalExecutionRepository,
  WindowStateStore,
} from "../infrastructure/persistence";
import {
  createLegacyRuntime,
  migrateLegacyPersistence,
  type LegacyRuntimeOptions,
  type LegacyRuntimePort,
} from "./legacy-runtime-port";

const USE_NEW_WRITE_EXECUTION_ENGINE: boolean = false;

function proposalExecution(
  execution: ProposalExecution<TaskWriteExecutionResult>,
): ProposalExecution<ProposalTaskWriteResult> {
  if (execution.plan.origin !== "proposal") throw new Error("proposal以外のexecutionを読み出しました。");
  if (execution.state === "succeeded") {
    return { ...execution, result: proposalTaskWriteResultSchema.parse(execution.result) };
  }
  return execution;
}

function guiExecution(
  execution: ProposalExecution<TaskWriteExecutionResult>,
): ProposalExecution<GuiTaskWriteResult> {
  if (execution.plan.origin !== "gui-edit") throw new Error("GUI編集以外のexecutionを読み出しました。");
  if (execution.state === "succeeded") {
    return { ...execution, result: guiTaskWriteResultSchema.parse(execution.result) };
  }
  return execution;
}

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
    const legacy = createLegacyRuntime({
      ...options.legacy,
      lifecycle_signal: controller.signal,
      now_provider: nowProvider,
      create_id: createId,
    }, openedPersistence, files);
    const bridge = legacy.getTaskWriteAsanaBridge();
    const fingerprint = (canonicalPayload: string) =>
      createHash("sha256").update(canonicalPayload).digest("hex");
    const repository = new SqliteProposalExecutionRepository<TaskWriteExecutionResult>(
      openedPersistence,
      (value) => parseTaskWritePlan(value, fingerprint),
      (value) => taskWriteReceiptSchema.parse(value),
      taskWriteExecutionResultSchema,
    );
    const readBack = new AsanaTaskWriteReadBackAdapter(
      bridge.readClient,
      (error) => bridge.isNotFound(error),
      (milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }),
    );
    const executors = {
      ...new AsanaTaskWriteCallAdapter(bridge.transport, bridge.readClient).getExecutors(),
      local_synchronize: {
        1: {
          execute: async (step, context, signal) => {
            const origin = context.plan.origin;
            if (step.payload.condition !== (origin === "proposal" ? "verified_operation" : "writer_result_available")) {
              throw new Error("後続同期の実行条件が保存済みplanと一致しません。");
            }
            const result = origin === "proposal"
              ? await bridge.synchronizeAfterProposalWrite(
                context.synchronization_task_gids,
                context.execution_id,
                signal,
              )
              : await bridge.synchronizeAfterGuiWrite(context.synchronization_task_gids, signal);
            if (result.kind === "recovery_required") {
              throw new TaskWriteSynchronizationError(result.error_code, result.cause);
            }
            return { kind: "synchronized", task_gids: context.synchronization_task_gids };
          },
        },
      },
    } satisfies TaskWriteExecutorRegistry;
    const engineReporter = reporter ?? createFallbackErrorReporter(createId, options.loggerFormatter.redactText);
    const engine = new ProposalExecutionEngine(
      repository,
      executors,
      readBack,
      buildTaskWriteExecutionResult,
      { now: () => nowProvider().toISOString() },
      engineReporter,
    );
    if (USE_NEW_WRITE_EXECUTION_ENGINE) {
      const proposalRepository = {
        save: (input) => repository.save(input),
        getByProposal: (proposalId) => repository.getByProposal(proposalId).map(proposalExecution),
        getIncomplete: () => repository.getIncomplete()
          .filter((execution) => execution.plan.origin === "proposal").map(proposalExecution),
      } satisfies Pick<ProposalExecutionRepository<ProposalTaskWriteResult>, "save" | "getByProposal" | "getIncomplete">;
      legacy.setProposalWriteExecution({
        repository: proposalRepository,
        legacyRepository: new SqliteLegacyProposalExecutionRepository(openedPersistence, engineReporter),
        engine: { run: async (executionId, signal) => proposalExecution(await engine.run(executionId, signal)) },
        createId,
        now: () => nowProvider().toISOString(),
        fingerprint,
      });
      legacy.setGuiWriteExecution({
        repository: {
          save: (input) => repository.save(input),
          getIncomplete: () => repository.getIncomplete()
            .filter((execution) => execution.plan.origin === "gui-edit").map(guiExecution),
        },
        engine: { run: async (executionId, signal) => guiExecution(await engine.run(executionId, signal)) },
        createId,
        now: () => nowProvider().toISOString(),
        fingerprint,
      });
    }
    let disposal: Promise<void> | undefined;
    return {
      legacy,
      reporter,
      taskWriteExecution: { repository, engine },
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
