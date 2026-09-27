import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { finalIpcContracts, type FinalTaskHubApi } from "../shared/ipc-contracts";
import type { TaskHubApi } from "../shared/task-hub-api";
import {
  ipcAiApprovalInputSchema,
  ipcAiApprovalResponseSchema,
  ipcAiCloseSessionInputSchema,
  ipcAiCloseSessionResponseSchema,
  ipcAiDeltaEventSchema,
  ipcAiEditInputSchema,
  ipcAiEditResponseSchema,
  ipcAiGetStatusResponseSchema,
  ipcAiProposalInputSchema,
  ipcAiProposalResponseSchema,
  ipcAiRejectInputSchema,
  ipcAiRejectResponseSchema,
  ipcAiSelectionInputSchema,
  ipcAiSelectionResponseSchema,
  ipcAiStartNewSessionResponseSchema,
  ipcAiStatusEventSchema,
  ipcAiTurnInputSchema,
  ipcAiTurnResponseSchema,
  ipcAsanaAuthenticationStateResponseSchema,
  ipcAsanaGetAuthenticationStateInputSchema,
  ipcAsanaBeginReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationResponseSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationResponseSchema,
  ipcAppStartupResponseSchema,
  ipcAppVersionSchema,
  ipcAppUpdateStateSchema,
  ipcAppUpdateGetStateResponseSchema,
  ipcEmptyRequestSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResponseSchema,
  ipcExternalAgentApproveInputSchema,
  ipcExternalAgentApproveResponseSchema,
  ipcExternalAgentEditInputSchema,
  ipcExternalAgentEditResponseSchema,
  ipcExternalAgentGetStateInputSchema,
  ipcExternalAgentGetStateResponseSchema,
  ipcExternalAgentRejectInputSchema,
  ipcExternalAgentRejectResponseSchema,
  ipcExternalAgentSelectInputSchema,
  ipcExternalAgentSelectResponseSchema,
  ipcExternalAgentSetEnabledInputSchema,
  ipcExternalAgentSetEnabledResponseSchema,
  ipcExternalAgentStateEventSchema,
  ipcObsidianListVaultsInputSchema,
  ipcObsidianListVaultsResponseSchema,
  ipcObsidianListVaultMappingsInputSchema,
  ipcObsidianListVaultMappingsResponseSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianPathResponseSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianOpenNoteResponseSchema,
  ipcObsidianSaveVaultMappingInputSchema,
  ipcObsidianSaveVaultMappingResponseSchema,
  ipcObsidianValidateInputSchema,
  ipcObsidianValidateResponseSchema,
  ipcReadModelOverviewInputSchema,
  ipcReadModelOverviewResponseSchema,
  ipcReadModelTaskDetailInputSchema,
  ipcReadModelTaskDetailResponseSchema,
  ipcSetupBeginAsanaAuthorizationInputSchema,
  ipcSetupCancelAsanaAuthorizationInputSchema,
  ipcSetupChooseExternalToolInputSchema,
  ipcSetupChooseVaultInputSchema,
  ipcSetupCompleteAsanaAuthorizationInputSchema,
  ipcSetupSelectProjectInputSchema,
  ipcSetupSelectWorkspaceInputSchema,
  ipcSetupStateResponseSchema,
  ipcIntegrationStatusResponseSchema,
  ipcSyncInputSchema,
  ipcSyncGetStateResponseSchema,
  ipcSyncResponseSchema,
  ipcSyncStateEventSchema,
  ipcProposalHistoryGetStatusResponseSchema,
  ipcProposalHistoryConfirmInputSchema,
  ipcProposalHistoryConfirmResponseSchema,
  ipcProposalHistorySynchronizeResponseSchema,
} from "../shared/ipc";

function invoke<TInput, TOutput>(
  channel: string,
  inputSchema: { parse(value: unknown): TInput },
  responseSchema: { parse(value: unknown): TOutput },
  input: TInput,
): Promise<TOutput> {
  const validatedInput = inputSchema.parse(input);
  return ipcRenderer.invoke(channel, validatedInput).then((value: unknown) =>
    responseSchema.parse(value));
}

function invokeEmpty<TOutput>(
  channel: string,
  responseSchema: { parse(value: unknown): TOutput },
): Promise<TOutput> {
  return invoke(channel, ipcEmptyRequestSchema, responseSchema, undefined);
}

