import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
import {
  accountReadParamsSchema,
  accountReadResultSchema,
  chatGptLoginStartParamsSchema,
  chatGptLoginStartResultSchema,
  codexConnectionOptionsSchema,
  codexDiagnosticSchema,
  codexNotificationSchema,
  codexRpcIdSchema,
  experimentalFeatureListParamsSchema,
  experimentalFeatureListResultSchema,
  initializeParamsSchema,
  initializeResultSchema,
  modelListParamsSchema,
  modelListResultSchema,
  mcpServerStatusListParamsSchema,
  mcpServerStatusListResultSchema,
  permissionProfileListParamsSchema,
  permissionProfileListResultSchema,
  skillsListParamsSchema,
  skillsListResultSchema,
  threadStartParamsSchema,
  threadStartResultSchema,
  turnInterruptParamsSchema,
  turnInterruptResultSchema,
  turnStartParamsSchema,
  turnStartResultSchema,
  type AccountReadParams,
  type AccountReadResult,
  type ChatGptLoginStartParams,
  type ChatGptLoginStartResult,
  type CodexConnectionOptions,
  type CodexConfigOverrideValue,
  type CodexDiagnostic,
  type CodexNotification,
  type CodexRpcId,
  type ExperimentalFeatureListParams,
  type ExperimentalFeatureListResult,
  type InitializeParams,
  type ModelListParams,
  type ModelListResult,
  type McpServerStatusListParams,
  type McpServerStatusListResult,
  type PermissionProfileListParams,
  type PermissionProfileListResult,
  type SkillsListParams,
  type SkillsListResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnStartParams,
  type TurnStartResult,
} from "./schemas";
import {
  CodexConnectionStateError,
  CodexConnectionStoppedError,
  CodexPendingRequestLimitError,
  CodexProcessError,
  CodexProcessExitError,
  CodexProtocolError,
  CodexResponseValidationError,
  CodexRequestAbortedError,
  CodexRequestIdExhaustedError,
  CodexRequestTimeoutError,
  CodexRpcError,
  CodexStopTimeoutError,
  CodexStdioError,
  CodexUnknownResponseIdError,
  CodexWriteError,
} from "./errors";
import { checkCodexExecutable, createSafeCodexEnvironment } from "./version";

const maxStdinMessageBytes = 256 * 1024;
const maxStdoutLineBytes = 4 * 1024 * 1024;
const maxStderrLineBytes = 256 * 1024;
const maxJsonDepth = 32;
const maxPendingRequests = 128;
const maxStoredDiagnostics = 256;
const defaultRequestTimeoutMs = 30_000;
const maxRequestId = Number.MAX_SAFE_INTEGER;
const maxQueuedWrites = 128;
const gracefulStopTimeoutMs = 1_000;
const forcedStopTimeoutMs = 1_000;

const rpcResponseResultSchema = z
  .object({
    id: codexRpcIdSchema,
    result: z.unknown(),
  })
  .strict();

const rpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string().min(1).max(2_000),
    data: z.unknown().optional(),
  })
  .strict();

const rpcResponseErrorSchema = z
  .object({
    id: codexRpcIdSchema,
    error: rpcErrorSchema,
  })
  .strict();

const rpcNotificationEnvelopeSchema = z
  .object({
    method: z.string().min(1).max(200),
    params: z.unknown().optional(),
    emittedAtMs: z.number().finite().optional(),
  })
  .strip();

const rpcServerRequestEnvelopeSchema = z
  .object({
    method: z.string().min(1).max(200),
    id: codexRpcIdSchema,
    params: z.unknown().optional(),
  })
  .strict();

type RpcResponseResult = z.infer<typeof rpcResponseResultSchema>;
type RpcResponseError = z.infer<typeof rpcResponseErrorSchema>;
type RpcNotificationEnvelope = z.infer<typeof rpcNotificationEnvelopeSchema>;
type RpcServerRequestEnvelope = z.infer<typeof rpcServerRequestEnvelopeSchema>;

type ProcessTerminationTarget =
  | { readonly kind: "direct_child" }
  | {
      readonly kind: "posix_process_group";
      readonly process_group_id: number;
    };

type ProcessSignalResult =
  | { readonly kind: "sent" }
  | { readonly kind: "not_running" };

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
}

type ConnectionState = "created" | "starting" | "ready" | "failed" | "stopping" | "stopped";

