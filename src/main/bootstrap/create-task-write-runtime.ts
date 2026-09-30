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
import { GuiEditExecutionWorkflow, type GuiEditExecution, type GuiEditExecutionPort } from "../application/gui-edit";
import { ProposalExecutionWorkflow, type StoredProposalExecution, type StoredProposalExecutionPort } from "../application/proposal-apply";
import type { AsanaTaskWriteCallAdapter, AsanaTaskWriteReadBackAdapter } from "../infrastructure/asana";

type TaskWriteRuntimeOptions = {
  readonly bridge: TaskWriteAsanaBridge;
  readonly historyRepository: ProposalApplicationHistoryRepository;
  readonly reporter: ErrorReporter;
  readonly createRepository: (
    fingerprint: (canonicalPayload: string) => string,
  ) => ProposalExecutionRepository<TaskWriteExecutionResult>;
  readonly createId: () => string;
  readonly now: () => Date;
  readonly createReadBack: () => AsanaTaskWriteReadBackAdapter;
  readonly createAsanaExecutors: () => ReturnType<AsanaTaskWriteCallAdapter["getExecutors"]>;
};

/** 保存済みplanのrepositoryと実書き込みengineを公開入口ごとに組み立てます。 */
export function createTaskWriteRuntime(options: TaskWriteRuntimeOptions): {
  readonly repository: ProposalExecutionRepository<TaskWriteExecutionResult>;
  readonly engine: ProposalExecutionEngine<TaskWriteExecutionResult>;
  readonly proposal: StoredProposalExecutionPort;
  readonly proposalWorkflow: ProposalExecutionWorkflow;
  readonly gui: GuiEditExecutionPort;
  readonly guiWorkflow: GuiEditExecutionWorkflow;
  readonly onGuiChanged: (listener: (execution: GuiEditExecution) => void) => () => void;
  readonly onProposalChanged: (listener: (execution: StoredProposalExecution) => void) => () => void;
} {
  const fingerprint = (canonicalPayload: string): string =>
    createHash("sha256").update(canonicalPayload).digest("hex");
  const repository = options.createRepository(fingerprint);
  const readBack = options.createReadBack();
  const executors = {
    ...options.createAsanaExecutors(),
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
            : await options.bridge.synchronizeAfterGuiWrite(
              context.synchronization_task_gids,
              context.execution_id,
              signal,
            );
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
  const gui: GuiEditExecutionPort = {
    repository: {
      save: (input) => repository.save(input),
      saveRetry: (input) => {
        const saved = repository.saveRetry(input);
        return { ...saved, execution: guiExecution(saved.execution) };
      },
      get: (executionId) => {
        const execution = repository.get(executionId);
        return execution == null || execution.plan.origin !== "gui-edit"
          ? undefined
          : guiExecution(execution);
      },
      getIncomplete: () => repository.getIncomplete()
        .filter((execution) => execution.plan.origin === "gui-edit").map(guiExecution),
    },
    engine: { run: async (executionId, signal) => guiExecution(await engine.run(executionId, signal)) },
    createId: options.createId,
    now: () => options.now().toISOString(),
    fingerprint,
  };
  const proposal: StoredProposalExecutionPort = {
    repository: {
      save: (input) => repository.save(input),
      saveRetry: (input) => {
        const saved = repository.saveRetry(input);
        return { ...saved, execution: proposalExecution(saved.execution) };
      },
      get: (executionId) => {
        const execution = repository.get(executionId);
        return execution == null || execution.plan.origin !== "proposal" ? undefined : proposalExecution(execution);
      },
      getByProposal: (proposalId) => repository.getByProposal(proposalId).map(proposalExecution),
      getIncomplete: () => repository.getIncomplete()
        .filter((execution) => execution.plan.origin === "proposal").map(proposalExecution),
      listExecutions: (input) => {
        const page = repository.listExecutions(input);
        return { ...page, executions: page.executions.map(proposalExecution) };
      },
    },
    historyRepository: options.historyRepository,
    engine: { run: async (executionId, signal) => proposalExecution(await engine.run(executionId, signal)) },
    createId: options.createId,
    now: () => options.now().toISOString(),
    fingerprint,
  };
  return {
    repository,
    engine,
    proposal,
    proposalWorkflow: new ProposalExecutionWorkflow(proposal),
    gui,
    guiWorkflow: new GuiEditExecutionWorkflow(gui),
    onGuiChanged: (listener) => repository.onChanged((execution) => {
      if (execution.plan.origin === "gui-edit") listener(guiExecution(execution));
    }),
    onProposalChanged: (listener) => repository.onChanged((execution) => {
      if (execution.plan.origin === "proposal") listener(proposalExecution(execution));
    }),
  };
}
