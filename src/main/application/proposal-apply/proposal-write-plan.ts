import { canonicalizeTaskWriteJson } from "../../domain/task-write-values";
import { proposalWriteOperationSchema, type ProposalWriteOperation } from "../../domain/proposal-write-operation";
import {
  createTaskWritePlan,
  type TaskWritePayloadFingerprint,
  type TaskWritePlan,
} from "../common/task-write-plan";
import { type TaskWriteStepDraft, type TaskWriteTarget } from "../common/task-write-step";
import { planProposalOperation, type ProposalOperationPlanningContext } from "../common/task-write-operation-manifest";
import { orderApplicableContexts } from "./operation-order";
import { createTaskTemporaryReferences } from "./recovery-references";

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
  const mappings = new Map(input.known_references.map((reference) => [reference.temporary_ref, reference.task_gid]));
  const validatedOperations = input.operations.map((item) => ({
    ...item,
    operation: proposalWriteOperationSchema.parse(item.operation),
  }));
  const orderedOperations = orderApplicableContexts(validatedOperations, mappings, createTaskTemporaryReferences);
  for (const item of orderedOperations) {
    const operation = item.operation;
    if (operationIds.has(operation.operation_id)) {
      throw new Error("write planの操作IDが重複しています。");
    }
    operationIds.add(operation.operation_id);
    const effects = planProposalOperation(operation, item.context);
    if (operation.operation !== "create_task") {
      steps.push({
        step_id: `${operation.operation_id}:check`,
        scope: { kind: "operation", operation_id: operation.operation_id },
        kind: "proposal_operation_check",
        payload: {
          operation,
          project_gid: item.context.project_gid,
          workspace_gid: item.context.workspace_gid,
          section_gids: item.context.section_gids,
          activity_date: item.context.activity_date,
          ...(item.context.external_baseline == null ? {} : { external_baseline: item.context.external_baseline }),
        },
      });
    }
    steps.push(...effects);
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
