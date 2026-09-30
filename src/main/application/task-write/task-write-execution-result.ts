import { z } from "zod";
import type { ProposalExecution } from "../common/ports/proposal-execution-repository";
import { buildGuiExecutionResult, guiTaskWriteResultSchema } from "../common/gui-task-write-result";
import { buildProposalExecutionResult, proposalTaskWriteResultSchema } from "./proposal-execution-result";

/** 両実行元の保存済み成功結果を検証します。 */
export const taskWriteExecutionResultSchema = z.union([
  proposalTaskWriteResultSchema,
  guiTaskWriteResultSchema,
]);

export type TaskWriteExecutionResult = z.infer<typeof taskWriteExecutionResultSchema>;

/** 保存済みplanの実行元に対応する成功結果を組み立てます。 */
export function buildTaskWriteExecutionResult(
  execution: ProposalExecution<object>,
): TaskWriteExecutionResult {
  return taskWriteExecutionResultSchema.parse(execution.plan.origin === "proposal"
    ? buildProposalExecutionResult(execution)
    : buildGuiExecutionResult(execution));
}
