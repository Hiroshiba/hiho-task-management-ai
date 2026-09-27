import { z } from "zod";

import {
  assertStateKindTyped,
  requiresContextRevalidation,
  sameSectionGids,
  validateAbortSignal,
  validateSetupPorts,
} from "../application/settings/setup-validation";
import {
  chooseSetupExternalTool,
  externalToolSelectionFromState,
} from "../application/settings/setup-external-tool";
import {
  stateCodexAvailability,
  updateStateCodexAvailability,
} from "../application/settings/setup-codex-state";
import {
  configuredSectionGidsFor,
  coordinateSetupResources,
  listSetupWorkspaces,
  resolveSetupProject,
  revalidateSetupResources,
  selectSetupWorkspace,
} from "../application/settings/setup-asana-resources";
import { assessSetupCapability } from "../application/settings/setup-capability";
import { SetupAsanaAuthorization } from "../application/settings/setup-asana-authorization";
import {
  chooseSetupVault,
  completeSetupCodexCapability,
  runSetupFullSync,
} from "../application/settings/setup-completion";

import {
  AsanaOAuthOutOfBandAuthenticationInProgressError,
  AsanaOAuthOutOfBandAuthorizationIdMismatchError,
  asanaOAuthCoordinatorResultSchema,
  oauthOutOfBandBeginResultSchema,
  oauthOutOfBandStateSchema,
  type AsanaOAuthCoordinator,
} from "../auth/asana-oauth";
import {
  AsanaCapabilityCheckError,
  type AsanaCapabilityCheckInput,
  type AsanaCapabilityCheckService,
  AsanaSetupResourceCoordinator,
  asanaSetupResourceCoordinatorResultSchema,
  capabilityCheckResultSchema,
  type AsanaSetupResourceCoordinatorResult,
} from "../asana/setup";
import type { AsanaSetupClient } from "../asana/client/setup-client";
import { hasRestAsanaHttpError } from "../asana/transport";
import { validateVaultMappingPath } from "../obsidian";
import type { StorageDatabase } from "../storage";
import type { DeviceSettings } from "../../shared/storage";
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
  ) => Promise<SetupCodexAuthenticationState>;
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

export type SetupCapabilityFailureReporter = (error: unknown) => void;

export type SetupDatabasePort = {
  readonly saveDeviceSettings: (settings: DeviceSettings) => void;
  readonly getDeviceSettings: () => DeviceSettings | undefined;
  readonly saveVaultMapping: StorageDatabase["saveVaultMapping"];
  readonly getVaultMappings: StorageDatabase["getVaultMappings"];
};

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
  readonly reportCapabilityFailure: SetupCapabilityFailureReporter;
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
    reportCapabilityFailure: z.unknown(),
    database: z.unknown(),
    checkpoint: z.unknown(),
    externalTool: z.unknown(),
    fullSync: z.unknown(),
  })
  .strict();

function parseProjectReference(value: unknown): SetupProject {
  const parsed = z
    .object({ gid: gidSchema, name: z.string().min(1) })
    .strip()
    .parse(value);
  return setupProjectSchema.parse(parsed);
}

function parseState(state: SetupState): SetupState {
  return setupStateSchema.parse(state);
}

type AsanaAuthorizationPendingState = Extract<
  SetupState,
  { kind: "asana_authorization_pending" }
