import type {
  AiWorkflowProposalView,
  AiWorkflowSelection,
  AiWorkflowSnapshot,
  BaselineSnapshot,
  Proposal,
} from "../../../domain";
import type { GraphValidationResult } from "../../../domain/proposal-analysis/graph";
import type {
  ExplicitSplitRequestReference,
  ProposalValidationResult,
  TrustedStatusEvidenceReference,
} from "../../../domain/proposal-analysis/basic";
import type { AsanaProposalApplicationInput } from "../proposal-application-schemas";

export type ExternalAgentBaseline<TTaskctl> = {
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly taskctl_snapshot: TTaskctl;
};

export type ExternalProposalRecord = {
  readonly proposal_id: string;
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly proposal_context_id: string;
  readonly operation_ids: readonly string[];
  readonly source_text: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly turn_context: { readonly baseline_snapshot_hash: string };
  proposal: Proposal;
  explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  graph_validation: GraphValidationResult;
  selected_operation_ids: readonly string[];
  view: AiWorkflowProposalView;
  revision: number;
  state: { readonly kind: string; readonly reason_code?: string; readonly message?: string; readonly result?: unknown };
};

export type ExternalAgentApprovalPreparationInput = {
  readonly proposal_id: string;
  readonly proposal: Proposal;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly existing_areas: readonly string[];
  readonly graph_validation_result: GraphValidationResult;
  readonly selected_operation_ids: readonly string[];
  readonly explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  readonly created_via: "external_tool";
};

export type ExternalProposalValidation = {
  readonly basic: ProposalValidationResult;
  readonly graph: GraphValidationResult;
  readonly evidence: {
    readonly split_references: readonly ExplicitSplitRequestReference[];
    readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  };
};

export type ExternalProposalPreparation = {
  readonly context_id: string;
  readonly proposal_context_id: string;
  readonly source_text: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly turn_context: { readonly baseline_snapshot_hash: string };
};

/** 提出済み外部提案を保持するworkflowの共有境界です。 */
export interface ExternalAgentApplyPort<TState> {
  readonly proposalCount: number;
  createInfoResponse(input: {
    readonly appVersion: string;
    readonly protocolVersion: number;
    readonly instanceId: string;
    readonly context: { readonly context_id: string; readonly project_gid: string } | undefined;
    readonly observedAt: string;
    readonly timeZone: string;
    readonly bridgeState: { readonly kind: string; readonly enabled: boolean };
    readonly runtime: { readonly kind: string; readonly last_successful_sync_at?: string | undefined; readonly last_error_code?: string | undefined } | undefined;
    readonly onlineProvider: () => boolean;
    readonly preparedContextCount: number;
    readonly inputSchema: () => unknown;
  }): unknown;
  createProposalRecord(
    input: { readonly request_id: string; readonly instance_id: string; readonly context_id: string },
    prepared: ExternalProposalPreparation,
    proposal: Proposal,
    validation: ExternalProposalValidation,
    proposalId: string,
  ): ExternalProposalRecord;
  registerProposal(record: ExternalProposalRecord): void;
  requireProposal(proposalId: string): ExternalProposalRecord;
  getProposalStatus(proposalId: string, operationIds: readonly string[]): unknown;
  openReview(proposalId: string): Promise<unknown>;
  expireProposals(reason: "context_changed" | "instance_restarted" | "superseded"): void;
  clearListeners(): void;
  emitChanged(): void;
  getState(): TState;
  onChanged(listener: (state: TState) => void): () => void;
  select(input: { readonly proposal_id: string; readonly revision: number; readonly selection: AiWorkflowSelection }, signal: AbortSignal): TState;
  edit(input: { readonly proposal_id: string; readonly operation_id: string; readonly revision: number; readonly after: unknown; readonly evidence_locator: string }, signal: AbortSignal): TState;
  approve(input: { readonly proposal_id: string; readonly revision: number; readonly selection: AiWorkflowSelection }, signal: AbortSignal): Promise<TState>;
  reject(input: { readonly proposal_id: string; readonly revision: number }, signal: AbortSignal): TState;
}
