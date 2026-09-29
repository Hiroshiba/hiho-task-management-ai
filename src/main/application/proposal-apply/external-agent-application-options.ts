import type { AiWorkflowProposalView, AiWorkflowSelection, Proposal } from "../../domain";
import type { ProposalValidationResult, ExplicitSplitRequestReference, TrustedStatusEvidenceReference } from "../../domain/proposal-analysis/basic";
import type { GraphValidationResult } from "../../domain/proposal-analysis/graph";
import type { AsanaProposalApplicationInput, AsanaProposalApplicationResult } from "../common/proposal-application-schemas";
import type { ExternalAgentAsanaOperationQueuePort } from "../common/ports/asana-operation-queue";
import type { ExternalAgentApprovalPreparationInput, ExternalProposalRecord } from "../common/ports/external-agent-proposal";

export type ExternalAgentApplicationOptions<TState> = {
  readonly lifecycle_signal: AbortSignal;
  readonly online_provider: () => boolean;
  readonly operation_queue: ExternalAgentAsanaOperationQueuePort;
  readonly current_context_id: () => string | undefined;
  readonly stopped: () => boolean;
  readonly assert_apply_ready: () => void;
  readonly prepare_approval_input: (input: ExternalAgentApprovalPreparationInput, signal: AbortSignal) => AsanaProposalApplicationInput | PromiseLike<AsanaProposalApplicationInput>;
  readonly apply_proposal: (input: AsanaProposalApplicationInput, signal: AbortSignal) => AsanaProposalApplicationResult | PromiseLike<AsanaProposalApplicationResult>;
  readonly get_saved_operation_result: (proposalId: string, operationId: string) => unknown;
  readonly open_review: (proposalId: string, requestId: string) => PromiseLike<void> | void;
  readonly create_id: () => string;
  readonly bridge: {
    readonly getState: () => { readonly kind: string; readonly enabled: boolean };
    readonly getRegistration: () => { readonly symlinkCommand: string; readonly allowExecutionCommand: string };
  };
  readonly parse_gui_state: (value: unknown) => TState;
  readonly parse_info_response: (value: unknown) => unknown;
  readonly parse_gui_select_input: (value: unknown) => { readonly proposal_id: string; readonly revision: number; readonly selection: AiWorkflowSelection };
  readonly parse_gui_edit_input: (value: unknown) => { readonly proposal_id: string; readonly operation_id: string; readonly revision: number; readonly after: unknown; readonly evidence_locator: string };
  readonly parse_gui_approve_input: (value: unknown) => { readonly proposal_id: string; readonly revision: number; readonly selection: AiWorkflowSelection };
  readonly parse_gui_reject_input: (value: unknown) => { readonly proposal_id: string; readonly revision: number };
  readonly parse_proposal: (value: unknown) => unknown;
  readonly parse_proposal_status_result: (value: unknown) => unknown;
  readonly parse_proposal_status_response: (value: unknown) => unknown;
  readonly parse_review_open_response: (value: unknown) => unknown;
  readonly parse_application_result: (value: unknown) => AsanaProposalApplicationResult;
  readonly parse_approval_result: (value: unknown) => unknown;
  readonly resolve_selection: (record: ExternalProposalRecord, selection: AiWorkflowSelection) => readonly string[];
  readonly assert_selected_graph_safe: (record: ExternalProposalRecord, selectedOperationIds: readonly string[]) => void;
  readonly is_selection_error: (error: unknown) => error is Error;
  readonly preserve_selection: (proposal: Proposal, graph: GraphValidationResult, previousOperationIds: readonly string[]) => readonly string[];
  readonly eligible_operation_ids: (proposal: Proposal, graph: GraphValidationResult) => readonly string[];
  readonly create_view: (input: {
    readonly proposal_id: string;
    readonly proposal: Proposal;
    readonly snapshot: ExternalProposalRecord["snapshot"];
    readonly baseline_snapshot_hash: string;
    readonly basic_validation: ProposalValidationResult;
    readonly graph_validation: GraphValidationResult;
    readonly selected_operation_ids: readonly string[];
  }) => AiWorkflowProposalView;
  readonly assert_external_evidence: (record: ExternalProposalRecord, operationIds: readonly string[]) => {
    readonly split_references: readonly ExplicitSplitRequestReference[];
    readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  };
};
