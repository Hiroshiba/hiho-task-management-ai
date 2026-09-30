type NoProposalResponse<TQuestion> = {
  readonly message: string;
  readonly questions: readonly TQuestion[];
  readonly pending_proposal_action: unknown;
};

type ProposalResponse<TProposal, TQuestion> = {
  readonly message: string;
  readonly questions: readonly TQuestion[];
  readonly proposal: TProposal;
};

/** 提案なし応答と取り下げ確認状態をターンの確定値へ組み立てます。 */
export function createNoProposalCommit<TPrepared, TQuestion, TPending, TResult>(
  response: NoProposalResponse<TQuestion>,
  prepared: TPrepared,
  attempt: number,
  turnId: string,
  dependencies: {
    readonly createPendingWithdrawConfirmation: (response: NoProposalResponse<TQuestion>, prepared: TPrepared) => TPending | undefined;
    readonly createRendererQuestions: (questions: readonly TQuestion[], pending: TPending | undefined, prepared: TPrepared) => unknown;
    readonly parseTurnResult: (value: unknown) => TResult;
  },
): {
  readonly kind: "no_proposal";
  readonly result: TResult;
  readonly pendingWithdrawConfirmation: { readonly kind: "clear" } | { readonly kind: "set"; readonly value: TPending };
  readonly prepared: TPrepared;
} {
  const pending = dependencies.createPendingWithdrawConfirmation(response, prepared);
  const result = dependencies.parseTurnResult({
    kind: "no_proposal",
    turn_id: turnId,
    message: response.message,
    questions: dependencies.createRendererQuestions(response.questions, pending, prepared),
    pending_proposal_action: response.pending_proposal_action,
    retry_count: attempt - 1,
  });
  return {
    kind: "no_proposal",
    result,
    pendingWithdrawConfirmation: pending == null
      ? { kind: "clear" }
      : { kind: "set", value: pending },
    prepared,
  };
}

/** 検証済み提案を保存案とRenderer向けターン結果へ組み立てます。 */
export function createProposalCommit<TProposal, TQuestion, TPrepared, TDigest, TBound, TStored, TIssue, TResult>(
  response: ProposalResponse<TProposal, TQuestion>,
  prepared: TPrepared,
  attempt: number,
  turnId: string,
  replacingProposalId: string | undefined,
  dependencies: {
    readonly candidateDigest: (proposal: TProposal) => TDigest;
    readonly parseProposal: (value: TProposal) => TProposal;
    readonly bindProposalEvidence: (proposal: TProposal, prepared: TPrepared, digest: TDigest) => TBound;
    readonly createProposalId: () => string;
    readonly createStoredProposal: (proposalId: string, bound: TBound, prepared: TPrepared) => TStored;
    readonly proposalValidationIssues: (stored: TStored) => readonly TIssue[];
    readonly makeValidationFailure: (issues: readonly TIssue[], digest: TDigest) => Error;
    readonly createProposalView: (stored: TStored) => unknown;
    readonly createRendererQuestions: (questions: readonly TQuestion[], prepared: TPrepared) => unknown;
    readonly parseTurnResult: (value: unknown) => TResult;
  },
): {
  readonly kind: "proposal";
  readonly result: TResult;
  readonly pendingWithdrawConfirmation: { readonly kind: "clear" };
  readonly storedProposal: TStored;
  readonly replacingProposalId: string | undefined;
  readonly prepared: TPrepared;
} {
  const candidateDigest = dependencies.candidateDigest(response.proposal);
  const bound = dependencies.bindProposalEvidence(
    dependencies.parseProposal(response.proposal),
    prepared,
    candidateDigest,
  );
  const proposalId = dependencies.createProposalId();
  const stored = dependencies.createStoredProposal(proposalId, bound, prepared);
  const validationIssues = dependencies.proposalValidationIssues(stored);
  if (validationIssues.length > 0) {
    throw dependencies.makeValidationFailure(validationIssues, candidateDigest);
  }
  const view = dependencies.createProposalView(stored);
  const result = dependencies.parseTurnResult({
    kind: "proposal",
    turn_id: turnId,
    message: response.message,
    questions: dependencies.createRendererQuestions(response.questions, prepared),
    proposal: view,
    retry_count: attempt - 1,
  });
  return {
    kind: "proposal",
    result,
    pendingWithdrawConfirmation: { kind: "clear" },
    storedProposal: stored,
    replacingProposalId,
    prepared,
  };
}

/** 成功したターンの保存案、会話根拠、確認状態を順に確定します。 */
export function commitTurn<TPrepared, TStored, TPending, TResult>(
  commit:
    | { readonly kind: "no_proposal"; readonly result: TResult; readonly prepared: TPrepared;
        readonly pendingWithdrawConfirmation: { readonly kind: "clear" } | { readonly kind: "set"; readonly value: TPending } }
    | { readonly kind: "proposal"; readonly result: TResult; readonly prepared: TPrepared;
        readonly storedProposal: TStored; readonly replacingProposalId: string | undefined;
        readonly pendingWithdrawConfirmation: { readonly kind: "clear" } | { readonly kind: "set"; readonly value: TPending } },
  dependencies: {
    readonly storeProposal: (stored: TStored, replacingProposalId: string | undefined) => void;
    readonly rememberSuccessfulTurnEvidence: (prepared: TPrepared) => void;
    readonly setPendingWithdrawConfirmation: (value: TPending | undefined) => void;
  },
): TResult {
  switch (commit.kind) {
    case "no_proposal":
      dependencies.rememberSuccessfulTurnEvidence(commit.prepared);
      break;
    case "proposal":
      dependencies.storeProposal(commit.storedProposal, commit.replacingProposalId);
      dependencies.rememberSuccessfulTurnEvidence(commit.prepared);
      break;
  }
  switch (commit.pendingWithdrawConfirmation.kind) {
    case "clear":
      dependencies.setPendingWithdrawConfirmation(undefined);
      break;
    case "set":
      dependencies.setPendingWithdrawConfirmation(commit.pendingWithdrawConfirmation.value);
      break;
  }
  return commit.result;
}