function subscribe<T>(
  channel: string,
  subscribeChannel: string,
  unsubscribeChannel: string,
  schema: { parse(value: unknown): T },
  listener: (value: T) => void,
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("IPC購読関数が必要です。");
  }
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
    listener(schema.parse(payload));
  };
  ipcRenderer.on(channel, wrapped);
  ipcRenderer.send(subscribeChannel, undefined);
  return (): void => {
    ipcRenderer.removeListener(channel, wrapped);
    ipcRenderer.send(unsubscribeChannel, undefined);
  };
}

function invokeFinal<Request, Response>(
  contract: {
    readonly channel: string;
    readonly request: { parse(value: unknown): Request };
    readonly response: { parse(value: unknown): Response };
  },
  request: Request,
): Promise<Response> {
  const validatedRequest = contract.request.parse(request);
  return ipcRenderer.invoke(contract.channel, validatedRequest).then((value: unknown) =>
    contract.response.parse(value));
}

function subscribeFinal<Value>(
  eventContract: {
    readonly channel: string;
    readonly event: { parse(value: unknown): { subscription_id: string; value: Value } };
  },
  subscribeContract: {
    readonly channel: string;
    readonly request: { parse(value: unknown): { subscription_id: string } };
  },
  unsubscribeContract: {
    readonly channel: string;
    readonly request: { parse(value: unknown): { subscription_id: string } };
  },
  listener: (value: Value) => void,
): () => void {
  if (typeof listener !== "function") {
    throw new TypeError("IPC購読関数が必要です。");
  }
  const subscriptionId = crypto.randomUUID();
  const request = { subscription_id: subscriptionId };
  const validatedSubscribeRequest = subscribeContract.request.parse(request);
  const validatedUnsubscribeRequest = unsubscribeContract.request.parse(request);
  let active = true;
  const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
    const event = eventContract.event.parse(payload);
    if (event.subscription_id === subscriptionId) {
      listener(event.value);
    }
  };
  const unsubscribe = (): void => {
    if (!active) {
      return;
    }
    active = false;
    ipcRenderer.removeListener(eventContract.channel, wrapped);
    window.removeEventListener("unload", unsubscribe);
    ipcRenderer.send(unsubscribeContract.channel, validatedUnsubscribeRequest);
  };
  ipcRenderer.on(eventContract.channel, wrapped);
  window.addEventListener("unload", unsubscribe);
  try {
    ipcRenderer.send(subscribeContract.channel, validatedSubscribeRequest);
  } catch (error: unknown) {
    ipcRenderer.removeListener(eventContract.channel, wrapped);
    window.removeEventListener("unload", unsubscribe);
    throw error;
  }
  return unsubscribe;
}