/** 型付きCodex通知を受け取る購読関数の型です。 */
export type CodexNotificationListener =
  (notification: CodexNotification) => void | PromiseLike<void>;

/** 本文を含まないCodex診断を受け取る購読関数の型です。 */
export type CodexDiagnosticListener =
  (diagnostic: CodexDiagnostic) => void | PromiseLike<void>;

function responseIdKey(id: CodexRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function validateDetachedProcessGroupId(pid: number | undefined): number {
  if (
    pid == null
    || !Number.isSafeInteger(pid)
    || pid <= 1
    || pid === process.pid
    || pid === process.ppid
  ) {
    throw new Error("Codex app-serverの専用プロセスグループIDが不正です。");
  }
  return pid;
}

function isNoSuchProcessError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ESRCH";
}

function createProcessSignalError(
  signal: NodeJS.Signals,
  cause: unknown,
): Error {
  return new Error(
    `Codex app-serverへ${signal}を送信できませんでした。`,
    { cause },
  );
}

function compareNumericRequestId(id: CodexRpcId, nextId: number): boolean {
  return (
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    id < nextId
  );
}

function jsonDepth(value: unknown, depth: number): number {
  let deepest = depth;
  const path = new WeakSet<object>();
  const pending: Array<
    | { kind: "enter"; value: unknown; depth: number }
    | { kind: "leave"; value: object }
  > = [{ kind: "enter", value, depth }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current == null) {
      continue;
    }
    if (current.kind === "leave") {
      path.delete(current.value);
      continue;
    }
    if (typeof current.value !== "object" || current.value == null) {
      continue;
    }
    if (path.has(current.value)) {
      continue;
    }
    path.add(current.value);
    if (current.depth > deepest) {
      deepest = current.depth;
    }
    pending.push({ kind: "leave", value: current.value });
    const childDepth = current.depth + 1;
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ kind: "enter", value: item, depth: childDepth });
      }
      continue;
    }
    for (const item of Object.values(current.value)) {
      pending.push({ kind: "enter", value: item, depth: childDepth });
    }
  }
  return deepest;
}

function knownNotificationMethod(method: string): boolean {
  return [
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/completed",
    "thread/settings/updated",
    "account/updated",
    "account/login/completed",
    "skills/changed",
    "item/agentMessage/delta",
  ].includes(method);
}

/** Codex app-serverのJSONL接続を管理します。 */
export class CodexAppServerConnection {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly clientInfo: InitializeParams["clientInfo"];
  private readonly capabilities: InitializeParams["capabilities"];
  private readonly requestTimeoutMs: number;
  private readonly configOverrides: readonly CodexConfigOverrideValue[];
  private codexHome: string | undefined;
  private state: ConnectionState = "created";
  private child: ChildProcess | undefined;
  private processTerminationTarget: ProcessTerminationTarget | undefined;
  private stdoutReader: Interface | undefined;
  private stderrReader: Interface | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly diagnostics: CodexDiagnostic[] = [];
  private readonly notificationListeners = new Set<CodexNotificationListener>();
  private readonly diagnosticListeners = new Set<CodexDiagnosticListener>();
  private stderrLineCount = 0;
  private stdoutLineBytes = 0;
  private stderrLineBytes = 0;
  private stderrReadingStopped = false;
  private terminalError: Error | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopResolve: (() => void) | undefined;
  private stopReject: ((reason: unknown) => void) | undefined;
  private gracefulStopTimer: NodeJS.Timeout | undefined;
  private forcedStopTimer: NodeJS.Timeout | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private queuedWrites = 0;

  public constructor(options: CodexConnectionOptions) {
    const validatedOptions = codexConnectionOptionsSchema.parse(options);
    this.executable = validatedOptions.executable ?? "codex";
    const sourceEnvironment = validatedOptions.environment ?? process.env;
    this.environment = createSafeCodexEnvironment(sourceEnvironment);
    this.clientInfo = validatedOptions.clientInfo;
    this.capabilities = validatedOptions.capabilities;
    this.requestTimeoutMs = validatedOptions.requestTimeoutMs ?? defaultRequestTimeoutMs;
    this.configOverrides = validatedOptions.configOverrides;
  }

