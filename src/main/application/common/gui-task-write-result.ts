import { z } from "zod";
import type { ProposalExecution } from "./ports/proposal-execution-repository";
import { gidSchema, identifierSchema } from "../../domain/task-write-values";

/** GUI編集の保存済み成功結果を検証します。 */
export const guiTaskWriteResultSchema = z.object({
  kind: z.literal("gui-edit"),
  operation_id: identifierSchema,
  task_gid: gidSchema,
  outcome: z.enum(["applied", "already_applied"]),
}).strict();

export type GuiTaskWriteResult = z.infer<typeof guiTaskWriteResultSchema>;

/** 保存済みGUI文脈と書き込みreceiptから成功結果を再構成します。 */
export function buildGuiExecutionResult(execution: ProposalExecution<object>): GuiTaskWriteResult {
  const context = execution.plan.gui_context;
  if (execution.plan.origin !== "gui-edit" || context == null) {
    throw new Error("GUI編集の保存済み文脈がありません。");
  }
  if (execution.steps.some((step) => step.state !== "succeeded")) {
    throw new Error("未完了stepからGUI編集結果を作成できません。");
  }
  const performed = execution.steps.some((step) =>
    step.state === "succeeded"
    && step.receipt.kind === "asana_write"
    && step.receipt.write_performed === true);
  return guiTaskWriteResultSchema.parse({
    kind: "gui-edit",
    operation_id: context.operation_id,
    task_gid: context.task_gid,
    outcome: performed ? "applied" : "already_applied",
  });
}