>;

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
  private readonly asanaAuthorization: SetupAsanaAuthorization<
    SetupState,
    AsanaAuthorizationPendingState,
    SetupAsanaAuthorizationBeginInput,
    SetupAsanaAuthorizationCompleteInput,
    SetupAsanaAuthorizationCancelInput
  >;
  private readonly asana: SetupAsanaPort;
  private readonly resources: SetupResourcePort;
  private readonly capability: SetupCapabilityPort;
  private readonly reportCapabilityFailure: SetupCapabilityFailureReporter;
  private readonly database: SetupDatabasePort;
  private readonly checkpoint: SetupCheckpointPort;
  private readonly externalTool: SetupExternalToolPort;
  private readonly fullSync: SetupFullSyncPort;
  private state: SetupState;
  private resumeRequired: boolean;
  private codexAvailability: SetupCodexAvailability | undefined;

  public constructor(options: SetupOrchestratorOptions) {
    setupOrchestratorOptionsSchema.parse(options);
    this.deviceId = identifierSchema.parse(options.device_id);
    validateSetupPorts(options);
    this.codex = options.codex;
    this.asanaAuthorization = new SetupAsanaAuthorization({
      begin: (input, signal) => options.oauth.beginInitialOutOfBandAuthorization(input, signal),
      parseBeginResult: (value) => oauthOutOfBandBeginResultSchema.parse(value),
      complete: (input, signal) => options.oauth.completeOutOfBandAuthorization(input, signal),
      parseCompleteResult: (value) => asanaOAuthCoordinatorResultSchema.parse(value),
      cancel: (input) => options.oauth.cancelOutOfBandAuthorization(input),
      cancelByAuthorizationId: (authorizationId) =>
        options.oauth.cancelOutOfBandAuthorization({ authorization_id: authorizationId }),
      getOutOfBandState: () => options.oauth.getOutOfBandState(),
      parseOutOfBandState: (value) => oauthOutOfBandStateSchema.parse(value),
      parseState: (value) => setupStateSchema.parse(value),
      commitState: (state) => {
        this.state = state;
        return this.getState();
      },
      resetPendingState: (state) => this.resetAsanaAuthorizationPendingState(state),
      createInProgressError: () => new AsanaOAuthOutOfBandAuthenticationInProgressError(),
      createIdMismatchError: () => new AsanaOAuthOutOfBandAuthorizationIdMismatchError(),
    });
    this.asana = options.asana;
    this.resources = options.resources;
    this.capability = options.capability;
    this.reportCapabilityFailure = options.reportCapabilityFailure;
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
      this.codexAvailability = stateCodexAvailability(
        restoredState, (value) => setupCodexAvailabilitySchema.parse(value),
      );
      this.resumeRequired = requiresContextRevalidation(restoredState);
    }
  }

  /** 現在の初回設定状態を取得します。 */
  public getState(): SetupState {
    const state = parseState(this.state);
    if (state.kind === "asana_authorization_pending") {
      return this.asanaAuthorization.currentPendingState(state);
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
    const revalidation = await revalidateSetupResources(state.context, signal, {
      coordinate: (input, operationSignal) => this.resources.coordinate(input, operationSignal),
      parseResourceResult: (value) => this.parseResourceResult(value),
      parseState: (value) => setupStateSchema.parse(value),
    });
    if (revalidation.kind === "requires_action") {
      this.state = revalidation.state;
      this.checkpoint.save(this.state);
      this.resumeRequired = false;
      return this.getState();
    }
    if (state.kind === "ready") {
      this.restoreReadyDeviceSettings();
    }
    this.resumeRequired = false;
    return this.getState();
  }

  /** 保存済みCodex利用不可状態を現在のCLIで再検査します。 */
  public async recheckPersistedCodex(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const state = parseState(this.state);
    const availability = stateCodexAvailability(
      state, (value) => setupCodexAvailabilitySchema.parse(value),
    );
    if (
      availability == null
      || availability.kind === "available"
      || availability.reason_code === "disabled"
    ) {
      return state;
    }
    const detected = setupCodexAvailabilitySchema.parse(
      await this.codex.detectCli(signal),
    );
    signal.throwIfAborted();
    const nextState = updateStateCodexAvailability(state, detected, {
      parseAvailability: (value) => setupCodexAvailabilitySchema.parse(value),
      parseState: (value) => setupStateSchema.parse(value),
    });
    this.checkpoint.save(nextState);
    this.state = nextState;
    this.codexAvailability = detected;
    return parseState(nextState);
  }

  /** 現在のCodex利用状態を保存済み初回設定へ反映します。 */
  public updateCodexAvailability(
    availability: SetupCodexAvailability,
  ): SetupState {
    const validatedAvailability = setupCodexAvailabilitySchema.parse(availability);
    const nextState = updateStateCodexAvailability(this.state, validatedAvailability, {
      parseAvailability: (value) => setupCodexAvailabilitySchema.parse(value),
      parseState: (value) => setupStateSchema.parse(value),
    });
    this.checkpoint.save(nextState);
    this.state = nextState;
    this.codexAvailability = validatedAvailability;
    return parseState(nextState);
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
    const authenticationState = setupCodexAuthenticationStateSchema.parse(
      await this.codex.completeAuthentication(signal),
    );
    if (authenticationState.kind === "required") {
      const availability = requireCodexAvailable(
        setupCodexAvailabilitySchema.parse({ kind: "available" }),
      );
      this.codexAvailability = availability;
      if (this.state.kind === "codex_authentication_required") {
        this.state = parseState({
          ...this.state,
          codex: availability,
        });
      } else {
        this.state = updateStateCodexAvailability(this.state, availability, {
          parseAvailability: (value) => setupCodexAvailabilitySchema.parse(value),
          parseState: (value) => setupStateSchema.parse(value),
        });
      }
      return this.getState();
    }
    const availability = authenticationState.kind === "authenticated"
      ? setupCodexAvailabilitySchema.parse({ kind: "available" })
      : authenticationState;
    this.codexAvailability = availability;
    this.state = updateStateCodexAvailability(this.state, availability, {
          parseAvailability: (value) => setupCodexAvailabilitySchema.parse(value),
          parseState: (value) => setupStateSchema.parse(value),
        });
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
    return this.asanaAuthorization.begin(
      validatedInput,
      () => requireCodexAvailability(this.codexAvailability),
      signal,
    );
  }

  /** Asana OAuth認可コードを完了してワークスペース取得へ進みます。 */
  public async completeAsanaAuthorization(
    input: SetupAsanaAuthorizationCompleteInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = setupAsanaAuthorizationCompleteInputSchema.parse(input);
    assertStateKindTyped(this.state, ["asana_authorization_pending"]);
    return this.asanaAuthorization.complete(this.state, validatedInput, signal);
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
    return this.asanaAuthorization.cancel(this.state, validatedInput);
  }

  /** Asanaのワークスペース一覧を取得します。 */
  public async listWorkspaces(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    assertStateKindTyped(this.state, ["workspace_listing_required"]);
    this.state = await listSetupWorkspaces(
      this.state.client_id,
      requireCodexAvailability(this.codexAvailability),
      signal,
      {
        listWorkspaces: (operationSignal) => this.asana.listCurrentUserWorkspaces(operationSignal),
        parseWorkspace: (value) => setupWorkspaceSchema.parse(value),
        parseState: (value) => setupStateSchema.parse(value),
      },
    );
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
    this.state = await selectSetupWorkspace(this.state, validatedInput.workspace_gid, signal, {
      listProjects: (workspaceGid, operationSignal) =>
        this.asana.listWorkspaceProjects(workspaceGid, operationSignal),
      parseProject: parseProjectReference,
      parseState: (value) => setupStateSchema.parse(value),
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
    const project = await resolveSetupProject(projectState, validatedInput, signal, {
      createProject: (workspaceGid, name, operationSignal) =>
        this.asana.createProject(workspaceGid, name, operationSignal),
      parseProject: (value) => setupProjectSchema.parse(value),
    });
    const configuredSectionGids = validatedInput.kind === "existing"
      ? configuredSectionGidsFor(projectState.client_id, projectState.workspace, project, {
          getDeviceSettings: () => this.database.getDeviceSettings(),
          parseDeviceSettings: (value) => deviceSettingsSchema.parse(value),
        })
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
        configured_section_gids: configuredSectionGidsFor(state.client_id, state.workspace, state.project, {
          getDeviceSettings: () => this.database.getDeviceSettings(),
          parseDeviceSettings: (value) => deviceSettingsSchema.parse(value),
        }),
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
    const result = await assessSetupCapability(capabilityInput, signal, {
      check: (input, operationSignal) => this.capability.check(input, operationSignal),
      parseResult: (value) => capabilityCheckResultSchema.parse(value),
      isCapabilityError: (error): error is AsanaCapabilityCheckError =>
        error instanceof AsanaCapabilityCheckError,
      hasRestAsanaHttpError,
      reportCapabilityFailure: (error) => this.reportCapabilityFailure(error),
    });
    if (result.kind === "failed") {
      this.state = parseState({
        kind: "asana_capability_failed",
        step: "asana_capability",
        context: state.context,
        reason_code: result.reason_code,
      });
      this.checkpoint.save(this.state);
      return this.getState();
    }
    const context = {
      ...state.context,
      test_task_gid: result.test_task_gid,
    };
    const taskVaultMappings = this.database.getVaultMappings()
      .filter((mapping) => mapping.vault_id === "tasks");
    if (taskVaultMappings.length > 1) {
      throw new Error("tasks Vaultマッピングが重複しています。");
    }
    const taskVaultMapping = taskVaultMappings[0];
    if (taskVaultMapping != null) {
      this.state = parseState({
        kind: "vault_configured",
        step: "external_tool",
        context,
        vault_id: taskVaultMapping.vault_id,
      });
      return this.chooseExternalTool({ kind: "skip" }, signal);
    }
    this.state = parseState({
      kind: "vault_choice_required",
      step: "vault",
      context,
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
    this.state = await chooseSetupVault(validatedInput, this.state.context, signal, {
      validatePath: validateVaultMappingPath,
      parseMapping: (value) => vaultMappingSchema.parse(value),
      saveMapping: (mapping) => this.database.saveVaultMapping(mapping),
      parseState: (value) => setupStateSchema.parse(value),
    });
    return this.chooseExternalTool({ kind: "skip" }, signal);
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
    this.state = await chooseSetupExternalTool(this.state, validatedInput, signal, {
      parseConfiguration: (value) => setupDiscordExternalToolConfigurationInputSchema.parse(value),
      configureDiscord: (configuration, operationSignal) =>
        this.externalTool.configureDiscord(configuration, operationSignal),
      parseConfigurationResult: (value) => setupExternalToolConfigurationResultSchema.parse(value),
      deactivateDiscord: (operationSignal) => this.externalTool.deactivateDiscord(operationSignal),
      parseDeactivationResult: (value) => setupExternalToolDeactivationResultSchema.parse(value),
      parseState: (value) => setupStateSchema.parse(value),
      saveCheckpoint: (state) => this.checkpoint.save(state),
    });
    return parseState(this.state);
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
        return externalToolSelectionFromState(
          this.state, (value) => setupExternalToolSelectionSchema.parse(value),
        );
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
    return runSetupFullSync(this.state, signal, {
      selectExternalTool: (state) => externalToolSelectionFromState(
        state, (value) => setupExternalToolSelectionSchema.parse(value),
      ),
      parseState: (value) => setupStateSchema.parse(value),
      setState: (state) => { this.state = state; },
      saveCheckpoint: (state) => this.checkpoint.save(state),
      parseFullSyncInput: (value) => setupFullSyncInputSchema.parse(value),
      fullSync: (input, operationSignal) => this.fullSync(input, operationSignal),
      getState: () => this.getState(),
    });
  }

  /** Codex能力検査を完了して初回設定をreadyにします。 */
  public async runCodexCapabilityCheck(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    this.assertResumeCompleted();
    assertStateKindTyped(this.state, ["codex_capability_required"]);
    this.state = await completeSetupCodexCapability(this.state, signal, {
      checkCapabilities: (operationSignal) => this.codex.checkCapabilities(operationSignal),
      parseAvailability: (value) => setupCodexAvailabilitySchema.parse(value),
      saveDeviceSettings: (settings) => this.database.saveDeviceSettings(settings),
      parseState: (value) => setupStateSchema.parse(value),
    });
    return this.getState();
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
    this.state = await coordinateSetupResources(input, signal, {
      deviceId: this.deviceId,
      codexAvailability: requireCodexAvailability(this.codexAvailability),
      coordinate: (resourceInput, operationSignal) =>
        this.resources.coordinate(resourceInput, operationSignal),
      parseResourceResult: (value) => this.parseResourceResult(value),
      parseState: (value) => setupStateSchema.parse(value),
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

  private assertResumeCompleted(): void {
    if (this.resumeRequired) {
      throw new Error("保存済み初回設定の再開検証が必要です。");
    }
  }
}
