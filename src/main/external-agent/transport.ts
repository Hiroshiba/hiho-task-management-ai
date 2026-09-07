import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  lstatSync,
  realpathSync,
  rmdirSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { readSecurePersistentTextFile } from "../local-storage-path";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { z } from "zod";
import {
  externalAgentConfigSchema,
  externalAgentDescriptorSchema,
  externalAgentFailureResponseSchema,
  externalAgentMaxConnections,
  externalAgentMaxRequestBytes,
  externalAgentMaxResponseBytes,
  externalAgentProtocolVersion,
  externalAgentRequestEnvelopeSchema,
  externalAgentRequestTimeoutMilliseconds,
  externalAgentResponseSchema,
  externalAgentSuccessResponseSchema,
  externalAgentUnixSocketMaxBytes,
  type ExternalAgentDescriptor,
  type ExternalAgentRequestEnvelope,
  type ExternalAgentResponse,
} from "./transport-schemas";
import {
  getExternalAgentRegistration,
  getExternalAgentResourcePaths,
  readExternalAgentConfig,
  removeExternalAgentConnectionInfo,
  writeExternalAgentConfig,
  writeExternalAgentConnectionInfo,
  writeExternalAgentResources,
  type ExternalAgentRegistration,
  type ExternalAgentResourcePaths,
} from "./resources";

export type ExternalAgentRequestHandler = (
  input: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

export type ExternalAgentBridgeOptions = {
  readonly userDataPath: string;
  readonly handleRequest: ExternalAgentRequestHandler;
  readonly onError: (error: unknown) => void;
};

export type ExternalAgentBridgeState = {
  readonly enabled: boolean;
  readonly kind: "stopped" | "running" | "unavailable";
};

type BridgeState = "created" | "ready" | "failed" | "stopping" | "stopped";

type UnixEndpoint = {
  readonly endpoint: string;
  readonly directoryPath: string;
};

class ExternalAgentRequestTimeoutError extends Error {
  public constructor() {
    super("外部連携要求が時間内に完了しませんでした。");
    this.name = "ExternalAgentRequestTimeoutError";
  }
}

class ExternalAgentResponseTooLargeError extends Error {
  public constructor() {
    super("外部連携応答がサイズ上限を超えています。");
    this.name = "ExternalAgentResponseTooLargeError";
  }
}

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function assertProcessExecPath(processExecPath: string): void {
  if (
    processExecPath.length === 0
    || (!processExecPath.startsWith("/") && !isWindowsAbsolutePath(processExecPath))
    || hasControlCharacters(processExecPath)
  ) {
    throw new Error("Electron実行ファイルのパスが不正です。");
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code != null && ((code >= 0 && code <= 31) || (code >= 127 && code <= 159))) {
      return true;
    }
  }
  return false;
}

