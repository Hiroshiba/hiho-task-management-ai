import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
} from "../common/proposal-application-schemas";
import type { TaskWriteExternalBaseline } from "../common/task-write-step";
import { customExternalDataSchema, parseCustomExternalData } from "../../domain";
import { classifyProposalConflicts, proposalApprovalResultSchema } from "../../domain/proposal-analysis/conflict-classifier";
import { validateSelectedProposalGraph } from "../../domain/proposal-analysis/graph";
import { applyStoredProposal, type StoredProposalExecutionPort } from "./apply-stored-proposal";

/** 承認済み変更案を保存済みplan executorへ渡します。 */
export async function executeStoredProposalApplication(
  input: AsanaProposalApplicationInput,
  port: StoredProposalExecutionPort,
  signal: AbortSignal,
): Promise<AsanaProposalApplicationResult> {
  const validated = asanaProposalApplicationInputSchema.parse(input);
  const baselines = validated.baseline_external_data.map((item) => {
    const parsed = parseCustomExternalData(item.external.data);
    if (parsed.kind !== "valid") {
      throw new Error("承認時のCustom external dataを読み取れません。");
    }
    const baseline = {
      kind: "stored",
      external_gid: item.external.gid,
      data: customExternalDataSchema.parse(parsed.data),
    } satisfies Extract<TaskWriteExternalBaseline, { readonly kind: "stored" }>;
    return { task_gid: item.task_gid, baseline };
  });
  const result = await applyStoredProposal({
    ...validated,
    baseline_external_data: baselines,
  }, proposalApprovalResultSchema.parse(classifyProposalConflicts(validated.approval_input)), (operationIds) => {
    const graph = validateSelectedProposalGraph({
      proposal: validated.approval_input.proposal,
      managed_tasks: validated.approval_input.current_tasks,
      selected_operation_ids: [...operationIds],
      temporary_ref_mappings: validated.approval_input.journal_task_mappings,
    });
    if (graph.kind === "unsafe") {
      throw new Error("適用操作に新しい依存関係または親子関係の循環があります。");
    }
  }, port, signal);
  return asanaProposalApplicationResultSchema.parse(result);
}
