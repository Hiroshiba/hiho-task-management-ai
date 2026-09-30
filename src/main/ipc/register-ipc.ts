import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { z } from "zod";
import { ipcFailureSchema } from "../../shared/ipc-contracts/common";
import { diagnosticsContracts } from "../../shared/ipc-contracts/diagnostics";
import { githubIntegrationContracts } from "../../shared/ipc-contracts/github-integration";
import { obsidianIntegrationContracts } from "../../shared/ipc-contracts/obsidian-integration";
import { proposalsContracts } from "../../shared/ipc-contracts/proposals";
import { settingsContracts } from "../../shared/ipc-contracts/settings";
import { systemContracts } from "../../shared/ipc-contracts/system";
import { tasksContracts } from "../../shared/ipc-contracts/tasks";
import { DiagnosticFailureDispositionError, individualDiagnosticErrors } from "../application/common/errors/diagnostic-failure";
import type { GuiEditExecution } from "../application/gui-edit";
import type { StoredProposalExecution } from "../application/proposal-apply";
import type { DiagnosticsHandlers } from "./handlers/diagnostics";
import type { GithubIntegrationHandlers } from "./handlers/github-integration";
import type { ObsidianIntegrationHandlers } from "./handlers/obsidian-integration";
import {
  parseProposalsAiDeltaSubscriptionRequest,
  parseProposalsAiDeltaUnsubscriptionRequest,
  parseProposalsAiStatusSubscriptionRequest,
  parseProposalsAiStatusUnsubscriptionRequest,
  parseProposalsExecutionSubscriptionRequest,
  parseProposalsExecutionUnsubscriptionRequest,
  parseProposalsExternalStateSubscriptionRequest,
  parseProposalsExternalStateUnsubscriptionRequest,
  serializeProposalsAiDeltaEvent,
  serializeProposalsAiStatusEvent,
  serializeProposalsExecutionEvent,
  serializeProposalsExternalStateEvent,
  type ProposalsHandlers,
} from "./handlers/proposals";
import type { SettingsHandlers } from "./handlers/settings";
import type { SystemHandlers } from "./handlers/system";
import {
  parseTasksExecutionSubscriptionRequest,
  parseTasksExecutionUnsubscriptionRequest,
  parseTasksSyncStateSubscriptionRequest,
  parseTasksSyncStateUnsubscriptionRequest,
  serializeTasksExecutionEvent,
  serializeTasksSyncStateEvent,
  type TasksHandlers,
} from "./handlers/tasks";

type InvokeHandler = (payload: unknown, signal: AbortSignal) => Promise<unknown>;
type InvokeContract = {
  readonly channel: string;
  readonly request: { parse(value: unknown): unknown };
  readonly response: { parse(value: unknown): unknown };
};
type InvokeFailureCode = "invalid_request" | "invalid_response" | "sender_untrusted" | "operation_failed";
type EventSource<Value> = (listener: (value: Value) => void) => () => void;
type SubscriptionParser = (payload: unknown) => { readonly subscription_id: string };
type IpcErrorReporter = {
  readonly reportErrorOnce: (error: unknown, context: {
    readonly source: "ipc";
    readonly diagnosticCode: string;
    readonly context: "ipc_diagnostic";
    readonly level: "error";
  }) => string;
};

const invokeFailureMessages = {
  invalid_request: "IPC入力が不正です。",
  invalid_response: "IPC応答が不正です。",
  sender_untrusted: "IPC送信元が信頼できません。",
  operation_failed: "IPC操作に失敗しました。",
} satisfies Record<InvokeFailureCode, string>;

