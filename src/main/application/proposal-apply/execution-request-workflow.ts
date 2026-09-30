import type { AsanaOperationQueueInput } from "../common/ports/asana-operation-queue";
import type { ListProposalExecutionsInput } from "../common/ports/proposal-execution-repository";
import type { ProposalExecutionWorkflow, StoredProposalExecution } from "./execution-workflow";

type ProposalExecutionRequestDependencies<Context> = {
  readonly requireWorkflow: () => ProposalExecutionWorkflow;
  readonly assertMutationRequestAccepted: () => void;
  readonly assertQueuedMutationReady: () => void;
  readonly requireContext: () => Context;
  readonly assertContextUnchanged: (context: Context) => void;
  readonly queue: { enqueue<T>(input: AsanaOperationQueueInput<T>): Promise<T> };
};

/** 保存済み変更案executionの取得と明示再試行を扱います。 */
export class ProposalExecutionRequestWorkflow<Context> {
  public constructor(private readonly dependencies: ProposalExecutionRequestDependencies<Context>) {}

  /** 指定IDの保存済み変更案executionを取得します。 */
  public getExecution(executionId: string): StoredProposalExecution {
    return this.dependencies.requireWorkflow().getExecution(executionId);
  }

  /** 保存済み変更案executionを作成順にページ単位で取得します。 */
  public listExecutions(input: ListProposalExecutionsInput): ReturnType<ProposalExecutionWorkflow["listExecutions"]> {
    return this.dependencies.requireWorkflow().listExecutions(input);
  }

  /** 変更案の実行条件を確認して明示再試行します。 */
  public async retryExecution(executionId: string, signal: AbortSignal): Promise<StoredProposalExecution> {
    this.dependencies.assertMutationRequestAccepted();
    const context = this.dependencies.requireContext();
    return this.dependencies.queue.enqueue({
      priority: "user",
      kind: "ai_apply",
      signal,
      beforeStart: () => {
        this.dependencies.assertQueuedMutationReady();
        this.dependencies.assertContextUnchanged(context);
      },
      run: (operationContext) => this.dependencies.requireWorkflow().retryExecution(executionId, operationContext.signal),
    });
  }
}
