import { z } from "zod";

import {
  AsanaOAuthOutOfBandAuthenticationInProgressError,
  AsanaOAuthOutOfBandAuthorizationIdMismatchError,
  asanaOAuthCoordinatorResultSchema,
  oauthOutOfBandBeginResultSchema,
  oauthOutOfBandStateSchema,
  type AsanaOAuthCoordinator,
  type OAuthOutOfBandState,
} from "../auth/asana-oauth";
import {
  AsanaCapabilityCheckError,
  type AsanaCapabilityCheckInput,
  type AsanaCapabilityCheckResult,
  type AsanaCapabilityCheckService,
  AsanaSetupResourceCoordinator,
  asanaSetupResourceCoordinatorResultSchema,
  capabilityCheckResultSchema,
  type AsanaSetupResourceCoordinatorResult,
  type SetupReconciliationResult,
} from "../asana/setup";
import type { AsanaSetupClient } from "../asana/client/setup-client";
import { validateVaultMappingPath } from "../obsidian";
import type { StorageDatabase } from "../storage";
import type { DeviceSettings, VaultMapping } from "../../shared/storage";
import {
  configuredTagGidsSchema,
  codexUnavailableReasonSchema,
  setupAsanaAuthorizationBeginInputSchema,
  setupAsanaAuthorizationCancelInputSchema,
  setupAsanaAuthorizationCompleteInputSchema,
  setupCodexAvailabilitySchema,
  setupDiscordExternalToolConfigurationInputSchema,
  setupExternalToolChoiceInputSchema,
  setupExternalToolSelectionSchema,
  setupExternalToolUnavailableReasonSchema,
  setupProjectSchema,
  setupProjectSelectionInputSchema,
  setupStateSchema,
  setupVaultChoiceInputSchema,
  setupWorkspaceSchema,
  setupWorkspaceSelectionInputSchema,
  type SetupAsanaAuthorizationBeginInput,
  type SetupAsanaAuthorizationCancelInput,
  type SetupAsanaAuthorizationCompleteInput,
  type SetupCodexAvailability,
  type SetupDiscordExternalToolConfigurationInput,
  type SetupExternalToolChoiceInput,
  type SetupExternalToolSelection,
  type SetupExternalToolUnavailableReason,
  type SetupProject,
  type SetupProjectSelectionInput,
  type SetupResourceIssue,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspace,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import {
  deviceSectionGidsSchema,
  deviceSettingsSchema,
  vaultMappingSchema,
} from "../../shared/storage";
import { gidSchema, identifierSchema } from "../../shared/domain";

type SetupCodexAuthenticationState =
  | { readonly kind: "authenticated" }
  | { readonly kind: "required" }
  | Extract<SetupCodexAvailability, { kind: "unavailable" }>;
const setupCodexAuthenticationStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("authenticated") }).strict(),
  z.object({ kind: z.literal("required") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: codexUnavailableReasonSchema,
    })
    .strict(),
]);

export type SetupCodexPort = {
  readonly detectCli: (signal: AbortSignal) => Promise<SetupCodexAvailability>;
  readonly getAuthenticationState: (
    signal: AbortSignal,
  ) => Promise<SetupCodexAuthenticationState>;
  readonly completeAuthentication: (
    signal: AbortSignal,
  ) => Promise<SetupCodexAvailability>;
  readonly checkCapabilities: (
    signal: AbortSignal,
  ) => Promise<SetupCodexAvailability>;
};

export type SetupOAuthPort = Pick<
  AsanaOAuthCoordinator,
  | "beginInitialOutOfBandAuthorization"
  | "completeOutOfBandAuthorization"
  | "cancelOutOfBandAuthorization"
  | "getOutOfBandState"
>;

export type SetupAsanaPort = Pick<
  AsanaSetupClient,
  | "listCurrentUserWorkspaces"
  | "listWorkspaceProjects"
  | "createProject"
>;

export type SetupResourcePort = Pick<
  AsanaSetupResourceCoordinator,
  "coordinate"
>;

export type SetupCapabilityPort = Pick<
  AsanaCapabilityCheckService,
  "check"
>;

export type SetupDatabasePort = Pick<
  StorageDatabase,
  "saveDeviceSettings" | "getDeviceSettings" | "saveVaultMapping"
>;

export type SetupCheckpointPort = {
  readonly load: () => SetupState | undefined;
  readonly save: (state: SetupState) => void;
};

export type SetupExternalToolConfigurationResult =
  | {
      readonly kind: "configured";
      readonly tool_id: "discord-context";
      readonly allowed_channel_ids: readonly string[];
    }
  | {
      readonly kind: "unavailable";
      readonly reason_code: SetupExternalToolUnavailableReason;
    };

export type SetupExternalToolDeactivationResult =
  | { readonly kind: "deactivated" }
  | {
      readonly kind: "unavailable";
      readonly reason_code: SetupExternalToolUnavailableReason;
    };

export type SetupExternalToolPort = {
  readonly configureDiscord: (
    input: SetupDiscordExternalToolConfigurationInput,
    signal: AbortSignal,
  ) => Promise<SetupExternalToolConfigurationResult>;
  readonly deactivateDiscord: (
    signal: AbortSignal,
  ) => Promise<SetupExternalToolDeactivationResult>;
};

const setupExternalToolConfigurationResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("configured"),
      tool_id: z.literal("discord-context"),
      allowed_channel_ids:
        setupDiscordExternalToolConfigurationInputSchema.shape.allowed_channel_ids,
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: setupExternalToolUnavailableReasonSchema,
    })
    .strict(),
]);

const setupExternalToolDeactivationResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deactivated") }).strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      reason_code: setupExternalToolUnavailableReasonSchema,
    })
    .strict(),
]);

export type SetupFullSyncInput = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly project_gid: string;
  readonly section_gids: z.infer<typeof deviceSectionGidsSchema>;
};

export type SetupFullSyncPort = (
  input: SetupFullSyncInput,
  signal: AbortSignal,
) => Promise<void>;

export const setupFullSyncInputSchema = z
  .object({
    device_id: identifierSchema,
    client_id: identifierSchema,
    workspace_gid: gidSchema,
    project_gid: gidSchema,
    section_gids: deviceSectionGidsSchema,
  })
  .strict();

