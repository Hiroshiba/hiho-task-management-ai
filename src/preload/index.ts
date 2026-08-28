import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { TaskHubApi } from "../shared/task-hub-api";
import {
  ipcAiApprovalInputSchema,
  ipcAiApprovalResponseSchema,
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
  ipcAsanaReauthenticateOAuthInputSchema,
  ipcAsanaReauthenticateOAuthResponseSchema,
  ipcAppVersionSchema,
  ipcEmptyRequestSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResponseSchema,
  ipcObsidianListInputSchema,
  ipcObsidianListVaultsInputSchema,
  ipcObsidianListVaultsResponseSchema,
  ipcObsidianListResponseSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianPathResponseSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianOpenNoteResponseSchema,
  ipcObsidianSearchInputSchema,
  ipcObsidianSearchResponseSchema,
  ipcObsidianValidateInputSchema,
  ipcObsidianValidateResponseSchema,
  ipcReadModelOverviewInputSchema,
  ipcReadModelOverviewResponseSchema,
  ipcReadModelTaskDetailInputSchema,
  ipcReadModelTaskDetailResponseSchema,
  ipcSetupAuthenticateAsanaInputSchema,
  ipcSetupChooseExternalToolInputSchema,
  ipcSetupChooseVaultInputSchema,
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
  },
  asana: {
    reauthenticateOAuth: () => invoke(
      "asana:reauthenticate-oauth",
      ipcAsanaReauthenticateOAuthInputSchema,
      ipcAsanaReauthenticateOAuthResponseSchema,
      undefined,
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
    authenticateAsana: (input) => invoke(
      "setup:authenticate-asana",
      ipcSetupAuthenticateAsanaInputSchema,
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
  ai: {
    getStatus: () => invokeEmpty("ai:get-status", ipcAiGetStatusResponseSchema),
    startTurn: (input) => invoke(
      "ai:start-turn",
      ipcAiTurnInputSchema,
      ipcAiTurnResponseSchema,
      input,
    ),
    getProposal: (proposalId) => invoke(
      "ai:get-proposal",
      ipcAiProposalInputSchema,
      ipcAiProposalResponseSchema,
      { proposal_id: proposalId },
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
    reject: (proposalId) => invoke(
      "ai:reject",
      ipcAiRejectInputSchema,
      ipcAiRejectResponseSchema,
      { proposal_id: proposalId },
    ),
    approve: (input) => invoke(
      "ai:approve",
      ipcAiApprovalInputSchema,
      ipcAiApprovalResponseSchema,
      input,
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
    validateVault: (vaultId) => invoke(
      "obsidian:validate-vault",
      ipcObsidianValidateInputSchema,
      ipcObsidianValidateResponseSchema,
      { vault_id: vaultId },
    ),
    listNotes: (vaultId) => invoke(
      "obsidian:list-notes",
      ipcObsidianListInputSchema,
      ipcObsidianListResponseSchema,
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
    search: (input) => invoke(
      "obsidian:search",
      ipcObsidianSearchInputSchema,
      ipcObsidianSearchResponseSchema,
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
