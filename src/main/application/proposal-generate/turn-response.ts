type WorkspaceStatus = {
  readonly workspace_id: string;
  readonly revision: number;
  readonly state: string;
};

type SubmittedResponse = {
  readonly kind: "proposal";
  readonly workspace_id: string;
  readonly revision: number;
  readonly message: string;
  readonly questions: readonly unknown[];
};

type GeneratedResponse = SubmittedResponse | { readonly kind: "no_proposal" };

/** 最終応答とワークスペースの提出状態を照合します。 */
export function validateGeneratedResponse<
  TProposal,
  TProposalResponse extends { readonly kind: "proposal"; readonly proposal: TProposal },
  TNoProposalResponse extends { readonly kind: "no_proposal" },
  TGenerated extends GeneratedResponse,
  TIssue,
  TDigest,
>(
  generatedResponse: TGenerated,
  workspace: { readonly getStatus: () => WorkspaceStatus },
  dependencies: {
    readonly readProposal: () => TProposal;
    readonly parseResponse: (value: unknown) => TProposalResponse | TNoProposalResponse;
    readonly parseIssue: (value: unknown) => TIssue;
    readonly notStagedDigest: () => TDigest;
    readonly candidateDigest: (proposal: TProposal) => TDigest;
    readonly makeFailure: (issues: readonly TIssue[], digest: TDigest, cause: Error) => Error;
    readonly WorkflowError: new (message: string) => Error;
  },
): { readonly kind: "proposal"; readonly response: TProposalResponse }
  | { readonly kind: "no_proposal"; readonly response: TNoProposalResponse } {
  if (generatedResponse.kind === "proposal") {
    const status = workspace.getStatus();
    if (
      generatedResponse.workspace_id !== status.workspace_id
      || generatedResponse.revision !== status.revision
      || status.state !== "submitted"
    ) {
      throw dependencies.makeFailure(
        [dependencies.parseIssue({
          phase: "proposal_workspace",
          code: generatedResponse.workspace_id !== status.workspace_id
            || generatedResponse.revision !== status.revision
            ? "proposal_workspace_reference_mismatch"
            : "proposal_workspace_not_submitted",
          json_pointer: generatedResponse.workspace_id !== status.workspace_id
            ? "/workspace_id"
            : "/revision",
        })],
        dependencies.notStagedDigest(),
        new dependencies.WorkflowError("AI変更案ワークスペースの提出と最終応答が一致しません。"),
      );
    }
    const proposal = dependencies.readProposal();
    const response = dependencies.parseResponse({
      kind: generatedResponse.kind,
      message: generatedResponse.message,
      questions: generatedResponse.questions,
      proposal,
    });
    if (response.kind !== "proposal") {
      throw new Error("ワークスペース応答が提案応答へ変換されませんでした。");
    }
    return { kind: "proposal", response };
  }
  if (workspace.getStatus().state === "submitted") {
    throw dependencies.makeFailure(
      [dependencies.parseIssue({
        phase: "proposal_workspace",
        code: "proposal_workspace_response_mismatch",
        json_pointer: "/kind",
      })],
      dependencies.candidateDigest(dependencies.readProposal()),
      new dependencies.WorkflowError("提出済みワークスペースに提案なし応答を指定できません。"),
    );
  }
  const response = dependencies.parseResponse(generatedResponse);
  if (response.kind !== "no_proposal") {
    throw new Error("提案なし応答が提案なし応答として検証されませんでした。");
  }
  return { kind: "no_proposal", response };
}
