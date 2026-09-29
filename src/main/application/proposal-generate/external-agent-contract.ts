import type {
  AiWorkflowSnapshot,
  BaselineSnapshot,
  Proposal,
  ProposalWorkspaceBatch,
  ProposalWorkspaceDiff,
  ProposalWorkspaceRead,
  ProposalWorkspaceSubmit,
} from "../../domain";
import type { AsanaProposalApplicationInput } from "../common/proposal-application-schemas";
import type { ExternalProposalValidation } from "../common/ports/external-agent-proposal";

type WorkspaceBinding = {
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
  readonly proposal_context_id: string;
  readonly workspace_id: string;
};

export type ExternalAgentTaskQueryInput = (
  | { readonly operation: "tasks.list" }
  | { readonly operation: "tasks.get"; readonly gid: string }
  | { readonly operation: "tasks.rank" }
  | { readonly operation: "tasks.graph" }
  | { readonly operation: "tasks.areas" }
  | { readonly operation: "tasks.search-local"; readonly query: string }
) & { readonly proposal_context_id?: string | undefined };

export type ExternalAgentProposalPrepareInput = {
  readonly operation: "proposals.prepare";
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
  readonly request_id: string;
  readonly source_text: string;
};

export type ExternalAgentProposalReadInput = WorkspaceBinding & {
  readonly operation: "proposals.read";
  readonly revision: number;
  readonly target: ProposalWorkspaceRead["target"];
  readonly offset?: number | undefined;
};

export type ExternalAgentProposalApplyEditsInput = WorkspaceBinding & {
  readonly operation: "proposals.apply-edits";
  readonly edit_batch_id: string;
  readonly expected_revision: number;
  readonly edits: ProposalWorkspaceBatch["edits"];
};

export type ExternalAgentProposalDiffInput = WorkspaceBinding & {
  readonly operation: "proposals.diff";
  readonly from_revision: number;
  readonly revision: number;
  readonly offset?: number | undefined;
};

export type ExternalAgentProposalValidateInput = WorkspaceBinding & {
  readonly operation: "proposals.validate";
  readonly expected_revision: number;
  readonly offset?: number | undefined;
};

export type ExternalAgentProposalSubmitInput = WorkspaceBinding & {
  readonly operation: "proposals.submit";
  readonly request_id: string;
  readonly expected_revision: number;
};

export type ExternalAgentRequestInput =
  | ExternalAgentTaskQueryInput
  | ExternalAgentProposalPrepareInput
  | ExternalAgentProposalReadInput
  | ExternalAgentProposalApplyEditsInput
  | ExternalAgentProposalDiffInput
  | ExternalAgentProposalValidateInput
  | ExternalAgentProposalSubmitInput
  | { readonly operation: "proposals.status"; readonly proposal_id: string; readonly operation_ids: readonly string[] }
  | { readonly operation: "review.open"; readonly proposal_id: string };

export type ExternalAgentCliInput = ExternalAgentRequestInput | { readonly operation: "agent-info" };

type WorkspaceIssue = { readonly message: string };

type WorkspaceValidationResult =
  | { readonly kind: "invalid"; readonly revision: number; readonly issues: readonly WorkspaceIssue[] }
  | { readonly kind: "valid"; readonly revision: number; readonly proposal: Proposal; readonly value: ExternalProposalValidation };

type WorkspaceValidation =
  | { readonly kind: "invalid"; readonly issues: readonly WorkspaceIssue[] }
  | { readonly kind: "valid"; readonly proposal: Proposal; readonly value: ExternalProposalValidation };

/** 外部提案生成が利用するワークスペース操作の境界です。 */
export interface ExternalAgentWorkspace {
  readonly workspaceId: string;
  getStatus(): { readonly revision: number };
  read(input: ProposalWorkspaceRead): { readonly content: string; readonly offset: number; readonly workspace_id: string; readonly revision: number; readonly next_offset?: number | undefined };
  applyBatch(input: ProposalWorkspaceBatch): { readonly workspace_id: string; readonly revision: number; readonly state: string; readonly completion: string; readonly issues: readonly WorkspaceIssue[] };
  diff(input: ProposalWorkspaceDiff): { readonly content: string; readonly offset: number; readonly workspace_id: string; readonly revision: number; readonly next_offset?: number | undefined };
  validate(input: ProposalWorkspaceSubmit, validate: (proposal: Proposal) => WorkspaceValidation): WorkspaceValidationResult;
  submit(input: ProposalWorkspaceSubmit, validate: (proposal: Proposal) => WorkspaceValidation):
    | { readonly kind: "invalid"; readonly revision: number; readonly issues: readonly WorkspaceIssue[] }
    | { readonly kind: "submitted"; readonly revision: number; readonly proposal: Proposal; readonly value: ExternalProposalValidation };
}

export type PreparedExternalContext<TTaskctl> = {
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
  readonly proposal_context_id: string;
  readonly source_text: string;
  readonly evidence_locator_prefix: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly taskctl_snapshot: TTaskctl;
  readonly turn_context: { readonly baseline_snapshot_hash: string; readonly app_version: string; readonly project_gid: string; readonly synced_at: string; readonly as_of: string };
  readonly workspace: ExternalAgentWorkspace;
};
