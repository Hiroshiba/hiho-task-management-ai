import type { CodexConnectionOptions } from "../codex-app-server";
import { createTaskHubConnectionFeatureOverrides, createTaskHubConnectionOverridesFromVerifiedPaths } from "../codex-app-server";
import { CodexSessionCapabilityError } from "./errors";
import {
  isPathWithin,
  resolveVerifiedReadOnlyDirectory,
  resolveCodexHomeCandidate,
  resolveVerifiedConfigurationDirectory,
  validateAdditionalLocalSocketPaths,
} from "./capability-policy";

type ConnectionConfigurationOptions = {
  readonly codexExecutablePath: string;
  readonly workspacePath: string;
  readonly tmpDirectoryPath: string;
  readonly readOnlyVaultPaths: readonly string[];
  readonly additionalLocalSocketPaths: readonly string[];
  readonly validateTaskctlLocalIpc: (tmpDirectoryPath: string) => string;
};

/** 認証領域、IPC、Vaultの境界を検証してCodex設定を作成します。 */
export function createCodexSessionConnectionOverrides(
  expectedCodexHomePath: string,
  options: ConnectionConfigurationOptions,
): CodexConnectionOptions["configOverrides"] {
  const codexHomePath = resolveCodexHomeCandidate(expectedCodexHomePath);
  const realWorkspacePath = resolveVerifiedConfigurationDirectory(
    options.workspacePath,
    "Codex専用ワークスペース",
  );
  const realTmpDirectoryPath = resolveVerifiedConfigurationDirectory(
    options.tmpDirectoryPath,
    "Codex専用ワークスペースのtmp",
  );
  if (
    isPathWithin(realWorkspacePath, codexHomePath)
    || isPathWithin(codexHomePath, realWorkspacePath)
  ) {
    throw new CodexSessionCapabilityError("Codex認証領域と専用ワークスペースの範囲が重なっています。");
  }
  if (process.platform === "win32") {
    options.validateTaskctlLocalIpc(realTmpDirectoryPath);
    validateAdditionalLocalSocketPaths(
      options.additionalLocalSocketPaths,
      realTmpDirectoryPath,
    );
    return createTaskHubConnectionFeatureOverrides();
  }
  const socketPath = options.validateTaskctlLocalIpc(realTmpDirectoryPath);
  const additionalSocketPaths = validateAdditionalLocalSocketPaths(
    options.additionalLocalSocketPaths,
    realTmpDirectoryPath,
  );
  const unixSocketPaths = [socketPath, ...additionalSocketPaths];
  if (new Set(unixSocketPaths).size !== unixSocketPaths.length) {
    throw new CodexSessionCapabilityError("同じローカルIPCを重複して指定できません。");
  }
  const verifiedVaultPaths = options.readOnlyVaultPaths.map(resolveVerifiedReadOnlyDirectory);
  if (new Set(verifiedVaultPaths).size !== verifiedVaultPaths.length) {
    throw new CodexSessionCapabilityError("同じVaultの実体パスを重複して指定できません。");
  }
  for (const vaultPath of verifiedVaultPaths) {
    if (
      isPathWithin(vaultPath, codexHomePath)
      || isPathWithin(codexHomePath, vaultPath)
    ) {
      throw new CodexSessionCapabilityError("Codex認証領域とVaultの範囲が重なっています。");
    }
    if (
      isPathWithin(vaultPath, realWorkspacePath)
      || isPathWithin(realWorkspacePath, vaultPath)
    ) {
      throw new CodexSessionCapabilityError("Codex専用ワークスペースとVaultの範囲が重なっています。");
    }
  }
  return createTaskHubConnectionOverridesFromVerifiedPaths({
    codexExecutablePath: options.codexExecutablePath,
    workspacePath: realWorkspacePath,
    codexHomePath,
    readOnlyVaultPaths: verifiedVaultPaths,
    unixSocketPaths,
  });
}
