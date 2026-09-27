type VaultMapping = { readonly vault_id: string };

type ResolvedPath =
  | { readonly kind: "missing"; readonly vault_id: string; readonly relative_path: string }
  | { readonly kind: "resolved"; readonly vault_id: string; readonly relative_path: string };

type ObsidianPortDependencies<Mapping extends VaultMapping, Path extends ResolvedPath> = {
  readonly assertOperationalReady: () => void;
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly getVaultMappings: () => readonly Mapping[];
  readonly saveVaultMapping: (mapping: Mapping, signal: AbortSignal) => Promise<readonly Mapping[]>;
  readonly validateVault: (vaultId: string, signal: AbortSignal) => Promise<{ readonly vault_id: string }>;
  readonly resolveRelativePath: (
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<Path>;
  readonly noteExists: (
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ) => Promise<Path>;
  readonly createOpenUri: (input: { readonly vault_id: string; readonly relative_path: string }) => string;
  readonly openObsidianUrl: (uri: string, signal: AbortSignal) => void | PromiseLike<void>;
};

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Obsidianの検証済み参照操作をIPCへ公開します。 */
export function createObsidianPort<Mapping extends VaultMapping, Path extends ResolvedPath>(
  dependencies: ObsidianPortDependencies<Mapping, Path>,
): {
  readonly listVaults: (signal: AbortSignal) => readonly string[];
  readonly listVaultMappings: (signal: AbortSignal) => readonly Mapping[];
  readonly saveVaultMapping: (mapping: Mapping, signal: AbortSignal) => Promise<readonly Mapping[]>;
  readonly validateVault: (
    vaultId: string,
    signal: AbortSignal,
  ) => Promise<{ readonly vault_id: string; readonly kind: "valid" }>;
  readonly resolvePath: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<ResolvedPath>;
  readonly noteExists: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<ResolvedPath>;
  readonly openNote: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<void>;
} {
  return {
    listVaults: (signal) => {
      dependencies.assertOperationalReady();
      dependencies.validateAbortSignal(signal);
      dependencies.throwIfAborted(signal);
      return dependencies.getVaultMappings()
        .map((mapping) => mapping.vault_id)
        .sort(compareStrings);
    },
    listVaultMappings: (signal) => {
      dependencies.assertOperationalReady();
      dependencies.validateAbortSignal(signal);
      dependencies.throwIfAborted(signal);
      return dependencies.getVaultMappings();
    },
    saveVaultMapping: (mapping, signal) => dependencies.saveVaultMapping(mapping, signal),
    validateVault: async (vaultId, signal) => {
      dependencies.assertOperationalReady();
      const result = await dependencies.validateVault(vaultId, signal);
      return { vault_id: result.vault_id, kind: "valid" };
    },
    resolvePath: async (vaultId, relativePath, signal) => {
      dependencies.assertOperationalReady();
      const result = await dependencies.resolveRelativePath(vaultId, relativePath, signal);
      if (result.kind === "missing") {
        return result;
      }
      return {
        kind: "resolved",
        vault_id: result.vault_id,
        relative_path: result.relative_path,
      };
    },
    noteExists: async (vaultId, relativePath, signal) => {
      dependencies.assertOperationalReady();
      const result = await dependencies.noteExists(vaultId, relativePath, signal);
      if (result.kind === "missing") {
        return result;
      }
      return {
        kind: "resolved",
        vault_id: result.vault_id,
        relative_path: result.relative_path,
      };
    },
    openNote: async (vaultId, relativePath, signal) => {
      dependencies.assertOperationalReady();
      const result = await dependencies.resolveRelativePath(vaultId, relativePath, signal);
      if (result.kind === "missing") {
        throw new Error("開くObsidianノートが見つかりません。");
      }
      dependencies.throwIfAborted(signal);
      const uri = dependencies.createOpenUri({
        vault_id: result.vault_id,
        relative_path: result.relative_path,
      });
      await dependencies.openObsidianUrl(uri, signal);
    },
  };
}

type CodexObsidianPortDependencies<Notes, Search, Note, Recent> = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly getVaultMappings: () => readonly VaultMapping[];
  readonly listNotes: (vaultId: string, signal: AbortSignal) => PromiseLike<Notes>;
  readonly searchNotes: (vaultId: string, query: string, signal: AbortSignal) => PromiseLike<Search>;
  readonly readNote: (vaultId: string, relativePath: string, signal: AbortSignal) => PromiseLike<Note>;
  readonly recentNotes: (vaultId: string, limit: number, signal: AbortSignal) => PromiseLike<Recent>;
};

/** CodexセッションへObsidianの読み取り操作を公開します。 */
export function createCodexObsidianReadPort<Notes, Search, Note, Recent>(
  dependencies: CodexObsidianPortDependencies<Notes, Search, Note, Recent>,
): {
  readonly listVaults: (signal: AbortSignal) => readonly string[];
  readonly listNotes: CodexObsidianPortDependencies<Notes, Search, Note, Recent>["listNotes"];
  readonly searchNotes: CodexObsidianPortDependencies<Notes, Search, Note, Recent>["searchNotes"];
  readonly readNote: CodexObsidianPortDependencies<Notes, Search, Note, Recent>["readNote"];
  readonly recentNotes: CodexObsidianPortDependencies<Notes, Search, Note, Recent>["recentNotes"];
} {
  return {
    listVaults: (signal) => {
      dependencies.validateAbortSignal(signal);
      dependencies.throwIfAborted(signal);
      return dependencies.getVaultMappings()
        .map((mapping) => mapping.vault_id)
        .sort(compareStrings);
    },
    listNotes: (vaultId, signal) => dependencies.listNotes(vaultId, signal),
    searchNotes: (vaultId, query, signal) => dependencies.searchNotes(vaultId, query, signal),
    readNote: (vaultId, relativePath, signal) => dependencies.readNote(vaultId, relativePath, signal),
    recentNotes: (vaultId, limit, signal) => dependencies.recentNotes(vaultId, limit, signal),
  };
}
