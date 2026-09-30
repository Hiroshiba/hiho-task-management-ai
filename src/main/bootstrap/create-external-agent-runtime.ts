import { z } from "zod";
import {
  ExternalAgentGeneration,
  ProposalWorkspace,
  ProposalWorkspaceConflictError,
  ProposalWorkspaceInputError,
  assertSelectedProposalGraphIsSafe,
  createWorkflowProposalView,
  eligibleOperationIds,
  preserveSelection,
  resolveSelectedOperationIds,
  AiWorkflowSelectionError,
} from "../application/proposal-generate";
import { ExternalAgentApplication } from "../application/proposal-apply";
import { asanaProposalApplicationResultSchema } from "../application/common/proposal-application-schemas";
import { aiWorkflowApprovalResultSchema } from "../domain";
import { executeTaskctlQuery, externalAgentProtocol, type TaskctlRankingSchemas, type TaskctlSnapshot } from "../infrastructure/ai";

type GuiState = externalAgentProtocol.ExternalAgentGuiState;
type Generation = ExternalAgentGeneration<GuiState, TaskctlSnapshot>;
type Application = ExternalAgentApplication<GuiState>;
type GenerationOptions = ConstructorParameters<typeof ExternalAgentGeneration<GuiState, TaskctlSnapshot>>[0];
type ApplicationOptions = ConstructorParameters<typeof ExternalAgentApplication<GuiState>>[0];

export type ExternalAgentBridgePort = {
  readonly getState: () => { readonly kind: "stopped" | "running" | "unavailable"; readonly enabled: boolean };
  readonly getRegistration: () => { readonly symlinkCommand: string; readonly allowExecutionCommand: string };
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly init: (processExecPath: string) => Promise<void>;
};

