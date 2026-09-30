import { z } from "zod";
import { proposalsContracts } from "../../shared/ipc-contracts/proposals";
import { settingsContracts } from "../../shared/ipc-contracts/settings";
import { detailSchema, overviewSchema } from "../../shared/ipc-contracts/task-view";
import { applyEditRequestSchema } from "../../shared/ipc-contracts/tasks";
import { validateAbortSignal } from "../application/common/abort-signal";
import { DiagnosticLogService } from "../application/common/diagnostic-log-service";
import {
  DiagnosticFailureDispositionError,
  combineDiagnosticFailures,
  diagnosticFailureDispositionFromError,
} from "../application/common/errors/diagnostic-failure";
import type { TaskWriteAsanaBridge } from "../application/common/ports/asana-task-write";
import type { ListProposalExecutionsInput } from "../application/common/ports/proposal-execution-repository";
import {
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResultWithCause,
} from "../application/common/proposal-application-schemas";
import { todayJst } from "../application/common/runtime-clock";
import {
  type GuiEditExecution,
  type GuiEditExecutionPort,
  type GuiEditExecutionWorkflow,
  type GuiEditWorkflowResult,
} from "../application/gui-edit";
import {
  ExternalAgentApplication,
  executeStoredProposalApplication,
  prepareProposalApprovalInput,
  type ProposalExecutionWorkflow,
  type StoredProposalExecution,
  type StoredProposalExecutionPort,
} from "../application/proposal-apply";
import {
  AiWorkflowService,
  type ApprovalPreparationInput,
} from "../application/proposal-generate";
import {
  AsanaReauthenticationRuntime,
  SetupIpcWorkflow,
  SetupOrchestrator,
  contextFromState,
  readSettingsState,
  type ApplicationState,
  type OperationalContext,
  type SetupExternalToolConfigurationResult,
  type SetupFullSyncInput,
} from "../application/settings";
import {
  aiWorkflowOperationEditSchema,
  aiWorkflowSelectionRequestSchema,
  canonicalizeJson,
  identifierSchema,
} from "../domain";
import {
  CodexSessionAbortedError,
  CodexSessionService,
  ExternalToolStatusEvidenceCollector,
  externalAgentProtocol,
  type TaskctlSnapshot,
} from "../infrastructure/ai";
import {
  AsanaSyncRuntime,
  getUniqueAsanaHttpStatus,
  type AsanaSyncCoordinatorResult,
  type AsanaSyncRuntimeInternalResult,
  type AsanaSyncRuntimeState,
} from "../infrastructure/asana";
import {
  SetupCheckpointStore,
  SqliteSettingsRepository,
  deviceSettingsSchema,
  diagnosticLogEntrySchema,
  diagnosticRecordSchema,
  type DeviceSettings,
  type DiagnosticLogEntry,
  type DiagnosticRecord,
} from "../infrastructure/persistence";
import type { ProposalsHandlerWorkflows } from "../ipc/handlers/proposals";
import { type AiSessionBaselineStore as RuntimeAiSessionBaselineStore } from "./ai-session-runtime";
import { createAiWorkflow } from "./create-ai-workflow";
import { createSettingsCompositionDependencies } from "./create-settings-composition-dependencies";
import { createSynchronizationCompositionDependencies } from "./create-synchronization-composition-dependencies";
import type { SynchronizationCompositionPort } from "./create-synchronization-runtime";
import { createTaskReadCompositionDependencies } from "./create-task-read-composition-dependencies";
import type { TaskReadCompositionPort } from "./create-task-read-runtime";
import { MainWorkflowConstruction } from "./main-workflow-construction";
import {
  setupDiscordExternalToolConfigurationInputSchema,
  setupStateSchema,
  type SetupDiscordExternalToolConfigurationInput,
  type SetupState,
} from "./setup-contracts";
import { SynchronizationOperations } from "./synchronization-operations";