  /** Codex CLIを検査してapp-serverを初期化します。 */
  public async start(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    if (this.state !== "created") {
      throw new CodexConnectionStateError();
    }
    this.state = "starting";

    try {
      await checkCodexExecutable(this.executable, this.environment, signal);
      if (this.state !== "starting") {
        throw new CodexConnectionStoppedError();
      }
      if (signal.aborted) {
        throw new CodexRequestAbortedError("codex --version");
      }
      this.startProcess();
      const initializeParams = initializeParamsSchema.parse({
        clientInfo: this.clientInfo,
        ...(this.capabilities == null ? {} : { capabilities: this.capabilities }),
      });
      const initializeResult = await this.requestInternal(
        "initialize",
        initializeParams,
        initializeResultSchema,
        signal,
      );
      this.codexHome = initializeResult.codexHome;
      if (signal.aborted) {
        throw new CodexRequestAbortedError("initialize");
      }
      await this.sendNotification("initialized", {});
      if (signal.aborted) {
        throw new CodexRequestAbortedError("initialized");
      }
      this.state = "ready";
    } catch (error: unknown) {
      this.failConnection(error);
      try {
        await this.stop();
      } catch {
        this.emitDiagnostic({ kind: "stop_error", code: "stop_error" });
      }
      throw error;
    }
  }

