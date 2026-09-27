import type { ProposalExecution, SaveRetryProposalExecution } from "./ports/proposal-execution-repository";
import { createTaskWritePlan, type TaskWritePayloadFingerprint } from "./task-write-plan";

/** 明示再試行できないexecutionを表します。 */
export class TaskWriteRetryNotAllowedError extends Error {
  public constructor() {
    super("失敗または確認待ちのexecutionだけ再試行できます。");
    this.name = "TaskWriteRetryNotAllowedError";
  }
}

/** 保存済みplanから別IDの明示再試行を準備します。 */
export function prepareTaskWriteRetry(
  source: ProposalExecution<object>,
  executionId: string,
  createdAt: string,
  fingerprint: TaskWritePayloadFingerprint,
): SaveRetryProposalExecution {
  if (source.state !== "failed" && source.state !== "confirmation_required") {
    throw new TaskWriteRetryNotAllowedError();
  }
  const plan = createTaskWritePlan({
    execution_id: executionId,
    origin: source.plan.origin,
    ...(source.plan.gui_context == null ? {} : { gui_context: source.plan.gui_context }),
    known_references: source.plan.known_references,
    steps: source.plan.steps,
  }, fingerprint);
  return {
    plan,
    ...(source.proposal_id == null ? {} : { proposal_id: source.proposal_id }),
    ...(source.proposal_context == null ? {} : { proposal_context: source.proposal_context }),
    retry_of_execution_id: source.execution_id,
    created_at: createdAt,
  };
}
