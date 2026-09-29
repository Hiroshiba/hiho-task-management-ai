import type { PowerMonitor } from "electron";
import { diagnosticFailureDispositionFromError } from "../application/common/errors/diagnostic-failure";
import { AsanaSyncRuntimeAlreadyReportedError } from "../infrastructure/asana";
import type { DiagnosticRecord } from "../infrastructure/persistence";
import type { MainRuntime } from "./create-main-runtime";

const onlinePollIntervalMilliseconds = 2_000;

type OnlineMonitorState =
  | { readonly kind: "idle" }
  | { readonly kind: "stopped" }
  | {
      readonly kind: "running";
      readonly timer: ReturnType<typeof setInterval>;
      readonly lastOnline: boolean;
    };

type OperationalEventDependencies = {
  readonly powerMonitor: PowerMonitor;
  readonly isOnline: () => boolean;
  readonly isRunning: () => boolean;
  readonly getRuntime: () => MainRuntime | undefined;
  readonly isStartupReady: () => boolean;
  readonly reportPersistentError: (code: DiagnosticRecord["code"], error: unknown) => void;
  readonly recordDiagnostic: (code: DiagnosticRecord["code"], error: unknown) => void;
};

/** 復帰と接続変化を監視し、背景処理の完了まで管理します。 */
export class OperationalEventRuntime {
  private backgroundOperations: Promise<void> = Promise.resolve();
  private onlineMonitorState: OnlineMonitorState = { kind: "idle" };
  private foregroundScheduled = false;
  private onlinePollScheduled = false;

  public constructor(private readonly dependencies: OperationalEventDependencies) {}

  /** ウィンドウの前面化を受けて同期を予約します。 */
  public readonly scheduleForegroundSync = (): void => {
    if (
      this.foregroundScheduled
      || !this.dependencies.isRunning()
      || !this.dependencies.isStartupReady()
    ) {
      return;
    }
    this.foregroundScheduled = true;
    this.enqueueBackgroundOperation(async () => {
      try {
        const runtime = this.dependencies.getRuntime();
        if (runtime == null) {
          throw new Error("アプリケーションが初期化されていません。");
        }
        if (runtime.getState().kind !== "configured") {
          return;
        }
        await runtime.taskRead.onForeground(runtime.signal);
      } finally {
        this.foregroundScheduled = false;
      }
    }, "sync.failed");
  };

  private enqueueBackgroundOperation(
    operation: () => Promise<void>,
    failureCode: DiagnosticRecord["code"],
  ): void {
    this.backgroundOperations = this.backgroundOperations.then(async () => {
      const runtime = this.dependencies.getRuntime();
      if (!this.dependencies.isRunning() || runtime == null || runtime.signal.aborted) {
        return;
      }
      try {
        await operation();
      } catch (error) {
        if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
          return;
        }
        const disposition = diagnosticFailureDispositionFromError(error);
        switch (disposition.kind) {
          case "recorded_only":
            return;
          case "unrecorded_only":
          case "recorded_and_unrecorded":
            this.dependencies.reportPersistentError(failureCode, disposition.unrecorded_error);
            if (!runtime.signal.aborted) {
              this.dependencies.recordDiagnostic(failureCode, disposition.unrecorded_error);
            }
            return;
        }
      }
    });
  }

  private updateOnlineMonitorState(
    monitor: Extract<OnlineMonitorState, { readonly kind: "running" }>,
    lastOnline: boolean,
  ): void {
    const activeMonitor = this.onlineMonitorState;
    if (activeMonitor.kind === "running" && activeMonitor.timer === monitor.timer) {
      this.onlineMonitorState = { kind: "running", timer: monitor.timer, lastOnline };
    }
  }

  private readonly scheduleOnlinePoll = (): void => {
    if (
      this.onlinePollScheduled
      || !this.dependencies.isRunning()
      || !this.dependencies.isStartupReady()
    ) {
      return;
    }
    this.onlinePollScheduled = true;
    this.enqueueBackgroundOperation(async () => {
      try {
        const monitor = this.onlineMonitorState;
        const runtime = this.dependencies.getRuntime();
        if (monitor.kind !== "running" || runtime == null) {
          return;
        }
        const currentOnline = this.dependencies.isOnline();
        if (currentOnline === monitor.lastOnline) {
          return;
        }
        const applicationConfigured = runtime.getState().kind === "configured";
        if (!currentOnline) {
          if (applicationConfigured) {
            runtime.taskRead.setOnline(false);
          }
          this.updateOnlineMonitorState(monitor, false);
          return;
        }
        if (!applicationConfigured) {
          this.updateOnlineMonitorState(monitor, true);
          return;
        }
        try {
          await runtime.taskRead.onOnline();
        } catch (error) {
          try {
            runtime.taskRead.setOnline(false);
          } catch (restoreError) {
            throw new AggregateError(
              [error, restoreError],
              "オンライン復帰失敗後の状態復元に失敗しました。",
              { cause: error },
            );
          }
          throw error;
        }
        this.updateOnlineMonitorState(monitor, true);
      } finally {
        this.onlinePollScheduled = false;
      }
    }, "sync.failed");
  };

  /** 運用イベントの監視を一度だけ開始します。 */
  public start(): void {
    if (this.onlineMonitorState.kind !== "idle") {
      throw new Error("運用イベント監視は重複開始できません。");
    }
    const lastOnline = this.dependencies.isOnline();
    const timer = setInterval(this.scheduleOnlinePoll, onlinePollIntervalMilliseconds);
    try {
      this.dependencies.powerMonitor.on("resume", this.scheduleForegroundSync);
    } catch (error) {
      clearInterval(timer);
      throw error;
    }
    this.onlineMonitorState = {
      kind: "running",
      timer,
      lastOnline,
    };
  }

  /** 監視を解除し、予約済みの背景処理を待ちます。 */
  public async stop(): Promise<void> {
    const monitor = this.onlineMonitorState;
    if (monitor.kind === "running") {
      clearInterval(monitor.timer);
      this.dependencies.powerMonitor.removeListener("resume", this.scheduleForegroundSync);
    }
    this.onlineMonitorState = { kind: "stopped" };
    await this.backgroundOperations;
  }
}