type AiStatus = z.output<typeof proposalsContracts.aiStatus.event.shape.value>;
type AiDelta = z.output<typeof proposalsContracts.aiDelta.event.shape.value>;
type AsanaReauthenticationCompleteInput = z.output<typeof settingsContracts.completeAsanaReauthentication.request>;
type AsanaReauthenticationCancelInput = z.output<typeof settingsContracts.cancelAsanaReauthentication.request>;
type AsanaAuthenticationState = Extract<
  z.output<typeof settingsContracts.getAsanaAuthenticationState.response>,
  { kind: "ok" }
>["value"];
type ProposalHistoryStatus = Extract<
  z.output<typeof proposalsContracts.getHistoryStatus.response>,
  { kind: "ok" }
>["value"];
type ProposalHistorySynchronization = Extract<
  z.output<typeof proposalsContracts.synchronizeHistory.response>,
  { kind: "ok" }
>["value"];
type BaselineExternalData = AsanaProposalApplicationInput["baseline_external_data"];
type AiSessionBaselineStore = RuntimeAiSessionBaselineStore<BaselineExternalData, TaskctlSnapshot>;




const serviceErrorDiagnostic = {
  kind: "service",
  severity: "error",
} satisfies { readonly kind: "service"; readonly severity: "warning" | "error" };
const serviceWarningDiagnostic = {
  kind: "service",
  severity: "warning",
} satisfies { readonly kind: "service"; readonly severity: "warning" | "error" };


class UnreachableError extends Error {}

function assertNonNullable<T>(value: T | undefined, message: string): asserts value is T {
  if (value == null) throw new Error(message);
}

type SavedOperationStatusResult = Extract<
  Extract<externalAgentProtocol.ExternalAgentProposalStatusResult, { kind: "journals" }>["results"][number]["result"],
  { kind: "execution" | "unknown" | "legacy_history" }
>;


type ReauthenticationCompositionOptions = ConstructorParameters<typeof AsanaReauthenticationRuntime<
  DeviceSettings,
  AsanaReauthenticationCompleteInput,
  AsanaReauthenticationCancelInput,
  AsanaAuthenticationState,
  AsanaSyncCoordinatorResult
>>[0];

type SetupIpcCompositionOptions = ConstructorParameters<typeof SetupIpcWorkflow<
  SetupState,
  Parameters<SetupOrchestrator["beginAsanaAuthorization"]>[0],
  Parameters<SetupOrchestrator["completeAsanaAuthorization"]>[0],
  Parameters<SetupOrchestrator["cancelAsanaAuthorization"]>[0],
  Parameters<SetupOrchestrator["selectWorkspace"]>[0],
  Parameters<SetupOrchestrator["selectProject"]>[0],
  Parameters<SetupOrchestrator["chooseVault"]>[0],
  Parameters<SetupOrchestrator["chooseExternalTool"]>[0]
>>[0];

type SettingsCompositionDependencies = {
  readonly settingsRepository: SqliteSettingsRepository<DeviceSettings>;
  readonly checkpoint: SetupCheckpointStore;
  readonly parseState: (value: unknown) => SetupState;
  readonly contextFromState: typeof contextFromState;
  readonly parseId: (value: unknown) => string;
  readonly setupPorts: Omit<ConstructorParameters<typeof SetupOrchestrator>[0], "device_id">;
} & ReauthenticationCompositionOptions & Omit<SetupIpcCompositionOptions, "setup" | "parseState">;

type DiagnosticCompositionDependencies = {
  readonly appVersion: string;
  readonly now: () => Date;
  readonly parseAppVersion: (value: unknown) => string;
  readonly parseRecord: (value: unknown) => DiagnosticRecord;
  readonly parseEntry: (value: unknown) => DiagnosticLogEntry;
};

type TaskReadRuntimePort = {
  readonly createSyncRuntime: (context: OperationalContext, online: boolean) => AsanaSyncRuntime;
  readonly subscribeRuntime: (runtime: AsanaSyncRuntime) => void;
  readonly runSetupFullSync: (input: SetupFullSyncInput, signal: AbortSignal) => Promise<void>;
  readonly synchronizeReauthentication: (signal: AbortSignal) => Promise<AsanaSyncCoordinatorResult>;
  readonly stop: () => void;
};

