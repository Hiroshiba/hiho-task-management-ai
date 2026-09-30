import {
  threadStartParamsSchema,
  threadStartResultSchema,
} from "../codex-app-server";
import type { CodexRpcEndpoint } from "../codex-app-server/rpc-endpoint";
import { CodexSessionCapabilityError, CodexSessionStateError, CodexThreadStartCapabilityError } from "./errors";
import { permissionProfileId, validateSandboxPolicy } from "./capability-policy";

type ThreadStartOptions = {
  readonly connection: Pick<CodexRpcEndpoint, "startThread"> | undefined;
  readonly requireSelectedModel: () => string;
  readonly workspacePath: string;
  readonly agentsFilePath: string;
  readonly tmpDirectoryPath: string;
  readonly skillConfiguration: readonly { path: string; enabled: boolean }[];
  readonly dynamicTools: readonly Record<string, unknown>[];
  readonly isThreadConfigurationChanged: () => boolean;
  readonly clearThreadSettingsNotification: () => void;
  readonly setThreadId: (threadId: string) => void;
  readonly validateStoredThreadSettingsNotification: (threadId: string) => void;
  readonly assertSafetyIntact: () => void;
};

function createThreadConfiguration(skillConfiguration: readonly { path: string; enabled: boolean }[]): Record<string, unknown> {
  return {
    ...(process.platform === "win32" ? {} : { default_permissions: permissionProfileId }),
    features: { apps: false, plugins: false },
    web_search: "disabled",
    tools: { web_search: false },
    skills: { config: skillConfiguration },
  };
}

/** Codexスレッドを開始して権限と設定を検証します。 */
export async function startCodexSessionThread(options: ThreadStartOptions, signal: AbortSignal): Promise<void> {
  const connection = options.connection;
  if (connection == null) {
    throw new CodexSessionStateError();
  }
  if (options.isThreadConfigurationChanged()) {
    throw new CodexSessionCapabilityError("Codexスレッド構成が変更されたためAIを開始できません。");
  }
  const expectedModel = options.requireSelectedModel();
  const config = createThreadConfiguration(options.skillConfiguration);
  const params = {
    model: expectedModel,
    cwd: options.workspacePath,
    approvalPolicy: "never",
    ...(process.platform === "win32" ? { sandbox: "workspace-write" } : {}),
    config,
    dynamicTools: options.dynamicTools,
  };
  const validatedParams = threadStartParamsSchema.parse(params);
  options.clearThreadSettingsNotification();
  const result = threadStartResultSchema.parse(
    await connection.startThread(validatedParams, signal),
  );
  if (result.model !== expectedModel) {
    throw new CodexThreadStartCapabilityError("model_mismatch");
  }
  if (result.cwd !== options.workspacePath) {
    throw new CodexThreadStartCapabilityError("cwd_mismatch");
  }
  if (result.approvalPolicy !== "never") {
    throw new CodexThreadStartCapabilityError("approval_policy_mismatch");
  }
  if (!result.instructionSources.includes(options.agentsFilePath)) {
    throw new CodexThreadStartCapabilityError("instruction_source_missing");
  }
  if (result.instructionSources.some((source) => source !== options.agentsFilePath)) {
    throw new CodexThreadStartCapabilityError("instruction_source_unexpected");
  }
  const sandboxValidation = validateSandboxPolicy(
    result.sandbox,
    options.tmpDirectoryPath,
  );
  if (sandboxValidation.kind !== "valid") {
    throw new CodexThreadStartCapabilityError(sandboxValidation.failureCode);
  }
  options.setThreadId(result.thread.id);
  options.validateStoredThreadSettingsNotification(result.thread.id);
  options.assertSafetyIntact();
  if (options.isThreadConfigurationChanged()) {
    throw new CodexSessionCapabilityError("Codexスレッド構成が変更されたためAIを開始できません。");
  }
  options.assertSafetyIntact();
}
