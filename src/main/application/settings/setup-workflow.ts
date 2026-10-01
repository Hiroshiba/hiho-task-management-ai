import { z } from "zod";
import {
  assertStateKindTyped,
  requiresContextRevalidation,
  sameSectionGids,
  validateAbortSignal,
  validateSetupPorts,
} from "./setup-validation";
import {
  stateCodexAvailability,
  updateStateCodexAvailability,
} from "./setup-codex-state";
import {
  configuredSectionGidsFor,
  coordinateSetupResources,
  listSetupWorkspaces,
  resolveSetupProject,
  revalidateSetupResources,
  selectSetupWorkspace,
  type ResourceResult,
} from "./setup-asana-resources";
import { assessSetupCapability } from "./setup-capability";
import { SetupAsanaAuthorization } from "./setup-asana-authorization";
import {
  chooseSetupVault,
  completeSetupCodexCapability,
  runSetupFullSync,
} from "./setup-completion";
import type {
  SetupAsanaAuthorizationBeginInput,
  SetupAsanaAuthorizationCancelInput,
  SetupAsanaAuthorizationCompleteInput,
  SetupCodexAvailability,
  SetupProject,
  SetupProjectSelectionInput,
  SetupState,
  SetupVaultChoiceInput,
  SetupWorkspace,
  SetupWorkspaceSelectionInput,
} from "../../domain/setup-state";
import type { DeviceSettingsRecord } from "../common/ports/settings-repository";
import { createSetupStateTools } from "./setup-state-tools";
import type {
  SetupAsanaPort,
  SetupCapabilityFailureReporter,
  SetupCapabilityPort,
  SetupCheckpointPort,
  SetupCodexPort,
  SetupDatabasePort,
  SetupFullSyncPort,
  SetupOrchestratorOptions,
  SetupResourcePort,
  SetupRuntimeContracts,
} from "./setup-ports";

const setupOrchestratorOptionsSchema = z.object({
  device_id: z.string(),
  codex: z.unknown(),
  oauth: z.unknown(),
  asana: z.unknown(),
  resources: z.unknown(),
  capability: z.unknown(),
  reportCapabilityFailure: z.unknown(),
  database: z.unknown(),
  checkpoint: z.unknown(),
  fullSync: z.unknown(),
  contracts: z.unknown(),
}).strict();

type AsanaAuthorizationPendingState = Extract<SetupState, { kind: "asana_authorization_pending" }>;

/** 初回設定の順序付き状態機械を調整します。 */
export class SetupOrchestrator {
  private readonly deviceId: string;
  private readonly contracts: SetupRuntimeContracts;
  private readonly stateTools: ReturnType<typeof createSetupStateTools>;
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
  private readonly fullSync: SetupFullSyncPort;
  private state: SetupState;
  private resumeRequired: boolean;
  private codexAvailability: SetupCodexAvailability | undefined;