type SynchronizationRuntime = SynchronizationOperations<
  AsanaSyncRuntimeInternalResult,
  PostWriteSynchronizationResultWithCause,
  PostWriteSynchronizationFailureCode
>;

type SynchronizationCompositionDependencies = SynchronizationCompositionPort<
  AsanaSyncRuntimeInternalResult,
  PostWriteSynchronizationResultWithCause,
  PostWriteSynchronizationFailureCode,
  OperationalContext
>;

type TaskReadCompositionDependencies = TaskReadCompositionPort<
  z.output<typeof overviewSchema>,
  z.output<typeof detailSchema>,
  AsanaSyncRuntimeInternalResult,
  AsanaSyncCoordinatorResult,
  AsanaSyncRuntimeState,
  OperationalContext,
  SetupFullSyncInput,
  AsanaSyncRuntime
>;

/** Mainのworkflowとportを組み立てます。 */
export class MainWorkflowComposition extends MainWorkflowConstruction {
  protected get setup(): SetupOrchestrator {
    const setup = this.attachedSetup;
    assertNonNullable(setup, "初回設定workflowが接続されていません。");
    return setup;
  }

  private get diagnostics(): DiagnosticLogService<DiagnosticRecord, DiagnosticLogEntry> {
    const diagnostics = this.attachedDiagnostics;
    assertNonNullable(diagnostics, "診断ログサービスが接続されていません。");
    return diagnostics;
  }

  /** 構造化診断ログの保存サービスを接続します。 */
  public attachDiagnosticRuntime(diagnostics: DiagnosticLogService<DiagnosticRecord, DiagnosticLogEntry>): void {
    if (this.attachedDiagnostics != null) {
      throw new Error("診断ログサービスを二重に接続できません。");
    }
    this.attachedDiagnostics = diagnostics;
  }

  /** タスク読取の同期資源を一度だけ接続します。 */
  public attachTaskReadRuntime(runtime: TaskReadRuntimePort): void {
    if (this.attachedTaskReadRuntime != null) {
      throw new Error("タスク読取ランタイムを二重に接続できません。");
    }
    this.attachedTaskReadRuntime = runtime;
  }

  /** 同期の競合状態と復旧入口を一度だけ接続します。 */
  public attachSynchronizationRuntime(runtime: SynchronizationRuntime): void {
    if (this.attachedSynchronizationOperations != null) {
      throw new Error("同期ランタイムを二重に接続できません。");
    }
    this.attachedSynchronizationOperations = runtime;
  }

  protected get synchronizationOperations(): SynchronizationRuntime {
    const runtime = this.attachedSynchronizationOperations;
    assertNonNullable(runtime, "同期ランタイムが接続されていません。");
    return runtime;
  }

  /** 同期の競合状態と復旧を組み立てるための運用操作を公開します。 */
  public getSynchronizationCompositionDependencies(): SynchronizationCompositionDependencies {
    return createSynchronizationCompositionDependencies({
      hasOperationOwner: (signal) => this.operationQueue.hasOwner(signal),
      hasPendingJournal: () => this.journalRecovery.hasPending(),
      hasIncompleteJournal: () => this.journalRecovery.hasIncompleteForSynchronization(),
      isJournalRecoveryRunning: () => this.journalRecovery.isRunning(),
      assertPostWriteSynchronizationReady: (executionId) =>
        this.journalRecovery.assertPostWriteSynchronizationReady(executionId),
      recoverJournal: (signal) => this.journalRecovery.recover(signal),
      afterLocalStateRefresh: (signal) => this.localStateRefresh.afterLocalStateRefresh(signal),
      synchronizeCodexAfterAsana: (signal) => this.configuredCodexRuntime.synchronizeAfterAsana(signal),
      requireRuntime: () => this.requireRuntime(),
      requireContext: () => this.requireContext(),
      syncCoordinator: this.syncCoordinator,
      appVersion: this.options.app_version,
      recordLocalRefreshFailure: (error) => this.recordFeatureFailure(
        error,
        "local_state_refresh",
        "Asana同期後の補助的なローカル状態更新に失敗しました。",
      ),
    });
  }

