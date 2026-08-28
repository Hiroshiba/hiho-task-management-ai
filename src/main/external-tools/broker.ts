import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import {
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { z } from "zod";
import type { JsonValue } from "../../shared/domain";
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
  externalToolProtocolVersion,
  externalToolRequestSchema,
  externalToolResponseSchema,
  externalToolMaxOutputRecords,
  type ExternalToolBrokerOptions,
  type ExternalToolBrokerStartResult,
  type ExternalToolCredentialProvider,
  type ExternalToolDefinition,
  type ExternalToolDiagnostic,
  type ExternalToolDiagnosticCode,
  type ExternalToolExecutionResult,
  type ExternalToolInvocation,
  type ExternalToolOutput,
  type ExternalToolResponse,
} from "./schemas";
import { ExternalToolError } from "./errors";

const directoryMode = 0o700;
const connectionInfoMode = 0o600;
const unixSocketMode = 0o600;
const credentialKeyPattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const maximumCredentialValueBytes = 4_096;
const maximumRequestMilliseconds = 35_000;
const processTerminationGraceMilliseconds = 250;
const childWorkingDirectoryMode = 0o500;
const transientProcessErrorCodes = new Set([
  "EAGAIN",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
]);
const safeParentEnvironmentNames = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
]);
const forbiddenCredentialEnvironmentNames = new Set([
  "ALL_PROXY",
  "APPDATA",
  "BASH_ENV",
  "CDPATH",
  "CLASSPATH",
  "CARGO_HOME",
  "COMSPEC",
  "ELECTRON_RUN_AS_NODE",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH_COMMAND",
  "IFS",
  "JAVA_TOOL_OPTIONS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PERL5LIB",
  "PERL5OPT",
  "PROMPT_COMMAND",
  "PS4",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "_JAVA_OPTIONS",
]);
const forbiddenCredentialEnvironmentPrefixes = [
  "BASH_",
  "CARGO_",
  "DYLD_",
  "ELECTRON_",
  "GIT_",
  "GIT_CONFIG",
  "JAVA_",
  "LD_",
  "NODE_",
  "NPM_",
  "PERL",
  "PIP_",
  "PYTHON",
  "RUBY",
  "XDG_",
];
const forbiddenArgumentNamePrefixes = [
  "auth",
  "base",
  "config",
  "cwd",
  "data",
  "domain",
  "endpoint",
  "exec",
  "file",
  "header",
  "host",
  "input",
  "module",
  "out",
  "plugin",
  "proxy",
  "request",
  "secret",
  "server",
  "token",
  "url",
  "uri",
];
const forbiddenInvocationVerbParts = new Set([
  "add",
  "archive",
  "ban",
  "cancel",
  "clear",
  "close",
  "complete",
  "create",
  "delete",
  "destroy",
  "dispatch",
  "drop",
  "edit",
  "enable",
  "execute",
  "install",
  "invite",
  "merge",
  "modify",
  "move",
  "patch",
  "post",
  "publish",
  "put",
  "react",
  "remove",
  "rename",
  "reply",
  "run",
  "save",
  "send",
  "set",
  "subscribe",
  "truncate",
  "unsubscribe",
  "update",
  "upload",
  "upsert",
  "write",
]);

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

type CredentialEnvironment = Readonly<Record<string, string>>;

type ProcessOutcome =
  | { readonly kind: "succeeded"; readonly output: Buffer }
  | { readonly kind: "failed"; readonly error: Error };

type FileSaveResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type FileCleanupResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type CleanupResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: AggregateError };

type ActiveRun = {
  readonly controller: AbortController;
  readonly completion: Promise<ExternalToolExecutionResult>;
};

const credentialEnvironmentSchema = z.record(
  z.string()
    .regex(credentialKeyPattern, "資格情報の環境変数名が不正です。")
    .refine(isSafeCredentialEnvironmentName, "危険な資格情報の環境変数名は使用できません。"),
  z.string()
    .min(1, "資格情報を空にできません。")
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maximumCredentialValueBytes,
      "資格情報が長すぎます。",
    )
    .refine(
      (value) => !hasControlCharacter(value),
      "資格情報に制御文字を指定できません。",
    ),
);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (
      codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
    );
  });
}

function isSafeCredentialEnvironmentName(value: string): boolean {
  const normalized = value.toUpperCase();
  if (safeParentEnvironmentNames.has(normalized) || forbiddenCredentialEnvironmentNames.has(normalized)) {
    return false;
  }
  return !forbiddenCredentialEnvironmentPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function isCurrentUser(stats: Stats): boolean {
  if (process.platform === "win32") {
    return true;
  }
  if (typeof process.getuid !== "function") {
    return false;
  }
  return stats.uid === process.getuid();
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (descriptor == null || !("value" in descriptor)) {
    return undefined;
  }
  return typeof descriptor.value === "string" ? descriptor.value : undefined;
}

function isNoEntryError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
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

function isJsonContainer(value: unknown): value is object {
  return typeof value === "object" && value != null;
}

function jsonDepth(value: unknown, depth: number, maximumDepth: number): number {
  type Frame = {
    readonly value: unknown;
    readonly depth: number;
  };
  const stack: Frame[] = [{ value, depth }];
  let deepest = depth;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      throw new Error("JSON深度検証のスタックが不正です。");
    }
    deepest = Math.max(deepest, frame.depth);
    if (frame.depth > maximumDepth) {
      return deepest;
    }
    if (!isJsonContainer(frame.value)) {
      continue;
    }
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item, depth: frame.depth + 1 });
      }
      continue;
    }
    for (const item of Object.values(frame.value)) {
      stack.push({ value: item, depth: frame.depth + 1 });
    }
  }
  return deepest;
}

