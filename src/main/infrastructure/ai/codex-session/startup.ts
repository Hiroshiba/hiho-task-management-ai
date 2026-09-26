import type { AccountInspectionResult } from "./connection-inspector";
import { validateAbortSignal } from "../codex-app-server/rpc-endpoint";
import {
  CodexSessionAbortedError,
  CodexSessionAuthenticationError,
  CodexSessionStateError,
} from "./errors";

type StartupState = "created" | "starting" | "authentication_required" | "ready" | "turning" | "restarting" | "stopping" | "stopped" | "disabled" | "failed";

type SessionStartupOptions<Connection, TaskctlStartResult, StartResult> = {
  readonly getState: () => StartupState;
  readonly setState: (state: StartupState) => void;
  readonly getConnection: () => Connection | undefined;
  readonly getTaskctlStartResult: () => TaskctlStartResult | undefined;
  readonly setTaskctlStartResult: (result: TaskctlStartResult) => void;
  readonly hasActiveTurn: () => boolean;
  readonly isSafetyViolation: () => boolean;
  readonly isConnectionConfigurationChanged: () => boolean;
  readonly installLifecycleAbort: (signal: AbortSignal) => void;
  readonly startTaskctl: (signal: AbortSignal) => Promise<TaskctlStartResult>;
  readonly connectWithInitialRetry: (signal: AbortSignal) => Promise<void>;
  readonly assertSafetyIntact: () => void;
  readonly markSuccessfullyStarted: () => void;
  readonly createStartResult: () => StartResult;
  readonly createAuthenticationRequiredResult: () => StartResult;
  readonly cleanupResources: () => Promise<unknown[]>;
  readonly recordDiagnosticLocally: (code: "connection_stop_error" | "startup_error", error: unknown) => void;
  readonly restartConnectionForConfigurationChange: (signal: AbortSignal) => Promise<void>;
  readonly inspectAccountWithRetry: (connection: Connection, signal: AbortSignal) => Promise<AccountInspectionResult>;
  readonly inspectModel: (connection: Connection, signal: AbortSignal) => Promise<void>;
  readonly inspectSkills: (connection: Connection, signal: AbortSignal) => Promise<void>;
  readonly inspectPermissionProfile: (connection: Connection, signal: AbortSignal) => Promise<void>;
  readonly startThreadOnCurrentConnection: (signal: AbortSignal) => Promise<void>;
  readonly disableAi: (request: {
    cause: unknown;
    turnFailure: { kind: "disabled" };
    diagnosticDisposition: { kind: "propagate_unrecorded" };
  }) => Promise<{ kind: "completed" } | { kind: "cleanup_failed"; errors: readonly unknown[] }>;
  readonly combineSessionFailure: (error: unknown, cleanupErrors: readonly unknown[]) => unknown;
  readonly createRecordedSessionFailure: (recordedError: unknown, responseError: unknown) => unknown;
  readonly createSafetyViolationError: (cause: unknown) => unknown;
};

/** Codexセッションの開始、認証再開、新規スレッド開始を調整します。 */
export class CodexSessionStartup<Connection, TaskctlStartResult, StartResult> {
  public constructor(private readonly options: SessionStartupOptions<Connection, TaskctlStartResult, StartResult>) {}

