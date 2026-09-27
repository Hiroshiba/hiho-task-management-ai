import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";
import { z } from "zod";
import { DiagnosticFailureDispositionError } from "../diagnostic-failure";
import {
  assertTrustedIpcSender,
  isApplicationUrl,
} from "../security";
import {
  StartupGateAbortedError,
  StartupGateFailedError,
  StartupGateNotReadyError,
  StartupGateStoppedError,
  type StartupGate,
} from "../startup-gate";
import {
  AsanaOAuthCredentialStateError,
  AsanaOAuthHttpError,
  AsanaOAuthOutOfBandAbortedError,
  AsanaOAuthOutOfBandAuthorizationIdMismatchError,
  AsanaOAuthOutOfBandCancelledError,
  AsanaOAuthOutOfBandExpiredError,
  AsanaOAuthOutOfBandNotPendingError,
  AsanaOAuthOutOfBandStoppedError,
  AsanaOAuthResponseError,
  AsanaOAuthStateError,
  AsanaOAuthTokenEndpointError,
  AsanaOAuthTransportError,
} from "../auth/asana-oauth";
import { SecretStorageEncryptionUnavailableError } from "../auth/secret-storage";
import { ExternalAgentServiceError } from "../external-agent";
import { ObsidianVaultMappingConflictError } from "../obsidian";
import { AsanaSyncRuntimeAlreadyReportedError } from "../asana/runtime";
import { IpcEventSubscriptions } from "./handlers/event-subscriptions";
import { ipcFailureMessages } from "./handlers/failure-messages";
import {
  ipcAiApprovalInputSchema,
  ipcAiApprovalResponseSchema,
  ipcAiCloseSessionInputSchema,
  ipcAiCloseSessionResponseSchema,
  ipcAiDeltaEventSchema,
  ipcAiEditInputSchema,
  ipcAiEditResponseSchema,
  ipcAiGetStatusInputSchema,
  ipcAiGetStatusResponseSchema,
  ipcAiProposalInputSchema,
  ipcAiProposalResponseSchema,
  ipcAiRejectInputSchema,
  ipcAiRejectResponseSchema,
  ipcAiSelectionInputSchema,
  ipcAiSelectionResponseSchema,
  ipcAiStatusEventSchema,
  ipcAiStartNewSessionInputSchema,
  ipcAiStartNewSessionResponseSchema,
  ipcAiTurnInputSchema,
  ipcAiTurnResponseSchema,
  ipcAsanaAuthenticationStateResponseSchema,
  ipcAppStartupResponseSchema,
  ipcAppUpdateStateSchema,
  ipcAppUpdateGetStateResponseSchema,
  ipcAsanaGetAuthenticationStateInputSchema,
  ipcAsanaBeginReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationResponseSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationResponseSchema,
  ipcChannelSchema,
  ipcEmptyRequestSchema,
  ipcFailureSchema,
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
  ipcGuiEditInputSchema,
  ipcGuiEditResponseSchema,
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
  ipcSetupCompleteCodexAuthenticationInputSchema,
  ipcSetupListWorkspacesInputSchema,
  ipcSetupRetryResourcesInputSchema,
  ipcSetupRunCapabilityInputSchema,
  ipcSetupRunCodexCapabilityInputSchema,
  ipcSetupRunFullSyncInputSchema,
  ipcSetupSelectProjectInputSchema,
  ipcSetupSelectWorkspaceInputSchema,
  ipcSetupStartInputSchema,
  ipcSetupStateResponseSchema,
  ipcSyncInputSchema,
  ipcSyncGetStateInputSchema,
  ipcSyncGetStateResponseSchema,
  ipcSyncResponseSchema,
  ipcSyncStateEventSchema,
  type IpcAiApprovalInput,
  type IpcAppUpdateState,
  type IpcAiApprovalResult,
  type IpcAiCloseSessionInput,
  type IpcAiEditInput,
  type IpcAiNewSessionResult,
  type IpcAiProposalInput,
  type IpcAiRejectInput,
  type IpcAiStatus,
  type IpcAiProposalView,
  type IpcAiSelectionInput,
  type IpcAiTurnInput,
  type IpcAiTurnResult,
  type IpcAsanaAuthenticationState,
  type IpcAsanaReauthenticationCancelInput,
  type IpcAsanaReauthenticationCompleteInput,
  type IpcCodexDelta,
  type IpcSetupAsanaAuthorizationBeginInput,
  type IpcSetupAsanaAuthorizationCancelInput,
  type IpcSetupAsanaAuthorizationCompleteInput,
  type IpcSetupExternalToolChoiceInput,
  type IpcSetupProjectSelectionInput,
  type IpcSetupState,
  type IpcSetupVaultChoiceInput,
  type IpcSetupWorkspaceSelectionInput,
  type IpcFailure,
  type IpcExternalAgentGuiApproveInput,
  type IpcExternalAgentGuiEditInput,
  type IpcExternalAgentGuiRejectInput,
  type IpcExternalAgentGuiSelectInput,
  type IpcExternalAgentGuiSetEnabledInput,
  type IpcExternalAgentGuiState,
  type IpcGuiEditInput,
  type IpcGuiEditResult,
  type IpcObsidianPathResult,
  type IpcObsidianVaultMapping,
  type IpcObsidianVaultMappings,
  type IpcObsidianVaultResult,
  type IpcReadModelOverview,
  type IpcReadModelTaskDetail,
  type IpcResponse,
  type IpcSyncInput,
  type IpcSyncResult,
  type IpcSyncStateEvent,
} from "../../shared/ipc";

