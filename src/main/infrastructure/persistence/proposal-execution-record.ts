import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseProposalExecutionContext,
  type ProposalExecutionContext,
} from "../../application/common/ports/proposal-execution-context";
import type {
  ProposalExecution,
  ProposalExecutionStep,
} from "../../application/common/ports/proposal-execution-repository";
import { canonicalizeTaskWriteJson } from "../../domain/task-write-values";

const identifierSchema = z.string().min(1).regex(/^\S+$/u);
const timestampSchema = z.iso.datetime({ offset: true });
const errorIdSchema = z.uuid();
const stateSchema = z.enum([
  "planned",
  "running",
  "succeeded",
  "failed",
  "confirmation_required",
]);

export const executionRowSchema = z.object({
  execution_id: identifierSchema,
  proposal_id: identifierSchema.nullable(),
  retry_of_execution_id: identifierSchema.nullable(),
  format_version: z.literal(1),
  origin: z.enum(["proposal", "gui-edit"]),
  plan_json: z.string(),
  plan_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  context_json: z.string().nullable(),
  context_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  state: stateSchema,
  error_id: errorIdSchema.nullable(),
  result_json: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
}).strict();

export const executionStepRowSchema = z.object({
  execution_id: identifierSchema,
  step_id: identifierSchema,
  step_order: z.number().int().nonnegative(),
  kind: identifierSchema,
  executor_version: z.number().int().positive(),
  payload_fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  state: stateSchema,
  attempt: z.number().int().nonnegative(),
  receipt_json: z.string().nullable(),
  error_id: errorIdSchema.nullable(),
  updated_at: timestampSchema,
}).strict();

export type ExecutionRow = z.infer<typeof executionRowSchema>;
export type ExecutionStepRow = z.infer<typeof executionStepRowSchema>;
export type PlanParser = (value: unknown) => ProposalExecution<object>["plan"];
export type ReceiptParser = (value: unknown) => NonNullable<ProposalExecutionStep["receipt"]>;

/** proposal contextの正規化JSONからfingerprintを作ります。 */
export function fingerprintProposalExecutionContext(context: ProposalExecutionContext): string {
  return createHash("sha256").update(canonicalizeTaskWriteJson(context)).digest("hex");
}

/** 保存済みcontextとplanの操作集合を照合します。 */
export function parseExecutionContext(
  value: unknown,
  plan: ProposalExecution<object>["plan"],
): ProposalExecutionContext | undefined {
  if (plan.origin === "gui-edit") {
    if (value != null) {
      throw new Error("GUI編集executionへproposal contextを指定できません。");
    }
    return undefined;
  }
  const context = parseProposalExecutionContext(value);
  const planOperationIds = new Set(plan.steps.flatMap((step) => step.scope.kind === "operation"
    ? [step.scope.operation_id]
    : []));
  const contextOperationIds = context.groups.flatMap((group) => group.operation_ids);
  if (
    planOperationIds.size !== contextOperationIds.length
    || contextOperationIds.some((operationId) => !planOperationIds.has(operationId))
  ) {
    throw new Error("proposal contextの操作IDが保存済みplanと一致しません。");
  }
  return context;
}

/** 永続JSONを解析し、破損の原因を保持します。 */
export function parseExecutionJson(serialized: string): unknown {
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error("保存済みexecution JSONを解析できません。", { cause: error });
  }
}

function parseStep(
  value: unknown,
  descriptor: ProposalExecutionStep["descriptor"],
  executionId: string,
  index: number,
  parseReceipt: ReceiptParser,
): ProposalExecutionStep {
  const row = executionStepRowSchema.parse(value);
  if (
    row.execution_id !== executionId
    || row.step_id !== descriptor.step_id
    || row.step_order !== index
    || row.kind !== descriptor.kind
    || row.executor_version !== descriptor.executor_version
    || row.payload_fingerprint !== descriptor.payload_fingerprint
  ) {
    throw new Error("保存済みexecution stepとplanが一致しません。");
  }
  const receipt = row.receipt_json == null
    ? undefined
    : parseReceipt(parseExecutionJson(row.receipt_json));
  if (row.state === "planned") {
    if (row.attempt !== 0 || receipt != null || row.error_id != null) {
      throw new Error("未開始stepの保存状態が不正です。");
    }
  } else if (row.state === "running") {
    if (row.attempt === 0 || receipt != null || row.error_id != null) {
      throw new Error("実行中stepの保存状態が不正です。");
    }
  } else if (row.state === "succeeded") {
    const expectedReceiptKind = descriptor.kind === "asana_create_task"
      ? "created_task"
      : descriptor.kind === "local_synchronize"
        ? "local_synchronize"
        : descriptor.kind === "proposal_operation_check"
          ? "proposal_operation_check"
          : "asana_write";
    if (
      row.attempt === 0 || receipt == null || row.error_id != null
      || receipt.step_id !== descriptor.step_id
      || receipt.planned_payload_fingerprint !== descriptor.payload_fingerprint
      || receipt.kind !== expectedReceiptKind
      || (receipt.kind === "created_task"
        && (descriptor.kind !== "asana_create_task"
          || receipt.temporary_ref !== descriptor.payload.target.ref))
    ) {
      throw new Error("成功stepのreceiptがplanと一致しません。");
    }
  } else if (row.attempt === 0 || receipt != null || row.error_id == null) {
    throw new Error("停止stepのerror IDが不正です。");
  }
  const base = { descriptor, attempt: row.attempt, updated_at: row.updated_at };
  if (row.state === "succeeded") {
    if (receipt == null) {
      throw new Error("成功stepのreceiptがありません。");
    }
    return { ...base, state: row.state, receipt };
  }
  if (row.state === "failed" || row.state === "confirmation_required") {
    if (row.error_id == null) {
      throw new Error("停止stepのerror IDがありません。");
    }
    return { ...base, state: row.state, error_id: row.error_id };
  }
  return { ...base, state: row.state };
}

