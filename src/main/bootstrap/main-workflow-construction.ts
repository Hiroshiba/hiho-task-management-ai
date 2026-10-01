import { join } from "node:path";
import { z } from "zod";
import { proposalsContracts } from "../../shared/ipc-contracts/proposals";
import { settingsContracts } from "../../shared/ipc-contracts/settings";
import { applyEditRequestSchema } from "../../shared/ipc-contracts/tasks";
import { throwIfAborted, validateAbortSignal } from "../application/common/abort-signal";
import { DiagnosticLogService } from "../application/common/diagnostic-log-service";
import { combineDiagnosticFailures } from "../application/common/errors/diagnostic-failure";
import { AsanaOperationInvalidatedError } from "../application/common/ports/asana-operation-queue";
import type { SecretStoragePort } from "../application/common/ports/secret-storage";
import type {
  CleanupItemsRecord as CleanupItemsCache,
  ProjectMetadataRecord as ProjectMetadataCache,
  TaskReadRanking as RankingCache,
  TaskCacheDiffRecord as TaskCacheDiff,
  TaskCacheRecord as TaskCacheEntry,
} from "../application/common/ports/task-read-repository";
import {
  asanaProposalRecoveryResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryResult,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResultWithCause,
} from "../application/common/proposal-application-schemas";
import { todayJst } from "../application/common/runtime-clock";
import {
  GuiEditRequestWorkflow,
  recoverGuiTaskWrites,
  validateCachedRelationGraph,
  type GuiEditExecutionPort,
  type GuiEditExecutionWorkflow,
} from "../application/gui-edit";
import { ObsidianIntegrationWorkflow } from "../application/obsidian-integration";
import {
  ExternalAgentApplication,
  ProposalExecutionRequestWorkflow,
  ProposalHistoryWorkflow,
  recoverStoredProposals,
  type ProposalExecutionWorkflow,
  type StoredProposalExecutionPort,
} from "../application/proposal-apply";
import {
  AiWorkflowService,
  ExternalAgentGeneration,
  ProposalBaselineWorkflow,
  type ApprovalPreparationInput,
} from "../application/proposal-generate";
import {
  AsanaReauthenticationRuntime,
  CodexHealthWorkflow,
  SetupOrchestrator,
  asanaOperationContextKey,
  clientIdFromState,
  codexAvailabilityFromState,
  contextFromState,
  contextMatchesSettings,
  isContextState,
  restoreSetupAtStartup,
  resumeSetupAtStartup,
  type ApplicationState,
  type OperationalContext,
  type SetupFullSyncInput,
} from "../application/settings";
import { CleanupAggregationService, LocalStateRefreshWorkflow } from "../application/task-read";
import { TaskWriteReadinessWorkflow } from "../application/task-write";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowApprovalResultSchema,
  aiWorkflowTurnRequestSchema,
  aiWorkflowTurnResultSchema,
  canonicalizeJson,
  identifierSchema,
} from "../domain";
import {
  CodexSessionAbortedError,
  CodexSessionService,
  CodexSetupAdapter,
  createCodexAppServerConnectionFactory,
  externalAgentProtocol,
  removeCodexSessionWorkspace,
  type CodexSessionStartResult,
  type CodexWorkspaceInitializationResult,
  type TaskctlRankingSchemas,
  type TaskctlSnapshot,
} from "../infrastructure/ai";
import {
  AsanaOAuthCoordinator,
  AsanaRequestAbortedError,
  AsanaSyncCoordinator,
  AsanaSyncRuntime,
  asanaDisplayOrderInputSchema,
  type AsanaCommunicationRuntime,
  type AsanaDisplayOrderInput,
  type AsanaDisplayOrderService,
  type AsanaSyncCoordinatorResult,
  type AsanaSyncRuntimeInternalResult,
} from "../infrastructure/asana";
import { ObsidianReadError } from "../infrastructure/obsidian";
import {
  SetupCheckpointStore,
  SqliteProposalApplicationHistoryRepository,
  SqliteSettingsRepository,
  SqliteVaultMappingRepository,
  TaskReadPersistenceRepository,
  createSyncStateSchema,
  deviceSettingsSchema,
  type DeviceSettings,
  type DiagnosticLogEntry,
  type DiagnosticRecord,
} from "../infrastructure/persistence";
import { AiEventRuntime } from "./ai-event-runtime";
import { AiInteractionRuntime } from "./ai-interaction-runtime";
import {
  AiSessionRuntime,
  type AiSessionBaselineStore as RuntimeAiSessionBaselineStore,
  type AiSessionRecord as RuntimeAiSessionRecord,
} from "./ai-session-runtime";
import { isAiSessionAbortError } from "./codex-runtime-utilities";
import {
  type CodexSessionResourceInputs,
  type CodexSessionResources,
} from "./codex-session-resources";
import type { AsanaSyncRuntimeFactory } from "./create-task-read-composition-dependencies";
import { ConfiguredCodexRuntime } from "./configured-codex-runtime";
import {
  createExternalAgentRuntime,
  type ExternalAgentBridgeFactory,
  type ExternalAgentBridgePort,
} from "./create-external-agent-runtime";
import { JournalRecoveryRuntime } from "./journal-recovery-runtime";
import { applicationOptionsSchemaExport, type ApplicationOptions } from "./main-runtime-options";
import { MainShutdownRuntime } from "./main-shutdown-runtime";
import { MainStartupRuntime } from "./main-startup-runtime";
import { OperationalContextRuntime } from "./operational-context-runtime";
import { OperationalServicesRuntime } from "./operational-services-runtime";
import { canResumeReadyStateAfterRevalidationFailure } from "./post-write-synchronization";
import {
  codexUnavailableReasonSchema,
  setupCodexAvailabilitySchema,
  setupStateSchema,
  type SetupCodexAvailability,
  type SetupState,
} from "./setup-contracts";
import { SynchronizationOperations } from "./synchronization-operations";
import { createTaskReadPersistenceContracts } from "./task-read-storage-contracts";

