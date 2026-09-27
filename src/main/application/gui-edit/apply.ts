import { z } from "zod";
import type { ProposalExecution, ProposalExecutionRepository } from "../common/ports/proposal-execution-repository";
import type { TaskWriteSynchronizationFailureCode } from "../common/ports/asana-task-write";
import type { TaskWritePayloadFingerprint } from "../common/task-write-plan";
import { gidSchema, identifierSchema, dateSchema } from "../../domain/task-write-values";
import type { GuiTaskWriteResult } from "../common/gui-task-write-result";
import { guiExternalBaseline } from "./external-baseline";
import {
  guiStatusBaselineMatches,
  guiStatusNeedsRepair,
  planGuiStatusRepair,
  type GuiStatus,
} from "./status-repair";
import { planGuiActivity, planGuiEditOperation, planGuiRepair, type GuiEditInput } from "./write-plan";

const taskSchema = z.object({
  gid: gidSchema,
  name: z.string(),
  notes: z.string(),
  completed: z.boolean(),
  due_on: dateSchema.nullable(),
  due_at: z.iso.datetime({ offset: true }).nullable(),
  parent: z.object({ gid: gidSchema }).passthrough().nullable(),
  memberships: z.array(z.object({
    project: z.object({ gid: gidSchema }).passthrough(),
    section: z.object({ gid: gidSchema }).passthrough().nullable(),
  }).passthrough()),
  tags: z.array(z.object({ name: z.string() }).passthrough()),
  external: z.object({ gid: z.string(), data: z.string() }).passthrough().nullable(),
}).passthrough();

const inputSchema = z.object({
  task_gid: gidSchema,
  project_gid: gidSchema,
  workspace_gid: gidSchema,
  device_id: identifierSchema,
  created_via: identifierSchema,
  activity_date: dateSchema,
  baseline_task: taskSchema,
  operation: z.object({ kind: z.string() }).passthrough(),
}).passthrough();

export type GuiEditResult =
  | { readonly operation_id: string; readonly task_gid: string; readonly outcome: "applied"; readonly reason_code: "applied" }
  | { readonly operation_id: string; readonly task_gid: string; readonly outcome: "already_applied"; readonly reason_code: "already_applied" }
  | { readonly operation_id: string; readonly task_gid: string; readonly outcome: "conflict"; readonly reason_code: "baseline_changed" | "relationship_cycle" | "external_unreadable" | "external_identity_mismatch"; readonly side_effect: "none" }
  | { readonly operation_id: string; readonly task_gid: string; readonly outcome: "rejected"; readonly reason_code: "offline" }
  | { readonly operation_id: string; readonly task_gid: string; readonly outcome: "recovery_required"; readonly reason_code: "local_resync_required"; readonly write_outcome: "applied" | "already_applied"; readonly sync_error_code: TaskWriteSynchronizationFailureCode };

export type GuiEditExecutionPort = {
  readonly repository: Pick<ProposalExecutionRepository<GuiTaskWriteResult>, "save" | "getIncomplete">;
  readonly engine: { run(executionId: string, signal: AbortSignal): Promise<ProposalExecution<GuiTaskWriteResult>> };
  readonly createId: () => string;
  readonly now: () => string;
  readonly fingerprint: TaskWritePayloadFingerprint;
};

export type GuiEditDependencies = {
  isOnline(): boolean;
  readTask(taskGid: string, signal: AbortSignal): Promise<unknown>;
  validateRelation(
    request: { readonly kind: "dependencies"; readonly task_gid: string; readonly dependencies: readonly { readonly task_gid: string; readonly scope: "full" | "partial"; readonly source: string }[] }
      | { readonly kind: "parent"; readonly task_gid: string; readonly parent_gid: string | null },
    signal: AbortSignal,
  ): Promise<{ readonly kind: "valid" } | { readonly kind: "conflict"; readonly reason_code: "relationship_cycle" }>;
};

