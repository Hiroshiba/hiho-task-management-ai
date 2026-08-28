import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  AsanaRequestAbortedError,
  AsanaRequestScheduler,
} from "../asana/scheduler";
import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransport,
  AsanaTransportError,
  type TokenProvider,
} from "../asana/transport";
import {
  AsanaReadClient,
  AsanaSetupClient,
  AsanaTaskWriteClient,
} from "../asana/client";
import {
  AsanaCapabilityCheckService,
  AsanaSetupResourceCoordinator,
} from "../asana/setup";
import {
  AsanaDeltaSyncSource,
  AsanaFullSyncSource,
  AsanaNormalizationPlanApplier,
  AsanaSyncCoordinator,
  AsanaSyncInProgressError,
} from "../asana/sync";
import {
  AsanaSyncRuntime,
  type AsanaSyncRuntimeResult,
  type AsanaSyncRuntimeState,
} from "../asana/runtime";
import {
  createAsanaDisplayOrderService,
  asanaDisplayOrderInputSchema,
  type AsanaDisplayOrderInput,
  type AsanaDisplayOrderService,
} from "../asana/display-order";
import {
  AsanaOAuthClient,
  AsanaOAuthCoordinator,
  AsanaOAuthCredentialError,
  AsanaOAuthHttpError,
  AsanaOAuthResponseError,
  AsanaOAuthTokenEndpointError,
  AsanaOAuthTransportError,
  asanaOAuthCoordinatorResultSchema,
} from "../auth/asana-oauth";
import { SecretStorage } from "../auth/secret-storage";
import {
  initializeCodexWorkspace,
  installContextctlClientScript,
  type CodexWorkspaceInitializationResult,
} from "../codex/workspace";
import {
  createSafeCodexEnvironment,
} from "../codex/app-server";
import {
  CodexSessionAbortedError,
  CodexSessionCapabilityError,
  CodexSessionService,
  createCodexAppServerConnectionFactory,
  type CodexSessionStartResult,
} from "../codex/session";
import { CodexSetupAdapter } from "./codex-adapter";
import { CleanupAggregationService } from "./cleanup-aggregation";
import {
  DiagnosticLogService,
  type DiagnosticRecord,
} from "./diagnostics";
import {
  AiWorkflowService,
  createBaselineSnapshot,
  type ApprovalPreparationInput,
} from "../ai/workflow";
import {
  AsanaProposalApplicationCoordinator,
  AsanaProposalOperationWriter,
  asanaPostWriteSynchronizationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryResult,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResult,
} from "../ai/proposal-application";
import {
  AsanaGuiEditService,
  type AsanaGuiEditInput,
  type AsanaGuiEditRelationGraphValidationRequest,
  type AsanaGuiEditRelationGraphValidationResult,
} from "../gui-edit";
import {
  ingestAsanaExternalData,
  normalizeAsanaSnapshot,
  normalizeTaskGraph,
  type NormalizationTask,
} from "../domain";
import { ReadModelService } from "../read-model";
import { ObsidianReadService } from "../obsidian";
import {
  ExternalToolBroker,
  ExternalToolError,
  ExternalToolRegistry,
  ExternalToolStatusEvidenceCollector,
  type ExternalToolDefinition,
} from "../external-tools";
import {
  SetupCheckpointStore,
} from "./checkpoint";
import {
  applicationOptionsSchemaExport,
  applicationStateSchemaExport,
  type ApplicationOptions,
  type ApplicationState,
} from "./schemas";
import {
  SetupOrchestrator,
  setupFullSyncInputSchema,
  type SetupFullSyncInput,
} from "../setup";
import {
  asanaTaskResponseSchema,
  canonicalizeJson,
  dateSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  serializeCustomExternalData,
  taskSchema,
  type AsanaTaskResponse,
} from "../../shared/domain";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowSnapshotSchema,
  aiWorkflowTurnRequestSchema,
  aiWorkflowTurnResultSchema,
  type AiWorkflowSnapshot,
} from "../../shared/ai-workflow";
import {
  taskctlSnapshotSchema,
  type TaskctlSnapshot,
} from "../codex/taskctl";
import {
  codexUnavailableReasonSchema,
  setupCodexAvailabilitySchema,
  type SetupCodexAvailability,
  type SetupState,
  setupStateSchema,
} from "../../shared/setup";
import {
  type IpcAiPort,
  type IpcAsanaPort,
  type IpcGuiEditPort,
  type IpcObsidianPort,
  type IpcReadModelPort,
  type IpcServicePorts,
  type IpcSetupPort,
  type IpcSyncPort,
} from "../ipc";
import {
  ipcAiDeltaEventSchema,
  ipcAiStatusEventSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResultSchema,
  ipcSyncInputSchema,
  ipcSyncResultSchema,
  ipcSyncStateEventSchema,
  type IpcAiStatus,
  type IpcCodexDelta,
  type IpcSyncResult,
  type IpcSyncStateEvent,
  type IpcGuiEditInput as IpcGuiRequest,
  type IpcGuiEditResult,
  type IpcAiTurnInput,
  type IpcAiTurnResult,
  type IpcAiProposalView,
  type IpcAiSelectionInput,
  type IpcAiEditInput,
  type IpcAiApprovalInput,
  type IpcAiApprovalResult,
} from "../../shared/ipc";
import {
  deviceSettingsSchema,
  type DeviceSettings,
  type TaskCacheEntry,
} from "../../shared/storage";
import {
  StorageDatabase,
  type ExternalToolDefinitionRecord,
} from "../storage";

type OperationalContext = {
  readonly redirect_uri: string;
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly workspace_name: string;
  readonly project_gid: string;
  readonly project_name: string;
  readonly section_gids: DeviceSettings["section_gids"];
  readonly tag_gids: Extract<SetupState, { kind: "resources_ready" }>["context"]["tag_gids"];
  readonly codex: Extract<SetupState, { kind: "resources_ready" }>["context"]["codex"];
};

type MutableTokenProviderPort = TokenProvider & {
  setProvider(provider: TokenProvider): void;
};

type MutableExternalToolRegistryPort = Pick<
  ExternalToolRegistry,
  "get" | "list"
> & {
  replace(records: readonly ExternalToolDefinitionRecord[]): void;
};

type BaselineExternalData = AsanaProposalApplicationInput["baseline_external_data"];

const codexAuthenticationStateSchema = z.union([
  z.object({ kind: z.literal("authenticated") }).strict(),
  z.object({ kind: z.literal("required") }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason_code: codexUnavailableReasonSchema,
  }).strict(),
]);

type CodexAuthenticationState = z.infer<typeof codexAuthenticationStateSchema>;

type ExternalIntegrationState =
  | { readonly kind: "not_started" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "ready";
      readonly broker: ExternalToolBroker;
    };

type SyncDiagnosticState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly previous_success_at: string | undefined;
    };

const maximumApprovalTaskCount = 10_000;
const diagnosticLogRetentionLimit = 1_000;
const asanaOAuthReauthenticationTimeoutMilliseconds = 120_000;

function diagnosticCodeForChannel(
  channel: string,
): DiagnosticRecord["code"] {
  switch (channel) {
    case "sync":
    case "display_order":
      return "sync.failed";
    case "codex":
      return "codex.status";
    case "external_tools":
      return "external_tools.status";
    case "application_journal":
      return "proposal.application";
    case "sync_state_listener":
    case "ai_status_listener":
    case "ipc":
      return "ipc.error";
    default:
      return "app.error";
  }
}

function externalToolDefinitionFromRecord(
  record: ExternalToolDefinitionRecord,
): ExternalToolDefinition {
  const { credential_reference_names: _credentialReferenceNames, ...definition } = record;
  void _credentialReferenceNames;
  return definition;
}

function createMutableExternalToolRegistry(
  records: readonly ExternalToolDefinitionRecord[],
): MutableExternalToolRegistryPort {
  let registry = new ExternalToolRegistry();
  const replace = (nextRecords: readonly ExternalToolDefinitionRecord[]): void => {
    const nextRegistry = new ExternalToolRegistry();
    for (const record of nextRecords) {
      nextRegistry.register(externalToolDefinitionFromRecord(record));
    }
    registry = nextRegistry;
  };
  replace(records);
  return {
    get(toolId: string): ExternalToolDefinition {
      return registry.get(toolId);
    },
    list(): readonly ExternalToolDefinition[] {
      return registry.list();
    },
    replace,
  };
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

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  validateAbortSignal(signal);
  if (signal.aborted) {
    throw new Error("アプリケーション処理が中断されました。");
  }
}

function createNowIso(nowProvider: () => Date): string {
  const value = nowProvider();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("現在時刻が不正です。");
  }
  return isoDateTimeSchema.parse(value.toISOString());
}

function todayJst(nowProvider: () => Date): string {
  const value = nowProvider();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("現在時刻が不正です。");
  }
  const japanTime = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  return dateSchema.parse(japanTime.toISOString().slice(0, 10));
}

function contextFromState(state: SetupState): OperationalContext | undefined {
  switch (state.kind) {
    case "resources_ready":
    case "asana_capability_failed":
    case "vault_choice_required":
    case "vault_skipped":
    case "vault_configured":
    case "external_tool_skipped":
    case "external_tool_configured":
    case "full_sync_required":
    case "codex_capability_required":
    case "ready":
      return {
        redirect_uri: state.context.redirect_uri,
        device_id: state.context.device_id,
        client_id: state.context.client_id,
        workspace_gid: state.context.workspace_gid,
        workspace_name: state.context.workspace_name,
        project_gid: state.context.project_gid,
        project_name: state.context.project_name,
        section_gids: state.context.section_gids,
        tag_gids: state.context.tag_gids,
        codex: state.context.codex,
      };
    default:
      return undefined;
  }
}

function clientIdFromState(state: SetupState): string | undefined {
  if ("context" in state) {
    return state.context.client_id;
  }
  if ("client_id" in state) {
    return state.client_id;
  }
  return undefined;
}

function codexAvailabilityFromState(
  state: SetupState,
): OperationalContext["codex"] | undefined {
  if ("context" in state) {
    return state.context.codex;
  }
  if ("codex" in state) {
    return state.codex;
  }
  return undefined;
}

function contextMatchesSettings(
  context: OperationalContext,
  settings: DeviceSettings,
): boolean {
  return context.device_id === settings.device_id
    && context.client_id === settings.client_id
    && context.workspace_gid === settings.workspace_gid
    && context.project_gid === settings.project_gid
    && canonicalizeJson(context.section_gids) === canonicalizeJson(settings.section_gids);
}

function requiresAsanaReauthentication(error: unknown): boolean {
  if (error instanceof AsanaOAuthCredentialError) {
    return true;
  }
  if (!(error instanceof AsanaOAuthTokenEndpointError)) {
    return false;
  }
  return error.code === "invalid_client"
    || error.code === "invalid_grant"
    || error.code === "unauthorized_client";
}

function throwTokenProviderError(error: unknown): never {
  if (requiresAsanaReauthentication(error)) {
    throw new AsanaAuthenticationError(error);
  }
  throw error;
}

