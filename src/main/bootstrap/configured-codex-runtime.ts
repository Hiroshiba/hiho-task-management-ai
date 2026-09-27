type LaunchState =
  | { readonly kind: "pending" }
  | { readonly kind: "running"; readonly operation: Promise<void> }
  | { readonly kind: "settled" };

type ConfiguredCodexDependencies = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly isSessionUnstarted: () => boolean;
  readonly hasStartResult: () => boolean;
  readonly startConfigured: (signal: AbortSignal) => Promise<void>;
  readonly rethrowFeatureAbort: (error: unknown, signal: AbortSignal) => void;
  readonly recordStartFailure: (error: unknown) => void;
  readonly disableAfterStartFailure: () => void;
  readonly verifyCapabilities: (signal: AbortSignal) => Promise<void>;
};

/** 設定済みCodexの起動試行とAsana同期後の再確認を管理します。 */
export class ConfiguredCodexRuntime {
  private launchState: LaunchState = { kind: "pending" };
  private synchronizationPromise: Promise<void> | undefined;

  public constructor(private readonly dependencies: ConfiguredCodexDependencies) {}

  /** 外部ツール安全措置後の起動試行を終了済みにします。 */
  public settleLaunch(): void {
    this.launchState = { kind: "settled" };
  }

  private async startUnstartedSafely(signal: AbortSignal): Promise<void> {
    if (!this.dependencies.isSessionUnstarted()) {
      return;
    }
    if (this.dependencies.hasStartResult()) {
      throw new Error("未開始のCodexセッションに起動済み結果が設定されています。");
    }
    try {
      await this.dependencies.startConfigured(signal);
    } catch (error: unknown) {
      this.dependencies.rethrowFeatureAbort(error, signal);
      this.dependencies.recordStartFailure(error);
      this.dependencies.disableAfterStartFailure();
    }
  }

  /** 設定済みCodexの起動試行を一度だけ実行します。 */
  public async ensureLaunchAttempt(signal: AbortSignal): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    const launchState = this.launchState;
    if (launchState.kind === "settled") {
      return;
    }
    if (launchState.kind === "running") {
      await launchState.operation;
      this.dependencies.throwIfAborted(signal);
      return;
    }
    const operation = this.startUnstartedSafely(signal);
    this.launchState = { kind: "running", operation };
    try {
      await operation;
    } finally {
      const currentState = this.launchState;
      if (currentState.kind === "running" && currentState.operation === operation) {
        this.launchState = { kind: "settled" };
      }
    }
  }

  /** Asana同期後のCodex確認を一つの実行へまとめます。 */
  public async synchronizeAfterAsana(signal: AbortSignal): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    const runningSynchronization = this.synchronizationPromise;
    if (runningSynchronization != null) {
      await runningSynchronization;
      this.dependencies.throwIfAborted(signal);
      return;
    }
    const synchronization = this.performSynchronization(signal);
    this.synchronizationPromise = synchronization;
    try {
      await synchronization;
    } finally {
      if (this.synchronizationPromise === synchronization) {
        this.synchronizationPromise = undefined;
      }
    }
  }

  private async performSynchronization(signal: AbortSignal): Promise<void> {
    await this.ensureLaunchAttempt(signal);
    await this.dependencies.verifyCapabilities(signal);
  }
}
