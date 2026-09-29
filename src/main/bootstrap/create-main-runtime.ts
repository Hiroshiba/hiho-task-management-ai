import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { autoUpdater } from "electron-updater";
import { setupStateSchema } from "../../shared/ipc-contracts";
import { dateSchema, gidSchema, identifierSchema, importanceSchema, isoDateTimeSchema } from "../domain";
import { DiagnosticFailureDispositionError } from "../application/common/errors/diagnostic-failure";
import type { ErrorReporter } from "../application/common/errors/error-reporter";
import type { SecretStorageData, SecretStoragePort } from "../application/common/ports/secret-storage";
import { DiagnosticLogService } from "../application/common/diagnostic-log-service";
import { createNowIso } from "../application/common/runtime-clock";
import { parseTaskWritePlan, taskWriteReceiptSchema } from "../application/common/task-write-plan";
import { getGithubIntegrationStatus } from "../application/github-integration";
import { createExternalToolStatusEvidenceParser } from "../application/proposal-generate";
import { ObsidianReadService } from "../infrastructure/obsidian";
import type { ApplicationState } from "../application/settings";
import { ProposalExecutionEngine, taskWriteExecutionResultSchema, type TaskWriteExecutionResult } from "../application/task-write";
import { createDiagnosticsHandlers, type DiagnosticsHandlers } from "../ipc/handlers/diagnostics";
import { createGithubIntegrationHandlers, type GithubIntegrationHandlers } from "../ipc/handlers/github-integration";
import { createObsidianIntegrationHandlers, type ObsidianIntegrationHandlers } from "../ipc/handlers/obsidian-integration";
import { createProposalsHandlers, type ProposalsHandlers } from "../ipc/handlers/proposals";
import { createSettingsHandlers, type SettingsHandlers } from "../ipc/handlers/settings";
import { createSystemHandlers, type SystemHandlers, type SystemHandlerWorkflow } from "../ipc/handlers/system";
import { createTasksHandlers, type TasksHandlers } from "../ipc/handlers/tasks";
import { FeatureIpcRegistry } from "../ipc/register-ipc";
import type { ProposalExecutionRepository } from "../application/common/ports/proposal-execution-repository";
import type { GuiEditExecution } from "../application/gui-edit";
import type { StoredProposalExecution } from "../application/proposal-apply";
import {
  AsanaCapabilityCheckService,
  AsanaDeltaSyncSource,
  AsanaDisplayOrderService,
  AsanaFullSyncSource,
  AsanaMutableTokenProvider,
  AsanaNormalizationPlanApplier,
  AsanaOAuthClient,
  AsanaOAuthCoordinator,
  AsanaOperationQueue,
  AsanaReadClient,
  AsanaRequestScheduler,
  AsanaSetupClient,
  AsanaSetupResourceCoordinator,
  AsanaSyncCoordinator,
  AsanaSyncRuntime,
  AsanaTaskReadAdapter,
  AsanaTaskWriteCallAdapter,
  AsanaTaskWriteClient,
  AsanaTaskWriteReadBackAdapter,
  AsanaTransport,
  getRestAsanaHttpErrorDetail,
  type AsanaCommunicationRuntime,
} from "../infrastructure/asana";
import {
  ExternalAgentBridge,
  CodexSessionService,
  CodexSetupAdapter,
  ExternalToolBroker,
  ExternalToolRegistry,
  ExternalToolStatusEvidenceCollector,
  SecretStorageDiscordCredentialProvider,
  createCodexAppServerConnectionFactory,
  createCodexDiagnosticDetailAdapter,
  createTaskctlRankingSchemas,
  createSnapshotHasher,
  externalToolDefinitionSchema,
  externalToolStatusEvidenceSchema,
  initializeCodexSessionWorkspaceParent,
  initializeCodexWorkspace,
  installContextctlClientScript,
  installDisabledExternalToolsSkill,
  removeCodexSessionWorkspace,
  resolveCodexExecutable,
  type ExternalAgentBridgeOptions,
} from "../infrastructure/ai";
import { JsonlErrorReporter, createPersistentErrorLogFormatter, knownSecretsFromStorage, writeErrorReportFailure } from "../infrastructure/logging";
import {
  ApplicationUpdateAttemptStore,
  ensureSecureUserDataDirectory,
  PersistenceRuntime,
  readSecurePersistentTextFile,
  removeSecurePersistentFile,
  SqliteDiagnosticLogRepository,
  SqliteExternalToolDefinitionRepository,
  SqliteProposalApplicationHistoryRepository,
  SqliteProposalExecutionRepository,
  SqliteSettingsRepository,
  SqliteVaultMappingRepository,
  TaskReadPersistenceRepository,
  createRankingCacheSchema,
  deviceSettingsSchema,
  externalToolCredentialReferenceNamesSchema,
  SecretStorage,
  SetupCheckpointStore,
  WindowStateStore,
  writeSecurePersistentTextFileAtomically,
  type LegacyMigrationSummary,
  type DiagnosticRecord,
} from "../infrastructure/persistence";
import { MainWorkflowComposition } from "./main-workflow-composition";
import { createTaskWriteRuntime } from "./create-task-write-runtime";
import { createObsidianRuntime } from "./create-obsidian-runtime";
import { createSettingsRuntime } from "./create-settings-runtime";
import { createTaskReadRuntime } from "./create-task-read-runtime";
import type { AsanaSyncRuntimeFactory } from "./create-task-read-composition-dependencies";
import { createSynchronizationRuntime } from "./create-synchronization-runtime";
import { createTaskReadPersistenceContracts } from "./task-read-storage-contracts";
import { createExternalToolDefinitionRecordSchema } from "./external-tool-storage-contracts";
import { CodexSessionResources } from "./codex-session-resources";
import { createCodexProcessEnvironment } from "./codex-runtime-utilities";
import { ApplicationUpdateService, isApplicationUpdateCandidate } from "./application-update-service";

