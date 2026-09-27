import type { ProposalExecution, ProposalExecutionRepository } from "../common/ports/proposal-execution-repository";
import { buildApplicationResult } from "./application-result";
import { createOperationResult } from "./operation-result";

export type StoredProposalWriteResult = {
  readonly proposal_id: string;
  readonly operations: readonly {
    readonly group_id: string;
    readonly operation_id: string;
    readonly task_gid: string;
    readonly outcome: "applied" | "already_applied";
    readonly reason_code: "applied" | "already_applied";
  }[];
};

type ProposalOperation = {
  readonly operation_id: string;
  readonly operation: string;
  readonly temporary_ref?: string;
  readonly target?: { readonly kind: "existing"; readonly gid: string } | { readonly kind: "temporary"; readonly ref: string };
};

export type SelectedProposal = {
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operations: readonly ProposalOperation[];
  }[];
};

export type ApplicationOperationResult = ReturnType<typeof createOperationResult>;
export type StoredProposalApplicationResult = ReturnType<typeof buildApplicationResult<ApplicationOperationResult>>;

type StoredExecutionOperationResult = {
  readonly group_id: string;
  readonly operation_id: string;
  readonly task_gid?: string;
} & (
  | { readonly outcome: "applied"; readonly reason_code: "applied" }
  | { readonly outcome: "already_applied"; readonly reason_code: "already_applied" }
  | { readonly outcome: "not_applied"; readonly reason_code: "writer_conflict" | "external_api_failed" }
  | { readonly outcome: "unknown"; readonly reason_code: "recovery_required" | "local_resync_required" }
);

function receiptTaskGid(
  steps: ProposalExecution<StoredProposalWriteResult>["steps"],
): string | undefined {
  for (const step of steps) {
    if (step.state !== "succeeded") continue;
    if (step.receipt.kind === "proposal_operation_check"
      || step.receipt.kind === "created_task"
      || step.receipt.kind === "asana_write") return step.receipt.task_gid;
  }
  return undefined;
}

/** 保存済みstepの結果を既存の操作結果へ投影します。 */
export function operationResultFromExecution(
  execution: ProposalExecution<StoredProposalWriteResult>,
  groupId: string,
  operationId: string,
): StoredExecutionOperationResult {
  if (execution.state === "succeeded") {
    const result = execution.result.operations.find((item) => item.operation_id === operationId);
    if (result == null || result.group_id !== groupId) {
      throw new Error("保存済み適用結果の操作が一致しません。");
    }
    if (result.outcome !== result.reason_code) {
      throw new Error("保存済み適用結果の操作結果と理由が一致しません。");
    }
    return result.outcome === "applied"
      ? createOperationResult(groupId, operationId, "applied", "applied", result.task_gid)
      : createOperationResult(groupId, operationId, "already_applied", "already_applied", result.task_gid);
  }
  const steps = execution.steps.filter((step) =>
    step.descriptor.scope.kind === "operation"
    && step.descriptor.scope.operation_id === operationId);
  if (steps.length === 0) {
    throw new Error("保存済みplanの操作が見つかりません。");
  }
  const taskGid = receiptTaskGid(steps);
  const check = steps.find((step) => step.descriptor.kind === "proposal_operation_check");
  const synchronization = execution.steps.find((step) => step.descriptor.kind === "local_synchronize");
  if (synchronization == null) {
    throw new Error("保存済みplanに後続同期stepがありません。");
  }
  if (synchronization.state === "confirmation_required" || synchronization.state === "failed") {
    return createOperationResult(groupId, operationId, "unknown", "local_resync_required", taskGid);
  }
  if (steps.every((step) => step.state === "succeeded")) {
    if (taskGid == null) throw new Error("完了操作の対象GIDがありません。");
    const alreadyApplied = check?.state === "succeeded"
      && check.receipt.kind === "proposal_operation_check"
      && check.receipt.outcome === "already_applied";
    return alreadyApplied
      ? createOperationResult(groupId, operationId, "already_applied", "already_applied", taskGid)
      : createOperationResult(groupId, operationId, "applied", "applied", taskGid);
  }
  const incomplete = steps.find((step) => step.state !== "succeeded");
  if (incomplete == null) throw new Error("未完了操作のstepがありません。");
  const hasConfirmedWrite = steps.some((step) =>
    step.state === "succeeded"
    && step.descriptor.kind !== "proposal_operation_check");
  if (incomplete.state === "confirmation_required" || incomplete.state === "running" || hasConfirmedWrite) {
    return createOperationResult(groupId, operationId, "unknown", "recovery_required", taskGid);
  }
  if (incomplete.state === "failed" && incomplete.descriptor.kind === "proposal_operation_check") {
    return createOperationResult(groupId, operationId, "not_applied", "writer_conflict", taskGid);
  }
  return createOperationResult(groupId, operationId, "not_applied", "external_api_failed", taskGid);
}

/** 保存済みexecutionから指定操作の状態を読み出します。 */
export function getStoredProposalOperationStatus(
  repository: Pick<ProposalExecutionRepository<StoredProposalWriteResult>, "getByProposal">,
  proposalId: string,
  operationId: string,
): { readonly execution_id: string; readonly operation: StoredExecutionOperationResult } | undefined {
  const executions = repository.getByProposal(proposalId);
  if (executions.length > 1) {
    throw new Error("同じ変更案の保存済みexecutionが複数あります。");
  }
  const execution = executions[0];
  if (execution == null) return undefined;
  const context = execution.proposal_context;
  if (context == null) throw new Error("保存済みexecutionの変更案文脈がありません。");
  const group = context.groups.find((item) => item.operation_ids.includes(operationId));
  if (group == null) return undefined;
  return {
    execution_id: execution.execution_id,
    operation: operationResultFromExecution(execution, group.group_id, operationId),
  };
}

/** 承認結果と保存済みstepを既存の適用結果DTOへまとめます。 */
export function projectStoredProposalResult(
  proposalId: string,
  proposal: SelectedProposal,
  selectedOperationIds: ReadonlySet<string>,
  preflightResults: ReadonlyMap<string, ApplicationOperationResult>,
  execution: ProposalExecution<StoredProposalWriteResult> | undefined,
): StoredProposalApplicationResult {
  const results = new Map(preflightResults);
  if (execution != null) {
    const context = execution.proposal_context;
    if (context == null || execution.proposal_id !== proposalId) {
      throw new Error("保存済みexecutionの変更案文脈が一致しません。");
    }
    for (const group of context.groups) {
      for (const operationId of group.operation_ids) {
        if (results.has(operationId)) {
          throw new Error("保存済み操作と承認競合結果が重複しています。");
        }
        results.set(operationId, operationResultFromExecution(execution, group.group_id, operationId));
      }
    }
  }
  return buildApplicationResult(proposalId, proposal, selectedOperationIds, results);
}
