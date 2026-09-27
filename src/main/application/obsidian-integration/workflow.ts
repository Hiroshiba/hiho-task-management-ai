import type {
  ObsidianTasksVaultDiscovery,
  ObsidianVaultReader,
  ObsidianVaultRepository,
} from "../common/ports/obsidian-vault-repository";
import {
  vaultMappingSchema,
  type ObsidianNoteReadResult,
  type ObsidianNoteSummary,
  type ObsidianRecentNote,
  type ObsidianResolvedPathResult,
  type ObsidianSearchResult,
  type ObsidianVaultValidationResult,
  type VaultMapping,
} from "../../domain/obsidian-contracts";
import { ObsidianVaultMappingConflictError } from "../../domain/obsidian-errors";
import { createObsidianOpenUri } from "../../domain/obsidian-uri";

type ObsidianWorkflowDependencies = {
  readonly repository: ObsidianVaultRepository;
  readonly reader: ObsidianVaultReader;
  readonly discoverTasksVault: (signal: AbortSignal) => Promise<ObsidianTasksVaultDiscovery>;
  readonly assertOperationalReady: () => void;
  readonly isStopped: () => boolean;
  readonly isExternalToolConfigurationRunning: () => boolean;
  readonly hasActiveAiSessions: () => boolean;
  readonly codexSessionState: () => string;
  readonly configuredReadOnlyVaultPaths: readonly string[];
  readonly setCodexReadOnlyVaultPaths: (paths: readonly string[]) => void;
  readonly openObsidianUrl: (uri: string, signal: AbortSignal) => void | PromiseLike<void>;
  readonly reportFailure: (error: unknown) => void;
};

