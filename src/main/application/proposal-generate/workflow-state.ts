import { commitTurn as applyTurnCommit } from "./turn-commit";
import { ProposalStore } from "./proposal-store";

type StoredProposal = {
  readonly proposal_id: string;
  readonly selected_operation_ids: readonly string[];
};

type TurnExecutionInput<TRequest, TStored, TPending> = {
  readonly request: TRequest;
  readonly signal: AbortSignal;
  readonly baseProposal: TStored | undefined;
  readonly turnGeneration: number;
  readonly pendingWithdrawConfirmation: TPending | undefined;
  readonly logicalTurnId: string;
  readonly retryProposal: undefined;
};

type TurnCommit<TStored, TPrepared, TPending, TResult> =
  | {
      readonly kind: "no_proposal";
      readonly result: TResult;
      readonly prepared: TPrepared;
      readonly pendingWithdrawConfirmation: { readonly kind: "clear" } | { readonly kind: "set"; readonly value: TPending };
    }
  | {
      readonly kind: "proposal";
      readonly result: TResult;
      readonly prepared: TPrepared;
      readonly storedProposal: TStored;
      readonly replacingProposalId: string | undefined;
      readonly pendingWithdrawConfirmation: { readonly kind: "clear" } | { readonly kind: "set"; readonly value: TPending };
    };

/** AI提案の保持値、会話根拠、購読と世代を一つのセッションで管理します。 */
export class ProposalGenerationState<
  TStored extends StoredProposal,
  TView,
  TSelectionRequest extends { readonly proposal_id: string; readonly selection: unknown },
  TSource,
  TPending,
  TDelta,
