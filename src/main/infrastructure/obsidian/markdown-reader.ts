import type { BigIntStats } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import {
  isValidRelativeMarkdownPath,
  isoDateTimeSchema,
  maximumExcerptCharacters,
  maximumHeadingCount,
  maximumOutputBytes,
  maximumScannedFiles,
  maximumWorkers,
  parseRelativeMarkdownPath,
  obsidianNoteReadFoundSchema,
} from "../../domain/obsidian-contracts";
import { ObsidianReadError } from "./read-error";
import {
  inspectExistingPath,
  resolveNotePathWithinVault,
  throwIfAborted,
  type MissingPath,
  type RegisteredVault,
  type ResolvedNotePath,
} from "./vault-path-security";
import { readFileWithLimit, reserveReadBytes, type ReadBudget } from "./secure-note-reader";

const getUtf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

type ParsedNote = {
  readonly kind: "found";
  readonly relative_path: string;
  readonly title: string;
  readonly headings: readonly string[];
  readonly frontmatter?: string;
  readonly body: string;
};

type ParsedNoteWithStats = {
  readonly note: ParsedNote;
  readonly stats: BigIntStats;
};

/** Vault読み取り結果の容量を確認します。 */
export function assertOutputBudget(values: readonly string[]): void {
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
  const validated = obsidianNoteReadFoundSchema.parse(parsed);
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

/** Vault内のMarkdownノートを読み取ります。 */
export async function readMarkdownNote(
  vault: RegisteredVault,
  relativePath: string,
  signal: AbortSignal,
  budget: ReadBudget,
): Promise<ParsedNote | MissingPath> {
  const resolved = await resolveNotePathWithinVault(
    vault, relativePath, signal, parseRelativeMarkdownPath,
  );
  if (resolved.kind === "missing") {
    return resolved;
  }
  const result = await readMarkdownNoteFromResolvedPath(resolved, signal, budget);
  return result.note;
}

/** 検証済みのMarkdownパスからノートを読み取ります。 */
export async function readMarkdownNoteFromResolvedPath(
  resolved: ResolvedNotePath,
  signal: AbortSignal,
  budget: ReadBudget,
): Promise<ParsedNoteWithStats> {
  let buffer: Buffer;
  let stats: BigIntStats;
  try {
    const readResult = await readFileWithLimit(resolved, signal);
    buffer = readResult.buffer;
    stats = readResult.stats;
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
  const note = parseMarkdown(resolved.relative_path, decodeUtf8(buffer));
  assertOutputBudget([
    note.relative_path,
    note.title,
    ...note.headings,
    ...(note.frontmatter == null ? [] : [note.frontmatter]),
    note.body,
  ]);
  return { note, stats };
}

/** Vault内のMarkdownパスを安全に収集します。 */
export async function collectMarkdownPaths(
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

/** ファイル更新日時をISO日時へ変換します。 */
export function modifiedAtFromMtimeNs(mtimeNs: bigint): string {
  const milliseconds = Number(mtimeNs / 1_000_000n);
  if (!Number.isSafeInteger(milliseconds)) {
    throw new ObsidianReadError(
      "file_read_failed",
      "Markdownファイルの更新日時を確認できません。",
    );
  }
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new ObsidianReadError(
      "file_read_failed",
      "Markdownファイルの更新日時を確認できません。",
    );
  }
  return isoDateTimeSchema.parse(date.toISOString());
}

/** 最近更新されたノートの候補パスを収集します。 */
export async function collectRecentNotePaths(
  vault: RegisteredVault,
  signal: AbortSignal,
): Promise<readonly ResolvedNotePath[]> {
  const paths = await collectMarkdownPaths(vault, signal);
  const resolvedPaths: ResolvedNotePath[] = [];
  for (const path of paths) {
    throwIfAborted(signal);
    const resolved = await resolveNotePathWithinVault(
      vault, path, signal, parseRelativeMarkdownPath,
    );
    if (resolved.kind === "missing") {
      throw new ObsidianReadError(
        "path_changed",
        "Vault走査中にMarkdownファイルが消失しました。",
      );
    }
    resolvedPaths.push(resolved);
  }
  return resolvedPaths;
}

/** Vault内の複数ノートを容量上限内で読み取ります。 */
export async function readMarkdownNotes(
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

/** 検索一致箇所の抜粋を生成します。 */
export function createExcerpt(note: ParsedNote, query: string): string {
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

/** ノートが検索文字列と一致するか調べます。 */
export function matchesSearch(note: ParsedNote, query: string): boolean {
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