type PostWriteErrorClassification =
  | {
      readonly kind: "recovery_required";
      readonly error_code: PostWriteSynchronizationFailureCode;
    }
  | { readonly kind: "unexpected" };

function classifyPostWriteSynchronizationError(
  error: unknown,
): PostWriteErrorClassification {
  if (error instanceof AsanaAuthenticationError) {
    return { kind: "recovery_required", error_code: "authentication_required" };
  }
  if (error instanceof AsanaPaymentRequiredError) {
    return { kind: "recovery_required", error_code: "payment_required" };
  }
  if (error instanceof AsanaRateLimitError) {
    return { kind: "recovery_required", error_code: "rate_limited" };
  }
  if (error instanceof AsanaHttpError || error instanceof AsanaOAuthHttpError) {
    return { kind: "recovery_required", error_code: "http_error" };
  }
  if (
    error instanceof AsanaTransportError
    || error instanceof AsanaOAuthTransportError
  ) {
    return { kind: "recovery_required", error_code: "transport_error" };
  }
  if (
    error instanceof AsanaResponseError
    || error instanceof AsanaOAuthResponseError
  ) {
    return { kind: "recovery_required", error_code: "response_error" };
  }
  if (error instanceof AsanaEventsResetError) {
    return { kind: "recovery_required", error_code: "events_reset" };
  }
  if (error instanceof AsanaRequestAbortedError) {
    return { kind: "recovery_required", error_code: "request_aborted" };
  }
  if (error instanceof AsanaSyncInProgressError) {
    return { kind: "recovery_required", error_code: "sync_in_progress" };
  }
  return { kind: "unexpected" };
}

function postWriteRecoveryRequired(
  errorCode: PostWriteSynchronizationFailureCode,
): PostWriteSynchronizationResult {
  return asanaPostWriteSynchronizationResultSchema.parse({
    kind: "recovery_required",
    error_code: errorCode,
  });
}

function postWriteSynchronizationFromRuntimeResult(
  result: AsanaSyncRuntimeResult,
): PostWriteSynchronizationResult {
  switch (result.kind) {
    case "synchronized":
      return asanaPostWriteSynchronizationResultSchema.parse({
        kind: "synchronized",
      });
    case "rejected":
      return postWriteRecoveryRequired(result.reason);
    case "aborted":
      return postWriteRecoveryRequired("aborted");
    case "failed":
      switch (result.error_code) {
        case "authentication_required":
        case "payment_required":
        case "rate_limited":
        case "http_error":
        case "transport_error":
        case "response_error":
        case "events_reset":
        case "request_aborted":
        case "sync_in_progress":
          return postWriteRecoveryRequired(result.error_code);
        case "unexpected_error":
          throw new Error("書き込み後の同期が想定外エラーで停止しました。", {
            cause: result,
          });
      }
  }
}

function createMutableTokenProvider(): MutableTokenProviderPort {
  let provider: TokenProvider | undefined;
  return {
    setProvider(nextProvider: TokenProvider): void {
      if (
        typeof nextProvider?.getAccessToken !== "function"
        || typeof nextProvider.refreshAccessToken !== "function"
      ) {
        throw new TypeError("Asana TokenProviderが不正です。");
      }
      provider = nextProvider;
    },
    async getAccessToken(): Promise<string> {
      if (provider == null) {
        throw new AsanaAuthenticationError();
      }
      try {
        return await provider.getAccessToken();
      } catch (error) {
        throwTokenProviderError(error);
      }
    },
    async refreshAccessToken(): Promise<string> {
      if (provider == null) {
        throw new AsanaAuthenticationError();
      }
      try {
        return await provider.refreshAccessToken();
      } catch (error) {
        throwTokenProviderError(error);
      }
    },
  };
}

function createCodexProcessEnvironment(): Record<string, string> {
  return z.record(z.string(), z.string()).parse(
    createSafeCodexEnvironment(process.env),
  );
}

function isReadyCodexResult(
  result: CodexSessionStartResult | undefined,
): result is Extract<CodexSessionStartResult, { state: "ready" }> {
  return result?.state === "ready";
}

function isContextState(state: SetupState): boolean {
  return contextFromState(state) != null;
}

function parseTaskCache(entries: readonly TaskCacheEntry[]): readonly TaskCacheEntry[] {
  return entries.map((entry) => {
    const parsedEntry = entry;
    asanaTaskResponseSchema.parse(parsedEntry.asana_response);
    taskSchema.parse(parsedEntry.task);
    return parsedEntry;
  });
}

function externalDataIsValid(task: AsanaTaskResponse): boolean {
  const ingestion = ingestAsanaExternalData(task);
  return task.external != null
    && ingestion.kind === "valid"
    && task.external.gid === `TaskHub:v1:task:${ingestion.data.id}`
    && task.external.data === serializeCustomExternalData(ingestion.data);
}

function mergeApprovalTaskResponse(
  tasks: Map<string, AsanaTaskResponse>,
  value: AsanaTaskResponse,
): boolean {
  const candidate = asanaTaskResponseSchema.parse(value);
  const current = tasks.get(candidate.gid);
  if (current == null) {
    tasks.set(candidate.gid, candidate);
    return true;
  }
  const currentModifiedAt = Date.parse(current.modified_at);
  const candidateModifiedAt = Date.parse(candidate.modified_at);
  if (!Number.isFinite(currentModifiedAt) || !Number.isFinite(candidateModifiedAt)) {
    throw new Error("承認前再取得タスクの更新時刻を比較できません。");
  }
  if (currentModifiedAt === candidateModifiedAt) {
    if (canonicalizeJson(current) !== canonicalizeJson(candidate)) {
      throw new Error("同じ更新時刻の承認前再取得タスクが一致しません。");
    }
    return false;
  }
  if (candidateModifiedAt > currentModifiedAt) {
    tasks.set(candidate.gid, candidate);
    return true;
  }
  return false;
}

function toIpcSyncState(state: AsanaSyncRuntimeState): IpcSyncStateEvent {
  return ipcSyncStateEventSchema.parse(state);
}

function toIpcSyncResult(
  result: Extract<AsanaSyncRuntimeResult, { kind: "synchronized" }>["result"],
): IpcSyncResult {
  const {
    events_token: _eventsToken,
    ranking_cache: _rankingCache,
    ...rendererResult
  } = result;
  void _eventsToken;
  void _rankingCache;
  return ipcSyncResultSchema.parse(rendererResult);
}

function rendererCodexVersion(rawVersion: string): string {
  const match = /^codex-cli (?<version>\d+\.\d+\.\d+)$/u.exec(rawVersion);
  const version = match?.groups?.version;
  if (version == null) {
    throw new CodexSessionCapabilityError("Codex CLIの表示用バージョンが不正です。");
  }
  return identifierSchema.parse(version);
}

/** TaskHubの主要な依存関係を組み立てるメインプロセスサービスです。 */
export class TaskHubApplication {
  private readonly options: ApplicationOptions;
  private readonly database: StorageDatabase;
  private readonly diagnostics: DiagnosticLogService;
  private readonly secretStorage: SecretStorage;
  private readonly checkpoint: SetupCheckpointStore;
  private readonly scheduler: AsanaRequestScheduler;
  private readonly tokenProvider: MutableTokenProviderPort;
  private readonly transport: AsanaTransport;
  private readonly readClient: AsanaReadClient;
  private readonly interactiveReadClient: AsanaReadClient;
  private readonly setupClient: AsanaSetupClient;
  private readonly writeClient: AsanaTaskWriteClient;
  private readonly interactiveWriteClient: AsanaTaskWriteClient;
  private readonly oauth: AsanaOAuthCoordinator;
  private readonly resources: AsanaSetupResourceCoordinator;
  private readonly capability: AsanaCapabilityCheckService;
  private readonly fullSource: AsanaFullSyncSource;
  private readonly deltaSource: AsanaDeltaSyncSource;
  private readonly planApplier: AsanaNormalizationPlanApplier;
  private readonly syncCoordinator: AsanaSyncCoordinator;
  private readonly codexWorkspace: CodexWorkspaceInitializationResult;
  private readonly codexSession: CodexSessionService;
  private readonly codexAdapter: CodexSetupAdapter;
  private readonly setup: SetupOrchestrator;
  private readonly readModel: ReadModelService;
  private readonly obsidian: ObsidianReadService;
  private readonly cleanupAggregation: CleanupAggregationService;
  private readonly externalWorkRoot: string;
  private readonly externalRegistry: MutableExternalToolRegistryPort;
  private readonly externalStatusEvidenceCollector: ExternalToolStatusEvidenceCollector;
  private externalIntegrationState: ExternalIntegrationState = { kind: "not_started" };
  private context: OperationalContext | undefined;
  private settings: DeviceSettings | undefined;
  private runtime: AsanaSyncRuntime | undefined;
  private displayOrder: AsanaDisplayOrderService | undefined;
  private writer: AsanaProposalOperationWriter | undefined;
  private applicationCoordinator: AsanaProposalApplicationCoordinator | undefined;
  private guiEdit: AsanaGuiEditService | undefined;
  private aiWorkflow: AiWorkflowService | undefined;
  private aiStartResult: CodexSessionStartResult | undefined;
  private codexAvailability: OperationalContext["codex"] | undefined;
  private codexAuthenticationRequired = false;
  private readonly syncStateListeners = new Set<(state: IpcSyncStateEvent) => void>();
  private readonly aiStatusListeners = new Set<(status: IpcAiStatus) => void>();
  private readonly proposalIds = new Map<string, string>();
  private readonly baselineExternalData = new Map<string, BaselineExternalData>();
  private removeRuntimeSubscription: (() => void) | undefined;
  private lastDisplaySyncAt: string | undefined;
  private syncDiagnosticState: SyncDiagnosticState = { kind: "idle" };
  private journalRecoveryPending: boolean;
  private journalRecoveryRunning = false;
  private journalRecoveryPromise: Promise<void> | undefined;
  private aiApplicationState: "idle" | "applying" | "synchronizing" = "idle";
  private readyActivated = false;
  private stopped = false;

