import type {
  Proposal,
  ProposalWorkspaceBatch,
  ProposalWorkspaceDiff,
  ProposalWorkspaceRead,
  ProposalWorkspaceSubmit,
} from "../../../domain";

/** 変更案ワークスペースで検出した入力上の問題です。 */
export type ProposalWorkspaceIssue = {
  code: string;
  json_pointer: string;
  message: string;
  group_id?: string;
  operation_id?: string;
};

/** 変更案ワークスペースの現在の状態です。 */
export type ProposalWorkspaceStatus = {
  workspace_id: string;
  baseline_snapshot_hash: string;
  revision: number;
  state: "draft" | "submitted";
  completion: "incomplete" | "structurally_complete";
  issues: ProposalWorkspaceIssue[];
};

/** 変更案ワークスペースの部分読み取り結果です。 */
export type ProposalWorkspaceChunk = {
  workspace_id: string;
  revision: number;
  offset: number;
  content: string;
  next_offset?: number;
  from_revision?: number;
};

/** 変更案ワークスペースに渡す意味検証の結果です。 */
export type ProposalWorkspaceValidation<T> =
  | { kind: "valid"; proposal: Proposal; value: T }
  | { kind: "invalid"; issues: ProposalWorkspaceIssue[] };

/** 変更案ワークスペースの提出結果です。 */
export type ProposalWorkspaceSubmission<T> =
  | { kind: "submitted"; revision: number; proposal: Proposal; value: T }
  | { kind: "invalid"; revision: number; issues: ProposalWorkspaceIssue[] };

/** 変更案ワークスペースの意味検証結果です。 */
export type ProposalWorkspaceValidationResult<T> =
  | { kind: "valid"; revision: number; proposal: Proposal; value: T }
  | { kind: "invalid"; revision: number; issues: ProposalWorkspaceIssue[] };

/** Codex の動的ツールから操作する変更案ワークスペースです。 */
export interface ProposalWorkspacePort {
  readonly workspaceId: string;
  getStatus(): ProposalWorkspaceStatus;
  read(input: ProposalWorkspaceRead): ProposalWorkspaceChunk;
  diff(input: ProposalWorkspaceDiff): ProposalWorkspaceChunk;
  applyBatch(input: ProposalWorkspaceBatch): ProposalWorkspaceStatus;
  submit<T>(
    input: ProposalWorkspaceSubmit,
    validate: (proposal: Proposal) => ProposalWorkspaceValidation<T>,
  ): ProposalWorkspaceSubmission<T>;
}
