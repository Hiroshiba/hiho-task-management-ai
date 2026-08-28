import type {
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
} from "electron";
import { z } from "zod";
import { externalToolDefinitionSchema } from "../external-tools/schemas";
import {
  assertTrustedIpcSender,
  isApplicationUrl,
} from "../security";
import { externalToolCredentialReferenceNamesSchema } from "../../shared/storage";
import {
  ipcAiApprovalInputSchema,
  ipcAiApprovalResponseSchema,
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
  ipcAsanaReauthenticateOAuthInputSchema,
  ipcAsanaReauthenticateOAuthResponseSchema,
  ipcChannelSchema,
  ipcEmptyRequestSchema,
  ipcExternalToolListResponseSchema,
  ipcExternalToolRemoveInputSchema,
  ipcExternalToolRemoveResponseSchema,
  ipcExternalToolReplaceInputSchema,
  ipcExternalToolReplaceResponseSchema,
  ipcFailureSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResponseSchema,
  ipcObsidianListInputSchema,
  ipcObsidianListVaultsInputSchema,
  ipcObsidianListVaultsResponseSchema,
  ipcObsidianListResponseSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianPathResponseSchema,
  ipcObsidianReadResponseSchema,
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
  type IpcAiApprovalResult,
  type IpcAiEditInput,
  type IpcAiNewSessionResult,
  type IpcAiStatus,
  type IpcAiProposalView,
  type IpcAiSelectionInput,
  type IpcAiTurnInput,
  type IpcAiTurnResult,
  type IpcCodexDelta,
  type IpcSetupCredentialsInput,
  type IpcSetupExternalToolChoiceInput,
  type IpcSetupProjectSelectionInput,
  type IpcSetupState,
  type IpcSetupVaultChoiceInput,
  type IpcSetupWorkspaceSelectionInput,
  type IpcExternalToolReplaceInput,
  type IpcExternalToolSummary,
  type IpcFailure,
  type IpcGuiEditInput,
  type IpcGuiEditResult,
  type IpcObsidianNoteResult,
  type IpcObsidianNoteSummary,
  type IpcObsidianPathResult,
  type IpcObsidianSearchResult,
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
  reauthenticateOAuth(signal: AbortSignal): MaybePromise<IpcSyncResult>;
}

