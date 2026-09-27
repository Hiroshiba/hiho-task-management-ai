type OAuthState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "opening" | "authorization_pending" | "completing" | "expired" | "cancelled";
      readonly authorization_id: string;
      readonly expires_at: string;
    };

type AuthenticationStateInput =
  | { readonly kind: "idle" }
  | {
      readonly kind: "opening" | "authorization_pending";
      readonly authorization_id: string;
      readonly expires_at: string;
    }
  | {
      readonly kind: "completing" | "synchronizing";
      readonly authorization_id: string;
    };

type ReauthenticationOperation =
  | { readonly kind: "idle" }
  | { readonly kind: "completing" | "synchronizing"; readonly authorizationId: string };

type ReauthenticationDependencies<
  Settings extends { readonly client_id: string },
  CompleteInput extends { readonly authorization_id: string },
  CancelInput extends { readonly authorization_id: string },
  AuthenticationState,
  SyncResult,
> = {
  readonly requireSettings: () => Settings;
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly parseCompleteInput: (input: unknown) => CompleteInput;
  readonly parseCancelInput: (input: unknown) => CancelInput;
  readonly readOAuthState: () => OAuthState;
  readonly beginOAuth: (clientId: string, signal: AbortSignal) => Promise<{
    readonly authorization_id: string;
    readonly expires_at: string;
  }>;
  readonly completeOAuth: (input: CompleteInput, signal: AbortSignal) => Promise<{
    readonly client_id: string;
  }>;
  readonly cancelOAuth: (authorizationId: string) => void;
  readonly parseAuthenticationState: (state: AuthenticationStateInput) => AuthenticationState;
  readonly createInProgressError: () => Error;
  readonly createAuthorizationIdMismatchError: () => Error;
  readonly createNotPendingError: () => Error;
  readonly invalidatePendingMutations: () => void;
  readonly expireExternalAgent: () => void;
  readonly enqueueContextChange: (
    signal: AbortSignal,
    run: (operationSignal: AbortSignal) => Promise<void>,
  ) => Promise<unknown>;
  readonly configureAsana: (settings: Settings) => void;
  readonly synchronize: (signal: AbortSignal) => Promise<SyncResult>;
  readonly restoreContext: () => void;
};

/** 設定済みAsana OAuthの再認証状態と同期への復帰を管理します。 */
export class AsanaReauthenticationRuntime<
  Settings extends { readonly client_id: string },
  CompleteInput extends { readonly authorization_id: string },
  CancelInput extends { readonly authorization_id: string },
  AuthenticationState,
  SyncResult,