type FeatureIpcRegistryOptions = {
  readonly signal: AbortSignal;
  readonly reporter: IpcErrorReporter;
  readonly assertTrustedSender: (event: IpcMainInvokeEvent, webContents: WebContents, rendererUrl: string) => void;
  readonly isApplicationUrl: (url: string, rendererUrl: string) => boolean;
  readonly handlers: {
    readonly system: SystemHandlers;
    readonly tasks: TasksHandlers;
    readonly settings: SettingsHandlers;
    readonly proposals: ProposalsHandlers;
    readonly githubIntegration: GithubIntegrationHandlers;
    readonly obsidianIntegration: ObsidianIntegrationHandlers;
    readonly diagnostics: DiagnosticsHandlers;
  };
  readonly events: {
    readonly updateState: EventSource<Parameters<SystemHandlers["updateState"]>[1]>;
    readonly syncState: EventSource<Parameters<typeof serializeTasksSyncStateEvent>[1]>;
    readonly guiExecution: EventSource<GuiEditExecution>;
    readonly aiStatus: EventSource<Parameters<typeof serializeProposalsAiStatusEvent>[1]>;
    readonly aiDelta: EventSource<Parameters<typeof serializeProposalsAiDeltaEvent>[1]>;
    readonly externalState: EventSource<Parameters<typeof serializeProposalsExternalStateEvent>[1]>;
    readonly proposalExecution: EventSource<StoredProposalExecution>;
  };
};

/** 最終IPCの登録、購読、ウィンドウごとの解放を管理します。 */
export class FeatureIpcRegistry {
  private readonly windows = new Map<WebContents, string>();
  private readonly subscriptions = new Map<WebContents, Map<string, string>>();
  private readonly activeInvokes = new Map<WebContents, Set<AbortController>>();
  private readonly removers: (() => void)[] = [];
  private registeredIpcMain: IpcMain | undefined;
  private stopped = false;

  public constructor(private readonly options: FeatureIpcRegistryOptions) {}

  /** ウィンドウを登録し、最初のウィンドウで最終IPCを登録します。 */
  public attach(ipcMain: IpcMain, webContents: WebContents, rendererUrl: string): void {
    if (this.stopped || this.options.signal.aborted) {
      throw new Error("停止済みのIPCにウィンドウを接続できません。");
    }
    if (this.windows.has(webContents)) {
      throw new Error("ウィンドウは既にIPCへ接続されています。");
    }
    if (this.registeredIpcMain != null && this.registeredIpcMain !== ipcMain) {
      throw new Error("別のIPCインスタンスには登録できません。");
    }
    this.windows.set(webContents, rendererUrl);
    this.subscriptions.set(webContents, new Map());
    this.activeInvokes.set(webContents, new Set());
    if (this.registeredIpcMain != null) {
      return;
    }
    try {
      this.register(ipcMain);
    } catch (error) {
      this.windows.delete(webContents);
      this.subscriptions.delete(webContents);
      this.activeInvokes.delete(webContents);
      throw error;
    }
  }

  /** ウィンドウ自身の購読を解除し、最後のウィンドウで登録を解放します。 */
  public detach(webContents: WebContents): void {
    if (!this.windows.delete(webContents)) {
      return;
    }
    this.subscriptions.delete(webContents);
    const controllers = this.activeInvokes.get(webContents);
    if (controllers != null) {
      for (const controller of controllers) {
        controller.abort();
      }
    }
    this.activeInvokes.delete(webContents);
    if (this.windows.size === 0) {
      this.unregister();
    }
  }

