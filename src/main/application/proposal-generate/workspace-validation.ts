type Workspace = {
  readonly getStatus: () => { readonly workspace_id: string; readonly revision: number };
  readonly read: (input: {
    readonly workspace_id: string;
    readonly revision: number;
    readonly target: { readonly kind: "proposal" };
    readonly offset: number;
  }) => { readonly content: string; readonly next_offset?: number | null };
};

/** ワークスペースへ提出された変更案を最後まで読み取ります。 */
export function readWorkspaceProposal<TProposal>(
  workspace: Workspace,
  parseProposal: (value: unknown) => TProposal,
): TProposal {
  const status = workspace.getStatus();
  let offset = 0;
  let content = "";
  while (true) {
    const chunk = workspace.read({
      workspace_id: status.workspace_id,
      revision: status.revision,
      target: { kind: "proposal" },
      offset,
    });
    content += chunk.content;
    if (chunk.next_offset == null) {
      return parseProposal(JSON.parse(content));
    }
    offset = chunk.next_offset;
  }
}

/** ワークスペースの検証問題を編集画面の位置へ変換します。 */
export function workspaceValidationIssues<TIssue extends {
  readonly code: string;
  readonly json_pointer: string;
  readonly validator_code?: string | undefined;
  readonly group_id?: string | undefined;
  readonly operation_id?: string | undefined;
}>(issues: readonly TIssue[]): {
  readonly code: string;
  readonly json_pointer: string;
  readonly message: string;
  readonly group_id?: string;
  readonly operation_id?: string;
}[] {
  return issues.map((issue) => ({
    code: issue.code,
    json_pointer: issue.json_pointer,
    message: `変更案の検証に失敗しました。${issue.validator_code ?? issue.code}`,
    ...(issue.group_id == null ? {} : { group_id: issue.group_id }),
    ...(issue.operation_id == null ? {} : { operation_id: issue.operation_id }),
  }));
}

/** ワークスペース提案を根拠、基本規則、グラフ規則で検証します。 */
export function validateWorkspaceProposal<
  TOperation extends { readonly operation: string; readonly operation_id: string; readonly after: unknown },
  TProposal extends { readonly groups: readonly {
    readonly group_id: string; readonly operations: readonly TOperation[];
  }[] },
  TPrepared,
  TDigest,
  TBound extends { readonly proposal: TProposal },
  TStored,
  TIssue,
  TWorkspaceIssue,
  TRetryError extends Error & { readonly issues: readonly TIssue[] },
>(
  proposal: TProposal,
  prepared: TPrepared,
  dependencies: {
    readonly createTaskDuration: (operation: TOperation) => unknown;
    readonly createCandidateDigest: (proposal: TProposal) => TDigest;
    readonly bindProposalEvidence: (proposal: TProposal, prepared: TPrepared, digest: TDigest) => TBound;
    readonly createStoredProposal: (id: string, bound: TBound, prepared: TPrepared) => TStored;
    readonly proposalValidationIssues: (stored: TStored) => readonly TIssue[];
    readonly workspaceValidationIssues: (issues: readonly TIssue[]) => TWorkspaceIssue[];
    readonly isRetryableFailure: (error: unknown) => error is TRetryError;
  },
): { readonly kind: "valid"; readonly proposal: TProposal; readonly value: null }
  | { readonly kind: "invalid"; readonly issues: TWorkspaceIssue[] | {
    readonly code: string; readonly json_pointer: string; readonly message: string;
    readonly group_id: string; readonly operation_id: string;
  }[] } {
  const durationIssues = proposal.groups.flatMap((group, groupIndex) =>
    group.operations.flatMap((operation, operationIndex) =>
      operation.operation === "create_task" && dependencies.createTaskDuration(operation) == null
        ? [{
            code: "create_task_duration_required",
            json_pointer: `/groups/${groupIndex}/operations/${operationIndex}/after/duration`,
            message: "新規タスクの所要時間を指定してください。",
            group_id: group.group_id,
            operation_id: operation.operation_id,
          }]
        : []));
  if (durationIssues.length > 0) {
    return { kind: "invalid", issues: durationIssues };
  }
  let bound: TBound;
  try {
    bound = dependencies.bindProposalEvidence(
      proposal, prepared, dependencies.createCandidateDigest(proposal),
    );
  } catch (error: unknown) {
    if (dependencies.isRetryableFailure(error)) {
      return { kind: "invalid", issues: dependencies.workspaceValidationIssues(error.issues) };
    }
    throw error;
  }
  const stored = dependencies.createStoredProposal("workspace-validation", bound, prepared);
  const issues = dependencies.proposalValidationIssues(stored);
  return issues.length === 0
    ? { kind: "valid", proposal: bound.proposal, value: null }
    : { kind: "invalid", issues: dependencies.workspaceValidationIssues(issues) };
}
