import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
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
  readonly socketPath: string;
  readonly capability: string;
};

type TaskctlLocalIpcFiles = {
  readonly createSocketPath: (socketDirectoryPath: string) => string;
  readonly assertWindowsPipe: (socketPath: string) => void;
  readonly createLocalIpcListenConfiguration: (
    socketDirectoryPath: string,
  ) => LocalIpcListenConfiguration;
  readonly ensureTemporaryDirectory: (directoryPath: string) => void;
  readonly createSocketDirectory: (tmpDirectoryPath: string) => string;
  readonly secureUnixSocket: (socketPath: string) => void;
  readonly writeConnectionInfoAtomically: (
    connectionInfoPath: string,
    connectionInfo: ConnectionInfo,
  ) => void;
  readonly removeConnectionInfo: (
    connectionInfoPath: string,
    connectionInfo: ConnectionInfo | undefined,
  ) => void;
  readonly removeSocket: (socketPath: string | undefined) => void;
  readonly removeSocketDirectory: (socketDirectoryPath: string | undefined) => void;
};

export type LocalIpcListenConfiguration = {
  readonly boundary:
    | {
      readonly kind: "windows_named_pipe";
      readonly access: "current_user";
    }
    | {
      readonly kind: "unix_socket";
      readonly access: "owner_only";
      readonly socketDirectoryPath: string;
    };
  readonly readableAll: false;
  readonly writableAll: false;
};