  public constructor(options: ApplicationOptions) {
    applicationOptionsSchemaExport.parse(options);
    this.options = options;
    this.database = new StorageDatabase(options.database_path);
    this.diagnostics = new DiagnosticLogService(
      this.database,
      options.app_version,
      options.now_provider,
      diagnosticLogRetentionLimit,
    );
    this.secretStorage = new SecretStorage(options.secret_storage_path);
    this.checkpoint = new SetupCheckpointStore(options.checkpoint_path);
    this.scheduler = new AsanaRequestScheduler();
    this.tokenProvider = createMutableTokenProvider();
    this.transport = new AsanaTransport(this.scheduler, this.tokenProvider);
    const normalTransport = this.transport.withPriority("normal");
    const highPriorityTransport = this.transport.withPriority("high");
    this.readClient = new AsanaReadClient(normalTransport);
    this.interactiveReadClient = new AsanaReadClient(highPriorityTransport);
    this.setupClient = new AsanaSetupClient(normalTransport);
    this.writeClient = new AsanaTaskWriteClient(normalTransport);
    this.interactiveWriteClient = new AsanaTaskWriteClient(highPriorityTransport);
    this.oauth = new AsanaOAuthCoordinator(
      this.secretStorage,
      options.open_authorization_url,
    );
    this.resources = new AsanaSetupResourceCoordinator(
      this.setupClient,
      this.readClient,
    );
    this.capability = new AsanaCapabilityCheckService(
      this.readClient,
      this.writeClient,
      options.now_provider,
    );
    this.fullSource = new AsanaFullSyncSource(this.readClient, this.writeClient);
    this.deltaSource = new AsanaDeltaSyncSource(this.readClient);
    this.planApplier = new AsanaNormalizationPlanApplier(
      this.readClient,
      this.writeClient,
      randomUUID,
    );
    this.syncCoordinator = new AsanaSyncCoordinator(
      this.readClient,
      this.fullSource,
      this.deltaSource,
      this.planApplier,
      this.database,
      () => createNowIso(this.options.now_provider),
    );
    this.codexWorkspace = initializeCodexWorkspace({
      userDataPath: options.user_data_path,
    });
    const connectionFactory = createCodexAppServerConnectionFactory({
      executable: options.codex_executable,
      environment: createCodexProcessEnvironment(),
      clientInfo: {
        name: "taskhub",
        title: "TaskHub",
        version: options.app_version,
      },
      capabilities: { experimentalApi: true },
    });
    this.codexSession = new CodexSessionService({
      workspacePath: this.codexWorkspace.workspacePath,
      agentsFilePath: this.codexWorkspace.agentsFilePath,
      tmpDirectoryPath: this.codexWorkspace.tmpDirectoryPath,
      readOnlyVaultPaths: [...this.readOnlyVaultPaths()],
      connectionFactory,
      snapshotProvider: () => this.createTaskctlSnapshot(),
      syncBeforeTurn: (signal) => this.requireSynchronizedBeforeAi(signal),
    });
    this.codexAdapter = new CodexSetupAdapter({
      session: this.codexSession,
      executable: options.codex_executable,
      environment: createCodexProcessEnvironment(),
      openAuthorizationUrl: options.open_codex_authorization_url,
    });
    this.readModel = new ReadModelService(this.database);
    this.obsidian = new ObsidianReadService(this.database);
    this.cleanupAggregation = new CleanupAggregationService(
      this.database,
      this.obsidian,
    );
    this.externalWorkRoot = join(options.user_data_path, "external-tool-work");
    mkdirSync(this.externalWorkRoot, { recursive: true, mode: 0o700 });
    chmodSync(this.externalWorkRoot, 0o700);
    this.externalRegistry = createMutableExternalToolRegistry(
      this.database.getExternalToolDefinitions(),
    );
    this.externalStatusEvidenceCollector = new ExternalToolStatusEvidenceCollector();
    this.setup = new SetupOrchestrator({
      redirect_uri: options.redirect_uri,
      device_id: this.resolveDeviceId(),
      codex: {
        detectCli: (signal) => this.detectCodexSafely(signal),
        getAuthenticationState: (signal) =>
          this.getCodexAuthenticationStateSafely(signal),
        completeAuthentication: (signal) =>
          this.completeCodexAuthenticationSafely(signal),
        checkCapabilities: (signal) =>
          this.checkCodexCapabilitiesSafely(signal),
      },
      oauth: {
        authenticate: async (input, signal) => {
          const result = await this.oauth.authenticate(input, signal);
          this.tokenProvider.setProvider(
            new AsanaOAuthClient(
              result.client_id,
              this.options.redirect_uri,
              this.secretStorage,
            ),
          );
          return result;
        },
      },
      asana: this.setupClient,
      resources: this.resources,
      capability: this.capability,
      database: {
        saveDeviceSettings: (value) => this.database.saveDeviceSettings(value),
        getDeviceSettings: () => this.database.getDeviceSettings(),
        saveVaultMapping: (value) => this.database.saveVaultMapping(value),
      },
      checkpoint: {
        load: () => this.checkpoint.load(),
        save: (value) => this.checkpoint.save(value),
      },
      fullSync: (input, signal) => this.runSetupFullSync(input, signal),
      configureExternalTool: (signal) => this.startExternalTools(signal),
    });
    this.settings = this.database.getDeviceSettings();
    this.journalRecoveryPending = this.database.getIncompleteApplicationJournals().length > 0;
    this.codexAvailability = contextFromState(this.setup.getState())?.codex;
    this.configureAsanaFromSettings(this.settings);
    this.configureContextFromState(this.setup.getState());
  }

  /** 現在の設定済みまたは未設定状態を取得します。 */
  public getState(): ApplicationState {
    const setupState = setupStateSchema.parse(this.setup.getState());
    const settings = this.database.getDeviceSettings();
    if (setupState.kind === "ready" && settings != null) {
      const parsedSettings = deviceSettingsSchema.parse(settings);
      return applicationStateSchemaExport.parse({
        kind: "configured",
        setup_state: setupState,
        settings: parsedSettings,
      });
    }
    return applicationStateSchemaExport.parse({
      kind: "unconfigured",
      setup_state: setupState,
    });
  }

  /** 本文を受け取らず固定コードと重要度だけを診断ログへ記録します。 */
  public recordDiagnostic(
    code: DiagnosticRecord["code"],
    severity: DiagnosticRecord["severity"],
  ): void {
    this.diagnostics.record({ code, severity });
  }