export type SetupOrchestratorOptions = {
  readonly device_id: string;
  readonly codex: SetupCodexPort;
  readonly oauth: SetupOAuthPort;
  readonly asana: SetupAsanaPort;
  readonly resources: SetupResourcePort;
  readonly capability: SetupCapabilityPort;
  readonly database: SetupDatabasePort;
  readonly checkpoint: SetupCheckpointPort;
  readonly externalTool: SetupExternalToolPort;
  readonly fullSync: SetupFullSyncPort;
};

const setupOrchestratorOptionsSchema = z
  .object({
    device_id: identifierSchema,
    codex: z.unknown(),
    oauth: z.unknown(),
    asana: z.unknown(),
    resources: z.unknown(),
    capability: z.unknown(),
    database: z.unknown(),
    checkpoint: z.unknown(),
    externalTool: z.unknown(),
    fullSync: z.unknown(),
  })
  .strict();

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

function validateFunction(value: unknown, message: string): void {
  if (typeof value !== "function") {
    throw new TypeError(message);
  }
}

function assertStateKindTyped<K extends SetupState["kind"]>(
  state: SetupState,
  kinds: readonly K[],
): asserts state is Extract<SetupState, { kind: K }> {
  for (const kind of kinds) {
    if (kind === state.kind) {
      return;
    }
  }
  throw new Error("初期設定の手順順序が不正です。");
}

function parseWorkspace(value: unknown): SetupWorkspace {
  return setupWorkspaceSchema.parse(value);
}

function parseWorkspaces(values: readonly unknown[]): SetupWorkspace[] {
  const workspaces = values.map((value) => parseWorkspace(value));
  const gids = new Set<string>();
  for (const workspace of workspaces) {
    if (gids.has(workspace.gid)) {
      throw new Error("ワークスペースGIDが重複しています。");
    }
    gids.add(workspace.gid);
  }
  if (workspaces.length === 0) {
    throw new Error("利用可能なワークスペースがありません。");
  }
  return workspaces;
}

function parseProjectReference(value: unknown): SetupProject {
  const parsed = z
    .object({ gid: gidSchema, name: z.string().min(1) })
    .strip()
    .parse(value);
  return setupProjectSchema.parse(parsed);
}

function parseProjects(values: readonly unknown[]): SetupProject[] {
  const projects = values.map((value) => parseProjectReference(value));
  const gids = new Set<string>();
  for (const project of projects) {
    if (gids.has(project.gid)) {
      throw new Error("プロジェクトGIDが重複しています。");
    }
    gids.add(project.gid);
  }
  return projects;
}

function mapResourceIssues(
  reconciliation: SetupReconciliationResult,
): SetupResourceIssue[] {
  if (reconciliation.kind !== "requires_action") {
    throw new Error("初期設定リソースの要対応結果が不正です。");
  }
  const issues: SetupResourceIssue[] = [];
  for (const check of reconciliation.sections) {
    if (check.kind === "duplicate") {
      issues.push({ resource: "section", name: check.required.name, reason: "duplicate" });
    } else if (check.kind === "renamed") {
      issues.push({
        resource: "section",
        name: check.required.name,
        reason: "renamed",
        configured_gid: check.configured_gid,
      });
    } else if (check.kind === "missing" && check.configured_gid != null) {
      issues.push({
        resource: "section",
        name: check.required.name,
        reason: "configured_missing",
        configured_gid: check.configured_gid,
      });
    }
  }
  for (const check of reconciliation.tags) {
    if (check.kind === "duplicate") {
      issues.push({ resource: "tag", name: check.required.name, reason: "duplicate" });
    } else if (check.kind === "renamed") {
      issues.push({
        resource: "tag",
        name: check.required.name,
        reason: "renamed",
        configured_gid: check.configured_gid,
      });
    } else if (check.kind === "missing" && check.configured_gid != null) {
      issues.push({
        resource: "tag",
        name: check.required.name,
        reason: "configured_missing",
        configured_gid: check.configured_gid,
      });
    }
  }
  if (issues.length === 0) {
    throw new Error("初期設定リソースの要対応理由を確定できません。");
  }
  return issues;
}

function safeCapabilityReason(
  result: AsanaCapabilityCheckResult,
): Extract<SetupState, { kind: "asana_capability_failed" }>["reason_code"] {
  if (result.kind !== "failed") {
    throw new Error("能力検査の失敗結果が不正です。");
  }
  switch (result.reason_code) {
    case "task_create_failed":
      return "task_create_failed";
    case "task_update_failed":
      return "task_update_failed";
    case "section_move_failed":
      return "section_move_failed";
    case "tag_add_failed":
    case "tag_remove_failed":
      return "tag_update_failed";
    case "external_data_write_failed":
    case "external_data_read_failed":
    case "external_data_mismatch":
      return "external_data_failed";
    case "task_list_failed":
    case "task_withdraw_failed":
    case "readback_mismatch":
      return "read_back_failed";
  }
  throw new Error("能力検査の失敗理由が不正です。");
}

function capabilityFailureReason(
  error: unknown,
): Extract<SetupState, { kind: "asana_capability_failed" }>["reason_code"] | undefined {
  if (error instanceof AsanaCapabilityCheckError) {
    return safeCapabilityReason(error.result);
  }
  if (!(error instanceof AggregateError) || !Array.isArray(error.errors)) {
    return undefined;
  }
  if (error.errors.some((cause) => cause instanceof AsanaCapabilityCheckError)) {
    return "cleanup_failed";
  }
  return undefined;
}

function assertCapabilityReady(
  result: AsanaCapabilityCheckResult,
): Extract<AsanaCapabilityCheckResult, { kind: "ready" }> {
  if (result.kind !== "ready") {
    throw new Error("Asana能力検査が成功状態を返しませんでした。");
  }
  return result;
}

function parseState(state: SetupState): SetupState {
  return setupStateSchema.parse(state);
}

type AsanaAuthorizationPendingState = Extract<
  SetupState,
  { kind: "asana_authorization_pending" }
>;

