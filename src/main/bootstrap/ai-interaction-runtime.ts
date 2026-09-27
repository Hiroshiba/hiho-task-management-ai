type InteractionRecord = {
  readonly baselineStore: {
    readonly currentTurnKeys: Set<string>;
    readonly proposalKeys: Map<string, string>;
  };
  turnInFlight: boolean;
  approvalInFlight: boolean;
};

type TurnOutcome =
  | { readonly kind: "proposal"; readonly proposalId: string; readonly baseProposalId: string | undefined }
  | { readonly kind: "discard"; readonly baseProposalId: string }
  | { readonly kind: "none" };

type AiInteractionDependencies<
  Record extends InteractionRecord,
  TurnInput extends { readonly session_id: string },
  TurnRequest,
  TurnResult,
  ApprovalInput extends { readonly session_id: string },
  ApprovalRequest,
  ApprovalResult extends { readonly proposal_id: string },
  Context,
> = {
  readonly assertOperationalReady: () => void;
  readonly assertMutationRequestAccepted: () => void;
  readonly assertProposalOperationAvailable: (record: Record) => void;
  readonly requireSession: (sessionId: string) => Record;
  readonly parseTurnRequest: (input: TurnInput) => TurnRequest;
  readonly runTurn: (
    record: Record,
    request: TurnRequest,
    signal: AbortSignal,
  ) => Promise<TurnResult>;
  readonly classifyTurn: (request: TurnRequest, result: TurnResult) => TurnOutcome;
  readonly rejectProposal: (record: Record, proposalId: string) => void;
  readonly rememberProposal: (record: Record, proposalId: string) => void;
  readonly forgetProposal: (record: Record, proposalId: string) => void;
  readonly releaseCurrentTurnBaselines: (record: Record) => void;
  readonly parseApprovalRequest: (input: ApprovalInput) => ApprovalRequest;
  readonly requireContext: () => Context;
  readonly enqueueApproval: (
    record: Record,
    request: ApprovalRequest,
    context: Context,
    signal: AbortSignal,
  ) => Promise<ApprovalResult>;
};

/** AIターンと変更案承認の進行状態を管理します。 */
export class AiInteractionRuntime<
  Record extends InteractionRecord,
  TurnInput extends { readonly session_id: string },
  TurnRequest,
  TurnResult,
  ApprovalInput extends { readonly session_id: string },
  ApprovalRequest,
  ApprovalResult extends { readonly proposal_id: string },
  Context,
> {
  public constructor(
    private readonly dependencies: AiInteractionDependencies<
      Record,
      TurnInput,
      TurnRequest,
      TurnResult,
      ApprovalInput,
      ApprovalRequest,
      ApprovalResult,
      Context
    >,
  ) {}

  /** AIターンを実行し、変更案と基準データの対応を更新します。 */
  public async startTurn(input: TurnInput, signal: AbortSignal): Promise<TurnResult> {
    this.dependencies.assertMutationRequestAccepted();
    const record = this.dependencies.requireSession(input.session_id);
    if (record.turnInFlight) {
      throw new Error("同じAIセッションで複数のターンを同時に実行できません。");
    }
    if (record.approvalInFlight) {
      throw new Error("同じAIセッションで承認実行中はAIターンを開始できません。");
    }
    if (record.baselineStore.currentTurnKeys.size > 0) {
      throw new Error("前回のAIターンの基準外部データが解放されていません。");
    }
    record.turnInFlight = true;
    try {
      const request = this.dependencies.parseTurnRequest(input);
      const result = await this.dependencies.runTurn(record, request, signal);
      const outcome = this.dependencies.classifyTurn(request, result);
      if (outcome.kind === "proposal") {
        let baselineKey: string | undefined;
        for (const key of record.baselineStore.currentTurnKeys) {
          baselineKey = key;
        }
        if (baselineKey == null) {
          this.dependencies.rejectProposal(record, outcome.proposalId);
          throw new Error("AI変更案に対応する基準外部データがありません。");
        }
        this.dependencies.rememberProposal(record, outcome.proposalId);
        record.baselineStore.proposalKeys.set(outcome.proposalId, baselineKey);
        if (outcome.baseProposalId != null) {
          this.dependencies.rejectProposal(record, outcome.baseProposalId);
          this.dependencies.forgetProposal(record, outcome.baseProposalId);
        }
      } else if (outcome.kind === "discard") {
        this.dependencies.rejectProposal(record, outcome.baseProposalId);
        this.dependencies.forgetProposal(record, outcome.baseProposalId);
      }
      return result;
    } finally {
      this.dependencies.releaseCurrentTurnBaselines(record);
      record.turnInFlight = false;
    }
  }

  /** 変更案承認中の状態を保持し、成功後に基準データを解放します。 */
  public async approve(input: ApprovalInput, signal: AbortSignal): Promise<ApprovalResult> {
    this.dependencies.assertMutationRequestAccepted();
    const record = this.dependencies.requireSession(input.session_id);
    this.dependencies.assertProposalOperationAvailable(record);
    const request = this.dependencies.parseApprovalRequest(input);
    const context = this.dependencies.requireContext();
    record.approvalInFlight = true;
    try {
      const result = await this.dependencies.enqueueApproval(record, request, context, signal);
      this.dependencies.forgetProposal(record, result.proposal_id);
      return result;
    } finally {
      record.approvalInFlight = false;
    }
  }

  /** AI変更案の参照または編集に使うセッションを確認します。 */
  public withProposalRecord<Input extends { readonly session_id: string }, Result>(
    input: Input,
    requireAvailable: boolean,
    run: (record: Record) => Result,
  ): Result {
    this.dependencies.assertOperationalReady();
    const record = this.dependencies.requireSession(input.session_id);
    if (requireAvailable) {
      this.dependencies.assertProposalOperationAvailable(record);
    }
    return run(record);
  }
}