  protected requireTaskReadRuntime(): TaskReadRuntimePort {
    const runtime = this.attachedTaskReadRuntime;
    assertNonNullable(runtime, "タスク読取ランタイムが接続されていません。");
    return runtime;
  }

  /** タスク読取の構成に必要な運用操作を公開します。 */
  public getTaskReadCompositionDependencies(): TaskReadCompositionDependencies {
    return createTaskReadCompositionDependencies({
      repository: this.taskReadRepository,
      persistenceContracts: this.taskReadPersistenceContracts,
      syncCoordinator: this.syncCoordinator,
      operationQueue: this.operationQueue,
      lifecycleSignal: this.options.lifecycle_signal,
      appVersion: this.options.app_version,
      snapshotHasher: this.options.snapshot_hasher,
      createSyncRuntime: this.createSyncRuntimeFactory,
      diagnostic: (error, channel) => this.options.diagnostic(error, channel, serviceErrorDiagnostic),
      recordDiagnostic: (code) => this.recordDiagnostic(code, "info"),
      shouldReportKnownFailure: () => this.synchronizationOperations.shouldReportKnownFailure(),
      afterLocalStateRefresh: (signal) => this.localStateRefresh.afterLocalStateRefresh(signal),
      isReadyActivated: () => this.startupRuntime.isReadyActivated(),
      synchronizeCodex: (signal) => this.configuredCodexRuntime.synchronizeAfterAsana(signal),
      reportUnexpectedError: (error, feature) => this.recordUnexpectedError(error, feature),
      requireContext: () => this.requireContext(),
      assertReady: () => this.assertOperationalReady(),
      assertReauthenticationIdle: () => this.asanaReauthentication.assertIdle(),
      requireRuntime: () => this.requireRuntime(),
      getRuntime: () => this.operationalServices.getRuntime(),
      beforeSynchronization: (signal, executionId) =>
        this.synchronizationOperations.beforeSynchronization(signal, executionId),
      configureContextFromSetup: () => this.operationalContext.configureFromState(this.setup.getState()),
      requireSynchronizedResult: (result) => this.synchronizationOperations.requireSynchronizedResult(result),
      afterSynchronizedState: (result, signal) =>
        this.synchronizationOperations.afterSynchronizedState(result, signal),
    });
  }

  /** 構造化診断ログの保存契約を組み立て側へ公開します。 */
  public getDiagnosticCompositionDependencies(): DiagnosticCompositionDependencies {
    return {
      appVersion: this.options.app_version,
      now: this.options.now_provider,
      parseAppVersion: (value) => identifierSchema.parse(value),
      parseRecord: (value) => diagnosticRecordSchema.parse(value),
      parseEntry: (value) => diagnosticLogEntrySchema.parse(value),
    };
  }

  protected get asanaReauthentication(): AsanaReauthenticationRuntime<
    DeviceSettings,
    AsanaReauthenticationCompleteInput,
    AsanaReauthenticationCancelInput,
    AsanaAuthenticationState,
    AsanaSyncCoordinatorResult
  > {
    const reauthentication = this.attachedAsanaReauthentication;
    assertNonNullable(reauthentication, "Asana再認証workflowが接続されていません。");
    return reauthentication;
  }

  /** 初回設定と再認証のworkflowを接続して保存済み状態を復元します。 */
  public attachSettingsRuntime(
    setup: SetupOrchestrator,
    reauthentication: AsanaReauthenticationRuntime<
      DeviceSettings,
      AsanaReauthenticationCompleteInput,
      AsanaReauthenticationCancelInput,
      AsanaAuthenticationState,
      AsanaSyncCoordinatorResult
    >,
  ): void {
    if (this.attachedSetup != null || this.attachedAsanaReauthentication != null) {
      throw new Error("設定workflowを二重に接続できません。");
    }
    this.attachedSetup = setup;
    this.attachedAsanaReauthentication = reauthentication;
    this.configuredCodexRuntime.setAvailability(contextFromState(setup.getState())?.codex);
    this.operationalContext.configureAsanaFromSettings(this.operationalContext.getSettings());
    this.operationalContext.configureFromState(setup.getState());
  }

