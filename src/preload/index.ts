import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import { finalIpcContracts, type FinalTaskHubApi } from "../shared/ipc-contracts";
import { serializeDiagnosticError } from "../shared/ipc-contracts/diagnostics";

function reportPreloadError(error: unknown): void {
  const contract = finalIpcContracts.diagnostics.report;
  const input = contract.request.parse({ level: "error", error: serializeDiagnosticError(error) });
  const logFailure = (failure: unknown): void => {
    console.error("preloadの診断をMainに記録できませんでした。", input.error, serializeDiagnosticError(failure));
  };
  try {
    void ipcRenderer.invoke(contract.channel, input)
      .then((value: unknown) => contract.response.parse(value))
      .then((result) => {
        if (result.kind === "error") {
          console.error("preloadの診断をMainに記録できませんでした。", input.error);
        }
      })
      .catch(logFailure);
  } catch (failure) {
    logFailure(failure);
  }
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
  listener: (value: Value) => void | Promise<void>,
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
    try {
      const event = eventContract.event.parse(payload);
      if (event.subscription_id === subscriptionId) {
        const result = listener(event.value);
        if (result != null) {
          void Promise.resolve(result).catch(reportPreloadError);
        }
      }
    } catch (error) {
      reportPreloadError(error);
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

const api: FinalTaskHubApi = {
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
    listExecutions: (input) => invokeFinal(finalIpcContracts.proposals.listExecutions, input),
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
