import type { GuiTaskWriteResult } from "../common/gui-task-write-result";
import type { ProposalExecution } from "../common/ports/proposal-execution-repository";
import { prepareTaskWriteRetry } from "../common/prepare-task-write-retry";
import { identifierSchema } from "../../domain/task-write-values";
import type { GuiEditExecutionPort } from "./apply";

export { TaskWriteRetryNotAllowedError } from "../common/prepare-task-write-retry";
export type GuiEditExecution = ProposalExecution<GuiTaskWriteResult>;

/** GUI編集の保存済みexecutionが見つからないことを表します。 */
export class GuiEditExecutionNotFoundError extends Error {
  public constructor() {
    super("GUI編集の保存済みexecutionが見つかりません。");
    this.name = "GuiEditExecutionNotFoundError";
  }
}

/** GUI編集の保存済みexecutionの取得と明示再試行を扱います。 */
export class GuiEditExecutionWorkflow {
  public constructor(private readonly port: GuiEditExecutionPort) {}

  /** 指定IDのGUI編集executionを取得します。 */
  public getExecution(executionId: string): GuiEditExecution {
    const execution = this.port.repository.get(identifierSchema.parse(executionId));
    if (execution == null || execution.plan.origin !== "gui-edit") {
      throw new GuiEditExecutionNotFoundError();
    }
    return execution;
  }

  /** 終了したGUI編集executionから新しい明示再試行を作成します。 */
  public async retryExecution(executionId: string, signal: AbortSignal): Promise<GuiEditExecution> {
    signal.throwIfAborted();
    const source = this.getExecution(executionId);
    const retry = prepareTaskWriteRetry(
      source,
      identifierSchema.parse(this.port.createId()),
      this.port.now(),
      this.port.fingerprint,
    );
    const saved = this.port.repository.saveRetry(retry);
    if (!saved.created) return saved.execution;
    return this.port.engine.run(saved.execution.execution_id, signal);
  }
}