  /** Obsidian連携が必要とする運用状態だけを公開します。 */
  public getObsidianCompositionDependencies(): {
    readonly assertOperationalReady: () => void;
    readonly isStopped: () => boolean;
    readonly isExternalToolConfigurationRunning: () => boolean;
    readonly hasActiveAiSessions: () => boolean;
    readonly codexSessionState: () => ReturnType<CodexSessionService["getState"]>;
    readonly setCodexReadOnlyVaultPaths: (paths: readonly string[]) => void;
  } {
    return {
      assertOperationalReady: () => this.assertOperationalReady(),
      isStopped: () => this.shutdownRuntime.isStopped(),
      isExternalToolConfigurationRunning: () => this.externalTools.isConfigurationRunning(),
      hasActiveAiSessions: () => this.aiRuntime.hasActiveSessions(),
      codexSessionState: () => this.codexSession.getState(),
      setCodexReadOnlyVaultPaths: (paths) => this.codexSession.setReadOnlyVaultPaths(paths),
    };
  }

  /** 設定workflowの生成に必要な既存運用操作を公開します。 */
  public getSettingsCompositionDependencies(): SettingsCompositionDependencies {
    return createSettingsCompositionDependencies({
      options: this.options,
      settingsRepository: this.settingsRepository,
      checkpoint: this.checkpoint,
      asana: this.asana,
      oauth: this.oauth,
      vaultMappingRepository: this.vaultMappingRepository,
      obsidian: this.obsidian,
      codexHealth: this.codexHealth,
      externalTools: this.externalTools,
      operationQueue: this.operationQueue,
      operationalContext: this.operationalContext,
      externalAgent: this.externalAgent,
      configuredCodexRuntime: this.configuredCodexRuntime,
      startupRuntime: this.startupRuntime,
      setup: () => this.setup,
      requireTaskReadRuntime: () => this.requireTaskReadRuntime(),
      configureDiscordExternalTool: (input, signal) => this.configureDiscordExternalTool(input, signal),
    });
  }

  /** 現在の設定済みまたは未設定状態を取得します。 */
  public getState(): ApplicationState {
    return readSettingsState({
      readSetupState: () => this.setup.getState(),
      settings: this.settingsRepository,
      parseSetupState: (value) => setupStateSchema.parse(value),
      parseSettings: (value) => deviceSettingsSchema.parse(value),
    });
  }

  /** 本文を受け取らず固定コードと安全な識別子だけを診断ログへ記録します。 */
  public recordDiagnostic(
    code: DiagnosticRecord["code"],
    severity: DiagnosticRecord["severity"],
    metadata?: Pick<
      DiagnosticRecord,
      "asana_gid" | "operation_id" | "proposal_id" | "http_status"
    >,
  ): void {
    this.diagnostics.record({ code, severity, ...metadata });
  }

  /** 起動時の設定再開、復旧、同期を実行します。 */
  public start(signal: AbortSignal): Promise<ApplicationState> {
    return this.startupRuntime.start(signal);
  }

  /** Electron終了時に全サービスを停止します。 */
  public stop(): Promise<void> {
    return this.shutdownRuntime.stop();
  }

  /** 保存済み書き込みstepへ既存のAsana接続と事後同期を渡します。 */
  public getTaskWriteAsanaBridge(): TaskWriteAsanaBridge {
    return {
      transport: this.highPriorityTransport,
      readClient: this.interactiveReadClient,
      isNotFound: (error) => getUniqueAsanaHttpStatus(error) === 404,
      synchronizeAfterProposalWrite: (requiredTaskGids, executionId, signal) =>
        this.synchronizationOperations.afterAiApply(
          requiredTaskGids,
          executionId,
          signal,
        ),
      synchronizeAfterGuiWrite: (requiredTaskGids, executionId, signal) =>
        this.synchronizationOperations.afterGuiEdit(requiredTaskGids, executionId, signal),
    };
  }