  /** Codex認証、能力、スキルを検査して新規スレッドを開始します。 */
  public async start(signal: AbortSignal): Promise<StartResult> {
    validateAbortSignal(signal);
    if (this.options.getState() !== "created") {
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    this.options.setState("starting");
    this.options.installLifecycleAbort(signal);

    try {
      this.options.setTaskctlStartResult(await this.options.startTaskctl(signal));
      await this.options.connectWithInitialRetry(signal);
      this.options.assertSafetyIntact();
      this.options.markSuccessfullyStarted();
      this.options.setState("ready");
      return this.options.createStartResult();
    } catch (error: unknown) {
      if (
        error instanceof CodexSessionAuthenticationError
        && this.options.getConnection() != null
        && this.options.getTaskctlStartResult() != null
        && !this.options.isSafetyViolation()
        && !signal.aborted
      ) {
        this.options.markSuccessfullyStarted();
        this.options.setState("authentication_required");
        return this.options.createAuthenticationRequiredResult();
      }
      const cleanupErrors = await this.options.cleanupResources();
      if (cleanupErrors.length > 0) {
        for (const cleanupError of cleanupErrors) {
          this.options.recordDiagnosticLocally("connection_stop_error", cleanupError);
        }
      }
      if (signal.aborted) {
        this.options.setState("stopped");
        if (cleanupErrors.length === 0) {
          throw error;
        }
        throw this.options.combineSessionFailure(error, cleanupErrors);
      }
      if (this.options.isSafetyViolation()) {
        this.options.setState("disabled");
        const safetyError = this.options.createSafetyViolationError(error);
        this.options.recordDiagnosticLocally("startup_error", safetyError);
        throw this.options.combineSessionFailure(
          this.options.createRecordedSessionFailure(error, safetyError),
          cleanupErrors,
        );
      }
      this.options.recordDiagnosticLocally("startup_error", error);
      this.options.setState("disabled");
      throw this.options.combineSessionFailure(error, cleanupErrors);
    }
  }

  /** ChatGPTログイン後に能力検査と新規スレッド開始を再開します。 */
  public async completeAuthentication(signal: AbortSignal): Promise<StartResult> {
    validateAbortSignal(signal);
    const connection = this.options.getConnection();
    if (this.options.getState() !== "authentication_required" || connection == null) {
      throw new CodexSessionStateError();
    }
    this.options.assertSafetyIntact();
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    this.options.setState("starting");
    const shouldRestartConnection = this.options.isConnectionConfigurationChanged();
    try {
      if (shouldRestartConnection) {
        await this.options.restartConnectionForConfigurationChange(signal);
        this.options.assertSafetyIntact();
        this.options.setState("ready");
        return this.options.createStartResult();
      }
      const accountInspection = await this.options.inspectAccountWithRetry(connection, signal);
      if (accountInspection.kind === "authentication_pending") {
        this.options.setState("authentication_required");
        return this.options.createAuthenticationRequiredResult();
      }
      if (accountInspection.kind === "wrong_account_type") {
        throw new CodexSessionAuthenticationError();
      }
      await this.options.inspectModel(connection, signal);
      await this.options.inspectSkills(connection, signal);
      if (process.platform !== "win32") {
        await this.options.inspectPermissionProfile(connection, signal);
      }
      await this.options.startThreadOnCurrentConnection(signal);
      this.options.assertSafetyIntact();
      this.options.setState("ready");
      return this.options.createStartResult();
    } catch (error: unknown) {
      if (
        shouldRestartConnection
        && error instanceof CodexSessionAuthenticationError
        && this.options.getConnection() != null
        && !this.options.isSafetyViolation()
      ) {
        this.options.setState("authentication_required");
        return this.options.createAuthenticationRequiredResult();
      }
      if (error instanceof CodexSessionAuthenticationError && !this.options.isSafetyViolation()) {
        this.options.setState("authentication_required");
        throw error;
      }
      if (this.options.isSafetyViolation()) {
        throw this.options.createRecordedSessionFailure(
          error,
          this.options.createSafetyViolationError(error),
        );
      }
      const disableResult = await this.options.disableAi({
        cause: error,
        turnFailure: { kind: "disabled" },
        diagnosticDisposition: { kind: "propagate_unrecorded" },
      });
      throw this.options.combineSessionFailure(
        error,
        disableResult.kind === "cleanup_failed" ? disableResult.errors : [],
      );
    }
  }

  /** GUIの新規セッション用に現在接続で新しいスレッドを開始します。 */
  public async startNewSession(signal: AbortSignal): Promise<StartResult> {
    validateAbortSignal(signal);
    if (this.options.getState() !== "ready" || this.options.hasActiveTurn()) {
      throw new CodexSessionStateError();
    }
    this.options.assertSafetyIntact();
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const connection = this.options.getConnection();
    if (connection == null) {
      throw new CodexSessionStateError();
    }
    this.options.setState("starting");
    const shouldRestartConnection = this.options.isConnectionConfigurationChanged();
    try {
      if (shouldRestartConnection) {
        await this.options.restartConnectionForConfigurationChange(signal);
        this.options.assertSafetyIntact();
        this.options.setState("ready");
        return this.options.createStartResult();
      }
      await this.options.inspectSkills(connection, signal);
      if (process.platform !== "win32") {
        await this.options.inspectPermissionProfile(connection, signal);
      }
      await this.options.inspectModel(connection, signal);
      await this.options.startThreadOnCurrentConnection(signal);
      this.options.assertSafetyIntact();
      this.options.setState("ready");
      return this.options.createStartResult();
    } catch (error: unknown) {
      if (
        shouldRestartConnection
        && error instanceof CodexSessionAuthenticationError
        && this.options.getConnection() != null
        && !this.options.isSafetyViolation()
      ) {
        this.options.setState("authentication_required");
        return this.options.createAuthenticationRequiredResult();
      }
      const disableResult = await this.options.disableAi({
        cause: error,
        turnFailure: { kind: "disabled" },
        diagnosticDisposition: { kind: "propagate_unrecorded" },
      });
      throw this.options.combineSessionFailure(
        error,
        disableResult.kind === "cleanup_failed" ? disableResult.errors : [],
      );
    }
  }

}