> {
  private readonly proposals: ProposalStore<TStored, TView, TSelectionRequest>;
  private readonly completedEvidenceSources = new Map<string, TSource>();
  private readonly deltaListeners = new Set<(delta: TDelta) => void | PromiseLike<unknown>>();
  private readonly removeSessionDelta: () => void;
  private lifecycle: "active" | "disposed" = "active";
  private pendingWithdrawConfirmation: TPending | undefined;
  private sessionGeneration = 0;

  public constructor(
    options: {
      readonly maximumProposals: number;
      readonly parseProposalId: (value: string) => string;
      readonly ProposalNotFoundError: new () => Error;
      readonly WorkflowError: new (message: string) => Error;
      readonly StateError: new (message: string) => Error;
      readonly selection: {
        readonly parseRequest: (value: unknown) => TSelectionRequest;
        readonly resolveSelected: (stored: TStored, selection: TSelectionRequest["selection"]) => readonly string[];
        readonly assertGraphSafe: (stored: TStored, selected: readonly string[]) => void;
        readonly createView: (stored: TStored) => TView;
      };
      readonly onSessionDelta: (listener: (delta: TDelta) => void) => () => void;
      readonly releaseTaskctlSnapshot: () => void;
      readonly reportListenerError: (error: unknown) => void;
    },
  ) {
    this.proposals = new ProposalStore(
      options.maximumProposals,
      options.parseProposalId,
      options.ProposalNotFoundError,
      options.WorkflowError,
      options.StateError,
      options.selection,
    );
    this.removeSessionDelta = options.onSessionDelta((delta) => this.emitDelta(delta));
    this.releaseTaskctlSnapshot = options.releaseTaskctlSnapshot;
    this.reportListenerError = options.reportListenerError;
    this.StateError = options.StateError;
  }

  private readonly releaseTaskctlSnapshot: () => void;
  private readonly reportListenerError: (error: unknown) => void;

  /** CodexのagentMessage差分を購読します。 */
  public onDelta(listener: (delta: TDelta) => void | PromiseLike<unknown>): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("差分購読関数が必要です。");
    }
    this.assertActive();
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** セッションを更新し、保留中の取り下げ確認を破棄します。 */
  public resetPendingWithdrawConfirmation(): void {
    this.sessionGeneration += 1;
    this.pendingWithdrawConfirmation = undefined;
  }

  /** 基準値を固定して一つの生成ターンを実行します。 */
  public async startTurn<
    TRequest extends { readonly base_proposal_id?: string | undefined },
    TResult,
    TCommit,
  >(
    input: unknown,
    signal: AbortSignal,
    dependencies: {
      readonly parseRequest: (value: unknown) => TRequest;
      readonly throwIfAborted: (signal: AbortSignal) => void;
      readonly createTurnId: () => string;
      readonly executeTurn: (
        input: TurnExecutionInput<TRequest, TStored, TPending>,
      ) => Promise<{ readonly kind: "succeeded"; readonly commit: TCommit } | { readonly kind: "failed"; readonly error: unknown }>;
      readonly commitTurn: (commit: TCommit) => TResult;
    },
  ): Promise<TResult> {
    this.assertActive();
    const request = dependencies.parseRequest(input);
    const baseProposal = request.base_proposal_id == null
      ? undefined
      : this.proposals.getStoredProposal(request.base_proposal_id);
    dependencies.throwIfAborted(signal);
    this.proposals.assertProposalCapacity(request.base_proposal_id);
    const execution = await dependencies.executeTurn({
      request,
      signal,
      baseProposal,
      turnGeneration: this.sessionGeneration,
      pendingWithdrawConfirmation: this.pendingWithdrawConfirmation,
      logicalTurnId: dependencies.createTurnId(),
      retryProposal: undefined,
    });
    if (execution.kind === "failed") {
      throw execution.error;
    }
    return dependencies.commitTurn(execution.commit);
  }

  /** 成功したターンの提案、会話根拠、確認状態を確定します。 */
  public commitTurn<TPrepared, TResult>(
    commit: TurnCommit<TStored, TPrepared, TPending, TResult>,
    rememberEvidence: (sources: Map<string, TSource>, prepared: TPrepared) => void,
  ): TResult {
    return applyTurnCommit(commit, {
      storeProposal: (stored, replacingId) => this.proposals.storeProposal(stored, replacingId),
      rememberSuccessfulTurnEvidence: (prepared) =>
        rememberEvidence(this.completedEvidenceSources, prepared),
      setPendingWithdrawConfirmation: (value) => {
        this.pendingWithdrawConfirmation = value;
      },
    });
  }

  /** 完了したターンで採用した会話根拠を返します。 */
  public evidenceSources(): ReadonlyMap<string, TSource> {
    return this.completedEvidenceSources;
  }

  /** 現在のセッション世代を返します。 */
  public generation(): number {
    return this.sessionGeneration;
  }

  /** 保持中の変更案を取得します。 */
  public getStoredProposal(proposalId: string): TStored {
    return this.proposals.getStoredProposal(proposalId);
  }

  /** 保持中の変更案の表示値を返します。 */
  public getProposal(proposalId: string): TView {
    return this.proposals.getProposal(proposalId);
  }

  /** 変更案の選択状態を更新します。 */
  public select(input: unknown): TView {
    return this.proposals.select(input);
  }

  /** 編集後の変更案を保持します。 */
  public setProposal(proposalId: string, stored: TStored): void {
    this.proposals.set(proposalId, stored);
  }

  /** 変更案を破棄します。 */
  public rejectProposal(proposalId: string): void {
    this.proposals.rejectProposal(proposalId);
  }

  /** 適用済みの変更案を保持状態から除きます。 */
  public forgetProposal(proposalId: string): void {
    this.proposals.delete(proposalId);
  }

  /** セッションの購読と保持中の生成結果を破棄します。 */
  public dispose(): void {
    if (this.lifecycle === "disposed") {
      return;
    }
    this.removeSessionDelta();
    this.releaseTaskctlSnapshot();
    this.deltaListeners.clear();
    this.proposals.clear();
    this.completedEvidenceSources.clear();
    this.pendingWithdrawConfirmation = undefined;
    this.sessionGeneration += 1;
    this.lifecycle = "disposed";
  }

  private assertActive(): void {
    if (this.lifecycle === "disposed") {
      throw new this.StateError("AIワークフローは終了しています。");
    }
  }

  private readonly StateError: new (message: string) => Error;

  private emitDelta(delta: TDelta): void {
    for (const listener of this.deltaListeners) {
      const result = listener(delta);
      if (result != null) {
        void Promise.resolve(result)
          .catch((error: unknown) => {
            this.reportListenerError(error);
          })
          .catch((error: unknown) => {
            queueMicrotask(() => {
              throw error;
            });
          });
      }
    }
  }
}