  /** 起動時の設定再開、復旧、同期を実行します。 */
  public async start(signal: AbortSignal): Promise<ApplicationState> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    if (this.stopped) {
      throw new Error("アプリケーションは停止済みです。");
    }
    this.recordDiagnostic("app.start", "info");
    let state = this.setup.getState();
    const readyCheckpointOffline = state.kind === "ready" && !this.isOnline();
    if (state.kind === "ready") {
      this.configureAsanaFromSettings(
        this.setup.restoreReadyDeviceSettings(),
      );
    }
    if (state.kind === "created" || state.kind === "codex_cli_ready") {
      state = await this.setup.start(signal);
    } else if (!readyCheckpointOffline) {
      await this.restorePersistedCodexSession(state, signal);
      if (state.kind === "resources_requires_action" || isContextState(state)) {
        state = await this.setup.resume(signal);
      }
    }
    this.configureAsanaFromSettings(this.database.getDeviceSettings());
    this.configureContextFromState(state);
    if (state.kind === "ready") {
      await this.activateReadyApplication(signal);
    }
    return this.getState();
  }

  /** Electron終了時に全サービスを停止します。 */
  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    const errors: unknown[] = [];
    this.removeRuntimeSubscription?.();
    this.removeRuntimeSubscription = undefined;
    this.syncStateListeners.clear();
    this.aiStatusListeners.clear();
    try {
      this.aiWorkflow?.dispose();
    } catch (error: unknown) {
      errors.push(error);
    }
    await this.stopAsyncService(this.displayOrder, errors);
    await this.stopAsyncService(this.runtime, errors);
    if (this.externalIntegrationState.kind === "ready") {
      await this.stopAsyncService(this.externalIntegrationState.broker, errors);
    }
    await this.stopAsyncService(this.codexSession, errors);
    try {
      this.recordDiagnostic("app.stop", "info");
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.database.close();
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "アプリケーションの停止に失敗しました。");
    }
  }

  /** IPCへ公開するアプリケーションサービスのポートを取得します。 */
  public getIpcPorts(): IpcServicePorts {
    return {
      asana: this.createAsanaPort(),
      readModel: this.createReadModelPort(),
      sync: this.createSyncPort(),
      setup: this.createSetupPort(),
      gui: this.createGuiPort(),
      ai: this.createAiPort(),
      obsidian: this.createObsidianPort(),
    };
  }

  /** Electronのフォアグラウンド復帰を同期へ渡します。 */
  public async onForeground(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    this.assertOperationalReady();
    const runtime = this.requireRuntime();
    const result = await this.requireSynchronizedResult(runtime.onForeground(signal));
    await this.afterSynchronizedState(result, signal);
    await this.verifyConfiguredCodexCapabilities(signal);
  }

  /** Electronのオンライン復帰を同期へ渡します。 */
  public async onOnline(): Promise<void> {
    this.assertOperationalReady();
    const runtime = this.requireRuntime();
    let result: AsanaSyncRuntimeResult;
    try {
      result = await runtime.onOnline(this.options.lifecycle_signal);
    } catch (error: unknown) {
      this.recordDiagnostic("sync.failed", "error");
      throw error;
    }
    if (result.kind === "synchronized") {
      await this.afterSynchronizedState(result, this.options.lifecycle_signal);
      await this.verifyConfiguredCodexCapabilities(this.options.lifecycle_signal);
      return;
    }
    if (result.kind === "failed") {
      return;
    }
    if (result.kind === "aborted") {
      throw new Error("Asana同期が中断されました。");
    }
    throw new Error(
      result.reason === "offline"
        ? "オフライン中はAsana同期を実行できません。"
        : "停止済みのAsana同期ランタイムは実行できません。",
    );
  }

  /** ネットワーク状態を同期ランタイムへ渡します。 */
  public setOnline(online: boolean): void {
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態は真偽値で指定してください。");
    }
    const runtime = this.runtime;
    if (runtime == null) {
      return;
    }
    runtime.setOnline(online);
  }

  /** 保存済み認証情報でAsana OAuthを再認証して同期を再開します。 */
  public async reauthenticateAsanaOAuth(
    signal: AbortSignal,
  ): Promise<IpcSyncResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    this.assertOperationalReady();
    const storedSettings = this.database.getDeviceSettings();
    if (storedSettings == null) {
      throw new Error("設定済みAsana OAuthの端末設定がありません。");
    }
    const settings = deviceSettingsSchema.parse(storedSettings);
    if (!contextMatchesSettings(this.requireContext(), settings)) {
      throw new Error("設定済み文脈と端末設定が一致しません。");
    }
    const authentication = asanaOAuthCoordinatorResultSchema.parse(
      await this.oauth.reauthenticate(
        {
          client_id: settings.client_id,
          redirect_uri: this.options.redirect_uri,
          timeout_milliseconds: asanaOAuthReauthenticationTimeoutMilliseconds,
        },
        signal,
      ),
    );
    if (authentication.client_id !== settings.client_id) {
      throw new Error("Asana OAuth再認証結果のClient IDが一致しません。");
    }
    throwIfAborted(signal);
    this.configureAsanaFromSettings(settings);
    const synchronized = await this.requireSynchronizedResult(
      this.requireRuntime().onOnline(signal),
    );
    await this.afterSynchronizedState(synchronized, signal);
    await this.verifyConfiguredCodexCapabilities(signal);
    return toIpcSyncResult(synchronized.result);
  }

  private resolveDeviceId(): string {
    const settings = this.database.getDeviceSettings();
    if (settings != null) {
      return deviceSettingsSchema.parse(settings).device_id;
    }
    const checkpointState = this.checkpoint.load();
    if (checkpointState != null) {
      const context = contextFromState(setupStateSchema.parse(checkpointState));
      if (context != null) {
        return identifierSchema.parse(context.device_id);
      }
    }
    return identifierSchema.parse(randomUUID());
  }

  private configureAsanaFromSettings(
    settings: DeviceSettings | undefined,
  ): void {
    if (settings == null) {
      this.settings = undefined;
      return;
    }
    const validatedSettings = deviceSettingsSchema.parse(settings);
    this.settings = validatedSettings;
    this.tokenProvider.setProvider(
      new AsanaOAuthClient(
        validatedSettings.client_id,
        this.options.redirect_uri,
        this.secretStorage,
      ),
    );
  }

  private readOnlyVaultPaths(): readonly string[] {
    const paths = new Set<string>(this.options.read_only_vault_paths);
    for (const mapping of this.database.getVaultMappings()) {
      const validatedMapping = mapping;
      paths.add(validatedMapping.absolute_path);
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  }

  private updateCodexVaultPaths(): void {
    const state = this.codexSession.getState();
    if (
      state !== "created"
      && state !== "authentication_required"
      && state !== "ready"
    ) {
      return;
    }
    this.codexSession.setReadOnlyVaultPaths(this.readOnlyVaultPaths());
  }

  private configureContextFromState(state: SetupState): void {
    const validatedState = setupStateSchema.parse(state);
    const context = contextFromState(validatedState);
    this.context = context;
    this.codexAvailability = codexAvailabilityFromState(validatedState);
    const settings = this.database.getDeviceSettings();
    this.configureAsanaFromSettings(settings);
    if (settings == null) {
      const clientId = clientIdFromState(validatedState);
      if (clientId != null) {
        this.tokenProvider.setProvider(
          new AsanaOAuthClient(
            clientId,
            this.options.redirect_uri,
            this.secretStorage,
          ),
        );
      }
    }
    if (context != null && settings != null && validatedState.kind === "ready") {
      const validatedSettings = deviceSettingsSchema.parse(settings);
      if (!contextMatchesSettings(context, validatedSettings)) {
        throw new Error("設定済み文脈と端末設定が一致しません。");
      }
    }
    this.updateCodexVaultPaths();
  }

  private configureOperationalServices(): void {
    this.assertSetupReady();
    const context = this.requireContext();
    const settings = this.settings;
    if (settings == null || !contextMatchesSettings(context, settings)) {
      throw new Error("設定済み文脈と端末設定が一致しません。");
    }
    const fullyConfigured = this.runtime != null
      && this.displayOrder != null
      && this.writer != null
      && this.applicationCoordinator != null
      && this.guiEdit != null
      && this.aiWorkflow != null;
    if (fullyConfigured) {
      return;
    }
    if (
      this.runtime != null
      || this.displayOrder != null
      || this.writer != null
      || this.applicationCoordinator != null
      || this.guiEdit != null
      || this.aiWorkflow != null
    ) {
      throw new Error("運用サービスの構成状態が一貫していません。");
    }
    const online = this.options.online_provider();
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態関数は真偽値を返してください。");
    }
    const runtime = new AsanaSyncRuntime(
      this.syncCoordinator,
      this.database,
      {
        project_gid: context.project_gid,
        section_gids: context.section_gids,
        device_id: context.device_id,
        app_version: this.options.app_version,
        initial_online: online,
      },
      this.options.lifecycle_signal,
      (signal) => this.beforeAsanaSynchronization(signal),
      (error) => this.notifyUnexpectedError(error, "sync"),
      () => createNowIso(this.options.now_provider),
    );
    const removeRuntimeSubscription = runtime.subscribe((runtimeState) => {
      this.handleRuntimeState(runtimeState);
    });
    const displayOrder = createAsanaDisplayOrderService(
      this.transport,
      (error) => this.notifyUnexpectedError(error, "display_order"),
      this.options.lifecycle_signal,
    );
    const writer = new AsanaProposalOperationWriter(
      this.interactiveReadClient,
      this.interactiveWriteClient,
    );
    const applicationCoordinator = new AsanaProposalApplicationCoordinator(
      this.interactiveReadClient,
      writer,
      this.database,
      randomUUID,
      () => createNowIso(this.options.now_provider),
      (signal) => this.afterAiApply(signal),
    );
    const guiEdit = new AsanaGuiEditService(
      writer,
      (signal) => this.afterGuiEdit(signal),
      () => this.isOnline(),
      (request, signal) => this.validateRelationGraph(request, signal),
      {
        getTask: (taskGid, signal) =>
          this.interactiveReadClient.getTask(taskGid, signal),
      },
      {
        addTaskToProject: (taskGid, projectGid, sectionGid, position, signal) =>
          this.interactiveWriteClient.addTaskToProject(
            taskGid,
            projectGid,
            sectionGid,
            position,
            signal,
          ),
        addTaskToSection: (taskGid, sectionGid, position, signal) =>
          this.interactiveWriteClient.addTaskToSection(
            taskGid,
            sectionGid,
            position,
            signal,
          ),
        updateTask: (taskGid, update, signal) =>
          this.interactiveWriteClient.updateTask(taskGid, update, signal),
      },
      randomUUID,
    );
    const aiWorkflow = new AiWorkflowService({
      session: this.codexSession,
      snapshotProvider: (signal) => this.createAiSnapshot(signal),
      taskctlSnapshotProvider: () => this.createTaskctlSnapshot(),
      externalStatusEvidenceCollector: this.externalStatusEvidenceCollector,
      applicationCoordinator: {
        apply: async (input, signal) => {
          if (this.aiApplicationState !== "idle") {
            throw new Error("AI変更案を同時に適用できません。");
          }
          this.aiApplicationState = "applying";
          let result: AsanaProposalApplicationResult;
          try {
            result = await applicationCoordinator.apply(input, signal);
          } finally {
            this.aiApplicationState = "idle";
          }
          this.cleanupAggregation.replaceProposalConflictsFromApplication(result);
          this.diagnostics.record({
            code: "proposal.application",
            severity: "info",
            proposal_id: result.proposal_id,
          });
          return result;
        },
      },
      prepareApprovalInput: (input, signal) =>
        this.prepareApprovalInput(input, signal),
      isOnline: () => this.isOnline(),
    });
    this.runtime = runtime;
    this.removeRuntimeSubscription = removeRuntimeSubscription;
    this.displayOrder = displayOrder;
    this.writer = writer;
    this.applicationCoordinator = applicationCoordinator;
    this.guiEdit = guiEdit;
    this.aiWorkflow = aiWorkflow;
  }

  private rethrowFeatureAbort(error: unknown, signal: AbortSignal): void {
    if (
      signal.aborted
      || this.options.lifecycle_signal.aborted
      || error instanceof CodexSessionAbortedError
      || (error instanceof ExternalToolError && error.code === "aborted")
    ) {
      throw error;
    }
  }

  private recordFeatureFailure(
    error: unknown,
    channel: string,
    message: string,
  ): void {
    this.recordDiagnostic(diagnosticCodeForChannel(channel), "warning");
    this.options.diagnostic(new Error(message, { cause: error }), channel);
  }

  private async detectCodexSafely(
    signal: AbortSignal,
  ): Promise<SetupCodexAvailability> {
    let availability: SetupCodexAvailability;
    try {
      availability = setupCodexAvailabilitySchema.parse(
        await this.codexAdapter.detectCli(signal),
      );
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      this.recordFeatureFailure(
        error,
        "codex",
        "Codex CLIの検査に失敗したためAI機能を無効にしました。",
      );
      return setupCodexAvailabilitySchema.parse({
        kind: "unavailable",
        reason_code: "startup_failed",
      });
    }
    if (availability.kind === "unavailable") {
      this.recordFeatureFailure(
        availability,
        "codex",
        "Codex CLIを利用できないためAI機能を無効にしました。",
      );
    }
    return availability;
  }

  private async getCodexAuthenticationStateSafely(
    signal: AbortSignal,
  ): Promise<CodexAuthenticationState> {
    let state: CodexAuthenticationState;
    try {
      state = codexAuthenticationStateSchema.parse(
        await this.codexAdapter.getAuthenticationState(signal),
      );
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      this.recordFeatureFailure(
        error,
        "codex",
        "Codex認証状態の検査に失敗したためAI機能を無効にしました。",
      );
      return codexAuthenticationStateSchema.parse({
        kind: "unavailable",
        reason_code: "startup_failed",
      });
    }
    if (state.kind === "unavailable") {
      this.recordFeatureFailure(
        state,
        "codex",
        "Codex認証状態を利用できないためAI機能を無効にしました。",
      );
    }
    return state;
  }

  private async completeCodexAuthenticationSafely(
    signal: AbortSignal,
  ): Promise<SetupCodexAvailability> {
    let availability: SetupCodexAvailability;
    try {
      availability = setupCodexAvailabilitySchema.parse(
        await this.codexAdapter.completeAuthentication(signal),
      );
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      this.recordFeatureFailure(
        error,
        "codex",
        "Codex再認証に失敗したためAI機能を無効にしました。",
      );
      return setupCodexAvailabilitySchema.parse({
        kind: "unavailable",
        reason_code: "startup_failed",
      });
    }
    if (availability.kind === "unavailable") {
      this.recordFeatureFailure(
        availability,
        "codex",
        "Codex再認証を完了できないためAI機能を無効にしました。",
      );
    }
    return availability;
  }

  private async checkCodexCapabilitiesSafely(
    signal: AbortSignal,
  ): Promise<SetupCodexAvailability> {
    let availability: SetupCodexAvailability;
    try {
      availability = setupCodexAvailabilitySchema.parse(
        await this.codexAdapter.checkCapabilities(signal),
      );
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      this.recordFeatureFailure(
        error,
        "codex",
        "Codex能力検査に失敗したためAI機能を無効にしました。",
      );
      return setupCodexAvailabilitySchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
    }
    if (availability.kind === "unavailable") {
      this.recordFeatureFailure(
        availability,
        "codex",
        "Codex能力検査を完了できないためAI機能を無効にしました。",
      );
    }
    return availability;
  }

  private async restorePersistedCodexSession(
    state: SetupState,
    signal: AbortSignal,
  ): Promise<void> {
    const availability = codexAvailabilityFromState(setupStateSchema.parse(state));
    this.codexAvailability = availability;
    if (availability == null || availability.kind === "unavailable") {
      return;
    }
    const detected = await this.detectCodexSafely(signal);
    this.codexAvailability = detected;
    if (detected.kind === "unavailable") {
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      return;
    }
    const authentication = await this.getCodexAuthenticationStateSafely(signal);
    if (authentication.kind === "unavailable") {
      this.codexAvailability = authentication;
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      return;
    }
    this.aiStartResult = this.codexAdapter.getStartResult();
    this.codexAuthenticationRequired = authentication.kind === "required";
  }

  private notifyUnexpectedError(error: unknown, channel: string): void {
    this.recordDiagnostic(diagnosticCodeForChannel(channel), "error");
    try {
      this.options.notify_unexpected_error(
        new Error("予期しないエラーが発生しました。"),
      );
    } catch (notificationError: unknown) {
      this.options.diagnostic(
        new AggregateError(
          [error, notificationError],
          "予期しないエラーの通知にも失敗しました。",
          { cause: error },
        ),
        channel,
      );
    }
  }

  private isOnline(): boolean {
    const online = this.options.online_provider();
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態関数は真偽値を返してください。");
    }
    return online;
  }

  private async runSetupFullSync(
    input: SetupFullSyncInput,
    signal: AbortSignal,
  ): Promise<void> {
    validateAbortSignal(signal);
    const validatedInput = setupFullSyncInputSchema.parse(input);
    this.configureContextFromState(this.setup.getState());
    this.recordDiagnostic("sync.started", "info");
    try {
      const result = await this.syncCoordinator.coordinate(
        {
          mode: "full",
          project_gid: validatedInput.project_gid,
          section_gids: validatedInput.section_gids,
          device_id: validatedInput.device_id,
          app_version: this.options.app_version,
        },
        signal,
      );
      if (result.performed_mode !== "full") {
        throw new Error("初回設定のフル同期が完全同期を返しませんでした。");
      }
      await this.afterLocalStateRefresh(signal);
    } catch (error: unknown) {
      if (!signal.aborted) {
        this.recordDiagnostic("sync.failed", "error");
      }
      throw error;
    }
    this.recordDiagnostic("sync.completed", "info");
  }

  private assertSetupReady(): void {
    if (this.setup.getState().kind !== "ready") {
      throw new Error("初回設定が完了するまで運用機能を利用できません。");
    }
  }

  private assertOperationalReady(): void {
    this.assertSetupReady();
    if (!this.readyActivated) {
      throw new Error("運用機能の起動が完了していません。");
    }
  }

  private requireRuntime(): AsanaSyncRuntime {
    const runtime = this.runtime;
    if (runtime == null) {
      throw new Error("Asana同期ランタイムが設定されていません。");
    }
    return runtime;
  }

  private requireContext(): OperationalContext {
    const context = this.context;
    if (context == null) {
      throw new Error("Asana設定の文脈がありません。");
    }
    return context;
  }

  private requireWriter(): AsanaProposalOperationWriter {
    const writer = this.writer;
    if (writer == null) {
      throw new Error("Asana変更操作ライターが設定されていません。");
    }
    return writer;
  }

  private requireApplicationCoordinator(): AsanaProposalApplicationCoordinator {
    const coordinator = this.applicationCoordinator;
    if (coordinator == null) {
      throw new Error("Asana変更適用コーディネータが設定されていません。");
    }
    return coordinator;
  }

  private async beforeAsanaSynchronization(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    if (this.aiApplicationState === "synchronizing") {
      return;
    }
    if (this.aiApplicationState === "applying") {
      throw new Error("AI変更案の適用完了前に別の同期を開始できません。");
    }
    await this.recoverApplicationJournal(signal);
    throwIfAborted(signal);
    if (
      this.journalRecoveryPending
      || this.database.getIncompleteApplicationJournals().length > 0
    ) {
      throw new Error("未完了のAI適用ジャーナルを復旧するまで同期を開始できません。");
    }
  }

  private async stopAsyncService(
    service: { stop(): Promise<void> } | undefined,
    errors: unknown[],
  ): Promise<void> {
    if (service == null) {
      return;
    }
    try {
      await service.stop();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  private async activateReadyApplication(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    if (this.readyActivated) {
      return;
    }
    this.configureOperationalServices();
    const runtime = this.requireRuntime();
    const startedOffline = runtime.getState().kind === "offline";
    let synchronizationDeferred = startedOffline;
    if (!synchronizationDeferred) {
      try {
        await this.recoverApplicationJournal(signal);
      } catch (error: unknown) {
        this.rethrowFeatureAbort(error, signal);
        this.recordFeatureFailure(
          error,
          "application_journal",
          "未完了のAI適用ジャーナルを起動同期前に復旧できませんでした。",
        );
        runtime.deferSynchronizationUntilRecovery();
        synchronizationDeferred = true;
      }
    }
    await this.startExternalTools(signal);
    if (!startedOffline) {
      await this.startCodexForConfigured(signal);
    }
    if (!synchronizationDeferred) {
      const runtimeResult = await runtime.start(signal);
      if (runtimeResult.kind === "synchronized") {
        await this.afterSynchronizedState(runtimeResult, signal);
        await this.verifyConfiguredCodexCapabilities(signal);
      } else if (runtimeResult.kind === "aborted") {
        throw new Error("設定済みアプリケーションの起動同期が中断されました。");
      } else if (
        runtimeResult.kind === "rejected"
        && runtimeResult.reason === "stopped"
      ) {
        throw new Error("停止済みのAsana同期ランタイムは起動できません。");
      }
    }
    this.readyActivated = true;
  }

  private async startCodexForConfigured(signal: AbortSignal): Promise<void> {
    const configuredAvailability = this.requireContext().codex;
    if (configuredAvailability.kind === "unavailable") {
      this.codexAvailability = configuredAvailability;
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      this.publishAiStatus();
      return;
    }
    this.publishAiStatus();
    const detected = await this.detectCodexSafely(signal);
    this.codexAvailability = detected;
    if (detected.kind === "unavailable") {
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      this.publishAiStatus();
      return;
    }
    const authentication = await this.getCodexAuthenticationStateSafely(signal);
    if (authentication.kind === "unavailable") {
      this.codexAvailability = authentication;
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      this.publishAiStatus();
      return;
    }
    this.codexAuthenticationRequired = authentication.kind === "required";
    this.aiStartResult = this.codexAdapter.getStartResult();
    this.publishAiStatus();
  }

  private async verifyConfiguredCodexCapabilities(signal: AbortSignal): Promise<void> {
    if (!isReadyCodexResult(this.aiStartResult) || this.codexAuthenticationRequired) {
      return;
    }
    const availability = await this.checkCodexCapabilitiesSafely(signal);
    this.codexAvailability = availability;
    this.publishAiStatus();
  }

  private async recoverApplicationJournal(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const runningRecovery = this.journalRecoveryPromise;
    if (runningRecovery != null) {
      await runningRecovery;
      throwIfAborted(signal);
      return;
    }
    const recovery = this.performApplicationJournalRecovery(signal);
    this.journalRecoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this.journalRecoveryPromise === recovery) {
        this.journalRecoveryPromise = undefined;
      }
    }
  }

  private async performApplicationJournalRecovery(
    signal: AbortSignal,
  ): Promise<void> {
    const incomplete = this.database.getIncompleteApplicationJournals();
    if (!this.journalRecoveryPending && incomplete.length === 0) {
      return;
    }
    this.journalRecoveryPending = true;
    this.journalRecoveryRunning = true;
    try {
      const result = await this.requireApplicationCoordinator().recover(
        {
          applications: [],
          project_gids: [this.requireContext().project_gid],
        },
        signal,
      );
      await this.afterJournalRecovery(result, signal);
      const remainingJournals = this.database.getIncompleteApplicationJournals();
      if (remainingJournals.length > 0) {
        throw new Error(
          "復旧結果に含まれない未完了のAI適用ジャーナルが残っています。",
        );
      }
      this.journalRecoveryPending = false;
      if (result.unresolved_journals.length > 0) {
        this.recordFeatureFailure(
          result.unresolved_journals,
          "application_journal",
          "未完了のAI適用ジャーナルを自動復旧できませんでした。",
        );
      }
    } finally {
      this.journalRecoveryRunning = false;
    }
  }

  private afterJournalRecovery(
    result: AsanaProposalRecoveryResult,
    signal: AbortSignal,
  ): Promise<void> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    this.cleanupAggregation.replaceProposalConflictsFromRecovery(result);
    return Promise.resolve();
  }

  private async requireSynchronizedResult(
    resultPromise: Promise<AsanaSyncRuntimeResult>,
  ): Promise<Extract<AsanaSyncRuntimeResult, { kind: "synchronized" }>> {
    let result: AsanaSyncRuntimeResult;
    try {
      result = await resultPromise;
    } catch (error: unknown) {
      this.recordDiagnostic("sync.failed", "error");
      throw error;
    }
    if (result.kind === "synchronized") {
      return result;
    }
    if (result.kind === "rejected") {
      this.recordDiagnostic("sync.failed", "warning");
      throw new Error(
        result.reason === "offline"
          ? "オフライン中はAsana同期を実行できません。"
          : "停止済みのAsana同期ランタイムは実行できません。",
      );
    }
    if (result.kind === "aborted") {
      throw new Error("Asana同期が中断されました。");
    }
    throw new Error(`Asana同期に失敗しました。エラーコード: ${result.error_code}`);
  }

  private async afterSynchronizedState(
    result: Extract<AsanaSyncRuntimeResult, { kind: "synchronized" }>,
    signal: AbortSignal,
  ): Promise<void> {
    void result;
    await this.recoverApplicationJournal(signal);
    await this.afterLocalStateRefresh(signal);
  }

  private afterGuiEdit(
    signal: AbortSignal,
  ): Promise<PostWriteSynchronizationResult> {
    return this.resolvePostWriteSynchronization(
      this.requireRuntime().afterGuiEdit(signal),
      signal,
    );
  }

  private async afterAiApply(
    signal: AbortSignal,
  ): Promise<PostWriteSynchronizationResult> {
    if (this.journalRecoveryRunning) {
      return this.synchronizeRecoveredApplicationJournals(signal);
    }
    if (this.aiApplicationState !== "applying") {
      throw new Error("AI変更案の適用状態が同期開始条件を満たしません。");
    }
    this.aiApplicationState = "synchronizing";
    try {
      return await this.resolvePostWriteSynchronization(
        this.requireRuntime().afterAiApply(signal),
        signal,
      );
    } finally {
      this.aiApplicationState = "applying";
    }
  }

  private async synchronizeRecoveredApplicationJournals(
    signal: AbortSignal,
  ): Promise<PostWriteSynchronizationResult> {
    const context = this.requireContext();
    try {
      await this.syncCoordinator.coordinate(
        {
          mode: "delta",
          project_gid: context.project_gid,
          section_gids: context.section_gids,
          device_id: context.device_id,
          app_version: this.options.app_version,
        },
        signal,
      );
    } catch (error: unknown) {
      if (signal.aborted) {
        return postWriteRecoveryRequired("aborted");
      }
      const classification = classifyPostWriteSynchronizationError(error);
      if (classification.kind === "recovery_required") {
        return postWriteRecoveryRequired(classification.error_code);
      }
      throw new Error("AI適用ジャーナル復旧後の同期に失敗しました。", {
        cause: error,
      });
    }
    const synchronization = asanaPostWriteSynchronizationResultSchema.parse({
      kind: "synchronized",
    });
    await this.refreshAuxiliaryStateAfterPostWrite(signal);
    return synchronization;
  }

  private async resolvePostWriteSynchronization(
    resultPromise: Promise<AsanaSyncRuntimeResult>,
    signal: AbortSignal,
  ): Promise<PostWriteSynchronizationResult> {
    let runtimeResult: AsanaSyncRuntimeResult;
    try {
      runtimeResult = await resultPromise;
    } catch (error: unknown) {
      if (signal.aborted) {
        return postWriteRecoveryRequired("aborted");
      }
      const classification = classifyPostWriteSynchronizationError(error);
      if (classification.kind === "recovery_required") {
        return postWriteRecoveryRequired(classification.error_code);
      }
      throw new Error("書き込み後の同期で想定外エラーが発生しました。", {
        cause: error,
      });
    }
    const synchronization = postWriteSynchronizationFromRuntimeResult(runtimeResult);
    if (synchronization.kind === "recovery_required") {
      return synchronization;
    }
    await this.refreshAuxiliaryStateAfterPostWrite(signal);
    return synchronization;
  }

  private async refreshAuxiliaryStateAfterPostWrite(
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.afterLocalStateRefresh(signal);
    } catch (error: unknown) {
      this.recordFeatureFailure(
        error,
        "local_state_refresh",
        "Asana同期後の補助的なローカル状態更新に失敗しました。",
      );
    }
  }

  private async requireSynchronizedBeforeAi(signal: AbortSignal): Promise<void> {
    const result = await this.requireSynchronizedResult(
      this.requireRuntime().beforeAiTurn(signal),
    );
    void result;
    await this.afterLocalStateRefresh(signal);
  }

  private recordSyncStateDiagnostic(state: AsanaSyncRuntimeState): void {
    const diagnosticState = this.syncDiagnosticState;
    if (state.kind === "syncing") {
      if (diagnosticState.kind === "idle") {
        this.recordDiagnostic("sync.started", "info");
        this.syncDiagnosticState = {
          kind: "running",
          previous_success_at: state.last_successful_sync_at,
        };
      }
      return;
    }
    if (diagnosticState.kind === "idle") {
      return;
    }
    this.syncDiagnosticState = { kind: "idle" };
    if (
      state.kind === "online"
      && state.last_successful_sync_at != null
      && state.last_successful_sync_at !== diagnosticState.previous_success_at
    ) {
      this.recordDiagnostic("sync.completed", "info");
      return;
    }
    if (
      state.kind === "authentication_required"
      || (state.kind === "error" && state.error_code !== "unexpected_error")
    ) {
      this.recordDiagnostic("sync.failed", "error");
    }
  }

  private handleRuntimeState(state: AsanaSyncRuntimeState): void {
    const ipcState = toIpcSyncState(state);
    for (const listener of this.syncStateListeners) {
      try {
        listener(ipcState);
      } catch (error: unknown) {
        this.recordDiagnostic("ipc.error", "error");
        this.options.diagnostic(error, "sync_state_listener");
      }
    }
    this.recordSyncStateDiagnostic(state);
    if (
      state.last_successful_sync_at == null
      || state.last_successful_sync_at === this.lastDisplaySyncAt
      || this.options.lifecycle_signal.aborted
    ) {
      return;
    }
    this.lastDisplaySyncAt = state.last_successful_sync_at;
    void this.afterLocalStateRefresh(this.options.lifecycle_signal).catch(
      (error: unknown) => this.notifyUnexpectedError(error, "display_order"),
    );
  }

  private async afterLocalStateRefresh(signal: AbortSignal): Promise<void> {
    const tasks = parseTaskCache(this.database.getTaskCache())
      .map((entry) => taskSchema.parse(entry.task));
    await this.cleanupAggregation.replaceBrokenVaultLinksFromTasks(
      tasks,
      signal,
    );
    signal.throwIfAborted();
    const displayOrder = this.displayOrder;
    if (displayOrder == null) {
      return;
    }
    let input: AsanaDisplayOrderInput;
    try {
      input = await this.createDisplayOrderInput(signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        signal.throwIfAborted();
      }
      this.notifyUnexpectedError(error, "display_order");
      return;
    }
    void displayOrder.request(input, signal).catch((error: unknown) => {
      this.notifyUnexpectedError(error, "display_order");
    });
  }

  private async createDisplayOrderInput(
    signal: AbortSignal,
  ): Promise<AsanaDisplayOrderInput> {
    const context = this.requireContext();
    const tasks = await this.readClient.listProjectTasks(context.project_gid, signal);
    const notStartedOrder: string[] = [];
    const inProgressOrder: string[] = [];
    const currentOrder = {
      not_started: notStartedOrder,
      in_progress: inProgressOrder,
    };
    const activeGids = new Set<string>();
    for (const task of tasks) {
      const memberships = task.memberships.filter(
        (membership) => membership.project.gid === context.project_gid,
      );
      if (memberships.length !== 1) {
        continue;
      }
      const sectionGid = memberships[0]?.section?.gid;
      if (sectionGid == null) {
        continue;
      }
      if (sectionGid === context.section_gids.not_started) {
        currentOrder.not_started.push(task.gid);
        activeGids.add(task.gid);
      } else if (sectionGid === context.section_gids.in_progress) {
        currentOrder.in_progress.push(task.gid);
        activeGids.add(task.gid);
      }
    }
    const ranking = this.database.getRankingCache()?.ranked_tasks
      .map((task) => task.gid)
      .filter((gid) => activeGids.has(gid)) ?? [];
    return asanaDisplayOrderInputSchema.parse({
      project_gid: context.project_gid,
      section_gids: {
        not_started: context.section_gids.not_started,
        in_progress: context.section_gids.in_progress,
      },
      current_order: currentOrder,
      ranking,
    });
  }

  private async startExternalTools(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    if (this.externalIntegrationState.kind !== "not_started") {
      return;
    }
    const records = this.database.getExternalToolDefinitions();
    const hasCredentialReferences = records.some(
      (record) => record.credential_reference_names.length > 0,
    );
    const definitionsEnabled = !hasCredentialReferences && records.length > 0;
    let connectionInfoPath = join(
      this.codexWorkspace.tmpDirectoryPath,
      "contextctl-connection.json",
    );
    let socketPaths: readonly string[] = [];
    let toolDefinitions: readonly ExternalToolDefinition[] = [];
    if (definitionsEnabled) {
      let startupFailure: {
        readonly error: unknown;
        readonly message: string;
      } | undefined;
      try {
        const broker = new ExternalToolBroker({
          tmp_directory_path: this.codexWorkspace.tmpDirectoryPath,
          child_work_root_path: this.externalWorkRoot,
          registry: this.externalRegistry,
          status_evidence_collector: this.externalStatusEvidenceCollector,
        });
        const result = await broker.start(this.options.lifecycle_signal);
        throwIfAborted(signal);
        if (result.kind === "ready") {
          connectionInfoPath = result.connection_info_path;
          socketPaths = [result.endpoint];
          toolDefinitions = this.externalRegistry.list();
          this.externalIntegrationState = {
            kind: "ready",
            broker,
          };
        } else {
          this.externalIntegrationState = { kind: "disabled" };
          startupFailure = {
            error: result,
            message: "外部ツールIPCを安全に開始できないため外部連携を無効にしました。",
          };
        }
      } catch (error: unknown) {
        this.rethrowFeatureAbort(error, signal);
        this.externalIntegrationState = { kind: "disabled" };
        startupFailure = {
          error,
          message: "外部ツールブローカーの起動に失敗したため外部連携を無効にしました。",
        };
      }
      if (startupFailure != null) {
        this.recordFeatureFailure(
          startupFailure.error,
          "external_tools",
          startupFailure.message,
        );
      }
    } else if (hasCredentialReferences) {
      this.externalIntegrationState = { kind: "disabled" };
      this.recordFeatureFailure(
        new Error("外部ツール定義に資格情報参照が含まれています。"),
        "external_tools",
        "資格情報を必要とする外部ツールは現在の安全境界では利用できません。",
      );
    } else {
      this.externalIntegrationState = { kind: "disabled" };
    }
    try {
      const sessionState = this.codexSession.getState();
      if (
        sessionState === "created"
        || sessionState === "authentication_required"
        || sessionState === "ready"
      ) {
        this.codexSession.requireThreadConfigurationRefresh();
        this.codexSession.setAdditionalLocalSocketPaths(socketPaths);
      }
      installContextctlClientScript({
        workspacePath: this.codexWorkspace.workspacePath,
        connectionInfoPath,
        toolDefinitions: [...toolDefinitions],
      });
      if (sessionState === "ready") {
        this.aiStartResult = await this.codexSession.startNewSession(signal);
        this.codexAuthenticationRequired = false;
      }
      this.publishAiStatus();
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      this.codexAvailability = setupCodexAvailabilitySchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
      this.recordFeatureFailure(
        error,
        "codex",
        "外部ツール用Codex構成を安全に更新できないためAI機能を無効にしました。",
      );
      this.publishAiStatus();
    }
  }

  private createTaskctlSnapshot(): TaskctlSnapshot {
    const context = this.context;
    const entries = parseTaskCache(this.database.getTaskCache());
    const tasks = entries
      .map((entry) => taskSchema.parse(entry.task))
      .sort((left, right) => compareStrings(left.gid, right.gid));
    const syncState = context == null
      ? undefined
      : this.database.getSyncState(context.project_gid);
    const ranking = this.database.getRankingCache();
    return taskctlSnapshotSchema.parse({
      sync: syncState?.last_successful_sync_at == null
        ? { kind: "unavailable" }
        : { kind: "synced", synced_at: syncState.last_successful_sync_at },
      tasks,
      ranking: ranking == null
        ? { kind: "unavailable" }
        : { kind: "available", cache: ranking },
    });
  }

  private createAiSnapshot(signal: AbortSignal): AiWorkflowSnapshot {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const context = this.requireContext();
    const syncState = this.database.getSyncState(context.project_gid);
    if (syncState?.last_successful_sync_at == null) {
      throw new Error("AIターンに必要な同期済み時刻がありません。");
    }
    const metadata = this.database.getProjectMetadataCache(context.project_gid);
    if (metadata == null) {
      throw new Error("AIターンに必要なAsanaメタデータがありません。");
    }
    const entries = parseTaskCache(this.database.getTaskCache());
    const tasks = entries
      .map((entry) => taskSchema.parse(entry.task))
      .sort((left, right) => compareStrings(left.gid, right.gid));
    const areas = new Set<string>(["未分類"]);
    for (const tag of metadata.tags) {
      if (!tag.name.startsWith("TaskHub/領域/")) {
        continue;
      }
      const area = tag.name.slice("TaskHub/領域/".length);
      if (area.trim().length > 0) {
        areas.add(area);
      }
    }
    const asOf = createNowIso(this.options.now_provider);
    const snapshot = aiWorkflowSnapshotSchema.parse({
      app_version: this.options.app_version,
      project_gid: context.project_gid,
      synced_at: syncState.last_successful_sync_at,
      as_of: asOf,
      tasks,
      areas: [...areas].sort(compareStrings),
    });
    const baselineExternalData: BaselineExternalData = entries
      .filter((entry) => externalDataIsValid(entry.asana_response))
      .map((entry) => {
        const external = entry.asana_response.external;
        if (external == null) {
          throw new Error("検証済みのCustom external dataを取得できません。");
        }
        return {
          task_gid: entry.gid,
          external: { gid: external.gid, data: external.data },
        };
      })
      .sort((left, right) => compareStrings(left.task_gid, right.task_gid));
    this.baselineExternalData.set(
      canonicalizeJson(createBaselineSnapshot(snapshot)),
      baselineExternalData,
    );
    while (this.baselineExternalData.size > 32) {
      const oldest = this.baselineExternalData.keys().next().value;
      if (oldest == null) {
        throw new Error("AI基準外部データの保持状態が不正です。");
      }
      this.baselineExternalData.delete(oldest);
    }
    return snapshot;
  }

  private proposalIdFor(input: ApprovalPreparationInput): string {
    const operationIds = input.proposal.groups.flatMap((group) =>
      group.operations.map((operation) => operation.operation_id));
    const proposalIds = new Set<string>();
    for (const operationId of operationIds) {
      const proposalId = this.proposalIds.get(operationId);
      if (proposalId == null) {
        throw new Error("AI変更案の操作IDに対応する適用IDがありません。");
      }
      proposalIds.add(proposalId);
    }
    if (proposalIds.size !== 1) {
      throw new Error("AI変更案の適用IDを一意に取得できません。");
    }
    const proposalId = proposalIds.values().next().value;
    if (proposalId == null) {
      throw new Error("AI変更案の適用IDを取得できません。");
    }
    return identifierSchema.parse(proposalId);
  }

  private async collectApprovalProjectTasks(
    projectGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaTaskResponse[]> {
    const validatedProjectGid = gidSchema.parse(projectGid);
    const projectTasks = await this.interactiveReadClient.listProjectTasks(
      validatedProjectGid,
      signal,
    );
    const tasks = new Map<string, AsanaTaskResponse>();
    const pendingTaskGids: string[] = [];
    const queuedTaskGids = new Set<string>();
    const expandedTaskGids = new Set<string>();
    for (const task of projectTasks) {
      mergeApprovalTaskResponse(tasks, task);
      if (!queuedTaskGids.has(task.gid)) {
        queuedTaskGids.add(task.gid);
        pendingTaskGids.push(task.gid);
      }
    }
    while (pendingTaskGids.length > 0) {
      signal.throwIfAborted();
      const taskGid = pendingTaskGids.shift();
      if (taskGid == null) {
        throw new Error("承認前再取得の探索キューを進行できません。");
      }
      if (expandedTaskGids.has(taskGid)) {
        continue;
      }
      const task = tasks.get(taskGid);
      if (task == null) {
        throw new Error("承認前再取得の探索対象タスクがありません。");
      }
      expandedTaskGids.add(taskGid);
      if (expandedTaskGids.size > maximumApprovalTaskCount) {
        throw new Error("承認前再取得のタスク件数が上限を超えました。");
      }
      if (task.num_subtasks === 0) {
        continue;
      }
      const subtasks = await this.interactiveReadClient.listSubtasks(
        task.gid,
        signal,
      );
      if (subtasks.length !== task.num_subtasks) {
        throw new Error("承認前再取得のサブタスク件数がAsana応答と一致しません。");
      }
      const childGids = new Set<string>();
      for (const subtask of subtasks) {
        const validatedSubtask = asanaTaskResponseSchema.parse(subtask);
        if (childGids.has(validatedSubtask.gid)) {
          throw new Error("承認前再取得のサブタスクGIDが重複しています。");
        }
        childGids.add(validatedSubtask.gid);
        if (validatedSubtask.parent?.gid !== task.gid) {
          throw new Error("承認前再取得のサブタスク親参照が一致しません。");
        }
        const selectedCandidate = mergeApprovalTaskResponse(tasks, validatedSubtask);
        if (
          selectedCandidate
          && validatedSubtask.num_subtasks > 0
          && expandedTaskGids.delete(validatedSubtask.gid)
        ) {
          pendingTaskGids.push(validatedSubtask.gid);
        }
        if (
          !queuedTaskGids.has(validatedSubtask.gid)
          && !expandedTaskGids.has(validatedSubtask.gid)
        ) {
          queuedTaskGids.add(validatedSubtask.gid);
          pendingTaskGids.push(validatedSubtask.gid);
        }
      }
      if (tasks.size > maximumApprovalTaskCount) {
        throw new Error("承認前再取得のタスク件数が上限を超えました。");
      }
    }
    return [...tasks.values()].sort((left, right) =>
      compareStrings(left.gid, right.gid));
  }

  private async prepareApprovalInput(
    input: ApprovalPreparationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationInput> {
    validateAbortSignal(signal);
    this.assertWritesAllowed();
    const context = this.requireContext();
    const baseline = input.baseline_snapshot;
    if (
      baseline.as_of == null
      || baseline.project_gid !== context.project_gid
      || baseline.app_version !== this.options.app_version
    ) {
      throw new Error("AI変更案の基準スナップショット文脈が一致しません。");
    }
    const baselineExternalData = this.baselineExternalData.get(
      canonicalizeJson(baseline),
    );
    if (baselineExternalData == null) {
      throw new Error("AI変更案の基準Custom external dataが失効しています。");
    }
    const baselineTasks = baseline.tasks.map((task) => taskSchema.parse(task));
    const currentResponses = await this.collectApprovalProjectTasks(
      context.project_gid,
      signal,
    );
    const normalized = normalizeAsanaSnapshot({
      project_gid: context.project_gid,
      section_gids: context.section_gids,
      activity_date: todayJst(this.options.now_provider),
      tasks: [...currentResponses],
      previous_tasks: baselineTasks,
      activity_baseline_tasks: baselineTasks,
      inaccessible_gids: [],
    });
    const writableExternalDataTaskGids = currentResponses
      .filter(externalDataIsValid)
      .map((task) => task.gid)
      .sort(compareStrings);
    return {
      proposal_id: this.proposalIdFor(input),
      project_gid: context.project_gid,
      workspace_gid: context.workspace_gid,
      section_gids: context.section_gids,
      device_id: context.device_id,
      created_via: "codex",
      activity_date: todayJst(this.options.now_provider),
      baseline_external_data: baselineExternalData,
      approval_input: {
        proposal: input.proposal,
        baseline_tasks: baselineTasks,
        current_tasks: normalized.tasks,
        graph_validation_result: input.graph_validation_result,
        selected_operation_ids: [...input.selected_operation_ids],
        writable_external_data_task_gids: writableExternalDataTaskGids,
        journal_task_mappings: [],
      },
    };
  }

  private validateRelationGraph(
    request: AsanaGuiEditRelationGraphValidationRequest,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditRelationGraphValidationResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const tasks: NormalizationTask[] = parseTaskCache(this.database.getTaskCache())
      .map((entry) => {
        const task = taskSchema.parse(entry.task);
        if (task.gid !== request.task_gid) {
          return {
            gid: task.gid,
            status: task.status,
            dependencies: task.dependencies,
            parent_work_mode: task.parent_work_mode,
            ...(task.parent_gid == null ? {} : { parent_gid: task.parent_gid }),
          };
        }
        if (request.kind === "dependencies") {
          return {
            gid: task.gid,
            status: task.status,
            dependencies: request.dependencies,
            parent_work_mode: task.parent_work_mode,
            ...(task.parent_gid == null ? {} : { parent_gid: task.parent_gid }),
          };
        }
        return {
          gid: task.gid,
          status: task.status,
          dependencies: task.dependencies,
          parent_work_mode: task.parent_work_mode,
          ...(request.parent_gid == null ? {} : { parent_gid: request.parent_gid }),
        };
      });
    if (!tasks.some((task) => task.gid === request.task_gid)) {
      throw new Error("関係グラフの編集対象タスクがありません。");
    }
    const result = normalizeTaskGraph({ tasks, inaccessible_gids: [] });
    if (result.dependency_cycles.length > 0 || result.parent_cycles.length > 0) {
      return Promise.resolve({
        kind: "conflict",
        reason_code: "relationship_cycle",
      });
    }
    return Promise.resolve({ kind: "valid" });
  }

  private assertWritesAllowed(): void {
    this.assertOperationalReady();
    if (
      this.journalRecoveryPending
      || this.database.getIncompleteApplicationJournals().length > 0
    ) {
      throw new Error("未完了のAI適用ジャーナルを復旧するまで書き込みを開始できません。");
    }
    const blocked = this.database.getCleanupItems()?.some(
      (item) => item.kind === "oauth_app_mismatch" && item.task_gid == null,
    ) ?? false;
    if (blocked) {
      throw new Error(
        "同一のAsana OAuthアプリ設定を確認するまで書き込みを開始できません。",
      );
    }
  }

  private assertExpectedSyncAt(expectedSyncAt: string): void {
    const expected = isoDateTimeSchema.parse(expectedSyncAt);
    const current = this.database.getSyncState(
      this.requireContext().project_gid,
    )?.last_successful_sync_at;
    if (current == null || current !== expected) {
      throw new Error("GUI編集の同期基準が最新状態と一致しません。");
    }
  }

  private createReadModelPort(): IpcReadModelPort {
    return {
      getOverview: () => this.readModel.getOverview(this.requireContext().project_gid),
      getTaskDetail: (taskGid) => this.readModel.getTaskDetail(
        this.requireContext().project_gid,
        gidSchema.parse(taskGid),
      ),
    };
  }

  private createAsanaPort(): IpcAsanaPort {
    return {
      reauthenticateOAuth: (signal) => this.reauthenticateAsanaOAuth(signal),
    };
  }

  private createSyncPort(): IpcSyncPort {
    return {
      getState: () => {
        this.assertOperationalReady();
        return toIpcSyncState(this.requireRuntime().getState());
      },
      run: async (input, signal) => {
        this.assertOperationalReady();
        const request = ipcSyncInputSchema.parse(input);
        const runtime = this.requireRuntime();
        const result = await this.requireSynchronizedResult(
          request.mode === "full"
            ? runtime.manualFullSync(signal)
            : runtime.manualSync(signal),
        );
        await this.afterSynchronizedState(result, signal);
        await this.verifyConfiguredCodexCapabilities(signal);
        return toIpcSyncResult(result.result);
      },
      onState: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("同期状態の購読関数が必要です。");
        }
        this.syncStateListeners.add(listener);
        return (): void => {
          this.syncStateListeners.delete(listener);
        };
      },
    };
  }

  private configureAfterSetupTransition(state: SetupState): SetupState {
    const validatedState = setupStateSchema.parse(state);
    this.configureAsanaFromSettings(this.database.getDeviceSettings());
    this.configureContextFromState(validatedState);
    this.aiStartResult = this.codexAdapter.getStartResult() ?? this.aiStartResult;
    this.codexAuthenticationRequired = validatedState.kind === "codex_authentication_required"
      || this.aiStartResult?.state === "authentication_required";
    this.publishAiStatus();
    return validatedState;
  }

  private async refreshCodexThreadIfReady(signal: AbortSignal): Promise<void> {
    if (this.codexSession.getState() !== "ready") {
      return;
    }
    this.aiStartResult = await this.codexSession.startNewSession(signal);
    this.codexAuthenticationRequired = false;
    this.publishAiStatus();
  }

  private createSetupPort(): IpcSetupPort {
    return {
      getState: () => setupStateSchema.parse(this.setup.getState()),
      start: async (signal) => this.configureAfterSetupTransition(
        await this.setup.start(signal),
      ),
      completeCodexAuthentication: async (signal) => {
        const state = this.configureAfterSetupTransition(
          await this.setup.completeCodexAuthentication(signal),
        );
        if (state.kind === "ready") {
          if (!this.readyActivated) {
            await this.activateReadyApplication(signal);
          } else {
            await this.verifyConfiguredCodexCapabilities(signal);
          }
        }
        return state;
      },
      authenticateAsana: async (input, signal) =>
        this.configureAfterSetupTransition(
          await this.setup.authenticateAsana(input, signal),
        ),
      listWorkspaces: async (signal) => this.configureAfterSetupTransition(
        await this.setup.listWorkspaces(signal),
      ),
      selectWorkspace: async (input, signal) =>
        this.configureAfterSetupTransition(
          await this.setup.selectWorkspace(input, signal),
        ),
      selectProject: async (input, signal) =>
        this.configureAfterSetupTransition(
          await this.setup.selectProject(input, signal),
        ),
      retryResources: async (signal) => this.configureAfterSetupTransition(
        await this.setup.retryResourceReconciliation(signal),
      ),
      runCapability: async (signal) => this.configureAfterSetupTransition(
        await this.setup.runCapabilityCheck(signal),
      ),
      chooseVault: async (input, signal) => {
        const state = this.configureAfterSetupTransition(
          await this.setup.chooseVault(input, signal),
        );
        await this.refreshCodexThreadIfReady(signal);
        return state;
      },
      chooseExternalTool: async (input, signal) => {
        const state = this.configureAfterSetupTransition(
          await this.setup.chooseExternalTool(input, signal),
        );
        await this.startExternalTools(signal);
        return state;
      },
      runFullSync: async (signal) => this.configureAfterSetupTransition(
        await this.setup.runFullSync(signal),
      ),
      runCodexCapability: async (signal) => {
        const state = this.configureAfterSetupTransition(
          await this.setup.runCodexCapabilityCheck(signal),
        );
        if (state.kind === "ready") {
          await this.activateReadyApplication(signal);
        }
        return state;
      },
    };
  }

  private requireGuiEdit(): AsanaGuiEditService {
    const service = this.guiEdit;
    if (service == null) {
      throw new Error("GUI編集サービスが設定されていません。");
    }
    return service;
  }

  private createGuiPort(): IpcGuiEditPort {
    return {
      apply: async (input: IpcGuiRequest, signal): Promise<IpcGuiEditResult> => {
        const request = ipcGuiEditInputSchema.parse(input);
        this.assertWritesAllowed();
        this.assertExpectedSyncAt(request.expected_sync_at);
        const context = this.requireContext();
        const baseline = this.database.getTaskCacheEntry(request.task_gid);
        if (baseline == null) {
          throw new Error("GUI編集の対象タスクが同期キャッシュにありません。");
        }
        const guiInput: AsanaGuiEditInput = {
          task_gid: request.task_gid,
          project_gid: context.project_gid,
          workspace_gid: context.workspace_gid,
          section_gids: context.section_gids,
          device_id: context.device_id,
          created_via: "gui",
          activity_date: todayJst(this.options.now_provider),
          baseline_task: asanaTaskResponseSchema.parse(baseline.asana_response),
          operation: request.operation,
        };
        return ipcGuiEditResultSchema.parse(
          await this.requireGuiEdit().apply(guiInput, signal),
        );
      },
    };
  }

  private requireAiWorkflow(): AiWorkflowService {
    const workflow = this.aiWorkflow;
    if (workflow == null) {
      throw new Error("AIワークフローが設定されていません。");
    }
    return workflow;
  }

  private rememberProposal(view: IpcAiProposalView): void {
    for (const operation of view.proposal.groups.flatMap((group) => group.operations)) {
      const existing = this.proposalIds.get(operation.operation_id);
      if (existing != null && existing !== view.proposal_id) {
        throw new Error("AI変更案の操作IDが別の変更案と重複しています。");
      }
      this.proposalIds.set(operation.operation_id, view.proposal_id);
    }
  }

  private forgetProposal(proposalId: string): void {
    for (const [operationId, storedProposalId] of this.proposalIds) {
      if (storedProposalId === proposalId) {
        this.proposalIds.delete(operationId);
      }
    }
  }

  private currentAiStatus(): IpcAiStatus {
    if (this.stopped || this.codexSession.getState() === "stopped") {
      return ipcAiStatusEventSchema.parse({
        kind: "unavailable",
        reason_code: "stopped",
      });
    }
    if (this.codexAvailability?.kind === "unavailable") {
      return ipcAiStatusEventSchema.parse({
        kind: "unavailable",
        reason_code: this.codexAvailability.reason_code,
      });
    }
    const rawVersion = this.codexAdapter.getVersion();
    if (this.codexAuthenticationRequired || this.aiStartResult?.state === "authentication_required") {
      if (rawVersion == null) {
        return ipcAiStatusEventSchema.parse({ kind: "starting" });
      }
      return ipcAiStatusEventSchema.parse({
        kind: "authentication_required",
        codex_version: rendererCodexVersion(rawVersion),
      });
    }
    const model = this.codexAdapter.getReadyModel();
    if (rawVersion != null && model != null && isReadyCodexResult(this.aiStartResult)) {
      return ipcAiStatusEventSchema.parse({
        kind: "ready",
        codex_version: rendererCodexVersion(rawVersion),
        model,
      });
    }
    const sessionState = this.codexSession.getState();
    if (sessionState === "disabled" || sessionState === "failed") {
      return ipcAiStatusEventSchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
    }
    return ipcAiStatusEventSchema.parse({ kind: "starting" });
  }

  private publishAiStatus(): void {
    const status = this.currentAiStatus();
    for (const listener of this.aiStatusListeners) {
      try {
        listener(status);
      } catch (error: unknown) {
        this.recordDiagnostic("ipc.error", "error");
        this.options.diagnostic(error, "ai_status_listener");
      }
    }
  }

  private createAiPort(): IpcAiPort {
    return {
      getStatus: () => {
        this.assertOperationalReady();
        return this.currentAiStatus();
      },
      startNewSession: async (signal) => {
        this.assertOperationalReady();
        this.aiStartResult = await this.codexSession.startNewSession(signal);
        this.codexAuthenticationRequired = false;
        this.publishAiStatus();
        return { kind: "started" };
      },
      startTurn: async (input: IpcAiTurnInput, signal): Promise<IpcAiTurnResult> => {
        this.assertWritesAllowed();
        const result = aiWorkflowTurnResultSchema.parse(
          await this.requireAiWorkflow().startTurn(
            aiWorkflowTurnRequestSchema.parse(input),
            signal,
          ),
        );
        if (result.kind === "proposal") {
          this.rememberProposal(result.proposal);
        }
        return result;
      },
      getProposal: (proposalId) => {
        this.assertOperationalReady();
        return aiWorkflowProposalViewSchema.parse(
          this.requireAiWorkflow().getProposal(identifierSchema.parse(proposalId)),
        );
      },
      select: (input: IpcAiSelectionInput) => {
        this.assertOperationalReady();
        return aiWorkflowProposalViewSchema.parse(
          this.requireAiWorkflow().select(aiWorkflowSelectionRequestSchema.parse(input)),
        );
      },
      editOperation: (input: IpcAiEditInput) => {
        this.assertOperationalReady();
        return aiWorkflowProposalViewSchema.parse(
          this.requireAiWorkflow().editOperation(aiWorkflowOperationEditSchema.parse(input)),
        );
      },
      rejectProposal: (proposalId) => {
        this.assertOperationalReady();
        const validatedProposalId = identifierSchema.parse(proposalId);
        this.requireAiWorkflow().rejectProposal(validatedProposalId);
        this.forgetProposal(validatedProposalId);
      },
      approve: async (
        input: IpcAiApprovalInput,
        signal,
      ): Promise<IpcAiApprovalResult> => {
        this.assertWritesAllowed();
        const result = aiWorkflowApprovalResultSchema.parse(
          await this.requireAiWorkflow().approve(input, signal),
        );
        this.forgetProposal(result.proposal_id);
        return result;
      },
      onDelta: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("AI差分の購読関数が必要です。");
        }
        return this.codexSession.onDelta((delta) => {
          const event: IpcCodexDelta = ipcAiDeltaEventSchema.parse({
            thread_id: delta.threadId,
            turn_id: delta.turnId,
            item_id: delta.itemId,
            delta: delta.delta,
          });
          listener(event);
        });
      },
      onStatus: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("AI状態の購読関数が必要です。");
        }
        this.aiStatusListeners.add(listener);
        return (): void => {
          this.aiStatusListeners.delete(listener);
        };
      },
    };
  }

  private createObsidianPort(): IpcObsidianPort {
    return {
      listVaults: (signal) => {
        this.assertOperationalReady();
        validateAbortSignal(signal);
        throwIfAborted(signal);
        return this.database.getVaultMappings()
          .map((mapping) => mapping.vault_id)
          .sort(compareStrings);
      },
      validateVault: async (vaultId, signal) => {
        this.assertOperationalReady();
        const result = await this.obsidian.validateVault(vaultId, signal);
        return { vault_id: result.vault_id, kind: "valid" };
      },
      listNotes: (vaultId, signal) => {
        this.assertOperationalReady();
        return this.obsidian.listNotes(vaultId, signal);
      },
      resolvePath: async (vaultId, relativePath, signal) => {
        this.assertOperationalReady();
        const result = await this.obsidian.resolveRelativePath(
          vaultId,
          relativePath,
          signal,
        );
        if (result.kind === "missing") {
          return result;
        }
        return {
          kind: "resolved",
          vault_id: result.vault_id,
          relative_path: result.relative_path,
        };
      },
      noteExists: async (vaultId, relativePath, signal) => {
        this.assertOperationalReady();
        const result = await this.obsidian.noteExists(vaultId, relativePath, signal);
        if (result.kind === "missing") {
          return result;
        }
        return {
          kind: "resolved",
          vault_id: result.vault_id,
          relative_path: result.relative_path,
        };
      },
      search: (vaultId, query, signal) => {
        this.assertOperationalReady();
        return this.obsidian.searchNotes(vaultId, query, signal);
      },
      readNote: (vaultId, relativePath, signal) => {
        this.assertOperationalReady();
        return this.obsidian.readNote(vaultId, relativePath, signal);
      },
      openNote: async (vaultId, relativePath, signal) => {
        this.assertOperationalReady();
        const result = await this.obsidian.resolveRelativePath(
          vaultId,
          relativePath,
          signal,
        );
        if (result.kind === "missing") {
          throw new Error("開くObsidianノートが見つかりません。");
        }
        await this.options.open_path(result.absolute_path, signal);
      },
    };
  }
}