type MainRuntimeOptions = {
  readonly userDataPath: string;
  readonly logsPath: string;
  readonly update: {
    readonly packaged: boolean;
    readonly resourcesPath: string;
  };
  readonly system: SystemHandlerWorkflow;
  readonly ipcSecurity: {
    readonly assertTrustedSender: (event: IpcMainInvokeEvent, webContents: WebContents, rendererUrl: string) => void;
    readonly isApplicationUrl: (url: string, rendererUrl: string) => boolean;
  };
  readonly composition: Omit<ConstructorParameters<typeof MainWorkflowComposition>[0], "lifecycle_signal" | "now_provider" | "create_id" | "snapshot_hasher" | "user_data_path" | "codex_executable">;
};

function createFallbackErrorReporter(
  createId: () => string,
  knownSecrets: () => readonly string[],
  redactText: (value: string) => string,
): ErrorReporter {
  const reported = new WeakMap<object, string>();
  const reportErrorOnce = (error: unknown): string => {
    const objectError = error !== null && typeof error === "object" ? error : undefined;
    const existing = objectError == null ? undefined : reported.get(objectError);
    if (existing != null) return existing;
    const errorId = createId();
    writeErrorReportFailure(new Error(`エラーID: ${errorId}`, { cause: error }), knownSecrets(), redactText);
    if (objectError != null) reported.set(objectError, errorId);
    return errorId;
  };
  return {
    reportErrorOnce,
    reportErrorOnceStrict: (error) => {
      reportErrorOnce(error);
      throw new Error("永続エラーログを初期化できません。", { cause: error });
    },
  };
}

const migrationFailureReasons = {
  invalid_source: "元の旧行を検証できません。",
  conflicting_history: "同じIDの履歴と元の旧行が一致しません。",
  missing_backup: "移行前バックアップがありません。",
  missing_backup_row: "移行前バックアップに元の旧行がありません。",
} satisfies Record<LegacyMigrationSummary["failures"][number]["reason"], string>;

function recordLegacyMigration(
  summary: LegacyMigrationSummary,
  reporter: ErrorReporter,
  backupPaths: PersistenceRuntime["migrationBackupPaths"],
): void {
  for (const failure of summary.failures) {
    reporter.reportErrorOnce(
      new Error(`旧適用ジャーナルの履歴移行に失敗しました。proposal ID: ${failure.proposal_id}、操作ID: ${failure.operation_id}。${migrationFailureReasons[failure.reason]}`),
      {
        source: "main",
        diagnosticCode: "proposal.application",
        context: "bootstrap",
        level: "error",
        operationId: failure.operation_id,
      },
    );
  }
  console.info(JSON.stringify({
    event: "legacy_application_migration",
    backup_paths: backupPaths,
    source_count: summary.source_count,
    migrated_count: summary.migrated_count,
    already_migrated_count: summary.already_migrated_count,
    failed_count: summary.failures.length,
    failed_ids: summary.failures.map((failure) => ({
      proposal_id: failure.proposal_id,
      operation_id: failure.operation_id,
    })),
  }));
}

