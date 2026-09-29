import { asanaTaskResponseSchema, canonicalizeJson, gidSchema, ingestAsanaExternalData, normalizeAsanaSnapshot, serializeCustomExternalData, taskSchema, type AsanaTaskResponse } from "../../domain";
import type { BaselineSnapshot } from "../../domain/schemas";
import { identifierSchema } from "../../domain/primitives";
import type { AsanaProposalApplicationInput } from "../common/proposal-application-schemas";
import { collectApprovalProjectTasks } from "./approval-task-read";

type ApprovalPreparationRequest = {
  readonly proposal_id: string;
  readonly proposal: AsanaProposalApplicationInput["approval_input"]["proposal"];
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly graph_validation_result: AsanaProposalApplicationInput["approval_input"]["graph_validation_result"];
  readonly selected_operation_ids: readonly string[];
  readonly created_via: string;
};

type ApprovalContext = Pick<AsanaProposalApplicationInput,
  "project_gid" | "workspace_gid" | "section_gids" | "device_id">;

type ApprovalInputDependencies = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly assertWritesAllowed: () => void;
  readonly requireContext: () => ApprovalContext;
  readonly appVersion: unknown;
  readonly today: () => string;
  readonly readClient: {
    listProjectTasks(projectGid: string, signal: AbortSignal): Promise<readonly AsanaTaskResponse[]>;
    listSubtasks(taskGid: string, signal: AbortSignal): Promise<readonly AsanaTaskResponse[]>;
  };
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function externalDataIsValid(task: AsanaTaskResponse): boolean {
  const ingestion = ingestAsanaExternalData(task);
  return task.external != null
    && ingestion.kind === "valid"
    && task.external.gid === `TaskHub:v1:task:${ingestion.data.id}`
    && task.external.data === serializeCustomExternalData(ingestion.data);
}

/** 承認直前のAsana再取得結果から適用入力を準備します。 */
export async function prepareProposalApprovalInput(
  input: ApprovalPreparationRequest,
  dependencies: ApprovalInputDependencies,
  signal: AbortSignal,
): Promise<AsanaProposalApplicationInput> {
  dependencies.validateAbortSignal(signal);
  dependencies.assertWritesAllowed();
  const context = dependencies.requireContext();
  const baseline = input.baseline_snapshot;
  if (baseline.as_of == null
    || baseline.project_gid !== context.project_gid
    || baseline.app_version !== dependencies.appVersion) {
    throw new Error("AI変更案の基準スナップショット文脈が一致しません。");
  }
  const baselineTasks = baseline.tasks.map((task) => taskSchema.parse(task));
  const currentResponses = await collectApprovalProjectTasks(context.project_gid, signal, {
    gidSchema,
    taskSchema: asanaTaskResponseSchema,
    source: dependencies.readClient,
    canonicalizeJson,
  });
  const normalized = normalizeAsanaSnapshot({
    project_gid: context.project_gid,
    section_gids: context.section_gids,
    activity_date: dependencies.today(),
    tasks: [...currentResponses],
    previous_tasks: baselineTasks,
    status_previous_tasks: baselineTasks,
    activity_baseline_tasks: baselineTasks,
    inaccessible_gids: [],
  });
  const writableExternalDataTaskGids = currentResponses
    .filter(externalDataIsValid)
    .map((task) => task.gid)
    .sort(compareStrings);
  return {
    proposal_id: identifierSchema.parse(input.proposal_id),
    project_gid: context.project_gid,
    workspace_gid: context.workspace_gid,
    section_gids: context.section_gids,
    device_id: context.device_id,
    created_via: identifierSchema.parse(input.created_via),
    activity_date: dependencies.today(),
    baseline_external_data: input.baseline_external_data,
    approval_input: {
      proposal: input.proposal,
      baseline_tasks: baselineTasks,
      current_tasks: normalized.tasks,
      graph_validation_result: input.graph_validation_result,
      selected_operation_ids: [...input.selected_operation_ids],
      writable_external_data_task_gids: writableExternalDataTaskGids,
      journal_task_mappings: [],
    },
  };
}