const api: TaskHubApi & FinalTaskHubApi = {
  app: {
    getVersion: (): Promise<string> =>
      invokeEmpty("app:get-version", ipcAppVersionSchema),
    waitForStartup: () => invokeEmpty(
      "app:wait-for-startup",
      ipcAppStartupResponseSchema,
    ),
  },
  appUpdate: {
    getState: () => invokeEmpty(
      "app-update:get-state",
      ipcAppUpdateGetStateResponseSchema,
    ),
    onState: (listener) => subscribe(
      "app-update:state",
      "app-update:state:subscribe",
      "app-update:state:unsubscribe",
      ipcAppUpdateStateSchema,
      listener,
    ),
  },
  asana: {
    getAuthenticationState: () => invoke(
      "asana:get-authentication-state",
      ipcAsanaGetAuthenticationStateInputSchema,
      ipcAsanaAuthenticationStateResponseSchema,
      undefined,
    ),
    beginReauthentication: () => invoke(
      "asana:begin-reauthentication",
      ipcAsanaBeginReauthenticationInputSchema,
      ipcAsanaAuthenticationStateResponseSchema,
      undefined,
    ),
    completeReauthentication: (input) => invoke(
      "asana:complete-reauthentication",
      ipcAsanaCompleteReauthenticationInputSchema,
      ipcAsanaCompleteReauthenticationResponseSchema,
      input,
    ),
    cancelReauthentication: (input) => invoke(
      "asana:cancel-reauthentication",
      ipcAsanaCancelReauthenticationInputSchema,
      ipcAsanaCancelReauthenticationResponseSchema,
      input,
    ),
  },
  readModel: {
    getOverview: () => invoke(
      "read-model:get-overview",
      ipcReadModelOverviewInputSchema,
      ipcReadModelOverviewResponseSchema,
      undefined,
    ),
    getTaskDetail: (taskGid) => invoke(
      "read-model:get-task-detail",
      ipcReadModelTaskDetailInputSchema,
      ipcReadModelTaskDetailResponseSchema,
      { task_gid: taskGid },
    ),
  },
  sync: {
    getState: () => invokeEmpty("sync:get-state", ipcSyncGetStateResponseSchema),
    run: (input) => invoke(
      "sync:run",
      ipcSyncInputSchema,
      ipcSyncResponseSchema,
      input,
    ),
    onState: (listener) => subscribe(
      "sync:state",
      "sync:state:subscribe",
      "sync:state:unsubscribe",
      ipcSyncStateEventSchema,
      listener,
    ),
  },
  proposalHistory: {
    getStatus: () => invokeEmpty(
      "proposal-history:get-status",
      ipcProposalHistoryGetStatusResponseSchema,
    ),
    confirm: (input) => invoke(
      "proposal-history:confirm",
      ipcProposalHistoryConfirmInputSchema,
      ipcProposalHistoryConfirmResponseSchema,
      input,
    ),
    synchronize: () => invokeEmpty(
      "proposal-history:synchronize",
      ipcProposalHistorySynchronizeResponseSchema,
    ),
  },
  setup: {
    getState: () => invokeEmpty("setup:get-state", ipcSetupStateResponseSchema),
    getIntegrationStatus: () => invokeEmpty(
      "setup:get-integration-status",
      ipcIntegrationStatusResponseSchema,
    ),
    start: () => invokeEmpty("setup:start", ipcSetupStateResponseSchema),
    completeCodexAuthentication: () => invokeEmpty(
      "setup:complete-codex-authentication",
      ipcSetupStateResponseSchema,
    ),
    beginAsanaAuthorization: (input) => invoke(
      "setup:begin-asana-authorization",
      ipcSetupBeginAsanaAuthorizationInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    completeAsanaAuthorization: (input) => invoke(
      "setup:complete-asana-authorization",
      ipcSetupCompleteAsanaAuthorizationInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    cancelAsanaAuthorization: (input) => invoke(
      "setup:cancel-asana-authorization",
      ipcSetupCancelAsanaAuthorizationInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    listWorkspaces: () => invokeEmpty("setup:list-workspaces", ipcSetupStateResponseSchema),
    selectWorkspace: (input) => invoke(
      "setup:select-workspace",
      ipcSetupSelectWorkspaceInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    selectProject: (input) => invoke(
      "setup:select-project",
      ipcSetupSelectProjectInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    retryResources: () => invokeEmpty("setup:retry-resources", ipcSetupStateResponseSchema),
    runCapability: () => invokeEmpty("setup:run-capability", ipcSetupStateResponseSchema),
    chooseVault: (input) => invoke(
      "setup:choose-vault",
      ipcSetupChooseVaultInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    chooseExternalTool: (input) => invoke(
      "setup:choose-external-tool",
      ipcSetupChooseExternalToolInputSchema,
      ipcSetupStateResponseSchema,
      input,
    ),
    runFullSync: () => invokeEmpty("setup:run-full-sync", ipcSetupStateResponseSchema),
    runCodexCapability: () => invokeEmpty(
      "setup:run-codex-capability",
      ipcSetupStateResponseSchema,
    ),
  },
  gui: {
    apply: (input) => invoke(
      "gui:apply",
      ipcGuiEditInputSchema,
      ipcGuiEditResponseSchema,
      input,
    ),
  },
  externalAgent: {
    getState: () => invoke(
      "external-agent:get-state",
      ipcExternalAgentGetStateInputSchema,
      ipcExternalAgentGetStateResponseSchema,
      {},
    ),
    setEnabled: (input) => invoke(
      "external-agent:set-enabled",
      ipcExternalAgentSetEnabledInputSchema,
      ipcExternalAgentSetEnabledResponseSchema,
      input,
    ),
    edit: (input) => invoke(
      "external-agent:edit",
      ipcExternalAgentEditInputSchema,
      ipcExternalAgentEditResponseSchema,
      input,
    ),
    select: (input) => invoke(
      "external-agent:select",
      ipcExternalAgentSelectInputSchema,
      ipcExternalAgentSelectResponseSchema,
      input,
    ),
    approve: (input) => invoke(
      "external-agent:approve",
      ipcExternalAgentApproveInputSchema,
      ipcExternalAgentApproveResponseSchema,
      input,
    ),
    reject: (input) => invoke(
      "external-agent:reject",
      ipcExternalAgentRejectInputSchema,
      ipcExternalAgentRejectResponseSchema,
      input,
    ),
    onChanged: (listener) => subscribe(
      "external-agent:state",
      "external-agent:state:subscribe",
      "external-agent:state:unsubscribe",
      ipcExternalAgentStateEventSchema,
      listener,
    ),
  },
  ai: {
    getStatus: () => invokeEmpty("ai:get-status", ipcAiGetStatusResponseSchema),
    startTurn: (input) => invoke(
      "ai:start-turn",
      ipcAiTurnInputSchema,
      ipcAiTurnResponseSchema,
      input,
    ),
    getProposal: (input) => invoke(
      "ai:get-proposal",
      ipcAiProposalInputSchema,
      ipcAiProposalResponseSchema,
      input,
    ),
    select: (input) => invoke(
      "ai:select",
      ipcAiSelectionInputSchema,
      ipcAiSelectionResponseSchema,
      input,
    ),
    editOperation: (input) => invoke(
      "ai:edit-operation",
      ipcAiEditInputSchema,
      ipcAiEditResponseSchema,
      input,
    ),
    reject: (input) => invoke(
      "ai:reject",
      ipcAiRejectInputSchema,
      ipcAiRejectResponseSchema,
      input,
    ),
    approve: (input) => invoke(
      "ai:approve",
      ipcAiApprovalInputSchema,
      ipcAiApprovalResponseSchema,
      input,
    ),
    closeSession: (sessionId) => invoke(
      "ai:close-session",
      ipcAiCloseSessionInputSchema,
      ipcAiCloseSessionResponseSchema,
      sessionId,
    ),
    onDelta: (listener) => subscribe(
      "ai:delta",
      "ai:delta:subscribe",
      "ai:delta:unsubscribe",
      ipcAiDeltaEventSchema,
      listener,
    ),
    onStatus: (listener) => subscribe(
      "ai:status",
      "ai:status:subscribe",
      "ai:status:unsubscribe",
      ipcAiStatusEventSchema,
      listener,
    ),
    startNewSession: () => invokeEmpty(
      "ai:start-new-session",
      ipcAiStartNewSessionResponseSchema,
    ),
  },
  obsidian: {
    listVaults: () => invoke(
      "obsidian:list-vaults",
      ipcObsidianListVaultsInputSchema,
      ipcObsidianListVaultsResponseSchema,
      undefined,
    ),
    listVaultMappings: () => invoke(
      "obsidian:list-vault-mappings",
      ipcObsidianListVaultMappingsInputSchema,
      ipcObsidianListVaultMappingsResponseSchema,
      undefined,
    ),
    saveVaultMapping: (input) => invoke(
      "obsidian:save-vault-mapping",
      ipcObsidianSaveVaultMappingInputSchema,
      ipcObsidianSaveVaultMappingResponseSchema,
      input,
    ),
    validateVault: (vaultId) => invoke(
      "obsidian:validate-vault",
      ipcObsidianValidateInputSchema,
      ipcObsidianValidateResponseSchema,
      { vault_id: vaultId },
    ),
    resolvePath: (input) => invoke(
      "obsidian:resolve-path",
      ipcObsidianPathInputSchema,
      ipcObsidianPathResponseSchema,
      input,
    ),
    noteExists: (input) => invoke(
      "obsidian:note-exists",
      ipcObsidianPathInputSchema,
      ipcObsidianPathResponseSchema,
      input,
    ),
    openNote: (input) => invoke(
      "obsidian:open-note",
      ipcObsidianOpenNoteInputSchema,
      ipcObsidianOpenNoteResponseSchema,
      input,
    ),
  },
  system: {
    getVersion: () => invokeFinal(finalIpcContracts.system.getVersion, {}),
    waitForStartup: () => invokeFinal(finalIpcContracts.system.waitForStartup, {}),
    getUpdateState: () => invokeFinal(finalIpcContracts.system.getUpdateState, {}),
    onUpdateState: (listener) => subscribeFinal(
      finalIpcContracts.system.updateState,
      finalIpcContracts.system.subscribeUpdateState,
      finalIpcContracts.system.unsubscribeUpdateState,
      listener,
    ),
  },
  tasks: {
    getOverview: () => invokeFinal(finalIpcContracts.tasks.getOverview, {}),
    getDetail: (taskGid) => invokeFinal(finalIpcContracts.tasks.getDetail, { task_gid: taskGid }),
    getSyncState: () => invokeFinal(finalIpcContracts.tasks.getSyncState, {}),
    runSync: (mode) => invokeFinal(finalIpcContracts.tasks.runSync, { mode }),
    applyEdit: (input) => invokeFinal(finalIpcContracts.tasks.applyEdit, input),
    getExecution: (executionId) => invokeFinal(
      finalIpcContracts.tasks.getExecution,
      { execution_id: executionId },
    ),
    retryExecution: (retryOfExecutionId) => invokeFinal(
      finalIpcContracts.tasks.retryExecution,
      { retry_of_execution_id: retryOfExecutionId },
    ),
    onSyncState: (listener) => subscribeFinal(
      finalIpcContracts.tasks.syncState,
      finalIpcContracts.tasks.subscribeSyncState,
      finalIpcContracts.tasks.unsubscribeSyncState,
      listener,
    ),
    onExecution: (listener) => subscribeFinal(
      finalIpcContracts.tasks.execution,
      finalIpcContracts.tasks.subscribeExecution,
      finalIpcContracts.tasks.unsubscribeExecution,
      listener,
    ),
  },
  settings: {
    getState: () => invokeFinal(finalIpcContracts.settings.getState, {}),
    start: () => invokeFinal(finalIpcContracts.settings.start, {}),
    completeCodexAuthentication: () => invokeFinal(
      finalIpcContracts.settings.completeCodexAuthentication,
      {},
    ),
    beginAsanaAuthorization: (input) => invokeFinal(
      finalIpcContracts.settings.beginAsanaAuthorization,
      input,
    ),
    completeAsanaAuthorization: (input) => invokeFinal(
      finalIpcContracts.settings.completeAsanaAuthorization,
      input,
    ),
    cancelAsanaAuthorization: (input) => invokeFinal(
      finalIpcContracts.settings.cancelAsanaAuthorization,
      input,
    ),
    listWorkspaces: () => invokeFinal(finalIpcContracts.settings.listWorkspaces, {}),
    selectWorkspace: (workspaceGid) => invokeFinal(
      finalIpcContracts.settings.selectWorkspace,
      { workspace_gid: workspaceGid },
    ),
    selectProject: (input) => invokeFinal(finalIpcContracts.settings.selectProject, input),
    retryResources: () => invokeFinal(finalIpcContracts.settings.retryResources, {}),
    runCapability: () => invokeFinal(finalIpcContracts.settings.runCapability, {}),
    chooseVault: (input) => invokeFinal(finalIpcContracts.settings.chooseVault, input),
    chooseExternalTool: (input) => invokeFinal(finalIpcContracts.settings.chooseExternalTool, input),
    runFullSync: () => invokeFinal(finalIpcContracts.settings.runFullSync, {}),
    runCodexCapability: () => invokeFinal(finalIpcContracts.settings.runCodexCapability, {}),
    getAsanaAuthenticationState: () => invokeFinal(
      finalIpcContracts.settings.getAsanaAuthenticationState,
      {},
    ),
    beginAsanaReauthentication: () => invokeFinal(
      finalIpcContracts.settings.beginAsanaReauthentication,
      {},
    ),
    completeAsanaReauthentication: (input) => invokeFinal(
      finalIpcContracts.settings.completeAsanaReauthentication,
      input,
    ),
    cancelAsanaReauthentication: (input) => invokeFinal(
      finalIpcContracts.settings.cancelAsanaReauthentication,
      input,
    ),
  },
  proposals: {
    getAiStatus: () => invokeFinal(finalIpcContracts.proposals.getAiStatus, {}),
    startSession: () => invokeFinal(finalIpcContracts.proposals.startSession, {}),
    startTurn: (input) => invokeFinal(finalIpcContracts.proposals.startTurn, input),
    getProposal: (input) => invokeFinal(finalIpcContracts.proposals.getProposal, input),
    select: (input) => invokeFinal(finalIpcContracts.proposals.select, input),
    editOperation: (input) => invokeFinal(finalIpcContracts.proposals.editOperation, input),
    reject: (input) => invokeFinal(finalIpcContracts.proposals.reject, input),
    approve: (input) => invokeFinal(finalIpcContracts.proposals.approve, input),
    closeSession: (sessionId) => invokeFinal(
      finalIpcContracts.proposals.closeSession,
      { session_id: sessionId },
    ),
    getExternalState: () => invokeFinal(finalIpcContracts.proposals.getExternalState, {}),
    setExternalEnabled: (enabled) => invokeFinal(
      finalIpcContracts.proposals.setExternalEnabled,
      { enabled },
    ),
    editExternalOperation: (input) => invokeFinal(
      finalIpcContracts.proposals.editExternalOperation,
      input,
    ),
    selectExternal: (input) => invokeFinal(finalIpcContracts.proposals.selectExternal, input),
    approveExternal: (input) => invokeFinal(finalIpcContracts.proposals.approveExternal, input),
    rejectExternal: (input) => invokeFinal(finalIpcContracts.proposals.rejectExternal, input),
    getHistoryStatus: () => invokeFinal(finalIpcContracts.proposals.getHistoryStatus, {}),
    confirmHistory: (input) => invokeFinal(finalIpcContracts.proposals.confirmHistory, input),
    synchronizeHistory: () => invokeFinal(finalIpcContracts.proposals.synchronizeHistory, {}),
    getExecution: (executionId) => invokeFinal(
      finalIpcContracts.proposals.getExecution,
      { execution_id: executionId },
    ),
    retryExecution: (retryOfExecutionId) => invokeFinal(
      finalIpcContracts.proposals.retryExecution,
      { retry_of_execution_id: retryOfExecutionId },
    ),
    onAiStatus: (listener) => subscribeFinal(
      finalIpcContracts.proposals.aiStatus,
      finalIpcContracts.proposals.subscribeAiStatus,
      finalIpcContracts.proposals.unsubscribeAiStatus,
      listener,
    ),
    onAiDelta: (listener) => subscribeFinal(
      finalIpcContracts.proposals.aiDelta,
      finalIpcContracts.proposals.subscribeAiDelta,
      finalIpcContracts.proposals.unsubscribeAiDelta,
      listener,
    ),
    onExternalState: (listener) => subscribeFinal(
      finalIpcContracts.proposals.externalState,
      finalIpcContracts.proposals.subscribeExternalState,
      finalIpcContracts.proposals.unsubscribeExternalState,
      listener,
    ),
    onExecution: (listener) => subscribeFinal(
      finalIpcContracts.proposals.execution,
      finalIpcContracts.proposals.subscribeExecution,
      finalIpcContracts.proposals.unsubscribeExecution,
      listener,
    ),
  },
  obsidianIntegration: {
    validateVault: (vaultId) => invokeFinal(
      finalIpcContracts.obsidianIntegration.validateVault,
      { vault_id: vaultId },
    ),
    listVaults: () => invokeFinal(finalIpcContracts.obsidianIntegration.listVaults, {}),
    listVaultMappings: () => invokeFinal(finalIpcContracts.obsidianIntegration.listVaultMappings, {}),
    saveVaultMapping: (mapping) => invokeFinal(
      finalIpcContracts.obsidianIntegration.saveVaultMapping,
      mapping,
    ),
    resolvePath: (input) => invokeFinal(finalIpcContracts.obsidianIntegration.resolvePath, input),
    noteExists: (input) => invokeFinal(finalIpcContracts.obsidianIntegration.noteExists, input),
    openNote: (input) => invokeFinal(finalIpcContracts.obsidianIntegration.openNote, input),
  },
  githubIntegration: {
    getStatus: () => invokeFinal(finalIpcContracts.githubIntegration.getStatus, {}),
  },
  diagnostics: {
    report: (input) => invokeFinal(finalIpcContracts.diagnostics.report, input),
  },
};

contextBridge.exposeInMainWorld("taskHub", api);
