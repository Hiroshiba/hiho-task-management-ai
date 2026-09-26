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

