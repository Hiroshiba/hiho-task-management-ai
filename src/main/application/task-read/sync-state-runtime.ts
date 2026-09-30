type RuntimeState =
  | { readonly kind: "syncing"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "online"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "offline"; readonly last_successful_sync_at?: string | undefined }
  | { readonly kind: "authentication_required"; readonly last_successful_sync_at?: string | undefined }
  | {
      readonly kind: "error";
      readonly error_code: string;
      readonly last_successful_sync_at?: string | undefined;
    };

export type SyncStateDependencies<State extends RuntimeState, Event> = {
  readonly toEvent: (state: State) => Event;
  readonly recordDiagnostic: (code: "sync.started" | "sync.completed") => void;
  readonly shouldReportKnownFailure: () => boolean;
  readonly reportKnownFailure: (cause: unknown) => void;
  readonly reportListenerFailure: (error: unknown) => void;
  readonly lifecycleSignal: AbortSignal;
  readonly afterLocalStateRefresh: (signal: AbortSignal) => Promise<void>;
  readonly isReadyActivated: () => boolean;
  readonly synchronizeCodex: (signal: AbortSignal) => Promise<void>;
  readonly reportUnexpectedError: (error: unknown, feature: "display_order" | "codex") => void;
};

/** Asana同期状態の購読、診断、補助更新を管理します。 */
export class SyncStateRuntime<State extends RuntimeState, Event> {
  private readonly listeners = new Set<(state: Event) => void>();
  private removeRuntimeSubscription: (() => void) | undefined;
  private lastDisplaySyncAt: string | undefined;
  private diagnosticState:
    | { readonly kind: "idle" }
    | { readonly kind: "running"; readonly previous_success_at: string | undefined } = {
      kind: "idle",
    };

  public constructor(private readonly dependencies: SyncStateDependencies<State, Event>) {}

  /** 同期ランタイムの状態変更を購読します。 */
  public subscribeRuntime(runtime: {
    subscribe(listener: (state: State, cause?: unknown) => void): () => void;
  }): void {
    this.removeRuntimeSubscription = runtime.subscribe((state, cause) => {
      this.handleRuntimeState(state, cause);
    });
  }

  /** IPC同期状態の購読関数を登録します。 */
  public onState(listener: (state: Event) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("同期状態の購読関数が必要です。");
    }
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** ランタイムとIPC同期状態の購読を解除します。 */
  public stop(): void {
    this.removeRuntimeSubscription?.();
    this.removeRuntimeSubscription = undefined;
    this.listeners.clear();
  }

  private recordSyncStateDiagnostic(state: State, cause?: unknown): void {
    const diagnosticState = this.diagnosticState;
    if (state.kind === "syncing") {
      if (diagnosticState.kind === "idle") {
        this.dependencies.recordDiagnostic("sync.started");
        this.diagnosticState = {
          kind: "running",
          previous_success_at: state.last_successful_sync_at,
        };
      }
      return;
    }
    if (diagnosticState.kind === "idle") {
      return;
    }
    this.diagnosticState = { kind: "idle" };
    if (
      state.kind === "online"
      && state.last_successful_sync_at != null
      && state.last_successful_sync_at !== diagnosticState.previous_success_at
    ) {
      this.dependencies.recordDiagnostic("sync.completed");
      return;
    }
    if (
      state.kind === "authentication_required"
      || (state.kind === "error" && state.error_code !== "unexpected_error")
    ) {
      if (this.dependencies.shouldReportKnownFailure()) {
        this.dependencies.reportKnownFailure(cause);
      }
    }
  }

  private handleRuntimeState(state: State, cause?: unknown): void {
    const ipcState = this.dependencies.toEvent(state);
    for (const listener of this.listeners) {
      try {
        listener(ipcState);
      } catch (error: unknown) {
        this.dependencies.reportListenerFailure(error);
      }
    }
    this.recordSyncStateDiagnostic(state, cause);
    if (
      state.last_successful_sync_at == null
      || state.last_successful_sync_at === this.lastDisplaySyncAt
      || this.dependencies.lifecycleSignal.aborted
    ) {
      return;
    }
    this.lastDisplaySyncAt = state.last_successful_sync_at;
    void this.dependencies.afterLocalStateRefresh(this.dependencies.lifecycleSignal).catch(
      (error: unknown) => this.dependencies.reportUnexpectedError(error, "display_order"),
    );
    if (this.dependencies.isReadyActivated()) {
      void this.dependencies.synchronizeCodex(this.dependencies.lifecycleSignal).catch(
        (error: unknown) => this.dependencies.reportUnexpectedError(error, "codex"),
      );
    }
  }
}
