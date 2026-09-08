import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
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
  ipcSyncInputSchema,
  ipcSyncGetStateResponseSchema,
  ipcSyncResponseSchema,
  ipcSyncStateEventSchema,
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

const api: TaskHubApi = {
  app: {
    getVersion: (): Promise<string> =>
      invokeEmpty("app:get-version", ipcAppVersionSchema),
    waitForStartup: () => invokeEmpty(
      "app:wait-for-startup",
      ipcAppStartupResponseSchema,
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
  setup: {
    getState: () => invokeEmpty("setup:get-state", ipcSetupStateResponseSchema),
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
};

contextBridge.exposeInMainWorld("taskHub", api);