function statusTarget(input: GuiEditInput): GuiStatus | undefined {
  switch (input.operation.kind) {
    case "set_status":
    case "restore": return input.operation.value;
    case "complete": return "completed";
    case "withdraw": return "withdrawn";
    default: return undefined;
  }
}

function requiresExternal(input: GuiEditInput): boolean {
  if (input.operation.kind === "complete" || input.operation.kind === "withdraw") return false;
  if (input.operation.kind === "set_status") {
    return input.operation.value !== "completed" && input.operation.value !== "withdrawn";
  }
  return true;
}

function conflict(
  input: GuiEditInput,
  operationId: string,
  reasonCode: "baseline_changed" | "relationship_cycle" | "external_unreadable" | "external_identity_mismatch",
): GuiEditResult {
  return { operation_id: operationId, task_gid: input.task_gid,
    outcome: "conflict", reason_code: reasonCode, side_effect: "none" };
}

function projectExecution(execution: ProposalExecution<GuiTaskWriteResult>): GuiEditResult {
  const context = execution.plan.gui_context;
  if (execution.plan.origin !== "gui-edit" || context == null) {
    throw new Error("GUI編集executionの保存文脈がありません。");
  }
  if (execution.state === "succeeded") {
    if (execution.result.kind !== "gui-edit"
      || execution.result.operation_id !== context.operation_id || execution.result.task_gid !== context.task_gid) {
      throw new Error("保存済みGUI編集結果がplanと一致しません。");
    }
    return execution.result.outcome === "applied"
      ? { operation_id: context.operation_id, task_gid: context.task_gid, outcome: "applied", reason_code: "applied" }
      : { operation_id: context.operation_id, task_gid: context.task_gid, outcome: "already_applied", reason_code: "already_applied" };
  }
  const stopped = execution.steps.find((step) => step.state === "failed" || step.state === "confirmation_required");
  if (stopped?.state === "failed" && stopped.descriptor.kind === "proposal_operation_check") {
    return { operation_id: context.operation_id, task_gid: context.task_gid,
      outcome: "conflict", reason_code: "baseline_changed", side_effect: "none" };
  }
  if (stopped?.state === "confirmation_required" && stopped.descriptor.kind === "local_synchronize"
    && stopped.sync_error_code != null) {
    const applied = execution.steps.some((step) => step.state === "succeeded"
      && step.receipt.kind === "asana_write" && step.receipt.write_performed === true);
    return { operation_id: context.operation_id, task_gid: context.task_gid,
      outcome: "recovery_required", reason_code: "local_resync_required",
      write_outcome: applied ? "applied" : "already_applied", sync_error_code: stopped.sync_error_code };
  }
  if (stopped == null) throw new Error("GUI編集executionが未完了のまま残りました。");
  throw new Error(`GUI編集の保存済みstepが停止しました。エラーID: ${stopped.error_id}`);
}