  public constructor(options: SetupOrchestratorOptions) {
    setupOrchestratorOptionsSchema.parse(options);
    this.contracts = options.contracts;
    this.stateTools = createSetupStateTools(this.contracts.validation);
    this.deviceId = this.contracts.validation.parseId(options.device_id);
    validateSetupPorts(options);
    this.codex = options.codex;
    this.asanaAuthorization = new SetupAsanaAuthorization({
      begin: (input, signal) => options.oauth.beginInitialOutOfBandAuthorization(input, signal),
      parseBeginResult: (value) => this.contracts.parseOAuthBeginResult(value),
      complete: (input, signal) => options.oauth.completeOutOfBandAuthorization(input, signal),
      parseCompleteResult: (value) => this.contracts.parseOAuthCompleteResult(value),
      cancel: (input) => options.oauth.cancelOutOfBandAuthorization(input),
      cancelByAuthorizationId: (authorizationId) =>
        options.oauth.cancelOutOfBandAuthorization({ authorization_id: authorizationId }),
      getOutOfBandState: () => options.oauth.getOutOfBandState(),
      parseOutOfBandState: (value) => this.contracts.parseOAuthState(value),
      parseState: (value) => this.contracts.validation.parseState(value),
      commitState: (state) => {
        this.state = state;
        return this.getState();
      },
      resetPendingState: (state) => this.resetAsanaAuthorizationPendingState(state),
      createInProgressError: () => this.contracts.createOAuthInProgressError(),
      createIdMismatchError: () => this.contracts.createOAuthIdMismatchError(),
    });
    this.asana = options.asana;
    this.resources = options.resources;
    this.capability = options.capability;
    this.reportCapabilityFailure = options.reportCapabilityFailure;
    this.database = options.database;
    this.checkpoint = options.checkpoint;
    this.fullSync = options.fullSync;
    const initialState = this.stateTools.parseState({
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
      const restoredState = this.stateTools.parseState(savedState);
      this.state = restoredState;
      this.codexAvailability = stateCodexAvailability(
        restoredState, (value) => this.contracts.validation.parseCodexAvailability(value),
      );
      this.resumeRequired = requiresContextRevalidation(restoredState);
    }
  }

  /** 現在の初回設定状態を取得します。 */
  public getState(): SetupState {
    const state = this.stateTools.parseState(this.state);
    if (state.kind === "asana_authorization_pending") {
      return this.asanaAuthorization.currentPendingState(state);
    }
    this.checkpoint.save(state);
    return state;
  }

  private resetAsanaAuthorizationPendingState(
    state: AsanaAuthorizationPendingState,
  ): Extract<SetupState, { kind: "credentials_required" }> {
    const nextState = this.stateTools.credentialsRequiredState(state.codex);
    this.state = nextState;
    this.checkpoint.save(nextState);
    return nextState;
  }

  /** readyチェックポイントから非秘密の端末設定を復元します。 */
  public restoreReadyDeviceSettings(): DeviceSettingsRecord {
    const state = this.state;
    assertStateKindTyped(state, ["ready"]);
    const checkpointSettings = this.contracts.parseDeviceSettings({
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
    const settings = this.contracts.parseDeviceSettings(savedSettings);
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
      parseState: (value) => this.contracts.validation.parseState(value),
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
    const state = this.stateTools.parseState(this.state);
    const availability = stateCodexAvailability(
      state, (value) => this.contracts.validation.parseCodexAvailability(value),
    );
    if (
      availability == null
      || availability.kind === "available"
      || availability.reason_code === "disabled"
    ) {
      return state;
    }
    const detected = this.contracts.validation.parseCodexAvailability(
      await this.codex.detectCli(signal),
    );
    signal.throwIfAborted();
    const nextState = updateStateCodexAvailability(state, detected, {
      parseAvailability: (value) => this.contracts.validation.parseCodexAvailability(value),
      parseState: (value) => this.contracts.validation.parseState(value),
    });
    this.checkpoint.save(nextState);
    this.state = nextState;
    this.codexAvailability = detected;
    return this.stateTools.parseState(nextState);
  }

  /** 現在のCodex利用状態を保存済み初回設定へ反映します。 */
  public updateCodexAvailability(
    availability: SetupCodexAvailability,
  ): SetupState {
    const validatedAvailability = this.contracts.validation.parseCodexAvailability(availability);
    const nextState = updateStateCodexAvailability(this.state, validatedAvailability, {
      parseAvailability: (value) => this.contracts.validation.parseCodexAvailability(value),
      parseState: (value) => this.contracts.validation.parseState(value),
    });
    this.checkpoint.save(nextState);
    this.state = nextState;
    this.codexAvailability = validatedAvailability;
    return this.stateTools.parseState(nextState);
  }

  /** Codex CLIとChatGPTログイン状態を確認します。 */
  public async start(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    assertStateKindTyped(this.state, ["created", "codex_cli_ready"]);
    if (this.state.kind === "created") {
      const availability = this.contracts.validation.parseCodexAvailability(
        await this.codex.detectCli(signal),
      );
      this.codexAvailability = availability;
      if (availability.kind === "unavailable") {
        this.state = this.stateTools.parseState({
          kind: "credentials_required",
          step: "credentials",
          codex: availability,
        });
        return this.getState();
      }
      this.state = this.stateTools.parseState({
        kind: "codex_cli_ready",
        step: "codex_authentication",
        codex: availability,
      });
      this.checkpoint.save(this.state);
    }
    const authenticationState = this.contracts.validation.parseCodexAuthenticationState(
      await this.codex.getAuthenticationState(signal),
    );
    if (authenticationState.kind === "unavailable") {
      this.codexAvailability = authenticationState;
      this.state = this.stateTools.parseState({
        kind: "credentials_required",
        step: "credentials",
        codex: authenticationState,
      });
      return this.getState();
    }
    if (authenticationState.kind === "required") {
      this.state = this.stateTools.parseState({
        kind: "codex_authentication_required",
        step: "codex_authentication",
        codex: this.stateTools.requireCodexAvailable(this.codexAvailability),
      });
      return this.getState();
    }
    if (authenticationState.kind !== "authenticated") {
      throw new Error("Codexの認証状態が不正です。");
    }
    this.state = this.stateTools.parseState({
      kind: "credentials_required",
      step: "credentials",
      codex: this.stateTools.requireCodexAvailability(this.codexAvailability),
    });
    return this.getState();
  }

  /** 初回設定中または設定済み状態のChatGPT再認証を完了します。 */
  public async completeCodexAuthentication(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    if (this.state.kind === "created" || this.state.kind === "codex_cli_ready") {
      throw new Error("現在の初回設定状態ではCodex認証を完了できません。");
    }
    const authenticationState = this.contracts.validation.parseCodexAuthenticationState(
      await this.codex.completeAuthentication(signal),
    );
    if (authenticationState.kind === "required") {
      const availability = this.stateTools.requireCodexAvailable(
        this.contracts.validation.parseCodexAvailability({ kind: "available" }),
      );
      this.codexAvailability = availability;
      if (this.state.kind === "codex_authentication_required") {
        this.state = this.stateTools.parseState({
          ...this.state,
          codex: availability,
        });
      } else {
        this.state = updateStateCodexAvailability(this.state, availability, {
          parseAvailability: (value) => this.contracts.validation.parseCodexAvailability(value),
          parseState: (value) => this.contracts.validation.parseState(value),
        });
      }
      return this.getState();
    }
    const availability = authenticationState.kind === "authenticated"
      ? this.contracts.validation.parseCodexAvailability({ kind: "available" })
      : authenticationState;
    this.codexAvailability = availability;
    this.state = updateStateCodexAvailability(this.state, availability, {
          parseAvailability: (value) => this.contracts.validation.parseCodexAvailability(value),
          parseState: (value) => this.contracts.validation.parseState(value),
        });
    return this.getState();
  }

  /** Asana OAuth認可を開始して認可コード入力を待機します。 */
  public async beginAsanaAuthorization(
    input: SetupAsanaAuthorizationBeginInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = this.contracts.validation.parseAsanaAuthorizationBeginInput(input);
    assertStateKindTyped(this.state, ["credentials_required"]);
    return this.asanaAuthorization.begin(
      validatedInput,
      () => this.stateTools.requireCodexAvailability(this.codexAvailability),
      signal,
    );
  }

  /** Asana OAuth認可コードを完了してワークスペース取得へ進みます。 */
  public async completeAsanaAuthorization(
    input: SetupAsanaAuthorizationCompleteInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = this.contracts.validation.parseAsanaAuthorizationCompleteInput(input);
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
    const validatedInput = this.contracts.validation.parseAsanaAuthorizationCancelInput(input);
    assertStateKindTyped(this.state, ["asana_authorization_pending"]);
    return this.asanaAuthorization.cancel(this.state, validatedInput);
  }

  /** Asanaのワークスペース一覧を取得します。 */
  public async listWorkspaces(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    assertStateKindTyped(this.state, ["workspace_listing_required"]);
    this.state = await listSetupWorkspaces(
      this.state.client_id,
      this.stateTools.requireCodexAvailability(this.codexAvailability),
      signal,
      {
        listWorkspaces: (operationSignal) => this.asana.listCurrentUserWorkspaces(operationSignal),
        parseWorkspace: (value) => this.contracts.validation.parseWorkspace(value),
        parseState: (value) => this.contracts.validation.parseState(value),
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
    const validatedInput = this.contracts.validation.parseWorkspaceSelectionInput(input);
    assertStateKindTyped(this.state, ["workspace_selection_required"]);
    this.state = await selectSetupWorkspace(this.state, validatedInput.workspace_gid, signal, {
      listProjects: (workspaceGid, operationSignal) =>
        this.asana.listWorkspaceProjects(workspaceGid, operationSignal),
      parseProject: this.stateTools.parseProjectReference,
      parseState: (value) => this.contracts.validation.parseState(value),
    });
    return this.getState();
  }

  /** 既存プロジェクトを選択するか専用プロジェクトを作成します。 */
  public async selectProject(
    input: SetupProjectSelectionInput,
    signal: AbortSignal,
  ): Promise<SetupState> {
    validateAbortSignal(signal);
    const validatedInput = this.contracts.validation.parseProjectSelectionInput(input);
    assertStateKindTyped(this.state, ["project_selection_required", "project_requires_action"]);
    const projectState = this.state;
    if (
      validatedInput.kind === "create"
      && projectState.projects.some((candidate) => candidate.name === validatedInput.name)
    ) {
      this.state = this.stateTools.parseState({
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
      parseProject: (value) => this.contracts.validation.parseProject(value),
    });
    const configuredSectionGids = validatedInput.kind === "existing"
      ? configuredSectionGidsFor(projectState.client_id, projectState.workspace, project, {
          getDeviceSettings: () => this.database.getDeviceSettings(),
          parseDeviceSettings: (value) => this.contracts.parseDeviceSettings(value),
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
          parseDeviceSettings: (value) => this.contracts.parseDeviceSettings(value),
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
    const capabilityInput: Parameters<SetupCapabilityPort["check"]>[0] = {
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
      parseResult: (value) => this.contracts.parseCapabilityResult(value),
      isCapabilityError: this.contracts.isCapabilityError,
      hasRestAsanaHttpError: this.contracts.hasRestAsanaHttpError,
      reportCapabilityFailure: (error) => this.reportCapabilityFailure(error),
    });
    if (result.kind === "failed") {
      this.state = this.stateTools.parseState({
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
      this.state = this.stateTools.parseState({
        kind: "full_sync_required",
        step: "full_sync",
        context,
      });
      return this.getState();
    }
    this.state = this.stateTools.parseState({
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
    const validatedInput = this.contracts.validation.parseVaultChoiceInput(input);
    assertStateKindTyped(this.state, ["vault_choice_required"]);
    this.state = await chooseSetupVault(validatedInput, this.state.context, signal, {
      validatePath: this.contracts.validateVaultPath,
      parseMapping: (value) => this.contracts.parseVaultMapping(value),
      saveMapping: (mapping) => this.database.saveVaultMapping(mapping),
      parseState: (value) => this.contracts.validation.parseState(value),
    });
    return this.getState();
  }

  /** 初回設定用のフル同期を完了します。 */
  public async runFullSync(signal: AbortSignal): Promise<SetupState> {
    validateAbortSignal(signal);
    this.assertResumeCompleted();
    assertStateKindTyped(this.state, ["full_sync_required"]);
    return runSetupFullSync(this.state, signal, {
      parseState: (value) => this.contracts.validation.parseState(value),
      setState: (state) => { this.state = state; },
      saveCheckpoint: (state) => this.checkpoint.save(state),
      parseFullSyncInput: (value) => this.contracts.validation.parseFullSyncInput(value),
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
      parseAvailability: (value) => this.contracts.validation.parseCodexAvailability(value),
      saveDeviceSettings: (settings) => this.database.saveDeviceSettings(settings),
      parseState: (value) => this.contracts.validation.parseState(value),
    });
    return this.getState();
  }

  private async coordinateResources(
    input: {
      readonly client_id: string;
      readonly workspace: SetupWorkspace;
      readonly project: SetupProject;
      readonly configured_section_gids: DeviceSettingsRecord["section_gids"] | undefined;
    },
    signal: AbortSignal,
  ): Promise<SetupState> {
    this.state = await coordinateSetupResources(input, signal, {
      deviceId: this.deviceId,
      codexAvailability: this.stateTools.requireCodexAvailability(this.codexAvailability),
      coordinate: (resourceInput, operationSignal) =>
        this.resources.coordinate(resourceInput, operationSignal),
      parseResourceResult: (value) => this.parseResourceResult(value),
      parseState: (value) => this.contracts.validation.parseState(value),
    });
    return this.getState();
  }

  private parseResourceResult(
    result: ResourceResult,
  ): ResourceResult {
    const parsed = this.contracts.parseResourceResult(result);
    if (parsed.kind === "requires_action") {
      return parsed;
    }
    const sectionGids = {
      not_started: parsed.section_gids.not_started,
      in_progress: parsed.section_gids.in_progress,
      completed: parsed.section_gids.completed,
      withdrawn: parsed.section_gids.withdrawn,
    };
    const tagGids = this.contracts.validation.parseTagGids({
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
