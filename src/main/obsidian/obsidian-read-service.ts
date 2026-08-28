import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  parse as parsePath,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";
import {
  getUtf8ByteLength,
  vaultIdSchema,
} from "../../shared/domain";
import {
  vaultMappingSchema,
  type VaultMapping,
} from "../../shared/storage";
import type { StorageDatabase } from "../storage";

const maximumPathBytes = 4_096;
const maximumQueryCharacters = 200;
const maximumFileBytes = 1_048_576;
const maximumScannedFiles = 10_000;
const maximumResultCount = 1_000;
const maximumTotalReadBytes = 16 * 1_024 * 1_024;
const maximumOutputBytes = 512 * 1_024;
const maximumExcerptCharacters = 240;
const maximumExcerptBytes = 1_024;
const maximumHeadingCount = 1_000;
const maximumWorkers = 5;
const maximumReadChunkBytes = 64 * 1_024;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (codePoint <= 31 || codePoint === 127);
  });
}

function hasTraversalSegment(value: string): boolean {
  const segments = sep === "\\" ? value.split(/[\\/]/u) : value.split("/");
  return segments.some((segment) => segment === "." || segment === "..");
}

function isValidRelativeMarkdownPath(value: string): boolean {
  if (
    value.length === 0
    || getUtf8ByteLength(value) > maximumPathBytes
    || value.includes("\\")
    || value.includes("\0")
    || hasControlCharacter(value)
    || isAbsolute(value)
    || /^[A-Za-z]:[\\/]/u.test(value)
    || !value.endsWith(".md")
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every((segment) =>
    segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function isValidSearchQuery(value: string): boolean {
  return (
    value.length > 0
    && [...value].length <= maximumQueryCharacters
    && getUtf8ByteLength(value) <= maximumOutputBytes
    && value.trim().length > 0
    && !hasControlCharacter(value)
  );
}

function createUtf8TextSchema(maximumBytes: number): z.ZodString {
  return z.string().refine(
    (value) => getUtf8ByteLength(value) <= maximumBytes,
    "UTF-8換算の文字列上限を超えています。",
  );
}

const absolutePathSchema = vaultMappingSchema.shape.absolute_path;

const relativeMarkdownPathSchema = z
  .string()
  .refine(isValidRelativeMarkdownPath, "Markdownの相対パスを指定してください。");

const searchQuerySchema = z
  .string()
  .refine(isValidSearchQuery, "検索文字列を指定してください。");

const vaultValidationResultSchema = z
  .object({
    vault_id: vaultIdSchema,
    absolute_path: absolutePathSchema,
    real_path: absolutePathSchema,
  })
  .strict();

const resolvedPathSchema = z
  .object({
    kind: z.literal("resolved"),
    vault_id: vaultIdSchema,
    relative_path: relativeMarkdownPathSchema,
    absolute_path: absolutePathSchema,
  })
  .strict();

const missingPathSchema = z
  .object({
    kind: z.literal("missing"),
    vault_id: vaultIdSchema,
    relative_path: relativeMarkdownPathSchema,
  })
  .strict();

const resolvedPathResultSchema = z.discriminatedUnion("kind", [
  resolvedPathSchema,
  missingPathSchema,
]);

const noteSummarySchema = z
  .object({
    relative_path: relativeMarkdownPathSchema,
    title: createUtf8TextSchema(maximumOutputBytes).refine(
      (value) => value.trim().length > 0,
      "ノートタイトルを空にできません。",
    ),
    headings: z.array(createUtf8TextSchema(maximumOutputBytes)).max(maximumHeadingCount),
  })
  .strict();

const noteSummaryArraySchema = z.array(noteSummarySchema).max(maximumResultCount);

const noteReadFoundSchema = z
  .object({
    kind: z.literal("found"),
    relative_path: relativeMarkdownPathSchema,
    title: createUtf8TextSchema(maximumOutputBytes).refine(
      (value) => value.trim().length > 0,
      "ノートタイトルを空にできません。",
    ),
    headings: z.array(createUtf8TextSchema(maximumOutputBytes)).max(maximumHeadingCount),
    frontmatter: createUtf8TextSchema(maximumOutputBytes).optional(),
    body: createUtf8TextSchema(maximumOutputBytes),
  })
  .strict();

const noteReadMissingSchema = z
  .object({
    kind: z.literal("missing"),
    relative_path: relativeMarkdownPathSchema,
  })
  .strict();

const noteReadResultSchema = z.discriminatedUnion("kind", [
  noteReadFoundSchema,
  noteReadMissingSchema,
]);

const searchResultSchema = z
  .object({
    relative_path: relativeMarkdownPathSchema,
    title: createUtf8TextSchema(maximumOutputBytes).refine(
      (value) => value.trim().length > 0,
      "ノートタイトルを空にできません。",
    ),
    headings: z.array(createUtf8TextSchema(maximumOutputBytes)).max(maximumHeadingCount),
    excerpt: createUtf8TextSchema(maximumExcerptBytes).max(
      maximumExcerptCharacters,
      "検索抜粋の文字数上限を超えています。",
    ),
  })
  .strict();

const searchResultArraySchema = z.array(searchResultSchema).max(maximumResultCount);

const obsidianErrorCodeSchema = z.enum([
  "vault_not_registered",
  "vault_unavailable",
  "vault_not_directory",
  "symlink_rejected",
  "path_security",
  "path_changed",
  "note_not_file",
  "file_read_failed",
  "invalid_utf8",
  "limit_exceeded",
]);

export type ObsidianVaultValidationResult = z.infer<
  typeof vaultValidationResultSchema
>;
export type ObsidianResolvedPathResult = z.infer<
  typeof resolvedPathResultSchema
>;
export type ObsidianNoteSummary = z.infer<typeof noteSummarySchema>;
export type ObsidianNoteReadResult = z.infer<typeof noteReadResultSchema>;
export type ObsidianSearchResult = z.infer<typeof searchResultSchema>;
export type ObsidianReadErrorCode = z.infer<typeof obsidianErrorCodeSchema>;

/** Vault読み取り処理の構造化エラーを表します。 */
export class ObsidianReadError extends Error {
  public readonly code: ObsidianReadErrorCode;

  public constructor(
    code: ObsidianReadErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ObsidianReadError";
    this.code = obsidianErrorCodeSchema.parse(code);
  }
}

/** Vault ID入力を検証するスキーマです。 */
export const obsidianVaultIdSchema = vaultIdSchema;

/** Markdown相対パス入力を検証するスキーマです。 */
export const obsidianRelativeMarkdownPathSchema = relativeMarkdownPathSchema;

/** Vault検索文字列入力を検証するスキーマです。 */
export const obsidianSearchQuerySchema = searchQuerySchema;

/** Vault検証結果を検証するスキーマです。 */
export const obsidianVaultValidationResultSchema = vaultValidationResultSchema;

/** Vault相対パス解決結果を検証するスキーマです。 */
export const obsidianResolvedPathResultSchema = resolvedPathResultSchema;

/** Vaultノート一覧結果を検証するスキーマです。 */
export const obsidianNoteSummaryArraySchema = noteSummaryArraySchema;

/** Vaultノート読取結果を検証するスキーマです。 */
export const obsidianNoteReadResultSchema = noteReadResultSchema;

/** Vaultノート検索結果を検証するスキーマです。 */
export const obsidianSearchResultArraySchema = searchResultArraySchema;

type RegisteredVault = {
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

type MissingPath = {
  readonly kind: "missing";
};

type PathInspection = ExistingPath | MissingPathInspection;

type ResolvedNotePath = {
  readonly kind: "resolved";
  readonly relative_path: string;
  readonly absolute_path: string;
  readonly read_path: string;
  readonly pre_open_stats: BigIntStats;
};

type ResolvedNotePathResult = ResolvedNotePath | MissingPath;

type ParsedNote = {
  readonly kind: "found";
  readonly relative_path: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly frontmatter?: string;
  readonly body: string;
};

type ReadBudget = {
  total_bytes: number;
};

type ReadAttempt =
  | { readonly kind: "succeeded"; readonly buffer: Buffer }
  | { readonly kind: "failed"; readonly error: unknown };

type CloseAttempt =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

function getSecureFileOpenFlags(): number {
  let flags = constants.O_RDONLY;
  if (
    process.platform !== "win32"
    && Number.isSafeInteger(constants.O_NOFOLLOW)
    && constants.O_NOFOLLOW > 0
  ) {
    flags |= constants.O_NOFOLLOW;
  }
  if (
    process.platform !== "win32"
    && Number.isSafeInteger(constants.O_NONBLOCK)
    && constants.O_NONBLOCK > 0
  ) {
    flags |= constants.O_NONBLOCK;
  }
  return flags;
}

function assertUsableFileIdentity(stats: BigIntStats): void {
  if (stats.dev < 0n || stats.ino <= 0n) {
    throw new ObsidianReadError(
      "path_security",
      "Markdownファイルの一意な識別子を確認できません。",
    );
  }
}

function assertSameFileIdentity(
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

function assertFileStateUnchanged(
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

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isMissingFileSystemError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    signal.throwIfAborted();
  }
}

function assertOutputBudget(values: readonly string[]): void {
  let totalBytes = 0;
  for (const value of values) {
    totalBytes += getUtf8ByteLength(value);
    if (totalBytes > maximumOutputBytes) {
      throw new ObsidianReadError(
        "limit_exceeded",
        "Vault読み取り結果が出力上限を超えています。",
      );
    }
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

async function inspectExistingPath(
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
  return vaultValidationResultSchema.parse({
    vault_id: validatedMapping.vault_id,
    absolute_path: absolutePath,
    real_path: realPath,
  });
}

async function resolveNotePathWithinVault(
  vault: RegisteredVault,
  relativePath: string,
  signal: AbortSignal,
): Promise<ResolvedNotePathResult> {
  const validatedPath = relativeMarkdownPathSchema.parse(relativePath);
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

function validateFileSize(size: bigint): void {
  if (size < 0n || size > BigInt(maximumFileBytes)) {
    throw new ObsidianReadError(
      "limit_exceeded",
      "Markdownファイルが一ファイルの読取上限を超えています。",
    );
  }
}

function reserveReadBytes(budget: ReadBudget, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumFileBytes) {
    throw new ObsidianReadError(
      "limit_exceeded",
      "Markdownファイルが一ファイルの読取上限を超えています。",
    );
  }
  if (budget.total_bytes + size > maximumTotalReadBytes) {
    throw new ObsidianReadError(
      "limit_exceeded",
      "Vaultの総読取量が上限を超えています。",
    );
  }
  budget.total_bytes += size;
}

async function readFileWithLimit(
  resolvedPath: ResolvedNotePath,
  signal: AbortSignal,
): Promise<Buffer> {
  let file: FileHandle;
  try {
    throwIfAborted(signal);
    file = await open(resolvedPath.read_path, getSecureFileOpenFlags());
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    const code = errorCode(error);
    if (code === "ELOOP") {
      throw new ObsidianReadError(
        "symlink_rejected",
        "シンボリックリンクのMarkdownファイルは読み取れません。",
        error,
      );
    }
    if (isMissingFileSystemError(error)) {
      throw new ObsidianReadError(
        "path_changed",
        "Markdownファイルがオープン前に消失しました。",
        error,
      );
    }
    if (
      code === "EINVAL"
      || code === "ENOTSUP"
      || code === "EOPNOTSUPP"
    ) {
      throw new ObsidianReadError(
        "path_security",
        "Markdownファイルの安全なオープンを保証できません。",
        error,
      );
    }
    throw error;
  }
  let readResult: ReadAttempt | undefined;
  try {
    throwIfAborted(signal);
    const openedStats = await file.stat({ bigint: true });
    if (!openedStats.isFile()) {
      throw new ObsidianReadError(
        "note_not_file",
        "指定されたMarkdownパスは通常ファイルではありません。",
      );
    }
    assertSameFileIdentity(resolvedPath.pre_open_stats, openedStats);
    validateFileSize(openedStats.size);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let readCompleted = false;
    while (!readCompleted && totalBytes <= maximumFileBytes) {
      throwIfAborted(signal);
      const remainingBytes = maximumFileBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(maximumReadChunkBytes, remainingBytes),
      );
      const fileReadResult = await file.read(chunk, 0, chunk.byteLength, null);
      if (fileReadResult.bytesRead === 0) {
        readCompleted = true;
        continue;
      }
      chunks.push(chunk.subarray(0, fileReadResult.bytesRead));
      totalBytes += fileReadResult.bytesRead;
      if (totalBytes > maximumFileBytes) {
        throw new ObsidianReadError(
          "limit_exceeded",
          "Markdownファイルが一ファイルの読取上限を超えています。",
        );
      }
    }
    if (!readCompleted) {
      throw new ObsidianReadError(
        "limit_exceeded",
        "Markdownファイルが一ファイルの読取上限を超えています。",
      );
    }
    if (BigInt(totalBytes) !== openedStats.size) {
      throw new ObsidianReadError(
        "path_changed",
        "Markdownファイルが読み取り中に変更されました。",
      );
    }
    throwIfAborted(signal);
    const afterReadStats = await file.stat({ bigint: true });
    if (!afterReadStats.isFile()) {
      throw new ObsidianReadError(
        "note_not_file",
        "指定されたMarkdownパスは通常ファイルではありません。",
      );
    }
    assertFileStateUnchanged(openedStats, afterReadStats);
    readResult = {
      kind: "succeeded",
      buffer: Buffer.concat(chunks, totalBytes),
    };
  } catch (error) {
    readResult = { kind: "failed", error };
  }
  let closeResult: CloseAttempt;
  try {
    await file.close();
    closeResult = { kind: "succeeded" };
  } catch (error) {
    closeResult = { kind: "failed", error };
  }
  if (readResult == null) {
    throw new Error("Markdownファイルの読取結果を取得できません。");
  }
  if (readResult.kind === "failed" && closeResult.kind === "failed") {
    throw new AggregateError(
      [readResult.error, closeResult.error],
      "Markdownファイルの読取と終了処理に失敗しました。",
      { cause: readResult.error },
    );
  }
  if (readResult.kind === "failed") {
    throw readResult.error;
  }
  if (closeResult.kind === "failed") {
    throw closeResult.error;
  }
  return readResult.buffer;
}

function decodeUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw new ObsidianReadError(
      "invalid_utf8",
      "MarkdownファイルをUTF-8として読み取れません。",
      error,
    );
  }
}

function parseMarkdown(relativePath: string, text: string): ParsedNote {
  let body = text;
  let frontmatter: string | undefined;
  const opening = /^(?:\uFEFF)?---\r?\n/u.exec(text);
  if (opening != null) {
    const closingPattern = /^(?:---|\.\.\.)\r?\n?/gmu;
    closingPattern.lastIndex = opening[0].length;
    const closing = closingPattern.exec(text);
    if (closing != null) {
      frontmatter = text.slice(opening[0].length, closing.index);
      body = text.slice(closing.index + closing[0].length);
    }
  }

  const headings: string[] = [];
  const headingPattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#?[ \t]*$/gmu;
  for (const match of body.matchAll(headingPattern)) {
    const heading = match[2];
    if (heading == null) {
      throw new Error("Markdown見出しの解析結果を取得できません。");
    }
    const normalizedHeading = heading.trim();
    if (normalizedHeading.length === 0) {
      continue;
    }
    headings.push(normalizedHeading);
    if (headings.length > maximumHeadingCount) {
      throw new ObsidianReadError(
        "limit_exceeded",
        "Markdownファイルの見出し数が上限を超えています。",
      );
    }
  }
  const fileTitle = basename(relativePath, extname(relativePath));
  const title = headings[0] ?? fileTitle;
  const parsed = {
    kind: "found",
    relative_path: relativePath,
    title,
    headings,
    ...(frontmatter == null ? {} : { frontmatter }),
    body,
  };
  const validated = noteReadFoundSchema.parse(parsed);
  return {
    kind: "found",
    relative_path: validated.relative_path,
    title: validated.title,
    headings: [...validated.headings],
    ...(validated.frontmatter == null
      ? {}
      : { frontmatter: validated.frontmatter }),
    body: validated.body,
  };
}

async function readMarkdownNote(
  vault: RegisteredVault,
  relativePath: string,
  signal: AbortSignal,
  budget: ReadBudget,
): Promise<ParsedNote | MissingPath> {
  const resolved = await resolveNotePathWithinVault(vault, relativePath, signal);
  if (resolved.kind === "missing") {
    return resolved;
  }
  let buffer: Buffer;
  try {
    buffer = await readFileWithLimit(resolved, signal);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    if (error instanceof ObsidianReadError) {
      throw error;
    }
    throw new ObsidianReadError(
      "file_read_failed",
      "Markdownファイルの読み取りに失敗しました。",
      error,
    );
  }
  reserveReadBytes(budget, buffer.byteLength);
  throwIfAborted(signal);
  const note = parseMarkdown(relativePath, decodeUtf8(buffer));
  assertOutputBudget([
    note.relative_path,
    note.title,
    ...note.headings,
    ...(note.frontmatter == null ? [] : [note.frontmatter]),
    note.body,
  ]);
  return note;
}

async function collectMarkdownPaths(
  vault: RegisteredVault,
  signal: AbortSignal,
): Promise<string[]> {
  const pendingDirectories = [vault.absolute_path];
  const paths: string[] = [];
  let scannedFiles = 0;
  while (pendingDirectories.length > 0) {
    throwIfAborted(signal);
    const directoryPath = pendingDirectories.shift();
    if (directoryPath == null) {
      throw new Error("Vault走査キューを取得できません。");
    }
    const entries = await readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      throwIfAborted(signal);
      const childPath = join(directoryPath, entry.name);
      const childInspection = await inspectExistingPath(childPath, signal);
      if (childInspection.kind === "missing") {
        throw new ObsidianReadError(
          "path_changed",
          "Vault走査中にファイルが消失しました。",
        );
      }
      if (childInspection.stats.isSymbolicLink()) {
        throw new ObsidianReadError(
          "symlink_rejected",
          "シンボリックリンクを経由するVaultパスは読み取れません。",
        );
      }
      if (childInspection.stats.isDirectory()) {
        pendingDirectories.push(childPath);
        continue;
      }
      scannedFiles += 1;
      if (scannedFiles > maximumScannedFiles) {
        throw new ObsidianReadError(
          "limit_exceeded",
          "Vaultの走査ファイル数が上限を超えています。",
        );
      }
      if (childInspection.stats.isFile() && entry.name.endsWith(".md")) {
        const candidate = relative(vault.absolute_path, childPath).split(sep).join("/");
        if (!isValidRelativeMarkdownPath(candidate)) {
          throw new ObsidianReadError(
            "path_security",
            "Vault内のMarkdown相対パスを検証できません。",
          );
        }
        paths.push(candidate);
      }
    }
  }
  paths.sort();
  return paths;
}

async function readMarkdownNotes(
  vault: RegisteredVault,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<ParsedNote[]> {
  const budget: ReadBudget = { total_bytes: 0 };
  const notes = new Array<ParsedNote | undefined>(paths.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(signal);
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= paths.length) {
        return;
      }
      const path = paths[currentIndex];
      if (path == null) {
        throw new Error("Vault走査結果の相対パスを取得できません。");
      }
      const note = await readMarkdownNote(vault, path, signal, budget);
      if (note.kind === "missing") {
        throw new ObsidianReadError(
          "path_changed",
          "Vault走査中にMarkdownファイルが消失しました。",
        );
      }
      notes[currentIndex] = note;
    }
  };
  const workerCount = Math.min(maximumWorkers, paths.length);
  await Promise.all(
    Array.from({ length: workerCount }, () => worker()),
  );
  return notes.map((note) => {
    if (note == null) {
      throw new Error("Vault読み取り結果を取得できません。");
    }
    return note;
  });
}

function createExcerpt(note: ParsedNote, query: string): string {
  const lowerQuery = query.toLowerCase();
  const searchableParts = [
    note.relative_path,
    note.title,
    ...note.headings,
    note.frontmatter ?? "",
    note.body,
  ];
  for (const part of searchableParts) {
    const index = part.toLowerCase().indexOf(lowerQuery);
    if (index < 0) {
      continue;
    }
    const start = Math.max(0, index - 80);
    const end = Math.min(part.length, index + query.length + 160);
    const excerpt = part.slice(start, end).replace(/\s+/gu, " ").trim();
    const excerptCharacters = [...excerpt];
    if (excerptCharacters.length <= maximumExcerptCharacters) {
      return excerpt;
    }
    return `${excerptCharacters.slice(0, maximumExcerptCharacters - 1).join("")}…`;
  }
  throw new Error("検索一致箇所を抜粋できません。");
}

function matchesSearch(note: ParsedNote, query: string): boolean {
  const lowerQuery = query.toLowerCase();
  return [
    note.relative_path,
    note.title,
    ...note.headings,
    note.frontmatter ?? "",
    note.body,
  ].some((part) => part.toLowerCase().includes(lowerQuery));
}

/** 登録済みVaultを検証し、安全な実体パスを返します。 */
export class ObsidianReadService {
  public constructor(private readonly database: StorageDatabase) {}

  /** 登録済みVaultの存在とディレクトリ性を検証します。 */
  public async validateVault(
    vaultId: string,
    signal: AbortSignal,
  ): Promise<ObsidianVaultValidationResult> {
    validateAbortSignal(signal);
    const vault = await this.getRegisteredVault(vaultId, signal);
    return vaultValidationResultSchema.parse(vault);
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
    return noteSummaryArraySchema.parse(result);
  }

  /** 登録済みVault内のMarkdown相対パスを安全な絶対パスへ解決します。 */
  public async resolveRelativePath(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): Promise<ObsidianResolvedPathResult> {
    validateAbortSignal(signal);
    const vault = await this.getRegisteredVault(vaultId, signal);
    const result = await resolveNotePathWithinVault(vault, relativePath, signal);
    if (result.kind === "missing") {
      return resolvedPathResultSchema.parse({
        kind: "missing",
        vault_id: vault.vault_id,
        relative_path: relativeMarkdownPathSchema.parse(relativePath),
      });
    }
    return resolvedPathResultSchema.parse({
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
    const validatedQuery = searchQuerySchema.parse(query);
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
    return searchResultArraySchema.parse(result);
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
      return noteReadResultSchema.parse({
        kind: "missing",
        relative_path: relativeMarkdownPathSchema.parse(relativePath),
      });
    }
    return noteReadResultSchema.parse(note);
  }

  private async getRegisteredVault(
    vaultId: string,
    signal: AbortSignal,
  ): Promise<RegisteredVault> {
    const validatedVaultId = obsidianVaultIdSchema.parse(vaultId);
    throwIfAborted(signal);
    const mappings = this.database.getVaultMappings();
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
