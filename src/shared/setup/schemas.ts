import { z } from "zod";

import { gidSchema, identifierSchema } from "../domain";
import { deviceSectionGidsSchema, vaultMappingSchema } from "../storage";

const setupRedirectUriSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => !hasControlCharacter(value), "リダイレクトURIに制御文字を含めることはできません。");

const setupSafeNameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim().length > 0, "名前は空白だけにできません。")
  .refine((value) => !hasControlCharacter(value), "名前に制御文字を含めることはできません。");

const projectNameSchema = setupSafeNameSchema
  .refine((value) => value === value.trim(), "プロジェクト名の前後に空白を含めることはできません。");

const setupWorkspaceSchema = z
  .object({
    gid: gidSchema,
    name: setupSafeNameSchema,
  })
  .strict();

const setupProjectSchema = z
  .object({
    gid: gidSchema,
    name: setupSafeNameSchema,
  })
  .strict();

const configuredTagGidsSchema = z
  .object({
    importance_1: gidSchema,
    importance_2: gidSchema,
    importance_3: gidSchema,
    importance_4: gidSchema,
    importance_5: gidSchema,
    area_unclassified: gidSchema,
    block_none: gidSchema,
    block_partial: gidSchema,
    block_full: gidSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const gids = Object.values(value);
    if (new Set(gids).size !== gids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "タグGIDが重複しています。" });
    }
  });

const codexUnavailableReasonSchema = z.enum([
  "not_installed",
  "incompatible",
  "permission_denied",
  "startup_failed",
  "disabled",
]);

const setupCodexAvailabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: codexUnavailableReasonSchema,
    })
    .strict(),
]);

const setupCodexAvailableSchema = z.object({ kind: z.literal("available") }).strict();

const setupResourceIssueSchema = z
  .object({
    resource: z.enum(["section", "tag"]),
    name: setupSafeNameSchema,
    reason: z.enum(["duplicate", "renamed", "configured_missing"]),
    configured_gid: gidSchema.optional(),
  })
  .strict();

const setupContextSchema = z
  .object({
    redirect_uri: setupRedirectUriSchema,
    device_id: identifierSchema,
    client_id: identifierSchema,
    workspace_gid: gidSchema,
    workspace_name: setupSafeNameSchema,
    project_gid: gidSchema,
    project_name: setupSafeNameSchema,
    section_gids: deviceSectionGidsSchema,
    tag_gids: configuredTagGidsSchema,
    codex: setupCodexAvailabilitySchema,
  })
  .strict();

const setupContextWithTestTaskSchema = setupContextSchema
  .extend({
    test_task_gid: gidSchema,
  })
  .strict();

const setupStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("created"),
      step: z.literal("codex_cli"),
      redirect_uri: setupRedirectUriSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex_cli_ready"),
      step: z.literal("codex_authentication"),
      redirect_uri: setupRedirectUriSchema,
      codex: setupCodexAvailableSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex_authentication_required"),
      step: z.literal("codex_authentication"),
      redirect_uri: setupRedirectUriSchema,
      codex: setupCodexAvailableSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("credentials_required"),
      step: z.literal("credentials"),
      redirect_uri: setupRedirectUriSchema,
      codex: setupCodexAvailabilitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_listing_required"),
      step: z.literal("workspace"),
      redirect_uri: setupRedirectUriSchema,
      client_id: identifierSchema,
      codex: setupCodexAvailabilitySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_selection_required"),
      step: z.literal("workspace"),
      redirect_uri: setupRedirectUriSchema,
      client_id: identifierSchema,
      codex: setupCodexAvailabilitySchema,
      workspaces: z.array(setupWorkspaceSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_selection_required"),
      step: z.literal("project"),
      redirect_uri: setupRedirectUriSchema,
      client_id: identifierSchema,
      codex: setupCodexAvailabilitySchema,
      workspace: setupWorkspaceSchema,
      projects: z.array(setupProjectSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_requires_action"),
      step: z.literal("project"),
      redirect_uri: setupRedirectUriSchema,
      client_id: identifierSchema,
      codex: setupCodexAvailabilitySchema,
      workspace: setupWorkspaceSchema,
      projects: z.array(setupProjectSchema),
      reason_code: z.literal("duplicate_project_name"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resources_requires_action"),
      step: z.literal("resources"),
      redirect_uri: setupRedirectUriSchema,
      client_id: identifierSchema,
      codex: setupCodexAvailabilitySchema,
      workspace: setupWorkspaceSchema,
      project: setupProjectSchema,
      issues: z.array(setupResourceIssueSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resources_ready"),
      step: z.literal("asana_capability"),
      context: setupContextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("asana_capability_failed"),
      step: z.literal("asana_capability"),
      context: setupContextSchema,
      reason_code: z.enum([
        "task_create_failed",
        "task_update_failed",
        "section_move_failed",
        "tag_update_failed",
        "external_data_failed",
        "read_back_failed",
        "cleanup_failed",
        "unknown",
      ]),
      test_task_gid: gidSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vault_choice_required"),
      step: z.literal("vault"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("vault_skipped"),
      step: z.literal("external_tool"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("vault_configured"),
      step: z.literal("external_tool"),
      context: setupContextWithTestTaskSchema,
      vault_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_tool_skipped"),
      step: z.literal("full_sync"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_tool_configured"),
      step: z.literal("full_sync"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("full_sync_required"),
      step: z.literal("full_sync"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex_capability_required"),
      step: z.literal("codex_capability"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      step: z.literal("ready"),
      context: setupContextWithTestTaskSchema,
    })
    .strict(),
]);

const setupCredentialsInputSchema = z
  .object({
    client_id: identifierSchema,
    client_secret: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.trim().length > 0, "Client Secretは空白だけにできません。")
      .refine((value) => !hasControlCharacter(value), "Client Secretに制御文字を含めることはできません。"),
    timeout_milliseconds: z.number().int().min(1).max(2_147_483_647),
  })
  .strict();

const setupWorkspaceSelectionInputSchema = z
  .object({
    workspace_gid: gidSchema,
  })
  .strict();

const setupProjectSelectionInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("existing"),
      project_gid: gidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("create"),
      name: projectNameSchema,
    })
    .strict(),
]);

const setupVaultChoiceInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("skip"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("configure"),
      mapping: vaultMappingSchema,
    })
    .strict(),
]);

const setupExternalToolChoiceInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("skip"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("configure"),
    })
  .strict(),
]);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint == null) {
      throw new Error("文字列を検証できません。");
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export {
  configuredTagGidsSchema,
  setupCredentialsInputSchema,
  setupCodexAvailabilitySchema,
  codexUnavailableReasonSchema,
  setupExternalToolChoiceInputSchema,
  setupProjectSchema,
  setupProjectSelectionInputSchema,
  setupRedirectUriSchema,
  setupResourceIssueSchema,
  setupSafeNameSchema,
  setupStateSchema,
  setupVaultChoiceInputSchema,
  setupWorkspaceSchema,
  setupWorkspaceSelectionInputSchema,
};

export type SetupState = z.infer<typeof setupStateSchema>;
export type SetupCodexAvailability = z.infer<typeof setupCodexAvailabilitySchema>;
export type SetupCodexUnavailableReason = z.infer<typeof codexUnavailableReasonSchema>;
export type SetupCredentialsInput = z.infer<typeof setupCredentialsInputSchema>;
export type SetupExternalToolChoiceInput = z.infer<typeof setupExternalToolChoiceInputSchema>;
export type SetupProject = z.infer<typeof setupProjectSchema>;
export type SetupProjectSelectionInput = z.infer<typeof setupProjectSelectionInputSchema>;
export type SetupResourceIssue = z.infer<typeof setupResourceIssueSchema>;
export type SetupVaultChoiceInput = z.infer<typeof setupVaultChoiceInputSchema>;
export type SetupWorkspace = z.infer<typeof setupWorkspaceSchema>;
export type SetupWorkspaceSelectionInput = z.infer<typeof setupWorkspaceSelectionInputSchema>;
