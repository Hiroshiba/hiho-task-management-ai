import type { ProposalExecution } from "../common/ports/proposal-execution-repository";
import { buildApplicationResult } from "./application-result";
import type { StoredProposalExecutionPort } from "./apply-stored-proposal";
import { operationResultFromExecution, type StoredProposalWriteResult } from "./stored-proposal-result";

type RecoveryApplication = ReturnType<typeof buildApplicationResult<ReturnType<typeof operationResultFromExecution>>>;

export type StoredProposalRecoveryResult = {
  readonly applications: readonly RecoveryApplication[];
  readonly unresolved_journals: readonly {
    readonly proposal_id: string;
    readonly operation_id: string;
    readonly outcome: "unknown";
    readonly reason_code: "recovery_required" | "recovery_context_missing";
  }[];
};

function projectExecution(execution: ProposalExecution<StoredProposalWriteResult>): RecoveryApplication {
  const proposalId = execution.proposal_id;
  const context = execution.proposal_context;
  if (proposalId == null || context == null) {
    throw new Error("復旧するproposal executionの保存済み文脈がありません。");
  }
  const proposal = {
    groups: context.groups.map((group) => ({
      group_id: group.group_id,
      atomic: group.atomic,
      operations: group.operation_ids.map((operationId) => ({ operation_id: operationId })),
    })),
  };
  const selected = new Set(context.groups.flatMap((group) => group.operation_ids));
  const results = new Map(context.groups.flatMap((group) => group.operation_ids.map((operationId) => [
    operationId,
    operationResultFromExecution(execution, group.group_id, operationId),
  ] as const)));
  return buildApplicationResult(proposalId, proposal, selected, results);
}

/** 保存済みexecutionを共通engineで再開し、旧形式は読取専用で未確定結果へ投影します。 */
export async function recoverStoredProposals(
  port: StoredProposalExecutionPort,
  signal: AbortSignal,
): Promise<StoredProposalRecoveryResult> {
  const applications: RecoveryApplication[] = [];
  for (const execution of port.repository.getIncomplete()) {
    signal.throwIfAborted();
    const recovered = await port.engine.run(execution.execution_id, signal);
    if (recovered.state === "planned" || recovered.state === "running") {
      throw new Error("復旧中のproposal executionが未完了のまま残りました。");
    }
    applications.push(projectExecution(recovered));
  }
  const unresolved: StoredProposalRecoveryResult["unresolved_journals"][number][] = [];
  for (const legacy of port.legacyRepository.getIncomplete()) {
    if (legacy.kind === "rejected") {
      if (legacy.operation_id == null) {
        throw new Error("旧適用ジャーナルの操作IDを復旧表示へ変換できません。");
      }
      unresolved.push({
        proposal_id: legacy.proposal_id,
        operation_id: legacy.operation_id,
        outcome: "unknown",
        reason_code: "recovery_context_missing",
      });
      continue;
    }
    for (const step of legacy.execution.steps) {
      if (step.state !== "confirmation_required") continue;
      unresolved.push({
        proposal_id: legacy.execution.proposal_id,
        operation_id: step.operation_id,
        outcome: "unknown",
        reason_code: "recovery_required",
      });
    }
  }
  return { applications, unresolved_journals: unresolved };
}