  /** 停止時に全ウィンドウと最終IPCの登録を解放します。 */
  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const controllers of this.activeInvokes.values()) {
      for (const controller of controllers) {
        controller.abort();
      }
    }
    this.activeInvokes.clear();
    this.subscriptions.clear();
    this.windows.clear();
    this.unregister();
  }

  private register(ipcMain: IpcMain): void {
    try {
      this.registerInvokes(ipcMain);
      this.registerEvents(ipcMain);
      this.registeredIpcMain = ipcMain;
    } catch (error) {
      try {
        this.removeRegistrations();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "IPC登録失敗後の解除に失敗しました。", { cause: error });
      }
      throw error;
    }
  }

  private unregister(): void {
    this.registeredIpcMain = undefined;
    this.removeRegistrations();
  }

  private removeRegistrations(): void {
    const errors: unknown[] = [];
    for (const remove of this.removers.splice(0).reverse()) {
      try {
        remove();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "IPC登録を解除できませんでした。", { cause: errors[0] });
    }
  }

  private registerInvokes(ipcMain: IpcMain): void {
    const { system, tasks, settings, proposals, githubIntegration, obsidianIntegration, diagnostics } = this.options.handlers;
    const invokes: readonly (readonly [InvokeContract, InvokeHandler])[] = [
      [systemContracts.getVersion, system.getVersion],
      [systemContracts.waitForStartup, system.waitForStartup],
      [systemContracts.getUpdateState, system.getUpdateState],
      [tasksContracts.getOverview, tasks.getOverview],
      [tasksContracts.getDetail, tasks.getDetail],
      [tasksContracts.getSyncState, tasks.getSyncState],
      [tasksContracts.runSync, tasks.runSync],
      [tasksContracts.applyEdit, tasks.applyEdit],
      [tasksContracts.getExecution, tasks.getExecution],
      [tasksContracts.retryExecution, tasks.retryExecution],
      [settingsContracts.getState, settings.getState],
      [settingsContracts.start, settings.start],
      [settingsContracts.completeCodexAuthentication, settings.completeCodexAuthentication],
      [settingsContracts.beginAsanaAuthorization, settings.beginAsanaAuthorization],
      [settingsContracts.completeAsanaAuthorization, settings.completeAsanaAuthorization],
      [settingsContracts.cancelAsanaAuthorization, settings.cancelAsanaAuthorization],
      [settingsContracts.listWorkspaces, settings.listWorkspaces],
      [settingsContracts.selectWorkspace, settings.selectWorkspace],
      [settingsContracts.selectProject, settings.selectProject],
      [settingsContracts.retryResources, settings.retryResources],
      [settingsContracts.runCapability, settings.runCapability],
      [settingsContracts.chooseVault, settings.chooseVault],
      [settingsContracts.chooseExternalTool, settings.chooseExternalTool],
      [settingsContracts.runFullSync, settings.runFullSync],
      [settingsContracts.runCodexCapability, settings.runCodexCapability],
      [settingsContracts.getAsanaAuthenticationState, settings.getAsanaAuthenticationState],
      [settingsContracts.beginAsanaReauthentication, settings.beginAsanaReauthentication],
      [settingsContracts.completeAsanaReauthentication, settings.completeAsanaReauthentication],
      [settingsContracts.cancelAsanaReauthentication, settings.cancelAsanaReauthentication],
      [proposalsContracts.getAiStatus, proposals.getAiStatus],
      [proposalsContracts.startSession, proposals.startSession],
      [proposalsContracts.startTurn, proposals.startTurn],
      [proposalsContracts.getProposal, proposals.getProposal],
      [proposalsContracts.select, proposals.select],
      [proposalsContracts.editOperation, proposals.editOperation],
      [proposalsContracts.reject, proposals.reject],
      [proposalsContracts.approve, proposals.approve],
      [proposalsContracts.closeSession, proposals.closeSession],
      [proposalsContracts.getExternalState, proposals.getExternalState],
      [proposalsContracts.setExternalEnabled, proposals.setExternalEnabled],
      [proposalsContracts.editExternalOperation, proposals.editExternalOperation],
      [proposalsContracts.selectExternal, proposals.selectExternal],
      [proposalsContracts.approveExternal, proposals.approveExternal],
      [proposalsContracts.rejectExternal, proposals.rejectExternal],
      [proposalsContracts.getHistoryStatus, proposals.getHistoryStatus],
      [proposalsContracts.confirmHistory, proposals.confirmHistory],
      [proposalsContracts.synchronizeHistory, proposals.synchronizeHistory],
      [proposalsContracts.getExecution, proposals.getExecution],
      [proposalsContracts.listExecutions, proposals.listExecutions],
      [proposalsContracts.retryExecution, proposals.retryExecution],
      [githubIntegrationContracts.getStatus, githubIntegration.getStatus],
      [obsidianIntegrationContracts.validateVault, obsidianIntegration.validateVault],
      [obsidianIntegrationContracts.listVaults, obsidianIntegration.listVaults],
      [obsidianIntegrationContracts.listVaultMappings, obsidianIntegration.listVaultMappings],
      [obsidianIntegrationContracts.saveVaultMapping, obsidianIntegration.saveVaultMapping],
      [obsidianIntegrationContracts.resolvePath, obsidianIntegration.resolvePath],
      [obsidianIntegrationContracts.noteExists, obsidianIntegration.noteExists],
      [obsidianIntegrationContracts.openNote, obsidianIntegration.openNote],
      [diagnosticsContracts.report, diagnostics.report],
    ];
    for (const [contract, handler] of invokes) {
      ipcMain.handle(contract.channel, async (event, payload: unknown) => {
        let failureCode: InvokeFailureCode = "sender_untrusted";
        try {
          const rendererUrl = this.windows.get(event.sender);
          if (rendererUrl == null) {
            throw new Error("不正なIPC送信元です。");
          }
          this.options.assertTrustedSender(event, event.sender, rendererUrl);
          const controllers = this.activeInvokes.get(event.sender);
          if (controllers == null) {
            throw new Error("IPC送信元のウィンドウがありません。");
          }
          failureCode = "invalid_request";
          const request = contract.request.parse(payload);
          const controller = new AbortController();
          controllers.add(controller);
          try {
            failureCode = "operation_failed";
            const response = await handler(request, controller.signal);
            failureCode = "invalid_response";
            return contract.response.parse(response);
          } finally {
            controllers.delete(controller);
          }
        } catch (error) {
          const code = failureCode === "operation_failed" && error instanceof z.ZodError
            ? "invalid_response"
            : failureCode;
          const errorId = this.recordFailure(error);
          return contract.response.parse(ipcFailureSchema.parse({
            kind: "error",
            code,
            message: invokeFailureMessages[code],
            error_id: errorId,
          }));
        }
      });
      this.removers.push(() => ipcMain.removeHandler(contract.channel));
    }
  }

  private recordFailure(error: unknown): string {
    if (error instanceof DiagnosticFailureDispositionError) {
      const disposition = error.disposition;
      switch (disposition.kind) {
        case "recorded_only":
          return this.recordIndividualErrors(disposition.recorded_error);
        case "unrecorded_only":
          return this.record(disposition.unrecorded_error);
        case "recorded_and_unrecorded": {
          const errorId = this.recordIndividualErrors(disposition.recorded_error);
          this.record(disposition.unrecorded_error);
          return errorId;
        }
      }
    }
    return this.record(error);
  }

  private recordIndividualErrors(error: unknown): string {
    const [primary, ...additional] = individualDiagnosticErrors(error);
    const errorId = this.record(primary);
    for (const recorded of additional) {
      this.record(recorded);
    }
    return errorId;
  }

  private record(error: unknown): string {
    return this.options.reporter.reportErrorOnce(error, {
      source: "ipc",
      diagnosticCode: "ipc.error",
      context: "ipc_diagnostic",
      level: "error",
    });
  }

  private registerEvents(ipcMain: IpcMain): void {
    const { system } = this.options.handlers;
    const events = this.options.events;
    this.registerEvent(ipcMain, systemContracts.subscribeUpdateState.channel, systemContracts.unsubscribeUpdateState.channel,
      systemContracts.updateState.channel, system.subscribeUpdateState, system.unsubscribeUpdateState,
      system.updateState, events.updateState);
    this.registerEvent(ipcMain, tasksContracts.subscribeSyncState.channel, tasksContracts.unsubscribeSyncState.channel,
      tasksContracts.syncState.channel, parseTasksSyncStateSubscriptionRequest, parseTasksSyncStateUnsubscriptionRequest,
      serializeTasksSyncStateEvent, events.syncState);
    this.registerEvent(ipcMain, tasksContracts.subscribeExecution.channel, tasksContracts.unsubscribeExecution.channel,
      tasksContracts.execution.channel, parseTasksExecutionSubscriptionRequest, parseTasksExecutionUnsubscriptionRequest,
      serializeTasksExecutionEvent, events.guiExecution);
    this.registerEvent(ipcMain, proposalsContracts.subscribeAiStatus.channel, proposalsContracts.unsubscribeAiStatus.channel,
      proposalsContracts.aiStatus.channel, parseProposalsAiStatusSubscriptionRequest, parseProposalsAiStatusUnsubscriptionRequest,
      serializeProposalsAiStatusEvent, events.aiStatus);
    this.registerEvent(ipcMain, proposalsContracts.subscribeAiDelta.channel, proposalsContracts.unsubscribeAiDelta.channel,
      proposalsContracts.aiDelta.channel, parseProposalsAiDeltaSubscriptionRequest, parseProposalsAiDeltaUnsubscriptionRequest,
      serializeProposalsAiDeltaEvent, events.aiDelta);
    this.registerEvent(ipcMain, proposalsContracts.subscribeExternalState.channel, proposalsContracts.unsubscribeExternalState.channel,
      proposalsContracts.externalState.channel, parseProposalsExternalStateSubscriptionRequest,
      parseProposalsExternalStateUnsubscriptionRequest, serializeProposalsExternalStateEvent, events.externalState);
    this.registerEvent(ipcMain, proposalsContracts.subscribeExecution.channel, proposalsContracts.unsubscribeExecution.channel,
      proposalsContracts.execution.channel, parseProposalsExecutionSubscriptionRequest,
      parseProposalsExecutionUnsubscriptionRequest, serializeProposalsExecutionEvent, events.proposalExecution);
  }

  private registerEvent<Value>(
    ipcMain: IpcMain,
    subscribeChannel: string,
    unsubscribeChannel: string,
    eventChannel: string,
    parseSubscription: SubscriptionParser,
    parseUnsubscription: SubscriptionParser,
    serialize: (subscriptionId: string, value: Value) => unknown,
    source: EventSource<Value>,
  ): void {
    const subscribeListener = (event: IpcMainEvent, payload: unknown): void => {
      try {
        const subscriptions = this.requireSubscriptions(event);
        const { subscription_id: id } = parseSubscription(payload);
        if (subscriptions.has(id)) {
          throw new Error("同じウィンドウで購読IDが重複しています。");
        }
        subscriptions.set(id, eventChannel);
      } catch (error) {
        this.recordFailure(error);
      }
    };
    ipcMain.on(subscribeChannel, subscribeListener);
    this.removers.push(() => ipcMain.removeListener(subscribeChannel, subscribeListener));
    const unsubscribeListener = (event: IpcMainEvent, payload: unknown): void => {
      try {
        const subscriptions = this.requireSubscriptions(event);
        const { subscription_id: id } = parseUnsubscription(payload);
        if (subscriptions.get(id) !== eventChannel) {
          throw new Error("このウィンドウに解除対象の購読がありません。");
        }
        subscriptions.delete(id);
      } catch (error) {
        this.recordFailure(error);
      }
    };
    ipcMain.on(unsubscribeChannel, unsubscribeListener);
    this.removers.push(() => ipcMain.removeListener(unsubscribeChannel, unsubscribeListener));
    const removeSource = source((value) => {
      for (const [webContents, subscriptions] of this.subscriptions) {
        if (webContents.isDestroyed()) {
          continue;
        }
        for (const [id, channel] of subscriptions) {
          if (channel !== eventChannel) {
            continue;
          }
          try {
            webContents.send(eventChannel, serialize(id, value));
          } catch (error) {
            this.recordFailure(error);
          }
        }
      }
    });
    this.removers.push(removeSource);
  }

  private requireSubscriptions(event: IpcMainEvent): Map<string, string> {
    const rendererUrl = this.windows.get(event.sender);
    if (rendererUrl == null
      || event.senderFrame !== event.sender.mainFrame
      || !this.options.isApplicationUrl(event.senderFrame.url, rendererUrl)) {
      throw new Error("不正なIPC送信元です。");
    }
    const subscriptions = this.subscriptions.get(event.sender);
    if (subscriptions == null) {
      throw new Error("IPC送信元のウィンドウがありません。");
    }
    return subscriptions;
  }
}
