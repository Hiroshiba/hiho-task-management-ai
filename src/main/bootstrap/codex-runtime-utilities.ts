import { z } from "zod";
import { AsanaRequestAbortedError } from "../infrastructure/asana";
import {
  CodexSessionAbortedError,
  TaskctlAbortError,
  createSafeCodexEnvironment,
  taskHubExecutablePathEnvironmentVariable,
  type CodexSessionStartResult,
} from "../infrastructure/ai";

/** AIセッションで発生した中断を原因の連鎖から判定します。 */
export function isAiSessionAbortError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (
      current instanceof AsanaRequestAbortedError
      || current instanceof CodexSessionAbortedError
      || current instanceof TaskctlAbortError
    ) {
      return true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
}

/** Codexに渡す安全なプロセス環境を組み立てます。 */
export function createCodexProcessEnvironment(
  codexHomePath: string,
  taskHubExecutablePath: string,
): Record<string, string> {
  return z.record(z.string(), z.string()).parse({
    ...createSafeCodexEnvironment(process.env),
    CODEX_HOME: codexHomePath,
    [taskHubExecutablePathEnvironmentVariable]: taskHubExecutablePath,
  });
}

/** Codexセッション開始結果が利用可能か判定します。 */
export function isReadyCodexResult(
  result: CodexSessionStartResult | undefined,
): result is Extract<CodexSessionStartResult, { state: "ready" }> {
  return result?.state === "ready";
}
