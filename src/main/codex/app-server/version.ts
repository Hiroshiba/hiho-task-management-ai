import { execFile } from "node:child_process";
import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import {
  CodexExecutableNotFoundError,
  CodexRequestAbortedError,
  CodexVersionCommandError,
} from "./errors";

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
]);
const safeEnvironmentKeysByLowerCase = new Map(
  [...safeEnvironmentKeys].map((key) => [key.toLowerCase(), key]),
);
const maxCodexHomePathCodeUnits = 4_096;

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

/** Windowsの公式Codex CLI候補を優先して実行ファイルを解決します。 */
export function resolveCodexExecutable(): string {
  return process.platform === "win32" ? resolveWindowsCodexExecutable() : "codex";
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
  return normalize(candidatePath);
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
