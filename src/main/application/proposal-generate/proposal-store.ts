/** 保持中の変更案と件数上限を管理します。 */
export class ProposalStore<
  TProposal extends { readonly proposal_id: string; readonly selected_operation_ids: readonly string[] },
  TView,
  TSelectionRequest extends { readonly proposal_id: string; readonly selection: unknown },
> extends Map<string, TProposal> {
  public constructor(
    private readonly maximumProposals: number,
    private readonly parseProposalId: (value: string) => string,
    private readonly ProposalNotFoundError: new () => Error,
    private readonly WorkflowError: new (message: string) => Error,
    private readonly StateError: new (message: string) => Error,
    private readonly selection: {
      readonly parseRequest: (value: unknown) => TSelectionRequest;
      readonly resolveSelected: (stored: TProposal, selection: TSelectionRequest["selection"]) => readonly string[];
      readonly assertGraphSafe: (stored: TProposal, selected: readonly string[]) => void;
      readonly createView: (stored: TProposal) => TView;
    },
  ) {
    super();
  }

  /** 変更案IDを検証して保持値を取得します。 */
  public getStoredProposal(proposalId: string): TProposal {
    const parsedProposalId = this.parseProposalId(proposalId);
    const stored = this.get(parsedProposalId);
    if (stored == null) {
      throw new this.ProposalNotFoundError();
    }
    return stored;
  }

  /** 保持中の変更案を表示値に変換して返します。 */
  public getProposal(proposalId: string): TView {
    return this.selection.createView(this.getStoredProposal(proposalId));
  }

  /** 選択操作を保存し、更新後の表示値を返します。 */
  public select(input: unknown): TView {
    const request = this.selection.parseRequest(input);
    const stored = this.getStoredProposal(request.proposal_id);
    const selectedOperationIds = this.selection.resolveSelected(stored, request.selection);
    this.selection.assertGraphSafe(stored, selectedOperationIds);
    const updated: TProposal = {
      ...stored,
      selected_operation_ids: [...selectedOperationIds],
    };
    this.set(stored.proposal_id, updated);
    return this.selection.createView(updated);
  }

  /** 変更案IDを検証し、保持中の変更案を破棄します。 */
  public rejectProposal(proposalId: string): void {
    const parsedProposalId = this.parseProposalId(proposalId);
    if (!this.delete(parsedProposalId)) {
      throw new this.ProposalNotFoundError();
    }
  }

  /** 変更案を重複と件数上限を確認して保持します。 */
  public storeProposal(stored: TProposal, replacingProposalId: string | undefined): void {
    if (this.has(stored.proposal_id)) {
      throw new this.WorkflowError("同じ変更案IDを重複して保持できません。");
    }
    this.assertProposalCapacity(replacingProposalId);
    this.set(stored.proposal_id, stored);
  }

  /** 新しい変更案を保持できる件数か確認します。 */
  public assertProposalCapacity(replacingProposalId: string | undefined): void {
    if (
      this.size >= this.maximumProposals
      && (replacingProposalId == null || !this.has(replacingProposalId))
    ) {
      throw new this.StateError(
        "保持中の変更案が上限に達しています。新しい変更案を作る前に既存案を承認または却下してください。",
      );
    }
  }

  /** 再取得後の適用結果を確認して変更案を保持状態から除きます。 */
  public async approve<
    TRequest extends { readonly proposal_id: string; readonly selection: unknown },
    TSelection,
    TPreparation,
    TInput,
    TApplication extends { readonly proposal_id: string },
    TResult,
  >(
    input: unknown,
    signal: AbortSignal,
    dependencies: {
      readonly parseRequest: (value: unknown) => TRequest;
      readonly throwIfAborted: (signal: AbortSignal) => void;
      readonly resolveSelection: (stored: TProposal, selection: TRequest["selection"]) => TSelection;
      readonly assertGraphSafe: (stored: TProposal, selected: TSelection) => void;
      readonly isOnline: () => boolean;
      readonly OfflineError: new () => Error;
      readonly createPreparationInput: (stored: TProposal, selected: TSelection) => TPreparation;
      readonly prepareApprovalInput: (input: TPreparation, signal: AbortSignal) => TInput | PromiseLike<TInput>;
      readonly parseApprovalInput: (value: TInput) => TInput;
      readonly assertApprovalInputMatchesStored: (input: TInput, stored: TProposal, selected: TSelection) => void;
      readonly apply: (input: TInput, signal: AbortSignal) => TApplication | PromiseLike<TApplication>;
      readonly parseApplication: (value: TApplication) => TApplication;
      readonly createResult: (stored: TProposal, application: TApplication) => TResult;
    },
  ): Promise<TResult> {
    const request = dependencies.parseRequest(input);
    dependencies.throwIfAborted(signal);
    const stored = this.getStoredProposal(request.proposal_id);
    const selected = dependencies.resolveSelection(stored, request.selection);
    dependencies.assertGraphSafe(stored, selected);
    if (dependencies.isOnline() !== true) {
      throw new dependencies.OfflineError();
    }
    const approvalInput = await dependencies.prepareApprovalInput(
      dependencies.createPreparationInput(stored, selected), signal,
    );
    const validatedInput = dependencies.parseApprovalInput(approvalInput);
    dependencies.assertApprovalInputMatchesStored(validatedInput, stored, selected);
    if (dependencies.isOnline() !== true) {
      throw new dependencies.OfflineError();
    }
    const application = dependencies.parseApplication(
      await dependencies.apply(validatedInput, signal),
    );
    if (application.proposal_id !== stored.proposal_id) {
      throw new this.WorkflowError("適用結果の変更案IDが一致しません。");
    }
    const result = dependencies.createResult(stored, application);
    this.delete(stored.proposal_id);
    return result;
  }
}