type MaybePromise<T> = T | PromiseLike<T>;

/** IPCの診断へ元のエラーを渡すポートです。 */
export interface IpcDiagnosticPort {
  record(error: unknown, channel: string): void;
}

/** 読み取りモデルをIPCへ提供するポートです。 */
export interface IpcReadModelPort {
  getOverview(): MaybePromise<IpcReadModelOverview>;
  getTaskDetail(taskGid: string): MaybePromise<IpcReadModelTaskDetail>;
}

/** 同期処理をIPCへ提供するポートです。 */
export interface IpcSyncPort {
  getState(): MaybePromise<IpcSyncStateEvent>;
  run(input: IpcSyncInput, signal: AbortSignal): MaybePromise<IpcSyncResult>;
  onState?(listener: (state: IpcSyncStateEvent) => void): () => void;
}

/** 設定済みAsana認証操作をIPCへ提供するポートです。 */
export interface IpcAsanaPort {
  getAuthenticationState(): MaybePromise<IpcAsanaAuthenticationState>;
  beginReauthentication(signal: AbortSignal): MaybePromise<IpcAsanaAuthenticationState>;
  completeReauthentication(
    input: IpcAsanaReauthenticationCompleteInput,
    signal: AbortSignal,
  ): MaybePromise<IpcSyncResult>;
  cancelReauthentication(
    input: IpcAsanaReauthenticationCancelInput,
    signal: AbortSignal,
  ): MaybePromise<IpcAsanaAuthenticationState>;
}

/** 初回設定の状態機械をIPCへ提供するポートです。 */
export interface IpcSetupPort {
  getState(): MaybePromise<IpcSetupState>;
  start(signal: AbortSignal): MaybePromise<IpcSetupState>;
  completeCodexAuthentication(signal: AbortSignal): MaybePromise<IpcSetupState>;
  beginAsanaAuthorization(
    input: IpcSetupAsanaAuthorizationBeginInput,
    signal: AbortSignal,
  ): MaybePromise<IpcSetupState>;
  completeAsanaAuthorization(
    input: IpcSetupAsanaAuthorizationCompleteInput,
    signal: AbortSignal,
  ): MaybePromise<IpcSetupState>;
  cancelAsanaAuthorization(
    input: IpcSetupAsanaAuthorizationCancelInput,
    signal: AbortSignal,
  ): MaybePromise<IpcSetupState>;
  listWorkspaces(signal: AbortSignal): MaybePromise<IpcSetupState>;
  selectWorkspace(input: IpcSetupWorkspaceSelectionInput, signal: AbortSignal): MaybePromise<IpcSetupState>;
  selectProject(input: IpcSetupProjectSelectionInput, signal: AbortSignal): MaybePromise<IpcSetupState>;
  retryResources(signal: AbortSignal): MaybePromise<IpcSetupState>;
  runCapability(signal: AbortSignal): MaybePromise<IpcSetupState>;
  chooseVault(input: IpcSetupVaultChoiceInput, signal: AbortSignal): MaybePromise<IpcSetupState>;
  chooseExternalTool(input: IpcSetupExternalToolChoiceInput, signal: AbortSignal): MaybePromise<IpcSetupState>;
  runFullSync(signal: AbortSignal): MaybePromise<IpcSetupState>;
  runCodexCapability(signal: AbortSignal): MaybePromise<IpcSetupState>;
}

