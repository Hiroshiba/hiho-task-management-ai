import type { BigIntStats } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { ObsidianReadError } from "./read-error";

export type RegisteredVault = {
  readonly vault_id: string;
  readonly absolute_path: string;
  readonly real_path: string;
};

type ExistingPath = {
  readonly kind: "existing";
  readonly stats: BigIntStats;
};

type MissingPathInspection = {
  readonly kind: "missing";
  readonly cause: unknown;
};

export type MissingPath = {
  readonly kind: "missing";
};

export type PathInspection = ExistingPath | MissingPathInspection;

export type ResolvedNotePath = {
  readonly kind: "resolved";
  readonly relative_path: string;
  readonly absolute_path: string;
  readonly read_path: string;
  readonly pre_open_stats: BigIntStats;
};

export type ResolvedNotePathResult = ResolvedNotePath | MissingPath;

function assertUsableFileIdentity(stats: BigIntStats): void {
  if (stats.dev < 0n || stats.ino <= 0n) {
    throw new ObsidianReadError(
      "path_security",
      "Markdownファイルの一意な識別子を確認できません。",
    );
  }
}

/** ファイルの実体が同じことを確認します。 */
export function assertSameFileIdentity(
  expected: BigIntStats,
  actual: BigIntStats,
): void {
  assertUsableFileIdentity(expected);
  assertUsableFileIdentity(actual);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new ObsidianReadError(
      "path_changed",
      "Markdownファイルの実体が読み取り中に変化しました。",
    );
  }
}

/** 読み取り前後でファイルの実体と状態が同じことを確認します。 */
export function assertFileStateUnchanged(
  before: BigIntStats,
  after: BigIntStats,
): void {
  assertSameFileIdentity(before, after);
  if (
    before.size !== after.size
    || before.mode !== after.mode
    || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs
  ) {
    throw new ObsidianReadError(
      "path_changed",
      "Markdownファイルが読み取り中に変更されました。",
    );
  }
}

/** ファイルシステムエラーのコードを取得します。 */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

/** ファイルシステムでパスが欠けた失敗か判定します。 */
export function isMissingFileSystemError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 中断されている場合は中断理由を送出します。 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    signal.throwIfAborted();
  }
}

function assertWithinRoot(rootPath: string, candidatePath: string): void {
  const pathFromRoot = relative(rootPath, candidatePath);
  if (
    pathFromRoot.length === 0
    || isAbsolute(pathFromRoot)
    || pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new ObsidianReadError(
      "path_security",
      "Vaultの範囲外のパスは読み取れません。",
    );
  }
}

/** 経路上のシンボリックリンクを拒否してパスを調べます。 */
export async function inspectExistingPath(
  absolutePath: string,
  signal: AbortSignal,
): Promise<PathInspection> {
  const normalizedPath = resolve(absolutePath);
  const pathRoot = parsePath(normalizedPath).root;
  const segments = normalizedPath.slice(pathRoot.length).split(sep);
  throwIfAborted(signal);
  let rootStats: BigIntStats;
  try {
    rootStats = await lstat(pathRoot, { bigint: true });
    throwIfAborted(signal);
  } catch (error) {
    if (isMissingFileSystemError(error)) {
      return { kind: "missing", cause: error };
    }
    throw error;
  }
  if (rootStats.isSymbolicLink()) {
    throw new ObsidianReadError(
      "symlink_rejected",
      "シンボリックリンクを経由するVaultパスは読み取れません。",
    );
  }
  let currentPath = pathRoot;
  if (segments.every((segment) => segment.length === 0)) {
    return { kind: "existing", stats: rootStats };
  }

  for (const [index, segment] of segments.entries()) {
    if (segment.length === 0) {
      continue;
    }
    currentPath = join(currentPath, segment);
    let stats: BigIntStats;
    try {
      throwIfAborted(signal);
      stats = await lstat(currentPath, { bigint: true });
      throwIfAborted(signal);
    } catch (error) {
      if (isMissingFileSystemError(error)) {
        return { kind: "missing", cause: error };
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new ObsidianReadError(
        "symlink_rejected",
        "シンボリックリンクを経由するVaultパスは読み取れません。",
      );
    }
    const remainingSegments = segments.slice(index + 1).filter(
      (value) => value.length > 0,
    );
    if (remainingSegments.length > 0 && !stats.isDirectory()) {
      return {
        kind: "missing",
        cause: new Error("Vaultパスの途中にディレクトリではない要素があります。"),
      };
    }
    if (remainingSegments.length === 0) {
      return { kind: "existing", stats };
    }
  }
  throw new ObsidianReadError(
    "path_security",
    "Vaultパスを検証できません。",
  );
}

/** Vault内のMarkdownパスを安全に解決します。 */
export async function resolveNotePathWithinVault(
  vault: RegisteredVault,
  relativePath: string,
  signal: AbortSignal,
  parseRelativePath: (value: string) => string,
): Promise<ResolvedNotePathResult> {
  const validatedPath = parseRelativePath(relativePath);
  throwIfAborted(signal);
  const candidatePath = resolve(vault.absolute_path, ...validatedPath.split("/"));
  assertWithinRoot(vault.absolute_path, candidatePath);
  const inspection = await inspectExistingPath(candidatePath, signal);
  if (inspection.kind === "missing") {
    return { kind: "missing" };
  }
  if (!inspection.stats.isFile()) {
    throw new ObsidianReadError(
      "note_not_file",
      "指定されたMarkdownパスは通常ファイルではありません。",
    );
  }
  let preOpenStats: BigIntStats;
  try {
    throwIfAborted(signal);
    preOpenStats = await stat(candidatePath, { bigint: true });
    throwIfAborted(signal);
  } catch (error) {
    if (isMissingFileSystemError(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
  if (!preOpenStats.isFile()) {
    throw new ObsidianReadError(
      "note_not_file",
      "指定されたMarkdownパスは通常ファイルではありません。",
    );
  }
  assertSameFileIdentity(inspection.stats, preOpenStats);
  throwIfAborted(signal);
  const realCandidatePath = await realpath(candidatePath);
  throwIfAborted(signal);
  assertWithinRoot(vault.real_path, realCandidatePath);
  return {
    kind: "resolved",
    relative_path: validatedPath,
    absolute_path: realCandidatePath,
    read_path: candidatePath,
    pre_open_stats: preOpenStats,
  };
}
