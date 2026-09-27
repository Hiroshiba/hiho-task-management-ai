import { z } from "zod";
import type { ProposalExecution } from "../common/ports/proposal-execution-repository";
import { gidSchema, identifierSchema } from "../../domain/task-write-values";

const operationResultSchema = z.object({
  group_id: identifierSchema,
  operation_id: identifierSchema,
  task_gid: gidSchema,
  outcome: z.enum(["applied", "already_applied"]),
  reason_code: z.enum(["applied", "already_applied"]),
}).strict().refine((result) => result.outcome === result.reason_code);

const groupResultSchema = z.object({
  group_id: identifierSchema,
  atomic: z.boolean(),
  operation_ids: z.array(identifierSchema).min(1),
  outcome: z.enum(["applied", "already_applied"]),
}).strict();

/** proposal適用結果の保存値を検証します。 */
export const proposalTaskWriteResultSchema = z.object({
  proposal_id: identifierSchema,
  outcome: z.enum(["applied", "already_applied"]),
  operations: z.array(operationResultSchema).min(1),
  groups: z.array(groupResultSchema).min(1),
}).strict();

type OperationResult = {
  readonly group_id: string;
  readonly operation_id: string;
  readonly task_gid: string;
  readonly outcome: "applied" | "already_applied";
  readonly reason_code: "applied" | "already_applied";
};

type GroupResult = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly operation_ids: readonly string[];
  readonly outcome: "applied" | "already_applied";
};

export type ProposalTaskWriteResult = {
  readonly proposal_id: string;
  readonly outcome: "applied" | "already_applied";
  readonly operations: readonly OperationResult[];
  readonly groups: readonly GroupResult[];
};

/** 保存済みgroup contextとstep receiptからproposal適用結果を再構成します。 */
export function buildProposalExecutionResult(
  execution: ProposalExecution<object>,
): ProposalTaskWriteResult {
  const proposalId = execution.proposal_id;
  const context = execution.proposal_context;
  if (proposalId == null || context == null) {
    throw new Error("proposal適用結果に保存済みcontextがありません。");
  }
  if (execution.steps.some((step) => step.state !== "succeeded")) {
    throw new Error("未完了stepからproposal適用結果を作成できません。");
  }
  const preflightIds = new Set(context.preflight_results.map((result) => result.operation_id));
  const operations: OperationResult[] = [];
  const groups: GroupResult[] = [];
  for (const group of context.groups) {
    const groupOperations: OperationResult[] = [];
    const operationIds = group.operation_ids.filter((operationId) => !preflightIds.has(operationId));
    for (const operationId of operationIds) {
      const operationSteps = execution.steps.filter((step) =>
        step.descriptor.scope.kind === "operation"
        && step.descriptor.scope.operation_id === operationId);
      const check = operationSteps.find((step) => step.descriptor.kind === "proposal_operation_check");
      const create = operationSteps.find((step) => step.descriptor.kind === "asana_create_task");
      const source = check ?? create;
      if (source?.state !== "succeeded") {
        throw new Error("操作の対象GIDを保存済みreceiptから取得できません。");
      }
      const receipt = source.receipt;
      if (receipt.kind !== "proposal_operation_check" && receipt.kind !== "created_task") {
        throw new Error("操作の先頭receiptがplanと一致しません。");
      }
      if (receipt.kind === "proposal_operation_check" && receipt.outcome === "needs_write"
        && !operationSteps.some((step) => step.descriptor.kind !== "proposal_operation_check")) {
        throw new Error("未適用の操作に成功済み書き込みstepがありません。");
      }
      const outcome = receipt.kind === "proposal_operation_check"
        && receipt.outcome === "already_applied"
        ? "already_applied"
        : "applied";
      groupOperations.push({
        group_id: group.group_id,
        operation_id: operationId,
        task_gid: receipt.task_gid,
        outcome,
        reason_code: outcome,
      });
    }
    if (groupOperations.length === 0) continue;
    operations.push(...groupOperations);
    groups.push({
      group_id: group.group_id,
      atomic: group.atomic,
      operation_ids: operationIds,
      outcome: groupOperations.some((operation) => operation.outcome === "applied")
        ? "applied"
        : "already_applied",
    });
  }
  return proposalTaskWriteResultSchema.parse({
    proposal_id: proposalId,
    outcome: groups.some((group) => group.outcome === "applied")
      ? "applied"
      : "already_applied",
    operations,
    groups,
  });
}
