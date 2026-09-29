import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import {
  createTaskctlLocalIpcFiles,
  type LocalIpcListenConfiguration,
} from "../taskctl/local-ipc-files";
import {
  maxConnections,
  maxDiagnostics,
  maxExecutionMilliseconds,
  maxJsonDepth,
  maxRequestBytes,
  maxResponseBytes,
  taskctlBrokerOptionsSchema,
  taskctlBrokerStartResultSchema,
  taskctlConnectionInfoSchema,
  taskctlDiagnosticsSchema,
  taskctlQuerySchema,
  taskctlProtocolVersion,
  taskctlRequestSchema,
  type TaskctlBrokerOptions,
  type TaskctlBrokerStartResult,
  type TaskctlConnectionInfo,
  type TaskctlDiagnostic,
  type TaskctlQuery,
  type TaskctlRankingSchemas,
  type TaskctlRequest,
  type TaskctlResponse,
  type TaskctlSnapshot,
} from "./schemas";
import { executeTaskctlQuery } from "./query";
import {
  TaskctlAbortError,
  TaskctlBrokerError,
  TaskctlExecutionTimeoutError,
} from "../taskctl/errors";

type BrokerState =
  | "created"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

type ClientConnection = {
  readonly socket: Socket;
  buffer: Buffer;
  requestReceived: boolean;
  responseStarted: boolean;
};

type TaskctlDiagnosticCode = TaskctlDiagnostic["code"];

type InternalDiagnostic = {
  readonly code: TaskctlDiagnosticCode;
  readonly cause: unknown;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype == null;
}

function hasCapabilityShape(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function jsonDepth(value: unknown, depth: number): number {
  type Frame = {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting: boolean;
  };
  const stack: Frame[] = [{ value, depth, exiting: false }];
  const ancestors = new WeakSet<object>();
  let deepest = depth;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      throw new TaskctlBrokerError("taskctl JSON検証の状態が不正です。");
    }
    if (frame.exiting) {
      if (typeof frame.value !== "object" || frame.value == null) {
        throw new TaskctlBrokerError("taskctl JSON検証の状態が不正です。");
      }
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.value == null || typeof frame.value !== "object") {
      deepest = Math.max(deepest, frame.depth);
      continue;
    }
    if (ancestors.has(frame.value)) {
      throw new TaskctlBrokerError("taskctl JSONに循環参照があります。");
    }
    ancestors.add(frame.value);
    deepest = Math.max(deepest, frame.depth);
    stack.push({ value: frame.value, depth: frame.depth, exiting: true });
    const childDepth = frame.depth + 1;
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item, depth: childDepth, exiting: false });
      }
      continue;
    }
    for (const item of Object.values(frame.value)) {
      stack.push({ value: item, depth: childDepth, exiting: false });
    }
  }
  return deepest;
}

function createUnavailableSyncState(): TaskctlResponse["sync"] {
  return { kind: "unavailable" };
}

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function createError(
  code: TaskctlErrorCode,
  message: string,
  sync: TaskctlResponse["sync"],
): TaskctlResponse {
  return {
    ok: false,
    error: { code, message },
    sync,
  };
}

type TaskctlErrorCode =
  | "client_error"
  | "invalid_request"
  | "capability_invalid"
  | "connection_limit"
  | "broker_stopped"
  | "snapshot_unavailable"
  | "snapshot_invalid"
  | "task_not_found"
  | "result_limit"
  | "response_too_large"
  | "execution_timeout"
  | "protocol_error";

function withTimeout<Value>(
  value: Value | PromiseLike<Value>,
  milliseconds: number,
): Promise<Value> {
  return new Promise<Value>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      rejectPromise(new TaskctlExecutionTimeoutError());
    }, milliseconds);
    Promise.resolve(value).then(
      (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        rejectPromise(
          error instanceof Error
            ? error
            : new TaskctlBrokerError("taskctl要求の実行に失敗しました。", { cause: error }),
        );
      },
    );
  });
}

function decodeUtf8(line: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(line);
  } catch (error: unknown) {
    throw new TaskctlBrokerError("taskctl要求の文字コードが不正です。", { cause: error });
  }
}