  /** 通常適用とGUI編集の保存済みplan実行入口を一度だけ受け取ります。 */
  public setTaskWriteExecution(ports: {
    readonly proposal: StoredProposalExecutionPort;
    readonly proposalWorkflow: ProposalExecutionWorkflow;
    readonly gui: GuiEditExecutionPort;
    readonly guiWorkflow: GuiEditExecutionWorkflow;
  }): void {
    if (this.taskWriteExecution != null) {
      throw new Error("保存済みplan実行入口を二重に設定できません。");
    }
    this.taskWriteExecution = ports;
  }

  /** 変更案の最終IPCに公開するworkflowを取得します。 */
  public getProposalsHandlerWorkflows(): ProposalsHandlerWorkflows {
    return {
      ai: {
        getStatus: () => {
          this.assertOperationalReady();
          return this.configuredCodexRuntime.currentStatus();
        },
        startNewSession: (signal) => this.aiRuntime.startSession(signal),
        startTurn: (input, signal) => this.aiInteraction.startTurn(input, signal),
        getProposal: (input) => this.aiInteraction.withProposalRecord(input, false, (record) =>
          record.workflow.getProposal(identifierSchema.parse(input.proposal_id))),
        select: (input) => this.aiInteraction.withProposalRecord(input, true, (record) =>
          record.workflow.select(aiWorkflowSelectionRequestSchema.parse(input))),
        editOperation: (input) => this.aiInteraction.withProposalRecord(input, true, (record) =>
          record.workflow.editOperation(aiWorkflowOperationEditSchema.parse(input))),
        reject: (input) => this.aiInteraction.reject(input),
        approve: (input, signal) => this.aiInteraction.approve(input, signal),
        closeSession: async (sessionId) => {
          const record = this.aiRuntime.requireSession(sessionId);
          await this.aiRuntime.closeRecord(record, "explicit");
          return { completed: true };
        },
      },
      external: {
        getState: () => this.externalAgentApply.getState(),
        setEnabled: (input, signal) => this.externalAgent.setEnabled(input, signal),
        edit: (input, signal) => this.externalAgentApply.edit({
          ...aiWorkflowOperationEditSchema.parse(input),
          revision: input.revision,
        }, signal),
        select: (input, signal) => this.externalAgentApply.select(input, signal),
        approve: (input, signal) => this.externalAgentApply.approve(input, signal),
        reject: (input, signal) => this.externalAgentApply.reject(input, signal),
      },
      history: {
        getStatus: () => this.getProposalHistoryStatus(),
        confirm: (input) => {
          this.proposalHistory.confirm(input);
          return this.getProposalHistoryStatus();
        },
        synchronize: async (signal) => {
          const result = await this.synchronizeProposalHistory(signal);
          return { status: this.getProposalHistoryStatus(), synced_at: result.synced_at };
        },
      },
      execution: {
        getExecution: (executionId) => this.getProposalExecution(executionId),
        listExecutions: (input) => this.listProposalExecutions(input.cursor == null
          ? { limit: input.limit }
          : { limit: input.limit, cursor: input.cursor }),
        retryExecution: (executionId, signal) => this.retryProposalExecution(executionId, signal),
      },
    };
  }

  /** AI状態の変化を購読します。 */
  public onAiStatus(listener: (status: AiStatus) => void): () => void {
    return this.aiEvents.onStatus(listener);
  }

  /** AI差分を購読します。 */
  public onAiDelta(listener: (delta: AiDelta) => void): () => void {
    return this.aiEvents.onDelta(listener);
  }

  /** 外部変更案の状態を購読します。 */
  public onExternalAgentChanged(listener: Parameters<ExternalAgentApplication<externalAgentProtocol.ExternalAgentGuiState>["onChanged"]>[0]): () => void {
    return this.externalAgentApply.onChanged(listener);
  }

  protected configureOperationalServices(): void {
    this.operationalServices.configure();
  }

  protected rethrowFeatureAbort(error: unknown, signal: AbortSignal): void {
    const responseError = error instanceof DiagnosticFailureDispositionError
      ? error.disposition.response_error
      : error;
    if (
      signal.aborted
      || this.options.lifecycle_signal.aborted
      || responseError instanceof CodexSessionAbortedError
    ) {
      throw error;
    }
  }