/** Mainの単一ランタイムと資源の破棄入口です。 */
export interface MainRuntime {
  getState(): ApplicationState;
  recordDiagnostic(
    code: DiagnosticRecord["code"],
    severity: DiagnosticRecord["severity"],
    metadata?: Pick<DiagnosticRecord, "asana_gid" | "operation_id" | "proposal_id" | "http_status">,
  ): void;
  start(signal: AbortSignal): Promise<ApplicationState>;
  readonly taskRead: {
    readonly onForeground: (signal: AbortSignal) => Promise<void>;
    readonly onOnline: () => Promise<void>;
    readonly setOnline: (online: boolean) => void;
  };
  readonly reporter: ErrorReporter | undefined;
  readonly knownSecrets: () => readonly string[];
  readonly taskWriteExecution: {
    readonly repository: ProposalExecutionRepository<TaskWriteExecutionResult>;
    readonly engine: ProposalExecutionEngine<TaskWriteExecutionResult>;
    readonly onGuiChanged: (listener: (execution: GuiEditExecution) => void) => () => void;
    readonly onProposalChanged: (listener: (execution: StoredProposalExecution) => void) => () => void;
  };
  readonly systemHandlers: SystemHandlers;
  readonly settingsHandlers: SettingsHandlers;
  readonly tasksHandlers: TasksHandlers;
  readonly proposalsHandlers: ProposalsHandlers;
  readonly githubIntegrationHandlers: GithubIntegrationHandlers;
  readonly obsidianIntegrationHandlers: ObsidianIntegrationHandlers;
  readonly diagnosticsHandlers: DiagnosticsHandlers;
  readonly signal: AbortSignal;
  attachWindow(ipcMain: IpcMain, webContents: WebContents, rendererUrl: string): void;
  detachWindow(webContents: WebContents): void;
  createWindowStateStore(): WindowStateStore;
  createApplicationUpdateService(reportError: (error: unknown) => string): ApplicationUpdateService;
  abort(): void;
  dispose(): Promise<void>;
  closeLateFiles(): void;
}

