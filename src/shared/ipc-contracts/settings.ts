import { z } from "zod";
import {
  dateTimeSchema,
  emptyRequestSchema,
  gidSchema,
  identifierSchema,
  responseSchema,
  type IpcResult,
} from "./common";
import { createSetupSchemas } from "./setup-schemas";
import { syncResultSchema } from "./tasks";
import { vaultMappingSchema } from "./vault-values";

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
  runFullSync: "settings:run-full-sync",
  runCodexCapability: "settings:run-codex-capability",
  getAsanaAuthenticationState: "settings:get-asana-authentication-state",
  beginAsanaReauthentication: "settings:begin-asana-reauthentication",
  completeAsanaReauthentication: "settings:complete-asana-reauthentication",
  cancelAsanaReauthentication: "settings:cancel-asana-reauthentication",
} satisfies Record<string, string>;

const deviceSectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .refine((value) => new Set(Object.values(value)).size === 4, "4つの状態セクションGIDはすべて異なる値で指定してください。");

const {
  setupStateSchema,
  setupAsanaAuthorizationBeginInputSchema: authorizationBeginSchema,
  setupAsanaAuthorizationCompleteInputSchema: authorizationCompleteSchema,
  setupAsanaAuthorizationCancelInputSchema: authorizationCancelSchema,
  setupWorkspaceSelectionInputSchema: workspaceSelectionSchema,
  setupProjectSelectionInputSchema: projectChoiceSchema,
  setupVaultChoiceInputSchema: vaultChoiceSchema,
} = createSetupSchemas({
  createUtf8ByteLimitedStringSchema: (maxBytes: number) => z.string().refine(
    (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
    `UTF-8換算で${maxBytes}バイト以下の文字列を指定してください。`,
  ),
  gidSchema,
  identifierSchema,
  isoDateTimeSchema: dateTimeSchema,
  deviceSectionGidsSchema,
  vaultMappingSchema,
});

export { setupStateSchema };

const authIdSchema = authorizationCompleteSchema.shape.authorization_id;

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
const reauthenticationResultSchema = syncResultSchema.pick({
  synced_at: true,
  performed_mode: true,
  normalization_notifications: true,
  conflict_count: true,
  remaining_write_count: true,
  critical_error_count: true,
  cleanup_count: true,
});

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
    request: workspaceSelectionSchema,
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
