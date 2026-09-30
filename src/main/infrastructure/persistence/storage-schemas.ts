import { z } from "zod";
import {
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
} from "../../domain";
import { vaultMappingSchema } from "../../domain/obsidian-contracts";
import { setupSectionGidsSchema } from "../../domain/setup-state";

/** 秘密情報を含まない端末設定を検証するスキーマです。 */
export const deviceSettingsSchema = z
  .object({
    device_id: identifierSchema,
    client_id: identifierSchema,
    workspace_gid: gidSchema,
    project_gid: gidSchema,
    section_gids: setupSectionGidsSchema,
  })
  .strict();

/** 外部ツールが参照する資格情報名の配列を検証するスキーマです。 */
export const externalToolCredentialReferenceNamesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0, {
        message: "資格情報参照名を空白だけにできません。",
      })
      .refine(
        (value) => ![...value].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
        }),
        {
          message: "資格情報参照名に制御文字を指定できません。",
        },
      ),
  )
  .max(64)
  .superRefine((names, context) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (seen.has(name)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じ資格情報参照名を重複して保存できません。",
        });
      }
      seen.add(name);
    });
  });

/** Vaultマッピングの配列を重複なく検証するスキーマです。 */
export const vaultMappingsSchema = z
  .array(vaultMappingSchema)
  .superRefine((mappings, context) => {
    const seen = new Set<string>();
    mappings.forEach((mapping, index) => {
      if (seen.has(mapping.vault_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "vault_id"],
          message: "同じVault IDを重複して保存できません。",
        });
        return;
      }
      seen.add(mapping.vault_id);
    });
  });

const diagnosticSeveritySchema = z.enum(["debug", "info", "warning", "error"]);

/** 診断ログの固定コードを検証するスキーマです。 */
export const diagnosticCodeSchema = z.enum([
  "app.start",
  "app.stop",
  "app.error",
  "ipc.error",
  "sync.started",
  "sync.completed",
  "sync.failed",
  "asana.http",
  "asana.auth",
  "asana.rate_limited",
  "asana.events_reset",
  "asana.not_found",
  "external_data.invalid",
  "external_data.unknown_schema",
  "external_data.too_large",
  "proposal.validation_failed",
  "proposal.conflict",
  "proposal.application",
  "codex.status",
  "codex.protocol",
  "external_tools.status",
  "storage.error",
]);

/** 構造化診断ログを検証するスキーマです。 */
export const diagnosticLogEntrySchema = z
  .object({
    occurred_at: isoDateTimeSchema,
    severity: diagnosticSeveritySchema,
    code: diagnosticCodeSchema,
    http_status: z.number().int().min(100).max(599).optional(),
    asana_gid: gidSchema.optional(),
    proposal_id: identifierSchema.optional(),
    operation_id: identifierSchema.optional(),
    app_version: identifierSchema.optional(),
    codex_version: identifierSchema.optional(),
  })
  .strict();

export const diagnosticRecordSchema = diagnosticLogEntrySchema.omit({
  occurred_at: true,
  app_version: true,
}).strict();

export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type ExternalToolCredentialReferenceNames = z.infer<
  typeof externalToolCredentialReferenceNamesSchema
>;
export type DiagnosticLogEntry = z.infer<typeof diagnosticLogEntrySchema>;
export type DiagnosticRecord = Readonly<z.infer<typeof diagnosticRecordSchema>>;
