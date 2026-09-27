import { createHash } from "node:crypto";
import type { ErrorReporter } from "../application/common/errors/error-reporter";
import type { TaskWriteAsanaBridge } from "../application/common/ports/asana-task-write";
import type { TaskWriteExecutorRegistry } from "../application/common/ports/task-write-executor";
import type {
  ProposalExecution,
  ProposalExecutionRepository,
} from "../application/common/ports/proposal-execution-repository";
import type { ProposalApplicationHistoryRepository } from "../application/common/ports/proposal-application-history";
import { guiTaskWriteResultSchema, type GuiTaskWriteResult } from "../application/common/gui-task-write-result";
import { TaskWriteSynchronizationError } from "../application/common/task-write-synchronization-error";
import {
  ProposalExecutionEngine,
  buildTaskWriteExecutionResult,
  proposalTaskWriteResultSchema,
  type ProposalTaskWriteResult,
  type TaskWriteExecutionResult,
} from "../application/task-write";
import type { GuiEditExecutionPort } from "../application/gui-edit";
import type { StoredProposalExecutionPort } from "../application/proposal-apply";
import { AsanaTaskWriteCallAdapter, AsanaTaskWriteReadBackAdapter } from "../infrastructure/asana";

type TaskWriteRuntimeOptions = {
  readonly bridge: TaskWriteAsanaBridge;
  readonly historyRepository: ProposalApplicationHistoryRepository;
  readonly reporter: ErrorReporter;
  readonly createRepository: (
    fingerprint: (canonicalPayload: string) => string,
  ) => ProposalExecutionRepository<TaskWriteExecutionResult>;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

/** 保存済みplanのrepositoryと実書き込みengineを公開入口ごとに組み立てます。 */
export function createTaskWriteRuntime(options: TaskWriteRuntimeOptions): {
  readonly repository: ProposalExecutionRepository<TaskWriteExecutionResult>;
  readonly engine: ProposalExecutionEngine<TaskWriteExecutionResult>;
  readonly proposal: StoredProposalExecutionPort;
  readonly gui: GuiEditExecutionPort;
} {
  const fingerprint = (canonicalPayload: string): string =>
    createHash("sha256").update(canonicalPayload).digest("hex");
  const repository = options.createRepository(fingerprint);
  const readBack = new AsanaTaskWriteReadBackAdapter(
    options.bridge.readClient,
    (error) => options.bridge.isNotFound(error),
    options.wait,
  );
  const executors = {
    ...new AsanaTaskWriteCallAdapter(options.bridge.transport, options.bridge.readClient).getExecutors(),
    local_synchronize: {
      1: {
        execute: async (step, context, signal) => {
          const origin = context.plan.origin;
          if (step.payload.condition !== (origin === "proposal" ? "verified_operation" : "writer_result_available")) {
            throw new Error("後続同期の実行条件が保存済みplanと一致しません。");
          }
          const result = origin === "proposal"
            ? await options.bridge.synchronizeAfterProposalWrite(
              context.synchronization_task_gids,
              context.execution_id,
              signal,
            )
            : await options.bridge.synchronizeAfterGuiWrite(context.synchronization_task_gids, signal);
          if (result.kind === "recovery_required") {
            throw new TaskWriteSynchronizationError(result.error_code, result.cause);
          }
          return { kind: "synchronized", task_gids: context.synchronization_task_gids };
        },
      },
    },
  } satisfies TaskWriteExecutorRegistry;
  const engine = new ProposalExecutionEngine(
    repository,
    executors,
    readBack,
    buildTaskWriteExecutionResult,
    { now: () => options.now().toISOString() },
    options.reporter,
  );
  const proposalExecution = (
    execution: ProposalExecution<TaskWriteExecutionResult>,
  ): ProposalExecution<ProposalTaskWriteResult> => {
    if (execution.plan.origin !== "proposal") throw new Error("proposal以外のexecutionを読み出しました。");
    if (execution.state === "succeeded") {
      return { ...execution, result: proposalTaskWriteResultSchema.parse(execution.result) };
    }
    return execution;
  };
  const guiExecution = (
    execution: ProposalExecution<TaskWriteExecutionResult>,
  ): ProposalExecution<GuiTaskWriteResult> => {
    if (execution.plan.origin !== "gui-edit") throw new Error("GUI編集以外のexecutionを読み出しました。");
    if (execution.state === "succeeded") {
      return { ...execution, result: guiTaskWriteResultSchema.parse(execution.result) };
    }
    return execution;
  };
  return {
    repository,
    engine,
    proposal: {
      repository: {
        save: (input) => repository.save(input),
        getByProposal: (proposalId) => repository.getByProposal(proposalId).map(proposalExecution),
        getIncomplete: () => repository.getIncomplete()
          .filter((execution) => execution.plan.origin === "proposal").map(proposalExecution),
      },
      historyRepository: options.historyRepository,
      engine: { run: async (executionId, signal) => proposalExecution(await engine.run(executionId, signal)) },
      createId: options.createId,
      now: () => options.now().toISOString(),
      fingerprint,
    },
    gui: {
      repository: {
        save: (input) => repository.save(input),
        getIncomplete: () => repository.getIncomplete()
          .filter((execution) => execution.plan.origin === "gui-edit").map(guiExecution),
      },
      engine: { run: async (executionId, signal) => guiExecution(await engine.run(executionId, signal)) },
      createId: options.createId,
      now: () => options.now().toISOString(),
      fingerprint,
    },
  };
}