type ActiveOutOfBandState = Extract<
  OAuthOutOfBandState,
  { kind: "opening" | "authorization_pending" | "completing" }
>;

type AuthorizationCompletionOperation =
  | { readonly kind: "idle" }
  | { readonly kind: "completing"; readonly authorizationId: string };

function isActiveOutOfBandState(
  state: OAuthOutOfBandState,
): state is ActiveOutOfBandState {
  return state.kind === "opening"
    || state.kind === "authorization_pending"
    || state.kind === "completing";
}

function credentialsRequiredState(
  codex: SetupCodexAvailability,
): Extract<SetupState, { kind: "credentials_required" }> {
  const state = setupStateSchema.parse({
    kind: "credentials_required",
    step: "credentials",
    codex,
  });
  if (state.kind !== "credentials_required") {
    throw new Error("Client ID入力状態を生成できません。");
  }
  return state;
}

function requiresContextRevalidation(state: SetupState): boolean {
  return [
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
  ].includes(state.kind);
}

function externalToolSelectionFromState(
  state: Extract<
    SetupState,
    {
      kind:
        | "external_tool_skipped"
        | "external_tool_configured"
        | "external_tool_unavailable"
        | "full_sync_required"
        | "codex_capability_required"
        | "ready";
    }
  >,
): SetupExternalToolSelection {
  switch (state.kind) {
    case "external_tool_skipped":
      return setupExternalToolSelectionSchema.parse({ kind: "skipped" });
    case "external_tool_configured":
      return setupExternalToolSelectionSchema.parse({
        kind: "configured",
        tool_id: state.tool_id,
        allowed_channel_ids: state.allowed_channel_ids,
      });
    case "external_tool_unavailable":
      return setupExternalToolSelectionSchema.parse({
        kind: "unavailable",
        reason_code: state.reason_code,
      });
    case "full_sync_required":
    case "codex_capability_required":
    case "ready":
      return setupExternalToolSelectionSchema.parse(state.external_tool);
  }
}

function sameSectionGids(
  first: z.infer<typeof deviceSectionGidsSchema>,
  second: z.infer<typeof deviceSectionGidsSchema>,
): boolean {
  return (
    first.not_started === second.not_started
    && first.in_progress === second.in_progress
    && first.completed === second.completed
    && first.withdrawn === second.withdrawn
  );
}

function sameTagGids(
  first: z.infer<typeof configuredTagGidsSchema>,
  second: z.infer<typeof configuredTagGidsSchema>,
): boolean {
  return (
    first.importance_1 === second.importance_1
    && first.importance_2 === second.importance_2
    && first.importance_3 === second.importance_3
    && first.importance_4 === second.importance_4
    && first.importance_5 === second.importance_5
    && first.area_unclassified === second.area_unclassified
    && first.block_none === second.block_none
    && first.block_partial === second.block_partial
    && first.block_full === second.block_full
  );
}

function stateCodexAvailability(
  state: SetupState,
): SetupCodexAvailability | undefined {
  if ("context" in state) {
    return setupCodexAvailabilitySchema.parse(state.context.codex);
  }
  if ("codex" in state) {
    return setupCodexAvailabilitySchema.parse(state.codex);
  }
  if (state.kind === "created") {
    return undefined;
  }
  throw new Error("保存済みCodex状態がありません。");
}

function updateStateCodexAvailability(
  state: SetupState,
  availability: SetupCodexAvailability,
): SetupState {
  const validatedAvailability = setupCodexAvailabilitySchema.parse(availability);
  switch (state.kind) {
    case "created":
    case "codex_cli_ready":
      throw new Error("現在の初回設定状態ではCodex認証を完了できません。");
    case "codex_authentication_required":
      return parseState({
        kind: "credentials_required",
        step: "credentials",
        codex: validatedAvailability,
      });
    case "credentials_required":
    case "asana_authorization_pending":
    case "workspace_listing_required":
    case "workspace_selection_required":
    case "project_selection_required":
    case "project_requires_action":
    case "resources_requires_action":
      return parseState({
        ...state,
        codex: validatedAvailability,
      });
    case "resources_ready":
    case "asana_capability_failed":
      return parseState({
        ...state,
        context: {
          ...state.context,
          codex: validatedAvailability,
        },
      });
    case "vault_choice_required":
    case "vault_skipped":
    case "vault_configured":
    case "external_tool_skipped":
    case "external_tool_configured":
    case "external_tool_unavailable":
    case "full_sync_required":
    case "codex_capability_required":
    case "ready":
      return parseState({
        ...state,
        context: {
          ...state.context,
          codex: validatedAvailability,
        },
      });
  }
}

function requireCodexAvailability(
  availability: SetupCodexAvailability | undefined,
): SetupCodexAvailability {
  if (availability == null) {
    throw new Error("Codex状態が確定していません。");
  }
  return setupCodexAvailabilitySchema.parse(availability);
}

function requireCodexAvailable(
  availability: SetupCodexAvailability | undefined,
): Extract<SetupCodexAvailability, { kind: "available" }> {
  const parsed = requireCodexAvailability(availability);
  if (parsed.kind !== "available") {
    throw new Error("Codex CLIの利用可能状態が確定していません。");
  }
  return parsed;
}

/** 初回設定の順序付き状態機械を調整します。 */
export class SetupOrchestrator {
  private readonly deviceId: string;
  private readonly codex: SetupCodexPort;
  private readonly oauth: SetupOAuthPort;
  private readonly asana: SetupAsanaPort;
  private readonly resources: SetupResourcePort;
  private readonly capability: SetupCapabilityPort;
  private readonly database: SetupDatabasePort;
  private readonly checkpoint: SetupCheckpointPort;
  private readonly externalTool: SetupExternalToolPort;
  private readonly fullSync: SetupFullSyncPort;
  private state: SetupState;
  private resumeRequired: boolean;
  private codexAvailability: SetupCodexAvailability | undefined;
  private authorizationCompletionOperation: AuthorizationCompletionOperation = {
    kind: "idle",
  };