function isParsedJsonValue(value: unknown): value is JsonValue {
  type Frame = { readonly value: unknown };
  const stack: Frame[] = [{ value }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      throw new Error("JSON値検証のスタックが不正です。");
    }
    if (frame.value === null || typeof frame.value === "string" || typeof frame.value === "boolean") {
      continue;
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        return false;
      }
      continue;
    }
    if (typeof frame.value !== "object") {
      return false;
    }
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item });
      }
      continue;
    }
    const prototype = Reflect.getPrototypeOf(frame.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const item of Object.values(frame.value)) {
      stack.push({ value: item });
    }
  }
  return true;
}

function createCapability(): string {
  return randomBytes(32).toString("hex");
}

function createEndpoint(tmpDirectoryPath: string): string {
  const suffix = randomBytes(12).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\taskhub-contextctl-${suffix}`;
  }
  return join(tmpDirectoryPath, `contextctl-${suffix}.sock`);
}

function lstatWithoutSymlink(directoryPath: string): Stats {
  const normalizedPath = resolve(directoryPath);
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  let currentStats = lstatSync(rootPath);
  const parts = relative(rootPath, normalizedPath)
    .split(sep)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    currentPath = join(currentPath, part);
    currentStats = lstatSync(currentPath);
    if (currentStats.isSymbolicLink()) {
      throw new ExternalToolError(
        "ipc_unavailable",
        "外部ツールIPC用ディレクトリにシンボリックリンクを指定できません。",
        false,
      );
    }
  }
  return currentStats;
}

function isWindowsPipe(endpoint: string): boolean {
  return /^\\\\\.\\pipe\\taskhub-contextctl-[0-9a-f]{24}$/u.test(endpoint);
}

function ensureIpcDirectory(directoryPath: string): void {
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(directoryPath);
  } catch (error) {
    if (error instanceof ExternalToolError) {
      throw error;
    }
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツールIPC用ディレクトリを確認できません。",
      false,
      error,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツールIPC用ディレクトリが不正です。",
      false,
    );
  }
  if (!isCurrentUser(stats)) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツールIPC用ディレクトリの所有者が不正です。",
      false,
    );
  }
  try {
    chmodSync(directoryPath, directoryMode);
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツールIPC用ディレクトリの権限を設定できません。",
      false,
      error,
    );
  }
  if (process.platform !== "win32") {
    const securedStats = lstatSync(directoryPath);
    if ((securedStats.mode & 0o777) !== directoryMode || !isCurrentUser(securedStats)) {
      throw new ExternalToolError(
        "permission_denied",
        "外部ツールIPC用ディレクトリの権限を固定できません。",
        false,
      );
    }
  }
}

function verifyChildWorkingDirectory(directoryPath: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(directoryPath);
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリを確認できません。",
      false,
      error,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリが不正です。",
      false,
    );
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== childWorkingDirectoryMode) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリの権限が不正です。",
      false,
    );
  }
  if (!isCurrentUser(stats)) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリの所有者が不正です。",
      false,
    );
  }
  let entries: string[];
  try {
    entries = readdirSync(directoryPath);
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリの内容を確認できません。",
      false,
      error,
    );
  }
  if (entries.length !== 0) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリは空でなければなりません。",
      false,
    );
  }
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  const firstToSecond = relative(first, second);
  const secondToFirst = relative(second, first);
  const isContained = (candidate: string): boolean =>
    candidate.length === 0
    || (candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
  return isContained(firstToSecond) || isContained(secondToFirst);
}

function ensureChildWorkingRoot(
  childWorkingRootPath: string,
  tmpDirectoryPath: string,
): void {
  const normalizedRoot = resolve(childWorkingRootPath);
  if (
    normalizedRoot === parse(normalizedRoot).root
    || pathsOverlap(childWorkingRootPath, tmpDirectoryPath)
  ) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ルートが専用ディレクトリではありません。",
      false,
    );
  }
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(childWorkingRootPath);
  } catch (error) {
    if (error instanceof ExternalToolError) {
      throw error;
    }
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ルートを確認できません。",
      false,
      error,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ルートが不正です。",
      false,
    );
  }
  try {
    chmodSync(childWorkingRootPath, directoryMode);
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ルートの権限を設定できません。",
      false,
      error,
    );
  }
  const securedStats = lstatSync(childWorkingRootPath);
  if (
    securedStats.isSymbolicLink()
    || !securedStats.isDirectory()
    || (process.platform !== "win32" && (securedStats.mode & 0o777) !== directoryMode)
    || !isCurrentUser(securedStats)
  ) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ルートを安全に検証できません。",
      false,
    );
  }
}

function createChildWorkingDirectory(childWorkingRootPath: string): string {
  let parentStats: Stats;
  try {
    parentStats = lstatWithoutSymlink(childWorkingRootPath);
  } catch (error) {
    if (error instanceof ExternalToolError) {
      throw error;
    }
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリの親を確認できません。",
      false,
      error,
    );
  }
  if (!parentStats.isDirectory()) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリの親が不正です。",
      false,
    );
  }
  if (
    (process.platform !== "win32" && (parentStats.mode & 0o777) !== directoryMode)
    || !isCurrentUser(parentStats)
  ) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ルートの権限が不正です。",
      false,
    );
  }
  let childDirectoryPath: string;
  try {
    childDirectoryPath = mkdtempSync(join(childWorkingRootPath, ".contextctl-child-"));
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリを作成できません。",
      false,
      error,
    );
  }
  try {
    chmodSync(childDirectoryPath, childWorkingDirectoryMode);
    verifyChildWorkingDirectory(childDirectoryPath);
    return childDirectoryPath;
  } catch (error) {
    let cleanupError: unknown;
    try {
      rmdirSync(childDirectoryPath);
    } catch (caughtError) {
      cleanupError = caughtError;
    }
    if (cleanupError != null) {
      throw new ExternalToolError(
        "permission_denied",
        "外部ツール作業ディレクトリの作成と後処理に失敗しました。",
        false,
        new AggregateError([error, cleanupError], "外部ツール作業ディレクトリの作成に失敗しました。", {
          cause: error,
        }),
      );
    }
    throw error;
  }
}

function removeChildWorkingDirectory(directoryPath: string): void {
  verifyChildWorkingDirectory(directoryPath);
  try {
    rmdirSync(directoryPath);
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール作業ディレクトリを削除できません。",
      false,
      error,
    );
  }
}

function ensureConnectionInfoAbsent(connectionInfoPath: string): void {
  try {
    const stats = lstatSync(connectionInfoPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new ExternalToolError(
        "ipc_unavailable",
        "外部ツール接続情報が想定外のファイルです。",
        false,
      );
    }
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報が既に存在します。",
      false,
    );
  } catch (error) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
}

function secureUnixSocket(endpoint: string): void {
  if (process.platform === "win32") {
    return;
  }
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(endpoint);
  } catch (error) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツールIPCソケットを確認できません。",
      false,
      error,
    );
  }
  if (!stats.isSocket() || !isCurrentUser(stats)) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツールIPC接続先が想定外のファイルです。",
      false,
    );
  }
  try {
    chmodSync(endpoint, unixSocketMode);
  } catch (error) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツールIPCソケットの権限を設定できません。",
      false,
      error,
    );
  }
  const securedStats = lstatSync(endpoint);
  if (
    !securedStats.isSocket()
    || (securedStats.mode & 0o777) !== unixSocketMode
    || !isCurrentUser(securedStats)
  ) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツールIPCソケットの権限を固定できません。",
      false,
    );
  }
}

function writeConnectionInfoAtomically(
  connectionInfoPath: string,
  connectionInfo: ConnectionInfo,
): void {
  const temporaryPath = `${connectionInfoPath}.${randomUUID()}.tmp`;
  const serialized = JSON.stringify(
    externalToolConnectionInfoSchema.parse(connectionInfo),
  );
  if (serialized == null) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報をJSON化できません。",
      false,
    );
  }
  let writeResult: FileSaveResult = { kind: "succeeded" };
  try {
    writeFileSync(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: connectionInfoMode,
    });
    renameSync(temporaryPath, connectionInfoPath);
    const stats = lstatWithoutSymlink(connectionInfoPath);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || (process.platform !== "win32" && (stats.mode & 0o777) !== connectionInfoMode)
      || !isCurrentUser(stats)
    ) {
      throw new ExternalToolError(
        "permission_denied",
        "外部ツール接続情報の権限を検証できません。",
        false,
      );
    }
  } catch (error) {
    writeResult = { kind: "failed", error };
  }
  if (writeResult.kind === "failed") {
    let cleanupResult: FileCleanupResult = { kind: "succeeded" };
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isNoEntryError(error)) {
        cleanupResult = { kind: "failed", error };
      }
    }
    if (cleanupResult.kind === "failed") {
      throw new ExternalToolError(
        "ipc_unavailable",
        "外部ツール接続情報の保存と後処理に失敗しました。",
        false,
        new AggregateError([writeResult.error, cleanupResult.error], "外部ツール接続情報の保存に失敗しました。", {
          cause: writeResult.error,
        }),
      );
    }
    throw writeResult.error;
  }
}

function readConnectionInfo(connectionInfoPath: string): ConnectionInfo {
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(connectionInfoPath);
  } catch (error) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報を確認できません。",
      false,
      error,
    );
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || (process.platform !== "win32" && (stats.mode & 0o777) !== connectionInfoMode)
    || !isCurrentUser(stats)
  ) {
    throw new ExternalToolError(
      "permission_denied",
      "外部ツール接続情報の権限を確認できません。",
      false,
    );
  }
  let raw: string;
  try {
    raw = readFileSync(connectionInfoPath, "utf8");
  } catch (error) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報を読み取れません。",
      false,
      error,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報のJSONが不正です。",
      false,
      error,
    );
  }
  return externalToolConnectionInfoSchema.parse(parsed);
}

function removeConnectionInfo(
  connectionInfoPath: string,
  expected: ConnectionInfo,
): void {
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(connectionInfoPath);
  } catch (error) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || (process.platform !== "win32" && (stats.mode & 0o777) !== connectionInfoMode)
    || !isCurrentUser(stats)
  ) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報が想定外のファイルです。",
      false,
    );
  }
  if (stats.size > externalToolMaxRequestBytes) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報がサイズ上限を超えています。",
      false,
    );
  }
  const current = readConnectionInfo(connectionInfoPath);
  if (
    current.endpoint !== expected.endpoint
    || current.capability !== expected.capability
  ) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツール接続情報の所有権を確認できません。",
      false,
    );
  }
  unlinkSync(connectionInfoPath);
}

function removeUnixSocket(endpoint: string | undefined): void {
  if (endpoint == null || process.platform === "win32") {
    return;
  }
  let stats: Stats;
  try {
    stats = lstatWithoutSymlink(endpoint);
  } catch (error) {
    if (isNoEntryError(error)) {
      return;
    }
    throw error;
  }
  if (!stats.isSocket() || !isCurrentUser(stats)) {
    throw new ExternalToolError(
      "ipc_unavailable",
      "外部ツールIPC接続先が想定外のファイルです。",
      false,
    );
  }
  unlinkSync(endpoint);
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function hasParentPathSegment(value: string): boolean {
  return value.split(/[\\/]/u).some((part) => part === "..");
}

function isFileUrl(value: string): boolean {
  return /\bfile:/iu.test(value);
}

function extractHttpUrls(value: string): readonly string[] {
  const startIndexes: number[] = [];
  for (const match of value.matchAll(/https?:\/\//giu)) {
    if (match.index == null) {
      throw new Error("外部URLの位置を取得できません。");
    }
    startIndexes.push(match.index);
  }
  const urls: string[] = [];
  for (const [index, start] of startIndexes.entries()) {
    const nextStart = startIndexes[index + 1];
    const end = nextStart == null ? value.length : nextStart;
    const candidate = value.slice(start, end).split(/[\s"'<>]/u)[0];
    if (candidate == null || candidate.length === 0) {
      throw new Error("外部URLを取得できません。");
    }
    urls.push(candidate);
  }
  return urls;
}

function isArgumentFlag(value: string): boolean {
  return value.startsWith("-");
}

function argumentFlagName(value: string): string | undefined {
  if (!value.startsWith("--")) {
    return undefined;
  }
  const separatorIndex = value.indexOf("=");
  if (separatorIndex < 0) {
    return value;
  }
  return value.slice(0, separatorIndex);
}

function containsDangerousArgumentPart(value: string): boolean {
  const normalized = value.toLowerCase();
  if (
    normalized !== "--method"
    && normalized !== "--http-method"
    && normalized.slice(2).split("-").some((part) => {
      if (forbiddenInvocationVerbParts.has(part)) {
        return true;
      }
      return [...forbiddenInvocationVerbParts].some((verb) =>
        part.startsWith(verb) || part.endsWith(verb),
      );
    })
  ) {
    return true;
  }
  if (
    normalized !== "--method"
    && normalized !== "--http-method"
    && normalized.slice(2).split(/[-_=]/u).some((part) => part.startsWith("method"))
  ) {
    return true;
  }
  const parts = normalized.slice(2).split(/[-_=]/u);
  return parts.some((part) => forbiddenArgumentNamePrefixes.some((prefix) =>
    part === prefix || part.startsWith(prefix),
  ));
}

function readHttpMethod(args: readonly string[], index: number): string | undefined {
  const argument = args[index];
  if (argument == null) {
    throw new Error("外部ツール引数の位置が不正です。");
  }
  const normalized = argument.toLowerCase();
  let methodFlag: "--method=" | "--http-method=" | undefined;
  if (normalized.startsWith("--method=")) {
    methodFlag = "--method=";
  } else if (normalized.startsWith("--http-method=")) {
    methodFlag = "--http-method=";
  }
  if (methodFlag != null) {
    const method = argument.slice(methodFlag.length).toUpperCase();
    if (method.length === 0) {
      throw new ExternalToolError(
        "invalid_request",
        "HTTPメソッドが空です。",
        false,
      );
    }
    return method;
  }
  if (normalized === "--method" || normalized === "--http-method") {
    const method = args[index + 1];
    if (method == null || method.length === 0) {
      throw new ExternalToolError(
        "invalid_request",
        "HTTPメソッドが必要です。",
        false,
      );
    }
    return method.toUpperCase();
  }
  return undefined;
}

function isFlagValue(args: readonly string[], index: number): boolean {
  const previous = args[index - 1];
  return previous != null && isArgumentFlag(previous) && !previous.includes("=");
}

function isIndependentWriteVerb(value: string): boolean {
  if (!/^[a-z][a-z0-9._:-]*$/iu.test(value)) {
    return false;
  }
  return value.toLowerCase().split(/[._:-]/u).some((part) => {
    if (forbiddenInvocationVerbParts.has(part)) {
      return true;
    }
    return [...forbiddenInvocationVerbParts].some((verb) =>
      part.startsWith(verb) || part.endsWith(verb),
    );
  });
}

function isReadOnlyHttpMethod(value: string): value is "GET" | "HEAD" | "OPTIONS" {
  return value === "GET" || value === "HEAD" || value === "OPTIONS";
}

function validateInvocationArguments(
  tool: ExternalToolDefinition,
  args: readonly string[],
): void {
  let totalArgumentBytes = 0;
  const allowedArgumentNames = new Set(tool.allowed_argument_names);
  for (const [index, argument] of args.entries()) {
    totalArgumentBytes += new TextEncoder().encode(argument).byteLength;
    if (totalArgumentBytes > externalToolMaxRequestBytes) {
      throw new ExternalToolError(
        "invalid_request",
        "外部ツール要求がサイズ上限を超えました。",
        false,
      );
    }
    if (
      argument.startsWith("@")
      || isAbsolute(argument)
      || isWindowsAbsolutePath(argument)
      || isFileUrl(argument)
      || hasParentPathSegment(argument)
    ) {
      throw new ExternalToolError(
        "invalid_request",
        "外部ツール引数が不正です。",
        false,
      );
    }
    const flagName = argumentFlagName(argument);
    if (isArgumentFlag(argument) && (flagName == null || !allowedArgumentNames.has(flagName))) {
      throw new ExternalToolError(
        "invalid_request",
        "登録されていない外部ツール引数です。",
        false,
      );
    }
    if (flagName != null && containsDangerousArgumentPart(flagName)) {
      throw new ExternalToolError(
        "invalid_request",
        "危険な外部ツール引数です。",
        false,
      );
    }
    const method = readHttpMethod(args, index);
    if (method != null && (
      !isReadOnlyHttpMethod(method)
      || !(tool.allowed_http_methods ?? []).includes(method)
    )) {
      throw new ExternalToolError(
        "forbidden_write_operation",
        "許可されていないHTTPメソッドです。",
        false,
      );
    }
    if (
      !isArgumentFlag(argument)
      && !isFlagValue(args, index)
      && isIndependentWriteVerb(argument)
    ) {
      throw new ExternalToolError(
        "forbidden_write_operation",
        "書き込み操作に見える外部ツール引数は許可されていません。",
        false,
      );
    }
    for (const urlValue of extractHttpUrls(argument)) {
      let parsed: URL;
      try {
        parsed = new URL(urlValue);
      } catch (error) {
        throw new ExternalToolError(
          "forbidden_network",
          "許可されていない外部URLです。",
          false,
          error,
        );
      }
      if (parsed.username.length > 0 || parsed.password.length > 0) {
        throw new ExternalToolError(
          "forbidden_network",
          "URLへ認証情報を指定できません。",
          false,
        );
      }
      const domains = tool.allowed_domains ?? [];
      if (!domains.includes(parsed.hostname.toLowerCase())) {
        throw new ExternalToolError(
          "forbidden_network",
          "許可されていない外部URLです。",
          false,
        );
      }
    }
  }
}

function sanitizeControlCharacters(value: string, preserveLineFeed: boolean): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint == null) {
        return false;
      }
      if (preserveLineFeed && codePoint === 10) {
        return true;
      }
      return !(
        codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      );
    })
    .join("");
}

function sanitizeString(value: string, secrets: readonly string[]): string {
  let sanitized = sanitizeControlCharacters(value, false);
  for (const secret of secrets) {
    if (secret.length > 0) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }
  return sanitized;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function sanitizeJsonValue(value: JsonValue, secrets: readonly string[]): JsonValue {
  type Frame =
    | { readonly kind: "enter"; readonly value: JsonValue }
    | { readonly kind: "exit"; readonly value: JsonValue };
  type Result =
    | { readonly kind: "pending" }
    | { readonly kind: "complete"; readonly value: JsonValue };
  const stack: Frame[] = [{ kind: "enter", value }];
  const transformed = new WeakMap<object, JsonValue>();
  const ancestors = new WeakSet<object>();
  let result: Result = { kind: "pending" };
  const getTransformedValue = (item: JsonValue): JsonValue => {
    if (item !== null && typeof item === "object") {
      const transformedValue = transformed.get(item);
      if (transformedValue == null) {
        throw new Error("外部ツール出力の正規化状態が不正です。");
      }
      return transformedValue;
    }
    if (typeof item === "string") {
      return sanitizeString(item, secrets);
    }
    return item;
  };
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      throw new Error("外部ツール出力の正規化スタックが不正です。");
    }
    if (frame.kind === "enter") {
      if (frame.value === null || typeof frame.value !== "object") {
        result = { kind: "complete", value: getTransformedValue(frame.value) };
        continue;
      }
      if (ancestors.has(frame.value)) {
        throw new ExternalToolError(
          "invalid_output",
          "外部ツール出力に循環参照があります。",
          false,
        );
      }
      ancestors.add(frame.value);
      stack.push({ kind: "exit", value: frame.value });
      if (isJsonArray(frame.value)) {
        for (const item of frame.value) {
          stack.push({ kind: "enter", value: item });
        }
      } else {
        for (const item of Object.values(frame.value)) {
          stack.push({ kind: "enter", value: item });
        }
      }
      continue;
    }
    if (frame.value === null || typeof frame.value !== "object") {
      throw new Error("外部ツール出力の終了状態が不正です。");
    }
    ancestors.delete(frame.value);
    if (isJsonArray(frame.value)) {
      const items = frame.value.map((item) => getTransformedValue(item));
      transformed.set(frame.value, items);
      if (stack.length === 0) {
        result = { kind: "complete", value: items };
      }
      continue;
    }
    const keys = new Set<string>();
    const entries: Array<[string, JsonValue]> = [];
    for (const [key, item] of Object.entries(frame.value)) {
      const sanitizedKey = sanitizeString(key, secrets);
      if (keys.has(sanitizedKey)) {
        throw new ExternalToolError(
          "invalid_output",
          "外部ツール出力のキーを安全に正規化できません。",
          false,
        );
      }
      keys.add(sanitizedKey);
      entries.push([sanitizedKey, getTransformedValue(item)]);
    }
    const object = Object.fromEntries(entries);
    transformed.set(frame.value, object);
    if (stack.length === 0) {
      result = { kind: "complete", value: object };
    }
  }
  if (result.kind !== "complete") {
    throw new Error("外部ツール出力の正規化結果がありません。");
  }
  return result.value;
}

function parseJsonValue(raw: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ExternalToolError(
      "invalid_output",
      "外部ツール出力のJSONが不正です。",
      false,
      error,
    );
  }
  if (
    jsonDepth(parsed, 0, externalToolMaxJsonDepth) > externalToolMaxJsonDepth
    || !isParsedJsonValue(parsed)
  ) {
    throw new ExternalToolError(
      "invalid_output",
      "外部ツール出力がJSON値として不正です。",
      false,
    );
  }
  return parsed;
}

function parseToolOutput(
  output: Buffer,
  secrets: readonly string[],
): ExternalToolOutput {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new ExternalToolError(
      "invalid_utf8",
      "外部ツール出力をUTF-8として読み取れません。",
      false,
      error,
    );
  }
  const normalized = sanitizeControlCharacters(text, true);
  const trimmed = normalized.trim();
  if (trimmed.length === 0) {
    throw new ExternalToolError(
      "invalid_output",
      "外部ツール出力が空です。",
      false,
    );
  }
  try {
    const parsed = parseJsonValue(trimmed);
    const sanitized = sanitizeJsonValue(parsed, secrets);
    return {
      format: "json",
      value: sanitized,
    };
  } catch (error) {
    if (!(error instanceof ExternalToolError) || error.code !== "invalid_output") {
      throw error;
    }
    const lines = normalized
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0 || lines.length > externalToolMaxOutputRecords) {
      throw new ExternalToolError(
        "invalid_output",
        "外部ツール出力がJSONLとして不正です。",
        false,
        error,
      );
    }
    const values = lines.map((line) => sanitizeJsonValue(
      parseJsonValue(line),
      secrets,
    ));
    return {
      format: "jsonl",
      values,
    };
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
    tool_not_found: "外部ツール実行ファイルが見つかりません。",
    tool_execution_failed: "外部ツールの実行に失敗しました。",
    execution_timeout: "外部ツールの実行時間が上限を超えました。",
    output_too_large: "外部ツール出力がサイズ上限を超えました。",
    invalid_output: "外部ツール出力が不正です。",
    invalid_utf8: "外部ツール出力の文字コードが不正です。",
    credential_unavailable: "外部ツール資格情報を利用できません。",
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

function classifyProcessError(error: unknown): ExternalToolError {
  const code = errorCode(error);
  if (code === "ENOENT") {
    return new ExternalToolError(
      "tool_not_found",
      "外部ツール実行ファイルが見つかりません。",
      false,
      error,
    );
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ExternalToolError(
      "tool_execution_failed",
      "外部ツールを実行できません。",
      false,
      error,
    );
  }
  return new ExternalToolError(
    "tool_execution_failed",
    "外部ツールの実行に失敗しました。",
    code == null || transientProcessErrorCodes.has(code),
    error,
  );
}

function runChildProcess(
  tool: ExternalToolDefinition,
  invocation: ExternalToolInvocation,
  credentials: CredentialEnvironment,
  tmpDirectoryPath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  throwIfAborted(signal);
  const environment: Record<string, string> = {};
  for (const name of safeParentEnvironmentNames) {
    const value = process.env[name];
    if (value != null) {
      environment[name] = value;
    }
  }
  for (const [key, value] of Object.entries(credentials)) {
    environment[key] = value;
  }
  const argv = [invocation.subcommand, ...invocation.args];
  const workingDirectory = createChildWorkingDirectory(
    tmpDirectoryPath,
  );
  let child: ChildProcess;
  try {
    child = spawn(tool.executable, argv, {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
      cwd: workingDirectory,
      windowsHide: true,
    });
  } catch (error) {
    try {
      removeChildWorkingDirectory(workingDirectory);
    } catch (cleanupError) {
      throw new ExternalToolError(
        "tool_execution_failed",
        "外部ツールの起動と作業ディレクトリの後処理に失敗しました。",
        false,
        new AggregateError([error, cleanupError], "外部ツールの起動に失敗しました。", {
          cause: error,
        }),
      );
    }
    throw classifyProcessError(error);
  }
  const stdout = child.stdout;
  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    type ProcessLifecycle =
      | { readonly kind: "starting" }
      | { readonly kind: "running"; readonly timeout: NodeJS.Timeout }
      | {
        readonly kind: "terminating";
        readonly error: Error;
        readonly timeout: NodeJS.Timeout;
        readonly graceTimeout: NodeJS.Timeout;
      }
      | { readonly kind: "finished" };
    const lifecycle: { current: ProcessLifecycle } = {
      current: { kind: "starting" },
    };
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const finish = (outcome: ProcessOutcome): void => {
      const current = lifecycle.current;
      if (current.kind === "finished") {
        return;
      }
      if (current.kind === "starting") {
        throw new Error("外部ツールプロセスの状態が開始前です。");
      }
      clearTimeout(current.timeout);
      if (current.kind === "terminating") {
        clearTimeout(current.graceTimeout);
      }
      let cleanupError: unknown;
      try {
        removeChildWorkingDirectory(workingDirectory);
      } catch (error) {
        cleanupError = error;
      }
      let finalOutcome = outcome;
      if (cleanupError != null) {
        if (outcome.kind === "failed") {
          finalOutcome = {
            kind: "failed",
            error: new ExternalToolError(
              "tool_execution_failed",
              "外部ツール実行と作業ディレクトリの後処理に失敗しました。",
              false,
              new AggregateError([outcome.error, cleanupError], "外部ツール実行に失敗しました。", {
                cause: outcome.error,
              }),
            ),
          };
        } else {
          finalOutcome = {
            kind: "failed",
            error: new ExternalToolError(
              "tool_execution_failed",
              "外部ツール作業ディレクトリの後処理に失敗しました。",
              false,
              cleanupError,
            ),
          };
        }
      }
      lifecycle.current = { kind: "finished" };
      signal.removeEventListener("abort", onAbort);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      if (stdout != null) {
        stdout.removeListener("data", onData);
        stdout.removeListener("error", onError);
      }
      if (finalOutcome.kind === "succeeded") {
        resolvePromise(finalOutcome.output);
      } else {
        rejectPromise(finalOutcome.error);
      }
    };
    const requestTermination = (error: Error): void => {
      const current = lifecycle.current;
      if (current.kind === "finished" || current.kind === "terminating") {
        return;
      }
      if (current.kind === "starting") {
        throw new Error("外部ツールプロセスの状態が開始前です。");
      }
      child.kill("SIGTERM");
      const graceTimeout = setTimeout(() => {
        if (lifecycle.current.kind !== "terminating") {
          return;
        }
        child.kill("SIGKILL");
      }, processTerminationGraceMilliseconds);
      lifecycle.current = {
        kind: "terminating",
        error,
        timeout: current.timeout,
        graceTimeout,
      };
    };
    const onData = (chunk: Buffer): void => {
      if (lifecycle.current.kind !== "running") {
        return;
      }
      totalBytes += chunk.byteLength;
      if (totalBytes > tool.max_output_bytes) {
        requestTermination(new ExternalToolError(
          "output_too_large",
          "外部ツール出力がサイズ上限を超えました。",
          false,
        ));
        return;
      }
      chunks.push(chunk);
    };
    const onError = (error: Error): void => {
      if (lifecycle.current.kind === "terminating") {
        return;
      }
      requestTermination(classifyProcessError(error));
    };
    const onClose = (code: number | null): void => {
      const current = lifecycle.current;
      if (current.kind === "terminating") {
        finish({ kind: "failed", error: current.error });
        return;
      }
      if (current.kind !== "running") {
        return;
      }
      if (code === 0) {
        finish({ kind: "succeeded", output: Buffer.concat(chunks, totalBytes) });
        return;
      }
      finish({
        kind: "failed",
        error: new ExternalToolError(
          "tool_execution_failed",
          "外部ツールが読み取りに失敗しました。",
          true,
        ),
      });
    };
    const onAbort = (): void => {
      requestTermination(createAbortError(signal));
    };
    const timer = setTimeout(() => {
      requestTermination(new ExternalToolError(
        "execution_timeout",
        "外部ツールの実行時間が上限を超えました。",
        false,
      ));
    }, tool.timeout_ms);
    lifecycle.current = { kind: "running", timeout: timer };
    child.once("error", onError);
    child.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    if (stdout != null) {
      stdout.on("data", onData);
      stdout.once("error", onError);
    } else {
      requestTermination(new ExternalToolError(
        "tool_execution_failed",
        "外部ツールの標準出力を取得できません。",
        false,
      ));
    }
    if (signal.aborted) {
      onAbort();
    }
  });
}

function isRetryableExternalToolError(error: unknown): error is ExternalToolError {
  return error instanceof ExternalToolError && error.retryable;
}

async function runWithRetries(
  tool: ExternalToolDefinition,
  invocation: ExternalToolInvocation,
  credentials: CredentialEnvironment,
  childWorkingRootPath: string,
  signal: AbortSignal,
): Promise<Buffer> {
  let retryCount = 0;
  while (true) {
    throwIfAborted(signal);
    try {
      return await runChildProcess(
        tool,
        invocation,
        credentials,
        childWorkingRootPath,
        signal,
      );
    } catch (error) {
      if (!isRetryableExternalToolError(error) || retryCount >= externalToolMaximumRetries) {
        throw error;
      }
      retryCount += 1;
    }
  }
}

function validateCredentials(value: Readonly<Record<string, string>>): CredentialEnvironment {
  return credentialEnvironmentSchema.parse(value);
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
  return process.platform === "win32"
    || process.platform === "linux"
    || process.platform === "darwin"
    || process.platform === "freebsd"
    || process.platform === "openbsd"
    || process.platform === "sunos"
    || process.platform === "aix";
}

/** 読み取り専用外部ツールを実行するメインプロセス内ブローカーです。 */
export class ExternalToolBroker {
  private readonly tmpDirectoryPath: string;
  private readonly childWorkingRootPath: string;
  private readonly registry: ExternalToolBrokerOptions["registry"];
  private readonly credentialProvider: ExternalToolCredentialProvider | undefined;
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
    this.tmpDirectoryPath = validatedOptions.tmp_directory_path;
    this.childWorkingRootPath = validatedOptions.child_work_root_path;
    this.registry = validatedOptions.registry;
    this.credentialProvider = validatedOptions.credential_provider;
    this.connectionInfoPath = join(this.tmpDirectoryPath, "contextctl-connection.json");
    if (isBrokerSupportedPlatform()) {
      ensureChildWorkingRoot(this.childWorkingRootPath, this.tmpDirectoryPath);
    }
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
      ensureIpcDirectory(this.tmpDirectoryPath);
      ensureConnectionInfoAbsent(this.connectionInfoPath);
      const endpoint = externalToolConnectionInfoSchema.shape.endpoint.parse(
        createEndpoint(this.tmpDirectoryPath),
      );
      if (process.platform === "win32" && !isWindowsPipe(endpoint)) {
        throw new ExternalToolError(
          "ipc_unavailable",
          "外部ツールIPC接続先が不正です。",
          false,
        );
      }
      if (!isWindowsPipe(endpoint) && Buffer.byteLength(endpoint, "utf8") >= 108) {
        throw new ExternalToolError(
          "ipc_unavailable",
          "外部ツールIPC接続先が長すぎます。",
          false,
        );
      }
      const connectionInfo = externalToolConnectionInfoSchema.parse({
        version: externalToolProtocolVersion,
        endpoint,
        capability: createCapability(),
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
      const listenPromise = this.listen(server, endpoint, startController.signal);
      this.startListenPromise = listenPromise;
      await listenPromise;
      this.startListenPromise = undefined;
      throwIfAborted(signal);
      if (this.stopRequested) {
        throw createBrokerStoppedError();
      }
      secureUnixSocket(endpoint);
      if (this.stopRequested) {
        throw createBrokerStoppedError();
      }
      writeConnectionInfoAtomically(this.connectionInfoPath, connectionInfo);
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
    if (!tool.allowed_subcommands.includes(validatedInvocation.subcommand)) {
      throw new ExternalToolError(
        "forbidden_subcommand",
        "許可されていないサブコマンドです。",
        false,
      );
    }
    validateInvocationArguments(tool, validatedInvocation.args);
    const runController = new AbortController();
    const runSignal = AbortSignal.any([signal, runController.signal]);
    const completion = this.executeRun(
      tool,
      validatedInvocation,
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
    runController: AbortController,
    runSignal: AbortSignal,
  ): Promise<ExternalToolExecutionResult> {
    try {
      let credentials: CredentialEnvironment = {};
      if (this.credentialProvider != null) {
        try {
          credentials = validateCredentials(
            await this.credentialProvider(tool, runSignal),
          );
        } catch (error) {
          if (runSignal.aborted) {
            throw createAbortError(runSignal);
          }
          if (error instanceof ExternalToolError) {
            throw error;
          }
          throw new ExternalToolError(
            "credential_unavailable",
            "外部ツール資格情報を利用できません。",
            false,
            error,
          );
        }
      }
      const rawOutput = await runWithRetries(
        tool,
        validatedInvocation,
        credentials,
        this.childWorkingRootPath,
        runSignal,
      );
      const secrets = Object.values(credentials);
      const output = parseToolOutput(rawOutput, secrets);
      return externalToolExecutionResultSchema.parse({
        tool_id: validatedInvocation.tool_id,
        output,
      });
    } finally {
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

  private listen(
    server: Server,
    endpoint: string,
    stopSignal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const removeListeners = (): void => {
        server.removeListener("error", onError);
        server.removeListener("listening", onListening);
        stopSignal.removeEventListener("abort", onAbort);
      };
      const rejectStopped = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeListeners();
        rejectPromise(createBrokerStoppedError());
      };
      const onError = (error: Error): void => {
        if (stopSignal.aborted) {
          rejectStopped();
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        removeListeners();
        rejectPromise(error);
      };
      const onListening = (): void => {
        if (stopSignal.aborted) {
          onAbort();
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        removeListeners();
        resolvePromise();
      };
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        const onClosed = (error?: Error): void => {
          if (error != null && errorCode(error) !== "ERR_SERVER_NOT_RUNNING") {
            if (settled) {
              return;
            }
            settled = true;
            removeListeners();
            rejectPromise(error);
            return;
          }
          rejectStopped();
        };
        try {
          server.close(onClosed);
        } catch (error) {
          if (settled) {
            return;
          }
          settled = true;
          removeListeners();
          rejectPromise(error instanceof Error
            ? error
            : new Error("外部ツールIPCサーバーの停止に失敗しました。", { cause: error }));
        }
      };
      server.once("error", onError);
      server.once("listening", onListening);
      stopSignal.addEventListener("abort", onAbort, { once: true });
      try {
        server.listen({
          path: endpoint,
          readableAll: false,
          writableAll: false,
        });
      } catch (error) {
        if (stopSignal.aborted) {
          rejectStopped();
          return;
        }
        if (settled) {
          return;
        }
        settled = true;
        removeListeners();
        rejectPromise(error instanceof Error
          ? error
          : new Error("外部ツールIPCサーバーの起動に失敗しました。", { cause: error }));
        return;
      }
      if (stopSignal.aborted) {
        onAbort();
      }
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
        removeConnectionInfo(this.connectionInfoPath, connectionInfo);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      removeUnixSocket(this.endpoint);
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