function serializeResponse(response: TaskctlResponse, schemas: TaskctlRankingSchemas): string {
  const validatedResponse = schemas.taskctlResponseSchema.parse(response);
  const serialized = JSON.stringify(validatedResponse);
  if (serialized == null) {
    throw new TaskctlBrokerError("taskctl応答をJSON化できません。");
  }
  if (Buffer.byteLength(serialized, "utf8") > maxResponseBytes) {
    throw new TaskctlBrokerError("taskctl応答がサイズ上限を超えました。");
  }
  if (jsonDepth(validatedResponse, 0) > maxJsonDepth) {
    throw new TaskctlBrokerError("taskctl応答のJSON深度が上限を超えました。");
  }
  return `${serialized}\n`;
}

function taskctlQueryFromRequest(request: TaskctlRequest): TaskctlQuery {
  switch (request.command) {
    case "list":
      return { command: "list" };
    case "get":
      return { command: "get", gid: request.gid };
    case "rank":
      return { command: "rank" };
    case "graph":
      return { command: "graph" };
    case "areas":
      return { command: "areas" };
    case "search-local":
      return { command: "search-local", query: request.query };
    default:
      throw new TaskctlBrokerError("taskctl要求のコマンドが不正です。");
  }
}

/** 読み取り専用スナップショットをtaskctlへ公開するローカルブローカーです。 */
export class TaskctlBroker {
  private readonly files: ReturnType<typeof createTaskctlLocalIpcFiles>;
  private readonly tmpDirectoryPath: string;
  private readonly snapshotProvider: TaskctlBrokerOptions["snapshotProvider"];
  private readonly schemas: TaskctlRankingSchemas;
  private readonly connectionInfoPath: string;
  private state: BrokerState = "created";
  private server: Server | undefined;
  private socketPath: string | undefined;
  private socketDirectoryPath: string | undefined;
  private connectionInfo: TaskctlConnectionInfo | undefined;
  private readonly connections = new Map<Socket, ClientConnection>();
  private stopPromise: Promise<void> | undefined;
  private abortSignal: AbortSignal | undefined;
  private abortListener: (() => void) | undefined;
  private internalError: Error | undefined;
  private readonly diagnostics: InternalDiagnostic[] = [];

  public constructor(options: TaskctlBrokerOptions, schemas: TaskctlRankingSchemas) {
    const validatedOptions = taskctlBrokerOptionsSchema.parse(options);
    this.files = createTaskctlLocalIpcFiles(
      TaskctlBrokerError,
      (value) => taskctlConnectionInfoSchema.parse(value),
      maxRequestBytes,
    );
    this.tmpDirectoryPath = validatedOptions.tmpDirectoryPath;
    this.snapshotProvider = validatedOptions.snapshotProvider;
    this.schemas = schemas;
    this.connectionInfoPath = join(this.tmpDirectoryPath, "taskctl-connection.json");
  }