  public constructor(options: SetupOrchestratorOptions) {
    setupOrchestratorOptionsSchema.parse(options);
    this.deviceId = identifierSchema.parse(options.device_id);
    validateFunction(options.codex.detectCli, "Codex CLI検出関数が必要です。");
    validateFunction(options.codex.getAuthenticationState, "Codex認証状態関数が必要です。");
    validateFunction(options.codex.completeAuthentication, "Codex認証完了関数が必要です。");
    validateFunction(options.codex.checkCapabilities, "Codex能力検査関数が必要です。");
    validateFunction(
      options.oauth.beginInitialOutOfBandAuthorization,
      "Asana OAuth開始関数が必要です。",
    );
    validateFunction(
      options.oauth.completeOutOfBandAuthorization,
      "Asana OAuth完了関数が必要です。",
    );
    validateFunction(
      options.oauth.cancelOutOfBandAuthorization,
      "Asana OAuth取消関数が必要です。",
    );
    validateFunction(
      options.oauth.getOutOfBandState,
      "Asana OAuth状態取得関数が必要です。",
    );
    validateFunction(options.asana.listCurrentUserWorkspaces, "ワークスペース取得関数が必要です。");
    validateFunction(options.asana.listWorkspaceProjects, "プロジェクト取得関数が必要です。");
    validateFunction(options.asana.createProject, "プロジェクト作成関数が必要です。");
    validateFunction(options.resources.coordinate, "リソース調整関数が必要です。");
    validateFunction(options.capability.check, "能力検査関数が必要です。");
    validateFunction(options.database.saveDeviceSettings, "端末設定保存関数が必要です。");
    validateFunction(options.database.getDeviceSettings, "端末設定取得関数が必要です。");
    validateFunction(options.database.saveVaultMapping, "Vault保存関数が必要です。");
    validateFunction(options.checkpoint.load, "初回設定チェックポイント取得関数が必要です。");
    validateFunction(options.checkpoint.save, "初回設定チェックポイント保存関数が必要です。");
    validateFunction(options.externalTool.configureDiscord, "Discord外部ツール設定関数が必要です。");
    validateFunction(options.externalTool.deactivateDiscord, "Discord外部ツール無効化関数が必要です。");
    validateFunction(options.fullSync, "フル同期関数が必要です。");
    this.codex = options.codex;
    this.oauth = options.oauth;
    this.asana = options.asana;
    this.resources = options.resources;
    this.capability = options.capability;
    this.database = options.database;
    this.checkpoint = options.checkpoint;
    this.externalTool = options.externalTool;
    this.fullSync = options.fullSync;
    const initialState = parseState({
      kind: "created",
      step: "codex_cli",
    });
    this.resumeRequired = false;
    this.codexAvailability = undefined;
    const savedState = this.checkpoint.load();
    if (savedState == null) {
      this.state = initialState;
      this.checkpoint.save(initialState);
    } else {
      const restoredState = parseState(savedState);
      this.state = restoredState;
      this.codexAvailability = stateCodexAvailability(restoredState);
      this.resumeRequired = requiresContextRevalidation(restoredState);
    }
  }

  /** 現在の初回設定状態を取得します。 */
  public getState(): SetupState {
    const state = parseState(this.state);
    if (state.kind === "asana_authorization_pending") {
      if (
        this.authorizationCompletionOperation.kind === "completing"
        && this.authorizationCompletionOperation.authorizationId === state.authorization_id
      ) {
        return state;
      }
      const outOfBandState = oauthOutOfBandStateSchema.parse(
        this.oauth.getOutOfBandState(),
      );
      if (isActiveOutOfBandState(outOfBandState)) {
        if (outOfBandState.authorization_id !== state.authorization_id) {
          throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
        }
        return state;
      }
      return this.resetAsanaAuthorizationPendingState(state);
    }
    this.checkpoint.save(state);
    return state;
  }

  private resetAsanaAuthorizationPendingState(
    state: AsanaAuthorizationPendingState,
  ): Extract<SetupState, { kind: "credentials_required" }> {
    const nextState = credentialsRequiredState(state.codex);
    this.state = nextState;
    this.checkpoint.save(nextState);
    return nextState;
  }

