import { ObsidianIntegrationWorkflow } from "../application/obsidian-integration";
import { ObsidianReadError, discoverTasksVault } from "../infrastructure/obsidian";
import { SqliteVaultMappingRepository } from "../infrastructure/persistence";
import type { CodexSessionService } from "../infrastructure/ai";

export type ObsidianCompositionDependencies = {
  readonly assertOperationalReady: () => void;
  readonly isStopped: () => boolean;
  readonly hasActiveAiSessions: () => boolean;
  readonly codexSessionState: () => ReturnType<CodexSessionService["getState"]>;
  readonly setCodexReadOnlyVaultPaths: (paths: readonly string[]) => void;
};

type ObsidianRuntimeOptions = {
  readonly readOnlyVaultPaths: readonly string[];
  readonly openObsidianUrl: (url: string, signal: AbortSignal) => void | Promise<void>;
  readonly diagnostic: (error: unknown, channel: string, diagnostic: { readonly kind: "service"; readonly severity: "warning" | "error" }) => void;
};

/** Vault保存先とObsidian操作をMainの運用状態へ接続します。 */
export function createObsidianRuntime(
  adapters: {
    readonly repository: SqliteVaultMappingRepository;
    readonly reader: ConstructorParameters<typeof ObsidianIntegrationWorkflow>[0]["reader"];
  },
  options: ObsidianRuntimeOptions,
): {
  readonly repository: SqliteVaultMappingRepository;
  readonly workflow: ObsidianIntegrationWorkflow;
  readonly bindHost: (host: ObsidianCompositionDependencies) => void;
} {
  const { repository } = adapters;
  let host: ObsidianCompositionDependencies | undefined;
  const requireHost = (): ObsidianCompositionDependencies => {
    if (host == null) {
      throw new Error("Obsidian連携の接続が完了していません。");
    }
    return host;
  };
  const workflow = new ObsidianIntegrationWorkflow({
    repository,
    reader: adapters.reader,
    discoverTasksVault,
    assertOperationalReady: () => requireHost().assertOperationalReady(),
    isStopped: () => requireHost().isStopped(),
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
