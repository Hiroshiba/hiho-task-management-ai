import type { StoredProposalExecutionPort } from "./apply-stored-proposal";
import { projectStoredProposalResult } from "./stored-proposal-result";

type RecoveryApplication = ReturnType<typeof projectStoredProposalResult>;

export type StoredProposalRecoveryResult = {
  readonly applications: readonly RecoveryApplication[];
  readonly unresolved_journals: readonly {
    readonly proposal_id: string;
    readonly operation_id: string;
    readonly outcome: "unknown";
    readonly reason_code: "recovery_required" | "recovery_context_missing";
  }[];
};

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
    applications.push(projectStoredProposalResult(recovered));
  }
  const unresolved: StoredProposalRecoveryResult["unresolved_journals"][number][] = [];
  for (const legacy of port.historyRepository.getIncomplete()) {
    if (legacy.kind === "rejected") {
      unresolved.push({
        proposal_id: legacy.proposal_id,
        operation_id: legacy.operation_id,
        outcome: "unknown",
        reason_code: "recovery_context_missing",
      });
      continue;
    }
    for (const step of legacy.history.steps) {
      if (step.state !== "confirmation_required") continue;
      unresolved.push({
        proposal_id: legacy.history.proposal_id,
        operation_id: step.operation_id,
        outcome: "unknown",
        reason_code: "recovery_required",
      });
    }
  }
  return { applications, unresolved_journals: unresolved };
}