export type ExternalAgentBridgeFactory = (options: {
  readonly userDataPath: string;
  readonly handleRequest: (input: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly onError: (error: unknown) => void;
}) => ExternalAgentBridgePort;

type ExternalAgentCompositionOptions = {
  readonly userDataPath: string;
  readonly createBridge: ExternalAgentBridgeFactory;
  readonly onError: (error: unknown) => void;
  readonly taskctlSchemas: TaskctlRankingSchemas;
  readonly application: Omit<ApplicationOptions,
    | "current_context_id"
    | "stopped"
    | "bridge"
    | "parse_gui_state"
    | "parse_info_response"
    | "parse_gui_select_input"
    | "parse_gui_edit_input"
    | "parse_gui_approve_input"
    | "parse_gui_reject_input"
    | "parse_proposal"
    | "parse_proposal_status_result"
    | "parse_proposal_status_response"
    | "parse_review_open_response"
    | "parse_application_result"
    | "parse_approval_result"
    | "resolve_selection"
    | "assert_selected_graph_safe"
    | "is_selection_error"
    | "preserve_selection"
    | "eligible_operation_ids"
    | "create_view"
    | "assert_external_evidence"
  >;
  readonly generation: Omit<GenerationOptions,
    | "parse_taskctl_snapshot"
    | "execute_taskctl_query"
    | "create_workspace"
    | "bridge"
    | "apply"
    | "eligible_operation_ids"
    | "protocol"
  >;
};

/** 外部変更案の生成、適用、IPCブリッジを一つの実行範囲に接続します。 */
export function createExternalAgentRuntime(options: ExternalAgentCompositionOptions): {
  readonly bridge: ExternalAgentBridgePort;
  readonly application: Application;
  readonly generation: Generation;
} {
  const externalAgentBridge = options.createBridge({
    userDataPath: options.userDataPath,
    handleRequest: (input, signal) => externalAgent.handleRequest(input, signal),
    onError: options.onError,
  });
  const externalAgentApply: Application = new ExternalAgentApplication<GuiState>({
    ...options.application,
    current_context_id: () => externalAgent.contextId,
    stopped: () => externalAgent.stopped,
    bridge: externalAgentBridge,
    parse_gui_state: (value) => externalAgentProtocol.externalAgentGuiStateSchema.parse(value),
    parse_info_response: (value) => externalAgentProtocol.externalAgentInfoResponseSchema.parse(value),
    parse_gui_select_input: (value) => externalAgentProtocol.externalAgentGuiSelectInputSchema.parse(value),
    parse_gui_edit_input: (value) => externalAgentProtocol.externalAgentGuiEditInputSchema.parse(value),
    parse_gui_approve_input: (value) => externalAgentProtocol.externalAgentGuiApproveInputSchema.parse(value),
    parse_gui_reject_input: (value) => externalAgentProtocol.externalAgentGuiRejectInputSchema.parse(value),
    parse_proposal: (value) => externalAgentProtocol.externalAgentProposalSchema.parse(value),
    parse_proposal_status_result: (value) => externalAgentProtocol.externalAgentProposalStatusResultSchema.parse(value),
    parse_proposal_status_response: (value) => externalAgentProtocol.externalAgentProposalStatusResponseSchema.parse(value),
    parse_review_open_response: (value) => externalAgentProtocol.externalAgentReviewOpenResponseSchema.parse(value),
    parse_application_result: (value) => asanaProposalApplicationResultSchema.parse(value),
    parse_approval_result: (value) => aiWorkflowApprovalResultSchema.parse(value),
    resolve_selection: resolveSelectedOperationIds,
    assert_selected_graph_safe: assertSelectedProposalGraphIsSafe,
    is_selection_error: (error): error is AiWorkflowSelectionError => error instanceof AiWorkflowSelectionError,
    preserve_selection: preserveSelection,
    eligible_operation_ids: eligibleOperationIds,
    create_view: createWorkflowProposalView,
    assert_external_evidence: (record, operationIds) => externalAgent.assertExternalEvidence(record, operationIds),
  });
  const externalAgent: Generation = new ExternalAgentGeneration<GuiState, TaskctlSnapshot>({
    ...options.generation,
    parse_taskctl_snapshot: (value) => options.taskctlSchemas.taskctlSnapshotSchema.parse(value),
    execute_taskctl_query: (query, snapshot) => executeTaskctlQuery(query, snapshot, options.taskctlSchemas),
    create_workspace: (workspaceId, baselineSnapshotHash) => new ProposalWorkspace({
      workspace_id: workspaceId,
      baseline_snapshot_hash: baselineSnapshotHash,
    }),
    bridge: externalAgentBridge,
    apply: externalAgentApply,
    eligible_operation_ids: eligibleOperationIds,
    protocol: {
      protocol_version: externalAgentProtocol.externalAgentProtocolVersion,
      maximum_message_bytes: externalAgentProtocol.maximumExternalAgentMessageBytes,
      maximum_workspace_response_bytes: externalAgentProtocol.maximumWorkspaceCliResponseBytes,
      input_schema: () => z.toJSONSchema(externalAgentProtocol.externalAgentRequestInputSchema, { target: "draft-07" }),
      parse_cli_input: (value) => externalAgentProtocol.externalAgentCliInputSchema.parse(value),
      is_input_error: (error) => error instanceof z.ZodError,
      parse_error_response: (value) => externalAgentProtocol.externalAgentErrorResponseSchema.parse(value),
      parse_prepare_response: (value) => externalAgentProtocol.externalAgentProposalPrepareResponseSchema.parse(value),
      parse_read_response: (value) => externalAgentProtocol.externalAgentProposalReadResponseSchema.parse(value),
      parse_apply_edits_response: (value) => externalAgentProtocol.externalAgentProposalApplyEditsResponseSchema.parse(value),
      parse_diff_response: (value) => externalAgentProtocol.externalAgentProposalDiffResponseSchema.parse(value),
      parse_validate_response: (value) => externalAgentProtocol.externalAgentProposalValidateResponseSchema.parse(value),
      parse_submit_response: (value) => externalAgentProtocol.externalAgentProposalSubmitResponseSchema.parse(value),
      parse_task_query_response: (value) => externalAgentProtocol.createExternalAgentResponseSchemas(
        options.taskctlSchemas.taskctlResponseSchema,
      ).externalAgentTaskQueryResponseSchema.parse(value),
      workspace_conflict: (error) => error instanceof ProposalWorkspaceConflictError ? error : undefined,
      is_workspace_input_error: (error): error is ProposalWorkspaceInputError => error instanceof ProposalWorkspaceInputError,
    },
  });
  return { bridge: externalAgentBridge, application: externalAgentApply, generation: externalAgent };
}