type ObsidianPathStatus =
  | { readonly kind: "missing"; readonly vault_id: string; readonly relative_path: string }
  | { readonly kind: "resolved"; readonly vault_id: string; readonly relative_path: string };

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
    || typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  validateAbortSignal(signal);
  if (signal.aborted) {
    throw new Error("アプリケーション処理が中断されました。");
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toPathStatus(result: ObsidianResolvedPathResult): ObsidianPathStatus {
  return {
    kind: result.kind,
    vault_id: result.vault_id,
    relative_path: result.relative_path,
  };
}

/** Obsidian Vault設定と参照操作を統括します。 */
export class ObsidianIntegrationWorkflow {
  private saveInProgress = false;

  public constructor(private readonly dependencies: ObsidianWorkflowDependencies) {}

  private async reportCodexFailure<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      this.dependencies.reportFailure(error);
      throw error;
    }
  }

  private assertVaultMappingSaveAllowed(): void {
    if (
      this.dependencies.isStopped()
      || this.dependencies.isExternalToolConfigurationRunning()
      || this.dependencies.hasActiveAiSessions()
    ) {
      throw new ObsidianVaultMappingConflictError();
    }
    const codexState = this.dependencies.codexSessionState();
    if (
      codexState !== "created"
      && codexState !== "authentication_required"
      && codexState !== "ready"
      && codexState !== "disabled"
    ) {
      throw new ObsidianVaultMappingConflictError();
    }
  }

  /** 登録済みVault IDを並び替えて返します。 */
  public listVaults(signal: AbortSignal): readonly string[] {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    return this.dependencies.repository.getVaultMappings()
      .map((mapping) => mapping.vault_id)
      .sort(compareStrings);
  }

  /** 登録済みVaultマッピングを返します。 */
  public listVaultMappings(signal: AbortSignal): readonly VaultMapping[] {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    return this.dependencies.repository.getVaultMappings();
  }

  /** Codexへ公開する読取専用Vaultパスを返します。 */
  public readOnlyVaultPaths(): readonly string[] {
    const paths = new Set<string>(this.dependencies.configuredReadOnlyVaultPaths);
    for (const mapping of this.dependencies.repository.getVaultMappings()) {
      paths.add(mapping.absolute_path);
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }

  /** Codexが参照する読取専用Vaultパスを更新します。 */
  public refreshCodexVaultPaths(): void {
    const state = this.dependencies.codexSessionState();
    if (state !== "created" && state !== "authentication_required" && state !== "ready") {
      return;
    }
    this.dependencies.setCodexReadOnlyVaultPaths(this.readOnlyVaultPaths());
  }

  /** 既定のtasks Vaultが未登録なら発見して保存します。 */
  public async ensureTasksVaultMapping(signal: AbortSignal): Promise<void> {
    const exists = this.dependencies.repository.getVaultMappings().some(
      (mapping) => mapping.vault_id === "tasks",
    );
    if (exists) return;
    const discovery = await this.dependencies.discoverTasksVault(signal);
    if (discovery.kind === "found") {
      throwIfAborted(signal);
      this.dependencies.repository.saveVaultMapping(discovery.mapping);
      this.refreshCodexVaultPaths();
    }
  }

  /** Vaultマッピングを安全な実体パスへ保存します。 */
  public async saveVaultMapping(mapping: VaultMapping, signal: AbortSignal): Promise<readonly VaultMapping[]> {
    this.dependencies.assertOperationalReady();
    validateAbortSignal(signal);
    throwIfAborted(signal);
    if (this.saveInProgress) {
      throw new ObsidianVaultMappingConflictError();
    }
    this.assertVaultMappingSaveAllowed();
    this.saveInProgress = true;
    try {
      const requestedMapping = vaultMappingSchema.parse(mapping);
      const validatedVault = await this.dependencies.reader.validateMapping(requestedMapping, signal);
      throwIfAborted(signal);
      this.dependencies.assertOperationalReady();
      this.assertVaultMappingSaveAllowed();
      const savedMapping = vaultMappingSchema.parse({
        vault_id: validatedVault.vault_id,
        absolute_path: validatedVault.real_path,
      });
      this.dependencies.repository.saveVaultMapping(savedMapping);
      this.refreshCodexVaultPaths();
      return this.dependencies.repository.getVaultMappings();
    } finally {
      this.saveInProgress = false;
    }
  }

  /** 指定したVaultマッピングの実体パスを検証します。 */
  public validateMapping(mapping: VaultMapping, signal: AbortSignal): Promise<ObsidianVaultValidationResult> {
    return this.dependencies.reader.validateMapping(mapping, signal);
  }

  /** 登録済みVaultのディレクトリと実体パスを検証します。 */
  public validateVault(vaultId: string, signal: AbortSignal): Promise<ObsidianVaultValidationResult> {
    return this.dependencies.reader.validateVault(vaultId, signal);
  }

  /** Markdown相対パスを安全なVault内パスへ解決します。 */
  public resolveRelativePath(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<ObsidianResolvedPathResult> {
    return this.dependencies.reader.resolveRelativePath(vaultId, relativePath, signal);
  }

  /** Markdownノートの存在状態を返します。 */
  public noteExists(vaultId: string, relativePath: string, signal: AbortSignal): Promise<ObsidianResolvedPathResult> {
    return this.dependencies.reader.noteExists(vaultId, relativePath, signal);
  }

  /** Markdownノートを一覧します。 */
  public listNotes(vaultId: string, signal: AbortSignal): Promise<readonly ObsidianNoteSummary[]> {
    return this.dependencies.reader.listNotes(vaultId, signal);
  }

  /** Markdownノートを検索します。 */
  public searchNotes(vaultId: string, query: string, signal: AbortSignal): Promise<readonly ObsidianSearchResult[]> {
    return this.dependencies.reader.searchNotes(vaultId, query, signal);
  }

  /** Markdownノートを読み取ります。 */
  public readNote(vaultId: string, relativePath: string, signal: AbortSignal): Promise<ObsidianNoteReadResult> {
    return this.dependencies.reader.readNote(vaultId, relativePath, signal);
  }

  /** 最近更新されたMarkdownノートを一覧します。 */
  public recentNotes(vaultId: string, limit: number, signal: AbortSignal): Promise<readonly ObsidianRecentNote[]> {
    return this.dependencies.reader.recentNotes(vaultId, limit, signal);
  }

  /** Codexへ公開する読み取り専用Vault操作を返します。 */
  public createCodexPort(): {
    readonly listVaults: (signal: AbortSignal) => readonly string[];
    readonly listNotes: (vaultId: string, signal: AbortSignal) => Promise<readonly ObsidianNoteSummary[]>;
    readonly searchNotes: (vaultId: string, query: string, signal: AbortSignal) => Promise<readonly ObsidianSearchResult[]>;
    readonly readNote: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<ObsidianNoteReadResult>;
    readonly recentNotes: (vaultId: string, limit: number, signal: AbortSignal) => Promise<readonly ObsidianRecentNote[]>;
  } {
    return {
      listVaults: (signal) => this.listVaults(signal),
      listNotes: (vaultId, signal) => this.reportCodexFailure(() => this.listNotes(vaultId, signal), signal),
      searchNotes: (vaultId, query, signal) => this.reportCodexFailure(
        () => this.searchNotes(vaultId, query, signal), signal,
      ),
      readNote: (vaultId, relativePath, signal) => this.reportCodexFailure(
        () => this.readNote(vaultId, relativePath, signal), signal,
      ),
      recentNotes: (vaultId, limit, signal) => this.reportCodexFailure(
        () => this.recentNotes(vaultId, limit, signal), signal,
      ),
    };
  }

  /** IPCから利用するVault参照操作を返します。 */
  public createIpcPort(): {
    readonly listVaults: (signal: AbortSignal) => readonly string[];
    readonly listVaultMappings: (signal: AbortSignal) => readonly VaultMapping[];
    readonly saveVaultMapping: (mapping: VaultMapping, signal: AbortSignal) => Promise<readonly VaultMapping[]>;
    readonly validateVault: (vaultId: string, signal: AbortSignal) => Promise<{ readonly vault_id: string; readonly kind: "valid" }>;
    readonly resolvePath: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<ObsidianPathStatus>;
    readonly noteExists: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<ObsidianPathStatus>;
    readonly openNote: (vaultId: string, relativePath: string, signal: AbortSignal) => Promise<void>;
  } {
    return {
      listVaults: (signal) => {
        this.dependencies.assertOperationalReady();
        return this.listVaults(signal);
      },
      listVaultMappings: (signal) => {
        this.dependencies.assertOperationalReady();
        return this.listVaultMappings(signal);
      },
      saveVaultMapping: (mapping, signal) => this.saveVaultMapping(mapping, signal),
      validateVault: async (vaultId, signal) => {
        this.dependencies.assertOperationalReady();
        const result = await this.validateVault(vaultId, signal);
        return { vault_id: result.vault_id, kind: "valid" };
      },
      resolvePath: (vaultId, relativePath, signal) => this.resolvePathStatus(vaultId, relativePath, signal),
      noteExists: async (vaultId, relativePath, signal) => {
        this.dependencies.assertOperationalReady();
        return toPathStatus(await this.noteExists(vaultId, relativePath, signal));
      },
      openNote: async (vaultId, relativePath, signal) => {
        this.dependencies.assertOperationalReady();
        const result = await this.resolveRelativePath(vaultId, relativePath, signal);
        if (result.kind === "missing") {
          throw new Error("開くObsidianノートが見つかりません。");
        }
        throwIfAborted(signal);
        await this.dependencies.openObsidianUrl(createObsidianOpenUri({
          vault_id: result.vault_id,
          relative_path: result.relative_path,
        }), signal);
      },
    };
  }

  private async resolvePathStatus(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<ObsidianPathStatus> {
    this.dependencies.assertOperationalReady();
    const result = await this.resolveRelativePath(vaultId, relativePath, signal);
    return toPathStatus(result);
  }
}
