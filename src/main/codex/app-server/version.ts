import { execFile } from "node:child_process";
import { statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexVersionInfoSchema, type CodexVersionInfo } from "./schemas";
import {
  CodexExecutableNotFoundError,
  CodexRequestAbortedError,
  CodexUnsupportedVersionError,
  CodexVersionCommandError,
  CodexVersionFormatError,
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

const versionPattern =
  /^codex-cli (?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;

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

function executeVersionCommand(
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<string> {
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
      (error, stdout) => {
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
        resolve(stdout);
      },
    );
  });
}

function parseVersionOutput(output: string): CodexVersionInfo {
  const normalizedOutput = output.trim();
  const match = versionPattern.exec(normalizedOutput);
  if (match == null) {
    throw new CodexVersionFormatError();
  }

  const majorText = match.groups?.major;
  const minorText = match.groups?.minor;
  const patchText = match.groups?.patch;
  if (majorText == null || minorText == null || patchText == null) {
    throw new CodexVersionFormatError();
  }

  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    throw new CodexVersionFormatError();
  }
  if (major !== 0 || minor !== 150) {
    throw new CodexUnsupportedVersionError(normalizedOutput);
  }

  const version = codexVersionInfoSchema.safeParse({
    raw: normalizedOutput,
    major,
    minor,
    patch,
  });
  if (!version.success) {
    throw new CodexVersionFormatError();
  }
  return version.data;
}

/** 指定した実行ファイルの対応するCodex CLIの版を取得します。 */
export async function getCodexVersionForExecutable(
  executable: string,
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<CodexVersionInfo> {
  const output = await executeVersionCommand(executable, environment, signal);
  return parseVersionOutput(output);
}

/** 対応するCodex CLIの版を取得します。 */
export async function getCodexVersion(signal: AbortSignal): Promise<CodexVersionInfo> {
  const environment = createSafeCodexEnvironment(process.env);
  return getCodexVersionForExecutable(resolveCodexExecutable(), environment, signal);
}
