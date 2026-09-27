import type { TaskWriteExecutionContext } from "../common/ports/task-write-executor";
import type { ProposalExecution, ProposalExecutionStep } from "../common/ports/proposal-execution-repository";
import type { TaskWriteReceipt } from "../common/task-write-plan";
import type { TaskWriteTarget } from "../common/task-write-step";

function resolveTarget(target: TaskWriteTarget, references: ReadonlyMap<string, string>): string {
  if (target.kind === "existing") return target.gid;
  const gid = references.get(target.ref);
  if (gid == null) throw new Error("保存済みreceiptに一時参照のタスクGIDがありません。");
  return gid;
}

/** 保存済みreceiptからstep executorへ渡す参照と同期対象を導出します。 */
export function executionContext(
  execution: ProposalExecution<object>,
  forSynchronization: boolean,
): TaskWriteExecutionContext {
  const references = new Map(execution.plan.known_references.map((item) => [item.temporary_ref, item.task_gid]));
  const operationTaskGids = new Map<string, string>();
  const operationProjectGids = new Map<string, string>();
  for (const step of execution.plan.steps) {
    if (step.kind === "proposal_operation_check" && step.scope.kind === "operation") {
      operationProjectGids.set(step.scope.operation_id, step.payload.project_gid);
    }
    if (step.kind === "asana_create_task" && step.scope.kind === "operation") {
      operationProjectGids.set(step.scope.operation_id, step.payload.project_gid);
    }
  }
  for (const step of execution.steps) {
    if (step.state !== "succeeded" || step.descriptor.scope.kind !== "operation") continue;
    if (step.receipt.kind === "created_task") {
      const previous = references.get(step.receipt.temporary_ref);
      if (previous != null && previous !== step.receipt.task_gid) {
        throw new Error("保存済み作成receiptの一時参照が競合しています。");
      }
      references.set(step.receipt.temporary_ref, step.receipt.task_gid);
      operationTaskGids.set(step.descriptor.scope.operation_id, step.receipt.task_gid);
    }
    if (step.receipt.kind === "proposal_operation_check") {
      operationTaskGids.set(step.descriptor.scope.operation_id, step.receipt.task_gid);
    }
  }
  const synchronizationStep = execution.plan.steps.find((step) => step.kind === "local_synchronize");
  if (synchronizationStep?.kind !== "local_synchronize") throw new Error("保存済みplanに後続同期stepがありません。");
  const synchronizationTaskGids = forSynchronization
    ? [...new Set(synchronizationStep.payload.targets.map((target) => resolveTarget(target, references)))].sort()
    : [];
  return {
    execution_id: execution.execution_id,
    plan: execution.plan,
    references,
    operation_task_gids: operationTaskGids,
    operation_project_gids: operationProjectGids,
    synchronization_task_gids: synchronizationTaskGids,
  };
}

/** 最初の未完了stepを保存順で返します。 */
export function firstIncompleteStep(execution: ProposalExecution<object>): ProposalExecutionStep | undefined {
  return execution.steps.find((step) => step.state !== "succeeded");
}

/** 同じ操作の照合stepに保存したreceiptを返します。 */
export function priorCheckReceipt(
  execution: ProposalExecution<object>,
  step: ProposalExecutionStep,
): Extract<TaskWriteReceipt, { readonly kind: "proposal_operation_check" }> | undefined {
  if (step.descriptor.scope.kind !== "operation") return undefined;
  const operationId = step.descriptor.scope.operation_id;
  const check = execution.steps.find((item) => item.descriptor.kind === "proposal_operation_check"
    && item.descriptor.scope.kind === "operation"
    && item.descriptor.scope.operation_id === operationId);
  if (check?.state !== "succeeded" || check.receipt.kind !== "proposal_operation_check") {
    return undefined;
  }
  return check.receipt;
}
