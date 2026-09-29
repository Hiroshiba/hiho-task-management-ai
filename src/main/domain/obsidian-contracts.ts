import { z } from "zod";
import {
  getUtf8ByteLength,
  hasControlCharacter,
  isoDateTimeSchema,
  vaultIdSchema,
} from "./primitives";

export { hasControlCharacter, isoDateTimeSchema };

function isAbsoluteVaultPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
}

/** Vaultと絶対パスの対応を検証します。 */
export const vaultMappingSchema = z.object({
  vault_id: vaultIdSchema,
  absolute_path: z.string().refine((value) => value.length > 0, {
    message: "空でない文字列を指定してください。",
  }).refine((value) => getUtf8ByteLength(value) <= 4_096, "Vaultの絶対パスが長さ上限を超えています。")
    .refine((value) => !value.includes("\0"), "Vaultの絶対パスにNUL文字を指定できません。")
    .refine(isAbsoluteVaultPath, "Vaultのパスは絶対パスで指定してください。"),
}).strict();

export type VaultMapping = z.infer<typeof vaultMappingSchema>;

const maximumPathBytes = 4_096;
const maximumQueryCharacters = 200;
export const maximumScannedFiles = 10_000;
export const maximumResultCount = 1_000;
export const maximumOutputBytes = 512 * 1_024;
export const maximumExcerptCharacters = 240;
const maximumExcerptBytes = 1_024;
export const maximumHeadingCount = 1_000;
export const maximumWorkers = 5;
export const maximumRecentNoteLimit = 100;

/** Markdownの相対パスを検証します。 */
export function isValidRelativeMarkdownPath(value: string): boolean {
  if (
    value.length === 0
    || getUtf8ByteLength(value) > maximumPathBytes
    || value.includes("\\")
    || value.includes("\0")
    || hasControlCharacter(value)
    || value.startsWith("/")
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

/** Markdownの相対パスを解析します。 */
export function parseRelativeMarkdownPath(value: string): string {
  return relativeMarkdownPathSchema.parse(value);
}

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

/** 読み取ったMarkdownノートを検証します。 */
export const obsidianNoteReadFoundSchema = noteReadFoundSchema;

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

export const recentNoteLimitSchema = z.number().int().min(1).max(maximumRecentNoteLimit);

const recentNoteSchema = z
  .object({
    relative_path: relativeMarkdownPathSchema,
    title: createUtf8TextSchema(maximumOutputBytes).refine(
      (value) => value.trim().length > 0,
      "ノートタイトルを空にできません。",
    ),
    headings: z.array(createUtf8TextSchema(maximumOutputBytes)).max(maximumHeadingCount),
    modified_at: isoDateTimeSchema,
  })
  .strict();

const recentNoteArraySchema = z
  .array(recentNoteSchema)
  .max(maximumRecentNoteLimit);

export type ObsidianVaultValidationResult = z.infer<
  typeof vaultValidationResultSchema
>;
export type ObsidianResolvedPathResult = z.infer<
  typeof resolvedPathResultSchema
>;
export type ObsidianNoteSummary = z.infer<typeof noteSummarySchema>;
export type ObsidianNoteReadResult = z.infer<typeof noteReadResultSchema>;
export type ObsidianSearchResult = z.infer<typeof searchResultSchema>;
export type ObsidianRecentNote = z.infer<typeof recentNoteSchema>;

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

/** Vaultの最近更新されたノート一覧結果を検証するスキーマです。 */
export const obsidianRecentNoteArraySchema = recentNoteArraySchema;
