type ReviewRecord = {
  readonly proposal_id: string;
  readonly state: { readonly kind: string };
};

type ReviewTarget = { readonly proposal_id: string; readonly request_id: string };

/** 外部提案の確認画面とGUI状態の購読を管理します。 */
export class ExternalAgentReview<TState> {
  private readonly listeners = new Set<(state: TState) => void>();
  private currentTarget: ReviewTarget | undefined;

  public constructor(private readonly getState: () => TState) {}

  /** 現在の確認画面の対象を返します。 */
  public get target(): ReviewTarget | undefined {
    return this.currentTarget;
  }

  /** GUI状態の変更購読を登録します。 */
  public onChanged(listener: (state: TState) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("外部連携状態の購読関数が必要です。");
    }
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** GUI状態の変更を購読者へ通知します。 */
  public emitChanged(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }

  /** GUI状態の購読を破棄します。 */
  public clear(): void {
    this.listeners.clear();
  }

  /** 提案の確認画面を開きます。 */
  public async open<TRecord extends ReviewRecord, TResponse>(
    proposalId: string,
    ports: {
      readonly requireProposal: (proposalId: string) => TRecord;
      readonly createId: () => string;
      readonly openReview: (proposalId: string, requestId: string) => PromiseLike<void> | void;
      readonly createResponse: (proposalId: string, requestId: string) => TResponse;
      readonly createConflictError: () => Error;
    },
  ): Promise<TResponse> {
    const record = ports.requireProposal(proposalId);
    if (record.state.kind !== "pending_approval" && record.state.kind !== "approving") {
      throw ports.createConflictError();
    }
    const requestId = ports.createId();
    this.currentTarget = { proposal_id: record.proposal_id, request_id: requestId };
    this.emitChanged();
    await ports.openReview(record.proposal_id, requestId);
    return ports.createResponse(record.proposal_id, requestId);
  }
}
