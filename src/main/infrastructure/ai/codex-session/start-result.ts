import { z } from "zod";
import { CodexSessionStateError } from "./errors";

type StartResultOptions<Result> = {
  readonly resultSchema: z.ZodType<Result>;
  readonly assertSafetyIntact: () => void;
  readonly taskctlStartResult: { readonly connectionInfoPath: string } | undefined;
  readonly workspacePath: string;
  readonly agentsFilePath: string;
};

type ReadyStartResultOptions<Result> = StartResultOptions<Result> & {
  readonly threadId: string | undefined;
  readonly requireSelectedModel: () => string;
  readonly structuredOutputVerified: boolean;
};

/** 認証済みCodexセッションの開始結果を作成します。 */
export function createReadyCodexStartResult<Result>(options: ReadyStartResultOptions<Result>): Result {
  options.assertSafetyIntact();
  const threadId = options.threadId;
  const taskctlStartResult = options.taskctlStartResult;
  if (threadId == null || taskctlStartResult == null) {
    throw new CodexSessionStateError();
  }
  return options.resultSchema.parse({
    state: "ready",
    threadId,
    model: options.requireSelectedModel(),
    workspacePath: options.workspacePath,
    agentsFilePath: options.agentsFilePath,
    taskctlConnectionInfoPath: taskctlStartResult.connectionInfoPath,
    capabilities: {
      authentication: "chatgpt",
      structuredOutput: options.structuredOutputVerified ? "verified" : "unverified",
      instructionSources: true,
      skills: true,
    },
  });
}

/** 認証待ちCodexセッションの開始結果を作成します。 */
export function createAuthenticationRequiredCodexStartResult<Result>(options: StartResultOptions<Result>): Result {
  options.assertSafetyIntact();
  const taskctlStartResult = options.taskctlStartResult;
  if (taskctlStartResult == null) {
    throw new CodexSessionStateError();
  }
  return options.resultSchema.parse({
    state: "authentication_required",
    workspacePath: options.workspacePath,
    agentsFilePath: options.agentsFilePath,
    taskctlConnectionInfoPath: taskctlStartResult.connectionInfoPath,
    capabilities: {
      authentication: "required",
      structuredOutput: "unverified",
      instructionSources: false,
      skills: false,
    },
  });
}