> {
  private operation: ReauthenticationOperation = { kind: "idle" };

  public constructor(
    private readonly dependencies: ReauthenticationDependencies<
      Settings,
      CompleteInput,
      CancelInput,
      AuthenticationState,
      SyncResult
    >,
  ) {}

  /** Asana再認証のIPC操作を公開します。 */
  public createPort(): {
    readonly getAuthenticationState: () => AuthenticationState;
    readonly beginReauthentication: (signal: AbortSignal) => Promise<AuthenticationState>;
    readonly completeReauthentication: (input: CompleteInput, signal: AbortSignal) => Promise<SyncResult>;
    readonly cancelReauthentication: (input: CancelInput, signal: AbortSignal) => AuthenticationState;
  } {
    return {
      getAuthenticationState: () => this.getState(),
      beginReauthentication: (signal) => this.begin(signal),
      completeReauthentication: (input, signal) => this.complete(input, signal),
      cancelReauthentication: (input, signal) => this.cancel(input, signal),
    };
  }

  /** 再認証中の操作競合を拒否します。 */
  public assertIdle(): void {
    if (this.operation.kind !== "idle") {
      throw this.dependencies.createInProgressError();
    }
  }

  /** 現在のOAuth認証状態を返します。 */
  public getState(): AuthenticationState {
    this.dependencies.requireSettings();
    if (this.operation.kind !== "idle") {
      return this.toOperationState(this.operation);
    }
    return this.toAuthenticationState(this.dependencies.readOAuthState());
  }

  /** 設定済みAsana OAuthの再認証を開始します。 */
  public async begin(signal: AbortSignal): Promise<AuthenticationState> {
    const settings = this.dependencies.requireSettings();
    this.dependencies.validateAbortSignal(signal);
    this.assertIdle();
    this.dependencies.throwIfAborted(signal);
    const result = await this.dependencies.beginOAuth(settings.client_id, signal);
    try {
      const state = this.dependencies.readOAuthState();
      if (
        state.kind !== "authorization_pending"
        || state.authorization_id !== result.authorization_id
        || state.expires_at !== result.expires_at
      ) {
        throw new Error("Asana OAuth再認証の開始状態が不正です。");
      }
      return this.toAuthenticationState(state);
    } catch (error: unknown) {
      return this.rethrowAfterBeginFailure(result.authorization_id, error);
    }
  }

  /** 設定済みAsana OAuthの再認証を完了して同期します。 */
  public async complete(input: unknown, signal: AbortSignal): Promise<SyncResult> {
    const settings = this.dependencies.requireSettings();
    this.dependencies.validateAbortSignal(signal);
    const validatedInput = this.dependencies.parseCompleteInput(input);
    const operation = this.operation;
    if (operation.kind !== "idle") {
      if (operation.authorizationId !== validatedInput.authorization_id) {
        throw this.dependencies.createAuthorizationIdMismatchError();
      }
      throw this.dependencies.createInProgressError();
    }
    this.dependencies.throwIfAborted(signal);
    this.operation = {
      kind: "completing",
      authorizationId: validatedInput.authorization_id,
    };
    this.dependencies.invalidatePendingMutations();
    this.dependencies.expireExternalAgent();
    try {
      await this.dependencies.enqueueContextChange(signal, async (operationSignal) => {
        const authentication = await this.dependencies.completeOAuth(
          validatedInput,
          operationSignal,
        );
        if (authentication.client_id !== settings.client_id) {
          throw new Error("Asana OAuth再認証結果のClient IDが一致しません。");
        }
        this.dependencies.throwIfAborted(operationSignal);
        this.dependencies.configureAsana(settings);
        this.operation = {
          kind: "synchronizing",
          authorizationId: validatedInput.authorization_id,
        };
      });
      return await this.dependencies.synchronize(signal);
    } finally {
      this.operation = { kind: "idle" };
      this.dependencies.restoreContext();
    }
  }

  /** 設定済みAsana OAuthの再認証を取り消します。 */
  public cancel(input: unknown, signal: AbortSignal): AuthenticationState {
    this.dependencies.requireSettings();
    this.dependencies.validateAbortSignal(signal);
    const validatedInput = this.dependencies.parseCancelInput(input);
    const operation = this.operation;
    if (operation.kind !== "idle") {
      if (operation.authorizationId !== validatedInput.authorization_id) {
        throw this.dependencies.createAuthorizationIdMismatchError();
      }
      throw this.dependencies.createInProgressError();
    }
    this.dependencies.throwIfAborted(signal);
    const state = this.dependencies.readOAuthState();
    if (state.kind === "idle") {
      throw this.dependencies.createNotPendingError();
    }
    if (state.authorization_id !== validatedInput.authorization_id) {
      throw this.dependencies.createAuthorizationIdMismatchError();
    }
    if (state.kind === "expired" || state.kind === "cancelled") {
      return this.toAuthenticationState(state);
    }
    if (state.kind === "completing") {
      throw this.dependencies.createInProgressError();
    }
    this.dependencies.cancelOAuth(validatedInput.authorization_id);
    return this.toAuthenticationState(this.dependencies.readOAuthState());
  }

  private rethrowAfterBeginFailure(authorizationId: string, error: unknown): never {
    try {
      const state = this.dependencies.readOAuthState();
      if (
        (state.kind === "opening"
          || state.kind === "authorization_pending"
          || state.kind === "completing")
        && state.authorization_id === authorizationId
      ) {
        this.dependencies.cancelOAuth(authorizationId);
      }
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Asana OAuth再認証開始後の後処理に失敗しました。",
        { cause: error },
      );
    }
    throw error;
  }

  private toAuthenticationState(state: OAuthState): AuthenticationState {
    switch (state.kind) {
      case "idle":
      case "expired":
      case "cancelled":
        return this.dependencies.parseAuthenticationState({ kind: "idle" });
      case "opening":
      case "authorization_pending":
        return this.dependencies.parseAuthenticationState({
          kind: state.kind,
          authorization_id: state.authorization_id,
          expires_at: state.expires_at,
        });
      case "completing":
        return this.dependencies.parseAuthenticationState({
          kind: "completing",
          authorization_id: state.authorization_id,
        });
    }
  }

  private toOperationState(operation: ReauthenticationOperation): AuthenticationState {
    switch (operation.kind) {
      case "idle":
        return this.dependencies.parseAuthenticationState({ kind: "idle" });
      case "completing":
      case "synchronizing":
        return this.dependencies.parseAuthenticationState({
          kind: operation.kind,
          authorization_id: operation.authorizationId,
        });
    }
  }
}
