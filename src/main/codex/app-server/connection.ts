import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import {
  codexConnectionOptionsSchema,
  initializeParamsSchema,
  initializeResultSchema,
  type CodexConnectionOptions,
  type CodexConfigOverrideValue,
  type InitializeParams,
} from "../../infrastructure/ai/codex-app-server";
import {
  CodexConnectionStateError,
  CodexConnectionStoppedError,
  CodexProcessError,
  CodexProcessExitError,
  CodexProtocolError,
  CodexRequestAbortedError,
  CodexStopTimeoutError,
  CodexStdioError,
  CodexWriteError,
} from "./errors";
import {
  CodexRpcEndpoint,
  validateAbortSignal,
} from "../../infrastructure/ai/codex-app-server/rpc-endpoint";
import { checkCodexExecutable, createSafeCodexEnvironment } from "./version";

const maxStdinMessageBytes = 256 * 1024;
const maxStdoutLineBytes = 4 * 1024 * 1024;
const maxStderrLineBytes = 256 * 1024;
const maxJsonDepth = 32;
const maxQueuedWrites = 128;
const defaultRequestTimeoutMs = 30_000;
const gracefulStopTimeoutMs = 1_000;
const forcedStopTimeoutMs = 1_000;

type ProcessTerminationTarget =
  | { readonly kind: "direct_child" }
  | {
      readonly kind: "posix_process_group";
      readonly process_group_id: number;
    };

type ProcessSignalResult =
  | { readonly kind: "sent" }
  | { readonly kind: "not_running" };

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

/** Codex app-serverのJSONL接続と子プロセスを管理します。 */
export class CodexAppServerConnection extends CodexRpcEndpoint {
  private readonly executable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly clientInfo: InitializeParams["clientInfo"];
  private readonly capabilities: InitializeParams["capabilities"];
  private readonly configOverrides: readonly CodexConfigOverrideValue[];
  private codexHome: string | undefined;
  private child: ChildProcess | undefined;
  private processTerminationTarget: ProcessTerminationTarget | undefined;
  private stdoutReader: Interface | undefined;
  private stderrReader: Interface | undefined;
  private stderrLineCount = 0;
  private stdoutLineBytes = 0;
  private stderrLineBytes = 0;
  private stderrReadingStopped = false;
  private stopPromise: Promise<void> | undefined;
  private stopResolve: (() => void) | undefined;
  private stopReject: ((reason: unknown) => void) | undefined;
  private gracefulStopTimer: NodeJS.Timeout | undefined;
  private forcedStopTimer: NodeJS.Timeout | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private queuedWrites = 0;

  public constructor(options: CodexConnectionOptions, onError: (error: unknown) => void) {
    const validatedOptions = codexConnectionOptionsSchema.parse(options);
    super(validatedOptions.requestTimeoutMs ?? defaultRequestTimeoutMs, onError);
    this.executable = validatedOptions.executable ?? "codex";
    const sourceEnvironment = validatedOptions.environment ?? process.env;
    this.environment = createSafeCodexEnvironment(sourceEnvironment);
    this.clientInfo = validatedOptions.clientInfo;
    this.capabilities = validatedOptions.capabilities;
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
      } catch (stopError: unknown) {
        this.emitDiagnostic({ kind: "stop_error", code: "stop_error", error: stopError });
      }
      throw error;
    }
  }

  /** 初期化応答で得たCodexホームのパスを取得します。 */
  public getCodexHome(): string {
    if (this.codexHome == null) {
      throw new CodexConnectionStateError();
    }
    return this.codexHome;
  }

  /** JSONL接続、子プロセス、保留要求を停止します。 */
  public stop(): Promise<void> {
    this.dynamicToolHandler = undefined;
    this.abortDynamicToolRequests();
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
    this.stderrReader.on("line", (line: string) => {
      this.handleStderrLine(line);
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

  protected writeMessage(message: unknown): Promise<void> {
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
      this.emitDiagnostic({ kind: "protocol_error", code: "protocol_error", error: connectionError });
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
        this.emitDiagnostic({ kind: "protocol_error", code: "protocol_error", error: protocolError });
        return;
      }
    }
  }

  private handleStderrLine(line: string): void {
    this.stderrLineCount += 1;
    this.stderrLineBytes = 0;
    this.emitDiagnostic({
      kind: "stderr",
      code: "stderr_output",
      lineCount: this.stderrLineCount,
      line,
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

  protected failConnection(error: unknown): void {
    const connectionError = error instanceof Error ? error : new Error("Codex app-server接続に失敗しました。", { cause: error });
    if (this.terminalError == null) {
      this.terminalError = connectionError;
    }
    this.dynamicToolHandler = undefined;
    this.abortDynamicToolRequests();
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
    } catch (error: unknown) {
      this.emitDiagnostic({ kind: "stop_error", code: "stop_error", error });
    }
    try {
      if (this.isProcessTreeRunning(child)) {
        this.signalProcessTree(child, "SIGTERM");
      }
    } catch (error: unknown) {
      this.emitDiagnostic({ kind: "stop_error", code: "stop_error", error });
    }
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