  /** account/readで現在のCodex認証状態を取得します。 */
  public async readAccount(
    params: AccountReadParams,
    signal: AbortSignal,
  ): Promise<AccountReadResult> {
    const validatedParams = accountReadParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "account/read",
      validatedParams,
      accountReadResultSchema,
      signal,
    );
  }

  /** ChatGPTブラウザログインを開始します。 */
  public async startChatGptLogin(
    params: ChatGptLoginStartParams,
    signal: AbortSignal,
  ): Promise<ChatGptLoginStartResult> {
    const validatedParams = chatGptLoginStartParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "account/login/start",
      validatedParams,
      chatGptLoginStartResultSchema,
      signal,
    );
  }

  /** 利用可能なCodexモデルを取得します。 */
  public async listModels(
    params: ModelListParams,
    signal: AbortSignal,
  ): Promise<ModelListResult> {
    const validatedParams = modelListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "model/list",
      validatedParams,
      modelListResultSchema,
      signal,
    );
  }

  /** 利用可能なスキル一覧を取得します。 */
  public async listSkills(
    params: SkillsListParams,
    signal: AbortSignal,
  ): Promise<SkillsListResult> {
    const validatedParams = skillsListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "skills/list",
      validatedParams,
      skillsListResultSchema,
      signal,
    );
  }

  /** 利用可能な権限プロファイルを取得します。 */
  public async listPermissionProfiles(
    params: PermissionProfileListParams,
    signal: AbortSignal,
  ): Promise<PermissionProfileListResult> {
    const validatedParams = permissionProfileListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "permissionProfile/list",
      validatedParams,
      permissionProfileListResultSchema,
      signal,
    );
  }

  /** 接続中のMCPサーバー状態を取得します。 */
  public async listMcpServerStatuses(
    params: McpServerStatusListParams,
    signal: AbortSignal,
  ): Promise<McpServerStatusListResult> {
    const validatedParams = mcpServerStatusListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "mcpServerStatus/list",
      validatedParams,
      mcpServerStatusListResultSchema,
      signal,
    );
  }

  /** 実効化されたCodex機能一覧を取得します。 */
  public async listExperimentalFeatures(
    params: ExperimentalFeatureListParams,
    signal: AbortSignal,
  ): Promise<ExperimentalFeatureListResult> {
    const validatedParams = experimentalFeatureListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "experimentalFeature/list",
      validatedParams,
      experimentalFeatureListResultSchema,
      signal,
    );
  }

  /** 初期化応答で得たCodexホームのパスを取得します。 */
  public getCodexHome(): string {
    if (this.codexHome == null) {
      throw new CodexConnectionStateError();
    }
    return this.codexHome;
  }

  /** 新しいCodexスレッドを開始します。 */
  public async startThread(
    params: ThreadStartParams,
    signal: AbortSignal,
  ): Promise<ThreadStartResult> {
    const validatedParams = threadStartParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "thread/start",
      validatedParams,
      threadStartResultSchema,
      signal,
    );
  }

  /** Codexスレッドのターンを開始します。 */
  public async startTurn(
    params: TurnStartParams,
    signal: AbortSignal,
  ): Promise<TurnStartResult> {
    const validatedParams = turnStartParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "turn/start",
      validatedParams,
      turnStartResultSchema,
      signal,
    );
  }

  /** 実行中のCodexターンを中断します。 */
  public async interruptTurn(
    params: TurnInterruptParams,
    signal: AbortSignal,
  ): Promise<TurnInterruptResult> {
    const validatedParams = turnInterruptParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "turn/interrupt",
      validatedParams,
      turnInterruptResultSchema,
      signal,
    );
  }

  /** 型付き通知の購読を登録します。 */
  public onNotification(listener: CodexNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /** 本文を含まない診断の購読を登録します。 */
  public onDiagnostic(listener: CodexDiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  /** 保持中の本文なし診断を読み出します。 */
  public getDiagnostics(): readonly CodexDiagnostic[] {
    return this.diagnostics.slice();
  }

  /** JSONL接続、子プロセス、保留要求を停止します。 */
  public stop(): Promise<void> {
    if (this.stopPromise != null) {
      return this.stopPromise;
    }
    this.stopPromise = new Promise<void>((resolve, reject) => {
      this.stopResolve = resolve;
      this.stopReject = reject;
      this.state = "stopping";
      const stopError = new CodexConnectionStoppedError();
      this.rejectPending(stopError);
      this.closeReaders();

      const child = this.child;
      if (child == null) {
        this.finishStop();
        return;
      }

      try {
        if (child.stdin != null && !child.stdin.destroyed) {
          child.stdin.end();
        }
        if (!this.isProcessTreeRunning(child)) {
          this.finishStop();
          return;
        }
        if (this.state !== "stopping") {
          return;
        }
        this.gracefulStopTimer = setTimeout(() => {
          this.forceStopChild();
        }, gracefulStopTimeoutMs);
      } catch (error: unknown) {
        this.finishStop(error);
      }
    });
    return this.stopPromise;
  }

  private validatedProcessGroupId(
    child: ChildProcess,
    target: Extract<ProcessTerminationTarget, {
      readonly kind: "posix_process_group";
    }>,
  ): number {
    const processGroupId = validateDetachedProcessGroupId(child.pid);
    if (processGroupId !== target.process_group_id) {
      throw new Error("Codex app-serverの専用プロセスグループIDが変化しました。");
    }
    return processGroupId;
  }

  private isProcessTreeRunning(child: ChildProcess): boolean {
    const target = this.processTerminationTarget;
    if (target == null || target.kind === "direct_child") {
      return child.exitCode == null && child.signalCode == null;
    }
    const processGroupId = this.validatedProcessGroupId(child, target);
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error: unknown) {
      if (isNoSuchProcessError(error)) {
        return false;
      }
      throw error;
    }
  }

  private signalProcessTree(
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): ProcessSignalResult {
    const target = this.processTerminationTarget;
    if (target == null || target.kind === "direct_child") {
      if (child.exitCode != null || child.signalCode != null) {
        return { kind: "not_running" };
      }
      let sent: boolean;
      try {
        sent = child.kill(signal);
      } catch (error: unknown) {
        throw createProcessSignalError(signal, error);
      }
      if (sent) {
        return { kind: "sent" };
      }
      if (child.exitCode != null || child.signalCode != null) {
        return { kind: "not_running" };
      }
      throw createProcessSignalError(
        signal,
        new Error("子プロセス停止APIがシグナル送信を拒否しました。"),
      );
    }
    const processGroupId = this.validatedProcessGroupId(child, target);
    let sent: boolean;
    try {
      sent = process.kill(-processGroupId, signal);
    } catch (error: unknown) {
      if (isNoSuchProcessError(error)) {
        return { kind: "not_running" };
      }
      throw createProcessSignalError(signal, error);
    }
    if (sent) {
      return { kind: "sent" };
    }
    try {
      if (!this.isProcessTreeRunning(child)) {
        return { kind: "not_running" };
      }
    } catch (error: unknown) {
      throw createProcessSignalError(signal, error);
    }
    throw createProcessSignalError(
      signal,
      new Error("プロセスグループ停止APIがシグナル送信を拒否しました。"),
    );
  }

  private forceStopChild(): void {
    if (this.state !== "stopping") {
      return;
    }
    this.gracefulStopTimer = undefined;
    const child = this.child;
    if (child == null) {
      this.finishStop();
      return;
    }
    try {
      if (!this.isProcessTreeRunning(child)) {
        this.finishStop();
        return;
      }
      const signalResult = this.signalProcessTree(child, "SIGKILL");
      if (signalResult.kind === "not_running") {
        this.finishStop();
        return;
      }
    } catch (error: unknown) {
      this.finishStop(error);
      return;
    }
    this.forcedStopTimer = setTimeout(() => {
      this.finishForcedStop();
    }, forcedStopTimeoutMs);
  }

  private finishForcedStop(): void {
    this.forcedStopTimer = undefined;
    if (this.state !== "stopping") {
      return;
    }
    const child = this.child;
    if (child == null) {
      this.finishStop();
      return;
    }
    try {
      if (this.isProcessTreeRunning(child)) {
        this.finishStop(new CodexStopTimeoutError());
        return;
      }
      this.finishStop();
    } catch (error: unknown) {
      this.finishStop(error);
    }
  }

  private startProcess(): void {
    const usePosixProcessGroup = process.platform !== "win32";
    const child = spawn(this.executable, [
      ...this.configOverrides.flatMap((override) => ["-c", override.toArgument()]),
      "app-server",
    ], {
      detached: usePosixProcessGroup,
      env: this.environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    child.on("error", (error: Error) => {
      this.handleChildError(error);
    });
    this.processTerminationTarget = usePosixProcessGroup
      ? {
        kind: "posix_process_group",
        process_group_id: validateDetachedProcessGroupId(child.pid),
      }
      : { kind: "direct_child" };
    if (child.stdin == null || child.stdout == null || child.stderr == null) {
      throw new CodexStdioError();
    }
    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.handleStderrChunk(chunk);
    });
    this.stdoutReader = createInterface({ input: child.stdout });
    this.stderrReader = createInterface({ input: child.stderr });
    this.stdoutReader.on("line", (line: string) => {
      this.handleStdoutLine(line);
    });
    this.stderrReader.on("line", () => {
      this.handleStderrLine();
    });
    child.on("exit", (exitCode: number | null, signal: NodeJS.Signals | null) => {
      this.handleChildExit(exitCode, signal);
    });
    child.stdin.on("error", (error: Error) => {
      this.handleStdioError(error);
    });
    child.stdout.on("error", (error: Error) => {
      this.handleStdioError(error);
    });
    child.stderr.on("error", (error: Error) => {
      this.handleStdioError(error);
    });
  }

  private ensureReady(): void {
    if (this.state !== "ready") {
      if (this.state === "stopped" || this.state === "stopping") {
        throw new CodexConnectionStoppedError();
      }
      throw new CodexConnectionStateError();
    }
  }

  private requestInternal<Output>(
    method: string,
    params: unknown,
    schema: z.ZodType<Output>,
    signal: AbortSignal,
  ): Promise<Output> {
    validateAbortSignal(signal);
    if (this.state !== "starting" && this.state !== "ready") {
      if (this.state === "stopped" || this.state === "stopping") {
        return Promise.reject(new CodexConnectionStoppedError());
      }
      if (this.terminalError != null) {
        return Promise.reject(this.terminalError);
      }
      return Promise.reject(new CodexConnectionStateError());
    }
    if (this.pendingRequests.size >= maxPendingRequests) {
      return Promise.reject(new CodexPendingRequestLimitError());
    }
    if (this.nextRequestId >= maxRequestId) {
      return Promise.reject(new CodexRequestIdExhaustedError());
    }
    if (signal.aborted) {
      return Promise.reject(new CodexRequestAbortedError(method));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = responseIdKey(id);

    return new Promise<Output>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleRequestTimeout(key, method);
      }, this.requestTimeoutMs);
      const abortListener = (): void => {
        this.handleRequestAbort(key, method);
      };
      this.pendingRequests.set(key, {
        resolve: (value: unknown) => {
          resolve(schema.parse(value));
        },
        reject,
        timeout,
        signal,
        abortListener,
      });
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        this.handleRequestAbort(key, method);
        return;
      }
      try {
        void this.writeMessage({ method, id, params }).catch((error: unknown) => {
          this.failConnection(error);
        });
      } catch (error: unknown) {
        const pending = this.pendingRequests.get(key);
        if (pending != null) {
          this.pendingRequests.delete(key);
          this.cleanupPending(pending);
        }
        this.failConnection(error);
        const rejection =
          error instanceof Error
            ? error
            : new Error("Codex app-server要求の送信に失敗しました。", { cause: error });
        reject(rejection);
      }
    });
  }

  private sendNotification(method: string, params: unknown): Promise<void> {
    return this.writeMessage({ method, params });
  }

  private writeMessage(message: unknown): Promise<void> {
    if (jsonDepth(message, 0) > maxJsonDepth) {
      throw new CodexProtocolError(
        "json_too_deep",
        new Error("Codex app-server要求のJSON深度が上限を超えました。"),
      );
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(message);
    } catch (error: unknown) {
      throw new CodexWriteError(error);
    }
    if (serialized == null) {
      throw new CodexWriteError(new Error("Codex app-server要求をJSON化できません。"));
    }
    if (Buffer.byteLength(serialized, "utf8") > maxStdinMessageBytes) {
      throw new CodexProtocolError(
        "message_too_large",
        new Error("Codex app-server要求がサイズ上限を超えました。"),
      );
    }
    if (this.queuedWrites >= maxQueuedWrites) {
      throw new CodexWriteError(new Error("Codex app-server要求の送信待ちが上限を超えました。"));
    }
    this.queuedWrites += 1;
    const queuedWrite = this.writeQueue.then(() => this.writeSerialized(`${serialized}\n`));
    this.writeQueue = queuedWrite.then(
      () => {
        this.queuedWrites -= 1;
      },
      (error: unknown) => {
        this.queuedWrites -= 1;
        this.failConnection(error);
      },
    );
    return queuedWrite;
  }

  private writeSerialized(serialized: string): Promise<void> {
    const child = this.child;
    if (
      child == null ||
      child.stdin == null ||
      child.stdin.destroyed ||
      this.state === "stopping" ||
      this.state === "stopped" ||
      this.state === "failed"
    ) {
      throw new CodexWriteError(new Error("Codex app-serverの標準入力が利用できません。"));
    }
    const stdin = child.stdin;
    return new Promise<void>((resolve, reject) => {
      let callbackCompleted = false;
      let drainCompleted = true;
      let writeReturned = false;
      let settled = false;

      const cleanup = (): void => {
        stdin.removeListener("error", onError);
        stdin.removeListener("drain", onDrain);
      };
      const settleResolve = (): void => {
        if (!callbackCompleted || !drainCompleted || !writeReturned || settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const settleReject = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof CodexWriteError ? error : new CodexWriteError(error));
      };
      const onError = (error: Error): void => {
        settleReject(error);
      };
      const onDrain = (): void => {
        drainCompleted = true;
        settleResolve();
      };
      stdin.once("error", onError);
      try {
        const accepted = stdin.write(serialized, (error: Error | null | undefined) => {
          if (error != null) {
            settleReject(error);
            return;
          }
          callbackCompleted = true;
          settleResolve();
        });
        writeReturned = true;
        if (!accepted) {
          drainCompleted = false;
          stdin.once("drain", onDrain);
        }
        settleResolve();
      } catch (error: unknown) {
        writeReturned = true;
        settleReject(error);
      }
    });
  }

  private handleStdoutLine(line: string): void {
    if (this.state === "failed" || this.state === "stopped" || this.state === "stopping") {
      return;
    }
    try {
      const byteLength = Buffer.byteLength(line, "utf8");
      if (byteLength > maxStdoutLineBytes) {
        throw new CodexProtocolError(
          "message_too_large",
          new Error("Codex app-server応答がサイズ上限を超えました。"),
        );
      }
      const parsed: unknown = JSON.parse(line);
      if (jsonDepth(parsed, 0) > maxJsonDepth) {
        throw new CodexProtocolError(
          "json_too_deep",
          new Error("Codex app-server応答のJSON深度が上限を超えました。"),
        );
      }
      this.handleParsedMessage(parsed);
    } catch (error: unknown) {
      const connectionError = this.toConnectionError(error);
      this.failConnection(connectionError);
      this.emitDiagnostic({ kind: "protocol_error", code: "protocol_error" });
    }
  }

  private handleStdoutChunk(chunk: Buffer): void {
    if (this.state === "failed" || this.state === "stopped" || this.state === "stopping") {
      return;
    }
    for (const byte of chunk) {
      if (byte === 10) {
        this.stdoutLineBytes = 0;
        continue;
      }
      this.stdoutLineBytes += 1;
      if (this.stdoutLineBytes > maxStdoutLineBytes) {
        const protocolError = new CodexProtocolError(
          "message_too_large",
          new Error("Codex app-server応答の行サイズが上限を超えました。"),
        );
        this.failConnection(protocolError);
        this.emitDiagnostic({ kind: "protocol_error", code: "protocol_error" });
        return;
      }
    }
  }

  private handleParsedMessage(parsed: unknown): void {
    const result = rpcResponseResultSchema.safeParse(parsed);
    if (result.success) {
      this.handleResponseResult(result.data);
      return;
    }
    const errorResponse = rpcResponseErrorSchema.safeParse(parsed);
    if (errorResponse.success) {
      this.handleResponseError(errorResponse.data);
      return;
    }
    const serverRequest = rpcServerRequestEnvelopeSchema.safeParse(parsed);
    if (serverRequest.success) {
      this.handleServerRequest(serverRequest.data);
      return;
    }
    const notification = rpcNotificationEnvelopeSchema.safeParse(parsed);
    if (notification.success) {
      this.handleNotification(notification.data);
      return;
    }
    throw new CodexProtocolError(
      "invalid_message",
      new Error("Codex app-serverメッセージの形式が不正です。"),
    );
  }

  private handleResponseResult(response: RpcResponseResult): void {
    this.ensureIssuedNumericResponseId(response.id);
    const key = responseIdKey(response.id);
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    try {
      pending.resolve(response.result);
    } catch (error: unknown) {
      const validationError = new CodexResponseValidationError(error);
      pending.reject(validationError);
      throw validationError;
    }
  }

  private handleResponseError(response: RpcResponseError): void {
    this.ensureIssuedNumericResponseId(response.id);
    const key = responseIdKey(response.id);
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    const rpcError = new CodexRpcError(response.error.code);
    pending.reject(rpcError);
  }

  private ensureIssuedNumericResponseId(id: CodexRpcId): void {
    if (!compareNumericRequestId(id, this.nextRequestId)) {
      throw new CodexUnknownResponseIdError();
    }
  }

  private handleNotification(notification: RpcNotificationEnvelope): void {
    if (!knownNotificationMethod(notification.method)) {
      this.emitDiagnostic({
        kind: "unknown_notification",
        code: "unknown_notification",
        method: notification.method,
      });
      return;
    }
    const known = codexNotificationSchema.safeParse({
      method: notification.method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    });
    if (!known.success) {
      throw new CodexProtocolError(
        "invalid_message",
        new Error("既知のCodex通知を検証できません。"),
      );
    }
    this.emitNotification(known.data);
  }

  private handleServerRequest(request: RpcServerRequestEnvelope): void {
    this.emitDiagnostic({
      kind: "server_request_rejected",
      code: "server_request_rejected",
      method: request.method,
    });
    void this.writeMessage({
      id: request.id,
      error: {
        code: -32601,
        message: "サーバー開始要求は許可されていません。",
      },
    }).catch((error: unknown) => {
      this.failConnection(error);
    });
  }

  private handleStderrLine(): void {
    this.stderrLineCount += 1;
    this.stderrLineBytes = 0;
    this.emitDiagnostic({
      kind: "stderr",
      code: "stderr_output",
      lineCount: this.stderrLineCount,
    });
  }

  private handleStderrChunk(chunk: Buffer): void {
    if (this.stderrReadingStopped) {
      return;
    }
    for (const byte of chunk) {
      if (byte === 10) {
        this.stderrLineBytes = 0;
        continue;
      }
      this.stderrLineBytes += 1;
      if (this.stderrLineBytes > maxStderrLineBytes) {
        this.stderrReadingStopped = true;
        this.stderrReader?.close();
        this.stderrReader = undefined;
        this.child?.stderr?.resume();
        return;
      }
    }
  }

  private handleStdioError(error: Error): void {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }
    const stdioError = new CodexStdioError(error);
    this.failConnection(stdioError);
  }

  private handleChildError(error: Error): void {
    if (this.state === "stopped" || this.state === "stopping") {
      return;
    }
    const processError = new CodexProcessError(error);
    this.failConnection(processError);
  }

  private handleChildExit(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === "stopping") {
      const child = this.child;
      if (child == null) {
        this.finishStop();
        return;
      }
      try {
        if (!this.isProcessTreeRunning(child)) {
          this.finishStop();
        }
      } catch (error: unknown) {
        this.finishStop(error);
      }
      return;
    }
    if (this.state === "stopped") {
      return;
    }
    const processExitError = new CodexProcessExitError(exitCode, signal);
    this.emitDiagnostic({
      kind: "process_exit",
      code: "process_exit",
      exitCode,
      signal,
    });
    this.failConnection(processExitError);
  }

  private handleRequestTimeout(key: string, method: string): void {
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    pending.reject(new CodexRequestTimeoutError(method));
  }

  private handleRequestAbort(key: string, method: string): void {
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    pending.reject(new CodexRequestAbortedError(method));
  }

  private cleanupPending(pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener("abort", pending.abortListener);
  }

  private emitNotification(notification: CodexNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        const result = listener(notification);
        this.handleListenerResult(result, "notification");
      } catch {
        this.reportListenerError("notification");
      }
    }
  }

  private emitDiagnostic(diagnostic: CodexDiagnostic): void {
    const validatedDiagnostic = codexDiagnosticSchema.parse(diagnostic);
    this.storeDiagnostic(validatedDiagnostic);
    for (const listener of this.diagnosticListeners) {
      try {
        const result = listener(validatedDiagnostic);
        this.handleListenerResult(result, "diagnostic");
      } catch {
        this.storeListenerError("diagnostic");
      }
    }
  }

  private handleListenerResult(
    result: void | PromiseLike<void>,
    source: "notification" | "diagnostic",
  ): void {
    if (result == null) {
      return;
    }
    void Promise.resolve(result).catch(() => {
      this.reportListenerError(source);
    });
  }

  private reportListenerError(source: "notification" | "diagnostic"): void {
    if (source === "notification") {
      this.emitDiagnostic({
        kind: "listener_error",
        code: "listener_error",
        source,
      });
      return;
    }
    this.storeListenerError(source);
  }

  private storeListenerError(source: "notification" | "diagnostic"): void {
    this.storeDiagnostic({
      kind: "listener_error",
      code: "listener_error",
      source,
    });
  }

  private storeDiagnostic(diagnostic: CodexDiagnostic): void {
    if (this.diagnostics.length >= maxStoredDiagnostics) {
      this.diagnostics.shift();
    }
    this.diagnostics.push(diagnostic);
  }

  private toConnectionError(error: unknown): Error {
    if (
      error instanceof CodexProtocolError ||
      error instanceof CodexUnknownResponseIdError ||
      error instanceof CodexRpcError ||
      error instanceof CodexResponseValidationError
    ) {
      return error;
    }
    return new CodexProtocolError("invalid_message", error);
  }

  private failConnection(error: unknown): void {
    const connectionError = error instanceof Error ? error : new Error("Codex app-server接続に失敗しました。", { cause: error });
    if (this.terminalError == null) {
      this.terminalError = connectionError;
    }
    this.rejectPending(connectionError);
    if (this.state === "stopping" || this.state === "stopped") {
      return;
    }
    this.state = "failed";
    this.closeReaders();
    const child = this.child;
    if (child == null) {
      return;
    }
    try {
      if (child.stdin != null && !child.stdin.destroyed) {
        child.stdin.destroy();
      }
    } catch {
      this.emitDiagnostic({ kind: "stop_error", code: "stop_error" });
    }
    try {
      if (this.isProcessTreeRunning(child)) {
        this.signalProcessTree(child, "SIGTERM");
      }
    } catch {
      this.emitDiagnostic({ kind: "stop_error", code: "stop_error" });
    }
  }

  private rejectPending(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private closeReaders(): void {
    this.stdoutReader?.close();
    this.stderrReader?.close();
    this.stdoutReader = undefined;
    this.stderrReader = undefined;
  }

  private finishStop(error?: unknown): void {
    if (this.gracefulStopTimer != null) {
      clearTimeout(this.gracefulStopTimer);
      this.gracefulStopTimer = undefined;
    }
    if (this.forcedStopTimer != null) {
      clearTimeout(this.forcedStopTimer);
      this.forcedStopTimer = undefined;
    }
    this.closeReaders();
    this.state = error == null ? "stopped" : "failed";
    const resolve = this.stopResolve;
    const reject = this.stopReject;
    this.stopResolve = undefined;
    this.stopReject = undefined;
    if (error == null) {
      resolve?.();
      return;
    }
    reject?.(error);
  }
}