type AiStatus = z.output<typeof proposalsContracts.aiStatus.event.shape.value>;
type AiDelta = z.output<typeof proposalsContracts.aiDelta.event.shape.value>;
type AiTurnInput = z.output<typeof proposalsContracts.startTurn.request>;
type AiTurnResult = z.output<typeof aiWorkflowTurnResultSchema>;
type AiApprovalInput = z.output<typeof proposalsContracts.approve.request>;
type AiApprovalResult = z.output<typeof aiWorkflowApprovalResultSchema>;
type AsanaReauthenticationCompleteInput = z.output<typeof settingsContracts.completeAsanaReauthentication.request>;
type AsanaReauthenticationCancelInput = z.output<typeof settingsContracts.cancelAsanaReauthentication.request>;
type AsanaAuthenticationState = Extract<
  z.output<typeof settingsContracts.getAsanaAuthenticationState.response>,
  { kind: "ok" }
>["value"];
type BaselineExternalData = AsanaProposalApplicationInput["baseline_external_data"];
type AiSessionBaselineStore = RuntimeAiSessionBaselineStore<BaselineExternalData, TaskctlSnapshot>;

type AiSessionRecord = RuntimeAiSessionRecord<
  CodexWorkspaceInitializationResult,
  CodexSessionService,
  AiWorkflowService,
  BaselineExternalData,
  TaskctlSnapshot
>;

const codexAuthenticationStateSchema = z.union([
  z.object({ kind: z.literal("authenticated") }).strict(),
  z.object({ kind: z.literal("required") }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason_code: codexUnavailableReasonSchema,
  }).strict(),
]);

type CodexAuthenticationState = z.infer<typeof codexAuthenticationStateSchema>;

const serviceErrorDiagnostic = {
  kind: "service",
  severity: "error",
} satisfies { readonly kind: "service"; readonly severity: "warning" | "error" };

type SyncState = z.infer<ReturnType<typeof createSyncStateSchema>>;



type SavedOperationStatusResult = Extract<
  Extract<externalAgentProtocol.ExternalAgentProposalStatusResult, { kind: "journals" }>["results"][number]["result"],
  { kind: "execution" | "unknown" | "legacy_history" }
>;

