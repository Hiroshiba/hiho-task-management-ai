import { ObsidianIntegrationWorkflow } from "../application/obsidian-integration";
import { ObsidianReadError, ObsidianReadService, discoverTasksVault } from "../infrastructure/obsidian";
import { SqliteVaultMappingRepository, type PersistenceRuntime } from "../infrastructure/persistence";
import type { LegacyRuntimePort } from "./legacy-runtime-port";

type ObsidianRuntimeOptions = {
  readonly readOnlyVaultPaths: readonly string[];
  readonly openObsidianUrl: (url: string, signal: AbortSignal) => void | Promise<void>;
  readonly diagnostic: (error: unknown, channel: string, diagnostic: { readonly kind: "service"; readonly severity: "warning" | "error" }) => void;
};

/** Vault保存先とObsidian操作をMainの運用状態へ接続します。 */
export function createObsidianRuntime(
  persistence: PersistenceRuntime,
  options: ObsidianRuntimeOptions,
): {
  readonly repository: SqliteVaultMappingRepository;
  readonly workflow: ObsidianIntegrationWorkflow;
  readonly bindHost: (host: ReturnType<LegacyRuntimePort["getObsidianCompositionDependencies"]>) => void;
} {
  const repository = new SqliteVaultMappingRepository(persistence.connection);
  let host: ReturnType<LegacyRuntimePort["getObsidianCompositionDependencies"]> | undefined;
  const requireHost = (): ReturnType<LegacyRuntimePort["getObsidianCompositionDependencies"]> => {
    if (host == null) {
      throw new Error("Obsidian連携の接続が完了していません。");
    }
    return host;
  };
  const workflow = new ObsidianIntegrationWorkflow({
    repository,
    reader: new ObsidianReadService(repository),
    discoverTasksVault,
    assertOperationalReady: () => requireHost().assertOperationalReady(),
    isStopped: () => requireHost().isStopped(),
    isExternalToolConfigurationRunning: () => requireHost().isExternalToolConfigurationRunning(),
    hasActiveAiSessions: () => requireHost().hasActiveAiSessions(),
    codexSessionState: () => requireHost().codexSessionState(),
    configuredReadOnlyVaultPaths: options.readOnlyVaultPaths,
    setCodexReadOnlyVaultPaths: (paths) => requireHost().setCodexReadOnlyVaultPaths(paths),
    openObsidianUrl: options.openObsidianUrl,
    reportFailure: (error) => {
      if (error instanceof ObsidianReadError) {
        options.diagnostic(error, "obsidian", { kind: "service", severity: "error" });
      }
    },
  });
  return {
    repository,
    workflow,
    bindHost: (value) => {
      if (host != null) {
        throw new Error("Obsidian連携を二重に接続できません。");
      }
      host = value;
    },
  };
}