/** executionとstep行を保存済みplanに照らして検証します。 */
export function parseExecutionRecord<Result extends object>(
  executionValue: unknown,
  stepValues: readonly unknown[],
  parsePlan: PlanParser,
  parseReceipt: ReceiptParser,
  parseResult: (value: unknown) => Result,
): ProposalExecution<Result> {
  const row = executionRowSchema.parse(executionValue);
  const plan = parsePlan(parseExecutionJson(row.plan_json));
  const context = parseExecutionContext(
    row.context_json == null ? undefined : parseExecutionJson(row.context_json),
    plan,
  );
  if (
    plan.execution_id !== row.execution_id
    || plan.format_version !== row.format_version
    || plan.origin !== row.origin
    || plan.plan_fingerprint !== row.plan_fingerprint
    || (row.origin === "proposal") !== (row.proposal_id != null)
    || (context == null) !== (row.context_fingerprint == null)
    || (context != null
      && fingerprintProposalExecutionContext(context) !== row.context_fingerprint)
    || row.retry_of_execution_id === row.execution_id
    || stepValues.length !== plan.steps.length
  ) {
    throw new Error("保存済みexecutionとplanが一致しません。");
  }
  const steps = stepValues.map((value, index) => {
    const descriptor = plan.steps[index];
    if (descriptor == null) {
      throw new Error("保存済みexecutionに余分なstepがあります。");
    }
    return parseStep(value, descriptor, row.execution_id, index, parseReceipt);
  });
  for (const [index, step] of steps.entries()) {
    if (step.state !== "succeeded" || step.receipt.kind !== "asana_write"
      || step.receipt.verification_step_id == null) continue;
    const receipt = step.receipt;
    const source = steps.slice(0, index).find((candidate) =>
      candidate.descriptor.step_id === receipt.verification_step_id);
    if (source?.state !== "succeeded"
      || source.receipt.kind !== "proposal_operation_check"
      || source.receipt.outcome !== "already_applied"
      || source.receipt.task_gid !== step.receipt.task_gid
      || source.receipt.observed_state_fingerprint !== step.receipt.observed_state_fingerprint
      || source.descriptor.scope.kind !== "operation"
      || step.descriptor.scope.kind !== "operation"
      || source.descriptor.scope.operation_id !== step.descriptor.scope.operation_id) {
      throw new Error("省略したAsana stepの照合receiptが一致しません。");
    }
  }
  const activeSteps = steps.filter((step) => step.state !== "planned" && step.state !== "succeeded");
  const firstPlanned = steps.findIndex((step) => step.state === "planned");
  const activeIndex = steps.findIndex((step) => step.state !== "planned" && step.state !== "succeeded");
  const invalidOrder = activeIndex >= 0
    ? steps.slice(0, activeIndex).some((step) => step.state !== "succeeded")
      || steps.slice(activeIndex + 1).some((step) => step.state !== "planned")
    : firstPlanned >= 0 && steps.slice(firstPlanned).some((step) => step.state !== "planned");
  if (activeSteps.length > 1 || invalidOrder) {
    throw new Error("保存済みexecutionのstep順序が不正です。");
  }
  const active = activeSteps[0];
  if (
    (row.state === "planned" && steps.some((step) => step.state !== "planned"))
    || (row.state === "running" && (steps.every((step) => step.state === "planned")
      || active?.state === "failed"
      || active?.state === "confirmation_required"))
    || (row.state === "succeeded" && steps.some((step) => step.state !== "succeeded"))
    || ((row.state === "failed" || row.state === "confirmation_required")
      && (active?.state !== row.state || active.error_id !== row.error_id))
    || ((row.state === "planned" || row.state === "running" || row.state === "succeeded")
      && row.error_id != null)
    || ((row.state === "succeeded") !== (row.result_json != null))
  ) {
    throw new Error("保存済みexecutionの状態がstepと一致しません。");
  }
  const result = row.result_json == null
    ? undefined
    : parseResult(parseExecutionJson(row.result_json));
  const base = {
    execution_id: row.execution_id,
    ...(row.proposal_id == null ? {} : { proposal_id: row.proposal_id }),
    ...(row.retry_of_execution_id == null ? {} : { retry_of_execution_id: row.retry_of_execution_id }),
    plan,
    ...(context == null ? {} : { proposal_context: context }),
    created_at: row.created_at,
    updated_at: row.updated_at,
    steps,
  };
  if (row.state === "succeeded") {
    if (result == null) {
      throw new Error("成功executionの最終resultがありません。");
    }
    return { ...base, state: row.state, result };
  }
  if (row.state === "failed" || row.state === "confirmation_required") {
    if (row.error_id == null) {
      throw new Error("停止executionのerror IDがありません。");
    }
    return { ...base, state: row.state, error_id: row.error_id };
  }
  return { ...base, state: row.state };
}