  /** taskctlのローカルIPCサーバーを起動します。 */
  public async start(signal: AbortSignal): Promise<TaskctlBrokerStartResult> {
    validateAbortSignal(signal);
    if (this.state !== "created") {
      throw new TaskctlBrokerError("taskctlブローカーは一度だけ起動できます。");
    }
    if (signal.aborted) {
      throw new TaskctlAbortError();
    }
    this.state = "starting";
    this.abortSignal = signal;
    this.abortListener = () => {
      void this.stop().catch((error: unknown) => {
        this.recordInternalError(error, "stop_error");
      });
    };
    signal.addEventListener("abort", this.abortListener, { once: true });

    try {
      this.files.ensureTemporaryDirectory(this.tmpDirectoryPath);
      const socketDirectoryPath = this.files.createSocketDirectory(this.tmpDirectoryPath);
      if (process.platform === "darwin") {
        this.socketDirectoryPath = socketDirectoryPath;
      }
      const socketPath = this.files.createSocketPath(socketDirectoryPath);
      this.files.assertWindowsPipe(socketPath);
      const connectionInfo = taskctlConnectionInfoSchema.parse({
        version: taskctlProtocolVersion,
        socketPath,
        capability: randomBytes(32).toString("hex"),
      });
      this.socketPath = socketPath;
      this.connectionInfo = connectionInfo;
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        this.handleConnection(socket);
      });
      this.server = server;
      server.on("error", (error: Error) => {
        this.handleServerError(error);
      });
      const listenConfiguration = this.files.createLocalIpcListenConfiguration(socketDirectoryPath);
      await this.listen(server, socketPath, listenConfiguration);
      if (this.state !== "starting" || signal.aborted) {
        throw new TaskctlAbortError();
      }
      this.files.secureUnixSocket(socketPath);
      this.files.writeConnectionInfoAtomically(this.connectionInfoPath, connectionInfo);
      this.state = "ready";
      return taskctlBrokerStartResultSchema.parse({
        version: taskctlProtocolVersion,
        socketPath,
        connectionInfoPath: this.connectionInfoPath,
        localIpcBoundary: listenConfiguration.boundary,
      });
    } catch (error: unknown) {
      this.recordInternalError(error, "startup_error");
      this.state = "failed";
      try {
        await this.stop();
      } catch (cleanupError: unknown) {
        throw new TaskctlBrokerError(
          "taskctlブローカーの起動と後処理に失敗しました。",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw error;
    }
  }

  /** taskctl要求を同期済みスナップショットへ適用します。 */
  public executeQuery(query: unknown): Promise<TaskctlResponse> {
    if (this.state !== "ready") {
      return Promise.resolve(
        createError(
          "broker_stopped",
          "taskctlブローカーを利用できません。",
          createUnavailableSyncState(),
        ),
      );
    }
    const parsedQuery = taskctlQuerySchema.safeParse(query);
    if (!parsedQuery.success) {
      return Promise.resolve(
        createError(
          "invalid_request",
          "taskctl要求の形式が不正です。",
          createUnavailableSyncState(),
        ),
      );
    }
    return this.createQueryResponse(parsedQuery.data);
  }

  /** taskctlのローカルIPCサーバーと接続情報を停止します。 */
  public stop(): Promise<void> {
    if (this.stopPromise != null) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  /** taskctl内部診断を本文なしで取得します。RendererやCodexへError本文を渡す用途には使いません。 */
  public getDiagnostics(): TaskctlDiagnostic[] {
    return taskctlDiagnosticsSchema.parse(
      this.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        cause_present: diagnostic.cause != null,
      })),
    );
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopping";
    if (this.abortSignal != null && this.abortListener != null) {
      this.abortSignal.removeEventListener("abort", this.abortListener);
    }
    this.abortSignal = undefined;
    this.abortListener = undefined;
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    const errors: unknown[] = [];
    try {
      await this.closeServer();
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.files.removeConnectionInfo(this.connectionInfoPath, this.connectionInfo);
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.files.removeSocket(this.socketPath);
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.files.removeSocketDirectory(this.socketDirectoryPath);
      this.socketDirectoryPath = undefined;
    } catch (error: unknown) {
      errors.push(error);
    }
    this.server = undefined;
    this.connections.clear();
    if (errors.length > 0) {
      const error = new TaskctlBrokerError(
        "taskctlブローカーの停止に失敗しました。",
        { cause: new AggregateError(errors) },
      );
      const previousError = this.internalError;
      const diagnosticError = previousError == null
        ? error
        : new TaskctlBrokerError(
          "taskctlブローカーの停止と既存エラーの処理に失敗しました。",
          { cause: new AggregateError([previousError, error]) },
        );
      this.recordInternalError(diagnosticError, "stop_error");
      this.state = "failed";
      throw error;
    }
    this.state = "stopped";
  }

  private listen(
    server: Server,
    socketPath: string,
    configuration: LocalIpcListenConfiguration,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        server.removeListener("listening", onListening);
        rejectPromise(error);
      };
      const onListening = (): void => {
        server.removeListener("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({
        path: socketPath,
        readableAll: configuration.readableAll,
        writableAll: configuration.writableAll,
      });
    });
  }

  private closeServer(): Promise<void> {
    const server = this.server;
    if (server == null || !server.listening) {
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error?: Error) => {
        if (error != null) {
          rejectPromise(error);
          return;
        }
        resolvePromise();
      });
    });
  }

  private handleServerError(error: Error): void {
    if (this.state === "stopping" || this.state === "stopped") {
      return;
    }
    const serverError = new TaskctlBrokerError(
      "taskctlローカルIPCサーバーでエラーが発生しました。",
      { cause: error },
    );
    this.recordInternalError(serverError, "server_error");
    this.state = "failed";
    for (const connection of this.connections.values()) {
      connection.socket.destroy();
    }
    void this.stop().catch((cleanupError: unknown) => {
      this.recordInternalError(
        new TaskctlBrokerError(
          "taskctlローカルIPCサーバーの後処理に失敗しました。",
          { cause: new AggregateError([serverError, cleanupError]) },
        ),
        "stop_error",
      );
    });
  }

  private handleConnection(socket: Socket): void {
    if (this.state !== "ready") {
      socket.destroy();
      return;
    }
    if (this.connections.size >= maxConnections) {
      void this.writeErrorAndClose(socket, "connection_limit", "taskctl接続数が上限を超えました。")
        .catch((error: unknown) => {
          this.recordInternalError(error, "response_error");
          socket.destroy();
        });
      return;
    }
    const connection: ClientConnection = {
      socket,
      buffer: Buffer.alloc(0),
      requestReceived: false,
      responseStarted: false,
    };
    this.connections.set(socket, connection);
    socket.setNoDelay(true);
    socket.setTimeout(maxExecutionMilliseconds, () => {
      void this.writeErrorAndClose(
        socket,
        "execution_timeout",
        "taskctl要求の実行時間が上限を超えました。",
      ).catch((error: unknown) => {
        this.recordInternalError(error, "response_error");
        socket.destroy();
      });
    });
    socket.on("data", (chunk: Buffer) => {
      this.handleData(connection, chunk);
    });
    socket.on("error", (error: Error) => {
      this.recordInternalError(error, "socket_error");
    });
    socket.once("close", () => {
      this.connections.delete(socket);
    });
  }

  private handleData(connection: ClientConnection, chunk: Buffer): void {
    if (connection.responseStarted) {
      return;
    }
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    if (connection.buffer.byteLength > maxRequestBytes) {
      void this.writeErrorAndClose(
        connection.socket,
        "protocol_error",
        "taskctl要求がサイズ上限を超えました。",
      ).catch((error: unknown) => {
        this.recordInternalError(error, "response_error");
        connection.socket.destroy();
      });
      return;
    }
    const newlineIndex = connection.buffer.indexOf(10);
    if (newlineIndex < 0) {
      return;
    }
    if (connection.requestReceived || connection.buffer.indexOf(10, newlineIndex + 1) >= 0) {
      void this.writeErrorAndClose(
        connection.socket,
        "protocol_error",
        "taskctlは一接続につき一要求だけ受け付けます。",
      ).catch((error: unknown) => {
        this.recordInternalError(error, "response_error");
        connection.socket.destroy();
      });
      return;
    }
    if (connection.buffer.byteLength > newlineIndex + 1) {
      void this.writeErrorAndClose(
        connection.socket,
        "protocol_error",
        "taskctl要求に余分なデータがあります。",
      ).catch((error: unknown) => {
        this.recordInternalError(error, "response_error");
        connection.socket.destroy();
      });
      return;
    }
    connection.requestReceived = true;
    const line = connection.buffer.subarray(0, newlineIndex);
    connection.buffer = Buffer.alloc(0);
    void this.processLine(connection, line).catch((error: unknown) => {
      this.recordInternalError(error, "process_error");
      connection.socket.destroy();
    });
  }

  private async processLine(
    connection: ClientConnection,
    lineBuffer: Buffer,
  ): Promise<void> {
    let response: TaskctlResponse;
    try {
      const hasCarriageReturn =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13;
      const line = decodeUtf8(hasCarriageReturn
        ? lineBuffer.subarray(0, lineBuffer.length - 1)
        : lineBuffer);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error: unknown) {
        throw new TaskctlBrokerError("taskctl要求のJSONが不正です。", { cause: error });
      }
      if (jsonDepth(parsed, 0) > maxJsonDepth) {
        response = createError(
          "protocol_error",
          "taskctl要求のJSON深度が上限を超えました。",
          createUnavailableSyncState(),
        );
      } else {
        const parsedRequest = taskctlRequestSchema.safeParse(parsed);
        if (!parsedRequest.success) {
          const capability = isPlainObject(parsed) ? parsed.capability : undefined;
          const code =
            typeof capability === "string" && !hasCapabilityShape(capability)
              ? "capability_invalid"
              : "invalid_request";
          response = createError(
            code,
            code === "capability_invalid"
              ? "taskctlの起動単位能力値が不正です。"
              : "taskctl要求の形式が不正です。",
            createUnavailableSyncState(),
          );
        } else if (!this.verifyCapability(parsedRequest.data.capability)) {
          response = createError(
            "capability_invalid",
            "taskctlの起動単位能力値が不正です。",
            createUnavailableSyncState(),
          );
        } else {
          response = await this.executeQuery(taskctlQueryFromRequest(parsedRequest.data));
        }
      }
    } catch (error: unknown) {
      this.recordInternalError(error, "process_error");
      if (error instanceof TaskctlExecutionTimeoutError) {
        response = createError(
          "execution_timeout",
          "taskctl要求の実行時間が上限を超えました。",
          createUnavailableSyncState(),
        );
      } else {
        response = createError(
          "invalid_request",
          "taskctl要求を処理できません。",
          createUnavailableSyncState(),
        );
      }
    }
    await this.writeResponseAndClose(connection, response);
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

  private async createQueryResponse(query: TaskctlQuery): Promise<TaskctlResponse> {
    let suppliedSnapshot: TaskctlSnapshot;
    try {
      suppliedSnapshot = await withTimeout(
        this.snapshotProvider(),
        maxExecutionMilliseconds,
      );
    } catch (error: unknown) {
      const diagnosticError = error instanceof TaskctlExecutionTimeoutError
        ? error
        : new TaskctlBrokerError(
          "taskctlスナップショット供給関数が失敗しました。",
          { cause: error },
        );
      this.recordInternalError(diagnosticError, "snapshot_provider_error");
      if (error instanceof TaskctlExecutionTimeoutError) {
        return createError(
          "execution_timeout",
          "taskctl要求の実行時間が上限を超えました。",
          createUnavailableSyncState(),
        );
      }
      return createError(
        "snapshot_unavailable",
        "同期済みスナップショットを取得できません。",
        createUnavailableSyncState(),
      );
    }
    const parsedSnapshot = this.schemas.taskctlSnapshotSchema.safeParse(suppliedSnapshot);
    if (!parsedSnapshot.success) {
      this.recordInternalError(
        new TaskctlBrokerError(
          "同期済みスナップショットの形式が不正です。",
          { cause: parsedSnapshot.error },
        ),
        "snapshot_invalid",
      );
      return createError(
        "snapshot_invalid",
        "同期済みスナップショットの形式が不正です。",
        createUnavailableSyncState(),
      );
    }
    return executeTaskctlQuery(query, parsedSnapshot.data, this.schemas);
  }

  private async writeErrorAndClose(
    socket: Socket,
    code: TaskctlErrorCode,
    message: string,
  ): Promise<void> {
    if (!this.beginResponse(socket)) {
      return;
    }
    await this.writeSocketResponse(socket, createError(code, message, createUnavailableSyncState()));
  }

  private beginResponse(socket: Socket): boolean {
    if (socket.destroyed) {
      return false;
    }
    const connection = this.connections.get(socket);
    if (connection == null) {
      return true;
    }
    if (connection.responseStarted) {
      return false;
    }
    connection.responseStarted = true;
    return true;
  }

  private async writeResponseAndClose(
    connection: ClientConnection,
    response: TaskctlResponse,
  ): Promise<void> {
    if (!this.beginResponse(connection.socket)) {
      return;
    }
    try {
      await this.writeSocketResponse(connection.socket, response);
    } catch (error: unknown) {
      const fallback = createError(
        "response_too_large",
        "taskctl応答を送信できません。",
        response.ok ? response.sync : createUnavailableSyncState(),
      );
      try {
        await this.writeSocketResponse(connection.socket, fallback);
      } catch (fallbackError: unknown) {
        throw new TaskctlBrokerError(
          "taskctl応答の送信に失敗しました。",
          { cause: new AggregateError([error, fallbackError]) },
        );
      }
    }
  }

  private writeSocketResponse(socket: Socket, response: TaskctlResponse): Promise<void> {
    const serialized = serializeResponse(response, this.schemas);
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => {
        socket.removeListener("error", onError);
        rejectPromise(error);
      };
      socket.once("error", onError);
      socket.end(serialized, () => {
        socket.removeListener("error", onError);
        resolvePromise();
      });
    });
  }

  private recordInternalError(error: unknown, code: TaskctlDiagnosticCode): void {
    const normalizedError = error instanceof Error
      ? error
      : new TaskctlBrokerError("taskctl内部エラーが発生しました。", { cause: error });
    this.internalError = normalizedError;
    if (this.diagnostics.length >= maxDiagnostics) {
      this.diagnostics.shift();
    }
    this.diagnostics.push({ code, cause: normalizedError });
  }
}
