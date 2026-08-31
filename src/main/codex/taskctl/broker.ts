import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, parse, relative, resolve, sep } from "node:path";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
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
  taskctlResponseSchema,
  taskctlSnapshotSchema,
  type TaskctlBrokerOptions,
  type TaskctlBrokerStartResult,
  type TaskctlConnectionInfo,
  type TaskctlDiagnostic,
  type TaskctlQuery,
  type TaskctlRequest,
  type TaskctlResponse,
  type TaskctlSnapshot,
} from "./schemas";
import {
  TaskctlAbortError,
  TaskctlBrokerError,
  TaskctlExecutionTimeoutError,
} from "./errors";

const directoryMode = 0o700;
const connectionInfoMode = 0o600;
const unixSocketMode = 0o600;

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

type LocalIpcListenConfiguration = {
  readonly boundary: TaskctlBrokerStartResult["localIpcBoundary"];
  readonly readableAll: false;
  readonly writableAll: false;
};

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

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

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stats: Stats, label: string): void {
  const userId = currentUserId();
  if (userId != null && stats.uid !== userId) {
    throw new TaskctlBrokerError(`${label}の所有者を確認できません。`);
  }
}

function lstatWithoutSymlink(filePath: string, label: string): Stats {
  const normalizedPath = resolve(filePath);
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  let stats: Stats;
  try {
    stats = lstatSync(currentPath);
  } catch (error: unknown) {
    throw new TaskctlBrokerError(`${label}を確認できません。`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new TaskctlBrokerError(`${label}の親にシンボリックリンクを指定できません。`);
  }
  const remainingPath = relative(rootPath, normalizedPath);
  for (const part of remainingPath.split(sep).filter((segment) => segment.length > 0)) {
    currentPath = join(currentPath, part);
    try {
      stats = lstatSync(currentPath);
    } catch (error: unknown) {
      throw new TaskctlBrokerError(`${label}を確認できません。`, { cause: error });
    }
    if (stats.isSymbolicLink()) {
      throw new TaskctlBrokerError(`${label}の親にシンボリックリンクを指定できません。`);
    }
  }
  return stats;
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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedTasks(snapshot: TaskctlSnapshot): TaskctlSnapshot["tasks"] {
  return [...snapshot.tasks].sort((left, right) => compareStrings(left.gid, right.gid));
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

function createSocketPath(tmpDirectoryPath: string): string {
  const suffix = randomBytes(12).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\taskhub-taskctl-${suffix}`;
  }
  return join(tmpDirectoryPath, `taskctl-${suffix}.sock`);
}

function isWindowsPipe(socketPath: string): boolean {
  return /^\\\\\.\\pipe\\taskhub-taskctl-[0-9a-f]{24}$/u.test(socketPath);
}

function assertWindowsPipe(socketPath: string): void {
  if (process.platform === "win32" && !isWindowsPipe(socketPath)) {
    throw new TaskctlBrokerError("taskctl名前付きパイプの接続先が不正です。");
  }
}

function createLocalIpcListenConfiguration(): LocalIpcListenConfiguration {
  if (process.platform === "win32") {
    return {
      boundary: {
        kind: "windows_named_pipe",
        access: "current_user",
      },
      readableAll: false,
      writableAll: false,
    };
  }
  return {
    boundary: {
      kind: "unix_socket",
      access: "owner_only",
    },
    readableAll: false,
    writableAll: false,
  };
}

function ensureTemporaryDirectory(directoryPath: string): void {
  const stats = lstatWithoutSymlink(directoryPath, "taskctl一時ディレクトリ");
  if (stats.isSymbolicLink()) {
    throw new TaskctlBrokerError("taskctl一時ディレクトリにシンボリックリンクを指定できません。");
  }
  if (!stats.isDirectory()) {
    throw new TaskctlBrokerError("taskctl一時ディレクトリはディレクトリでなければなりません。");
  }
  assertOwned(stats, "taskctl一時ディレクトリ");
  chmodSync(directoryPath, directoryMode);
  const securedStats = lstatWithoutSymlink(directoryPath, "taskctl一時ディレクトリ");
  if (
    !securedStats.isDirectory()
    || (process.platform !== "win32" && (securedStats.mode & 0o777) !== directoryMode)
  ) {
    throw new TaskctlBrokerError("taskctl一時ディレクトリの権限を固定できません。");
  }
}

function secureUnixSocket(socketPath: string): void {
  if (process.platform === "win32") {
    return;
  }
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(socketPath, "taskctlソケット");
  } catch (error: unknown) {
    throw new TaskctlBrokerError(
      "taskctlソケットを確認できません。",
      { cause: error },
    );
  }
  if (!stats.isSocket()) {
    throw new TaskctlBrokerError("taskctlソケットが想定外のファイルです。");
  }
  assertOwned(stats, "taskctlソケット");
  chmodSync(socketPath, unixSocketMode);
  const securedStats = lstatWithoutSymlink(socketPath, "taskctlソケット");
  if (!securedStats.isSocket() || (securedStats.mode & 0o777) !== unixSocketMode) {
    throw new TaskctlBrokerError("taskctlソケットの権限を固定できません。");
  }
  assertOwned(securedStats, "taskctlソケット");
}

function verifySecureFile(filePath: string, label: string, mode: number): Stats {
  const stats = lstatWithoutSymlink(filePath, label);
  if (!stats.isFile()) {
    throw new TaskctlBrokerError(`${label}が想定外のファイルです。`);
  }
  assertOwned(stats, label);
  if (process.platform !== "win32" && (stats.mode & 0o777) !== mode) {
    throw new TaskctlBrokerError(`${label}の権限を固定できません。`);
  }
  return stats;
}

function writeConnectionInfoAtomically(
  connectionInfoPath: string,
  connectionInfo: TaskctlConnectionInfo,
): void {
  const temporaryPath = `${connectionInfoPath}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(taskctlConnectionInfoSchema.parse(connectionInfo));
  try {
    let existingStats: Stats | undefined;
    try {
      existingStats = lstatSync(connectionInfoPath);
    } catch (error: unknown) {
      if (!isNoEntryError(error)) {
        throw error;
      }
    }
    if (existingStats != null) {
      if (existingStats.isSymbolicLink() || !existingStats.isFile()) {
        throw new TaskctlBrokerError("既存のtaskctl接続情報が想定外のファイルです。");
      }
      assertOwned(existingStats, "既存のtaskctl接続情報");
    }
    writeFileSync(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: connectionInfoMode,
    });
    chmodSync(temporaryPath, connectionInfoMode);
    renameSync(temporaryPath, connectionInfoPath);
    verifySecureFile(connectionInfoPath, "taskctl接続情報", connectionInfoMode);
  } catch (error: unknown) {
    try {
      unlinkSync(temporaryPath);
    } catch (cleanupError: unknown) {
      if (!isNoEntryError(cleanupError)) {
        throw new TaskctlBrokerError(
          "taskctl接続情報の一時ファイルを削除できません。",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
}

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

function serializeResponse(response: TaskctlResponse): string {
  const validatedResponse = taskctlResponseSchema.parse(response);
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
  private readonly tmpDirectoryPath: string;
  private readonly snapshotProvider: TaskctlBrokerOptions["snapshotProvider"];
  private readonly connectionInfoPath: string;
  private state: BrokerState = "created";
  private server: Server | undefined;
  private socketPath: string | undefined;
  private connectionInfo: TaskctlConnectionInfo | undefined;
  private readonly connections = new Map<Socket, ClientConnection>();
  private stopPromise: Promise<void> | undefined;
  private abortSignal: AbortSignal | undefined;
  private abortListener: (() => void) | undefined;
  private internalError: Error | undefined;
  private readonly diagnostics: InternalDiagnostic[] = [];

  public constructor(options: TaskctlBrokerOptions) {
    const validatedOptions = taskctlBrokerOptionsSchema.parse(options);
    this.tmpDirectoryPath = validatedOptions.tmpDirectoryPath;
    this.snapshotProvider = validatedOptions.snapshotProvider;
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
      ensureTemporaryDirectory(this.tmpDirectoryPath);
      const socketPath = createSocketPath(this.tmpDirectoryPath);
      assertWindowsPipe(socketPath);
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
      const listenConfiguration = createLocalIpcListenConfiguration();
      await this.listen(server, socketPath, listenConfiguration);
      if (this.state !== "starting" || signal.aborted) {
        throw new TaskctlAbortError();
      }
      secureUnixSocket(socketPath);
      writeConnectionInfoAtomically(this.connectionInfoPath, connectionInfo);
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
      this.removeConnectionInfo();
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.removeSocket();
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

  private removeConnectionInfo(): void {
    const connectionInfo = this.connectionInfo;
    if (connectionInfo == null) {
      return;
    }
    let stats: Stats;
    try {
      stats = lstatSync(this.connectionInfoPath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new TaskctlBrokerError("taskctl接続情報が想定外のファイルです。");
    }
    assertOwned(stats, "taskctl接続情報");
    if (process.platform !== "win32" && (stats.mode & 0o777) !== connectionInfoMode) {
      throw new TaskctlBrokerError("taskctl接続情報の権限を確認できません。");
    }
    if (stats.size > maxRequestBytes) {
      throw new TaskctlBrokerError("taskctl接続情報がサイズ上限を超えています。");
    }
    const raw = readFileSync(this.connectionInfoPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new TaskctlBrokerError("taskctl接続情報のJSONが不正です。", { cause: error });
    }
    const current = taskctlConnectionInfoSchema.parse(parsed);
    if (
      current.socketPath !== connectionInfo.socketPath
      || current.capability !== connectionInfo.capability
    ) {
      throw new TaskctlBrokerError("taskctl接続情報の所有権を確認できません。");
    }
    unlinkSync(this.connectionInfoPath);
  }

  private removeSocket(): void {
    const socketPath = this.socketPath;
    if (socketPath == null || process.platform === "win32") {
      return;
    }
    let stats: Stats;
    try {
      stats = lstatSync(socketPath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return;
      }
      throw error;
    }
    if (!stats.isSocket()) {
      throw new TaskctlBrokerError("taskctlソケットが想定外のファイルです。");
    }
    assertOwned(stats, "taskctlソケット");
    unlinkSync(socketPath);
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
    const parsedSnapshot = taskctlSnapshotSchema.safeParse(suppliedSnapshot);
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
    const snapshot = parsedSnapshot.data;

    switch (query.command) {
      case "list": {
        const tasks = sortedTasks(snapshot);
        if (tasks.length > 1_000) {
          return createError("result_limit", "taskctl一覧の件数が上限を超えました。", snapshot.sync);
        }
        return { ok: true, command: "list", sync: snapshot.sync, data: { tasks } };
      }
      case "get": {
        const task = snapshot.tasks.find((candidate) => candidate.gid === query.gid);
        if (task == null) {
          return createError("task_not_found", "指定したタスクが見つかりません。", snapshot.sync);
        }
        return { ok: true, command: "get", sync: snapshot.sync, data: { task } };
      }
      case "rank":
        return { ok: true, command: "rank", sync: snapshot.sync, data: { ranking: snapshot.ranking } };
      case "graph": {
        const tasks = sortedTasks(snapshot);
        if (tasks.length > 10_000) {
          return createError("result_limit", "taskctlグラフの件数が上限を超えました。", snapshot.sync);
        }
        const dependencies = tasks.map((task) => ({
          task_gid: task.gid,
          dependencies: [...task.dependencies].sort((left, right) => {
            const taskResult = compareStrings(left.task_gid, right.task_gid);
            if (taskResult !== 0) {
              return taskResult;
            }
            const scopeResult = compareStrings(left.scope, right.scope);
            if (scopeResult !== 0) {
              return scopeResult;
            }
            return compareStrings(left.source, right.source);
          }),
        }));
        const relationMap = new Map<string, { readonly parent_gid: string; readonly child_gid: string }>();
        for (const task of tasks) {
          if (task.parent_gid != null) {
            relationMap.set(`${task.parent_gid}\u0000${task.gid}`, {
              parent_gid: task.parent_gid,
              child_gid: task.gid,
            });
          }
          for (const childGid of task.child_gids) {
            relationMap.set(`${task.gid}\u0000${childGid}`, {
              parent_gid: task.gid,
              child_gid: childGid,
            });
          }
        }
        const parentRelations = [...relationMap.values()].sort((left, right) => {
          const parentResult = compareStrings(left.parent_gid, right.parent_gid);
          if (parentResult !== 0) {
            return parentResult;
          }
          return compareStrings(left.child_gid, right.child_gid);
        });
        if (parentRelations.length > 20_000) {
          return createError("result_limit", "taskctlグラフの関係数が上限を超えました。", snapshot.sync);
        }
        return {
          ok: true,
          command: "graph",
          sync: snapshot.sync,
          data: { tasks, dependencies, parent_relations: parentRelations },
        };
      }
      case "areas": {
        const areas = [...new Set(snapshot.tasks.map((task) => task.area))].sort(compareStrings);
        if (areas.length > 500) {
          return createError("result_limit", "taskctl領域の件数が上限を超えました。", snapshot.sync);
        }
        return { ok: true, command: "areas", sync: snapshot.sync, data: { areas } };
      }
      case "search-local": {
        const normalizedQuery = query.query.toLowerCase();
        const tasks = sortedTasks(snapshot).filter((task) => (
          task.title.toLowerCase().includes(normalizedQuery)
          || task.notes.toLowerCase().includes(normalizedQuery)
          || task.area.toLowerCase().includes(normalizedQuery)
        ));
        if (tasks.length > 1_000) {
          return createError("result_limit", "taskctl検索結果の件数が上限を超えました。", snapshot.sync);
        }
        return {
          ok: true,
          command: "search-local",
          sync: snapshot.sync,
          data: { query: query.query, tasks },
        };
      }
    }
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
    const serialized = serializeResponse(response);
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
