import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import type { ObsidianVaultRepository } from "../../application/common/ports/obsidian-vault-repository";
import {
  hasControlCharacter,
  maximumResultCount,
  obsidianNoteReadResultSchema,
  obsidianNoteSummaryArraySchema,
  obsidianRecentNoteArraySchema,
  obsidianResolvedPathResultSchema,
  obsidianRelativeMarkdownPathSchema,
  obsidianSearchQuerySchema,
  obsidianSearchResultArraySchema,
  obsidianVaultIdSchema,
  obsidianVaultValidationResultSchema,
  parseRelativeMarkdownPath,
  recentNoteLimitSchema,
  vaultMappingSchema,
  type ObsidianNoteReadResult,
  type ObsidianNoteSummary,
  type ObsidianRecentNote,
  type ObsidianResolvedPathResult,
  type ObsidianSearchResult,
  type ObsidianVaultValidationResult,
  type VaultMapping,
} from "../../domain/obsidian-contracts";
import { ObsidianReadError } from "./read-error";
import {
  assertFileStateUnchanged,
  inspectExistingPath,
  resolveNotePathWithinVault,
  throwIfAborted,
  type PathInspection,
  type RegisteredVault,
} from "./vault-path-security";
import type { ReadBudget } from "./secure-note-reader";
import {
  assertOutputBudget,
  collectMarkdownPaths,
  collectRecentNotePaths,
  createExcerpt,
  matchesSearch,
  modifiedAtFromMtimeNs,
  readMarkdownNote,
  readMarkdownNoteFromResolvedPath,
  readMarkdownNotes,
} from "./markdown-reader";

function hasTraversalSegment(value: string): boolean {
  const segments = sep === "\\" ? value.split(/[\\/]/u) : value.split("/");
  return segments.some((segment) => segment === "." || segment === "..");
}

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

/** Vaultマッピングの存在と安全性を検証して実体パスを返します。 */
export async function validateVaultMappingPath(
  mapping: VaultMapping,
  signal: AbortSignal,
): Promise<ObsidianVaultValidationResult> {
  validateAbortSignal(signal);
  throwIfAborted(signal);
  const validatedMapping = vaultMappingSchema.parse(mapping);
  if (
    !isAbsolute(validatedMapping.absolute_path)
    || hasControlCharacter(validatedMapping.absolute_path)
    || hasTraversalSegment(validatedMapping.absolute_path)
  ) {
    throw new ObsidianReadError(
      "vault_unavailable",
      "登録されたVaultパスが不正です。",
    );
  }
  const absolutePath = resolve(validatedMapping.absolute_path);
  throwIfAborted(signal);
  let inspection: PathInspection;
  try {
    inspection = await inspectExistingPath(absolutePath, signal);
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    if (error instanceof ObsidianReadError) {
      throw error;
    }
    throw new ObsidianReadError(
      "vault_unavailable",
      "登録されたVaultパスを検証できません。",
      error,
    );
  }
  if (inspection.kind === "missing") {
    throw new ObsidianReadError(
      "vault_unavailable",
      "登録されたVaultディレクトリを確認できません。",
      inspection.cause,
    );
  }
  if (!inspection.stats.isDirectory()) {
    throw new ObsidianReadError(
      "vault_not_directory",
      "登録されたVaultパスはディレクトリではありません。",
    );
  }
  let realPath: string;
  try {
    throwIfAborted(signal);
    realPath = await realpath(absolutePath);
    throwIfAborted(signal);
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    throw new ObsidianReadError(
      "vault_unavailable",
      "登録されたVaultの実体パスを確認できません。",
      error,
    );
  }
  return obsidianVaultValidationResultSchema.parse({
    vault_id: validatedMapping.vault_id,
    absolute_path: absolutePath,
    real_path: realPath,
  });
}

/** Vault内のMarkdownノートを安全に参照します。 */
export class ObsidianReadService {
  public constructor(private readonly repository: ObsidianVaultRepository) {}

  /** 指定したVaultマッピングの存在とディレクトリ性を検証します。 */
  public validateMapping(
    mapping: VaultMapping,
    signal: AbortSignal,
  ): Promise<ObsidianVaultValidationResult> {
    return validateVaultMappingPath(mapping, signal);
  }

  /** 登録済みVaultの存在とディレクトリ性を検証します。 */
  public async validateVault(
    vaultId: string,
    signal: AbortSignal,
  ): Promise<ObsidianVaultValidationResult> {
    validateAbortSignal(signal);
    const vault = await this.getRegisteredVault(vaultId, signal);
    return obsidianVaultValidationResultSchema.parse(vault);
  }

  /** 登録済みVault内のMarkdownノートを一覧します。 */
  public async listNotes(
    vaultId: string,
    signal: AbortSignal,
  ): Promise<readonly ObsidianNoteSummary[]> {
    validateAbortSignal(signal);
    const vault = await this.getRegisteredVault(vaultId, signal);
    const paths = await collectMarkdownPaths(vault, signal);
    if (paths.length > maximumResultCount) {
      throw new ObsidianReadError(
        "limit_exceeded",
        "VaultのMarkdown一覧件数が上限を超えています。",
      );
    }
    const notes = await readMarkdownNotes(vault, paths, signal);
    const result = notes.map((note) => ({
      relative_path: note.relative_path,
      title: note.title,
      headings: [...note.headings],
    }));
    assertOutputBudget(
      result.flatMap((note) => [note.relative_path, note.title, ...note.headings]),
    );
    return obsidianNoteSummaryArraySchema.parse(result);
  }

