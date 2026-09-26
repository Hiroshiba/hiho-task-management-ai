import { timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { createExternalToolConnectionFiles, errorCode } from "../infrastructure/ai/external-tools/connection-files";
import { createExternalToolInvocationPolicy } from "../infrastructure/ai/external-tools/invocation-policy";
import { jsonDepth } from "../infrastructure/ai/external-tools/json-depth";
import { createExternalToolRunWithRetries } from "../infrastructure/ai/external-tools/run-with-retries";
import { listenExternalToolServer } from "../infrastructure/ai/external-tools/server-listener";
import {
  externalToolBrokerOptionsSchema,
  externalToolBrokerStartResultSchema,
  externalToolConnectionInfoSchema,
  externalToolDiagnosticSchema,
  externalToolDiagnosticsSchema,
  externalToolDefinitionSchema,
  externalToolExecutionResultSchema,
  externalToolInvocationSchema,
  externalToolMaxConnections,
  externalToolMaxDiagnostics,
  externalToolMaxJsonDepth,
  externalToolMaxRequestBytes,
  externalToolMaxResponseBytes,
  externalToolMaximumRetries,
  externalToolOutputSchema,
  externalToolProtocolVersion,
  externalToolRequestSchema,
  externalToolResponseSchema,
  externalToolStatusEvidenceAttemptSchema,
  type ExternalToolBrokerOptions,
  type ExternalToolBrokerStartResult,
  type ExternalToolDefinition,
  type ExternalToolDiagnostic,
  type ExternalToolDiagnosticCode,
  type ExternalToolExecutionResult,
  type ExternalToolInvocation,
  type ExternalToolOutput,
  type ExternalToolResponse,
  type ExternalToolStatusEvidenceAttempt,
} from "./schemas";
import { ExternalToolError } from "./errors";
import { executeDiscordReadInvocation } from "./discord";

const maximumRequestMilliseconds = 35_000;
const externalToolRetryDelayMilliseconds = 1_000;

type BrokerState =
  | "created"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "disabled"
  | "failed";

type ConnectionInfo = {
  readonly version: number;
  readonly endpoint: string;
  readonly capability: string;
};

type ClientConnection = {
  readonly socket: Socket;
  readonly abortController: AbortController;
  buffer: Buffer;
  requestReceived: boolean;
  responseStarted: boolean;
};

type InternalDiagnostic = {
  readonly code: ExternalToolDiagnosticCode;
  readonly cause: unknown;
};

type CleanupResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: AggregateError };

type ActiveRun = {
  readonly controller: AbortController;
  readonly completion: Promise<ExternalToolExecutionResult>;
};

type ExternalToolRunner = (
  tool: ExternalToolDefinition,
  invocation: ExternalToolInvocation,
  credentialProvider: ExternalToolBrokerOptions["discord_credential_provider"],
  signal: AbortSignal,
) => Promise<ExternalToolOutput>;

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
    || typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function createAbortError(signal: AbortSignal): ExternalToolError {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return new ExternalToolError(
      "aborted",
      "外部ツール要求が中断されました。",
      false,
      error,
    );
  }
  throw new Error("中断済みAbortSignalの理由を取得できません。");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError(signal);
  }
}

function createErrorResponse(error: unknown): ExternalToolResponse {
  if (error instanceof ExternalToolError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: errorMessage(error.code),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "internal_error",
      message: errorMessage("internal_error"),
    },
  };
}

