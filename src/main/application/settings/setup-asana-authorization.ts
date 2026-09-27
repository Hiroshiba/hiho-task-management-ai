type OutOfBandState =
  | { readonly kind: "idle" }
  | {
      readonly kind:
        | "opening"
        | "authorization_pending"
        | "completing"
        | "expired"
        | "cancelled";
      readonly authorization_id: string;
      readonly expires_at: string;
    };

type PendingState = {
  readonly kind: "asana_authorization_pending";
  readonly client_id: string;
  readonly authorization_id: string;
  readonly codex: unknown;
};

type AuthorizationCompletionOperation =
  | { readonly kind: "idle" }
  | { readonly kind: "completing"; readonly authorizationId: string };

function isActiveOutOfBandState(
  state: OutOfBandState,
): state is {
  readonly kind: "opening" | "authorization_pending" | "completing";
  readonly authorization_id: string;
  readonly expires_at: string;
} {
  return state.kind === "opening"
    || state.kind === "authorization_pending"
    || state.kind === "completing";
}

/** 初回設定のAsana OAuth取引と同時完了状態を管理します。 */
export class SetupAsanaAuthorization<
  TState extends { readonly kind: string },
  TPendingState extends TState & PendingState,
  TBeginInput extends { readonly client_id: string },
  TCompleteInput extends { readonly authorization_id: string },
  TCancelInput extends { readonly authorization_id: string },
> {
  private completionOperation: AuthorizationCompletionOperation = { kind: "idle" };

  public constructor(private readonly dependencies: {
    readonly begin: (
      input: TBeginInput,
      signal: AbortSignal,
    ) => Promise<unknown>;
    readonly parseBeginResult: (value: unknown) => {
      readonly authorization_id: string;
      readonly expires_at: string;
    };
    readonly complete: (
      input: TCompleteInput,
      signal: AbortSignal,
    ) => Promise<unknown>;
    readonly parseCompleteResult: (value: unknown) => {
      readonly kind: string;
      readonly client_id: string;
    };
    readonly cancel: (input: TCancelInput) => void;
    readonly cancelByAuthorizationId: (authorizationId: string) => void;
    readonly getOutOfBandState: () => unknown;
    readonly parseOutOfBandState: (value: unknown) => OutOfBandState;
    readonly parseState: (value: unknown) => TState;
    readonly commitState: (state: TState) => TState;
    readonly resetPendingState: (state: TPendingState) => TState;
    readonly createInProgressError: () => Error;
    readonly createIdMismatchError: () => Error;
  }) {}

  /** 待機中の認可取引が現在も有効か照合します。 */
  public currentPendingState(state: TPendingState): TState {
    if (
      this.completionOperation.kind === "completing"
      && this.completionOperation.authorizationId === state.authorization_id
    ) {
      return state;
    }
    const outOfBandState = this.dependencies.parseOutOfBandState(
      this.dependencies.getOutOfBandState(),
    );
    if (isActiveOutOfBandState(outOfBandState)) {
      if (outOfBandState.authorization_id !== state.authorization_id) {
        throw this.dependencies.createIdMismatchError();
      }
      return state;
    }
    return this.dependencies.resetPendingState(state);
  }

  /** 初回Asana OAuth認可を開始します。 */
  public async begin(
    input: TBeginInput,
    getCodexAvailability: () => unknown,
    signal: AbortSignal,
  ): Promise<TState> {
    const result = this.dependencies.parseBeginResult(
      await this.dependencies.begin(input, signal),
    );
    try {
      const outOfBandState = this.dependencies.parseOutOfBandState(
        this.dependencies.getOutOfBandState(),
      );
      if (
        outOfBandState.kind !== "authorization_pending"
        || outOfBandState.authorization_id !== result.authorization_id
        || outOfBandState.expires_at !== result.expires_at
      ) {
        throw new Error("Asana OAuth認可の待機状態が一致しません。");
      }
      return this.dependencies.commitState(this.dependencies.parseState({
        kind: "asana_authorization_pending",
        step: "credentials",
        client_id: input.client_id,
        authorization_id: result.authorization_id,
        expires_at: result.expires_at,
        codex: getCodexAvailability(),
      }));
    } catch (error: unknown) {
      try {
        const outOfBandState = this.dependencies.parseOutOfBandState(
          this.dependencies.getOutOfBandState(),
        );
        if (
          isActiveOutOfBandState(outOfBandState)
          && outOfBandState.authorization_id === result.authorization_id
        ) {
          this.dependencies.cancelByAuthorizationId(result.authorization_id);
        }
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "Asana OAuth認可開始後の後処理に失敗しました。",
          { cause: error },
        );
      }
      throw error;
    }
  }

  /** 認可コードを完了しワークスペース取得へ進みます。 */
  public async complete(
    state: TPendingState,
    input: TCompleteInput,
    signal: AbortSignal,
  ): Promise<TState> {
    if (this.completionOperation.kind === "completing") {
      if (this.completionOperation.authorizationId === input.authorization_id) {
        throw this.dependencies.createInProgressError();
      }
      throw this.dependencies.createIdMismatchError();
    }
    if (input.authorization_id !== state.authorization_id) {
      throw this.dependencies.createIdMismatchError();
    }
    this.completionOperation = {
      kind: "completing",
      authorizationId: state.authorization_id,
    };
    try {
      const outOfBandState = this.dependencies.parseOutOfBandState(
        this.dependencies.getOutOfBandState(),
      );
      if (
        isActiveOutOfBandState(outOfBandState)
        && outOfBandState.authorization_id !== state.authorization_id
      ) {
        throw this.dependencies.createIdMismatchError();
      }
      const result = this.dependencies.parseCompleteResult(
        await this.dependencies.complete(input, signal),
      );
      if (result.kind !== "authenticated" || result.client_id !== state.client_id) {
        throw new Error("Asana OAuthの認証結果が入力と一致しません。");
      }
      return this.dependencies.commitState(this.dependencies.parseState({
        kind: "workspace_listing_required",
        step: "workspace",
        client_id: result.client_id,
        codex: state.codex,
      }));
    } catch (error: unknown) {
      this.dependencies.resetPendingState(state);
      throw error;
    } finally {
      this.completionOperation = { kind: "idle" };
    }
  }

  /** 待機中のAsana OAuth認可を取り消します。 */
  public cancel(state: TPendingState, input: TCancelInput): TState {
    if (this.completionOperation.kind !== "idle") {
      throw this.dependencies.createInProgressError();
    }
    if (input.authorization_id !== state.authorization_id) {
      throw this.dependencies.createIdMismatchError();
    }
    const outOfBandState = this.dependencies.parseOutOfBandState(
      this.dependencies.getOutOfBandState(),
    );
    if (!isActiveOutOfBandState(outOfBandState)) {
      return this.dependencies.resetPendingState(state);
    }
    if (outOfBandState.authorization_id !== state.authorization_id) {
      throw this.dependencies.createIdMismatchError();
    }
    this.dependencies.cancel(input);
    return this.dependencies.resetPendingState(state);
  }
}
