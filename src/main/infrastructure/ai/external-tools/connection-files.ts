import { randomBytes, randomUUID } from "node:crypto";
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

const directoryMode = 0o700;
const connectionInfoMode = 0o600;
const unixSocketMode = 0o600;

type ConnectionInfo = {
  readonly version: number;
  readonly endpoint: string;
  readonly capability: string;
};

type FileSaveResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type FileCleanupResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type ConnectionFiles = {
  readonly createCapability: () => string;
  readonly createEndpoint: (tmpDirectoryPath: string) => string;
  readonly ensureIpcDirectory: (directoryPath: string) => void;
  readonly ensureConnectionInfoAbsent: (connectionInfoPath: string) => void;
  readonly secureUnixSocket: (endpoint: string) => void;
  readonly writeConnectionInfoAtomically: (
    connectionInfoPath: string,
    connectionInfo: ConnectionInfo,
  ) => void;
  readonly removeConnectionInfo: (
    connectionInfoPath: string,
    expected: ConnectionInfo,
  ) => void;
  readonly removeUnixSocket: (endpoint: string | undefined) => void;
};

/** 外部ツールで使うNodeエラーのcodeを取得します。 */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(error, "code");
  if (descriptor == null || !("value" in descriptor)) {
    return undefined;
  }
  return typeof descriptor.value === "string" ? descriptor.value : undefined;
}

/** 外部ツールの接続情報とUnixソケットの所有権を検証して管理します。 */
export function createExternalToolConnectionFiles(
  errorType: new (
    code: "ipc_unavailable" | "permission_denied",
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) => Error,
  parseConnectionInfo: (value: unknown) => ConnectionInfo,
  maxRequestBytes: number,
): ConnectionFiles {
  function isCurrentUser(stats: Stats): boolean {
    if (process.platform === "win32") {
      return false;
    }
    if (typeof process.getuid !== "function") {
      return false;
    }
    return stats.uid === process.getuid();
  }

  function isNoEntryError(error: unknown): boolean {
    return errorCode(error) === "ENOENT";
  }

  function createCapability(): string {
    return randomBytes(32).toString("hex");
  }

  function createEndpoint(tmpDirectoryPath: string): string {
    const suffix = randomBytes(12).toString("hex");
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
        throw new errorType(
          "ipc_unavailable",
          "外部ツールIPC用ディレクトリにシンボリックリンクを指定できません。",
          false,
        );
      }
    }
    return currentStats;
  }

  function ensureIpcDirectory(directoryPath: string): void {
    let stats: Stats;
    try {
      stats = lstatWithoutSymlink(directoryPath);
    } catch (error) {
      if (error instanceof errorType) {
        throw error;
      }
      throw new errorType(
        "ipc_unavailable",
        "外部ツールIPC用ディレクトリを確認できません。",
        false,
        error,
      );
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new errorType(
        "ipc_unavailable",
        "外部ツールIPC用ディレクトリが不正です。",
        false,
      );
    }
    if (!isCurrentUser(stats)) {
      throw new errorType(
        "permission_denied",
        "外部ツールIPC用ディレクトリの所有者が不正です。",
        false,
      );
    }
    try {
      chmodSync(directoryPath, directoryMode);
    } catch (error) {
      throw new errorType(
        "permission_denied",
        "外部ツールIPC用ディレクトリの権限を設定できません。",
        false,
        error,
      );
    }
    if (process.platform !== "win32") {
      const securedStats = lstatSync(directoryPath);
      if ((securedStats.mode & 0o777) !== directoryMode || !isCurrentUser(securedStats)) {
        throw new errorType(
          "permission_denied",
          "外部ツールIPC用ディレクトリの権限を固定できません。",
          false,
        );
      }
    }
  }

  function ensureConnectionInfoAbsent(connectionInfoPath: string): void {
    try {
      const stats = lstatSync(connectionInfoPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new errorType(
          "ipc_unavailable",
          "外部ツール接続情報が想定外のファイルです。",
          false,
        );
      }
      throw new errorType(
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
    let stats: Stats;
    try {
      stats = lstatWithoutSymlink(endpoint);
    } catch (error) {
      throw new errorType(
        "ipc_unavailable",
        "外部ツールIPCソケットを確認できません。",
        false,
        error,
      );
    }
    if (!stats.isSocket() || !isCurrentUser(stats)) {
      throw new errorType(
        "ipc_unavailable",
        "外部ツールIPC接続先が想定外のファイルです。",
        false,
      );
    }
    try {
      chmodSync(endpoint, unixSocketMode);
    } catch (error) {
      throw new errorType(
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
      throw new errorType(
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
      parseConnectionInfo(connectionInfo),
    );
    if (serialized == null) {
      throw new errorType(
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
        throw new errorType(
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
        throw new errorType(
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
      throw new errorType(
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
      throw new errorType(
        "permission_denied",
        "外部ツール接続情報の権限を確認できません。",
        false,
      );
    }
    let raw: string;
    try {
      raw = readFileSync(connectionInfoPath, "utf8");
    } catch (error) {
      throw new errorType(
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
      throw new errorType(
        "ipc_unavailable",
        "外部ツール接続情報のJSONが不正です。",
        false,
        error,
      );
    }
    return parseConnectionInfo(parsed);
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
      throw new errorType(
        "ipc_unavailable",
        "外部ツール接続情報が想定外のファイルです。",
        false,
      );
    }
    if (stats.size > maxRequestBytes) {
      throw new errorType(
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
      throw new errorType(
        "ipc_unavailable",
        "外部ツール接続情報の所有権を確認できません。",
        false,
      );
    }
    unlinkSync(connectionInfoPath);
  }

  function removeUnixSocket(endpoint: string | undefined): void {
    if (endpoint == null) {
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
      throw new errorType(
        "ipc_unavailable",
        "外部ツールIPC接続先が想定外のファイルです。",
        false,
      );
    }
    unlinkSync(endpoint);
  }

  return {
    createCapability,
    createEndpoint,
    ensureIpcDirectory,
    ensureConnectionInfoAbsent,
    secureUnixSocket,
    writeConnectionInfoAtomically,
    removeConnectionInfo,
    removeUnixSocket,
  };
}