  protected recordFeatureFailure(
    error: unknown,
    channel: string,
    message: string,
  ): void {
    const disposition = diagnosticFailureDispositionFromError(error);
    switch (disposition.kind) {
      case "recorded_only":
        return;
      case "unrecorded_only":
        this.options.diagnostic(
          new Error(message, { cause: disposition.unrecorded_error }),
          channel,
          serviceWarningDiagnostic,
        );
        return;
      case "recorded_and_unrecorded":
        this.options.diagnostic(
          new Error(message, { cause: disposition.unrecorded_error }),
          channel,
          serviceWarningDiagnostic,
        );
        return;
    }
  }

  protected recordCodexKnownFailure(error: unknown, message: string): void {
    try {
      this.recordFeatureFailure(error, "codex", message);
    } catch (diagnosticError: unknown) {
      throw combineDiagnosticFailures([error, diagnosticError]);
    }
  }

  protected recordUnexpectedError(error: unknown, channel: string): void {
    const disposition = diagnosticFailureDispositionFromError(error);
    switch (disposition.kind) {
      case "recorded_only":
        return;
      case "unrecorded_only":
      case "recorded_and_unrecorded":
        try {
          this.options.diagnostic(
            disposition.unrecorded_error,
            channel,
            serviceErrorDiagnostic,
          );
        } catch (diagnosticError: unknown) {
          throw combineDiagnosticFailures([error, diagnosticError]);
        }
        return;
    }
  }

  private async configureDiscordExternalTool(
    input: SetupDiscordExternalToolConfigurationInput,
    signal: AbortSignal,
  ): Promise<SetupExternalToolConfigurationResult> {
    const configuration =
      setupDiscordExternalToolConfigurationInputSchema.parse(input);
    return this.externalTools.configureDiscord(configuration, signal);
  }

