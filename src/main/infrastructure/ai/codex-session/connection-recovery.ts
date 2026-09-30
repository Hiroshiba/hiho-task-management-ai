import type { ActiveTurn, ActiveTurnStarting } from "./turn-coordinator";
import {
  CodexSessionAbortedError,
  CodexSessionAuthenticationError,
  CodexSessionError,
} from "./errors";

type DisableRequest = {
  readonly cause: unknown;
  readonly turnFailure: { kind: "disabled" } | { kind: "provided"; error: unknown };
  readonly diagnosticDisposition: { kind: "record" } | { kind: "already_recorded" };
};

type ConnectionRecoveryOptions<Result, Connection> = {
  readonly getActiveTurn: () => ActiveTurn<Result, Connection> | undefined;
  readonly finishTurn: (active: ActiveTurn<Result, Connection>, error: unknown) => void;
  readonly getLifecycleSignal: () => AbortSignal | undefined;
  readonly getRecoveryAbortController: () => AbortController | undefined;
  readonly setRecoveryAbortController: (controller: AbortController | undefined) => void;
  readonly getState: () => string;
  readonly setState: (state: "restarting" | "ready" | "authentication_required") => void;
  readonly cleanupConnection: () => Promise<unknown[]>;
  readonly disableAi: (request: DisableRequest) => Promise<unknown>;
  readonly connectAndStartThread: (signal: AbortSignal) => Promise<void>;
  readonly recordDiagnosticLocally: (code: "restart_started" | "restart_completed", error: unknown) => void;
  readonly recordDiagnosticAndNotify: (code: "connection_stop_error" | "connection_process_exit", error: unknown) => void;
  readonly assertSafetyIntact: () => void;
  readonly isSafetyViolation: () => boolean;
  readonly getConnection: () => Connection | undefined;
  readonly isSuccessfullyStarted: () => boolean;
  readonly isProcessExitError: (error: unknown) => boolean;
  readonly createSafetyViolationError: (error: unknown) => unknown;
  readonly createRecordedSessionFailure: (error: unknown, responseError: unknown) => unknown;
};

/** Codex接続の初期再試行、異常終了、ターン中断後の復旧を管理します。 */
export class CodexConnectionRecovery<Result, Connection> {
  private restartCount = 0;
  private restartPromise: Promise<void> | undefined;

  public constructor(private readonly options: ConnectionRecoveryOptions<Result, Connection>) {}

  /** 開始中のターンを中断してCodex接続を復旧します。 */
  public async recoverAfterStartingAbort(
    active: ActiveTurnStarting<Result>,
    cause: unknown,
  ): Promise<void> {
    if (this.options.getActiveTurn() !== active) {
      return;
    }
    const abortedError = new CodexSessionAbortedError();
    const lifecycleSignal = this.options.getLifecycleSignal();
    if (lifecycleSignal == null || lifecycleSignal.aborted) {
      await this.options.disableAi({
        cause,
        turnFailure: { kind: "provided", error: abortedError },
        diagnosticDisposition: { kind: "record" },
      });
      return;
    }
    this.options.setState("restarting");
    const cleanupErrors = await this.options.cleanupConnection();
    if (cleanupErrors.length > 0) {
      await this.options.disableAi(
        {
          cause: new CodexSessionError(
            "Codex接続を安全に停止できませんでした。",
            new AggregateError(cleanupErrors),
          ),
          turnFailure: { kind: "provided", error: abortedError },
          diagnosticDisposition: { kind: "record" },
        },
      );
      return;
    }
    if (this.options.getActiveTurn() !== active || this.options.getState() !== "restarting") {
      return;
    }
    const recoveryController = new AbortController();
    this.options.setRecoveryAbortController(recoveryController);
    const lifecycleAbortListener = (): void => {
      recoveryController.abort();
    };
    lifecycleSignal.addEventListener("abort", lifecycleAbortListener, { once: true });
    try {
      await this.options.connectAndStartThread(recoveryController.signal);
      if (recoveryController.signal.aborted) {
        throw new CodexSessionAbortedError();
      }
      this.options.setState("ready");
      this.options.finishTurn(active, abortedError);
    } catch (error: unknown) {
      await this.options.disableAi({
        cause: error,
        turnFailure: { kind: "provided", error: abortedError },
        diagnosticDisposition: { kind: "record" },
      });
    } finally {
      if (this.options.getRecoveryAbortController() === recoveryController) {
        this.options.setRecoveryAbortController(undefined);
      }
      lifecycleSignal.removeEventListener("abort", lifecycleAbortListener);
    }
  }


