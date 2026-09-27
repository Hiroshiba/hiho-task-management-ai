import { z } from "zod";
import {
  dateTimeSchema,
  displayTextSchema,
  emptyRequestSchema,
  gidSchema,
  identifierSchema,
  responseSchema,
  type IpcResult,
} from "./common";

export const settingsChannels = {
  getState: "settings:get-state",
  start: "settings:start",
  completeCodexAuthentication: "settings:complete-codex-authentication",
  beginAsanaAuthorization: "settings:begin-asana-authorization",
  completeAsanaAuthorization: "settings:complete-asana-authorization",
  cancelAsanaAuthorization: "settings:cancel-asana-authorization",
  listWorkspaces: "settings:list-workspaces",
  selectWorkspace: "settings:select-workspace",
  selectProject: "settings:select-project",
  retryResources: "settings:retry-resources",
  runCapability: "settings:run-capability",
  chooseVault: "settings:choose-vault",
  chooseExternalTool: "settings:choose-external-tool",
  runFullSync: "settings:run-full-sync",
  runCodexCapability: "settings:run-codex-capability",
  getAsanaAuthenticationState: "settings:get-asana-authentication-state",
  beginAsanaReauthentication: "settings:begin-asana-reauthentication",
  completeAsanaReauthentication: "settings:complete-asana-reauthentication",
  cancelAsanaReauthentication: "settings:cancel-asana-reauthentication",
} satisfies Record<string, string>;

const projectSchema = z.object({ gid: gidSchema, name: displayTextSchema }).strict();
const codexAvailabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("available") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: z.enum(["not_installed", "incompatible", "permission_denied", "startup_failed", "disabled"]),
    })
    .strict(),
]);
const setupContextSchema = z
  .object({
    device_id: identifierSchema,
    client_id: identifierSchema,
    workspace_gid: gidSchema,
    workspace_name: displayTextSchema,
    project_gid: gidSchema,
    project_name: displayTextSchema,
    section_gids: z
      .object({
        not_started: gidSchema,
        in_progress: gidSchema,
        completed: gidSchema,
        withdrawn: gidSchema,
      })
      .strict(),
    tag_gids: z
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
      .strict(),
    codex: codexAvailabilitySchema,
    test_task_gid: gidSchema.optional(),
  })
  .strict();

const setupStateSchema = z
  .object({
    kind: z.enum([
      "created",
      "codex_cli_ready",
      "codex_authentication_required",
      "credentials_required",
      "asana_authorization_pending",
      "workspace_listing_required",
      "workspace_selection_required",
      "project_selection_required",
      "project_requires_action",
      "resources_requires_action",
      "resources_ready",
      "asana_capability_failed",
      "vault_choice_required",
      "vault_skipped",
      "vault_configured",
      "external_tool_skipped",
      "external_tool_configured",
      "external_tool_unavailable",
      "full_sync_required",
      "codex_capability_required",
      "ready",
    ]),
    step: z.enum([
      "codex_cli",
      "codex_authentication",
      "credentials",
      "workspace",
      "project",
      "resources",
      "asana_capability",
      "vault",
      "external_tool",
      "full_sync",
      "codex_capability",
      "ready",
    ]),
    client_id: identifierSchema.optional(),
    authorization_id: identifierSchema.optional(),
    expires_at: dateTimeSchema.optional(),
    codex: codexAvailabilitySchema.optional(),
    workspace: projectSchema.optional(),
    workspaces: z.array(projectSchema).max(1_000).optional(),
    project: projectSchema.optional(),
    projects: z.array(projectSchema).max(1_000).optional(),
    context: setupContextSchema.optional(),
    issues: z
      .array(
        z
          .object({
            resource: z.enum(["section", "tag"]),
            name: displayTextSchema,
            reason: z.enum(["duplicate", "renamed", "configured_missing"]),
            configured_gid: gidSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    test_task_gid: gidSchema.optional(),
    vault_id: identifierSchema.optional(),
    tool_id: z.literal("discord-context").optional(),
    allowed_channel_ids: z.array(identifierSchema).max(16).optional(),
    external_tool: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("skipped") }).strict(),
        z
          .object({
            kind: z.literal("configured"),
            tool_id: z.literal("discord-context"),
            allowed_channel_ids: z.array(identifierSchema).min(1).max(16),
          })
          .strict(),
        z
          .object({
            kind: z.literal("unavailable"),
            reason_code: identifierSchema,
          })
          .strict(),
      ])
      .optional(),
    reason_code: identifierSchema.optional(),
  })
  .strict();

const authIdSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const authorizationBeginSchema = z
  .object({
    client_id: identifierSchema,
    client_secret: z.string().min(1).max(1_024),
  })
  .strict();
const authorizationCompleteSchema = z
  .object({
    authorization_id: authIdSchema,
    authorization_code: z.string().min(1).max(8_192),
  })
  .strict();
const authorizationCancelSchema = z.object({ authorization_id: authIdSchema }).strict();
const projectChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("existing"), project_gid: gidSchema }).strict(),
  z.object({ kind: z.literal("create"), name: displayTextSchema }).strict(),
]);
const vaultChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skip") }).strict(),
  z
    .object({
      kind: z.literal("configure"),
      mapping: z
        .object({
          vault_id: identifierSchema,
          absolute_path: z.string().min(1).max(4_096),
        })
        .strict(),
    })
    .strict(),
]);
const externalToolChoiceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skip") }).strict(),
  z
    .object({
      kind: z.literal("configure_discord"),
      bot_token: z.string().min(1).max(4_096),
      allowed_channel_ids: z.array(identifierSchema).min(1).max(16),
    })
    .strict(),
]);

const asanaAuthenticationStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }).strict(),
  z
    .object({
      kind: z.literal("opening"),
      authorization_id: authIdSchema,
      expires_at: dateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorization_pending"),
      authorization_id: authIdSchema,
      expires_at: dateTimeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("completing"), authorization_id: authIdSchema }).strict(),
  z
    .object({
      kind: z.literal("synchronizing"),
      authorization_id: authIdSchema,
    })
    .strict(),
]);
const reauthenticationResultSchema = z
  .object({
    synced_at: dateTimeSchema,
    performed_mode: z.enum(["full", "delta"]),
    cleanup_count: z.number().int().nonnegative(),
  })
  .strict();

const setupResponseSchema = responseSchema(setupStateSchema);

export const settingsContracts = {
  getState: {
    channel: settingsChannels.getState,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  start: {
    channel: settingsChannels.start,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  completeCodexAuthentication: {
    channel: settingsChannels.completeCodexAuthentication,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  beginAsanaAuthorization: {
    channel: settingsChannels.beginAsanaAuthorization,
    request: authorizationBeginSchema,
    response: setupResponseSchema,
  },
  completeAsanaAuthorization: {
    channel: settingsChannels.completeAsanaAuthorization,
    request: authorizationCompleteSchema,
    response: setupResponseSchema,
  },
  cancelAsanaAuthorization: {
    channel: settingsChannels.cancelAsanaAuthorization,
    request: authorizationCancelSchema,
    response: setupResponseSchema,
  },
  listWorkspaces: {
    channel: settingsChannels.listWorkspaces,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  selectWorkspace: {
    channel: settingsChannels.selectWorkspace,
    request: z.object({ workspace_gid: gidSchema }).strict(),
    response: setupResponseSchema,
  },
  selectProject: {
    channel: settingsChannels.selectProject,
    request: projectChoiceSchema,
    response: setupResponseSchema,
  },
  retryResources: {
    channel: settingsChannels.retryResources,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  runCapability: {
    channel: settingsChannels.runCapability,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  chooseVault: {
    channel: settingsChannels.chooseVault,
    request: vaultChoiceSchema,
    response: setupResponseSchema,
  },
  chooseExternalTool: {
    channel: settingsChannels.chooseExternalTool,
    request: externalToolChoiceSchema,
    response: setupResponseSchema,
  },
  runFullSync: {
    channel: settingsChannels.runFullSync,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  runCodexCapability: {
    channel: settingsChannels.runCodexCapability,
    request: emptyRequestSchema,
    response: setupResponseSchema,
  },
  getAsanaAuthenticationState: {
    channel: settingsChannels.getAsanaAuthenticationState,
    request: emptyRequestSchema,
    response: responseSchema(asanaAuthenticationStateSchema),
  },
  beginAsanaReauthentication: {
    channel: settingsChannels.beginAsanaReauthentication,
    request: emptyRequestSchema,
    response: responseSchema(asanaAuthenticationStateSchema),
  },
  completeAsanaReauthentication: {
    channel: settingsChannels.completeAsanaReauthentication,
    request: authorizationCompleteSchema,
    response: responseSchema(reauthenticationResultSchema),
  },
  cancelAsanaReauthentication: {
    channel: settingsChannels.cancelAsanaReauthentication,
    request: authorizationCancelSchema,
    response: responseSchema(asanaAuthenticationStateSchema),
  },
};

type SetupResult = Promise<IpcResult<z.infer<typeof setupStateSchema>>>;

export type SettingsApi = {
  readonly getState: () => SetupResult;
  readonly start: () => SetupResult;
  readonly completeCodexAuthentication: () => SetupResult;
  readonly beginAsanaAuthorization: (input: z.infer<typeof authorizationBeginSchema>) => SetupResult;
  readonly completeAsanaAuthorization: (input: z.infer<typeof authorizationCompleteSchema>) => SetupResult;
  readonly cancelAsanaAuthorization: (input: z.infer<typeof authorizationCancelSchema>) => SetupResult;
  readonly listWorkspaces: () => SetupResult;
  readonly selectWorkspace: (workspaceGid: string) => SetupResult;
  readonly selectProject: (input: z.infer<typeof projectChoiceSchema>) => SetupResult;
  readonly retryResources: () => SetupResult;
  readonly runCapability: () => SetupResult;
  readonly chooseVault: (input: z.infer<typeof vaultChoiceSchema>) => SetupResult;
  readonly chooseExternalTool: (input: z.infer<typeof externalToolChoiceSchema>) => SetupResult;
  readonly runFullSync: () => SetupResult;
  readonly runCodexCapability: () => SetupResult;
  readonly getAsanaAuthenticationState: () => Promise<IpcResult<z.infer<typeof asanaAuthenticationStateSchema>>>;
  readonly beginAsanaReauthentication: () => Promise<IpcResult<z.infer<typeof asanaAuthenticationStateSchema>>>;
  readonly completeAsanaReauthentication: (
    input: z.infer<typeof authorizationCompleteSchema>,
  ) => Promise<IpcResult<z.infer<typeof reauthenticationResultSchema>>>;
  readonly cancelAsanaReauthentication: (
    input: z.infer<typeof authorizationCancelSchema>,
  ) => Promise<IpcResult<z.infer<typeof asanaAuthenticationStateSchema>>>;
};