  /** 登録済みVault内の最近更新されたMarkdownノートを一覧します。 */
  public async recentNotes(
    vaultId: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<readonly ObsidianRecentNote[]> {
    validateAbortSignal(signal);
    const validatedLimit = recentNoteLimitSchema.parse(limit);
    const vault = await this.getRegisteredVault(vaultId, signal);
    const paths = await collectRecentNotePaths(vault, signal);
    const sortedPaths = [...paths].sort((left, right) => {
      if (left.pre_open_stats.mtimeNs > right.pre_open_stats.mtimeNs) {
        return -1;
      }
      if (left.pre_open_stats.mtimeNs < right.pre_open_stats.mtimeNs) {
        return 1;
      }
      if (left.relative_path < right.relative_path) {
        return -1;
      }
      if (left.relative_path > right.relative_path) {
        return 1;
      }
      return 0;
    });
    const budget: ReadBudget = { total_bytes: 0 };
    const result: ObsidianRecentNote[] = [];
    for (const path of sortedPaths.slice(0, validatedLimit)) {
      throwIfAborted(signal);
      const parsed = await readMarkdownNoteFromResolvedPath(path, signal, budget);
      assertFileStateUnchanged(path.pre_open_stats, parsed.stats);
      result.push({
        relative_path: parsed.note.relative_path,
        title: parsed.note.title,
        headings: [...parsed.note.headings],
        modified_at: modifiedAtFromMtimeNs(path.pre_open_stats.mtimeNs),
      });
    }
    assertOutputBudget(
      result.flatMap((note) => [
        note.relative_path,
        note.title,
        ...note.headings,
        note.modified_at,
      ]),
    );
    return obsidianRecentNoteArraySchema.parse(result);
  }

  /** 登録済みVault内のMarkdown相対パスを安全な絶対パスへ解決します。 */
  public async resolveRelativePath(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<ObsidianResolvedPathResult> {
    validateAbortSignal(signal);
    const vault = await this.getRegisteredVault(vaultId, signal);
    const result = await resolveNotePathWithinVault(
      vault, relativePath, signal, parseRelativeMarkdownPath,
    );
    if (result.kind === "missing") {
      return obsidianResolvedPathResultSchema.parse({
        kind: "missing",
        vault_id: vault.vault_id,
        relative_path: obsidianRelativeMarkdownPathSchema.parse(relativePath),
      });
    }
    return obsidianResolvedPathResultSchema.parse({
      kind: "resolved",
      vault_id: vault.vault_id,
      relative_path: result.relative_path,
      absolute_path: result.absolute_path,
    });
  }

  /** 登録済みVault内のMarkdownノートの存在状態を返します。 */
  public async noteExists(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<ObsidianResolvedPathResult> {
    return this.resolveRelativePath(vaultId, relativePath, signal);
  }

  /** 登録済みVault内のMarkdownノートを検索します。 */
  public async searchNotes(
    vaultId: string,
    query: string,
    signal: AbortSignal,
  ): Promise<readonly ObsidianSearchResult[]> {
    validateAbortSignal(signal);
    const validatedQuery = obsidianSearchQuerySchema.parse(query);
    const vault = await this.getRegisteredVault(vaultId, signal);
    const paths = await collectMarkdownPaths(vault, signal);
    const notes = await readMarkdownNotes(vault, paths, signal);
    const matchedNotes = notes.filter((note) => matchesSearch(note, validatedQuery));
    if (matchedNotes.length > maximumResultCount) {
      throw new ObsidianReadError(
        "limit_exceeded",
        "Vault検索結果が上限を超えています。",
      );
    }
    const result = matchedNotes.map((note) => ({
      relative_path: note.relative_path,
      title: note.title,
      headings: [...note.headings],
      excerpt: createExcerpt(note, validatedQuery),
    }));
    assertOutputBudget(
      result.flatMap((note) => [
        note.relative_path,
        note.title,
        ...note.headings,
        note.excerpt,
      ]),
    );
    return obsidianSearchResultArraySchema.parse(result);
  }

  /** 登録済みVault内の単一Markdownノートを読み取ります。 */
  public async readNote(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<ObsidianNoteReadResult> {
    validateAbortSignal(signal);
    const vault = await this.getRegisteredVault(vaultId, signal);
    const budget: ReadBudget = { total_bytes: 0 };
    const note = await readMarkdownNote(vault, relativePath, signal, budget);
    if (note.kind === "missing") {
      return obsidianNoteReadResultSchema.parse({
        kind: "missing",
        relative_path: obsidianRelativeMarkdownPathSchema.parse(relativePath),
      });
    }
    return obsidianNoteReadResultSchema.parse(note);
  }

  private async getRegisteredVault(
    vaultId: string,
    signal: AbortSignal,
  ): Promise<RegisteredVault> {
    const validatedVaultId = obsidianVaultIdSchema.parse(vaultId);
    throwIfAborted(signal);
    const mappings = this.repository.getVaultMappings();
    const matchingMappings = mappings.filter(
      (mapping) => mapping.vault_id === validatedVaultId,
    );
    if (matchingMappings.length === 0) {
      throw new ObsidianReadError(
        "vault_not_registered",
        "指定されたVaultは登録されていません。",
      );
    }
    if (matchingMappings.length !== 1) {
      throw new ObsidianReadError(
        "vault_unavailable",
        "指定されたVaultの登録内容が一意ではありません。",
      );
    }
    const mapping = matchingMappings[0];
    if (mapping == null) {
      throw new Error("Vaultマッピングを取得できません。");
    }
    return validateVaultMappingPath(mapping, signal);
  }
}