/** GUI直接編集を保存済みplanとして同じengineで適用します。 */
export async function applyGuiTaskWrite(
  input: GuiEditInput,
  port: GuiEditExecutionPort,
  dependencies: GuiEditDependencies,
  signal: AbortSignal,
): Promise<GuiEditResult> {
  signal.throwIfAborted();
  inputSchema.parse(input);
  if (input.baseline_task.gid !== input.task_gid) throw new Error("GUI編集の基準タスクGIDが一致しません。");
  const operationId = identifierSchema.parse(port.createId());
  if (!dependencies.isOnline()) {
    return { operation_id: operationId, task_gid: input.task_gid, outcome: "rejected", reason_code: "offline" };
  }
  const executionId = identifierSchema.parse(port.createId());
  const targetStatus = statusTarget(input);
  let plan;
  if (targetStatus != null && guiStatusNeedsRepair(input.baseline_task, input.project_gid, input.section_gids)) {
    const current = taskSchema.parse(await dependencies.readTask(input.task_gid, signal));
    if (current.gid !== input.task_gid || !guiStatusBaselineMatches(input.baseline_task, current, input.project_gid)) {
      return conflict(input, operationId, "baseline_changed");
    }
    let repairExternal: Extract<ReturnType<typeof guiExternalBaseline>, { readonly kind: "valid" }> | undefined;
    if (targetStatus === "not_started" || targetStatus === "in_progress") {
      const baselineExternal = guiExternalBaseline(input.baseline_task);
      if (baselineExternal.kind === "conflict") return conflict(input, operationId, baselineExternal.reason_code);
      const currentExternal = guiExternalBaseline(current);
      if (currentExternal.kind === "conflict") return conflict(input, operationId, currentExternal.reason_code);
      if (currentExternal.baseline.external_gid !== baselineExternal.baseline.external_gid
        || currentExternal.baseline.data.id !== baselineExternal.baseline.data.id) {
        return conflict(input, operationId, "external_identity_mismatch");
      }
      repairExternal = currentExternal;
    }
    const activityDate = repairExternal == null || repairExternal.baseline.data.activity_anchor_on <= input.activity_date
      ? input.activity_date
      : repairExternal.baseline.data.activity_anchor_on;
    const steps = planGuiStatusRepair(current, input.project_gid, input.section_gids,
      targetStatus, input.task_gid, operationId, repairExternal?.baseline, activityDate, input.device_id);
    plan = planGuiRepair(input, executionId, operationId, steps, port.fingerprint);
  } else {
    const external = guiExternalBaseline(input.baseline_task);
    if (requiresExternal(input) && external.kind === "conflict") {
      return conflict(input, operationId, external.reason_code);
    }
    if (input.operation.kind === "set_dependencies" || input.operation.kind === "set_parent") {
      const relation = input.operation.kind === "set_dependencies"
        ? { kind: "dependencies" as const, task_gid: input.task_gid, dependencies: input.operation.value }
        : { kind: "parent" as const, task_gid: input.task_gid,
          parent_gid: input.operation.value.kind === "absent" ? null : input.operation.value.gid };
      const checked = await dependencies.validateRelation(relation, signal);
      if (checked.kind === "conflict") return conflict(input, operationId, "relationship_cycle");
    }
    if (input.operation.kind === "mark_activity") {
      if (external.kind !== "valid") throw new Error("活動記録にCustom external dataの基準がありません。");
      const current = taskSchema.parse(await dependencies.readTask(input.task_gid, signal));
      if (current.gid !== input.task_gid
        || current.memberships.filter((membership) => membership.project.gid === input.project_gid).length !== 1) {
        return conflict(input, operationId, "baseline_changed");
      }
      const currentExternal = guiExternalBaseline(current);
      if (currentExternal.kind === "conflict") return conflict(input, operationId, currentExternal.reason_code);
      if (currentExternal.baseline.external_gid !== external.baseline.external_gid
        || currentExternal.baseline.data.id !== external.baseline.data.id) {
        return conflict(input, operationId, "external_identity_mismatch");
      }
      plan = planGuiActivity(input, executionId, operationId, currentExternal, port.fingerprint);
    } else {
      plan = planGuiEditOperation(input, executionId, operationId,
        external.kind === "valid" ? external : undefined, port.fingerprint);
    }
  }
  port.repository.save({ plan, created_at: port.now() });
  return projectExecution(await port.engine.run(executionId, signal));
}

/** 保存済みGUI編集を同じengineの読戻し経路で再開します。 */
export async function recoverGuiTaskWrites(port: GuiEditExecutionPort, signal: AbortSignal): Promise<void> {
  for (const execution of port.repository.getIncomplete()) {
    if (execution.plan.origin !== "gui-edit") continue;
    signal.throwIfAborted();
    const recovered = await port.engine.run(execution.execution_id, signal);
    if (recovered.state === "planned" || recovered.state === "running") {
      throw new Error("GUI編集executionが再開後も未完了です。");
    }
    if (recovered.state === "succeeded") projectExecution(recovered);
  }
}