/** GUI編集処理をIPCへ提供するポートです。 */
export interface IpcGuiEditPort {
  apply(input: IpcGuiEditInput, signal: AbortSignal): MaybePromise<IpcGuiEditResult>;
}

/** 外部連携GUIの提案操作をIPCへ提供するポートです。 */
export interface IpcExternalAgentPort {
  getState(): MaybePromise<IpcExternalAgentGuiState>;
  setEnabled(
    input: IpcExternalAgentGuiSetEnabledInput,
    signal: AbortSignal,
  ): MaybePromise<IpcExternalAgentGuiState>;
  edit(
    input: IpcExternalAgentGuiEditInput,
    signal: AbortSignal,
  ): MaybePromise<IpcExternalAgentGuiState>;
  select(
    input: IpcExternalAgentGuiSelectInput,
    signal: AbortSignal,
  ): MaybePromise<IpcExternalAgentGuiState>;
  approve(
    input: IpcExternalAgentGuiApproveInput,
    signal: AbortSignal,
  ): MaybePromise<IpcExternalAgentGuiState>;
  reject(
    input: IpcExternalAgentGuiRejectInput,
    signal: AbortSignal,
  ): MaybePromise<IpcExternalAgentGuiState>;
  onChanged?(listener: (state: IpcExternalAgentGuiState) => void): () => void;
}

/** AIワークフローをIPCへ提供するポートです。 */
export interface IpcAiPort {
  getStatus(): MaybePromise<IpcAiStatus>;
  startNewSession(signal: AbortSignal): MaybePromise<IpcAiNewSessionResult>;
  startTurn(input: IpcAiTurnInput, signal: AbortSignal): MaybePromise<IpcAiTurnResult>;
  getProposal(input: IpcAiProposalInput): MaybePromise<IpcAiProposalView>;
  select(input: IpcAiSelectionInput): MaybePromise<IpcAiProposalView>;
  editOperation(input: IpcAiEditInput): MaybePromise<IpcAiProposalView>;
  reject(input: IpcAiRejectInput): MaybePromise<void>;
  approve(input: IpcAiApprovalInput, signal: AbortSignal): MaybePromise<IpcAiApprovalResult>;
  closeSession(sessionId: IpcAiCloseSessionInput): MaybePromise<{ readonly completed: true }>;
  onDelta?(listener: (delta: IpcCodexDelta) => void): () => void;
  onStatus?(listener: (status: IpcAiStatus) => void): () => void;
}