/** 初回設定の状態機械をIPCへ提供するポートです。 */
export interface IpcSetupPort {
  getState(): MaybePromise<IpcSetupState>;
  start(signal: AbortSignal): MaybePromise<IpcSetupState>;
  completeCodexAuthentication(signal: AbortSignal): MaybePromise<IpcSetupState>;
  authenticateAsana(input: IpcSetupCredentialsInput, signal: AbortSignal): MaybePromise<IpcSetupState>;
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

/** AIワークフローをIPCへ提供するポートです。 */
export interface IpcAiPort {
  getStatus(): MaybePromise<IpcAiStatus>;
  startNewSession(signal: AbortSignal): MaybePromise<IpcAiNewSessionResult>;
  startTurn(input: IpcAiTurnInput, signal: AbortSignal): MaybePromise<IpcAiTurnResult>;
  getProposal(proposalId: string): MaybePromise<IpcAiProposalView>;
  select(input: IpcAiSelectionInput): MaybePromise<IpcAiProposalView>;
  editOperation(input: IpcAiEditInput): MaybePromise<IpcAiProposalView>;
  rejectProposal(proposalId: string): MaybePromise<void>;
  approve(input: IpcAiApprovalInput, signal: AbortSignal): MaybePromise<IpcAiApprovalResult>;
  onDelta?(listener: (delta: IpcCodexDelta) => void): () => void;
  onStatus?(listener: (status: IpcAiStatus) => void): () => void;
}

/** 外部ツール定義をIPCへ提供するポートです。 */
export interface IpcExternalToolPort {
  list(): MaybePromise<readonly IpcExternalToolSummary[]>;
  replace(input: IpcExternalToolReplaceInput): MaybePromise<void>;
  remove(toolId: string): MaybePromise<void>;
}

/** Obsidian読み取りをIPCへ提供するポートです。 */
export interface IpcObsidianPort {
  listVaults(signal: AbortSignal): MaybePromise<readonly string[]>;
  validateVault(vaultId: string, signal: AbortSignal): MaybePromise<IpcObsidianVaultResult>;
  listNotes(vaultId: string, signal: AbortSignal): MaybePromise<readonly IpcObsidianNoteSummary[]>;
  resolvePath(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<IpcObsidianPathResult>;
  noteExists(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<IpcObsidianPathResult>;
  search(vaultId: string, query: string, signal: AbortSignal): MaybePromise<readonly IpcObsidianSearchResult[]>;
  readNote(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<IpcObsidianNoteResult>;
  openNote(vaultId: string, relativePath: string, signal: AbortSignal): MaybePromise<void>;
}

/** IPCの依存ポートをまとめた設定です。 */
export interface IpcServicePorts {
  readonly asana?: IpcAsanaPort;
  readonly readModel?: IpcReadModelPort;
  readonly sync?: IpcSyncPort;
  readonly setup?: IpcSetupPort;
  readonly gui?: IpcGuiEditPort;
  readonly ai?: IpcAiPort;
  readonly externalTools?: IpcExternalToolPort;
  readonly obsidian?: IpcObsidianPort;
}

/** IPCハンドラー登録の設定です。 */
export interface IpcHandlerRegistryOptions {
  readonly rendererWebContents: WebContents;
  readonly rendererUrl: string;
  readonly ports: IpcServicePorts;
  readonly diagnostic: IpcDiagnosticPort;
}

class IpcCapabilityUnavailableError extends Error {
  public constructor() {
    super("IPC機能が利用できません。");
    this.name = "IpcCapabilityUnavailableError";
  }
}

type HandlerRemover = () => void;

const externalToolDefinitionRecordSchema = externalToolDefinitionSchema
  .extend({ credential_reference_names: externalToolCredentialReferenceNamesSchema })
  .strict();

const failureMessages: Record<IpcFailure["code"], string> = {
  invalid_request: "IPC入力が不正です。",
  invalid_response: "IPC応答が不正です。",
  sender_untrusted: "IPC送信元が信頼できません。",
  not_configured: "この機能は設定されていません。",
  operation_failed: "IPC操作に失敗しました。",
  aborted: "IPC操作が中断されました。",
  conflict: "操作が競合しました。",
  not_found: "指定された対象が見つかりません。",
  authentication_required: "認証が必要です。",
  unavailable: "この機能は現在利用できません。",
};

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
  private readonly syncSubscribers = new Set<WebContents>();
  private readonly aiSubscribers = new Set<WebContents>();
  private readonly aiStatusSubscribers = new Set<WebContents>();
  private readonly activeAbortControllers = new Set<AbortController>();
  private registeredIpcMain: IpcMain | undefined;
  private disposed = false;

  public constructor(options: IpcHandlerRegistryOptions) {
    validateOptions(options);
    this.options = options;
  }

  /** 固定チャンネルのIPCハンドラーを登録します。 */
  public register(ipcMain: IpcMain): void {
    if (this.registeredIpcMain != null) {
      throw new Error("IPCハンドラーは重複登録できません。");
    }
    this.disposed = false;
    this.registeredIpcMain = ipcMain;
    this.registerInvokeHandlers(ipcMain);
    this.registerEventHandlers(ipcMain);
    this.registerServiceEvents();
  }

  /** 登録済みIPCハンドラーと購読を解放します。 */
  public dispose(): void {
    this.disposed = true;
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
    this.syncSubscribers.clear();
    this.aiSubscribers.clear();
    this.aiStatusSubscribers.clear();
    this.registeredIpcMain = undefined;
  }

  private registerInvokeHandlers(ipcMain: IpcMain): void {
    this.registerHandle(
      ipcMain,
      "asana:reauthenticate-oauth",
      ipcAsanaReauthenticateOAuthInputSchema,
      ipcAsanaReauthenticateOAuthResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.asana;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.reauthenticateOAuth(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "read-model:get-overview",
      ipcReadModelOverviewInputSchema,
      ipcReadModelOverviewResponseSchema,
      async (input) => {
        const port = this.options.ports.readModel;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        ipcEmptyRequestSchema.parse(input);
        return port.getOverview();
      },
    );
    this.registerHandle(
      ipcMain,
      "read-model:get-task-detail",
      ipcReadModelTaskDetailInputSchema,
      ipcReadModelTaskDetailResponseSchema,
      async (input) => {
        const port = this.options.ports.readModel;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.getTaskDetail(input.task_gid);
      },
    );
    this.registerHandle(
      ipcMain,
      "sync:run",
      ipcSyncInputSchema,
      ipcSyncResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.sync;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.run(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "sync:get-state",
      ipcSyncGetStateInputSchema,
      ipcSyncGetStateResponseSchema,
      async () => {
        const port = this.options.ports.sync;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.getState();
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:get-state",
      ipcEmptyRequestSchema,
      ipcSetupStateResponseSchema,
      async () => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.getState();
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:start",
      ipcSetupStartInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.start(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:complete-codex-authentication",
      ipcSetupCompleteCodexAuthenticationInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.completeCodexAuthentication(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:authenticate-asana",
      ipcSetupAuthenticateAsanaInputSchema,
      ipcSetupStateResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.authenticateAsana(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:list-workspaces",
      ipcSetupListWorkspacesInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.listWorkspaces(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:select-workspace",
      ipcSetupSelectWorkspaceInputSchema,
      ipcSetupStateResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.selectWorkspace(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:select-project",
      ipcSetupSelectProjectInputSchema,
      ipcSetupStateResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.selectProject(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:retry-resources",
      ipcSetupRetryResourcesInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.retryResources(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:run-capability",
      ipcSetupRunCapabilityInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.runCapability(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:choose-vault",
      ipcSetupChooseVaultInputSchema,
      ipcSetupStateResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.chooseVault(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:choose-external-tool",
      ipcSetupChooseExternalToolInputSchema,
      ipcSetupStateResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.chooseExternalTool(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:run-full-sync",
      ipcSetupRunFullSyncInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.runFullSync(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "setup:run-codex-capability",
      ipcSetupRunCodexCapabilityInputSchema,
      ipcSetupStateResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.setup;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.runCodexCapability(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "gui:apply",
      ipcGuiEditInputSchema,
      ipcGuiEditResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.gui;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.apply(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:start-turn",
      ipcAiTurnInputSchema,
      ipcAiTurnResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.startTurn(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:start-new-session",
      ipcAiStartNewSessionInputSchema,
      ipcAiStartNewSessionResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.startNewSession(signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:get-status",
      ipcAiGetStatusInputSchema,
      ipcAiGetStatusResponseSchema,
      async () => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.getStatus();
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:get-proposal",
      ipcAiProposalInputSchema,
      ipcAiProposalResponseSchema,
      (input) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.getProposal(input.proposal_id);
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:select",
      ipcAiSelectionInputSchema,
      ipcAiSelectionResponseSchema,
      (input) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.select(input);
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:edit-operation",
      ipcAiEditInputSchema,
      ipcAiEditResponseSchema,
      (input) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.editOperation(input);
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:reject",
      ipcAiRejectInputSchema,
      ipcAiRejectResponseSchema,
      async (input) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        await port.rejectProposal(input.proposal_id);
        return createCompletedValue();
      },
    );
    this.registerHandle(
      ipcMain,
      "ai:approve",
      ipcAiApprovalInputSchema,
      ipcAiApprovalResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.ai;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.approve(input, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "external-tools:list",
      ipcEmptyRequestSchema,
      ipcExternalToolListResponseSchema,
      async () => {
        const port = this.options.ports.externalTools;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return { tools: [...await port.list()] };
      },
    );
    this.registerHandle(
      ipcMain,
      "external-tools:replace",
      ipcExternalToolReplaceInputSchema,
      ipcExternalToolReplaceResponseSchema,
      async (input) => {
        const port = this.options.ports.externalTools;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        const definition = externalToolDefinitionRecordSchema.parse(input.definition);
        await port.replace({
          definition,
          credential_values: input.credential_values,
        });
        return createCompletedValue();
      },
    );
    this.registerHandle(
      ipcMain,
      "external-tools:remove",
      ipcExternalToolRemoveInputSchema,
      ipcExternalToolRemoveResponseSchema,
      async (input) => {
        const port = this.options.ports.externalTools;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        await port.remove(input.tool_id);
        return createCompletedValue();
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:list-vaults",
      ipcObsidianListVaultsInputSchema,
      ipcObsidianListVaultsResponseSchema,
      async (_input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        const vaultIds = [...await port.listVaults(signal)].sort(compareStrings);
        return { vault_ids: vaultIds };
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:validate-vault",
      ipcObsidianValidateInputSchema,
      ipcObsidianValidateResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.validateVault(input.vault_id, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:list-notes",
      ipcObsidianListInputSchema,
      ipcObsidianListResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return [...await port.listNotes(input.vault_id, signal)];
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:resolve-path",
      ipcObsidianPathInputSchema,
      ipcObsidianPathResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.resolvePath(
          input.vault_id,
          input.relative_path,
          signal,
        );
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:note-exists",
      ipcObsidianPathInputSchema,
      ipcObsidianPathResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.noteExists(
          input.vault_id,
          input.relative_path,
          signal,
        );
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:search",
      ipcObsidianSearchInputSchema,
      ipcObsidianSearchResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return [...await port.search(input.vault_id, input.query, signal)];
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:read-note",
      ipcObsidianPathInputSchema,
      ipcObsidianReadResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
        return port.readNote(input.vault_id, input.relative_path, signal);
      },
    );
    this.registerHandle(
      ipcMain,
      "obsidian:open-note",
      ipcObsidianOpenNoteInputSchema,
      ipcObsidianOpenNoteResponseSchema,
      async (input, signal) => {
        const port = this.options.ports.obsidian;
        if (port == null) {
          throw new IpcCapabilityUnavailableError();
        }
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
    const validatedChannel = ipcChannelSchema.parse(channel);
    ipcMain.handle(validatedChannel, (event, payload: unknown) =>
      this.execute(
        event,
        validatedChannel,
        payload,
        inputSchema,
        responseSchema,
        operation,
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
        const value = await operation(input, controller.signal);
        return responseSchema.parse({ kind: "ok", value });
      } catch (error: unknown) {
        if (error instanceof IpcCapabilityUnavailableError) {
          return responseSchema.parse(this.createFailure("not_configured"));
        }
        this.options.diagnostic.record(error, channel);
        const code: IpcFailure["code"] = error instanceof z.ZodError
          ? "invalid_response"
          : "operation_failed";
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
      message: failureMessages[code],
    });
  }

  private registerEventHandlers(ipcMain: IpcMain): void {
    this.registerSubscription(
      ipcMain,
      "sync:state:subscribe",
      this.syncSubscribers,
    );
    this.registerSubscription(
      ipcMain,
      "sync:state:unsubscribe",
      this.syncSubscribers,
    );
    this.registerSubscription(
      ipcMain,
      "ai:delta:subscribe",
      this.aiSubscribers,
    );
    this.registerSubscription(
      ipcMain,
      "ai:delta:unsubscribe",
      this.aiSubscribers,
    );
    this.registerSubscription(
      ipcMain,
      "ai:status:subscribe",
      this.aiStatusSubscribers,
    );
    this.registerSubscription(
      ipcMain,
      "ai:status:unsubscribe",
      this.aiStatusSubscribers,
    );
  }

  private registerSubscription(
    ipcMain: IpcMain,
    channel: string,
    subscribers: Set<WebContents>,
  ): void {
    const validatedChannel = ipcChannelSchema.parse(channel);
    const listener = (event: IpcMainEvent, payload: unknown): void => {
      try {
        validateEventSender(
          event,
          this.options.rendererWebContents,
          this.options.rendererUrl,
        );
        ipcEmptyRequestSchema.parse(payload);
        if (validatedChannel.endsWith(":subscribe")) {
          subscribers.add(event.sender);
        } else {
          subscribers.delete(event.sender);
        }
      } catch (error: unknown) {
        this.options.diagnostic.record(error, validatedChannel);
      }
    };
    ipcMain.on(validatedChannel, listener);
    this.cleanup.push(() => {
      ipcMain.removeListener(validatedChannel, listener);
    });
  }

  private registerServiceEvents(): void {
    const sync = this.options.ports.sync;
    if (sync?.onState != null) {
      const remove = sync.onState((state) => {
        this.sendServiceEvent(
          ipcSyncStateEventSchema,
          state,
          this.syncSubscribers,
          "sync:state",
        );
      });
      this.cleanup.push(remove);
    }
    const ai = this.options.ports.ai;
    if (ai?.onDelta != null) {
      const remove = ai.onDelta((delta) => {
        this.sendServiceEvent(
          ipcAiDeltaEventSchema,
          delta,
          this.aiSubscribers,
          "ai:delta",
        );
      });
      this.cleanup.push(remove);
    }
    if (ai?.onStatus != null) {
      const remove = ai.onStatus((status) => {
        this.sendServiceEvent(
          ipcAiStatusEventSchema,
          status,
          this.aiStatusSubscribers,
          "ai:status",
        );
      });
      this.cleanup.push(remove);
    }
  }

  private sendServiceEvent<T>(
    schema: z.ZodType<T>,
    value: unknown,
    subscribers: ReadonlySet<WebContents>,
    channel: string,
  ): void {
    if (this.disposed) {
      return;
    }
    try {
      const parsed = schema.parse(value);
      this.sendToSubscribers(subscribers, channel, parsed);
    } catch (error: unknown) {
      this.options.diagnostic.record(error, channel);
    }
  }

  private sendToSubscribers<T>(
    subscribers: ReadonlySet<WebContents>,
    channel: string,
    payload: T,
  ): void {
    if (this.disposed) {
      return;
    }
    for (const webContents of subscribers) {
      if (!webContents.isDestroyed()) {
        webContents.send(channel, payload);
      }
    }
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