function errorMessage(code: import("./schemas").ExternalToolErrorCode): string {
  const messages: Record<import("./schemas").ExternalToolErrorCode, string> = {
    invalid_request: "外部ツール要求が不正です。",
    capability_invalid: "外部ツールの能力値が不正です。",
    tool_not_registered: "指定された外部ツールは登録されていません。",
    forbidden_subcommand: "許可されていないサブコマンドです。",
    forbidden_write_operation: "書き込み系の外部ツール操作は実行できません。",
    forbidden_network: "許可されていない外部ネットワーク操作です。",
    credential_unavailable: "外部ツールの資格情報を利用できません。",
    tool_not_found: "外部ツール実行ファイルが見つかりません。",
    tool_execution_failed: "外部ツールの実行に失敗しました。",
    execution_timeout: "外部ツールの実行時間が上限を超えました。",
    output_too_large: "外部ツール出力がサイズ上限を超えました。",
    invalid_output: "外部ツール出力が不正です。",
    invalid_utf8: "外部ツール出力の文字コードが不正です。",
    broker_unavailable: "外部ツールブローカーを利用できません。",
    broker_stopped: "外部ツールブローカーは停止しています。",
    broker_start_failed: "外部ツールブローカーを起動できません。",
    broker_stop_failed: "外部ツールブローカーを停止できません。",
    ipc_unavailable: "外部ツールIPCを利用できません。",
    permission_denied: "外部ツールIPCの権限を設定できません。",
    response_too_large: "外部ツールIPC応答がサイズ上限を超えました。",
    registry_conflict: "外部ツール登録が競合しました。",
    aborted: "外部ツール要求が中断されました。",
    internal_error: "外部ツール処理で内部エラーが発生しました。",
  };
  return messages[code];
}