/** Obsidian参照とVault設定をIPCへ提供するポートです。 */
export interface IpcObsidianPort {
  listVaults(signal: AbortSignal): MaybePromise<readonly string[]>;
  listVaultMappings(signal: AbortSignal): MaybePromise<IpcObsidianVaultMappings>;
  saveVaultMapping(
    input: IpcObsidianVaultMapping,
    signal: AbortSignal,
  ): MaybePromise<IpcObsidianVaultMappings>;
  validateVault(vaultId: string, signal: AbortSignal): MaybePromise<IpcObsidianVaultResult>;
  resolvePath(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<IpcObsidianPathResult>;
  noteExists(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<IpcObsidianPathResult>;
  openNote(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<void>;
}

/** IPCの依存ポートをまとめた設定です。 */
export interface IpcServicePorts {
  readonly appUpdate?: IpcAppUpdatePort;
  readonly asana?: IpcAsanaPort;
  readonly readModel?: IpcReadModelPort;
  readonly sync?: IpcSyncPort;
  readonly setup?: IpcSetupPort;
  readonly gui?: IpcGuiEditPort;
  readonly externalAgent?: IpcExternalAgentPort;
  readonly ai?: IpcAiPort;
  readonly obsidian?: IpcObsidianPort;
}

/** アプリ本体の更新状態をIPCへ提供するポートです。 */
export interface IpcAppUpdatePort {
  getState(): IpcAppUpdateState;
  onState(listener: (state: IpcAppUpdateState) => void): () => void;
}

/** IPCハンドラー登録の設定です。 */
export interface IpcHandlerRegistryOptions {
  readonly rendererWebContents: WebContents;
  readonly rendererUrl: string;
  readonly ports: IpcServicePorts;
  readonly diagnostic: IpcDiagnosticPort;
  readonly startupGate: StartupGate;
}

class IpcCapabilityUnavailableError extends Error {
  public constructor() {
    super("IPC機能が利用できません。");
    this.name = "IpcCapabilityUnavailableError";
  }
}

type HandlerRemover = () => void;


type IpcOperationFailure =
  | {
      readonly kind: "already_reported";
    }
  | {
      readonly kind: "unreported";
      readonly error: unknown;
    };

function classifyIpcOperationFailure(error: unknown): IpcOperationFailure {
  if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
    return { kind: "already_reported" };
  }
  return { kind: "unreported", error };
}

function ipcResponseError(error: unknown): unknown {
  if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
    return error.cause;
  }
  return error;
}

function ipcFailureCodeForError(error: unknown): IpcFailure["code"] {
  if (error instanceof StartupGateNotReadyError) {
    return "unavailable";
  }
  if (error instanceof StartupGateFailedError) {
    return "operation_failed";
  }
  if (
    error instanceof StartupGateStoppedError
    || error instanceof StartupGateAbortedError
  ) {
    return "aborted";
  }
  if (error instanceof ExternalAgentServiceError) {
    switch (error.code) {
      case "invalid_request":
        return "invalid_request";
      case "not_found":
        return "not_found";
      case "stale_revision":
      case "context_changed":
      case "context_mismatch":
      case "request_id_reused":
      case "conflict":
        return "conflict";
      case "disabled":
      case "unavailable":
      case "offline":
      case "setup_required":
      case "capacity_exceeded":
        return "unavailable";
      case "unknown_result":
        return "operation_failed";
    }
  }
  if (error instanceof ObsidianVaultMappingConflictError) {
    return "conflict";
  }
  if (error instanceof AsanaOAuthTokenEndpointError) {
    switch (error.code) {
      case "invalid_client":
      case "unauthorized_client":
        return "oauth_invalid_client";
      case "invalid_grant":
        return "oauth_invalid_grant";
      default:
        return "oauth_token_endpoint_rejected";
    }
  }
  if (error instanceof AsanaOAuthTransportError) {
    return "oauth_network_error";
  }
  if (error instanceof AsanaOAuthHttpError) {
    if (
      error.status === 408
      || error.status === 429
      || (error.status >= 500 && error.status <= 599)
    ) {
      return "oauth_service_unavailable";
    }
    return "oauth_http_rejected";
  }
  if (error instanceof AsanaOAuthResponseError) {
    return "oauth_response_invalid";
  }
  if (error instanceof SecretStorageEncryptionUnavailableError) {
    return "secure_storage_unavailable";
  }
  if (
    error instanceof AsanaOAuthOutOfBandExpiredError
    || error instanceof AsanaOAuthStateError
    || error instanceof AsanaOAuthOutOfBandCancelledError
    || error instanceof AsanaOAuthOutOfBandAbortedError
    || error instanceof AsanaOAuthOutOfBandStoppedError
    || error instanceof AsanaOAuthOutOfBandNotPendingError
    || error instanceof AsanaOAuthCredentialStateError
    || error instanceof AsanaOAuthOutOfBandAuthorizationIdMismatchError
  ) {
    return "oauth_session_error";
  }
  if (error instanceof AggregateError) {
    return "operation_failed";
  }
  if (error instanceof z.ZodError) {
    return "invalid_response";
  }
  return "operation_failed";
}

function validateOptions(options: IpcHandlerRegistryOptions): void {
  if (typeof options?.rendererUrl !== "string" || options.rendererUrl.length === 0) {
    throw new TypeError("信頼済みRendererのURLが必要です。");
  }
  if (typeof options?.diagnostic?.record !== "function") {
    throw new TypeError("IPC診断ポートが必要です。");
  }
  if (typeof options?.ports !== "object" || options.ports == null) {
    throw new TypeError("IPCサービスポートが必要です。");
  }
  if (
    typeof options?.startupGate?.assertReady !== "function"
    || typeof options.startupGate.waitForStartup !== "function"
  ) {
    throw new TypeError("IPC起動ゲートが必要です。");
  }
}

function createCompletedValue(): { readonly completed: true } {
  return { completed: true };
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateEventSender(
  event: IpcMainEvent,
  expectedWebContents: WebContents,
  rendererUrl: string,
): void {
  if (
    event.sender !== expectedWebContents
    || event.senderFrame !== event.sender.mainFrame
    || !isApplicationUrl(event.senderFrame.url, rendererUrl)
  ) {
    throw new Error("不正なIPC送信元です。");
  }
}

/** 依存注入されたサービスを安全なIPCハンドラーとして登録します。 */
export class IpcHandlerRegistry {
  private readonly options: IpcHandlerRegistryOptions;
  private readonly cleanup: HandlerRemover[] = [];
  private readonly eventSubscriptions: IpcEventSubscriptions;
  private readonly activeAbortControllers = new Set<AbortController>();
  private registeredIpcMain: IpcMain | undefined;

  public constructor(options: IpcHandlerRegistryOptions) {
    validateOptions(options);
    this.options = options;
    this.eventSubscriptions = new IpcEventSubscriptions({
      validateChannel: (channel) => ipcChannelSchema.parse(channel),
      validateSender: (event) => validateEventSender(
        event,
        options.rendererWebContents,
        options.rendererUrl,
      ),
      validateRequest: (payload) => {
        ipcEmptyRequestSchema.parse(payload);
      },
      record: (error, channel) => options.diagnostic.record(error, channel),
    });
  }

  /** 固定チャンネルのIPCハンドラーを登録します。 */
  public register(ipcMain: IpcMain): void {
    if (this.registeredIpcMain != null) {
      throw new Error("IPCハンドラーは重複登録できません。");
    }
    this.registeredIpcMain = ipcMain;
    this.registerInvokeHandlers(ipcMain);
    this.eventSubscriptions.register(ipcMain);
    this.registerServiceEvents();
  }

  /** 登録済みIPCハンドラーと購読を解放します。 */
  public dispose(): void {
    this.eventSubscriptions.stopSending();
    for (const controller of this.activeAbortControllers) {
      controller.abort();
    }
    this.activeAbortControllers.clear();
    const ipcMain = this.registeredIpcMain;
    if (ipcMain == null) {
      return;
    }
    for (const remove of this.cleanup.splice(0)) {
      remove();
    }
    this.eventSubscriptions.dispose();
    this.registeredIpcMain = undefined;
  }

  private registerInvokeHandlers(ipcMain: IpcMain): void {
    this.registerHandleWithStartupGate(
      ipcMain,
      "app:wait-for-startup",
      ipcEmptyRequestSchema,
      ipcAppStartupResponseSchema,
      async (_input, signal) => {
        await this.options.startupGate.waitForStartup(signal);
        return createCompletedValue();
      },
      false,
    );
    this.registerHandleWithStartupGate(
      ipcMain,
      "app-update:get-state",
      ipcEmptyRequestSchema,
      ipcAppUpdateGetStateResponseSchema,
      () => {
        const port = this.options.ports.appUpdate;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.getState();
      },
      false,
    );
    this.registerPortHandle(
      ipcMain, "asana:get-authentication-state", ipcAsanaGetAuthenticationStateInputSchema, ipcAsanaAuthenticationStateResponseSchema, "asana",
      async (port) => port.getAuthenticationState(),
    );
    this.registerPortHandle(
      ipcMain, "asana:begin-reauthentication", ipcAsanaBeginReauthenticationInputSchema, ipcAsanaAuthenticationStateResponseSchema, "asana",
      async (port, _input, signal) => port.beginReauthentication(signal),
    );
    this.registerPortHandle(
      ipcMain, "asana:complete-reauthentication", ipcAsanaCompleteReauthenticationInputSchema, ipcAsanaCompleteReauthenticationResponseSchema, "asana",
      async (port, input, signal) => port.completeReauthentication(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "asana:cancel-reauthentication", ipcAsanaCancelReauthenticationInputSchema, ipcAsanaCancelReauthenticationResponseSchema, "asana",
      async (port, input, signal) => port.cancelReauthentication(input, signal),
    );
    this.registerPortHandle(
      ipcMain,
      "read-model:get-overview",
      ipcReadModelOverviewInputSchema,
      ipcReadModelOverviewResponseSchema,
      "readModel",
      async (port, input) => {
        ipcEmptyRequestSchema.parse(input);
        return port.getOverview();
      },
    );
    this.registerPortHandle(
      ipcMain, "read-model:get-task-detail", ipcReadModelTaskDetailInputSchema, ipcReadModelTaskDetailResponseSchema, "readModel",
      async (port, input) => port.getTaskDetail(input.task_gid),
    );
    this.registerPortHandle(
      ipcMain, "sync:run", ipcSyncInputSchema, ipcSyncResponseSchema, "sync",
      async (port, input, signal) => port.run(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "sync:get-state", ipcSyncGetStateInputSchema, ipcSyncGetStateResponseSchema, "sync",
      async (port) => port.getState(),
    );
    this.registerPortHandle(
      ipcMain, "setup:get-state", ipcEmptyRequestSchema, ipcSetupStateResponseSchema, "setup",
      async (port) => port.getState(),
    );
    this.registerPortHandle(
      ipcMain, "setup:start", ipcSetupStartInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.start(signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:complete-codex-authentication", ipcSetupCompleteCodexAuthenticationInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.completeCodexAuthentication(signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:begin-asana-authorization", ipcSetupBeginAsanaAuthorizationInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.beginAsanaAuthorization(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:complete-asana-authorization", ipcSetupCompleteAsanaAuthorizationInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.completeAsanaAuthorization(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:cancel-asana-authorization", ipcSetupCancelAsanaAuthorizationInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.cancelAsanaAuthorization(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:list-workspaces", ipcSetupListWorkspacesInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.listWorkspaces(signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:select-workspace", ipcSetupSelectWorkspaceInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.selectWorkspace(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:select-project", ipcSetupSelectProjectInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.selectProject(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:retry-resources", ipcSetupRetryResourcesInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.retryResources(signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:run-capability", ipcSetupRunCapabilityInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.runCapability(signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:choose-vault", ipcSetupChooseVaultInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.chooseVault(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:choose-external-tool", ipcSetupChooseExternalToolInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, input, signal) => port.chooseExternalTool(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:run-full-sync", ipcSetupRunFullSyncInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.runFullSync(signal),
    );
    this.registerPortHandle(
      ipcMain, "setup:run-codex-capability", ipcSetupRunCodexCapabilityInputSchema, ipcSetupStateResponseSchema, "setup",
      async (port, _input, signal) => port.runCodexCapability(signal),
    );
    this.registerPortHandle(
      ipcMain, "gui:apply", ipcGuiEditInputSchema, ipcGuiEditResponseSchema, "gui",
      async (port, input, signal) => port.apply(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "external-agent:get-state", ipcExternalAgentGetStateInputSchema, ipcExternalAgentGetStateResponseSchema, "externalAgent",
      async (port) => port.getState(),
    );
    this.registerPortHandle(
      ipcMain, "external-agent:set-enabled", ipcExternalAgentSetEnabledInputSchema, ipcExternalAgentSetEnabledResponseSchema, "externalAgent",
      async (port, input, signal) => port.setEnabled(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "external-agent:edit", ipcExternalAgentEditInputSchema, ipcExternalAgentEditResponseSchema, "externalAgent",
      async (port, input, signal) => port.edit(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "external-agent:select", ipcExternalAgentSelectInputSchema, ipcExternalAgentSelectResponseSchema, "externalAgent",
      async (port, input, signal) => port.select(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "external-agent:approve", ipcExternalAgentApproveInputSchema, ipcExternalAgentApproveResponseSchema, "externalAgent",
      async (port, input, signal) => port.approve(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "external-agent:reject", ipcExternalAgentRejectInputSchema, ipcExternalAgentRejectResponseSchema, "externalAgent",
      async (port, input, signal) => port.reject(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "ai:start-turn", ipcAiTurnInputSchema, ipcAiTurnResponseSchema, "ai",
      async (port, input, signal) => port.startTurn(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "ai:start-new-session", ipcAiStartNewSessionInputSchema, ipcAiStartNewSessionResponseSchema, "ai",
      async (port, _input, signal) => port.startNewSession(signal),
    );
    this.registerPortHandle(
      ipcMain, "ai:get-status", ipcAiGetStatusInputSchema, ipcAiGetStatusResponseSchema, "ai",
      async (port) => port.getStatus(),
    );
    this.registerPortHandle(
      ipcMain, "ai:get-proposal", ipcAiProposalInputSchema, ipcAiProposalResponseSchema, "ai",
      (port, input) => port.getProposal(input),
    );
    this.registerPortHandle(
      ipcMain, "ai:select", ipcAiSelectionInputSchema, ipcAiSelectionResponseSchema, "ai",
      (port, input) => port.select(input),
    );
    this.registerPortHandle(
      ipcMain, "ai:edit-operation", ipcAiEditInputSchema, ipcAiEditResponseSchema, "ai",
      (port, input) => port.editOperation(input),
    );
    this.registerPortHandle(
      ipcMain,
      "ai:reject",
      ipcAiRejectInputSchema,
      ipcAiRejectResponseSchema,
      "ai",
      async (port, input) => {
        await port.reject(input);
        return createCompletedValue();
      },
    );
    this.registerPortHandle(
      ipcMain, "ai:approve", ipcAiApprovalInputSchema, ipcAiApprovalResponseSchema, "ai",
      async (port, input, signal) => port.approve(input, signal),
    );
    this.registerPortHandle(
      ipcMain, "ai:close-session", ipcAiCloseSessionInputSchema, ipcAiCloseSessionResponseSchema, "ai",
      async (port, sessionId) => port.closeSession(sessionId),
    );
    this.registerPortHandle(
      ipcMain,
      "obsidian:list-vaults",
      ipcObsidianListVaultsInputSchema,
      ipcObsidianListVaultsResponseSchema,
      "obsidian",
      async (port, _input, signal) => {
        const vaultIds = [...await port.listVaults(signal)].sort(compareStrings);
        return { vault_ids: vaultIds };
      },
    );
    this.registerPortHandle(
      ipcMain,
      "obsidian:list-vault-mappings",
      ipcObsidianListVaultMappingsInputSchema,
      ipcObsidianListVaultMappingsResponseSchema,
      "obsidian",
      async (port, _input, signal) => {
        return [...await port.listVaultMappings(signal)];
      },
    );
    this.registerPortHandle(
      ipcMain,
      "obsidian:save-vault-mapping",
      ipcObsidianSaveVaultMappingInputSchema,
      ipcObsidianSaveVaultMappingResponseSchema,
      "obsidian",
      async (port, input, signal) => {
        return [...await port.saveVaultMapping(input, signal)];
      },
    );
    this.registerPortHandle(
      ipcMain, "obsidian:validate-vault", ipcObsidianValidateInputSchema, ipcObsidianValidateResponseSchema, "obsidian",
      async (port, input, signal) => port.validateVault(input.vault_id, signal),
    );
    this.registerPortHandle(
      ipcMain, "obsidian:resolve-path", ipcObsidianPathInputSchema, ipcObsidianPathResponseSchema, "obsidian",
      async (port, input, signal) => port.resolvePath(
          input.vault_id,
          input.relative_path,
          signal,
        ),
    );
    this.registerPortHandle(
      ipcMain, "obsidian:note-exists", ipcObsidianPathInputSchema, ipcObsidianPathResponseSchema, "obsidian",
      async (port, input, signal) => port.noteExists(
          input.vault_id,
          input.relative_path,
          signal,
        ),
    );
    this.registerPortHandle(
      ipcMain,
      "obsidian:open-note",
      ipcObsidianOpenNoteInputSchema,
      ipcObsidianOpenNoteResponseSchema,
      "obsidian",
      async (port, input, signal) => {
        await port.openNote(input.vault_id, input.relative_path, signal);
        return createCompletedValue();
      },
    );
  }

  private registerHandle<TInput, TOutput>(
    ipcMain: IpcMain,
    channel: string,
    inputSchema: z.ZodType<TInput>,
    responseSchema: z.ZodType<IpcResponse<TOutput>>,
    operation: (input: TInput, signal: AbortSignal) => MaybePromise<TOutput>,
  ): void {
    this.registerHandleWithStartupGate(
      ipcMain,
      channel,
      inputSchema,
      responseSchema,
      operation,
      true,
    );
  }

  private registerPortHandle<K extends keyof IpcServicePorts, TInput, TOutput>(
    ipcMain: IpcMain,
    channel: string,
    inputSchema: z.ZodType<TInput>,
    responseSchema: z.ZodType<IpcResponse<TOutput>>,
    portKey: K,
    operation: (
      port: NonNullable<IpcServicePorts[K]>,
      input: TInput,
      signal: AbortSignal,
    ) => MaybePromise<TOutput>,
  ): void {
    this.registerHandle(ipcMain, channel, inputSchema, responseSchema, (input, signal) => {
      const port = this.options.ports[portKey];
      if (port == null) {
        throw new IpcCapabilityUnavailableError();
      }
      return operation(port, input, signal);
    });
  }

  private registerHandleWithStartupGate<TInput, TOutput>(
    ipcMain: IpcMain,
    channel: string,
    inputSchema: z.ZodType<TInput>,
    responseSchema: z.ZodType<IpcResponse<TOutput>>,
    operation: (input: TInput, signal: AbortSignal) => MaybePromise<TOutput>,
    requiresStartupReady: boolean,
  ): void {
    const validatedChannel = ipcChannelSchema.parse(channel);
    ipcMain.handle(validatedChannel, (event, payload: unknown) =>
      this.execute(
        event,
        validatedChannel,
        payload,
        inputSchema,
        responseSchema,
        operation,
        requiresStartupReady,
      ));
    this.cleanup.push(() => {
      ipcMain.removeHandler(validatedChannel);
    });
  }

  private async execute<TInput, TOutput>(
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown,
    inputSchema: z.ZodType<TInput>,
    responseSchema: z.ZodType<IpcResponse<TOutput>>,
    operation: (input: TInput, signal: AbortSignal) => MaybePromise<TOutput>,
    requiresStartupReady: boolean,
  ): Promise<IpcResponse<TOutput>> {
    const controller = new AbortController();
    this.activeAbortControllers.add(controller);
    try {
      try {
        assertTrustedIpcSender(
          event,
          this.options.rendererWebContents,
          this.options.rendererUrl,
        );
      } catch (error: unknown) {
        this.options.diagnostic.record(error, channel);
        return responseSchema.parse(this.createFailure("sender_untrusted"));
      }
      let input: TInput;
      try {
        input = inputSchema.parse(payload);
      } catch (error: unknown) {
        this.options.diagnostic.record(error, channel);
        return responseSchema.parse(this.createFailure("invalid_request"));
      }
      try {
        if (requiresStartupReady) {
          this.options.startupGate.assertReady();
        }
        const value = await operation(input, controller.signal);
        return responseSchema.parse({ kind: "ok", value });
      } catch (error: unknown) {
        if (error instanceof IpcCapabilityUnavailableError) {
          return responseSchema.parse(this.createFailure("not_configured"));
        }
        if (error instanceof DiagnosticFailureDispositionError) {
          switch (error.disposition.kind) {
            case "recorded_only":
              return responseSchema.parse(
                this.createFailure(
                  ipcFailureCodeForError(
                    ipcResponseError(error.disposition.response_error),
                  ),
                ),
              );
            case "unrecorded_only":
              this.options.diagnostic.record(
                error.disposition.unrecorded_error,
                channel,
              );
              return responseSchema.parse(
                this.createFailure(
                  ipcFailureCodeForError(
                    ipcResponseError(error.disposition.response_error),
                  ),
                ),
              );
            case "recorded_and_unrecorded":
              this.options.diagnostic.record(
                error.disposition.unrecorded_error,
                channel,
              );
              return responseSchema.parse(
                this.createFailure(
                  ipcFailureCodeForError(
                    ipcResponseError(error.disposition.response_error),
                  ),
                ),
              );
          }
        }
        if (
          error instanceof StartupGateNotReadyError
          || error instanceof StartupGateFailedError
          || error instanceof StartupGateStoppedError
          || error instanceof StartupGateAbortedError
        ) {
          return responseSchema.parse(
            this.createFailure(ipcFailureCodeForError(error)),
          );
        }
        const operationFailure = classifyIpcOperationFailure(error);
        if (operationFailure.kind === "unreported") {
          this.options.diagnostic.record(operationFailure.error, channel);
        }
        const code = ipcFailureCodeForError(ipcResponseError(error));
        return responseSchema.parse(this.createFailure(code));
      }
    } finally {
      this.activeAbortControllers.delete(controller);
    }
  }

  private createFailure(code: IpcFailure["code"]): IpcFailure {
    return ipcFailureSchema.parse({
      kind: "error",
      code,
      message: ipcFailureMessages[code],
    });
  }

  private registerServiceEvents(): void {
    const { appUpdate, sync, ai, externalAgent } = this.options.ports;
    this.eventSubscriptions.bind(
      "app-update:state", ipcAppUpdateStateSchema, appUpdate?.onState.bind(appUpdate),
    );
    this.eventSubscriptions.bind(
      "sync:state", ipcSyncStateEventSchema, sync?.onState?.bind(sync),
    );
    this.eventSubscriptions.bind(
      "ai:delta", ipcAiDeltaEventSchema, ai?.onDelta?.bind(ai),
    );
    this.eventSubscriptions.bind(
      "ai:status", ipcAiStatusEventSchema, ai?.onStatus?.bind(ai),
    );
    this.eventSubscriptions.bind(
      "external-agent:state", ipcExternalAgentStateEventSchema,
      externalAgent?.onChanged?.bind(externalAgent),
    );
  }

}

/** IPCレジストリを作成して固定チャンネルへ登録します。 */
export function registerIpcHandlers(
  ipcMain: IpcMain,
  options: IpcHandlerRegistryOptions,
): IpcHandlerRegistry {
  const registry = new IpcHandlerRegistry(options);
  registry.register(ipcMain);
  return registry;
}