  /** 初回のプロセス終了だけ再試行してCodex接続を開始します。 */
  public async connectWithInitialRetry(signal: AbortSignal): Promise<void> {
    this.options.assertSafetyIntact();
    try {
      await this.options.connectAndStartThread(signal);
      this.options.assertSafetyIntact();
    } catch (error: unknown) {
      if (this.options.isSafetyViolation()) {
        throw this.options.createSafetyViolationError(error);
      }
      if (!(this.options.isProcessExitError(error)) || this.restartCount > 0 || signal.aborted) {
        throw error;
      }
      this.restartCount += 1;
      this.options.recordDiagnosticLocally("restart_started", error);
      const cleanupErrors = await this.options.cleanupConnection();
      try {
        await this.options.connectAndStartThread(signal);
        this.options.assertSafetyIntact();
        for (const cleanupError of cleanupErrors) {
          this.options.recordDiagnosticAndNotify("connection_stop_error", cleanupError);
        }
        this.options.recordDiagnosticLocally("restart_completed", error);
      } catch (retryError: unknown) {
        if (cleanupErrors.length === 0) {
          throw retryError;
        }
        throw new AggregateError(
          [retryError, ...cleanupErrors],
          "Codex接続の再起動と後処理に失敗しました。",
          { cause: retryError },
        );
      }
    }
  }


  /** 設定変更に合わせてCodex接続を作り直します。 */
  public async restartConnectionForConfigurationChange(signal: AbortSignal): Promise<void> {
    const cleanupErrors = await this.options.cleanupConnection();
    if (cleanupErrors.length > 0) {
      throw new CodexSessionError(
        "Codex接続を安全に停止できませんでした。",
        new AggregateError(cleanupErrors),
      );
    }
    await this.options.connectAndStartThread(signal);
  }


  /** 起動後のCodexプロセス終了を処理します。 */
  public handleProcessExit(
    processExitError: unknown,
  ): void {
    if (
      !this.options.isSuccessfullyStarted()
      || (
        this.options.getState() !== "ready"
        && this.options.getState() !== "turning"
        && this.options.getState() !== "authentication_required"
      )
    ) {
      return;
    }
    this.options.recordDiagnosticAndNotify("connection_process_exit", processExitError);
    const active = this.options.getActiveTurn();
    if (active != null) {
      this.options.finishTurn(active, this.options.createRecordedSessionFailure(processExitError, processExitError));
    }
    if (this.restartPromise != null) {
      return;
    }
    if (this.restartCount > 0) {
      void this.options.disableAi({
        cause: processExitError,
        turnFailure: { kind: "disabled" },
        diagnosticDisposition: { kind: "already_recorded" },
      });
      return;
    }
    const signal = this.options.getLifecycleSignal();
    if (signal == null || signal.aborted) {
      void this.options.disableAi({
        cause: processExitError,
        turnFailure: { kind: "disabled" },
        diagnosticDisposition: { kind: "already_recorded" },
      });
      return;
    }
    this.restartCount += 1;
    this.restartPromise = this.restartConnection(signal).finally(() => {
      this.restartPromise = undefined;
    });
  }

  private async restartConnection(signal: AbortSignal): Promise<void> {
    this.options.assertSafetyIntact();
    this.options.setState("restarting");
    this.options.recordDiagnosticLocally("restart_started", undefined);
    const cleanupErrors = await this.options.cleanupConnection();
    for (const cleanupError of cleanupErrors) {
      this.options.recordDiagnosticAndNotify("connection_stop_error", cleanupError);
    }
    try {
      await this.options.connectAndStartThread(signal);
      this.options.assertSafetyIntact();
      this.options.setState("ready");
      this.options.recordDiagnosticLocally("restart_completed", undefined);
    } catch (error: unknown) {
      if (
        error instanceof CodexSessionAuthenticationError
        && this.options.getConnection() != null
        && !this.options.isSafetyViolation()
      ) {
        this.options.setState("authentication_required");
        return;
      }
      await this.options.disableAi({
        cause: error,
        turnFailure: { kind: "disabled" },
        diagnosticDisposition: { kind: "record" },
      });
    }
  }

}
