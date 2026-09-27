type RuntimeResult =
  | { readonly kind: "synchronized" }
  | { readonly kind: "aborted" }
  | { readonly kind: "rejected"; readonly reason: "stopped" | "offline" }
  | { readonly kind: "failed" };

type RuntimePort<Result extends RuntimeResult> = {
  getState(): { readonly kind: string };
  start(signal: AbortSignal): Promise<Result>;
  deferSynchronizationUntilRecovery(): void;
  stop(): Promise<void>;
};

type MainLifecycleDependencies<State extends { readonly kind: string }, ApplicationState, Result extends RuntimeResult> = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly initializeExternalAgentBridge: () => Promise<void>;
  readonly ensureTasksVaultMapping: (signal: AbortSignal) => Promise<void>;
  readonly recordDiagnostic: (code: "app.start" | "app.stop") => void;
  readonly reconcileExternalTools: (signal: AbortSignal) => Promise<void>;
  readonly getSetupState: () => State;
  readonly isOnline: () => boolean;
  readonly restoreReadyDeviceSettings: () => void;
  readonly startSetup: (signal: AbortSignal) => Promise<State>;
  readonly restoreCodexSession: (signal: AbortSignal) => Promise<State>;
  readonly isContextState: (state: State) => boolean;
  readonly resumeSetup: (state: State, signal: AbortSignal) => Promise<State>;
  readonly configureAsanaFromStoredSettings: () => void;
  readonly configureContextFromState: (state: State) => void;
  readonly getApplicationState: () => ApplicationState;
  readonly configureOperationalServices: () => void;
  readonly requireRuntime: () => RuntimePort<Result>;
  readonly recoverJournal: (signal: AbortSignal) => Promise<void>;
  readonly rethrowFeatureAbort: (error: unknown, signal: AbortSignal) => void;
  readonly recordJournalRecoveryFailure: (error: unknown) => void;
  readonly ensureCodexLaunch: (signal: AbortSignal) => Promise<void>;
  readonly afterSynchronizedState: (
    result: Extract<Result, { readonly kind: "synchronized" }>,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly isSynchronizedResult: (
    result: Result,
  ) => result is Extract<Result, { readonly kind: "synchronized" }>;
  readonly stopOAuthAuthorization: () => void;
  readonly stopExternalConfiguration: (errors: unknown[]) => Promise<void>;
  readonly externalAgent: { stop(): Promise<void> };
  readonly externalAgentBridge: { stop(): Promise<void> };
  readonly stopSyncSubscriptions: () => void;
  readonly clearAiListeners: () => void;
  readonly closeAiSessions: (errors: unknown[]) => Promise<void>;
  readonly displayOrder: () => { stop(): Promise<void> } | undefined;
  readonly runtime: () => RuntimePort<Result> | undefined;
  readonly operationQueue: { stop(): Promise<void> };
  readonly stopCodexSession: () => Promise<void>;
  readonly externalBroker: () => { stop(): Promise<void> } | undefined;
  readonly markExternalStopped: () => void;
  readonly combineFailures: (errors: unknown[]) => Error;
};

/** Mainの起動、ready活性化、停止順を管理します。 */
export class MainLifecycleRuntime<
  State extends { readonly kind: string },
  ApplicationState,
  Result extends RuntimeResult,
