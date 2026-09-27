import type {
  ObsidianNoteReadResult,
  ObsidianNoteSummary,
  ObsidianRecentNote,
  ObsidianResolvedPathResult,
  ObsidianSearchResult,
  ObsidianVaultValidationResult,
  VaultMapping,
} from "../../../domain/obsidian-contracts";

/** Vaultマッピングの保存と取得を行います。 */
export interface ObsidianVaultRepository {
  saveVaultMapping(mapping: VaultMapping): void;
  getVaultMappings(): readonly VaultMapping[];
}

/** Vaultの安全な参照操作を提供します。 */
export interface ObsidianVaultReader {
  validateMapping(mapping: VaultMapping, signal: AbortSignal): Promise<ObsidianVaultValidationResult>;
  validateVault(vaultId: string, signal: AbortSignal): Promise<ObsidianVaultValidationResult>;
  listNotes(vaultId: string, signal: AbortSignal): Promise<readonly ObsidianNoteSummary[]>;
  recentNotes(vaultId: string, limit: number, signal: AbortSignal): Promise<readonly ObsidianRecentNote[]>;
  resolveRelativePath(vaultId: string, relativePath: string, signal: AbortSignal): Promise<ObsidianResolvedPathResult>;
  noteExists(vaultId: string, relativePath: string, signal: AbortSignal): Promise<ObsidianResolvedPathResult>;
  searchNotes(vaultId: string, query: string, signal: AbortSignal): Promise<readonly ObsidianSearchResult[]>;
  readNote(vaultId: string, relativePath: string, signal: AbortSignal): Promise<ObsidianNoteReadResult>;
}

export type ObsidianTasksVaultDiscovery =
  | { readonly kind: "found"; readonly mapping: VaultMapping }
  | { readonly kind: "not_found" }
  | { readonly kind: "unsupported" };