function assertCurrentUser(stats: { readonly uid?: number }, label: string): void {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${label}の所有者が現在のユーザーではありません。`);
  }
}

function createUnixEndpoint(): UnixEndpoint {
  if (typeof process.getuid !== "function") {
    throw new Error("Unixソケットの所有者を確認できません。");
  }
  const tempRoot = realpathSync("/tmp");
  const uid = process.getuid();
  const directoryPath = join(tempRoot, `taskhub-agent-${uid}-${randomBytes(12).toString("hex")}`);
  mkdirSync(directoryPath, { mode: 0o700 });
  chmodSync(directoryPath, 0o700);
  const directoryStats = lstatSync(directoryPath);
  if (!directoryStats.isDirectory()) {
    throw new Error("外部連携Unixソケットの一時ディレクトリが不正です。");
  }
  assertCurrentUser(directoryStats, "外部連携Unixソケットの一時ディレクトリ");
  if ((directoryStats.mode & 0o777) !== 0o700) {
    throw new Error("外部連携Unixソケットの一時ディレクトリの権限が不正です。");
  }
  const endpoint = join(directoryPath, "bridge.sock");
  if (Buffer.byteLength(endpoint, "utf8") > externalAgentUnixSocketMaxBytes) {
    rmdirSync(directoryPath);
    throw new Error("外部連携Unixソケットのパスが長すぎます。");
  }
  return { endpoint, directoryPath };
}

function createEndpoint(): { readonly endpoint: string; readonly directoryPath: string | undefined } {
  if (process.platform === "win32") {
    return {
      endpoint: `\\\\.\\pipe\\taskhub-agent-${randomBytes(16).toString("hex")}`,
      directoryPath: undefined,
    };
  }
  return createUnixEndpoint();
}

function verifyUnixSocket(endpoint: string): void {
  const stats = lstatSync(endpoint);
  if (!stats.isSocket()) {
    throw new Error("外部連携Unixソケットが想定外のファイルです。");
  }
  assertCurrentUser(stats, "外部連携Unixソケット");
  chmodSync(endpoint, 0o600);
  const securedStats = lstatSync(endpoint);
  if (!securedStats.isSocket() || (securedStats.mode & 0o777) !== 0o600) {
    throw new Error("外部連携Unixソケットの権限を固定できません。");
  }
  assertCurrentUser(securedStats, "外部連携Unixソケット");
}

function randomRequestId(): string {
  return randomBytes(16).toString("hex");
}

function createFailureResponse(
  requestId: string,
  code: z.infer<typeof externalAgentFailureResponseSchema>['error']['code'],
  message: string,
): ExternalAgentResponse {
  return externalAgentFailureResponseSchema.parse({
    version: externalAgentProtocolVersion,
    requestId,
    ok: false,
    error: { code, message },
  });
}

function serializeResponse(response: ExternalAgentResponse): string {
  const validatedResponse = externalAgentResponseSchema.parse(response);
  const serialized = JSON.stringify(validatedResponse);
  if (serialized == null) {
    throw new Error("外部連携応答をJSON化できません。");
  }
  if (Buffer.byteLength(serialized, "utf8") + 1 > externalAgentMaxResponseBytes) {
    throw new ExternalAgentResponseTooLargeError();
  }
  return `${serialized}\n`;
}

function compareCapability(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.byteLength === expectedBuffer.byteLength && timingSafeEqual(actualBuffer, expectedBuffer);
}

function descriptorMatches(left: ExternalAgentDescriptor, right: ExternalAgentDescriptor): boolean {
  return left.version === right.version
    && left.endpoint === right.endpoint
    && left.capability === right.capability
    && left.instanceId === right.instanceId;
}

/** 外部Codex向けの独立したTaskHub IPCブリッジです。 */
export class ExternalAgentBridge {
  private readonly userDataPath: string;
  private readonly handleRequest: ExternalAgentRequestHandler;
  private readonly onError: (error: unknown) => void;
  private state: BridgeState = "created";
  private enabled = false;
  private paths: ExternalAgentResourcePaths | undefined;
  private server: Server | undefined;
  private descriptor: ExternalAgentDescriptor | undefined;
  private unixEndpointDirectoryPath: string | undefined;
  private acceptingConnections = false;
  private readonly connections = new Set<Socket>();
  private readonly requestControllers = new Set<AbortController>();
  private lifecycleOperation: Promise<void> = Promise.resolve();
  private stopPromise: Promise<void> | undefined;

  public constructor(options: ExternalAgentBridgeOptions) {
    if (options.userDataPath.length === 0) {
      throw new TypeError("外部連携のuserDataパスが必要です。");
    }
    this.userDataPath = options.userDataPath;
    this.handleRequest = options.handleRequest;
    this.onError = options.onError;
  }

  /** 起動時資源を更新し、保存済み設定に従って待受を開始します。 */
  public async init(processExecPath: string): Promise<void> {
    return this.scheduleLifecycle(async () => {
      if (this.state !== "created") {
        throw new Error("外部連携ブリッジは一度だけ初期化できます。");
      }
      assertProcessExecPath(processExecPath);
      try {
        const paths = writeExternalAgentResources(this.userDataPath, processExecPath);
        this.paths = paths;
        removeExternalAgentConnectionInfo(paths);
        const config = readExternalAgentConfig(paths);
        this.enabled = config.enabled;
        if (this.enabled) {
          await this.startTransport(paths);
        }
        this.state = "ready";
      } catch (error: unknown) {
        this.state = "failed";
        this.notifyError(error);
        throw error;
      }
    });
  }

  /** 外部連携の有効状態を保存し、待受を開始または停止します。 */
  public async setEnabled(enabled: boolean): Promise<void> {
    return this.scheduleLifecycle(async () => {
      if (this.state !== "ready") {
        throw new Error("外部連携ブリッジは利用可能な状態ではありません。");
      }
      const paths = this.requirePaths();
      if (enabled === this.enabled) {
        return;
      }
      if (enabled) {
        this.enabled = true;
        try {
          await this.startTransport(paths);
          writeExternalAgentConfig(paths, externalAgentConfigSchema.parse({ enabled: true }));
        } catch (error: unknown) {
          this.enabled = false;
          this.state = "failed";
          try {
            await this.stopTransport(paths);
          } catch (cleanupError: unknown) {
            const cleanupFailure = new Error("外部連携の有効化と後処理に失敗しました。", {
              cause: new AggregateError([error, cleanupError]),
            });
            this.notifyError(cleanupFailure);
            throw cleanupFailure;
          }
          this.notifyError(error);
          throw error;
        }
        return;
      }
      try {
        await this.stopTransport(paths);
        writeExternalAgentConfig(paths, externalAgentConfigSchema.parse({ enabled: false }));
        this.enabled = false;
      } catch (error: unknown) {
        this.state = "failed";
        this.notifyError(error);
        throw error;
      }
    });
  }

  /** 外部連携の有効状態と実行状態を返します。 */
  public getState(): ExternalAgentBridgeState {
    if (this.state === "failed" || this.state === "created") {
      return { enabled: this.enabled, kind: "unavailable" };
    }
    if (
      this.state === "ready"
      && this.enabled
      && this.acceptingConnections
      && this.server != null
      && this.server.listening
    ) {
      return { enabled: true, kind: "running" };
    }
    if (this.state === "ready" && this.enabled) {
      return { enabled: true, kind: "unavailable" };
    }
    return { enabled: this.enabled, kind: "stopped" };
  }

  /** 外部連携の登録に必要な非秘密コマンドを返します。 */
  public getRegistration(): ExternalAgentRegistration {
    const paths = this.paths ?? getExternalAgentResourcePaths(this.userDataPath);
    return getExternalAgentRegistration(paths);
  }

  /** 外部連携の待受と接続情報を停止します。 */
  public stop(): Promise<void> {
    if (this.stopPromise != null) {
      return this.stopPromise;
    }
    this.stopPromise = this.scheduleLifecycle(() => this.stopInternal());
    return this.stopPromise;
  }

  private scheduleLifecycle(operation: () => Promise<void>): Promise<void> {
    const nextOperation = this.lifecycleOperation.then(operation);
    this.lifecycleOperation = nextOperation.then(
      () => undefined,
      () => undefined,
    );
    return nextOperation;
  }

  private requirePaths(): ExternalAgentResourcePaths {
    if (this.paths == null) {
      throw new Error("外部連携資源が初期化されていません。");
    }
    return this.paths;
  }

  private notifyError(error: unknown): void {
    this.onError(error);
  }

  private async startTransport(paths: ExternalAgentResourcePaths): Promise<void> {
    if (this.server != null || this.descriptor != null) {
      throw new Error("外部連携の待受は既に開始されています。");
    }
    this.acceptingConnections = false;
    const endpointData = createEndpoint();
    const descriptor = externalAgentDescriptorSchema.parse({
      version: externalAgentProtocolVersion,
      endpoint: endpointData.endpoint,
      capability: randomBytes(32).toString("hex"),
      instanceId: randomBytes(16).toString("hex"),
    });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      this.handleConnection(socket);
    });
    this.server = server;
    this.descriptor = descriptor;
    this.unixEndpointDirectoryPath = endpointData.directoryPath;
    server.on("error", (error: Error) => {
      this.notifyError(error);
    });
    try {
      await this.listen(server, descriptor.endpoint);
      if (process.platform !== "win32") {
        verifyUnixSocket(descriptor.endpoint);
      }
      writeExternalAgentConnectionInfo(paths, descriptor);
      this.acceptingConnections = true;
    } catch (error: unknown) {
      try {
        await this.stopTransport(paths);
      } catch (cleanupError: unknown) {
        throw new Error("外部連携の待受開始と後処理に失敗しました。", {
          cause: new AggregateError([error, cleanupError]),
        });
      }
      throw error;
    }
  }

  private listen(server: Server, endpoint: string): Promise<void> {
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
      if (process.platform === "win32") {
        server.listen({ path: endpoint });
        return;
      }
      server.listen({ path: endpoint, readableAll: false, writableAll: false });
    });
  }

  private handleConnection(socket: Socket): void {
    if (
      this.state === "stopping"
      || this.state === "stopped"
      || !this.acceptingConnections
      || this.server == null
    ) {
      socket.destroy();
      return;
    }
    if (this.connections.size >= externalAgentMaxConnections) {
      const response = createFailureResponse(randomRequestId(), "connection_limit", "外部連携の接続数が上限です。");
      try {
        socket.end(serializeResponse(response));
      } catch (error: unknown) {
        this.notifyError(error);
        socket.destroy();
      }
      return;
    }
    this.connections.add(socket);
    const connectionDeadline = setTimeout(() => {
      socket.destroy();
    }, externalAgentRequestTimeoutMilliseconds);
    socket.setTimeout(externalAgentRequestTimeoutMilliseconds, () => {
      socket.destroy();
    });
    let buffer = Buffer.alloc(0);
    let readingFinished = false;
    socket.on("data", (chunk: Buffer) => {
      if (readingFinished || socket.destroyed) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > externalAgentMaxRequestBytes) {
        readingFinished = true;
        this.sendFailure(socket, randomRequestId(), "invalid_request", "要求がサイズ上限を超えています。");
        return;
      }
      const newlineIndex = buffer.indexOf(10);
      if (newlineIndex < 0) {
        return;
      }
      readingFinished = true;
      if (buffer.byteLength !== newlineIndex + 1) {
        this.sendFailure(socket, randomRequestId(), "invalid_request", "要求は一行のJSONだけを指定してください。");
        return;
      }
      const line = buffer.subarray(0, newlineIndex);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      } catch {
        this.sendFailure(socket, randomRequestId(), "invalid_request", "要求のJSONまたは文字コードが不正です。");
        return;
      }
      const parsedEnvelope = externalAgentRequestEnvelopeSchema.safeParse(parsedJson);
      if (!parsedEnvelope.success) {
        this.sendFailure(socket, randomRequestId(), "invalid_request", "要求の形式が不正です。");
        return;
      }
      void this.dispatchRequest(socket, parsedEnvelope.data).catch((error: unknown) => {
        this.notifyError(error);
        this.sendFailure(socket, parsedEnvelope.data.requestId, "internal_error", "外部連携要求に失敗しました。");
      });
    });
    socket.once("end", () => {
      if (!readingFinished) {
        readingFinished = true;
        this.sendFailure(socket, randomRequestId(), "invalid_request", "要求が途中で終了しました。");
      }
    });
    socket.once("close", () => {
      clearTimeout(connectionDeadline);
      this.connections.delete(socket);
    });
    socket.once("error", (error: Error) => {
      this.connections.delete(socket);
      if (this.state === "ready") {
        this.notifyError(error);
      }
    });
  }

  private async dispatchRequest(socket: Socket, envelope: ExternalAgentRequestEnvelope): Promise<void> {
    const descriptor = this.descriptor;
    if (descriptor == null || this.state !== "ready" || !this.enabled || !this.acceptingConnections) {
      this.sendFailure(socket, envelope.requestId, "broker_stopped", "外部連携は利用できません。");
      return;
    }
    if (
      envelope.endpoint !== descriptor.endpoint
      || envelope.instanceId !== descriptor.instanceId
      || !compareCapability(envelope.capability, descriptor.capability)
    ) {
      this.sendFailure(socket, envelope.requestId, "capability_invalid", "外部連携の認証情報が不正です。");
      return;
    }
    const controller = new AbortController();
    this.requestControllers.add(controller);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const requestPromise = this.handleRequest(envelope.input, controller.signal);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new ExternalAgentRequestTimeoutError());
        }, externalAgentRequestTimeoutMilliseconds);
      });
      try {
        const output = await Promise.race([requestPromise, timeoutPromise]);
        this.sendSuccess(socket, envelope.requestId, output);
      } catch (error: unknown) {
        if (error instanceof ExternalAgentRequestTimeoutError) {
          this.notifyError(error);
          this.sendFailure(socket, envelope.requestId, "execution_timeout", "外部連携要求が時間内に完了しませんでした。");
        } else {
          this.notifyError(error);
          this.sendFailure(socket, envelope.requestId, "internal_error", "外部連携要求に失敗しました。");
        }
      }
    } finally {
      if (timeout != null) {
        clearTimeout(timeout);
      }
      this.requestControllers.delete(controller);
    }
  }

  private sendSuccess(socket: Socket, requestId: string, output: unknown): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }
    try {
      const response = externalAgentSuccessResponseSchema.parse({
        version: externalAgentProtocolVersion,
        requestId,
        ok: true,
        output,
      });
      socket.end(serializeResponse(response));
    } catch (error: unknown) {
      if (error instanceof ExternalAgentResponseTooLargeError) {
        this.notifyError(error);
        this.sendFailure(socket, requestId, "response_too_large", "外部連携応答がサイズ上限を超えています。");
        return;
      }
      this.notifyError(error);
      this.sendFailure(socket, requestId, "internal_error", "外部連携応答の生成に失敗しました。");
    }
  }

  private sendFailure(
    socket: Socket,
    requestId: string,
    code: z.infer<typeof externalAgentFailureResponseSchema>["error"]["code"],
    message: string,
  ): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }
    try {
      socket.end(serializeResponse(createFailureResponse(requestId, code, message)));
    } catch (error: unknown) {
      this.notifyError(error);
      socket.destroy();
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopping";
    const paths = this.paths;
    const errors: unknown[] = [];
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    for (const socket of this.connections) {
      socket.destroy();
    }
    if (paths != null) {
      try {
        await this.stopTransport(paths);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      this.state = "failed";
      const error = new Error("外部連携ブリッジの停止に失敗しました。", { cause: new AggregateError(errors) });
      this.notifyError(error);
      throw error;
    }
    this.state = "stopped";
  }

  private async stopTransport(paths: ExternalAgentResourcePaths): Promise<void> {
    const server = this.server;
    this.acceptingConnections = false;
    for (const socket of this.connections) {
      socket.destroy();
    }
    const descriptor = this.descriptor;
    this.descriptor = undefined;
    const errors: unknown[] = [];
    if (descriptor != null) {
      try {
        this.removeOwnedDescriptor(paths, descriptor);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
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
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    this.server = undefined;
    const endpointDirectoryPath = this.unixEndpointDirectoryPath;
    this.unixEndpointDirectoryPath = undefined;
    if (endpointDirectoryPath != null) {
      try {
        rmdirSync(endpointDirectoryPath);
      } catch (error: unknown) {
        if (!isNoEntryError(error)) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "外部連携接続情報の削除に失敗しました。");
    }
  }

  private removeOwnedDescriptor(paths: ExternalAgentResourcePaths, descriptor: ExternalAgentDescriptor): void {
    const raw = readSecurePersistentTextFile(paths.connectionInfoPath, "外部連携接続情報");
    if (raw == null) {
      return;
    }
    const current = externalAgentDescriptorSchema.parse(JSON.parse(raw));
    if (!descriptorMatches(current, descriptor)) {
      throw new Error("外部連携接続情報が別の起動インスタンスに置き換わっています。");
    }
    removeExternalAgentConnectionInfo(paths);
  }
}