  private rethrowAfterInitialAuthorizationBeginFailure(
    authorizationId: string,
    error: unknown,
  ): never {
    try {
      const outOfBandState = oauthOutOfBandStateSchema.parse(
        this.oauth.getOutOfBandState(),
      );
      if (
        isActiveOutOfBandState(outOfBandState)
        && outOfBandState.authorization_id === authorizationId
      ) {
        this.oauth.cancelOutOfBandAuthorization({ authorization_id: authorizationId });
      }
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Asana OAuth認可開始後の後処理に失敗しました。",
        { cause: error },
      );
    }
    throw error;
  }

  /** readyチェックポイントから非秘密の端末設定を復元します。 */
  public restoreReadyDeviceSettings(): DeviceSettings {
    const state = this.state;
    assertStateKindTyped(state, ["ready"]);
    const checkpointSettings = deviceSettingsSchema.parse({
      device_id: state.context.device_id,
      client_id: state.context.client_id,
      workspace_gid: state.context.workspace_gid,
      project_gid: state.context.project_gid,
      section_gids: state.context.section_gids,
    });
    const savedSettings = this.database.getDeviceSettings();
    if (savedSettings == null) {
      this.database.saveDeviceSettings(checkpointSettings);
      return checkpointSettings;
    }
    const settings = deviceSettingsSchema.parse(savedSettings);
    if (
      settings.device_id !== checkpointSettings.device_id
      || settings.client_id !== checkpointSettings.client_id
      || settings.workspace_gid !== checkpointSettings.workspace_gid
      || settings.project_gid !== checkpointSettings.project_gid
      || !sameSectionGids(settings.section_gids, checkpointSettings.section_gids)
    ) {
      throw new Error("端末設定と保存済み初回設定が一致しません。");
    }
    return settings;
  }

  /** 保存済み初回設定をAsanaの実状態と再照合して再開します。 */
  public async resume(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    if (this.state.kind === "resources_requires_action") {
      this.resumeRequired = false;
      return this.retryResourceReconciliation(signal);
    }
    if (!requiresContextRevalidation(this.state)) {
      return this.getState();
    }
    const state = this.state;
    if (!("context" in state)) {
      throw new Error("再開対象の初回設定状態に文脈がありません。");
    }
    const refreshedResult = this.parseResourceResult(
      await this.resources.coordinate(
        {
          workspace_gid: state.context.workspace_gid,
          project_gid: state.context.project_gid,
          configured_section_gids: state.context.section_gids,
          configured_tag_gids: state.context.tag_gids,
        },
        signal,
      ),
    );
    if (refreshedResult.kind === "requires_action") {
      this.state = parseState({
        kind: "resources_requires_action",
        step: "resources",
        client_id: state.context.client_id,
        codex: state.context.codex,
        workspace: {
          gid: state.context.workspace_gid,
          name: state.context.workspace_name,
        },
        project: {
          gid: state.context.project_gid,
          name: state.context.project_name,
        },
        issues: mapResourceIssues(refreshedResult.reconciliation),
      });
      this.checkpoint.save(this.state);
      this.resumeRequired = false;
      return this.getState();
    }
    if (
      !sameSectionGids(state.context.section_gids, refreshedResult.section_gids)
      || !sameTagGids(state.context.tag_gids, refreshedResult.tag_gids)
    ) {
      throw new Error("保存済み初期設定リソースとAsanaの実状態が一致しません。");
    }
    if (state.kind === "ready") {
      this.restoreReadyDeviceSettings();
    }
    this.resumeRequired = false;
    return this.getState();
  }

  /** Codex CLIとChatGPTログイン状態を確認します。 */
  public async start(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    assertStateKindTyped(this.state, ["created", "codex_cli_ready"]);
    if (this.state.kind === "created") {
      const availability = setupCodexAvailabilitySchema.parse(
        await this.codex.detectCli(signal),
      );
      this.codexAvailability = availability;
      if (availability.kind === "unavailable") {
        this.state = parseState({
          kind: "credentials_required",
          step: "credentials",
          codex: availability,
        });
        return this.getState();
      }
      this.state = parseState({
        kind: "codex_cli_ready",
        step: "codex_authentication",
        codex: availability,
      });
      this.checkpoint.save(this.state);
    }
    const authenticationState = setupCodexAuthenticationStateSchema.parse(
      await this.codex.getAuthenticationState(signal),
    );
    if (authenticationState.kind === "unavailable") {
      this.codexAvailability = authenticationState;
      this.state = parseState({
        kind: "credentials_required",
        step: "credentials",
        codex: authenticationState,
      });
      return this.getState();
    }
    if (authenticationState.kind === "required") {
      this.state = parseState({
        kind: "codex_authentication_required",
        step: "codex_authentication",
        codex: requireCodexAvailable(this.codexAvailability),
      });
      return this.getState();
    }
    if (authenticationState.kind !== "authenticated") {
      throw new Error("Codexの認証状態が不正です。");
    }
    this.state = parseState({
      kind: "credentials_required",
      step: "credentials",
      codex: requireCodexAvailability(this.codexAvailability),
    });
    return this.getState();
  }

  /** 初回設定中または設定済み状態のChatGPT再認証を完了します。 */
  public async completeCodexAuthentication(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    if (this.state.kind === "created" || this.state.kind === "codex_cli_ready") {
      throw new Error("現在の初回設定状態ではCodex認証を完了できません。");
    }
    const availability = setupCodexAvailabilitySchema.parse(
      await this.codex.completeAuthentication(signal),
    );
    this.codexAvailability = availability;
    this.state = updateStateCodexAvailability(this.state, availability);
    return this.getState();
  }

  /** Asana OAuth認可を開始して認可コード入力を待機します。 */
  public async beginAsanaAuthorization(
    input: SetupAsanaAuthorizationBeginInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = setupAsanaAuthorizationBeginInputSchema.parse(input);
    assertStateKindTyped(this.state, ["credentials_required"]);
    const result = oauthOutOfBandBeginResultSchema.parse(
      await this.oauth.beginInitialOutOfBandAuthorization(validatedInput, signal),
    );
    try {
      const outOfBandState = oauthOutOfBandStateSchema.parse(
        this.oauth.getOutOfBandState(),
      );
      if (
        outOfBandState.kind !== "authorization_pending"
        || outOfBandState.authorization_id !== result.authorization_id
        || outOfBandState.expires_at !== result.expires_at
      ) {
        throw new Error("Asana OAuth認可の待機状態が一致しません。");
      }
      this.state = parseState({
        kind: "asana_authorization_pending",
        step: "credentials",
        client_id: validatedInput.client_id,
        authorization_id: result.authorization_id,
        expires_at: result.expires_at,
        codex: requireCodexAvailability(this.codexAvailability),
      });
      return this.getState();
    } catch (error: unknown) {
      return this.rethrowAfterInitialAuthorizationBeginFailure(
        result.authorization_id,
        error,
      );
    }
  }

  /** Asana OAuth認可コードを完了してワークスペース取得へ進みます。 */
  public async completeAsanaAuthorization(
    input: SetupAsanaAuthorizationCompleteInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = setupAsanaAuthorizationCompleteInputSchema.parse(input);
    assertStateKindTyped(this.state, ["asana_authorization_pending"]);
    const state = this.state;
    if (this.authorizationCompletionOperation.kind === "completing") {
      if (
        this.authorizationCompletionOperation.authorizationId === validatedInput.authorization_id
      ) {
        throw new AsanaOAuthOutOfBandAuthenticationInProgressError();
      }
      throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
    }
    if (validatedInput.authorization_id !== state.authorization_id) {
      throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
    }
    this.authorizationCompletionOperation = {
      kind: "completing",
      authorizationId: state.authorization_id,
    };
    try {
      const outOfBandState = oauthOutOfBandStateSchema.parse(
        this.oauth.getOutOfBandState(),
      );
      if (
        isActiveOutOfBandState(outOfBandState)
        && outOfBandState.authorization_id !== state.authorization_id
      ) {
        throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
      }
      const result = asanaOAuthCoordinatorResultSchema.parse(
        await this.oauth.completeOutOfBandAuthorization(validatedInput, signal),
      );
      if (result.kind !== "authenticated" || result.client_id !== state.client_id) {
        throw new Error("Asana OAuthの認証結果が入力と一致しません。");
      }
      this.state = parseState({
        kind: "workspace_listing_required",
        step: "workspace",
        client_id: result.client_id,
        codex: state.codex,
      });
      return this.getState();
    } catch (error: unknown) {
      this.resetAsanaAuthorizationPendingState(state);
      throw error;
    } finally {
      this.authorizationCompletionOperation = { kind: "idle" };
    }
  }

  /** Asana OAuth認可を取り消してClient ID入力へ戻ります。 */
  public cancelAsanaAuthorization(
    input: SetupAsanaAuthorizationCancelInput,
    signal: AbortSignal,
  ): SetupState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const validatedInput = setupAsanaAuthorizationCancelInputSchema.parse(input);
    assertStateKindTyped(this.state, ["asana_authorization_pending"]);
    if (this.authorizationCompletionOperation.kind !== "idle") {
      throw new AsanaOAuthOutOfBandAuthenticationInProgressError();
    }
    const state = this.state;
    if (validatedInput.authorization_id !== state.authorization_id) {
      throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
    }
    const outOfBandState = oauthOutOfBandStateSchema.parse(
      this.oauth.getOutOfBandState(),
    );
    if (!isActiveOutOfBandState(outOfBandState)) {
      return this.resetAsanaAuthorizationPendingState(state);
    }
    if (outOfBandState.authorization_id !== state.authorization_id) {
      throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
    }
    this.oauth.cancelOutOfBandAuthorization(validatedInput);
    return this.resetAsanaAuthorizationPendingState(state);
  }

  /** Asanaのワークスペース一覧を取得します。 */
  public async listWorkspaces(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    assertStateKindTyped(this.state, ["workspace_listing_required"]);
    const state = this.state;
    const workspaces = parseWorkspaces(
      await this.asana.listCurrentUserWorkspaces(signal),
    );
    this.state = parseState({
      kind: "workspace_selection_required",
      step: "workspace",
      client_id: state.client_id,
      codex: requireCodexAvailability(this.codexAvailability),
      workspaces,
    });
    return this.getState();
  }

  /** 対象ワークスペースを選択してプロジェクト一覧を取得します。 */
  public async selectWorkspace(
    input: SetupWorkspaceSelectionInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = setupWorkspaceSelectionInputSchema.parse(input);
    assertStateKindTyped(this.state, ["workspace_selection_required"]);
    const state = this.state;
    const workspace = state.workspaces.find(
      (candidate) => candidate.gid === validatedInput.workspace_gid,
    );
    if (workspace == null) {
      throw new Error("一覧にないワークスペースを選択できません。");
    }
    const projects = parseProjects(
      await this.asana.listWorkspaceProjects(workspace.gid, signal),
    );
    this.state = parseState({
      kind: "project_selection_required",
      step: "project",
      client_id: state.client_id,
      codex: state.codex,
      workspace,
      projects,
    });
    return this.getState();
  }

  /** 既存プロジェクトを選択するか専用プロジェクトを作成します。 */
  public async selectProject(
    input: SetupProjectSelectionInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = setupProjectSelectionInputSchema.parse(input);
    assertStateKindTyped(this.state, ["project_selection_required", "project_requires_action"]);
    const projectState = this.state;
    if (
      validatedInput.kind === "create"
      && projectState.projects.some((candidate) => candidate.name === validatedInput.name)
    ) {
      this.state = parseState({
        kind: "project_requires_action",
        step: "project",
        client_id: projectState.client_id,
        codex: projectState.codex,
        workspace: projectState.workspace,
        projects: projectState.projects,
        reason_code: "duplicate_project_name",
      });
      this.checkpoint.save(this.state);
      return this.getState();
    }
    const project = await this.resolveProject(projectState, validatedInput, signal);
    const configuredSectionGids = validatedInput.kind === "existing"
      ? this.configuredSectionGidsFor(projectState.client_id, projectState.workspace, project)
      : undefined;
    return this.coordinateResources(
      {
        client_id: projectState.client_id,
        workspace: projectState.workspace,
        project,
        configured_section_gids: configuredSectionGids,
      },
      signal,
    );
  }

  /** 要対応リソースを再照合します。 */
  public async retryResourceReconciliation(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    assertStateKindTyped(this.state, ["resources_requires_action"]);
    const state = this.state;
    return this.coordinateResources(
      {
        client_id: state.client_id,
        workspace: state.workspace,
        project: state.project,
        configured_section_gids: this.configuredSectionGidsFor(
          state.client_id,
          state.workspace,
          state.project,
        ),
      },
      signal,
    );
  }

  /** Asanaの実操作能力を検査します。 */
  public async runCapabilityCheck(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    this.assertResumeCompleted();
    assertStateKindTyped(this.state, ["resources_ready", "asana_capability_failed"]);
    const state = this.state;
    const capabilityInput: AsanaCapabilityCheckInput = {
      project_gid: state.context.project_gid,
      section_gids: {
        not_started: state.context.section_gids.not_started,
        in_progress: state.context.section_gids.in_progress,
        withdrawn: state.context.section_gids.withdrawn,
      },
      tag_gid: state.context.tag_gids.importance_3,
    };
    let result: AsanaCapabilityCheckResult;
    try {
      result = capabilityCheckResultSchema.parse(
        await this.capability.check(capabilityInput, signal),
      );
    } catch (error: unknown) {
      const reasonCode = capabilityFailureReason(error);
      if (reasonCode != null) {
        this.state = parseState({
          kind: "asana_capability_failed",
          step: "asana_capability",
          context: state.context,
          reason_code: reasonCode,
        });
        this.checkpoint.save(this.state);
        return this.getState();
      }
      throw error;
    }
    if (result.kind === "failed") {
      this.state = parseState({
        kind: "asana_capability_failed",
        step: "asana_capability",
        context: state.context,
        reason_code: safeCapabilityReason(result),
      });
      this.checkpoint.save(this.state);
      return this.getState();
    }
    const readyResult = assertCapabilityReady(result);
    this.state = parseState({
      kind: "vault_choice_required",
      step: "vault",
      context: {
        ...state.context,
        test_task_gid: readyResult.test_task_gid,
      },
    });
    return this.getState();
  }

  /** Vaultを設定するか明示的にスキップします。 */
  public async chooseVault(
    input: SetupVaultChoiceInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    this.assertResumeCompleted();
    const validatedInput = setupVaultChoiceInputSchema.parse(input);
    assertStateKindTyped(this.state, ["vault_choice_required"]);
    const state = this.state;
    if (validatedInput.kind === "configure") {
      const validatedVault = await validateVaultMappingPath(
        validatedInput.mapping,
        signal,
      );
      signal.throwIfAborted();
      const mapping: VaultMapping = vaultMappingSchema.parse({
        vault_id: validatedVault.vault_id,
        absolute_path: validatedVault.real_path,
      });
      this.database.saveVaultMapping(mapping);
      this.state = parseState({
        kind: "vault_configured",
        step: "external_tool",
        context: state.context,
        vault_id: mapping.vault_id,
      });
      return this.getState();
    }
    this.state = parseState({
      kind: "vault_skipped",
      step: "external_tool",
      context: state.context,
    });
    return this.getState();
  }

  /** 固定Discord読取連携を設定するか明示的にスキップします。 */
  public async chooseExternalTool(
    input: SetupExternalToolChoiceInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    this.assertResumeCompleted();
    const validatedInput = setupExternalToolChoiceInputSchema.parse(input);
    assertStateKindTyped(this.state, ["vault_skipped", "vault_configured"]);
    const state = this.state;
    if (validatedInput.kind === "configure_discord") {
      const configuration = setupDiscordExternalToolConfigurationInputSchema.parse({
        bot_token: validatedInput.bot_token,
        allowed_channel_ids: validatedInput.allowed_channel_ids,
      });
      const result = setupExternalToolConfigurationResultSchema.parse(
        await this.externalTool.configureDiscord(configuration, signal),
      );
      if (result.kind === "configured") {
        return this.commitExternalToolChoice(state, parseState({
          kind: "external_tool_configured",
          step: "full_sync",
          context: state.context,
          tool_id: result.tool_id,
          allowed_channel_ids: result.allowed_channel_ids,
        }), signal);
      }
      const deactivation = setupExternalToolDeactivationResultSchema.parse(
        await this.externalTool.deactivateDiscord(signal),
      );
      const reasonCode = deactivation.kind === "unavailable"
        ? deactivation.reason_code
        : result.reason_code;
      return this.commitExternalToolChoice(state, parseState({
        kind: "external_tool_unavailable",
        step: "full_sync",
        context: state.context,
        reason_code: reasonCode,
      }), signal);
    }
    const deactivation = setupExternalToolDeactivationResultSchema.parse(
      await this.externalTool.deactivateDiscord(signal),
    );
    if (deactivation.kind === "unavailable") {
      return this.commitExternalToolChoice(state, parseState({
        kind: "external_tool_unavailable",
        step: "full_sync",
        context: state.context,
        reason_code: deactivation.reason_code,
      }), signal);
    }
    return this.commitExternalToolChoice(state, parseState({
      kind: "external_tool_skipped",
      step: "full_sync",
      context: state.context,
    }), signal);
  }

  /** 保存済み外部ツール選択を取得します。 */
  public getExternalToolSelection(): SetupExternalToolSelection | undefined {
    switch (this.state.kind) {
      case "external_tool_skipped":
      case "external_tool_configured":
      case "external_tool_unavailable":
      case "full_sync_required":
      case "codex_capability_required":
      case "ready":
        return externalToolSelectionFromState(this.state);
      default:
        return undefined;
    }
  }

  /** 外部ツール選択を安全停止状態へ更新します。 */
  public markExternalToolUnavailable(
    reasonCode: SetupExternalToolUnavailableReason,
  ): SetupState {
    const reason = setupExternalToolUnavailableReasonSchema.parse(reasonCode);
    const state = this.state;
    let nextState: SetupState;
    switch (state.kind) {
      case "external_tool_configured":
      case "external_tool_skipped":
      case "external_tool_unavailable":
        nextState = parseState({
          kind: "external_tool_unavailable",
          step: "full_sync",
          context: state.context,
          reason_code: reason,
        });
        break;
      case "full_sync_required":
      case "codex_capability_required":
      case "ready":
        nextState = parseState({
          ...state,
          external_tool: {
            kind: "unavailable",
            reason_code: reason,
          },
        });
        break;
      default:
        throw new Error("現在の初回設定状態には外部ツール選択がありません。");
    }
    this.checkpoint.save(nextState);
    this.state = nextState;
    return parseState(nextState);
  }

  private async commitExternalToolChoice(
    previousState: Extract<SetupState, { kind: "vault_skipped" | "vault_configured" }>,
    nextState: SetupState,
    signal: AbortSignal,
  ): Promise<SetupState> {
    assertStateKindTyped(nextState, [
      "external_tool_skipped",
      "external_tool_configured",
      "external_tool_unavailable",
    ]);
    try {
      signal.throwIfAborted();
      this.checkpoint.save(nextState);
    } catch (error: unknown) {
      const deactivationSignal = new AbortController().signal;
      let deactivation: SetupExternalToolDeactivationResult;
      try {
        deactivation = setupExternalToolDeactivationResultSchema.parse(
          await this.externalTool.deactivateDiscord(deactivationSignal),
        );
      } catch (deactivationError: unknown) {
        this.state = previousState;
        throw new AggregateError(
          [error, deactivationError],
          "外部ツール選択を確定できず安全な無効化も失敗しました。",
          { cause: error },
        );
      }
      this.state = previousState;
      if (deactivation.kind === "unavailable") {
        throw new AggregateError(
          [error, new Error("外部ツール選択の確定失敗後にDiscord連携を無効化できませんでした。")],
          "外部ツール選択を確定できず安全な無効化も完了しませんでした。",
          { cause: error },
        );
      }
      throw error;
    }
    this.state = nextState;
    return parseState(nextState);
  }

  /** 初回設定用のフル同期を完了します。 */
  public async runFullSync(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    this.assertResumeCompleted();
    assertStateKindTyped(this.state, [
      "external_tool_skipped",
      "external_tool_configured",
      "external_tool_unavailable",
      "full_sync_required",
    ]);
    const state = this.state;
    const externalTool = externalToolSelectionFromState(state);
    this.state = parseState({
      kind: "full_sync_required",
      step: "full_sync",
      context: state.context,
      external_tool: externalTool,
    });
    this.checkpoint.save(this.state);
    const fullSyncInput = setupFullSyncInputSchema.parse({
        device_id: state.context.device_id,
        client_id: state.context.client_id,
        workspace_gid: state.context.workspace_gid,
        project_gid: state.context.project_gid,
        section_gids: state.context.section_gids,
    });
    await this.fullSync(fullSyncInput,
      signal,
    );
    this.state = parseState({
      kind: "codex_capability_required",
      step: "codex_capability",
      context: state.context,
      external_tool: externalTool,
    });
    return this.getState();
  }

  /** Codex能力検査を完了して初回設定をreadyにします。 */
  public async runCodexCapabilityCheck(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    this.assertResumeCompleted();
    assertStateKindTyped(this.state, ["codex_capability_required"]);
    const state = this.state;
    const availability = state.context.codex.kind === "unavailable"
      ? state.context.codex
      : setupCodexAvailabilitySchema.parse(
        await this.codex.checkCapabilities(signal),
      );
    const settings: DeviceSettings = {
      device_id: state.context.device_id,
      client_id: state.context.client_id,
      workspace_gid: state.context.workspace_gid,
      project_gid: state.context.project_gid,
      section_gids: state.context.section_gids,
    };
    this.database.saveDeviceSettings(settings);
    this.state = parseState({
      kind: "ready",
      step: "ready",
      context: {
        ...state.context,
        codex: availability,
      },
      external_tool: state.external_tool,
    });
    return this.getState();
  }

  private async resolveProject(
    state: Extract<SetupState, { kind: "project_selection_required" | "project_requires_action" }>,
    input: SetupProjectSelectionInput,
    signal: AbortSignal,
  ): Promise<SetupProject> {
    if (input.kind === "existing") {
      const selected = state.projects.find((candidate) => candidate.gid === input.project_gid);
      if (selected == null) {
        throw new Error("一覧にないプロジェクトを選択できません。");
      }
      return selected;
    }
    const created = await this.asana.createProject(state.workspace.gid, input.name, signal);
    if (created.workspace.gid !== state.workspace.gid || created.name !== input.name) {
      throw new Error("作成したプロジェクトの応答が要求と一致しません。");
    }
    const project = {
      gid: created.gid,
      name: created.name,
    };
    return setupProjectSchema.parse(project);
  }

  private async coordinateResources(
    input: {
      readonly client_id: string;
      readonly workspace: SetupWorkspace;
      readonly project: SetupProject;
      readonly configured_section_gids: z.infer<typeof deviceSectionGidsSchema> | undefined;
    },
    signal: AbortSignal,
  ): Promise<SetupState> {
    const result = await this.resources.coordinate(
      {
        workspace_gid: input.workspace.gid,
        project_gid: input.project.gid,
        ...(input.configured_section_gids == null
          ? {}
          : { configured_section_gids: input.configured_section_gids }),
      },
      signal,
    );
    const parsedResult = this.parseResourceResult(result);
    if (parsedResult.kind === "requires_action") {
      this.state = parseState({
        kind: "resources_requires_action",
        step: "resources",
        client_id: input.client_id,
        codex: requireCodexAvailability(this.codexAvailability),
        workspace: input.workspace,
        project: input.project,
        issues: mapResourceIssues(parsedResult.reconciliation),
      });
      return this.getState();
    }
    this.state = parseState({
      kind: "resources_ready",
      step: "asana_capability",
      context: {
        device_id: this.deviceId,
        client_id: input.client_id,
        workspace_gid: input.workspace.gid,
        workspace_name: input.workspace.name,
        project_gid: input.project.gid,
        project_name: input.project.name,
        section_gids: parsedResult.section_gids,
        tag_gids: parsedResult.tag_gids,
        codex: requireCodexAvailability(this.codexAvailability),
      },
    });
    return this.getState();
  }

  private parseResourceResult(
    result: AsanaSetupResourceCoordinatorResult,
  ): AsanaSetupResourceCoordinatorResult {
    const parsed = asanaSetupResourceCoordinatorResultSchema.parse(result);
    if (parsed.kind === "requires_action") {
      return parsed;
    }
    const sectionGids = {
      not_started: parsed.section_gids.not_started,
      in_progress: parsed.section_gids.in_progress,
      completed: parsed.section_gids.completed,
      withdrawn: parsed.section_gids.withdrawn,
    };
    const tagGids = configuredTagGidsSchema.parse({
      importance_1: parsed.tag_gids.importance_1,
      importance_2: parsed.tag_gids.importance_2,
      importance_3: parsed.tag_gids.importance_3,
      importance_4: parsed.tag_gids.importance_4,
      importance_5: parsed.tag_gids.importance_5,
      area_unclassified: parsed.tag_gids.area_unclassified,
      block_none: parsed.tag_gids.block_none,
      block_partial: parsed.tag_gids.block_partial,
      block_full: parsed.tag_gids.block_full,
    });
    return {
      ...parsed,
      section_gids: sectionGids,
      tag_gids: tagGids,
    };
  }

  private configuredSectionGidsFor(
    clientId: string,
    workspace: SetupWorkspace,
    project: SetupProject,
  ): z.infer<typeof deviceSectionGidsSchema> | undefined {
    const savedSettings = this.database.getDeviceSettings();
    if (savedSettings == null) {
      return undefined;
    }
    const settings = deviceSettingsSchema.parse(savedSettings);
    if (
      settings.client_id !== clientId
      || settings.workspace_gid !== workspace.gid
      || settings.project_gid !== project.gid
    ) {
      return undefined;
    }
    return settings.section_gids;
  }

  private assertResumeCompleted(): void {
    if (this.resumeRequired) {
      throw new Error("保存済み初回設定の再開検証が必要です。");
    }
  }

}