> {
  private readyActivated = false;
  private stopped = false;

  public constructor(
    private readonly dependencies: MainLifecycleDependencies<State, ApplicationState, Result>,
  ) {}

  /** 運用サービスの活性化が完了したかを返します。 */
  public isReadyActivated(): boolean {
    return this.readyActivated;
  }

  /** アプリケーションが停止処理に入ったかを返します。 */
  public isStopped(): boolean {
    return this.stopped;
  }

  /** 設定再開、復旧、同期を実行します。 */
  public async start(signal: AbortSignal): Promise<ApplicationState> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    if (this.stopped) {
      throw new Error("アプリケーションは停止済みです。");
    }
    await this.dependencies.initializeExternalAgentBridge();
    await this.dependencies.ensureTasksVaultMapping(signal);
    this.dependencies.recordDiagnostic("app.start");
    await this.dependencies.reconcileExternalTools(signal);
    let state = this.dependencies.getSetupState();
    const readyCheckpointOffline = state.kind === "ready" && !this.dependencies.isOnline();
    if (state.kind === "ready") {
      this.dependencies.restoreReadyDeviceSettings();
    }
    if (state.kind === "created" || state.kind === "codex_cli_ready") {
      state = await this.dependencies.startSetup(signal);
    } else if (!readyCheckpointOffline) {
      state = await this.dependencies.restoreCodexSession(signal);
      if (state.kind === "resources_requires_action" || this.dependencies.isContextState(state)) {
        state = await this.dependencies.resumeSetup(state, signal);
      }
    }
    this.dependencies.configureAsanaFromStoredSettings();
    this.dependencies.configureContextFromState(state);
    if (state.kind === "ready") {
      await this.activateReady(signal);
    }
    return this.dependencies.getApplicationState();
  }

  /** 設定完了後に運用サービスと起動同期を活性化します。 */
  public async activateReady(signal: AbortSignal): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    if (this.readyActivated) {
      return;
    }
    this.dependencies.configureOperationalServices();
    const runtime = this.dependencies.requireRuntime();
    const startedOffline = runtime.getState().kind === "offline";
    let synchronizationDeferred = startedOffline;
    if (!synchronizationDeferred) {
      try {
        await this.dependencies.recoverJournal(signal);
      } catch (error: unknown) {
        this.dependencies.rethrowFeatureAbort(error, signal);
        this.dependencies.recordJournalRecoveryFailure(error);
        runtime.deferSynchronizationUntilRecovery();
        synchronizationDeferred = true;
      }
    }
    if (!startedOffline) {
      await this.dependencies.ensureCodexLaunch(signal);
    }
    if (!synchronizationDeferred) {
      const runtimeResult = await runtime.start(signal);
      if (this.dependencies.isSynchronizedResult(runtimeResult)) {
        await this.dependencies.afterSynchronizedState(runtimeResult, signal);
      } else if (runtimeResult.kind === "aborted") {
        throw new Error("設定済みアプリケーションの起動同期が中断されました。");
      } else if (runtimeResult.kind === "rejected" && runtimeResult.reason === "stopped") {
        throw new Error("停止済みのAsana同期ランタイムは起動できません。");
      }
    }
    this.readyActivated = true;
  }

  private async stopAsyncService(
    service: { stop(): Promise<void> } | undefined,
    errors: unknown[],
  ): Promise<void> {
    if (service == null) {
      return;
    }
    try {
      await service.stop();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  /** 運用サービスを依存順に停止し、失敗を集約します。 */
  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const errors: unknown[] = [];
    try {
      this.dependencies.stopOAuthAuthorization();
    } catch (error: unknown) {
      errors.push(error);
    }
    await this.dependencies.stopExternalConfiguration(errors);
    await this.stopAsyncService(this.dependencies.externalAgent, errors);
    await this.stopAsyncService(this.dependencies.externalAgentBridge, errors);
    this.dependencies.stopSyncSubscriptions();
    this.dependencies.clearAiListeners();
    await this.dependencies.closeAiSessions(errors);
    await this.stopAsyncService(this.dependencies.displayOrder(), errors);
    await this.stopAsyncService(this.dependencies.runtime(), errors);
    await this.stopAsyncService(this.dependencies.operationQueue, errors);
    try {
      await this.dependencies.stopCodexSession();
    } catch (error: unknown) {
      errors.push(error);
    }
    await this.stopAsyncService(this.dependencies.externalBroker(), errors);
    this.dependencies.markExternalStopped();
    try {
      this.dependencies.recordDiagnostic("app.stop");
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw this.dependencies.combineFailures(errors);
    }
  }
}