/** taskctlの接続情報とソケットの所有権を検証して管理します。 */
export function createTaskctlLocalIpcFiles(
  errorType: new (message: string, options?: ErrorOptions) => Error,
  parseConnectionInfo: (value: unknown) => ConnectionInfo,
  maxRequestBytes: number,
): TaskctlLocalIpcFiles {
  function isNoEntryError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }

  function currentUserId(): number | undefined {
    return typeof process.getuid === "function" ? process.getuid() : undefined;
  }

  function assertOwned(stats: Stats, label: string): void {
    const userId = currentUserId();
    if (userId != null && stats.uid !== userId) {
      throw new errorType(`${label}の所有者を確認できません。`);
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
      throw new errorType(`${label}を確認できません。`, { cause: error });
    }
    if (stats.isSymbolicLink()) {
      throw new errorType(`${label}の親にシンボリックリンクを指定できません。`);
    }
    const remainingPath = relative(rootPath, normalizedPath);
    for (const part of remainingPath.split(sep).filter((segment) => segment.length > 0)) {
      currentPath = join(currentPath, part);
      try {
        stats = lstatSync(currentPath);
      } catch (error: unknown) {
        throw new errorType(`${label}を確認できません。`, { cause: error });
      }
      if (stats.isSymbolicLink()) {
        throw new errorType(`${label}の親にシンボリックリンクを指定できません。`);
      }
    }
    return stats;
  }

  function createSocketPath(socketDirectoryPath: string): string {
    const suffix = randomBytes(12).toString("hex");
    if (process.platform === "win32") {
      return `\\\\.\\pipe\\taskhub-taskctl-${suffix}`;
    }
    return join(socketDirectoryPath, `taskctl-${suffix}.sock`);
  }

  function isWindowsPipe(socketPath: string): boolean {
    return /^\\\\\.\\pipe\\taskhub-taskctl-[0-9a-f]{24}$/u.test(socketPath);
  }

  function assertWindowsPipe(socketPath: string): void {
    if (process.platform === "win32" && !isWindowsPipe(socketPath)) {
      throw new errorType("taskctl名前付きパイプの接続先が不正です。");
    }
  }

  function createLocalIpcListenConfiguration(
    socketDirectoryPath: string,
  ): LocalIpcListenConfiguration {
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
        socketDirectoryPath,
      },
      readableAll: false,
      writableAll: false,
    };
  }

  function ensureTemporaryDirectory(directoryPath: string): void {
    const stats = lstatWithoutSymlink(directoryPath, "taskctl一時ディレクトリ");
    if (stats.isSymbolicLink()) {
      throw new errorType("taskctl一時ディレクトリにシンボリックリンクを指定できません。");
    }
    if (!stats.isDirectory()) {
      throw new errorType("taskctl一時ディレクトリはディレクトリでなければなりません。");
    }
    assertOwned(stats, "taskctl一時ディレクトリ");
    chmodSync(directoryPath, directoryMode);
    const securedStats = lstatWithoutSymlink(directoryPath, "taskctl一時ディレクトリ");
    if (
      !securedStats.isDirectory()
      || (process.platform !== "win32" && (securedStats.mode & 0o777) !== directoryMode)
    ) {
      throw new errorType("taskctl一時ディレクトリの権限を固定できません。");
    }
  }

  function createSocketDirectory(tmpDirectoryPath: string): string {
    if (process.platform !== "darwin") {
      return tmpDirectoryPath;
    }
    const macSocketDirectoryPrefix = "/private/tmp/taskhub-taskctl-";
    let directoryPath: string;
    try {
      directoryPath = mkdtempSync(macSocketDirectoryPrefix);
    } catch (error: unknown) {
      throw new errorType(
        "macOSのtaskctlソケット用一時ディレクトリを作成できません。",
        { cause: error },
      );
    }
    try {
      ensureTemporaryDirectory(directoryPath);
      return directoryPath;
    } catch (error: unknown) {
      try {
        rmdirSync(directoryPath);
      } catch (cleanupError: unknown) {
        throw new errorType(
          "macOSのtaskctlソケット用一時ディレクトリの作成後処理に失敗しました。",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
      throw error;
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
      throw new errorType(
        "taskctlソケットを確認できません。",
        { cause: error },
      );
    }
    if (!stats.isSocket()) {
      throw new errorType("taskctlソケットが想定外のファイルです。");
    }
    assertOwned(stats, "taskctlソケット");
    chmodSync(socketPath, unixSocketMode);
    const securedStats = lstatWithoutSymlink(socketPath, "taskctlソケット");
    if (!securedStats.isSocket() || (securedStats.mode & 0o777) !== unixSocketMode) {
      throw new errorType("taskctlソケットの権限を固定できません。");
    }
    assertOwned(securedStats, "taskctlソケット");
  }

  function verifySecureFile(filePath: string, label: string, mode: number): Stats {
    const stats = lstatWithoutSymlink(filePath, label);
    if (!stats.isFile()) {
      throw new errorType(`${label}が想定外のファイルです。`);
    }
    assertOwned(stats, label);
    if (process.platform !== "win32" && (stats.mode & 0o777) !== mode) {
      throw new errorType(`${label}の権限を固定できません。`);
    }
    return stats;
  }

  function writeConnectionInfoAtomically(
    connectionInfoPath: string,
    connectionInfo: ConnectionInfo,
  ): void {
    const temporaryPath = `${connectionInfoPath}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(parseConnectionInfo(connectionInfo));
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
          throw new errorType("既存のtaskctl接続情報が想定外のファイルです。");
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
          throw new errorType(
            "taskctl接続情報の一時ファイルを削除できません。",
            { cause: new AggregateError([error, cleanupError]) },
          );
        }
      }
      throw error;
    }
  }

  function removeConnectionInfo(connectionInfoPath: string, connectionInfo: ConnectionInfo | undefined): void {
    if (connectionInfo == null) {
      return;
    }
    let stats: Stats;
    try {
      stats = lstatSync(connectionInfoPath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new errorType("taskctl接続情報が想定外のファイルです。");
    }
    assertOwned(stats, "taskctl接続情報");
    if (process.platform !== "win32" && (stats.mode & 0o777) !== connectionInfoMode) {
      throw new errorType("taskctl接続情報の権限を確認できません。");
    }
    if (stats.size > maxRequestBytes) {
      throw new errorType("taskctl接続情報がサイズ上限を超えています。");
    }
    const raw = readFileSync(connectionInfoPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new errorType("taskctl接続情報のJSONが不正です。", { cause: error });
    }
    const current = parseConnectionInfo(parsed);
    if (
      current.socketPath !== connectionInfo.socketPath
      || current.capability !== connectionInfo.capability
    ) {
      throw new errorType("taskctl接続情報の所有権を確認できません。");
    }
    unlinkSync(connectionInfoPath);
  }

  function removeSocket(socketPath: string | undefined): void {
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
      throw new errorType("taskctlソケットが想定外のファイルです。");
    }
    assertOwned(stats, "taskctlソケット");
    unlinkSync(socketPath);
  }

  function removeSocketDirectory(socketDirectoryPath: string | undefined): void {
    if (socketDirectoryPath == null) {
      return;
    }
    let stats: Stats;
    try {
      stats = lstatSync(socketDirectoryPath);
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return;
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new errorType("taskctlソケット用一時ディレクトリが想定外です。");
    }
    assertOwned(stats, "taskctlソケット用一時ディレクトリ");
    if ((stats.mode & 0o777) !== directoryMode) {
      throw new errorType("taskctlソケット用一時ディレクトリの権限が不正です。");
    }
    rmdirSync(socketDirectoryPath);
  }

  return {
    createSocketPath,
    assertWindowsPipe,
    createLocalIpcListenConfiguration,
    ensureTemporaryDirectory,
    createSocketDirectory,
    secureUnixSocket,
    writeConnectionInfoAtomically,
    removeConnectionInfo,
    removeSocket,
    removeSocketDirectory,
  };
}