type ApplicationFileStores = {
  readonly createExternalAgentBridge: ExternalAgentBridgeFactory;
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



/** Mainのworkflowとportを組み立てます。 */
export abstract class MainWorkflowConstruction {
  protected readonly options: ApplicationOptions;
  protected readonly taskReadPersistenceContracts: ReturnType<typeof createTaskReadPersistenceContracts>;
  protected readonly taskctlSchemas: TaskctlRankingSchemas;
  protected readonly taskReadRepository: TaskReadPersistenceRepository<
    TaskCacheEntry,
    ProjectMetadataCache,
    RankingCache,
    SyncState,
    CleanupItemsCache,
    TaskCacheDiff
  >;
  protected readonly vaultMappingRepository: SqliteVaultMappingRepository;
  protected readonly proposalApplicationHistoryRepository: SqliteProposalApplicationHistoryRepository;
  protected readonly settingsRepository: SqliteSettingsRepository<DeviceSettings>;
  protected attachedDiagnostics: DiagnosticLogService<DiagnosticRecord, DiagnosticLogEntry> | undefined;
  protected readonly secretStorage: SecretStoragePort;
  protected readonly checkpoint: SetupCheckpointStore;
  protected readonly asana: AsanaCommunicationRuntime;
  protected readonly operationQueue: AsanaCommunicationRuntime["operationQueue"];
  protected readonly highPriorityTransport: AsanaCommunicationRuntime["highPriorityTransport"];
  protected readonly readClient: AsanaCommunicationRuntime["readClient"];
  protected readonly interactiveReadClient: AsanaCommunicationRuntime["interactiveReadClient"];
  protected readonly writeClient: AsanaCommunicationRuntime["writeClient"];
  protected readonly oauth: AsanaOAuthCoordinator;
  protected readonly syncCoordinator: AsanaSyncCoordinator;
  protected readonly createSyncRuntimeFactory: AsanaSyncRuntimeFactory;
  protected readonly codexWorkspace: CodexWorkspaceInitializationResult;
  protected readonly aiSessionWorkspaceParentPath: string;
  protected readonly codexSession: CodexSessionService;
  protected readonly codexSessionResources: CodexSessionResources;
  protected readonly codexAdapter: CodexSetupAdapter;
  protected readonly codexHealth: CodexHealthWorkflow<SetupCodexAvailability, CodexAuthenticationState>;
  protected attachedSetup: SetupOrchestrator | undefined;
  protected readonly obsidian: ObsidianIntegrationWorkflow;
  protected readonly cleanupAggregation: CleanupAggregationService;
  protected readonly localStateRefresh: LocalStateRefreshWorkflow<OperationalContext, AsanaDisplayOrderInput>;
  protected readonly proposalBaseline: ProposalBaselineWorkflow<OperationalContext, TaskctlSnapshot>;
  protected readonly taskWriteReadiness: TaskWriteReadinessWorkflow;
  protected readonly guiEditRequest: GuiEditRequestWorkflow<OperationalContext>;
  protected readonly proposalHistory: ProposalHistoryWorkflow<OperationalContext>;
  protected readonly proposalExecutionRequest: ProposalExecutionRequestWorkflow<OperationalContext>;
  protected readonly externalAgentInstanceId: string;
  protected readonly externalAgent: ExternalAgentGeneration<externalAgentProtocol.ExternalAgentGuiState, TaskctlSnapshot>;
  protected readonly externalAgentApply: ExternalAgentApplication<externalAgentProtocol.ExternalAgentGuiState>;
  protected readonly externalAgentBridge: ExternalAgentBridgePort;
  protected attachedAsanaReauthentication: AsanaReauthenticationRuntime<
    DeviceSettings,
    AsanaReauthenticationCompleteInput,
    AsanaReauthenticationCancelInput,
    AsanaAuthenticationState,
    AsanaSyncCoordinatorResult
  > | undefined;
  protected readonly operationalContext: OperationalContextRuntime<
    SetupState,
    OperationalContext,
    DeviceSettings,
    OperationalContext["codex"]
  >;
  protected readonly operationalServices: OperationalServicesRuntime<
    OperationalContext,
    DeviceSettings,
    AsanaSyncRuntime,
    AsanaDisplayOrderService
  >;
  protected readonly aiRuntime: AiSessionRuntime<
    CodexWorkspaceInitializationResult,
    CodexSessionService,
    AiWorkflowService,
    BaselineExternalData,
    TaskctlSnapshot,
    CodexSessionStartResult
  >;
  protected readonly aiInteraction: AiInteractionRuntime<
    AiSessionRecord,
    AiTurnInput,
    z.infer<typeof aiWorkflowTurnRequestSchema>,
    AiTurnResult,
    AiApprovalInput,
    z.infer<typeof aiWorkflowApprovalRequestSchema>,
    AiApprovalResult,
    OperationalContext
  >;
  protected readonly aiEvents: AiEventRuntime<AiStatus, AiDelta>;
  protected attachedSynchronizationOperations: SynchronizationRuntime | undefined;
  protected taskWriteExecution: {
    readonly proposal: StoredProposalExecutionPort;
    readonly proposalWorkflow: ProposalExecutionWorkflow;
    readonly gui: GuiEditExecutionPort;
    readonly guiWorkflow: GuiEditExecutionWorkflow;
  } | undefined;
  protected readonly journalRecovery: JournalRecoveryRuntime<
    { readonly proposal_id: string; readonly operation_id: string; readonly final_result: null },
    AsanaProposalRecoveryResult
  >;
  protected readonly configuredCodexRuntime: ConfiguredCodexRuntime<AiStatus>;
  protected attachedTaskReadRuntime: TaskReadRuntimePort | undefined;
  protected readonly startupRuntime: MainStartupRuntime<ApplicationState, AsanaSyncRuntimeInternalResult>;
  protected readonly shutdownRuntime: MainShutdownRuntime;

  public constructor(
    options: ApplicationOptions,
    files: ApplicationFileStores,
    historyRepository: SqliteProposalApplicationHistoryRepository,
    bindings: {
      readonly vaultMappingRepository: SqliteVaultMappingRepository;
      readonly obsidian: ObsidianIntegrationWorkflow;
      readonly secretStorage: SecretStoragePort;
      readonly checkpoint: SetupCheckpointStore;
      readonly asana: AsanaCommunicationRuntime;
      readonly createSyncCoordinator: () => AsanaSyncCoordinator;
      readonly createSyncRuntime: (
        coordinator: AsanaSyncCoordinator,
        ...args: Parameters<AsanaSyncRuntimeFactory>
      ) => AsanaSyncRuntime;
      readonly taskReadPersistenceContracts: ReturnType<typeof createTaskReadPersistenceContracts>;
      readonly taskReadRepository: TaskReadPersistenceRepository<
        TaskCacheEntry,
        ProjectMetadataCache,
        RankingCache,
        SyncState,
        CleanupItemsCache,
        TaskCacheDiff
      >;
      readonly taskctlSchemas: TaskctlRankingSchemas;
      readonly initializeCodexWorkspace: (userDataPath: string) => CodexWorkspaceInitializationResult;
      readonly initializeCodexSessionWorkspaceParent: (parentPath: string) => string;
      readonly createCodexEnvironment: (codexHomePath: string) => Record<string, string>;
      readonly createCodexConnectionFactory: (
        environment: Record<string, string>,
        onError: (error: unknown) => void,
      ) => ReturnType<typeof createCodexAppServerConnectionFactory>;
      readonly createCodexSessionResources: (input: CodexSessionResourceInputs) => CodexSessionResources;
      readonly createCodexSetupAdapter: (session: CodexSessionService, environment: Record<string, string>) => CodexSetupAdapter;
      readonly removeSessionWorkspace: typeof removeCodexSessionWorkspace;
      readonly settingsRepository: SqliteSettingsRepository<DeviceSettings>;
    },
  ) {
    applicationOptionsSchemaExport.parse(options);
    this.options = options;
    this.aiEvents = new AiEventRuntime({
      currentStatus: () => this.configuredCodexRuntime.currentStatus(),
      reportListenerError: (error, channel) =>
        this.options.diagnostic(error, channel, serviceErrorDiagnostic),
    });
    this.externalAgentInstanceId = identifierSchema.parse(options.create_id());
    this.asana = bindings.asana;
    this.operationQueue = bindings.asana.operationQueue;
    this.taskReadPersistenceContracts = bindings.taskReadPersistenceContracts;
    this.taskctlSchemas = bindings.taskctlSchemas;
    this.taskReadRepository = bindings.taskReadRepository;
    this.vaultMappingRepository = bindings.vaultMappingRepository;
    this.proposalApplicationHistoryRepository = historyRepository;
    this.settingsRepository = bindings.settingsRepository;
    this.secretStorage = bindings.secretStorage;
    this.checkpoint = bindings.checkpoint;
    this.highPriorityTransport = bindings.asana.highPriorityTransport;
    this.readClient = bindings.asana.readClient;
    this.interactiveReadClient = bindings.asana.interactiveReadClient;
    this.writeClient = bindings.asana.writeClient;
    this.oauth = bindings.asana.oauth;
    this.syncCoordinator = bindings.createSyncCoordinator();
    this.createSyncRuntimeFactory = (...args) => bindings.createSyncRuntime(this.syncCoordinator, ...args);
    this.proposalBaseline = new ProposalBaselineWorkflow({
      repository: this.taskReadRepository,
      operationQueue: this.operationQueue,
      getContext: () => this.operationalContext.getContext(),
      requireContext: () => this.requireContext(),
      appVersion: this.options.app_version,
      now: this.options.now_provider,
      parseTaskctlSnapshot: (value) => this.taskctlSchemas.taskctlSnapshotSchema.parse(value),
      validateAbortSignal,
      assertQueuedMutationReady: () => this.taskWriteReadiness.assertQueuedMutationReady(),
      assertOperationalReady: () => this.assertOperationalReady(),
      assertReauthenticationIdle: () => this.asanaReauthentication.assertIdle(),
      assertContextUnchanged: (expected) => this.operationalContext.assertContextUnchanged(expected),
      asanaContextKey: asanaOperationContextKey,
      isOnline: () => this.isOnline(),
    });
    this.codexWorkspace = bindings.initializeCodexWorkspace(options.user_data_path);
    this.aiSessionWorkspaceParentPath = bindings.initializeCodexSessionWorkspaceParent(
      join(this.codexWorkspace.userDataPath, "ai-sessions"),
    );
    const codexEnvironment = bindings.createCodexEnvironment(this.codexWorkspace.codexHomePath);
    const onCodexError = (error: unknown): void => {
      this.options.diagnostic(error, "codex", serviceErrorDiagnostic);
    };
    const connectionFactory = bindings.createCodexConnectionFactory(codexEnvironment, onCodexError);
    this.obsidian = bindings.obsidian;
    this.codexSessionResources = bindings.createCodexSessionResources({
      parentPath: this.aiSessionWorkspaceParentPath,
      codexHomePath: this.codexWorkspace.codexHomePath,
      executable: options.codex_executable,
      obsidianReader: this.obsidian.createCodexPort(),
      readOnlyVaultPaths: () => this.obsidian.readOnlyVaultPaths(),
      connectionFactory,
      onError: onCodexError,
      snapshotProvider: () => this.proposalBaseline.createTaskctlSnapshot(),
      syncBeforeTurn: (signal) => this.synchronizationOperations.requireSynchronizedBeforeAi(signal),
      taskctlSchemas: this.taskctlSchemas,
    });
    this.codexSession = this.codexSessionResources.createSession(this.codexWorkspace);
    this.codexAdapter = bindings.createCodexSetupAdapter(this.codexSession, codexEnvironment);
    this.codexHealth = new CodexHealthWorkflow({
      isDisabled: () => this.codexSession.getState() === "disabled",
      detectCli: (signal, capture) => this.codexAdapter.detectCli(signal, capture),
      getAuthenticationState: (signal, capture) => this.codexAdapter.getAuthenticationState(signal, capture),
      completeAuthentication: (signal, capture) => this.codexAdapter.completeAuthentication(signal, capture),
      checkCapabilities: (signal) => this.codexAdapter.checkCapabilities(signal),
      parseAvailability: (value) => setupCodexAvailabilitySchema.parse(value),
      parseAuthentication: (value) => codexAuthenticationStateSchema.parse(value),
      rethrowAbort: (error, signal) => this.rethrowFeatureAbort(error, signal),
      recordFailure: (error, message) => this.recordFeatureFailure(error, "codex", message),
      recordKnownFailure: (error, message) => this.recordCodexKnownFailure(error, message),
    });
    this.cleanupAggregation = new CleanupAggregationService(
      this.taskReadRepository,
      {
        noteExists: (vaultId, relativePath, signal) => this.obsidian.noteExists(vaultId, relativePath, signal),
        readErrorCode: (error) => error instanceof ObsidianReadError ? error.code : undefined,
      },
    );
    this.localStateRefresh = new LocalStateRefreshWorkflow({
      repository: this.taskReadRepository,
      replaceBrokenVaultLinksFromTasks: (tasks, signal) =>
        this.cleanupAggregation.replaceBrokenVaultLinksFromTasks(tasks, signal),
      getDisplayOrder: () => this.operationalServices.getDisplayOrder(),
      requireContext: () => this.requireContext(),
      readProjectTasks: (projectGid, signal) => this.readClient.listProjectTasks(projectGid, signal),
      parseDisplayOrderInput: (value) => asanaDisplayOrderInputSchema.parse(value),
      assertQueuedMutationReady: () => this.taskWriteReadiness.assertQueuedMutationReady(),
      assertContextUnchanged: (expected) => this.operationalContext.assertContextUnchanged(expected),
      ignoreDisplayOrderError: (error) =>
        error instanceof AsanaRequestAbortedError || error instanceof AsanaOperationInvalidatedError,
      recordUnexpectedError: (error) => this.recordUnexpectedError(error, "display_order"),
    });
    this.aiRuntime = new AiSessionRuntime({
      lifecycleSignal: this.options.lifecycle_signal,
      isStopped: () => this.shutdownRuntime.isStopped(),
      assertOperationalReady: () => this.assertOperationalReady(),
      validateAbortSignal,
      throwIfAborted,
      createSessionId: () => identifierSchema.parse(this.options.create_id()),
      parseSessionId: (sessionId) => identifierSchema.parse(sessionId),
      workspaceUserDataPath: (sessionId) => join(
        this.aiSessionWorkspaceParentPath,
        `ai-session-${sessionId}`,
      ),
      createWorkspace: (sessionId) => this.codexSessionResources.createWorkspace(sessionId),
      createSession: (workspace) => this.codexSessionResources.createSession(workspace),
      startSession: (session, signal) => session.start(signal),
      createWorkflow: (session, baselineStore, sessionId) =>
        this.createAiWorkflow(session, baselineStore, sessionId),
      subscribeDelta: (workflow, sessionId) => workflow.onDelta((delta) => {
        this.aiEvents.publishDelta(proposalsContracts.aiDelta.event.shape.value.parse({
          session_id: sessionId,
          thread_id: delta.threadId,
          turn_id: delta.turnId,
          item_id: delta.itemId,
          delta: delta.delta,
        }));
      }),
      onAuthenticationRequired: (result) => this.configuredCodexRuntime.requireAuthentication(result),
      publishStatus: () => this.aiEvents.publishStatus(),
      createAbortedError: () => new CodexSessionAbortedError(),
      removeWorkspace: (userDataPath) => bindings.removeSessionWorkspace(
        userDataPath,
        this.aiSessionWorkspaceParentPath,
      ),
      combineFailures: (errors) => combineDiagnosticFailures(errors),
      isAbortError: isAiSessionAbortError,
      hasOperationOwner: (signal) => this.operationQueue.hasOwner(signal),
      linkOwnedSignal: (signal, owner) =>
        this.operationQueue.linkOwnedSignal(signal, owner),
    });
    this.aiInteraction = new AiInteractionRuntime<
      AiSessionRecord,
      AiTurnInput,
      z.infer<typeof aiWorkflowTurnRequestSchema>,
      AiTurnResult,
      AiApprovalInput,
      z.infer<typeof aiWorkflowApprovalRequestSchema>,
      AiApprovalResult,
      OperationalContext
    >({
      assertOperationalReady: () => this.assertOperationalReady(),
      assertMutationRequestAccepted: () => this.taskWriteReadiness.assertMutationRequestAccepted(),
      requireSession: (sessionId) => this.aiRuntime.requireSession(sessionId),
      parseTurnRequest: (input) => aiWorkflowTurnRequestSchema.parse({
        message: input.message,
        target_task_gid: input.target_task_gid,
        base_proposal_id: input.base_proposal_id,
      }),
      runTurn: async (record, request, signal) => aiWorkflowTurnResultSchema.parse(
        await this.aiRuntime.runOperation(
          record,
          signal,
          (operationSignal) => record.workflow.startTurn(request, operationSignal),
        ),
      ),
      classifyTurn: (request, result) => {
        if (result.kind === "proposal") {
          return {
            kind: "proposal",
            proposalId: result.proposal.proposal_id,
            baseProposalId: request.base_proposal_id,
          };
        }
        if (request.base_proposal_id != null && result.pending_proposal_action === "discard") {
          return { kind: "discard", baseProposalId: request.base_proposal_id };
        }
        return { kind: "none" };
      },
      rejectProposal: (record, proposalId) => record.workflow.rejectProposal(proposalId),
      rememberProposal: (record, proposalId) => this.aiRuntime.rememberProposal(record, proposalId),
      forgetProposal: (record, proposalId) => this.aiRuntime.forgetProposal(record, proposalId),
      releaseCurrentTurnBaselines: (record) =>
        this.aiRuntime.releaseCurrentTurnBaselines(record),
      parseApprovalRequest: (input) => aiWorkflowApprovalRequestSchema.parse({
        proposal_id: input.proposal_id,
        selection: input.selection,
      }),
      requireContext: () => this.requireContext(),
      enqueueApproval: async (record, request, approvalContext, signal) =>
        aiWorkflowApprovalResultSchema.parse(await this.operationQueue.enqueue({
          priority: "user",
          kind: "ai_apply",
          signal,
          beforeStart: () => {
            this.taskWriteReadiness.assertQueuedMutationReady();
            this.operationalContext.assertContextUnchanged(approvalContext);
          },
          run: (context) => this.aiRuntime.runOperation(
            record,
            context.signal,
            (operationSignal) => record.workflow.approve(request, operationSignal),
          ),
        })),
    });
    const externalAgentRuntime = createExternalAgentRuntime({
      userDataPath: this.codexWorkspace.userDataPath,
      createBridge: files.createExternalAgentBridge,
      onError: (error) => this.options.diagnostic(error, "external_agent", serviceErrorDiagnostic),
      taskctlSchemas: this.taskctlSchemas,
      application: {
        lifecycle_signal: this.options.lifecycle_signal,
        online_provider: () => this.isOnline(),
        operation_queue: this.operationQueue,
        assert_apply_ready: () => this.taskWriteReadiness.assertMutationRequestAccepted(),
        prepare_approval_input: (input, signal) => this.prepareApprovalInput(input, signal),
        apply_proposal: (input, signal) => this.applyExternalProposal(input, signal),
        get_saved_operation_result: (proposalId, operationId) =>
          this.getSavedProposalOperationStatus(proposalId, operationId),
        open_review: async () => {
          await this.options.open_external_agent_review();
        },
        create_id: this.options.create_id,
      },
      generation: {
        app_version: this.options.app_version,
        instance_id: this.externalAgentInstanceId,
        lifecycle_signal: this.options.lifecycle_signal,
        now_provider: this.options.now_provider,
        online_provider: () => this.isOnline(),
        get_taskctl_snapshot: () => this.proposalBaseline.createTaskctlSnapshot(),
        get_runtime_state: () => this.operationalServices.getRuntime()?.getState(),
        create_baseline: (signal) => this.proposalBaseline.createExternalBaseline(signal),
        hash_baseline_snapshot: (snapshot) => this.options.snapshot_hasher.hashBaselineSnapshot(snapshot),
        assert_apply_ready: () => this.taskWriteReadiness.assertMutationRequestAccepted(),
        create_id: this.options.create_id,
      },
    });
    this.externalAgentBridge = externalAgentRuntime.bridge;
    this.externalAgentApply = externalAgentRuntime.application;
    this.externalAgent = externalAgentRuntime.generation;
    this.operationalContext = new OperationalContextRuntime<
      SetupState,
      OperationalContext,
      DeviceSettings,
      OperationalContext["codex"]
    >({
      initialSettings: this.settingsRepository.get(),
      parseState: (state) => setupStateSchema.parse(state),
      contextFromState,
      operationKey: asanaOperationContextKey,
      canonicalizeContext: canonicalizeJson,
      createContextChangedError: () => new AsanaOperationInvalidatedError("context_changed"),
      availabilityFromState: codexAvailabilityFromState,
      clientIdFromState,
      readSettings: () => this.settingsRepository.get(),
      parseSettings: (settings) => deviceSettingsSchema.parse(settings),
      contextMatchesSettings,
      configureExternalAgent: (context) => this.externalAgent.configureContext(context),
      invalidatePendingMutations: () => this.operationQueue.invalidatePendingMutations(
        "context_changed",
      ),
      setCodexAvailability: (availability) => this.configuredCodexRuntime.setAvailability(availability),
      setTokenProvider: (clientId) => this.asana.setTokenProvider(clientId),
      updateCodexVaultPaths: () => this.obsidian.refreshCodexVaultPaths(),
      assertOperationalReady: () => this.assertOperationalReady(),
    });
    this.journalRecovery = new JournalRecoveryRuntime({
      validateAbortSignal,
      throwIfAborted,
      hasOperationOwner: (signal) => this.operationQueue.hasOwner(signal),
      enqueueRecovery: (signal, run) => this.operationQueue.enqueue({
        priority: "user",
        kind: "journal_recovery",
        signal,
        run: (context) => run(context.signal),
      }),
      getIncompleteJournals: () => [],
      hasAdditionalIncomplete: () => this.requireTaskWriteExecution().proposal.repository.getIncomplete().length > 0
        || this.requireTaskWriteExecution().gui.repository.getIncomplete().length > 0,
      hasIncompleteHistory: () => this.proposalApplicationHistoryRepository.getIncomplete().length > 0,
      incompleteProposalExecutionIds: () => this.requireTaskWriteExecution().proposal.repository.getIncomplete()
        .map((execution) => execution.execution_id),
      incompleteGuiExecutionIds: () => this.requireTaskWriteExecution().gui.repository.getIncomplete()
        .map((execution) => execution.execution_id),
      recover: async (signal) => {
        const execution = this.requireTaskWriteExecution();
        await recoverGuiTaskWrites(execution.gui, signal);
        return asanaProposalRecoveryResultSchema.parse(await recoverStoredProposals(execution.proposal, signal));
      },
      afterRecovery: (result) => {
        this.cleanupAggregation.replaceProposalConflictsFromRecovery(result, true);
      },
    });
    this.taskWriteReadiness = new TaskWriteReadinessWorkflow({
      assertOperationalReady: () => this.assertOperationalReady(),
      assertReauthenticationIdle: () => this.asanaReauthentication.assertIdle(),
      isOnline: () => this.isOnline(),
      getSynchronizationState: () => this.requireRuntime().getState(),
      hasPendingJournal: () => this.journalRecovery.hasPending(),
      hasIncompleteHistory: () => this.proposalApplicationHistoryRepository.getIncomplete().length > 0,
      hasOAuthAppMismatch: () => this.taskReadRepository.getCleanupItems()?.some(
        (item) => item.kind === "oauth_app_mismatch" && item.task_gid == null,
      ) ?? false,
    });
    this.guiEditRequest = new GuiEditRequestWorkflow<OperationalContext>({
      assertOperationalReady: () => this.assertOperationalReady(),
      assertReauthenticationIdle: () => this.asanaReauthentication.assertIdle(),
      assertMutationRequestAccepted: () => this.taskWriteReadiness.assertMutationRequestAccepted(),
      assertQueuedMutationReady: () => this.taskWriteReadiness.assertQueuedMutationReady(),
      assertContextUnchanged: (context) => this.operationalContext.assertContextUnchanged(context),
      isOnline: () => this.isOnline(),
      requireContext: () => this.requireContext(),
      getTaskCacheEntry: (taskGid) => this.taskReadRepository.getTaskCacheEntry(taskGid),
      today: () => todayJst(this.options.now_provider),
      createId: () => this.options.create_id(),
      hashGuiEditBaseline: (task) => this.options.snapshot_hasher.hashGuiEditBaseline(task),
      queue: this.operationQueue,
      getExecutionPort: () => this.requireTaskWriteExecution().gui,
      getExecution: (executionId) => this.requireTaskWriteExecution().guiWorkflow.getExecution(executionId),
      retryExecution: (executionId, signal) => this.requireTaskWriteExecution().guiWorkflow.retryExecution(executionId, signal),
      readTask: (taskGid, signal) => this.interactiveReadClient.getTask(taskGid, signal),
      validateRelation: (relation, signal) =>
        validateCachedRelationGraph(relation, this.taskReadRepository.getTaskCache(), signal),
      parseRequest: (value) => applyEditRequestSchema.parse(value),
    });
    this.proposalHistory = new ProposalHistoryWorkflow<OperationalContext>({
      repository: this.proposalApplicationHistoryRepository,
      getStoredProposalRepository: () => this.requireTaskWriteExecution().proposal.repository,
      validateAbortSignal,
      assertOperationalReady: () => this.assertOperationalReady(),
      assertReauthenticationIdle: () => this.asanaReauthentication.assertIdle(),
      isOnline: () => this.isOnline(),
      requireContext: () => this.requireContext(),
      assertContextUnchanged: (context) => this.operationalContext.assertContextUnchanged(context),
      hasPendingJournal: () => this.journalRecovery.hasPending(),
      queue: this.operationQueue,
      coordinateReadOnly: (context, signal) => this.syncCoordinator.coordinateReadOnly({
        mode: "full",
        project_gid: context.project_gid,
        section_gids: context.section_gids,
        device_id: context.device_id,
        app_version: this.options.app_version,
        required_task_gids: [],
      }, signal),
      refreshLocalTaskState: (signal) => this.localStateRefresh.refreshLocalTaskState(signal),
      acceptReadOnlySynchronization: (syncedAt, signal) =>
        this.requireRuntime().acceptReadOnlySynchronization(syncedAt, signal),
    });
    this.proposalExecutionRequest = new ProposalExecutionRequestWorkflow<OperationalContext>({
      requireWorkflow: () => this.requireTaskWriteExecution().proposalWorkflow,
      assertMutationRequestAccepted: () => this.taskWriteReadiness.assertMutationRequestAccepted(),
      assertQueuedMutationReady: () => this.taskWriteReadiness.assertQueuedMutationReady(),
      requireContext: () => this.requireContext(),
      assertContextUnchanged: (context) => this.operationalContext.assertContextUnchanged(context),
      queue: this.operationQueue,
    });
    this.configuredCodexRuntime = new ConfiguredCodexRuntime<AiStatus>({
      validateAbortSignal,
      throwIfAborted,
      isSessionUnstarted: () => this.codexSession.getState() === "created",
      detectCli: (signal) => this.codexHealth.detectCli(signal),
      getAuthenticationState: (signal) => this.codexHealth.getAuthenticationState(signal),
      getStartResult: () => this.codexAdapter.getStartResult(),
      checkCapabilities: (signal) => this.codexHealth.checkCapabilities(signal),
      rethrowFeatureAbort: (error, signal) => this.rethrowFeatureAbort(error, signal),
      recordStartFailure: (error) => this.recordFeatureFailure(
        error,
        "codex",
        "オンライン復帰後にCodexを開始できないためAI機能を無効にしました。",
      ),
      publishStatus: () => this.aiEvents.publishStatus(),
      isStopped: () => this.shutdownRuntime.isStopped(),
      getSessionState: () => this.codexSession.getState(),
      getModel: () => this.codexAdapter.getReadyModel(),
      parseStatus: (value) => proposalsContracts.aiStatus.event.shape.value.parse(value),
      startNewSession: (signal) => this.codexSession.startNewSession(signal),
      resetWithdrawConfirmations: () => this.aiRuntime.resetPendingWithdrawConfirmations(),
    });
    this.operationalServices = new OperationalServicesRuntime<
      OperationalContext,
      DeviceSettings,
      AsanaSyncRuntime,
      AsanaDisplayOrderService
    >({
      assertSetupReady: () => this.assertSetupReady(),
      requireContext: () => this.requireContext(),
      getSettings: () => this.operationalContext.getSettings(),
      contextMatchesSettings,
      onlineProvider: () => this.options.online_provider(),
      createRuntime: (context, online) => this.requireTaskReadRuntime().createSyncRuntime(context, online),
      subscribeRuntime: (runtime) => this.requireTaskReadRuntime().subscribeRuntime(runtime),
      createDisplayOrder: () => this.asana.createDisplayOrder(
        (error) => this.recordUnexpectedError(error, "display_order"),
      ),
    });
    this.shutdownRuntime = new MainShutdownRuntime({
      stopOAuthAuthorization: () => this.oauth.stopOutOfBandAuthorization(),
      externalAgent: this.externalAgent,
      externalAgentBridge: this.externalAgentBridge,
      stopSyncSubscriptions: () => this.requireTaskReadRuntime().stop(),
      clearAiListeners: () => {
        this.aiEvents.dispose();
      },
      closeAiSessions: (errors) => this.aiRuntime.closeAll(errors),
      displayOrder: () => this.operationalServices.getDisplayOrder(),
      runtime: () => this.operationalServices.getRuntime(),
      operationQueue: this.operationQueue,
      stopCodexSession: () => this.codexSession.stop({ kind: "record" }),
      recordDiagnostic: () => this.recordDiagnostic("app.stop", "info"),
      combineFailures: (errors) => combineDiagnosticFailures(errors),
    });
    this.startupRuntime = new MainStartupRuntime<ApplicationState, AsanaSyncRuntimeInternalResult>({
      validateAbortSignal,
      throwIfAborted,
      isStopped: () => this.shutdownRuntime.isStopped(),
      initializeExternalAgentBridge: () => this.initializeExternalAgentBridge(),
      ensureTasksVaultMapping: (signal) => this.obsidian.ensureTasksVaultMapping(signal),
      recordDiagnostic: () => this.recordDiagnostic("app.start", "info"),
      restoreSetup: (signal) => restoreSetupAtStartup({
        getSetupState: () => this.setup.getState(),
        isOnline: () => this.isOnline(),
        restoreReadyDeviceSettings: () => this.operationalContext.configureAsanaFromSettings(
          this.setup.restoreReadyDeviceSettings(),
        ),
        startSetup: (signal) => this.setup.start(signal),
        restoreCodexSession: (signal) => this.configuredCodexRuntime.restorePersistedSession(signal, {
          recheck: (recheckSignal) => this.setup.recheckPersistedCodex(recheckSignal),
          parseState: (value) => setupStateSchema.parse(value),
          availabilityFromState: codexAvailabilityFromState,
          updateAvailability: (availability) => this.setup.updateCodexAvailability(availability),
        }),
        isContextState,
        resumeSetup: (state, signal) => resumeSetupAtStartup(state, signal, {
          parseState: (value) => setupStateSchema.parse(value),
          resume: (resumeSignal) => this.setup.resume(resumeSignal),
          rethrowAbort: (error, resumeSignal) => this.rethrowFeatureAbort(error, resumeSignal),
          canResumeReadyStateAfterFailure: canResumeReadyStateAfterRevalidationFailure,
          recordFailure: (error) => this.recordFeatureFailure(
            error,
            "sync",
            "保存済み初回設定をAsanaと再照合できないためキャッシュ表示で起動します。",
          ),
        }),
        configureAsanaFromStoredSettings: () => this.operationalContext.configureAsanaFromSettings(
          this.settingsRepository.get(),
        ),
        configureContextFromState: (state) => this.operationalContext.configureFromState(state),
      }, signal),
      getApplicationState: () => this.getState(),
      configureOperationalServices: () => this.configureOperationalServices(),
      requireRuntime: () => this.requireRuntime(),
      recoverJournal: (signal) => this.journalRecovery.recover(signal),
      rethrowFeatureAbort: (error, signal) => this.rethrowFeatureAbort(error, signal),
      recordJournalRecoveryFailure: (error) => this.recordFeatureFailure(
        error,
        "proposal_application",
        "未完了のAI適用ジャーナルを起動同期前に復旧できませんでした。",
      ),
      ensureCodexLaunch: (signal) => this.configuredCodexRuntime.ensureLaunchAttempt(signal),
      isSynchronizedResult: (
        result,
      ): result is Extract<AsanaSyncRuntimeInternalResult, { kind: "synchronized" }> =>
        result.kind === "synchronized",
      afterSynchronizedState: (result, signal) =>
        this.synchronizationOperations.afterSynchronizedState(result, signal),
    });
  }

  protected abstract get setup(): SetupOrchestrator;
  protected abstract get asanaReauthentication(): AsanaReauthenticationRuntime<DeviceSettings, AsanaReauthenticationCompleteInput, AsanaReauthenticationCancelInput, AsanaAuthenticationState, AsanaSyncCoordinatorResult>;
  protected abstract get synchronizationOperations(): SynchronizationRuntime;
  protected abstract getState(): ApplicationState;
  protected abstract recordDiagnostic(code: DiagnosticRecord["code"], severity: DiagnosticRecord["severity"], metadata?: Record<string, unknown>): void;
  protected abstract requireTaskReadRuntime(): TaskReadRuntimePort;
  protected abstract requireTaskWriteExecution(): NonNullable<MainWorkflowConstruction["taskWriteExecution"]>;
  protected abstract requireRuntime(): AsanaSyncRuntime;
  protected abstract requireContext(): OperationalContext;
  protected abstract assertSetupReady(): void;
  protected abstract assertOperationalReady(): void;
  protected abstract isOnline(): boolean;
  protected abstract rethrowFeatureAbort(error: unknown, signal: AbortSignal): void;
  protected abstract recordFeatureFailure(error: unknown, channel: string, message: string): void;
  protected abstract recordCodexKnownFailure(error: unknown, message: string): void;
  protected abstract recordUnexpectedError(error: unknown, channel: string): void;
  protected abstract initializeExternalAgentBridge(): Promise<void>;
  protected abstract configureOperationalServices(): void;
  protected abstract prepareApprovalInput(input: ApprovalPreparationInput, signal: AbortSignal): Promise<AsanaProposalApplicationInput>;
  protected abstract applyExternalProposal(input: AsanaProposalApplicationInput, signal: AbortSignal): Promise<AsanaProposalApplicationResult>;
  protected abstract getSavedProposalOperationStatus(proposalId: string, operationId: string): SavedOperationStatusResult | undefined;
  protected abstract createAiWorkflow(session: CodexSessionService, baselineStore: AiSessionBaselineStore, sessionId: string): AiWorkflowService;
}
