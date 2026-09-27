import type { ProposalExecution } from "../common/ports/proposal-execution-repository";
import { prepareTaskWriteRetry } from "../common/prepare-task-write-retry";
import { identifierSchema } from "../../domain/task-write-values";
import type { StoredProposalExecutionPort } from "./apply-stored-proposal";
import { latestProposalExecution } from "./latest-proposal-execution";
import type { StoredProposalWriteResult } from "./stored-proposal-result";

export type StoredProposalExecution = ProposalExecution<StoredProposalWriteResult>;

/** 指定IDのproposal executionが見つからないことを表します。 */
export class ProposalExecutionNotFoundError extends Error {
  public constructor() {
    super("変更案の保存済みexecutionが見つかりません。");
    this.name = "ProposalExecutionNotFoundError";
  }
}

/** 変更案の保存済みexecutionの取得と明示再試行を扱います。 */
export class ProposalExecutionWorkflow {
  public constructor(private readonly port: StoredProposalExecutionPort) {}

  /** 指定IDのproposal executionを取得します。 */
  public getExecution(executionId: string): StoredProposalExecution {
    const execution = this.port.repository.get(identifierSchema.parse(executionId));
    if (execution == null || execution.plan.origin !== "proposal") {
      throw new ProposalExecutionNotFoundError();
    }
    return execution;
  }

  /** 終了したproposal executionから新しい明示再試行を作成します。 */
  public async retryExecution(executionId: string, signal: AbortSignal): Promise<StoredProposalExecution> {
    signal.throwIfAborted();
    const source = this.getExecution(executionId);
    if (source.proposal_id == null) throw new Error("変更案の保存済みexecutionに変更案IDがありません。");
    const executions = this.port.repository.getByProposal(source.proposal_id);
    latestProposalExecution(executions);
    const existing = executions.find((execution) =>
      execution.retry_of_execution_id === source.execution_id);
    if (existing != null) return existing;
    const retry = prepareTaskWriteRetry(
      source,
      identifierSchema.parse(this.port.createId()),
      this.port.now(),
      this.port.fingerprint,
    );
    this.port.repository.save(retry);
    return this.port.engine.run(retry.plan.execution_id, signal);
  }
}
