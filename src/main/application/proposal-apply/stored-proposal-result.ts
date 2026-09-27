import type { ProposalExecution, ProposalExecutionRepository } from "../common/ports/proposal-execution-repository";
import type {
  ProposalExecutionContext,
  ProposalPreflightOperationResult,
} from "../common/ports/proposal-execution-context";
import { buildApplicationResult } from "./application-result";
import { createOperationResult } from "./operation-result";
import { latestProposalExecution } from "./latest-proposal-execution";

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
export type StoredProposalApplicationResult = ReturnType<typeof buildApplicationResult<ApplicationOperationResult>> & {
  readonly execution_id?: string;
};

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

function requireProposalContext(
  execution: ProposalExecution<StoredProposalWriteResult>,
): { readonly proposalId: string; readonly context: ProposalExecutionContext } {
  const proposalId = execution.proposal_id;
  const context = execution.proposal_context;
  if (execution.plan.origin !== "proposal" || proposalId == null || context == null) {
    throw new Error("保存済みexecutionの変更案文脈がありません。");
  }
  return { proposalId, context };
}

function contextProposal(context: ProposalExecutionContext): Parameters<typeof buildApplicationResult>[1] {
  return {
    groups: context.groups.map((group) => ({
      group_id: group.group_id,
      atomic: group.atomic,
      operations: group.operation_ids.map((operationId) => ({ operation_id: operationId })),
    })),
  };
}

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

function operationResultFromExecution(
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
): { readonly execution_id: string; readonly operation: StoredExecutionOperationResult | ProposalPreflightOperationResult } | undefined {
  const executions = repository.getByProposal(proposalId);
  const execution = latestProposalExecution(executions);
  if (execution == null) return undefined;
  const { context } = requireProposalContext(execution);
  const group = context.groups.find((item) => item.operation_ids.includes(operationId));
  if (group == null) return undefined;
  const preflight = context.preflight_results.find((item) => item.operation_id === operationId);
  return {
    execution_id: execution.execution_id,
    operation: preflight ?? operationResultFromExecution(execution, group.group_id, operationId),
  };
}

/** 実行対象がない承認結果を既存の適用結果へまとめます。 */
export function projectPreflightProposalResult(
  proposalId: string,
  proposal: SelectedProposal,
  selectedOperationIds: ReadonlySet<string>,
  preflightResults: ReadonlyMap<string, ApplicationOperationResult>,
): StoredProposalApplicationResult {
  return buildApplicationResult(proposalId, proposal, selectedOperationIds, preflightResults);
}

/** 保存済み選択とstep結果から適用結果を再構成します。 */
export function projectStoredProposalResult(
  execution: ProposalExecution<StoredProposalWriteResult>,
): ReturnType<typeof buildApplicationResult<ApplicationOperationResult>> {
  const { proposalId, context } = requireProposalContext(execution);
  const preflight = new Map(context.preflight_results.map((result) => [result.operation_id, result]));
  const results = new Map<string, ApplicationOperationResult>();
  for (const group of context.groups) {
    for (const operationId of group.operation_ids) {
      results.set(operationId, preflight.get(operationId)
        ?? operationResultFromExecution(execution, group.group_id, operationId));
    }
  }
  return buildApplicationResult(proposalId, contextProposal(context), new Set(results.keys()), results);
}

function projectPendingProposalResults(
  execution: ProposalExecution<StoredProposalWriteResult>,
): {
  readonly operation_results: readonly (ProposalPreflightOperationResult | {
    readonly group_id: string;
    readonly operation_id: string;
    readonly outcome: "pending";
  })[];
  readonly group_results: readonly ({
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operation_ids: readonly string[];
    readonly outcome: "pending";
  } | ReturnType<typeof buildApplicationResult<ProposalPreflightOperationResult>>["groups"][number])[];
} {
  const { proposalId, context } = requireProposalContext(execution);
  const preflight = new Map(context.preflight_results.map((result) => [result.operation_id, result]));
  const operationResults: (ProposalPreflightOperationResult | {
    readonly group_id: string;
    readonly operation_id: string;
    readonly outcome: "pending";
  })[] = context.groups.flatMap((group) => group.operation_ids.map((operationId) => {
    const result = preflight.get(operationId);
    return result ?? { group_id: group.group_id, operation_id: operationId, outcome: "pending" };
  }));
  const groupResults: ({
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operation_ids: readonly string[];
    readonly outcome: "pending";
  } | ReturnType<typeof buildApplicationResult<ProposalPreflightOperationResult>>["groups"][number])[] = context.groups.map((group) => {
    if (group.operation_ids.some((operationId) => !preflight.has(operationId))) {
      return { ...group, outcome: "pending" };
    }
    const result = buildApplicationResult(proposalId, {
      groups: [{
        group_id: group.group_id,
        atomic: group.atomic,
        operations: group.operation_ids.map((operationId) => ({ operation_id: operationId })),
      }],
    }, new Set(group.operation_ids), preflight).groups[0];
    if (result == null) throw new Error("保存済み事前判定のグループ結果がありません。");
    return result;
  });
  return { operation_results: operationResults, group_results: groupResults };
}

/** 保存済みexecutionの状態に応じた操作とグループ結果を投影します。 */
export function projectProposalExecutionResults(
  execution: ProposalExecution<StoredProposalWriteResult>,
): {
  readonly operation_results: readonly (ApplicationOperationResult | {
    readonly group_id: string;
    readonly operation_id: string;
    readonly outcome: "pending";
  })[];
  readonly group_results: readonly ({
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operation_ids: readonly string[];
    readonly outcome: "pending" | "applied" | "already_applied" | "not_applied" | "partially_applied" | "unknown";
  })[];
} {
  if (execution.state === "planned" || execution.state === "running") {
    return projectPendingProposalResults(execution);
  }
  const projected = projectStoredProposalResult(execution);
  return { operation_results: projected.operations, group_results: projected.groups };
}
