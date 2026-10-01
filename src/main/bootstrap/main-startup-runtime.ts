type RuntimeResult =
  | { readonly kind: "synchronized" }
  | { readonly kind: "aborted" }
  | { readonly kind: "rejected"; readonly reason: "stopped" | "offline" }
  | { readonly kind: "failed" };

type RuntimePort<Result extends RuntimeResult> = {
  getState(): { readonly kind: string };
  start(signal: AbortSignal): Promise<Result>;
  deferSynchronizationUntilRecovery(): void;
};

type MainStartupDependencies<ApplicationState, Result extends RuntimeResult> = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly isStopped: () => boolean;
  readonly initializeExternalAgentBridge: () => Promise<void>;
  readonly ensureTasksVaultMapping: (signal: AbortSignal) => Promise<void>;
  readonly recordDiagnostic: () => void;
  readonly restoreSetup: (signal: AbortSignal) => Promise<{ readonly ready: boolean }>;
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
};

/** Mainの起動とready活性化で資源の実行順を管理します。 */
export class MainStartupRuntime<ApplicationState, Result extends RuntimeResult> {
  private readyActivated = false;

  public constructor(private readonly dependencies: MainStartupDependencies<ApplicationState, Result>) {}

  /** 運用サービスの活性化が完了したかを返します。 */
  public isReadyActivated(): boolean {
    return this.readyActivated;
  }

  /** 設定再開、復旧、同期を実行します。 */
  public async start(signal: AbortSignal): Promise<ApplicationState> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    if (this.dependencies.isStopped()) {
      throw new Error("アプリケーションは停止済みです。");
    }
    await this.dependencies.initializeExternalAgentBridge();
    await this.dependencies.ensureTasksVaultMapping(signal);
    this.dependencies.recordDiagnostic();
    const restored = await this.dependencies.restoreSetup(signal);
    if (restored.ready) {
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
}
