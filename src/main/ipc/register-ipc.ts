import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron";
import { diagnosticsContracts } from "../../shared/ipc-contracts/diagnostics";
import { githubIntegrationContracts } from "../../shared/ipc-contracts/github-integration";
import { obsidianIntegrationContracts } from "../../shared/ipc-contracts/obsidian-integration";
import { proposalsContracts } from "../../shared/ipc-contracts/proposals";
import { settingsContracts } from "../../shared/ipc-contracts/settings";
import { systemContracts } from "../../shared/ipc-contracts/system";
import { tasksContracts } from "../../shared/ipc-contracts/tasks";
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
type EventSource<Value> = (listener: (value: Value) => void) => () => void;
type SubscriptionParser = (payload: unknown) => { readonly subscription_id: string };

type FeatureIpcRegistryOptions = {
  readonly signal: AbortSignal;
  readonly record: (error: unknown, channel: string) => void;
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
    const invokes: readonly (readonly [string, InvokeHandler])[] = [
      [systemContracts.getVersion.channel, system.getVersion],
      [systemContracts.waitForStartup.channel, system.waitForStartup],
      [systemContracts.getUpdateState.channel, system.getUpdateState],
      [tasksContracts.getOverview.channel, tasks.getOverview],
      [tasksContracts.getDetail.channel, tasks.getDetail],
      [tasksContracts.getSyncState.channel, tasks.getSyncState],
      [tasksContracts.runSync.channel, tasks.runSync],
      [tasksContracts.applyEdit.channel, tasks.applyEdit],
      [tasksContracts.getExecution.channel, tasks.getExecution],
      [tasksContracts.retryExecution.channel, tasks.retryExecution],
      [settingsContracts.getState.channel, settings.getState],
      [settingsContracts.start.channel, settings.start],
      [settingsContracts.completeCodexAuthentication.channel, settings.completeCodexAuthentication],
      [settingsContracts.beginAsanaAuthorization.channel, settings.beginAsanaAuthorization],
      [settingsContracts.completeAsanaAuthorization.channel, settings.completeAsanaAuthorization],
      [settingsContracts.cancelAsanaAuthorization.channel, settings.cancelAsanaAuthorization],
      [settingsContracts.listWorkspaces.channel, settings.listWorkspaces],
      [settingsContracts.selectWorkspace.channel, settings.selectWorkspace],
      [settingsContracts.selectProject.channel, settings.selectProject],
      [settingsContracts.retryResources.channel, settings.retryResources],
      [settingsContracts.runCapability.channel, settings.runCapability],
      [settingsContracts.chooseVault.channel, settings.chooseVault],
      [settingsContracts.chooseExternalTool.channel, settings.chooseExternalTool],
      [settingsContracts.runFullSync.channel, settings.runFullSync],
      [settingsContracts.runCodexCapability.channel, settings.runCodexCapability],
      [settingsContracts.getAsanaAuthenticationState.channel, settings.getAsanaAuthenticationState],
      [settingsContracts.beginAsanaReauthentication.channel, settings.beginAsanaReauthentication],
      [settingsContracts.completeAsanaReauthentication.channel, settings.completeAsanaReauthentication],
      [settingsContracts.cancelAsanaReauthentication.channel, settings.cancelAsanaReauthentication],
      [proposalsContracts.getAiStatus.channel, proposals.getAiStatus],
      [proposalsContracts.startSession.channel, proposals.startSession],
      [proposalsContracts.startTurn.channel, proposals.startTurn],
      [proposalsContracts.getProposal.channel, proposals.getProposal],
      [proposalsContracts.select.channel, proposals.select],
      [proposalsContracts.editOperation.channel, proposals.editOperation],
      [proposalsContracts.reject.channel, proposals.reject],
      [proposalsContracts.approve.channel, proposals.approve],
      [proposalsContracts.closeSession.channel, proposals.closeSession],
      [proposalsContracts.getExternalState.channel, proposals.getExternalState],
      [proposalsContracts.setExternalEnabled.channel, proposals.setExternalEnabled],
      [proposalsContracts.editExternalOperation.channel, proposals.editExternalOperation],
      [proposalsContracts.selectExternal.channel, proposals.selectExternal],
      [proposalsContracts.approveExternal.channel, proposals.approveExternal],
      [proposalsContracts.rejectExternal.channel, proposals.rejectExternal],
      [proposalsContracts.getHistoryStatus.channel, proposals.getHistoryStatus],
      [proposalsContracts.confirmHistory.channel, proposals.confirmHistory],
      [proposalsContracts.synchronizeHistory.channel, proposals.synchronizeHistory],
      [proposalsContracts.getExecution.channel, proposals.getExecution],
      [proposalsContracts.retryExecution.channel, proposals.retryExecution],
      [githubIntegrationContracts.getStatus.channel, githubIntegration.getStatus],
      [obsidianIntegrationContracts.validateVault.channel, obsidianIntegration.validateVault],
      [obsidianIntegrationContracts.listVaults.channel, obsidianIntegration.listVaults],
      [obsidianIntegrationContracts.listVaultMappings.channel, obsidianIntegration.listVaultMappings],
      [obsidianIntegrationContracts.saveVaultMapping.channel, obsidianIntegration.saveVaultMapping],
      [obsidianIntegrationContracts.resolvePath.channel, obsidianIntegration.resolvePath],
      [obsidianIntegrationContracts.noteExists.channel, obsidianIntegration.noteExists],
      [obsidianIntegrationContracts.openNote.channel, obsidianIntegration.openNote],
      [diagnosticsContracts.report.channel, diagnostics.report],
    ];
    for (const [channel, handler] of invokes) {
      ipcMain.handle(channel, async (event, payload: unknown) => {
        const rendererUrl = this.windows.get(event.sender);
        if (rendererUrl == null) {
          throw new Error("不正なIPC送信元です。");
        }
        this.options.assertTrustedSender(event, event.sender, rendererUrl);
        const controllers = this.activeInvokes.get(event.sender);
        if (controllers == null) {
          throw new Error("IPC送信元のウィンドウがありません。");
        }
        const controller = new AbortController();
        controllers.add(controller);
        try {
          return await handler(payload, controller.signal);
        } finally {
          controllers.delete(controller);
        }
      });
      this.removers.push(() => ipcMain.removeHandler(channel));
    }
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
        this.options.record(error, subscribeChannel);
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
        this.options.record(error, unsubscribeChannel);
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
            this.options.record(error, eventChannel);
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
