import { canonicalizeTaskWriteJson } from "../../domain/task-write-values";
import { type ProposalWriteOperation } from "../../domain/proposal-write-operation";
import {
  createTaskWritePlan,
  type TaskWritePayloadFingerprint,
  type TaskWritePlan,
} from "../common/task-write-plan";
import { type TaskWriteStepDraft, type TaskWriteTarget } from "../common/task-write-step";
import { planProposalOperation, type ProposalOperationPlanningContext } from "./operation-manifest";

type PlannedOperation = {
  readonly operation: ProposalWriteOperation;
  readonly context: ProposalOperationPlanningContext;
};

/** 承認済み操作を旧writerと同じ順序の保存用planへまとめます。 */
export function planProposalTaskWrites(
  input: {
    readonly execution_id: string;
    readonly known_references: TaskWritePlan["known_references"];
    readonly operations: readonly PlannedOperation[];
  },
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  if (input.operations.length === 0) {
    throw new Error("write planには操作が1件以上必要です。");
  }
  const operationIds = new Set<string>();
  const steps: TaskWriteStepDraft[] = [];
  const targets = new Map<string, TaskWriteTarget>();
  for (const item of input.operations) {
    const operation = item.operation;
    if (operationIds.has(operation.operation_id)) {
      throw new Error("write planの操作IDが重複しています。");
    }
    operationIds.add(operation.operation_id);
    steps.push(...planProposalOperation(operation, item.context));
    const target: TaskWriteTarget = operation.operation === "create_task"
      ? { kind: "temporary", ref: operation.temporary_ref }
      : operation.target;
    targets.set(canonicalizeTaskWriteJson(target), target);
  }
  steps.push({
    step_id: `${input.execution_id}:sync`,
    scope: { kind: "execution" },
    kind: "local_synchronize",
    payload: {
      targets: [...targets.values()],
      condition: "verified_operation",
    },
  });
  return createTaskWritePlan({
    execution_id: input.execution_id,
    origin: "proposal",
    known_references: input.known_references,
    steps,
  }, fingerprint);
}
