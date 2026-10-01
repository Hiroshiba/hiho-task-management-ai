import { z } from "zod";

const identifierSchema = z.string().min(1).max(200).regex(/^\S+$/u);
const nameSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      value.trim().length > 0 &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
      }),
  );
const referenceSchema = z.object({ gid: identifierSchema, name: nameSchema }).strict();
const codexSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: z.enum([
        "not_installed",
        "incompatible",
        "permission_denied",
        "startup_failed",
        "disabled",
      ]),
    })
    .strict(),
]);
const availableCodexSchema = z.object({ kind: z.literal("available") }).strict();
const sectionGidsSchema = z
  .object({
    not_started: identifierSchema,
    in_progress: identifierSchema,
    completed: identifierSchema,
    withdrawn: identifierSchema,
  })
  .strict()
  .refine((value) => new Set(Object.values(value)).size === 4);
const tagGidsSchema = z
  .object({
    importance_1: identifierSchema,
    importance_2: identifierSchema,
    importance_3: identifierSchema,
    importance_4: identifierSchema,
    importance_5: identifierSchema,
    area_unclassified: identifierSchema,
    block_none: identifierSchema,
    block_partial: identifierSchema,
    block_full: identifierSchema,
  })
  .strict()
  .refine((value) => new Set(Object.values(value)).size === 9);
const contextSchema = z
  .object({
    device_id: identifierSchema,
    client_id: identifierSchema,
    workspace_gid: identifierSchema,
    workspace_name: nameSchema,
    project_gid: identifierSchema,
    project_name: nameSchema,
    section_gids: sectionGidsSchema,
    tag_gids: tagGidsSchema,
    codex: codexSchema,
  })
  .strict();
const contextWithTestTaskSchema = contextSchema
  .extend({ test_task_gid: identifierSchema })
  .strict();
const unavailableReasonSchema = z.enum([
  "unsupported_platform",
  "safe_execution_boundary_unavailable",
  "credential_storage_unavailable",
  "startup_failed",
]);
const channelIdsSchema = z
  .array(z.string().regex(/^[1-9][0-9]{16,19}$/u))
  .min(1)
  .max(16)
  .refine((value) => new Set(value).size === value.length);
const externalToolSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skipped") }).strict(),
  z
    .object({
      kind: z.literal("configured"),
      tool_id: z.literal("discord-context"),
      allowed_channel_ids: channelIdsSchema,
    })
    .strict(),
  z.object({ kind: z.literal("unavailable"), reason_code: unavailableReasonSchema }).strict(),
]);
const resourceIssueSchema = z
  .object({
    resource: z.enum(["section", "tag"]),
    name: nameSchema,
    reason: z.enum(["duplicate", "renamed", "configured_missing"]),
    configured_gid: identifierSchema.optional(),
  })
  .strict();

/** 旧v2初回設定状態を厳密に検証します。 */
export const checkpointV2StateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), step: z.literal("codex_cli") }).strict(),
  z
    .object({
      kind: z.literal("codex_cli_ready"),
      step: z.literal("codex_authentication"),
      codex: availableCodexSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex_authentication_required"),
      step: z.literal("codex_authentication"),
      codex: availableCodexSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("credentials_required"),
      step: z.literal("credentials"),
      codex: codexSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("asana_authorization_pending"),
      step: z.literal("credentials"),
      client_id: identifierSchema,
      authorization_id: z
        .string()
        .length(43)
        .regex(/^[A-Za-z0-9_-]+$/u),
      expires_at: z.iso.datetime({ offset: true }),
      codex: codexSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_listing_required"),
      step: z.literal("workspace"),
      client_id: identifierSchema,
      codex: codexSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("workspace_selection_required"),
      step: z.literal("workspace"),
      client_id: identifierSchema,
      codex: codexSchema,
      workspaces: z.array(referenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_selection_required"),
      step: z.literal("project"),
      client_id: identifierSchema,
      codex: codexSchema,
      workspace: referenceSchema,
      projects: z.array(referenceSchema),
    })
    .strict(),
  z
    .object({
      kind: z.literal("project_requires_action"),
      step: z.literal("project"),
      client_id: identifierSchema,
      codex: codexSchema,
      workspace: referenceSchema,
      projects: z.array(referenceSchema),
      reason_code: z.literal("duplicate_project_name"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resources_requires_action"),
      step: z.literal("resources"),
      client_id: identifierSchema,
      codex: codexSchema,
      workspace: referenceSchema,
      project: referenceSchema,
      issues: z.array(resourceIssueSchema).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("resources_ready"),
      step: z.literal("asana_capability"),
      context: contextSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("asana_capability_failed"),
      step: z.literal("asana_capability"),
      context: contextSchema,
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
      test_task_gid: identifierSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("vault_choice_required"),
      step: z.literal("vault"),
      context: contextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("vault_skipped"),
      step: z.literal("external_tool"),
      context: contextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("vault_configured"),
      step: z.literal("external_tool"),
      context: contextWithTestTaskSchema,
      vault_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_tool_skipped"),
      step: z.literal("full_sync"),
      context: contextWithTestTaskSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_tool_configured"),
      step: z.literal("full_sync"),
      context: contextWithTestTaskSchema,
      tool_id: z.literal("discord-context"),
      allowed_channel_ids: channelIdsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_tool_unavailable"),
      step: z.literal("full_sync"),
      context: contextWithTestTaskSchema,
      reason_code: unavailableReasonSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("full_sync_required"),
      step: z.literal("full_sync"),
      context: contextWithTestTaskSchema,
      external_tool: externalToolSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("codex_capability_required"),
      step: z.literal("codex_capability"),
      context: contextWithTestTaskSchema,
      external_tool: externalToolSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("ready"),
      step: z.literal("ready"),
      context: contextWithTestTaskSchema,
      external_tool: externalToolSchema,
    })
    .strict(),
]);

/** 旧v2チェックポイントを検証します。 */
export const checkpointV2Schema = z
  .object({ version: z.literal(2), state: checkpointV2StateSchema })
  .strict();

export type CheckpointV2State = z.infer<typeof checkpointV2StateSchema>;