  protected isOnline(): boolean {
    const online = this.options.online_provider();
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態関数は真偽値を返してください。");
    }
    return online;
  }

  protected assertSetupReady(): void {
    if (this.setup.getState().kind !== "ready") {
      throw new Error("初回設定が完了するまで運用機能を利用できません。");
    }
  }

  protected assertOperationalReady(): void {
    this.assertSetupReady();
    if (!this.startupRuntime.isReadyActivated()) {
      throw new Error("運用機能の起動が完了していません。");
    }
  }

  protected requireRuntime(): AsanaSyncRuntime {
    return this.operationalServices.requireRuntime();
  }

  protected requireContext(): OperationalContext {
    return this.operationalContext.requireContext();
  }

  protected async initializeExternalAgentBridge(): Promise<void> {
    try {
      await this.externalAgentBridge.init(process.execPath);
    } catch (error: unknown) {
      this.recordFeatureFailure(
        error,
        "external_agent",
        "外部連携ブリッジを起動できないため、外部連携を無効にしました。",
      );
    }
  }

  protected prepareApprovalInput(
    input: ApprovalPreparationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationInput> {
    return prepareProposalApprovalInput(input, {
      validateAbortSignal,
      assertWritesAllowed: () => this.taskWriteReadiness.assertWritesAllowed(),
      requireContext: () => this.requireContext(),
      appVersion: this.options.app_version,
      today: () => todayJst(this.options.now_provider),
      readClient: this.interactiveReadClient,
    }, signal);
  }

  protected requireTaskWriteExecution(): NonNullable<MainWorkflowComposition["taskWriteExecution"]> {
    const execution = this.taskWriteExecution;
    assertNonNullable(execution, "保存済みplan実行入口がありません。");
    return execution;
  }

  private getProposalHistoryStatus(): ProposalHistoryStatus {
    const response = proposalsContracts.getHistoryStatus.response.parse({
      kind: "ok",
      value: this.proposalHistory.getStatus(),
    });
    if (response.kind !== "ok") {
      throw new UnreachableError("旧適用履歴の応答形式が不正です。");
    }
    return response.value;
  }

  private async synchronizeProposalHistory(signal: AbortSignal): Promise<ProposalHistorySynchronization> {
    const result = await this.proposalHistory.synchronize(signal);
    return { status: this.getProposalHistoryStatus(), synced_at: result.synced_at };
  }

  protected getSavedProposalOperationStatus(
    proposalId: string,
    operationId: string,
  ): SavedOperationStatusResult | undefined {
    return this.proposalHistory.getSavedOperationStatus(proposalId, operationId);
  }

  /** GUI直接編集の開始前結果または保存済みexecutionを返します。 */
  public async applyGuiEdit(
    input: z.output<typeof applyEditRequestSchema>,
    signal: AbortSignal,
  ): Promise<GuiEditWorkflowResult> {
    return this.guiEditRequest.apply(input, signal);
  }

  /** 指定IDの保存済みGUI編集executionを取得します。 */
  public getGuiEditExecution(executionId: string): GuiEditExecution {
    return this.guiEditRequest.getExecution(executionId);
  }

  /** 指定IDの保存済み変更案executionを取得します。 */
  public getProposalExecution(executionId: string): StoredProposalExecution {
    return this.proposalExecutionRequest.getExecution(executionId);
  }

  /** 保存済み変更案executionを作成順にページ単位で取得します。 */
  public listProposalExecutions(input: ListProposalExecutionsInput): ReturnType<ProposalExecutionWorkflow["listExecutions"]> {
    return this.proposalExecutionRequest.listExecutions(input);
  }

  /** 変更案の実行条件を確認して明示再試行します。 */
  public async retryProposalExecution(executionId: string, signal: AbortSignal): Promise<StoredProposalExecution> {
    return this.proposalExecutionRequest.retryExecution(executionId, signal);
  }

  /** GUI編集の実行条件を確認して明示再試行します。 */
  public async retryGuiEditExecution(executionId: string, signal: AbortSignal): Promise<GuiEditExecution> {
    return this.guiEditRequest.retryExecution(executionId, signal);
  }

  protected createAiWorkflow(
    session: CodexSessionService,
    externalStatusEvidenceCollector: ExternalToolStatusEvidenceCollector,
    baselineStore: AiSessionBaselineStore,
    sessionId: string,
  ): AiWorkflowService {
    return createAiWorkflow({
      sessionId,
      session,
      createId: this.options.create_id,
      snapshotProvider: (signal) => this.proposalBaseline.createAiSnapshot(signal, baselineStore),
      taskctlSnapshotProvider: (signal) => this.aiRuntime.requireTaskctlSnapshot(signal, baselineStore),
      parseTaskctlSnapshot: (value) => this.taskctlSchemas.taskctlSnapshotSchema.parse(value),
      hashBaselineSnapshot: (snapshot) => this.options.snapshot_hasher.hashBaselineSnapshot(snapshot),
      baselineExternalDataProvider: (baseline) => {
        const value = baselineStore.externalData.get(canonicalizeJson(baseline));
        if (value == null) {
          throw new Error("AI変更案の基準Custom external dataが失効しています。");
        }
        return value;
      },
      externalStatusEvidenceCollector,
      proposalPort: this.requireTaskWriteExecution().proposal,
      isOnline: () => this.isOnline(),
      prepareApprovalInput: (input, signal) => this.prepareApprovalInput(input, signal),
      applyProposal: (input, signal) => this.applyProposalApplication(input, signal),
      diagnostic: (error, severity) => this.options.diagnostic(error, "codex", {
        kind: "service",
        severity,
      }),
      reportListenerError: (error) => this.options.diagnostic(
        error,
        "ai_delta_listener",
        serviceErrorDiagnostic,
      ),
    });
  }

  private async applyProposalApplication(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    return this.synchronizationOperations.applyProposal(
      signal,
      () => executeStoredProposalApplication(
        input,
        this.requireTaskWriteExecution().proposal,
        signal,
      ),
      (result) => {
        this.cleanupAggregation.replaceProposalConflictsFromApplication(result);
      },
    );
  }

  protected applyExternalProposal(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    return this.applyProposalApplication(input, signal);
  }
}
