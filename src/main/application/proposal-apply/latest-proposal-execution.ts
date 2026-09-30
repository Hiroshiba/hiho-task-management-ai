import type { ProposalExecution } from "../common/ports/proposal-execution-repository";

/** 同じ変更案の再試行系列から最後のexecutionを選びます。 */
export function latestProposalExecution<Result extends object>(
  executions: readonly ProposalExecution<Result>[],
): ProposalExecution<Result> | undefined {
  if (executions.length === 0) return undefined;
  const byId = new Map(executions.map((execution) => [execution.execution_id, execution]));
  const retriedIds = new Set<string>();
  for (const execution of executions) {
    const sourceId = execution.retry_of_execution_id;
    if (sourceId == null) continue;
    const source = byId.get(sourceId);
    if (source == null || source.proposal_id !== execution.proposal_id
      || source.state !== "failed" && source.state !== "confirmation_required"
      || retriedIds.has(sourceId)) {
      throw new Error("変更案の保存済みexecution再試行系列が不正です。");
    }
    retriedIds.add(sourceId);
  }
  const latest = executions.filter((execution) => !retriedIds.has(execution.execution_id));
  if (latest.length !== 1) {
    throw new Error("変更案の保存済みexecution再試行系列が分岐しています。");
  }
  return latest[0];
}