/** Mainの診断sink、保存資源、機能別workflowを一度だけ組み立てます。 */
export function createMainRuntime(options: MainRuntimeOptions): MainRuntime {
  const userDataPath = ensureSecureUserDataDirectory(options.userDataPath);
  const loggerFormatter = createPersistentErrorLogFormatter(
    getRestAsanaHttpErrorDetail,
    createCodexDiagnosticDetailAdapter(),
  );
  const codexExecutable = resolveCodexExecutable();
  const nowProvider = () => new Date();
  const createId = randomUUID;
  const snapshotHasher = createSnapshotHasher();
  let currentKnownSecrets: readonly string[] = [];
  const knownSecrets = (): readonly string[] => currentKnownSecrets;
  const rememberKnownSecrets = (data: SecretStorageData | undefined): void => {
    currentKnownSecrets = [...new Set([...currentKnownSecrets, ...knownSecretsFromStorage(data)])];
  };
  let reporter: ErrorReporter | undefined;
  try {
    reporter = new JsonlErrorReporter(options.logsPath, knownSecrets, loggerFormatter);
  } catch (error) {
    writeErrorReportFailure(error, knownSecrets(), loggerFormatter.redactText);
  }
  const controller = new AbortController();
  let persistence: PersistenceRuntime | undefined;
  try {
    persistence = new PersistenceRuntime(join(userDataPath, "taskhub.sqlite3"));
    const openedPersistence = persistence;
    const storedSecrets = new SecretStorage(
      openedPersistence.openTextFile(join(userDataPath, "secret-storage.json"), "秘密情報ファイル"),
    );
    const secretStorage: SecretStoragePort = {
      load: () => {
        const data = storedSecrets.load();
        rememberKnownSecrets(data);
        return data;
      },
      save: (data) => {
        rememberKnownSecrets(data);
        storedSecrets.save(data);
      },
      clear: () => {
        storedSecrets.clear();
      },
    };
    const files = {
      createExternalAgentBridge: ({
        userDataPath,
        handleRequest,
        onError,
      }: Pick<ExternalAgentBridgeOptions, "userDataPath" | "handleRequest" | "onError">) =>
        new ExternalAgentBridge({
          userDataPath,
          handleRequest,
          onError,
          openConfigFile: (filePath: string) =>
            openedPersistence.openTextFile(filePath, "外部連携設定"),
          secureFiles: {
            ensureDirectory: ensureSecureUserDataDirectory,
            readText: readSecurePersistentTextFile,
            writeText: writeSecurePersistentTextFileAtomically,
            removeFile: removeSecurePersistentFile,
          },
        }),
    };
    const checkpoint = new SetupCheckpointStore(
      openedPersistence.openTextFile(join(userDataPath, "setup-checkpoint.json"), "初回設定チェックポイント"),
      (value) => setupStateSchema.parse(value),
    );
    const createOAuthClient = (clientId: string): AsanaOAuthClient =>
      new AsanaOAuthClient(clientId, secretStorage);
    const tokenProvider = new AsanaMutableTokenProvider();
    const transport = new AsanaTransport(new AsanaRequestScheduler(), tokenProvider);
    const normalTransport = transport.withPriority("normal");
    const highPriorityTransport = transport.withPriority("high");
    const readClient = new AsanaReadClient(normalTransport);
    const writeClient = new AsanaTaskWriteClient(normalTransport);
    const setupClient = new AsanaSetupClient(normalTransport);
    const lowPriorityWriteClient = new AsanaTaskWriteClient(transport.withPriority("low"));
    const operationQueue = new AsanaOperationQueue(controller.signal);
    const asana: AsanaCommunicationRuntime = {
      setTokenProvider: (clientId) => tokenProvider.setProvider(createOAuthClient(clientId)),
      highPriorityTransport,
      readClient,
      interactiveReadClient: new AsanaReadClient(highPriorityTransport),
      writeClient,
      setupClient,
      setupResources: new AsanaSetupResourceCoordinator(setupClient, readClient),
      setupCapability: new AsanaCapabilityCheckService(readClient, writeClient, nowProvider),
      operationQueue,
      oauth: new AsanaOAuthCoordinator(
        secretStorage,
        createOAuthClient,
        options.composition.open_authorization_url,
      ),
      createDisplayOrder: (notifyUnexpectedError) => new AsanaDisplayOrderService(
        lowPriorityWriteClient,
        notifyUnexpectedError,
        controller.signal,
        operationQueue,
      ),
    };
    const engineReporter = reporter ?? createFallbackErrorReporter(createId, knownSecrets, loggerFormatter.redactText);
    const historyRepository = new SqliteProposalApplicationHistoryRepository(openedPersistence, engineReporter);
    recordLegacyMigration(historyRepository.migrate(), engineReporter, openedPersistence.migrationBackupPaths);
    historyRepository.assertNoUnmigratedJournals();
    const rankingCacheSchema = createRankingCacheSchema({
      dateSchema,
      gidSchema,
      identifierSchema,
      importanceSchema,
      isoDateTimeSchema,
    });
    const taskReadPersistenceContracts = createTaskReadPersistenceContracts(rankingCacheSchema);
    const taskReadRepository = new TaskReadPersistenceRepository(openedPersistence, taskReadPersistenceContracts);
    const createSyncRuntime: (
      coordinator: AsanaSyncCoordinator,
      ...args: Parameters<AsanaSyncRuntimeFactory>
    ) => AsanaSyncRuntime = (
      coordinator: AsanaSyncCoordinator,
      context,
      online,
      beforeSynchronization,
      reportUnexpectedError,
    ) => new AsanaSyncRuntime(
      coordinator,
      taskReadRepository,
      {
        project_gid: context.project_gid,
        section_gids: context.section_gids,
        device_id: context.device_id,
        app_version: options.composition.app_version,
        initial_online: online,
      },
      controller.signal,
      beforeSynchronization,
      reportUnexpectedError,
      options.composition.unhandled_error_forwarder,
      () => createNowIso(nowProvider),
      operationQueue,
      taskReadPersistenceContracts.parseSyncState,
    );
    const taskctlSchemas = createTaskctlRankingSchemas(rankingCacheSchema);
    const externalToolDefinitionRecordSchema = createExternalToolDefinitionRecordSchema();
    const externalToolDefinitionRepository = new SqliteExternalToolDefinitionRepository(
      openedPersistence.connection,
      {
        parseDefinition: (value) => externalToolDefinitionSchema.parse(value),
        parseRecord: (value) => externalToolDefinitionRecordSchema.parse(value),
        parseCredentialReferenceNames: (value) =>
          externalToolCredentialReferenceNamesSchema.parse(value),
      },
    );
    const settingsRepository = new SqliteSettingsRepository(
      openedPersistence.connection,
      (value) => deviceSettingsSchema.parse(value),
    );
    const vaultMappingRepository = new SqliteVaultMappingRepository(openedPersistence.connection);
    const obsidian = createObsidianRuntime({
      repository: vaultMappingRepository,
      reader: new ObsidianReadService(vaultMappingRepository),
    }, {
      openObsidianUrl: options.composition.open_obsidian_url,
      readOnlyVaultPaths: options.composition.read_only_vault_paths,
      diagnostic: options.composition.diagnostic,
    });
    const createEvidenceCollector = (): ExternalToolStatusEvidenceCollector =>
      new ExternalToolStatusEvidenceCollector(
        createExternalToolStatusEvidenceParser(externalToolStatusEvidenceSchema),
      );
    const composition = new MainWorkflowComposition({
      ...options.composition,
      codex_executable: codexExecutable,
      user_data_path: userDataPath,
      lifecycle_signal: controller.signal,
      now_provider: nowProvider,
      create_id: createId,
      snapshot_hasher: snapshotHasher,
    }, files, historyRepository, {
      vaultMappingRepository: obsidian.repository,
      obsidian: obsidian.workflow,
      secretStorage,
      checkpoint,
      asana,
      createSyncCoordinator: () => new AsanaSyncCoordinator(
        asana.readClient,
        new AsanaFullSyncSource(asana.readClient, asana.writeClient),
        new AsanaDeltaSyncSource(asana.readClient),
        new AsanaNormalizationPlanApplier(asana.readClient, asana.writeClient, createId),
        taskReadRepository,
        () => createNowIso(nowProvider),
        taskReadPersistenceContracts,
        rankingCacheSchema,
      ),
      createSyncRuntime,
      taskReadPersistenceContracts,
      taskReadRepository,
      taskctlSchemas,
      externalToolDefinitionRepository,
      createExternalToolRegistry: (definition) => {
        const registry = new ExternalToolRegistry();
        registry.register(definition);
        return registry;
      },
      initializeCodexWorkspace: (path) => initializeCodexWorkspace({ userDataPath: path }),
      initializeCodexSessionWorkspaceParent,
      createCodexEnvironment: (codexHomePath) =>
        createCodexProcessEnvironment(codexHomePath, process.execPath),
      createCodexConnectionFactory: (environment, onError) =>
        createCodexAppServerConnectionFactory({
          executable: codexExecutable,
          environment,
          clientInfo: {
            name: "taskhub",
            title: "TaskHub",
            version: options.composition.app_version,
          },
          capabilities: { experimentalApi: true },
          configOverrides: [],
        }, onError),
      createCodexSessionResources: (input) => new CodexSessionResources({
        ...input,
        createWorkspace: (path) => initializeCodexWorkspace({ userDataPath: path }),
        createSession: (sessionOptions, schemas) => new CodexSessionService(sessionOptions, schemas),
        createEvidenceCollector,
        createBroker: (registry, tmpDirectoryPath, collector) => new ExternalToolBroker({
          tmp_directory_path: tmpDirectoryPath,
          registry,
          discord_credential_provider: new SecretStorageDiscordCredentialProvider(secretStorage),
          status_evidence_collector: collector,
        }),
        installClient: installContextctlClientScript,
      }),
      createCodexSetupAdapter: (session, environment) => new CodexSetupAdapter({
        session,
        executable: codexExecutable,
        environment,
        openAuthorizationUrl: options.composition.open_codex_authorization_url,
      }),
      createEvidenceCollector,
      hasDiscordBotToken: () =>
        new SecretStorageDiscordCredentialProvider(secretStorage).hasBotToken(),
      installDisabledSkill: installDisabledExternalToolsSkill,
      installClient: installContextctlClientScript,
      removeSessionWorkspace: removeCodexSessionWorkspace,
      settingsRepository,
    });
    obsidian.bindHost(composition.getObsidianCompositionDependencies());
    const diagnosticDependencies = composition.getDiagnosticCompositionDependencies();
    const diagnosticLogRepository = new SqliteDiagnosticLogRepository(
      openedPersistence.connection,
      openedPersistence,
      diagnosticDependencies.parseEntry,
    );
    composition.attachDiagnosticRuntime(new DiagnosticLogService(
      diagnosticLogRepository,
      diagnosticDependencies.appVersion,
      diagnosticDependencies.now,
      1_000,
      diagnosticDependencies.parseAppVersion,
      diagnosticDependencies.parseRecord,
      diagnosticDependencies.parseEntry,
    ));
    const taskWriteBridge = composition.getTaskWriteAsanaBridge();
    const taskWrite = createTaskWriteRuntime({
      bridge: taskWriteBridge,
      historyRepository,
      reporter: engineReporter,
      createRepository: (fingerprint) => new SqliteProposalExecutionRepository<TaskWriteExecutionResult>(
        openedPersistence,
        (value) => parseTaskWritePlan(value, fingerprint),
        (value) => taskWriteReceiptSchema.parse(value),
        taskWriteExecutionResultSchema,
        engineReporter,
      ),
      createId,
      now: nowProvider,
      createReadBack: () => new AsanaTaskWriteReadBackAdapter(
        taskWriteBridge.readClient,
        (error) => taskWriteBridge.isNotFound(error),
        (milliseconds, signal) => setTimeout(milliseconds, undefined, { signal }),
      ),
      createAsanaExecutors: () => new AsanaTaskWriteCallAdapter(
        taskWriteBridge.transport,
        taskWriteBridge.readClient,
      ).getExecutors(),
    });
    composition.setTaskWriteExecution({ proposal: taskWrite.proposal, proposalWorkflow: taskWrite.proposalWorkflow, gui: taskWrite.gui, guiWorkflow: taskWrite.guiWorkflow });
    composition.attachSynchronizationRuntime(createSynchronizationRuntime(
      composition.getSynchronizationCompositionDependencies(),
    ));
    const taskReadHost = composition.getTaskReadCompositionDependencies();
    type TaskReadSyncRuntime = ReturnType<typeof taskReadHost.requireRuntime>;
    const taskRead = createTaskReadRuntime<
      ReturnType<typeof taskReadHost.contracts.parseOverview>,
      ReturnType<typeof taskReadHost.contracts.parseDetail>,
      Awaited<ReturnType<TaskReadSyncRuntime["manualSync"]>>,
      Awaited<ReturnType<typeof taskReadHost.coordinateFull>>,
      ReturnType<TaskReadSyncRuntime["getState"]>,
      Parameters<typeof taskReadHost.createSyncRuntime>[0],
      ReturnType<typeof taskReadHost.parseSetupInput>,
      TaskReadSyncRuntime
    >(taskReadHost, new AsanaTaskReadAdapter(taskReadHost.requireRuntime));
    composition.attachTaskReadRuntime(taskRead);
    const systemHandlers = createSystemHandlers(options.system);
    const settingsRuntime = createSettingsRuntime(composition.getSettingsCompositionDependencies(), createId);
    composition.attachSettingsRuntime(settingsRuntime.setupWorkflow, settingsRuntime.reauthenticationWorkflow);
    const settingsHandlers = createSettingsHandlers(settingsRuntime);
    const tasksHandlers = createTasksHandlers({
      taskRead: taskRead.workflow,
      guiEdit: composition,
      taskWriteExecution: {
        getExecution: (executionId) => composition.getGuiEditExecution(executionId),
        retryExecution: (executionId, signal) => composition.retryGuiEditExecution(executionId, signal),
      },
    });
    const proposalsHandlers = createProposalsHandlers(composition.getProposalsHandlerWorkflows());
    const githubIntegrationHandlers = createGithubIntegrationHandlers({ getStatus: getGithubIntegrationStatus }, engineReporter);
    const obsidianIntegrationHandlers = createObsidianIntegrationHandlers(
      obsidian.workflow.createIpcPort(),
    );
    const diagnosticsHandlers = createDiagnosticsHandlers(engineReporter);
    const featureIpc = new FeatureIpcRegistry({
      signal: controller.signal,
      ...options.ipcSecurity,
      reporter: engineReporter,
      handlers: {
        system: systemHandlers,
        tasks: tasksHandlers,
        settings: settingsHandlers,
        proposals: proposalsHandlers,
        githubIntegration: githubIntegrationHandlers,
        obsidianIntegration: obsidianIntegrationHandlers,
        diagnostics: diagnosticsHandlers,
      },
      events: {
        updateState: (listener) => options.system.onUpdateState(listener),
        syncState: (listener) => taskRead.workflow.onState(listener),
        guiExecution: taskWrite.onGuiChanged,
        aiStatus: (listener) => composition.onAiStatus(listener),
        aiDelta: (listener) => composition.onAiDelta(listener),
        externalState: (listener) => composition.onExternalAgentChanged(listener),
        proposalExecution: taskWrite.onProposalChanged,
      },
    });
    let disposal: Promise<void> | undefined;
    let windowStateStore: WindowStateStore | undefined;
    let applicationUpdateServiceCreated = false;
    return {
      getState: () => composition.getState(),
      recordDiagnostic: (code, severity, metadata) => composition.recordDiagnostic(code, severity, metadata),
      start: (signal) => composition.start(signal),
      taskRead,
      reporter,
      knownSecrets,
      taskWriteExecution: {
        repository: taskWrite.repository,
        engine: taskWrite.engine,
        onGuiChanged: taskWrite.onGuiChanged,
        onProposalChanged: taskWrite.onProposalChanged,
      },
      systemHandlers,
      settingsHandlers,
      tasksHandlers,
      proposalsHandlers,
      githubIntegrationHandlers,
      obsidianIntegrationHandlers,
      diagnosticsHandlers,
      signal: controller.signal,
      attachWindow: (ipcMain, webContents, rendererUrl) => featureIpc.attach(ipcMain, webContents, rendererUrl),
      detachWindow: (webContents) => featureIpc.detach(webContents),
      createWindowStateStore: () => {
        windowStateStore ??= new WindowStateStore(
          openedPersistence.openLateTextFile(
            join(userDataPath, "window-state.json"),
            "ウィンドウ状態",
          ),
        );
        return windowStateStore;
      },
      createApplicationUpdateService: (reportError) => {
        if (applicationUpdateServiceCreated) {
          throw new Error("アプリ本体の更新サービスは既に生成されています。");
        }
        const service = new ApplicationUpdateService(
          autoUpdater,
          options.composition.app_version,
          isApplicationUpdateCandidate(
            options.update.packaged,
            process.platform,
            process.arch,
            options.composition.app_version,
            options.update.resourcesPath,
          ),
          process.platform,
          options.update.resourcesPath,
          new ApplicationUpdateAttemptStore(
            openedPersistence.openLateTextFile(
              join(userDataPath, "application-update-attempt.json"),
              "アプリ本体の更新試行",
            ),
          ),
          reportError,
        );
        applicationUpdateServiceCreated = true;
        return service;
      },
      abort: () => {
        controller.abort();
        featureIpc.stop();
      },
      dispose: () => {
        if (disposal != null) {
          return disposal;
        }
        disposal = (async () => {
          controller.abort();
          const errors: unknown[] = [];
          try {
            featureIpc.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            await composition.stop();
          } catch (error) {
            errors.push(error);
          }
          try {
            openedPersistence.close();
          } catch (error) {
            errors.push(error);
          }
          if (errors.length === 1) {
            throw errors[0];
          }
          if (errors.length > 1) {
            throw new AggregateError(errors, "Mainの停止と保存資源の終了に失敗しました。", {
              cause: errors[0],
            });
          }
        })().catch((error: unknown) => {
          disposal = undefined;
          throw error;
        });
        return disposal;
      },
      closeLateFiles: () => openedPersistence.closeLateFiles(),
    };
  } catch (error) {
    controller.abort();
    let failure = error;
    if (persistence != null) {
      try {
        persistence.close();
      } catch (closeError) {
        failure = new AggregateError(
          [error, closeError],
          "Mainの初期化と保存資源の終了に失敗しました。",
          { cause: error },
        );
      }
    }
    if (reporter == null) {
      writeErrorReportFailure(failure, knownSecrets(), loggerFormatter.redactText);
    } else {
      reporter.reportErrorOnce(failure, {
        source: "main",
        diagnosticCode: "app.error",
        context: "bootstrap",
        level: "error",
      });
    }
    throw new DiagnosticFailureDispositionError({
      kind: "recorded_only",
      recorded_error: failure,
      response_error: failure,
    });
  }
}