function serializeResponse(response: ExternalToolResponse): string {
  const validated = externalToolResponseSchema.parse(response);
  const serialized = JSON.stringify(validated);
  if (serialized == null) {
    throw new ExternalToolError(
      "response_too_large",
      "外部ツールIPC応答をJSON化できません。",
      false,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > externalToolMaxResponseBytes) {
    throw new ExternalToolError(
      "response_too_large",
      "外部ツールIPC応答がサイズ上限を超えました。",
      false,
    );
  }
  return `${serialized}\n`;
}

function isCapabilityFailure(error: unknown): boolean {
  if (error instanceof ExternalToolError) {
    return error.code === "ipc_unavailable" || error.code === "permission_denied";
  }
  const code = errorCode(error);
  return code === "EACCES" || code === "EPERM" || code === "ENOTSUP" || code === "ENAMETOOLONG";
}

function disabledReason(error: unknown): "ipc_unavailable" | "permission_denied" {
  if (error instanceof ExternalToolError && error.code === "permission_denied") {
    return "permission_denied";
  }
  const code = errorCode(error);
  if (code === "EACCES" || code === "EPERM") {
    return "permission_denied";
  }
  return "ipc_unavailable";
}

function createBrokerStoppedError(): ExternalToolError {
  return new ExternalToolError(
    "broker_stopped",
    "外部ツールブローカーは停止しています。",
    false,
  );
}

function isBrokerSupportedPlatform(): boolean {
  return process.platform === "linux"
    || process.platform === "darwin"
    || process.platform === "freebsd"
    || process.platform === "openbsd"
    || process.platform === "sunos"
    || process.platform === "aix";
}

/** 読み取り専用外部ツールを実行するメインプロセス内ブローカーです。 */
export class ExternalToolBroker {
  private readonly connectionFiles: ReturnType<typeof createExternalToolConnectionFiles>;
  private readonly invocationPolicy: ReturnType<typeof createExternalToolInvocationPolicy>;
  private readonly runWithRetries: ExternalToolRunner;
  private readonly tmpDirectoryPath: string;
  private readonly registry: ExternalToolBrokerOptions["registry"];
  private readonly discordCredentialProvider: ExternalToolBrokerOptions["discord_credential_provider"];
  private readonly statusEvidenceCollector: ExternalToolBrokerOptions["status_evidence_collector"];
  private readonly connectionInfoPath: string;
  private state: BrokerState = "created";
  private server: Server | undefined;
  private endpoint: string | undefined;
  private connectionInfo: ConnectionInfo | undefined;
  private readonly connections = new Map<Socket, ClientConnection>();
  private readonly activeRuns = new Map<AbortController, ActiveRun>();
  private readonly diagnostics: InternalDiagnostic[] = [];
  private stopPromise: Promise<void> | undefined;
  private stopRequested = false;
  private startAbortSignal: AbortSignal | undefined;
  private startAbortListener: (() => void) | undefined;
  private startController: AbortController | undefined;
  private startListenPromise: Promise<void> | undefined;
  private startAbortStopPromise: Promise<void> | undefined;

  public constructor(options: ExternalToolBrokerOptions) {
    const validatedOptions = externalToolBrokerOptionsSchema.parse(options);
    this.runWithRetries = createExternalToolRunWithRetries(
      ExternalToolError,
      executeDiscordReadInvocation,
      throwIfAborted,
      createAbortError,
      externalToolMaximumRetries,
      externalToolRetryDelayMilliseconds,
    );
    this.invocationPolicy = createExternalToolInvocationPolicy(
      ExternalToolError,
      externalToolMaxRequestBytes,
    );
    this.connectionFiles = createExternalToolConnectionFiles(
      ExternalToolError,
      (value) => externalToolConnectionInfoSchema.parse(value),
      externalToolMaxRequestBytes,
    );
    this.tmpDirectoryPath = validatedOptions.tmp_directory_path;
    this.registry = validatedOptions.registry;
    this.discordCredentialProvider = validatedOptions.discord_credential_provider;
    this.statusEvidenceCollector = validatedOptions.status_evidence_collector;
    this.connectionInfoPath = join(this.tmpDirectoryPath, "contextctl-connection.json");
  }

  /** 外部ツール用の安全なローカルIPCを起動します。 */
  public async start(signal: AbortSignal): Promise<ExternalToolBrokerStartResult> {
    validateAbortSignal(signal);
    if (this.state !== "created") {
      throw new ExternalToolError(
        "broker_start_failed",
        "外部ツールブローカーは一度だけ起動できます。",
        false,
      );
    }
    throwIfAborted(signal);
    if (!isBrokerSupportedPlatform()) {
      this.state = "disabled";
      return externalToolBrokerStartResultSchema.parse({
        kind: "disabled",
        reason: "unsupported_platform",
      });
    }
    this.state = "starting";
    this.stopRequested = false;
    const startController = new AbortController();
    this.startController = startController;
    const onAbort = (): void => {
      this.startAbortStopPromise = this.stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    this.startAbortSignal = signal;
    this.startAbortListener = onAbort;
    try {
      this.connectionFiles.ensureIpcDirectory(this.tmpDirectoryPath);
      this.connectionFiles.ensureConnectionInfoAbsent(this.connectionInfoPath);
      const endpoint = externalToolConnectionInfoSchema.shape.endpoint.parse(
        this.connectionFiles.createEndpoint(this.tmpDirectoryPath),
      );
      if (Buffer.byteLength(endpoint, "utf8") >= 108) {
        throw new ExternalToolError(
          "ipc_unavailable",
          "外部ツールIPC接続先が長すぎます。",
          false,
        );
      }
      const connectionInfo = externalToolConnectionInfoSchema.parse({
        version: externalToolProtocolVersion,
        endpoint,
        capability: this.connectionFiles.createCapability(),
      });
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        this.handleConnection(socket);
      });
      this.server = server;
      this.endpoint = endpoint;
      this.connectionInfo = connectionInfo;
      server.on("error", (error: Error) => {
        this.handleServerError(error);
      });
      const listenPromise = listenExternalToolServer(
        server,
        endpoint,
        startController.signal,
        createBrokerStoppedError,
        errorCode,
      );
      this.startListenPromise = listenPromise;
      await listenPromise;
      this.startListenPromise = undefined;
      throwIfAborted(signal);
      if (this.stopRequested) {
        throw createBrokerStoppedError();
      }
      this.connectionFiles.secureUnixSocket(endpoint);
      if (this.stopRequested) {
        throw createBrokerStoppedError();
      }
      this.connectionFiles.writeConnectionInfoAtomically(this.connectionInfoPath, connectionInfo);
      if (this.stopRequested) {
        throw createBrokerStoppedError();
      }
      this.state = "ready";
      if (signal.aborted) {
        const abortStopPromise = this.startAbortStopPromise ?? this.stop();
        await abortStopPromise;
        throw createAbortError(signal);
      }
      if (this.stopRequested) {
        await this.stop();
        throw createBrokerStoppedError();
      }
      this.startController = undefined;
      return externalToolBrokerStartResultSchema.parse({
        kind: "ready",
        version: externalToolProtocolVersion,
        endpoint,
        connection_info_path: this.connectionInfoPath,
      });
    } catch (error) {
      this.startListenPromise = undefined;
      this.removeStartAbortListener();
      this.recordDiagnostic(error, "startup_error");
      const abortStopPromise = this.startAbortStopPromise;
      let abortStopResult:
        | { readonly kind: "not_requested" }
        | { readonly kind: "succeeded" }
        | { readonly kind: "failed"; readonly error: unknown } = {
        kind: "not_requested",
      };
      if (abortStopPromise != null) {
        try {
          await abortStopPromise;
          abortStopResult = { kind: "succeeded" };
        } catch (stopError) {
          abortStopResult = { kind: "failed", error: stopError };
        }
      }
      this.startAbortStopPromise = undefined;
      const cleanupResult = await this.cleanupResources();
      this.startController = undefined;
      if (abortStopResult.kind === "failed") {
        this.state = "failed";
        const errors: unknown[] = [error, abortStopResult.error];
        if (cleanupResult.kind === "failed") {
          errors.push(cleanupResult.error);
        }
        const aggregateError = new AggregateError(
          errors,
          "外部ツールブローカーの起動と停止に失敗しました。",
          { cause: error },
        );
        throw new ExternalToolError(
          "broker_start_failed",
          "外部ツールブローカーの起動と停止に失敗しました。",
          false,
          aggregateError,
        );
      }
      if (this.stopRequested) {
        if (cleanupResult.kind === "failed") {
          this.state = "failed";
          throw new ExternalToolError(
            "broker_start_failed",
            "外部ツールブローカーの起動と後処理に失敗しました。",
            false,
            new AggregateError([error, cleanupResult.error], "外部ツールブローカーの起動に失敗しました。", {
              cause: error,
            }),
          );
        }
        this.state = "stopped";
        throw error;
      }
      if (isCapabilityFailure(error) && cleanupResult.kind === "succeeded") {
        this.state = "disabled";
        return externalToolBrokerStartResultSchema.parse({
          kind: "disabled",
          reason: disabledReason(error),
        });
      }
      this.state = "failed";
      if (cleanupResult.kind === "failed") {
        throw new ExternalToolError(
          "broker_start_failed",
          "外部ツールブローカーの起動と後処理に失敗しました。",
          false,
          new AggregateError([error, cleanupResult.error], "外部ツールブローカーの起動に失敗しました。", {
            cause: error,
          }),
        );
      }
      throw error;
    }
  }

  /** 外部ツールIPCを停止し接続情報を削除します。 */
  public stop(): Promise<void> {
    this.stopRequested = true;
    const currentPromise = this.stopPromise;
    if (currentPromise != null) {
      return currentPromise;
    }
    const stopPromise = this.stopInternal();
    this.stopPromise = stopPromise;
    return stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") {
      this.removeStartAbortListener();
      return;
    }
    if (this.state === "created" || this.state === "disabled") {
      this.removeStartAbortListener();
      this.state = "stopped";
      return;
    }
    this.state = "stopping";
    this.removeStartAbortListener();
    const startController = this.startController;
    if (startController != null) {
      startController.abort();
    }
    for (const connection of this.connections.values()) {
      connection.abortController.abort();
      connection.socket.destroy();
    }
    for (const activeRun of this.activeRuns.values()) {
      activeRun.controller.abort();
    }
    const stopErrors: unknown[] = [];
    const startListenPromise = this.startListenPromise;
    if (startListenPromise != null) {
      try {
        await startListenPromise;
      } catch (error) {
        if (!(error instanceof ExternalToolError) || error.code !== "broker_stopped") {
          stopErrors.push(error);
        }
      }
    }
    const activeRunCompletions = [...this.activeRuns.values()].map(
      (activeRun) => activeRun.completion,
    );
    const runOutcomes = await Promise.allSettled(activeRunCompletions);
    for (const runOutcome of runOutcomes) {
      if (runOutcome.status === "rejected") {
        if (
          runOutcome.reason instanceof ExternalToolError
          && runOutcome.reason.code === "aborted"
        ) {
          continue;
        }
        stopErrors.push(new ExternalToolError(
          "broker_stop_failed",
          "外部ツール実行の停止に失敗しました。",
          false,
          runOutcome.reason,
        ));
      }
    }
    const cleanupResult = await this.cleanupResources();
    if (stopErrors.length > 0 && cleanupResult.kind === "failed") {
      this.state = "failed";
      const errors = [...stopErrors, cleanupResult.error];
      const aggregateError = new AggregateError(
        errors,
        "外部ツールブローカーの停止に失敗しました。",
        { cause: errors[0] },
      );
      this.recordDiagnostic(aggregateError, "stop_error");
      throw new ExternalToolError(
        "broker_stop_failed",
        "外部ツールブローカーの停止に失敗しました。",
        false,
        aggregateError,
      );
    }
    if (stopErrors.length > 0) {
      this.state = "failed";
      const aggregateError = new AggregateError(
        stopErrors,
        "外部ツール実行の停止に失敗しました。",
        { cause: stopErrors[0] },
      );
      this.recordDiagnostic(aggregateError, "stop_error");
      throw new ExternalToolError(
        "broker_stop_failed",
        "外部ツールブローカーの停止に失敗しました。",
        false,
        aggregateError,
      );
    }
    if (cleanupResult.kind === "failed") {
      this.state = "failed";
      this.recordDiagnostic(cleanupResult.error, "stop_error");
      throw new ExternalToolError(
        "broker_stop_failed",
        "外部ツールブローカーの停止に失敗しました。",
        false,
        cleanupResult.error,
      );
    }
    this.state = "stopped";
  }

  private removeStartAbortListener(): void {
    const signal = this.startAbortSignal;
    const listener = this.startAbortListener;
    if (signal != null && listener != null) {
      signal.removeEventListener("abort", listener);
    }
    this.startAbortSignal = undefined;
    this.startAbortListener = undefined;
  }

  /** 登録済み外部ツールをAbortSignal付きで実行します。 */
  public async run(
    invocation: ExternalToolInvocation,
    signal: AbortSignal,
  ): Promise<ExternalToolExecutionResult> {
    validateAbortSignal(signal);
    const validatedInvocation = externalToolInvocationSchema.parse(invocation);
    throwIfAborted(signal);
    if (this.state !== "ready") {
      throw new ExternalToolError(
        "broker_stopped",
        "外部ツールブローカーは停止しています。",
        false,
      );
    }
    const tool = externalToolDefinitionSchema.parse(
      this.registry.get(validatedInvocation.tool_id),
    );
    const allowedSubcommands: readonly string[] = tool.allowed_subcommands;
    if (!allowedSubcommands.includes(validatedInvocation.subcommand)) {
      throw new ExternalToolError(
        "forbidden_subcommand",
        "許可されていないサブコマンドです。",
        false,
      );
    }
    this.invocationPolicy.validateInvocationArguments(tool, validatedInvocation.args);
    const statusEvidenceAttempt = externalToolStatusEvidenceAttemptSchema.parse(
      this.statusEvidenceCollector.captureAttempt(),
    );
    const runController = new AbortController();
    const runSignal = AbortSignal.any([signal, runController.signal]);
    const completion = this.executeRun(
      tool,
      validatedInvocation,
      statusEvidenceAttempt,
      runController,
      runSignal,
    );
    this.activeRuns.set(runController, {
      controller: runController,
      completion,
    });
    return completion;
  }

  private async executeRun(
    tool: ExternalToolDefinition,
    validatedInvocation: ExternalToolInvocation,
    statusEvidenceAttempt: ExternalToolStatusEvidenceAttempt,
    runController: AbortController,
    runSignal: AbortSignal,
  ): Promise<ExternalToolExecutionResult> {
    const timeoutController = new AbortController();
    const executionSignal = AbortSignal.any([
      runSignal,
      timeoutController.signal,
    ]);
    const timeout = setTimeout(() => {
      timeoutController.abort();
    }, tool.timeout_ms);
    try {
      let output: ExternalToolOutput;
      try {
        output = externalToolOutputSchema.parse(
          await this.runWithRetries(
            tool,
            validatedInvocation,
            this.discordCredentialProvider,
            executionSignal,
          ),
        );
      } catch (error) {
        if (timeoutController.signal.aborted && !runSignal.aborted) {
          throw new ExternalToolError(
            "execution_timeout",
            "外部ツールの実行時間が上限を超えました。",
            false,
            error,
          );
        }
        throw error;
      }
      if (timeoutController.signal.aborted && !runSignal.aborted) {
        throw new ExternalToolError(
          "execution_timeout",
          "外部ツールの実行時間が上限を超えました。",
          false,
        );
      }
      throwIfAborted(runSignal);
      const evidence = this.statusEvidenceCollector.record(
        statusEvidenceAttempt,
        output,
      );
      if (statusEvidenceAttempt.kind === "inactive" && evidence.length !== 0) {
        throw new Error("収集対象外の外部ツール実行へ構造化根拠を記録できません。");
      }
      return externalToolExecutionResultSchema.parse({
        tool_id: validatedInvocation.tool_id,
        output,
        evidence,
      });
    } finally {
      clearTimeout(timeout);
      this.activeRuns.delete(runController);
    }
  }

  /** 外部ツールブローカーの安全な診断概要を取得します。 */
  public getDiagnostics(): readonly ExternalToolDiagnostic[] {
    return externalToolDiagnosticsSchema.parse(
      this.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        cause_present: diagnostic.cause != null,
      })),
    );
  }

  private recordDiagnostic(
    error: unknown,
    code: ExternalToolDiagnosticCode,
  ): void {
    if (this.diagnostics.length >= externalToolMaxDiagnostics) {
      this.diagnostics.shift();
    }
    this.diagnostics.push({ code, cause: error });
    externalToolDiagnosticSchema.parse({
      code,
      cause_present: error != null,
    });
  }

  private async cleanupResources(): Promise<CleanupResult> {
    const errors: unknown[] = [];
    const server = this.server;
    if (server != null && server.listening) {
      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          server.close((error?: Error) => {
            if (error != null) {
              rejectPromise(error);
              return;
            }
            resolvePromise();
          });
        });
      } catch (error) {
        errors.push(error);
      }
    }
    const connectionInfo = this.connectionInfo;
    if (connectionInfo != null) {
      try {
        this.connectionFiles.removeConnectionInfo(this.connectionInfoPath, connectionInfo);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.connectionFiles.removeUnixSocket(this.endpoint);
    } catch (error) {
      errors.push(error);
    }
    this.server = undefined;
    this.endpoint = undefined;
    this.connectionInfo = undefined;
    this.connections.clear();
    if (errors.length === 0) {
      return { kind: "succeeded" };
    }
    return {
      kind: "failed",
      error: new AggregateError(errors, "外部ツールIPCの後処理に失敗しました。", {
        cause: errors[0],
      }),
    };
  }

  private handleServerError(error: Error): void {
    if (this.state === "stopping" || this.state === "stopped") {
      return;
    }
    this.recordDiagnostic(error, "server_error");
    this.state = "failed";
    for (const connection of this.connections.values()) {
      connection.abortController.abort();
      connection.socket.destroy();
    }
    void this.stop().catch((cleanupError: unknown) => {
      this.recordDiagnostic(cleanupError, "stop_error");
    });
  }

  private handleConnection(socket: Socket): void {
    if (this.state !== "ready") {
      socket.destroy();
      return;
    }
    if (this.connections.size >= externalToolMaxConnections) {
      socket.end(serializeResponse(createErrorResponse(new ExternalToolError(
        "broker_unavailable",
        "外部ツール接続数が上限を超えました。",
        false,
      ))));
      return;
    }
    const connection: ClientConnection = {
      socket,
      abortController: new AbortController(),
      buffer: Buffer.alloc(0),
      requestReceived: false,
      responseStarted: false,
    };
    this.connections.set(socket, connection);
    socket.setNoDelay(true);
    socket.setTimeout(maximumRequestMilliseconds, () => {
      connection.abortController.abort();
      void this.writeErrorAndClose(
        connection,
        new ExternalToolError(
          "execution_timeout",
          "外部ツールIPC要求の実行時間が上限を超えました。",
          false,
        ),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      this.handleData(connection, chunk);
    });
    socket.on("error", (error: Error) => {
      this.recordDiagnostic(error, "socket_error");
    });
    socket.once("close", () => {
      connection.abortController.abort();
      this.connections.delete(socket);
    });
  }

  private handleData(connection: ClientConnection, chunk: Buffer): void {
    if (connection.responseStarted) {
      return;
    }
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    if (connection.buffer.byteLength > externalToolMaxRequestBytes) {
      void this.writeErrorAndClose(
        connection,
        new ExternalToolError(
          "invalid_request",
          "外部ツール要求がサイズ上限を超えました。",
          false,
        ),
      );
      return;
    }
    const newlineIndex = connection.buffer.indexOf(10);
    if (newlineIndex < 0) {
      return;
    }
    if (
      connection.requestReceived
      || connection.buffer.indexOf(10, newlineIndex + 1) >= 0
      || connection.buffer.byteLength > newlineIndex + 1
    ) {
      void this.writeErrorAndClose(
        connection,
        new ExternalToolError(
          "invalid_request",
          "外部ツールIPCは一接続につき一要求だけ受け付けます。",
          false,
        ),
      );
      return;
    }
    connection.requestReceived = true;
    const line = connection.buffer.subarray(0, newlineIndex);
    connection.buffer = Buffer.alloc(0);
    void this.processLine(connection, line).catch((error: unknown) => {
      this.recordDiagnostic(error, "request_error");
      connection.socket.destroy();
    });
  }

  private async processLine(
    connection: ClientConnection,
    lineBuffer: Buffer,
  ): Promise<void> {
    let response: ExternalToolResponse;
    try {
      let line: string;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(lineBuffer);
      } catch (error) {
        throw new ExternalToolError(
          "invalid_request",
          "外部ツール要求をUTF-8として読み取れません。",
          false,
          error,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new ExternalToolError(
          "invalid_request",
          "外部ツール要求のJSONが不正です。",
          false,
          error,
        );
      }
      if (jsonDepth(parsed, 0, externalToolMaxJsonDepth) > externalToolMaxJsonDepth) {
        throw new ExternalToolError(
          "invalid_request",
          "外部ツール要求のJSON深度が上限を超えました。",
          false,
        );
      }
      const parsedRequest = externalToolRequestSchema.safeParse(parsed);
      if (!parsedRequest.success) {
        response = createErrorResponse(new ExternalToolError(
          "invalid_request",
          "外部ツール要求の形式が不正です。",
          false,
          parsedRequest.error,
        ));
      } else if (!this.verifyCapability(parsedRequest.data.capability)) {
        response = createErrorResponse(new ExternalToolError(
          "capability_invalid",
          "外部ツールの能力値が不正です。",
          false,
        ));
      } else {
        try {
          const result = await this.run(
            {
              tool_id: parsedRequest.data.tool_id,
              subcommand: parsedRequest.data.subcommand,
              args: parsedRequest.data.args,
            },
            connection.abortController.signal,
          );
          response = {
            ok: true,
            tool_id: result.tool_id,
            output: result.output,
            evidence: result.evidence,
          };
        } catch (error) {
          this.recordDiagnostic(error, "execution_error");
          response = createErrorResponse(error);
        }
      }
    } catch (error) {
      this.recordDiagnostic(error, "request_error");
      response = createErrorResponse(error);
    }
    this.writeResponseAndClose(connection, response);
  }

  private verifyCapability(value: string): boolean {
    const connectionInfo = this.connectionInfo;
    if (connectionInfo == null) {
      return false;
    }
    const expected = Buffer.from(connectionInfo.capability, "utf8");
    const received = Buffer.from(value, "utf8");
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  private writeResponseAndClose(
    connection: ClientConnection,
    response: ExternalToolResponse,
  ): void {
    if (connection.responseStarted) {
      return;
    }
    connection.responseStarted = true;
    const serialized = serializeResponse(response);
    connection.socket.end(serialized);
  }

  private writeErrorAndClose(
    connection: ClientConnection,
    error: ExternalToolError,
  ): void {
    if (connection.responseStarted) {
      return;
    }
    connection.responseStarted = true;
    try {
      connection.socket.end(serializeResponse(createErrorResponse(error)));
    } catch (serializationError) {
      this.recordDiagnostic(serializationError, "response_error");
      connection.socket.destroy();
    }
  }
}
