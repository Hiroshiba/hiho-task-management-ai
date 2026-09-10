import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  CodexExecutableNotFoundError,
  CodexRequestAbortedError,
  CodexVersionCommandError,
} from "./errors";
import { taskHubExecutablePathEnvironmentVariable } from "../taskctl";

const safeEnvironmentKeys = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "CODEX_HOME",
  taskHubExecutablePathEnvironmentVariable,
]);
const safeEnvironmentKeysByLowerCase = new Map(
  [...safeEnvironmentKeys].map((key) => [key.toLowerCase(), key]),
);
const maxCodexHomePathCodeUnits = 4_096;

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPathSearchError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EACCES");
}

function resolveWindowsCodexExecutable(): string {
  const candidate = join(
    homedir(),
    "AppData",
    "Local",
    "Programs",
    "OpenAI",
    "Codex",
    "bin",
    "codex.exe",
  );
  let stats: Stats;
  try {
    stats = statSync(candidate);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return "codex";
    }
    throw error;
  }
  if (!stats.isFile()) {
    throw new Error("公式Codex CLI候補は通常ファイルでなければなりません。");
  }
  return candidate;
}

function resolvePosixCodexExecutable(): string {
  const safeEnvironment = createSafeCodexEnvironment(process.env);
  const pathEntries = safeEnvironment.PATH == null
    ? ["/usr/bin", "/bin"]
    : safeEnvironment.PATH.split(delimiter);
  for (const pathEntry of pathEntries) {
    const candidate = resolve(pathEntry.length === 0 ? "." : pathEntry, "codex");
    let stats: Stats;
    try {
      accessSync(candidate, constants.X_OK);
      stats = statSync(candidate);
    } catch (error: unknown) {
      if (isPathSearchError(error)) {
        continue;
      }
      throw error;
    }
    if (!stats.isFile()) {
      continue;
    }
    try {
      return realpathSync.native(candidate);
    } catch (error: unknown) {
      if (isPathSearchError(error)) {
        continue;
      }
      throw error;
    }
  }
  return "codex";
}

/** PATH上のCodex CLIを優先順で検出し、POSIXでは実体パスを返します。 */
export function resolveCodexExecutable(): string {
  return process.platform === "win32"
    ? resolveWindowsCodexExecutable()
    : resolvePosixCodexExecutable();
}

/** Codexへ渡す環境変数を安全なOS由来の許可リストへ絞ります。 */
export function createSafeCodexEnvironment(
  sourceEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const safeEnvironment: NodeJS.ProcessEnv = {};
  const isWindows = process.platform === "win32";
  const seenWindowsKeys = new Set<string>();
  for (const [key, value] of Object.entries(sourceEnvironment)) {
    if (value == null) {
      continue;
    }
    if (!isWindows) {
      if (!safeEnvironmentKeys.has(key)) {
        continue;
      }
      safeEnvironment[key] = value;
      continue;
    }
    const canonicalKey = safeEnvironmentKeysByLowerCase.get(key.toLowerCase());
    if (canonicalKey == null || seenWindowsKeys.has(canonicalKey)) {
      continue;
    }
    safeEnvironment[canonicalKey] = value;
    seenWindowsKeys.add(canonicalKey);
  }
  if (process.platform !== "darwin") {
    return safeEnvironment;
  }
  const pathEntries = safeEnvironment.PATH == null
    ? ["/usr/bin", "/bin"]
    : safeEnvironment.PATH.split(delimiter);
  safeEnvironment.PATH = [
    ...new Set([
      ...pathEntries,
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]),
  ].join(delimiter);
  return safeEnvironment;
}

/** 安全な環境変数からCodexホームの正規化候補を解決します。 */
export function resolveCodexHomePath(
  safeEnvironment: NodeJS.ProcessEnv,
): string {
  const configuredPath = safeEnvironment.CODEX_HOME;
  const candidatePath = configuredPath ?? join(homedir(), ".codex");
  if (
    candidatePath.length === 0
    || candidatePath.length > maxCodexHomePathCodeUnits
    || !isAbsolute(candidatePath)
    || candidatePath.includes("\0")
    || candidatePath.includes("\n")
    || candidatePath.includes("\r")
  ) {
    throw new Error("Codexホームのパスが不正です。");
  }
  return resolve(candidatePath);
}

function executeVersionCommand(
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ["--version"],
      {
        env: environment,
        shell: false,
        signal,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error) => {
        if (error != null) {
          if (signal.aborted) {
            reject(new CodexRequestAbortedError("codex --version"));
            return;
          }
          if (error.code === "ENOENT") {
            reject(new CodexExecutableNotFoundError());
            return;
          }
          reject(new CodexVersionCommandError(error));
          return;
        }
        resolve();
      },
    );
  });
}

/** 指定した実行ファイルのCodex CLI実行可否を検査します。 */
export async function checkCodexExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  await executeVersionCommand(executable, environment, signal);
}
