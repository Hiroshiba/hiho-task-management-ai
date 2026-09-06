import { z } from "zod";
import {
  obsidianNoteReadResultSchema,
  obsidianNoteSummaryArraySchema,
  obsidianRecentNoteArraySchema,
  obsidianRelativeMarkdownPathSchema,
  obsidianSearchQuerySchema,
  obsidianSearchResultArraySchema,
  obsidianVaultIdSchema,
  type ObsidianNoteReadResult,
  type ObsidianNoteSummary,
  type ObsidianRecentNote,
  type ObsidianSearchResult,
} from "../../obsidian";
import { createUtf8ByteLimitedStringSchema } from "../../../shared/domain";

const maximumVaultCount = 1_000;
const maximumRecentNoteCount = 100;
const maximumErrorMessageBytes = 200;

const vaultsQuerySchema = z
  .object({ command: z.literal("vaults") })
  .strict();

const listQuerySchema = z
  .object({
    command: z.literal("list"),
    vault_id: obsidianVaultIdSchema,
  })
  .strict();

const searchQuerySchema = z
  .object({
    command: z.literal("search"),
    vault_id: obsidianVaultIdSchema,
    query: obsidianSearchQuerySchema,
  })
  .strict();

const readQuerySchema = z
  .object({
    command: z.literal("read"),
    vault_id: obsidianVaultIdSchema,
    relative_path: obsidianRelativeMarkdownPathSchema,
  })
  .strict();

const recentQuerySchema = z
  .object({
    command: z.literal("recent"),
    vault_id: obsidianVaultIdSchema,
    limit: z.number().int().min(1).max(maximumRecentNoteCount),
  })
  .strict();

/** Obsidian dynamic toolの要求を検証するスキーマです。 */
export const codexObsidianQuerySchema = z.discriminatedUnion("command", [
  vaultsQuerySchema,
  listQuerySchema,
  searchQuerySchema,
  readQuerySchema,
  recentQuerySchema,
]);
export type CodexObsidianQuery = z.infer<typeof codexObsidianQuerySchema>;

const vaultsSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("vaults"),
    data: z
      .object({
        vault_ids: z.array(obsidianVaultIdSchema).max(maximumVaultCount).superRefine(
          (vaultIds, context) => {
            if (new Set(vaultIds).size !== vaultIds.length) {
              context.addIssue({
                code: "custom",
                message: "Vault IDを重複して返せません。",
              });
            }
          },
        ),
      })
      .strict(),
  })
  .strict();

const listSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("list"),
    data: z
      .object({
        vault_id: obsidianVaultIdSchema,
        notes: obsidianNoteSummaryArraySchema,
      })
      .strict(),
  })
  .strict();

const searchSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("search"),
    data: z
      .object({
        vault_id: obsidianVaultIdSchema,
        query: obsidianSearchQuerySchema,
        notes: obsidianSearchResultArraySchema,
      })
      .strict(),
  })
  .strict();

const readSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("read"),
    data: z
      .object({
        vault_id: obsidianVaultIdSchema,
        note: obsidianNoteReadResultSchema,
      })
      .strict(),
  })
  .strict();

const recentSuccessResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("recent"),
    data: z
      .object({
        vault_id: obsidianVaultIdSchema,
        limit: z.number().int().min(1).max(maximumRecentNoteCount),
        notes: obsidianRecentNoteArraySchema,
      })
      .strict(),
  })
  .strict();

const errorCodeSchema = z.enum([
  "invalid_request",
  "response_too_large",
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

const errorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: errorCodeSchema,
        message: createUtf8ByteLimitedStringSchema(maximumErrorMessageBytes).min(1),
      })
      .strict(),
  })
  .strict();

/** Obsidian dynamic toolの応答を検証するスキーマです。 */
export const codexObsidianResponseSchema = z.union([
  vaultsSuccessResponseSchema,
  listSuccessResponseSchema,
  searchSuccessResponseSchema,
  readSuccessResponseSchema,
  recentSuccessResponseSchema,
  errorResponseSchema,
]);
export type CodexObsidianResponse = z.infer<typeof codexObsidianResponseSchema>;

/** Codexセッションから登録済みVaultを読み取るポートです。 */
export interface CodexObsidianReadPort {
  listVaults(signal: AbortSignal): readonly string[] | PromiseLike<readonly string[]>;
  listNotes(
    vaultId: string,
    signal: AbortSignal,
  ): PromiseLike<readonly ObsidianNoteSummary[]>;
  searchNotes(
    vaultId: string,
    query: string,
    signal: AbortSignal,
  ): PromiseLike<readonly ObsidianSearchResult[]>;
  readNote(
    vaultId: string,
    relativePath: string,
    signal: AbortSignal,
  ): PromiseLike<ObsidianNoteReadResult>;
  recentNotes(
    vaultId: string,
    limit: number,
    signal: AbortSignal,
  ): PromiseLike<readonly ObsidianRecentNote[]>;
}

function isCodexObsidianReadPort(value: unknown): value is CodexObsidianReadPort {
  if (value == null || typeof value !== "object") {
    return false;
  }
  return [
    "listVaults",
    "listNotes",
    "searchNotes",
    "readNote",
    "recentNotes",
  ].every((name) => typeof Reflect.get(value, name) === "function");
}

/** Obsidian読み取りポートを検証するスキーマです。 */
export const codexObsidianReadPortSchema = z.custom<CodexObsidianReadPort>(
  isCodexObsidianReadPort,
  "Obsidian読み取りポートが不正です。",
);
