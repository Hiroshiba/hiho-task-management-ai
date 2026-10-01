type MainShutdownDependencies = {
  readonly stopOAuthAuthorization: () => void;
  readonly externalAgent: { stop(): Promise<void> };
  readonly externalAgentBridge: { stop(): Promise<void> };
  readonly stopSyncSubscriptions: () => void;
  readonly clearAiListeners: () => void;
  readonly closeAiSessions: (errors: unknown[]) => Promise<void>;
  readonly displayOrder: () => { stop(): Promise<void> } | undefined;
  readonly runtime: () => { stop(): Promise<void> } | undefined;
  readonly operationQueue: { stop(): Promise<void> };
  readonly stopCodexSession: () => Promise<void>;
  readonly recordDiagnostic: () => void;
  readonly combineFailures: (errors: unknown[]) => Error;
};

/** Mainが所有する資源を依存順に停止します。 */
export class MainShutdownRuntime {
  private stopped = false;

  public constructor(private readonly dependencies: MainShutdownDependencies) {}

  /** アプリケーションが停止処理に入ったかを返します。 */
  public isStopped(): boolean {
    return this.stopped;
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
    try {
      this.dependencies.recordDiagnostic();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw this.dependencies.combineFailures(errors);
    }
  }
}
