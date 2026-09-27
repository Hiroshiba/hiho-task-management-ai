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
  type AsanaSyncCoordinatorResult,
} from "../asana/sync";
import {
  AsanaSyncRuntime,
  type AsanaSyncRuntimeInternalResult,
  type AsanaSyncRuntimeState,
} from "../asana/runtime";
import {
  AsanaOperationInvalidatedError,
  AsanaOperationQueue,
} from "../asana/operation-queue";
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
  AsanaOAuthOutOfBandAuthenticationInProgressError,
  AsanaOAuthOutOfBandAuthorizationIdMismatchError,
  AsanaOAuthOutOfBandNotPendingError,
  oauthOutOfBandBeginResultSchema,
  oauthOutOfBandStateSchema,
} from "../auth/asana-oauth";
import {
  SecretStorage,
  type SecretStorageData,
} from "../auth/secret-storage";
import {
  createCodexSessionWorkspaceUserDataPath,
  initializeCodexWorkspace,
  initializeCodexSessionWorkspaceParent,
  installContextctlClientScript,
  installDisabledExternalToolsSkill,
  removeCodexSessionWorkspace,
  type CodexWorkspaceInitializationResult,
} from "../codex/workspace";
import {
  createSafeCodexEnvironment,
} from "../codex/app-server";
import {
  CodexSessionAbortedError,
  CodexSessionService,
  createCodexAppServerConnectionFactory,
  type CodexSessionConnectionFactory,
  type CodexSessionStartResult,
} from "../codex/session";
import type { CodexObsidianReadPort } from "../codex/obsidian";
import {
  combineDiagnosticFailures,
  DiagnosticFailureDispositionError,
  diagnosticFailureDispositionFromError,
} from "./common/errors/diagnostic-failure";
import { CodexSetupAdapter } from "./codex-adapter";
import { CleanupAggregationService } from "./cleanup-aggregation";
import {
  DiagnosticLogService,
  type DiagnosticRecord,
} from "./diagnostics";
import {
  AiWorkflowService,
  AiWorkflowRetryLogEventError,
  aiWorkflowRetryLogEventSchema,
  createBaselineSnapshot,
  type AiWorkflowRetryLogEvent,
  type ApprovalPreparationInput,
} from "../ai/workflow";
import {
  AsanaProposalApplicationCoordinator,
  AsanaProposalOperationWriter,
  asanaPostWriteSynchronizationResultSchema,
  type ApplicationDiagnostic,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryResult,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResult,
  type PostWriteSynchronizationResultWithCause,
} from "../ai/proposal-application";
import {
  AsanaGuiEditService,
  hashGuiEditBaseline,
  type AsanaGuiEditInput,
  type AsanaGuiEditRelationGraphValidationRequest,
  type AsanaGuiEditRelationGraphValidationResult,
} from "../gui-edit";
import {
  ingestAsanaExternalData,
  normalizeAsanaSnapshot,
  normalizeTaskGraph,
} from "../domain";
import { collectApprovalProjectTasks } from "./proposal-generate";
import { buildDisplayOrderInput } from "./task-write";
import { validateRelationGraph } from "./gui-edit";
import {
  createCodexObsidianReadPort,
  createObsidianPort,
} from "../bootstrap/obsidian-ports";
import { ExternalToolRuntime } from "../bootstrap/external-tool-runtime";
import {
  AiSessionRuntime,
  type AiSessionBaselineStore as RuntimeAiSessionBaselineStore,
  type AiSessionRecord as RuntimeAiSessionRecord,
} from "../bootstrap/ai-session-runtime";
import { JournalRecoveryRuntime } from "../bootstrap/journal-recovery-runtime";
import { SynchronizationOperations } from "../bootstrap/synchronization-operations";
import { ConfiguredCodexRuntime } from "../bootstrap/configured-codex-runtime";
import { AsanaReauthenticationRuntime } from "../bootstrap/asana-reauthentication-runtime";
import { OperationalContextRuntime } from "../bootstrap/operational-context-runtime";
import { AiInteractionRuntime } from "../bootstrap/ai-interaction-runtime";
import { MainLifecycleRuntime } from "../bootstrap/main-lifecycle-runtime";
import { OperationalServicesRuntime } from "../bootstrap/operational-services-runtime";
import { SyncStateRuntime, TaskReadIndex, TaskReadWorkflow } from "./task-read";
import {
  createObsidianOpenUri,
  ObsidianReadService,
  ObsidianVaultMappingConflictError,
  validateVaultMappingPath,
} from "../obsidian";
import { discoverTasksVault } from "../obsidian/tasks-vault-discovery";
import {
  ExternalToolBroker,
  ExternalToolError,
  ExternalToolRegistry,
  ExternalToolStatusEvidenceCollector,
  SecretStorageDiscordCredentialProvider,
  createDiscordExternalToolDefinition,
  discordExternalToolCredentialReferenceName,
  type ExternalToolDefinition,
} from "../external-tools";
import {
  ExternalAgentService,
  type ExternalAgentBaseline,
} from "../external-agent";
import { ExternalAgentBridge } from "../external-agent/transport";
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
  type SetupExternalToolConfigurationResult,
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
  aiWorkflowApprovalRequestSchema,
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
  TaskctlAbortError,
  taskHubExecutablePathEnvironmentVariable,
  taskctlSnapshotSchema,
  type TaskctlSnapshot,
} from "../codex/taskctl";
import {
  codexUnavailableReasonSchema,
  setupDiscordExternalToolConfigurationInputSchema,
  setupCodexAvailabilitySchema,
  setupExternalToolSelectionSchema,
  type SetupDiscordExternalToolConfigurationInput,
  type SetupCodexAvailability,
  type SetupState,
  setupStateSchema,
} from "../../shared/setup";
import {
  type IpcAiPort,
  type IpcAsanaPort,
  type IpcGuiEditPort,
  type IpcExternalAgentPort,
  type IpcObsidianPort,
  type IpcServicePorts,
  type IpcSetupPort,
} from "../ipc";
import {
  ipcAiDeltaEventSchema,
  ipcAiStatusEventSchema,
  ipcAsanaAuthenticationStateSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResultSchema,
  ipcReadModelOverviewResponseSchema,
  ipcReadModelTaskDetailResponseSchema,
  ipcSyncInputSchema,
  type IpcAiStatus,
  type IpcCodexDelta,
  type IpcGuiEditInput as IpcGuiRequest,
  type IpcGuiEditResult,
  type IpcAiTurnInput,
  type IpcAiTurnResult,
  type IpcAiSelectionInput,
  type IpcAiEditInput,
  type IpcAiApprovalInput,
  type IpcAiApprovalResult,
  type IpcAiProposalInput,
  type IpcAiRejectInput,
  type IpcAsanaAuthenticationState,
  type IpcAsanaReauthenticationCancelInput,
  type IpcAsanaReauthenticationCompleteInput,
  type IpcObsidianVaultMapping,
  type IpcObsidianVaultMappings,
} from "../../shared/ipc";
import {
  deviceSettingsSchema,
  vaultMappingSchema,
  type DeviceSettings,
  type TaskCacheEntry,
} from "../../shared/storage";
import {
  StorageDatabase,
  migrateLegacyProposalConflictIdentifiers,
  type ExternalToolDefinitionRecord,
} from "../storage";
import { type PersistenceRuntime, type SqliteConnection } from "../infrastructure/persistence";
import { AsanaTaskReadAdapter } from "../infrastructure/asana";
import type { TaskReadEntry } from "./common/ports/task-read-repository";

type OperationalContext = {
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

type BaselineExternalData = AsanaProposalApplicationInput["baseline_external_data"];

type AiSessionBaselineStore = RuntimeAiSessionBaselineStore<BaselineExternalData, TaskctlSnapshot>;

type AiSessionRecord = RuntimeAiSessionRecord<
  CodexWorkspaceInitializationResult,
  CodexSessionService,
  AiWorkflowService,
  ExternalToolBroker,
  BaselineExternalData,
  TaskctlSnapshot
>;

type AiSessionExternalToolResources = {
  readonly broker: ExternalToolBroker | undefined;
  readonly collector: ExternalToolStatusEvidenceCollector;
  readonly endpoint: string | undefined;
};

const codexAuthenticationStateSchema = z.union([
  z.object({ kind: z.literal("authenticated") }).strict(),
  z.object({ kind: z.literal("required") }).strict(),
  z.object({
    kind: z.literal("unavailable"),
    reason_code: codexUnavailableReasonSchema,
  }).strict(),
]);

type CodexAuthenticationState = z.infer<typeof codexAuthenticationStateSchema>;

type CodexKnownFailureCapture =
  | { readonly kind: "none" }
  | { readonly kind: "captured"; readonly error: unknown };

type ExternalToolPersistenceResult =
  | { readonly kind: "saved" }
  | {
      readonly kind: "credential_storage_unavailable";
      readonly error: unknown;
    }
  | {
      readonly kind: "startup_failed";
      readonly error: unknown;
    }
  | {
      readonly kind: "recovery_required";
      readonly error: unknown;
    };

const diagnosticLogRetentionLimit = 1_000;
const serviceErrorDiagnostic = {
  kind: "service",
  severity: "error",
} satisfies ApplicationDiagnostic;
const serviceWarningDiagnostic = {
  kind: "service",
  severity: "warning",
} satisfies ApplicationDiagnostic;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function createPersistedExternalToolRegistry(
  records: readonly ExternalToolDefinitionRecord[],
): ExternalToolRegistry {
  if (records.length !== 1) {
    throw new Error("保存済み外部ツール設定は固定Discord定義一件でなければなりません。");
  }
  const record = records[0];
  if (record == null) {
    throw new Error("保存済み外部ツール設定を取得できません。");
  }
  if (
    record.credential_reference_names.length !== 1
    || record.credential_reference_names[0] !== discordExternalToolCredentialReferenceName
  ) {
    throw new Error("保存済みDiscord資格情報参照が固定値と一致しません。");
  }
  const {
    credential_reference_names: _credentialReferenceNames,
    ...storedDefinition
  } = record;
  void _credentialReferenceNames;
  const definition = createDiscordExternalToolDefinition(
    storedDefinition.allowed_channel_ids,
  );
  if (canonicalizeJson(storedDefinition) !== canonicalizeJson(definition)) {
    throw new Error("保存済み外部ツール設定が固定Discord定義と一致しません。");
  }
  const registry = new ExternalToolRegistry();
  registry.register(definition);
  return registry;
}

function findPersistedDiscordExternalToolRecord(
  records: readonly ExternalToolDefinitionRecord[],
): ExternalToolDefinitionRecord | undefined {
  const discordRecords = records.filter(
    (record) => record.tool_id === "discord-context",
  );
  if (discordRecords.length > 1) {
    throw new Error("保存済み固定Discord定義が重複しています。");
  }
  const record = discordRecords[0];
  if (record == null) {
    return undefined;
  }
  createPersistedExternalToolRegistry([record]);
  return record;
}

function createExternalToolRegistry(
  definition: ExternalToolDefinition,
): ExternalToolRegistry {
  const registry = new ExternalToolRegistry();
  registry.register(definition);
  return registry;
}

function createExternalToolDefinitionRecord(
  definition: ExternalToolDefinition,
): ExternalToolDefinitionRecord {
  return {
    ...definition,
    credential_reference_names: [
      discordExternalToolCredentialReferenceName,
    ],
  };
}

function isAiSessionAbortError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (
      current instanceof AsanaRequestAbortedError
      || current instanceof CodexSessionAbortedError
      || current instanceof TaskctlAbortError
      || (current instanceof ExternalToolError && current.code === "aborted")
    ) {
      return true;
    }
    seen.add(current);
    current = current.cause;
  }
  return false;
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
    case "external_tool_unavailable":
    case "full_sync_required":
    case "codex_capability_required":
    case "ready":
      return {
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

function asanaOperationContextKey(context: OperationalContext): string {
  return canonicalizeJson({
    device_id: context.device_id,
    client_id: context.client_id,
    workspace_gid: context.workspace_gid,
    project_gid: context.project_gid,
    section_gids: context.section_gids,
    tag_gids: context.tag_gids,
  });
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

class AsanaOAuthRefreshHttpError extends AsanaHttpError {
  public readonly cause: AsanaOAuthHttpError;

  public constructor(error: AsanaOAuthHttpError) {
    super(error.status, error.requestId, { response_body_kind: "unavailable" }, "oauth");
    this.cause = error;
  }
}

function throwTokenProviderError(error: unknown): never {
  if (requiresAsanaReauthentication(error)) {
    throw new AsanaAuthenticationError(error);
  }
  if (error instanceof AsanaOAuthTransportError) {
    throw new AsanaTransportError(error);
  }
  if (error instanceof AsanaOAuthResponseError) {
    throw new AsanaResponseError(error);
  }
  if (error instanceof AsanaOAuthHttpError) {
    throw new AsanaOAuthRefreshHttpError(error);
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

function canResumeReadyStateAfterRevalidationFailure(error: unknown): boolean {
  if (error instanceof AsanaRequestAbortedError) {
    return false;
  }
  return classifyPostWriteSynchronizationError(error).kind === "recovery_required";
}

function postWriteRecoveryRequired(
  errorCode: PostWriteSynchronizationFailureCode,
): PostWriteSynchronizationResult {
  return asanaPostWriteSynchronizationResultSchema.parse({
    kind: "recovery_required",
    error_code: errorCode,
  });
}

function postWriteRecoveryRequiredWithCause(
  errorCode: PostWriteSynchronizationFailureCode,
  cause: unknown,
): PostWriteSynchronizationResultWithCause {
  return {
    ...postWriteRecoveryRequired(errorCode),
    cause,
  };
}

function postWriteSynchronizationFromRuntimeResult(
  result: AsanaSyncRuntimeInternalResult,
): PostWriteSynchronizationResultWithCause {
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
          return postWriteRecoveryRequiredWithCause(result.error_code, result.cause);
        case "unexpected_error":
          throw new Error("書き込み後の同期が想定外エラーで停止しました。", {
            cause: result.cause,
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

function createCodexProcessEnvironment(
  codexHomePath: string,
  taskHubExecutablePath: string,
): Record<string, string> {
  return z.record(z.string(), z.string()).parse(
    {
      ...createSafeCodexEnvironment(process.env),
      CODEX_HOME: codexHomePath,
      [taskHubExecutablePathEnvironmentVariable]: taskHubExecutablePath,
    },
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

class UnreachableError extends Error {}

/** TaskHubの主要な依存関係を組み立てるメインプロセスサービスです。 */
export class TaskHubApplication {
  private readonly options: ApplicationOptions;
  private readonly database: StorageDatabase;
  private readonly diagnostics: DiagnosticLogService;
  private readonly secretStorage: SecretStorage;
  private readonly checkpoint: SetupCheckpointStore;
  private readonly scheduler: AsanaRequestScheduler;
  private readonly operationQueue: AsanaOperationQueue;
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
  private readonly syncCoordinator: AsanaSyncCoordinator;
  private readonly codexWorkspace: CodexWorkspaceInitializationResult;
  private readonly aiSessionWorkspaceParentPath: string;
  private readonly codexSession: CodexSessionService;
  private readonly codexConnectionFactory: CodexSessionConnectionFactory;
  private readonly codexAdapter: CodexSetupAdapter;
  private readonly setup: SetupOrchestrator;
  public readonly taskRead: TaskReadWorkflow<
    Extract<ReturnType<typeof ipcReadModelOverviewResponseSchema.parse>, { kind: "ok" }>["value"],
    Extract<ReturnType<typeof ipcReadModelTaskDetailResponseSchema.parse>, { kind: "ok" }>["value"],
    AsanaSyncRuntimeInternalResult,
    AsanaSyncCoordinatorResult,
    AsanaSyncRuntimeState,
    AsanaSyncRuntimeState,
    AsanaSyncCoordinatorResult
  >;
  private readonly obsidian: ObsidianReadService;
  private readonly cleanupAggregation: CleanupAggregationService;
  private readonly externalStatusEvidenceCollector: ExternalToolStatusEvidenceCollector;
  private readonly externalAgentInstanceId: string;
  private readonly externalAgent: ExternalAgentService;
  private readonly externalAgentBridge: ExternalAgentBridge;
  private readonly externalTools: ExternalToolRuntime<
    ExternalToolBroker,
    ExternalToolRegistry,
    ExternalToolDefinition
  >;
  private readonly asanaReauthentication: AsanaReauthenticationRuntime<
    DeviceSettings,
    IpcAsanaReauthenticationCompleteInput,
    IpcAsanaReauthenticationCancelInput,
    IpcAsanaAuthenticationState,
    AsanaSyncCoordinatorResult
  >;
  private readonly operationalContext: OperationalContextRuntime<
    SetupState,
    OperationalContext,
    DeviceSettings,
    OperationalContext["codex"]
  >;
  private readonly operationalServices: OperationalServicesRuntime<
    OperationalContext,
    DeviceSettings,
    AsanaSyncRuntime,
    AsanaDisplayOrderService,
    AsanaProposalOperationWriter,
    AsanaProposalApplicationCoordinator,
    AsanaGuiEditService
  >;
  private readonly aiRuntime: AiSessionRuntime<
    CodexWorkspaceInitializationResult,
    CodexSessionService,
    AiWorkflowService,
    ExternalToolBroker,
    ExternalToolStatusEvidenceCollector,
    BaselineExternalData,
    TaskctlSnapshot,
    CodexSessionStartResult
  >;
  private readonly aiInteraction: AiInteractionRuntime<
    AiSessionRecord,
    IpcAiTurnInput,
    z.infer<typeof aiWorkflowTurnRequestSchema>,
    IpcAiTurnResult,
    IpcAiApprovalInput,
    z.infer<typeof aiWorkflowApprovalRequestSchema>,
    IpcAiApprovalResult,
    OperationalContext
  >;
  private vaultMappingSaveInProgress = false;
  private aiStartResult: CodexSessionStartResult | undefined;
  private codexAvailability: OperationalContext["codex"] | undefined;
  private codexAuthenticationRequired = false;
  private readonly aiDeltaListeners = new Set<(delta: IpcCodexDelta) => void>();
  private readonly aiStatusListeners = new Set<(status: IpcAiStatus) => void>();
  private readonly synchronizationOperations: SynchronizationOperations<
    AsanaSyncRuntimeInternalResult,
    PostWriteSynchronizationResultWithCause,
    PostWriteSynchronizationFailureCode
  >;
  private readonly journalRecovery: JournalRecoveryRuntime<
    ReturnType<StorageDatabase["getIncompleteApplicationJournals"]>[number],
    AsanaProposalRecoveryResult
  >;
  private readonly configuredCodexRuntime: ConfiguredCodexRuntime;
  private readonly lifecycleRuntime: MainLifecycleRuntime<
    SetupState,
    ApplicationState,
    AsanaSyncRuntimeInternalResult
  >;

  public constructor(options: ApplicationOptions, persistence: PersistenceRuntime) {
    applicationOptionsSchemaExport.parse(options);
    this.options = options;
    this.externalAgentInstanceId = identifierSchema.parse(options.create_id());
    this.operationQueue = new AsanaOperationQueue(options.lifecycle_signal);
    this.database = new StorageDatabase(persistence);
    const taskReadContracts = {
      ...this.database.taskReadContracts,
      parseOverview: (value: unknown) => {
        const response = ipcReadModelOverviewResponseSchema.parse({ kind: "ok", value });
        if (response.kind !== "ok") {
          throw new UnreachableError("読取概要の応答形式が不正です。");
        }
        return response.value;
      },
      parseDetail: (value: unknown) => {
        const response = ipcReadModelTaskDetailResponseSchema.parse({ kind: "ok", value });
        if (response.kind !== "ok") {
          throw new UnreachableError("読取詳細の応答形式が不正です。");
        }
        return response.value;
      },
      hashBaseline: (entry: TaskReadEntry) => hashGuiEditBaseline(
        asanaTaskResponseSchema.parse(entry.asana_response),
      ),
    };
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
    const fullSource = new AsanaFullSyncSource(this.readClient, this.writeClient);
    const deltaSource = new AsanaDeltaSyncSource(this.readClient);
    const planApplier = new AsanaNormalizationPlanApplier(
      this.readClient,
      this.writeClient,
      options.create_id,
    );
    this.syncCoordinator = new AsanaSyncCoordinator(
      this.readClient,
      fullSource,
      deltaSource,
      planApplier,
      this.database.taskRead,
      () => createNowIso(this.options.now_provider),
    );
    this.codexWorkspace = initializeCodexWorkspace({
      userDataPath: options.user_data_path,
    });
    this.aiSessionWorkspaceParentPath = initializeCodexSessionWorkspaceParent(
      join(this.codexWorkspace.userDataPath, "ai-sessions"),
    );
    const codexEnvironment = createCodexProcessEnvironment(
      this.codexWorkspace.codexHomePath,
      process.execPath,
    );
    const onCodexError = (error: unknown): void => {
      this.options.diagnostic(error, "codex", serviceErrorDiagnostic);
    };
    const connectionFactory = createCodexAppServerConnectionFactory({
      executable: options.codex_executable,
      environment: codexEnvironment,
      clientInfo: {
        name: "taskhub",
        title: "TaskHub",
        version: options.app_version,
      },
      capabilities: { experimentalApi: true },
      configOverrides: [],
    }, onCodexError);
    this.codexConnectionFactory = connectionFactory;
    this.obsidian = new ObsidianReadService(this.database);
    this.codexSession = new CodexSessionService({
      codexExecutablePath: options.codex_executable,
      workspacePath: this.codexWorkspace.workspacePath,
      agentsFilePath: this.codexWorkspace.agentsFilePath,
      tmpDirectoryPath: this.codexWorkspace.tmpDirectoryPath,
      expectedCodexHomePathProvider: () => this.codexWorkspace.codexHomePath,
      obsidianReader: this.createCodexObsidianReadPort(),
      readOnlyVaultPaths: [...this.readOnlyVaultPaths()],
      connectionFactory,
      onError: onCodexError,
      snapshotProvider: () => this.createTaskctlSnapshot(),
      syncBeforeTurn: (signal) => this.synchronizationOperations.requireSynchronizedBeforeAi(signal),
    });
    this.codexAdapter = new CodexSetupAdapter({
      session: this.codexSession,
      executable: options.codex_executable,
      environment: codexEnvironment,
      openAuthorizationUrl: options.open_codex_authorization_url,
    });
    const taskReadIndex = new TaskReadIndex(this.database.taskRead, taskReadContracts);
    this.cleanupAggregation = new CleanupAggregationService(
      this.database,
      this.obsidian,
    );
    this.externalStatusEvidenceCollector = new ExternalToolStatusEvidenceCollector();
    this.externalTools = new ExternalToolRuntime({
      lifecycleSignal: this.options.lifecycle_signal,
      isStopped: () => this.lifecycleRuntime.isStopped(),
      platform: process.platform,
      validateAbortSignal,
      throwIfAborted,
      installDisabledSkill: (reason) => installDisabledExternalToolsSkill(
        this.codexWorkspace.workspacePath,
        reason,
      ),
      installClient: (registry, connectionInfoPath) => installContextctlClientScript({
        workspacePath: this.codexWorkspace.workspacePath,
        connectionInfoPath,
        toolDefinitions: [...registry.list()],
      }),
      setCodexSocketPaths: (paths) => this.setCodexExternalSocketPaths(paths),
      recordStatus: () => this.recordDiagnostic("external_tools.status", "info"),
      recordFeatureFailure: (error, message) =>
        this.recordFeatureFailure(error, "external_tools", message),
      recordRecoveryDiagnostic: (message, cause) => this.options.diagnostic(
        new Error(message, { cause }),
        "external_tools",
        serviceErrorDiagnostic,
      ),
      combineFailures: (errors) => combineDiagnosticFailures(errors),
      disableCodexForSafety: (errors) => this.disableCodexForExternalToolSafety(errors),
      createDefinition: createDiscordExternalToolDefinition,
      createRegistry: createExternalToolRegistry,
      assertPersistedDefinition: (expectedDefinition) => {
        const records = this.database.getExternalToolDefinitions();
        const storedRecord = findPersistedDiscordExternalToolRecord(records);
        if (storedRecord == null) {
          throw new Error("保存済み固定Discord定義がありません。");
        }
        const {
          credential_reference_names: _credentialReferenceNames,
          ...storedDefinition
        } = storedRecord;
        void _credentialReferenceNames;
        if (canonicalizeJson(storedDefinition) !== canonicalizeJson(expectedDefinition)) {
          throw new Error("保存済み固定Discord定義がcheckpointと一致しません。");
        }
      },
      hasBotToken: () =>
        new SecretStorageDiscordCredentialProvider(this.secretStorage).hasBotToken(),
      createBroker: (registry) => this.createExternalToolBroker(
        registry,
        this.codexWorkspace.tmpDirectoryPath,
        this.externalStatusEvidenceCollector,
      ),
      persistConfiguration: (definition, botToken) =>
        this.persistDiscordExternalToolConfiguration(definition, botToken),
      getSelection: () => this.setup.getExternalToolSelection(),
      markUnavailable: (reason) => this.setup.markExternalToolUnavailable(reason),
      rethrowFeatureAbort: (error, signal) => this.rethrowFeatureAbort(error, signal),
    });
    this.aiRuntime = new AiSessionRuntime({
      lifecycleSignal: this.options.lifecycle_signal,
      isStopped: () => this.lifecycleRuntime.isStopped(),
      assertOperationalReady: () => this.assertOperationalReady(),
      validateAbortSignal,
      throwIfAborted,
      createSessionId: () => identifierSchema.parse(this.options.create_id()),
      parseSessionId: (sessionId) => identifierSchema.parse(sessionId),
      workspaceUserDataPath: (sessionId) => join(
        this.aiSessionWorkspaceParentPath,
        `ai-session-${sessionId}`,
      ),
      createWorkspace: (sessionId) => this.createAiSessionWorkspace(sessionId),
      prepareExternalTools: (workspace, signal) =>
        this.prepareAiSessionExternalTools(workspace, signal),
      createSession: (workspace, endpoint) => this.createAiSessionService(workspace, endpoint),
      startSession: (session, signal) => session.start(signal),
      createWorkflow: (session, collector, baselineStore, sessionId) =>
        this.createAiWorkflow(session, collector, baselineStore, sessionId),
      subscribeDelta: (workflow, sessionId) => workflow.onDelta((delta) => {
        this.publishAiDelta(ipcAiDeltaEventSchema.parse({
          session_id: sessionId,
          thread_id: delta.threadId,
          turn_id: delta.turnId,
          item_id: delta.itemId,
          delta: delta.delta,
        }));
      }),
      onAuthenticationRequired: (result) => {
        this.aiStartResult = result;
        this.codexAuthenticationRequired = true;
      },
      publishStatus: () => this.publishAiStatus(),
      createAbortedError: () => new CodexSessionAbortedError(),
      removeWorkspace: (userDataPath) => removeCodexSessionWorkspace(
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
      IpcAiTurnInput,
      z.infer<typeof aiWorkflowTurnRequestSchema>,
      IpcAiTurnResult,
      IpcAiApprovalInput,
      z.infer<typeof aiWorkflowApprovalRequestSchema>,
      IpcAiApprovalResult,
      OperationalContext
    >({
      assertOperationalReady: () => this.assertOperationalReady(),
      assertMutationRequestAccepted: () => this.assertMutationRequestAccepted(),
      assertProposalOperationAvailable: (record) =>
        this.assertAiProposalOperationAvailable(record),
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
            this.assertQueuedMutationReady();
            this.assertContextUnchanged(approvalContext);
          },
          run: (context) => this.aiRuntime.runOperation(
            record,
            context.signal,
            (operationSignal) => record.workflow.approve(request, operationSignal),
          ),
        })),
    });
    const externalAgentBridge = new ExternalAgentBridge({
      userDataPath: this.codexWorkspace.userDataPath,
      handleRequest: (input, signal) => {
        return externalAgent.handleRequest(input, signal);
      },
      onError: (error) => {
        this.options.diagnostic(error, "external_agent", serviceErrorDiagnostic);
      },
    });
    this.externalAgentBridge = externalAgentBridge;
    const externalAgent: ExternalAgentService = new ExternalAgentService({
      app_version: this.options.app_version,
      instance_id: this.externalAgentInstanceId,
      lifecycle_signal: this.options.lifecycle_signal,
      now_provider: this.options.now_provider,
      online_provider: () => this.isOnline(),
      get_taskctl_snapshot: () => this.createTaskctlSnapshot(),
      operation_queue: this.operationQueue,
      get_runtime_state: () => this.operationalServices.getRuntime()?.getState(),
      create_baseline: (signal) => this.createExternalBaseline(signal),
      prepare_approval_input: (input, signal) =>
        this.prepareApprovalInput(input, signal),
      apply_proposal: (input, signal) =>
        this.applyExternalProposal(input, signal),
      get_journal: (proposalId, operationId) =>
        this.database.getApplicationJournal(proposalId, operationId),
      assert_apply_ready: () => this.assertMutationRequestAccepted(),
      open_review: async () => {
        await this.options.open_external_agent_review();
      },
      bridge: externalAgentBridge,
    });
    this.externalAgent = externalAgent;
    this.setup = new SetupOrchestrator({
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
        beginInitialOutOfBandAuthorization: (input, signal) =>
          this.oauth.beginInitialOutOfBandAuthorization(input, signal),
        completeOutOfBandAuthorization: async (input, signal) => {
          const result = await this.oauth.completeOutOfBandAuthorization(input, signal);
          this.tokenProvider.setProvider(
            new AsanaOAuthClient(
              result.client_id,
              this.secretStorage,
            ),
          );
          return result;
        },
        cancelOutOfBandAuthorization: (input) =>
          this.oauth.cancelOutOfBandAuthorization(input),
        getOutOfBandState: () => this.oauth.getOutOfBandState(),
      },
      asana: this.setupClient,
      resources: this.resources,
      capability: this.capability,
      reportCapabilityFailure: (error) =>
        this.options.diagnostic(error, "setup", serviceErrorDiagnostic),
      database: {
        saveDeviceSettings: (value) => this.database.saveDeviceSettings(value),
        getDeviceSettings: () => this.database.getDeviceSettings(),
        saveVaultMapping: (value) => this.database.saveVaultMapping(value),
        getVaultMappings: () => this.database.getVaultMappings(),
      },
      checkpoint: {
        load: () => this.checkpoint.load(),
        save: (value) => this.checkpoint.save(value),
      },
      externalTool: {
        configureDiscord: (input, signal) =>
          this.configureDiscordExternalTool(input, signal),
        deactivateDiscord: (signal) =>
          this.externalTools.deactivate(signal),
      },
      fullSync: (input, signal) => this.runSetupFullSync(input, signal),
    });
    this.operationalContext = new OperationalContextRuntime<
      SetupState,
      OperationalContext,
      DeviceSettings,
      OperationalContext["codex"]
    >({
      initialSettings: this.database.getDeviceSettings(),
      parseState: (state) => setupStateSchema.parse(state),
      contextFromState,
      operationKey: asanaOperationContextKey,
      availabilityFromState: codexAvailabilityFromState,
      clientIdFromState,
      readSettings: () => this.database.getDeviceSettings(),
      parseSettings: (settings) => deviceSettingsSchema.parse(settings),
      contextMatchesSettings,
      configureExternalAgent: (context) => this.externalAgent.configureContext(context),
      invalidatePendingMutations: () => this.operationQueue.invalidatePendingMutations(
        "context_changed",
      ),
      setCodexAvailability: (availability) => {
        this.codexAvailability = availability;
      },
      setTokenProvider: (clientId) => this.tokenProvider.setProvider(
        new AsanaOAuthClient(clientId, this.secretStorage),
      ),
      updateCodexVaultPaths: () => this.updateCodexVaultPaths(),
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
      getIncompleteJournals: () => this.database.getIncompleteApplicationJournals(),
      recover: (signal) => this.requireApplicationCoordinator().recover(
        {
          applications: [],
          project_gids: [this.requireContext().project_gid],
        },
        signal,
      ),
      afterRecovery: (result) =>
        this.cleanupAggregation.replaceProposalConflictsFromRecovery(result),
    });
    this.synchronizationOperations = new SynchronizationOperations<
      AsanaSyncRuntimeInternalResult,
      PostWriteSynchronizationResultWithCause,
      PostWriteSynchronizationFailureCode
    >({
      validateAbortSignal,
      throwIfAborted,
      hasOperationOwner: (signal) => this.operationQueue.hasOwner(signal),
      hasPendingJournal: () => this.journalRecovery.hasPending(),
      hasIncompleteJournal: () => this.database.getIncompleteApplicationJournals()
        .some((journal) => journal.final_result == null),
      isJournalRecoveryRunning: () => this.journalRecovery.isRunning(),
      recoverJournal: (signal) => this.journalRecovery.recover(signal),
      afterLocalStateRefresh: (signal) => this.afterLocalStateRefresh(signal),
      synchronizeCodexAfterAsana: (signal) =>
        this.configuredCodexRuntime.synchronizeAfterAsana(signal),
      afterGuiEdit: (requiredTaskGids, signal) =>
        this.requireRuntime().afterGuiEdit(requiredTaskGids, signal),
      afterAiApply: (requiredTaskGids, signal) =>
        this.requireRuntime().afterAiApply(requiredTaskGids, signal),
      beforeAiTurn: (signal) => this.requireRuntime().beforeAiTurn(signal),
      prepareRecoveredSynchronization: (requiredTaskGids, signal) => {
        const context = this.requireContext();
        return () => this.syncCoordinator.coordinate(
          {
            mode: "delta",
            project_gid: context.project_gid,
            section_gids: context.section_gids,
            device_id: context.device_id,
            app_version: this.options.app_version,
            required_task_gids: [...requiredTaskGids],
          },
          signal,
        );
      },
      isSynchronizedResult: (
        result,
      ): result is Extract<AsanaSyncRuntimeInternalResult, { kind: "synchronized" }> =>
        result.kind === "synchronized",
      abortedCode: "aborted",
      classifyError: classifyPostWriteSynchronizationError,
      isDiagnosticFailure: (error) => error instanceof DiagnosticFailureDispositionError,
      recoveryRequired: postWriteRecoveryRequired,
      recoveryRequiredWithCause: postWriteRecoveryRequiredWithCause,
      synchronizedPostWrite: () => asanaPostWriteSynchronizationResultSchema.parse({
        kind: "synchronized",
      }),
      fromRuntimeResult: postWriteSynchronizationFromRuntimeResult,
      recordLocalRefreshFailure: (error) => this.recordFeatureFailure(
        error,
        "local_state_refresh",
        "Asana同期後の補助的なローカル状態更新に失敗しました。",
      ),
    });
    const syncStateRuntime = new SyncStateRuntime<AsanaSyncRuntimeState, AsanaSyncRuntimeState>({
      toEvent: (state) => state,
      recordDiagnostic: (code) => this.recordDiagnostic(code, "info"),
      shouldReportKnownFailure: () => this.synchronizationOperations.shouldReportKnownFailure(),
      reportKnownFailure: (cause) => this.options.diagnostic(
        cause == null
          ? new Error("Asana同期で認証または既知のエラーが発生しました。")
          : cause,
        "sync",
        serviceErrorDiagnostic,
      ),
      reportListenerFailure: (error) =>
        this.options.diagnostic(error, "sync_state_listener", serviceErrorDiagnostic),
      lifecycleSignal: this.options.lifecycle_signal,
      afterLocalStateRefresh: (signal) => this.afterLocalStateRefresh(signal),
      isReadyActivated: () => this.lifecycleRuntime.isReadyActivated(),
      synchronizeCodex: (signal) => this.configuredCodexRuntime.synchronizeAfterAsana(signal),
      reportUnexpectedError: (error, feature) => this.recordUnexpectedError(error, feature),
    });
    this.taskRead = new TaskReadWorkflow(taskReadIndex, syncStateRuntime, {
      projectGid: () => this.requireContext().project_gid,
      assertReady: () => this.assertOperationalReady(),
      assertReauthenticationIdle: () => this.assertAsanaReauthenticationIdle(),
      asana: new AsanaTaskReadAdapter(() => this.requireRuntime()),
      parseSyncInput: (value) => ipcSyncInputSchema.parse(value),
      toSyncState: (state) => state,
      toSyncResult: (details) => details,
      requireSynchronizedResult: (result) =>
        this.synchronizationOperations.requireSynchronizedResult(result),
      afterSynchronizedState: (result, signal) =>
        this.synchronizationOperations.afterSynchronizedState(result, signal),
    });
    this.configuredCodexRuntime = new ConfiguredCodexRuntime({
      validateAbortSignal,
      throwIfAborted,
      isSessionUnstarted: () => this.codexSession.getState() === "created",
      hasStartResult: () => this.aiStartResult != null,
      startConfigured: (signal) => this.startCodexForConfigured(signal),
      rethrowFeatureAbort: (error, signal) => this.rethrowFeatureAbort(error, signal),
      recordStartFailure: (error) => this.recordFeatureFailure(
        error,
        "codex",
        "オンライン復帰後にCodexを開始できないためAI機能を無効にしました。",
      ),
      disableAfterStartFailure: () => {
        this.codexAvailability = setupCodexAvailabilitySchema.parse({
          kind: "unavailable",
          reason_code: "startup_failed",
        });
        this.aiStartResult = undefined;
        this.codexAuthenticationRequired = false;
        this.publishAiStatus();
      },
      verifyCapabilities: (signal) => this.verifyConfiguredCodexCapabilities(signal),
    });
    this.asanaReauthentication = new AsanaReauthenticationRuntime<
      DeviceSettings,
      IpcAsanaReauthenticationCompleteInput,
      IpcAsanaReauthenticationCancelInput,
      IpcAsanaAuthenticationState,
      AsanaSyncCoordinatorResult
    >({
      requireSettings: () => this.requireConfiguredDeviceSettings(),
      validateAbortSignal,
      throwIfAborted,
      parseCompleteInput: (input) => ipcAsanaCompleteReauthenticationInputSchema.parse(input),
      parseCancelInput: (input) => ipcAsanaCancelReauthenticationInputSchema.parse(input),
      readOAuthState: () => oauthOutOfBandStateSchema.parse(this.oauth.getOutOfBandState()),
      beginOAuth: async (clientId, signal) => oauthOutOfBandBeginResultSchema.parse(
        await this.oauth.beginOutOfBandReauthentication({ client_id: clientId }, signal),
      ),
      completeOAuth: async (input, signal) => asanaOAuthCoordinatorResultSchema.parse(
        await this.oauth.completeOutOfBandAuthorization(input, signal),
      ),
      cancelOAuth: (authorizationId) =>
        this.oauth.cancelOutOfBandAuthorization({ authorization_id: authorizationId }),
      parseAuthenticationState: (state) => ipcAsanaAuthenticationStateSchema.parse(state),
      createInProgressError: () => new AsanaOAuthOutOfBandAuthenticationInProgressError(),
      createAuthorizationIdMismatchError: () =>
        new AsanaOAuthOutOfBandAuthorizationIdMismatchError(),
      createNotPendingError: () => new AsanaOAuthOutOfBandNotPendingError(),
      invalidatePendingMutations: () => this.operationQueue.invalidatePendingMutations(
        "context_changed",
      ),
      expireExternalAgent: () => this.externalAgent.expireForContextChange(),
      enqueueContextChange: (signal, run) => this.operationQueue.enqueue({
        priority: "user",
        kind: "context_change",
        signal,
        run: (context) => run(context.signal),
      }),
      configureAsana: (settings) => this.configureAsanaFromSettings(settings),
      synchronize: async (signal) => {
        const synchronized = await this.synchronizationOperations.requireSynchronizedResult(
          this.requireRuntime().onOnline(signal),
        );
        await this.synchronizationOperations.afterSynchronizedState(synchronized, signal);
        return synchronized.result;
      },
      restoreContext: () => this.configureContextFromState(this.setup.getState()),
    });
    this.operationalServices = new OperationalServicesRuntime<
      OperationalContext,
      DeviceSettings,
      AsanaSyncRuntime,
      AsanaDisplayOrderService,
      AsanaProposalOperationWriter,
      AsanaProposalApplicationCoordinator,
      AsanaGuiEditService
    >({
      assertSetupReady: () => this.assertSetupReady(),
      requireContext: () => this.requireContext(),
      getSettings: () => this.operationalContext.getSettings(),
      contextMatchesSettings,
      onlineProvider: () => this.options.online_provider(),
      createRuntime: (context, online) => new AsanaSyncRuntime(
        this.syncCoordinator,
        this.database.taskRead,
        {
          project_gid: context.project_gid,
          section_gids: context.section_gids,
          device_id: context.device_id,
          app_version: this.options.app_version,
          initial_online: online,
        },
        this.options.lifecycle_signal,
        (signal) => this.synchronizationOperations.beforeSynchronization(signal),
        (error) => this.recordUnexpectedError(error, "sync"),
        this.options.unhandled_error_forwarder,
        () => createNowIso(this.options.now_provider),
        this.operationQueue,
      ),
      subscribeRuntime: (runtime) => this.taskRead.subscribeRuntime(runtime),
      createDisplayOrder: () => createAsanaDisplayOrderService(
        this.transport,
        (error) => this.recordUnexpectedError(error, "display_order"),
        this.options.lifecycle_signal,
        this.operationQueue,
      ),
      createWriter: () => new AsanaProposalOperationWriter(
        this.interactiveReadClient,
        this.interactiveWriteClient,
      ),
      createCoordinator: (writer) => new AsanaProposalApplicationCoordinator(
        this.interactiveReadClient,
        writer,
        this.database,
        options.create_id,
        () => createNowIso(this.options.now_provider),
        (requiredTaskGids, signal) =>
          this.synchronizationOperations.afterAiApply(requiredTaskGids, signal),
        (error, event) => this.options.diagnostic(error, "application_journal", event),
      ),
      createGuiEdit: (writer) => new AsanaGuiEditService(
        writer,
        (requiredTaskGids, signal) =>
          this.synchronizationOperations.afterGuiEdit(requiredTaskGids, signal),
        () => this.isOnline(),
        (request, signal) => this.validateRelationGraph(request, signal),
        {
          getTask: (taskGid, signal) => this.interactiveReadClient.getTask(taskGid, signal),
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
        options.create_id,
        (error) => this.options.diagnostic(error, "gui_edit", serviceErrorDiagnostic),
      ),
    });
    this.lifecycleRuntime = new MainLifecycleRuntime<
      SetupState,
      ApplicationState,
      AsanaSyncRuntimeInternalResult
    >({
      validateAbortSignal,
      throwIfAborted,
      initializeExternalAgentBridge: () => this.initializeExternalAgentBridge(),
      ensureTasksVaultMapping: async (signal) => {
        const hasTasksVaultMapping = this.database.getVaultMappings().some(
          (mapping) => mapping.vault_id === "tasks",
        );
        if (!hasTasksVaultMapping) {
          const tasksVaultDiscovery = await discoverTasksVault(signal);
          if (tasksVaultDiscovery.kind === "found") {
            throwIfAborted(signal);
            this.database.saveVaultMapping(tasksVaultDiscovery.mapping);
            this.updateCodexVaultPaths();
          }
        }
      },
      recordDiagnostic: (code) => this.recordDiagnostic(code, "info"),
      reconcileExternalTools: (signal) => this.externalTools.reconcileAtStartup(signal),
      getSetupState: () => this.setup.getState(),
      isOnline: () => this.isOnline(),
      restoreReadyDeviceSettings: () => this.configureAsanaFromSettings(
        this.setup.restoreReadyDeviceSettings(),
      ),
      startSetup: (signal) => this.setup.start(signal),
      restoreCodexSession: (signal) => this.restorePersistedCodexSession(signal),
      isContextState,
      resumeSetup: (state, signal) => this.resumeSetupAtStartup(state, signal),
      configureAsanaFromStoredSettings: () => this.configureAsanaFromSettings(
        this.database.getDeviceSettings(),
      ),
      configureContextFromState: (state) => this.configureContextFromState(state),
      getApplicationState: () => this.getState(),
      configureOperationalServices: () => this.configureOperationalServices(),
      requireRuntime: () => this.requireRuntime(),
      recoverJournal: (signal) => this.journalRecovery.recover(signal),
      rethrowFeatureAbort: (error, signal) => this.rethrowFeatureAbort(error, signal),
      recordJournalRecoveryFailure: (error) => this.recordFeatureFailure(
        error,
        "application_journal",
        "未完了のAI適用ジャーナルを起動同期前に復旧できませんでした。",
      ),
      ensureCodexLaunch: (signal) => this.configuredCodexRuntime.ensureLaunchAttempt(signal),
      isSynchronizedResult: (
        result,
      ): result is Extract<AsanaSyncRuntimeInternalResult, { kind: "synchronized" }> =>
        result.kind === "synchronized",
      afterSynchronizedState: (result, signal) =>
        this.synchronizationOperations.afterSynchronizedState(result, signal),
      stopOAuthAuthorization: () => this.oauth.stopOutOfBandAuthorization(),
      stopExternalConfiguration: (errors) => this.externalTools.stopConfiguration(errors),
      externalAgent: this.externalAgent,
      externalAgentBridge: this.externalAgentBridge,
      stopSyncSubscriptions: () => this.taskRead.stop(),
      clearAiListeners: () => {
        this.aiDeltaListeners.clear();
        this.aiStatusListeners.clear();
      },
      closeAiSessions: (errors) => this.aiRuntime.closeAll(errors),
      displayOrder: () => this.operationalServices.getDisplayOrder(),
      runtime: () => this.operationalServices.getRuntime(),
      operationQueue: this.operationQueue,
      stopCodexSession: () => this.codexSession.stop({ kind: "record" }),
      externalBroker: () => this.externalTools.brokerForStop(),
      markExternalStopped: () => this.externalTools.markStopped(),
      combineFailures: (errors) => combineDiagnosticFailures(errors),
    });
    this.codexAvailability = contextFromState(this.setup.getState())?.codex;
    this.configureAsanaFromSettings(this.operationalContext.getSettings());
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
    return this.lifecycleRuntime.start(signal);
  }

  /** Electron終了時に全サービスを停止します。 */
  public stop(): Promise<void> {
    return this.lifecycleRuntime.stop();
  }

  /** IPCへ公開するアプリケーションサービスのポートを取得します。 */
  public getIpcPorts(): IpcServicePorts {
    return {
      asana: this.createAsanaPort(),
      setup: this.createSetupPort(),
      gui: this.createGuiPort(),
      externalAgent: this.createExternalAgentPort(),
      ai: this.createAiPort(),
      obsidian: this.createObsidianPort(),
    };
  }

  /** Electronのフォアグラウンド復帰を同期へ渡します。 */
  public async onForeground(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    this.assertOperationalReady();
    this.assertAsanaReauthenticationIdle();
    const runtime = this.requireRuntime();
    const result = await this.synchronizationOperations.requireSynchronizedResult(runtime.onForeground(signal));
    await this.synchronizationOperations.afterSynchronizedState(result, signal);
  }

  /** Electronのオンライン復帰を同期へ渡します。 */
  public async onOnline(): Promise<void> {
    this.assertOperationalReady();
    this.assertAsanaReauthenticationIdle();
    const runtime = this.requireRuntime();
    const result = await runtime.onOnline(this.options.lifecycle_signal);
    if (result.kind === "synchronized") {
      await this.synchronizationOperations.afterSynchronizedState(result, this.options.lifecycle_signal);
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
    const runtime = this.operationalServices.getRuntime();
    if (runtime == null) {
      return;
    }
    runtime.setOnline(online);
  }

  /** 設定済みAsana OAuthの認証状態を取得します。 */
  public getAsanaAuthenticationState(): IpcAsanaAuthenticationState {
    return this.asanaReauthentication.getState();
  }

  /** 設定済みAsana OAuthのOut-of-Band再認証を開始します。 */
  public beginAsanaReauthentication(signal: AbortSignal): Promise<IpcAsanaAuthenticationState> {
    return this.asanaReauthentication.begin(signal);
  }

  /** 設定済みAsana OAuthのOut-of-Band再認証を完了します。 */
  public completeAsanaReauthentication(
    input: IpcAsanaReauthenticationCompleteInput,
    signal: AbortSignal,
  ): Promise<AsanaSyncCoordinatorResult> {
    return this.asanaReauthentication.complete(input, signal);
  }

  /** 設定済みAsana OAuthのOut-of-Band再認証を取り消します。 */
  public cancelAsanaReauthentication(
    input: IpcAsanaReauthenticationCancelInput,
    signal: AbortSignal,
  ): IpcAsanaAuthenticationState {
    return this.asanaReauthentication.cancel(input, signal);
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
    return identifierSchema.parse(this.options.create_id());
  }

  private configureAsanaFromSettings(settings: DeviceSettings | undefined): void {
    this.operationalContext.configureAsanaFromSettings(settings);
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
    this.operationalContext.configureFromState(state);
  }

  private configureOperationalServices(): void {
    this.operationalServices.configure();
  }

  private rethrowFeatureAbort(error: unknown, signal: AbortSignal): void {
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

  private recordFeatureFailure(
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

  private recordCodexKnownFailure(error: unknown, message: string): void {
    try {
      this.recordFeatureFailure(error, "codex", message);
    } catch (diagnosticError: unknown) {
      throw combineDiagnosticFailures([error, diagnosticError]);
    }
  }

  private async detectCodexSafely(
    signal: AbortSignal,
  ): Promise<SetupCodexAvailability> {
    if (this.externalTools.codexDisabledBySafety()) {
      return setupCodexAvailabilitySchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
    }
    let availability: SetupCodexAvailability;
    const knownFailureCapture: { value: CodexKnownFailureCapture } = {
      value: { kind: "none" },
    };
    try {
      availability = setupCodexAvailabilitySchema.parse(
        await this.codexAdapter.detectCli(signal, (error) => {
          knownFailureCapture.value = { kind: "captured", error };
        }),
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
    const knownFailure = knownFailureCapture.value;
    if (knownFailure.kind === "captured") {
      this.recordCodexKnownFailure(
        knownFailure.error,
        "Codex CLIを利用できないためAI機能を無効にしました。",
      );
    }
    return availability;
  }

  private async getCodexAuthenticationStateSafely(
    signal: AbortSignal,
  ): Promise<CodexAuthenticationState> {
    if (this.externalTools.codexDisabledBySafety()) {
      return codexAuthenticationStateSchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
    }
    let state: CodexAuthenticationState;
    const knownFailureCapture: { value: CodexKnownFailureCapture } = {
      value: { kind: "none" },
    };
    try {
      state = codexAuthenticationStateSchema.parse(
        await this.codexAdapter.getAuthenticationState(signal, (error) => {
          knownFailureCapture.value = { kind: "captured", error };
        }),
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
    const knownFailure = knownFailureCapture.value;
    if (knownFailure.kind === "captured") {
      this.recordCodexKnownFailure(
        knownFailure.error,
        "Codex認証状態を利用できないためAI機能を無効にしました。",
      );
    }
    return state;
  }

  private async completeCodexAuthenticationSafely(
    signal: AbortSignal,
  ): Promise<CodexAuthenticationState> {
    if (this.externalTools.codexDisabledBySafety()) {
      return codexAuthenticationStateSchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
    }
    let authenticationState: CodexAuthenticationState;
    const knownFailureCapture: { value: CodexKnownFailureCapture } = {
      value: { kind: "none" },
    };
    try {
      authenticationState = codexAuthenticationStateSchema.parse(
        await this.codexAdapter.completeAuthentication(signal, (error) => {
          knownFailureCapture.value = { kind: "captured", error };
        }),
      );
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      this.recordFeatureFailure(
        error,
        "codex",
        "Codex再認証に失敗したためAI機能を無効にしました。",
      );
      return codexAuthenticationStateSchema.parse({
        kind: "unavailable",
        reason_code: "startup_failed",
      });
    }
    const knownFailure = knownFailureCapture.value;
    if (knownFailure.kind === "captured") {
      this.recordCodexKnownFailure(
        knownFailure.error,
        "Codex再認証を完了できないためAI機能を無効にしました。",
      );
    }
    return authenticationState;
  }

  private async checkCodexCapabilitiesSafely(
    signal: AbortSignal,
  ): Promise<SetupCodexAvailability> {
    if (this.externalTools.codexDisabledBySafety()) {
      return setupCodexAvailabilitySchema.parse({
        kind: "unavailable",
        reason_code: "disabled",
      });
    }
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
        reason_code: "startup_failed",
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

  private async resumeSetupAtStartup(
    state: SetupState,
    signal: AbortSignal,
  ): Promise<SetupState> {
    const validatedState = setupStateSchema.parse(state);
    try {
      return setupStateSchema.parse(await this.setup.resume(signal));
    } catch (error: unknown) {
      this.rethrowFeatureAbort(error, signal);
      if (
        validatedState.kind !== "ready"
        || !canResumeReadyStateAfterRevalidationFailure(error)
      ) {
        throw error;
      }
      this.recordFeatureFailure(
        error,
        "sync",
        "保存済み初回設定をAsanaと再照合できないためキャッシュ表示で起動します。",
      );
      return validatedState;
    }
  }

  private async restorePersistedCodexSession(
    signal: AbortSignal,
  ): Promise<SetupState> {
    const recheckedState = setupStateSchema.parse(
      await this.setup.recheckPersistedCodex(signal),
    );
    const availability = codexAvailabilityFromState(recheckedState);
    this.codexAvailability = availability;
    if (availability == null) {
      return recheckedState;
    }
    if (
      recheckedState.kind !== "ready"
      && availability.kind === "unavailable"
    ) {
      return recheckedState;
    }
    await this.configuredCodexRuntime.ensureLaunchAttempt(signal);
    const currentAvailability = this.codexAvailability;
    if (currentAvailability == null) {
      return recheckedState;
    }
    if (
      currentAvailability.kind === "unavailable"
      || (
        availability.kind === "unavailable"
        && currentAvailability.kind === "available"
      )
    ) {
      return setupStateSchema.parse(
        this.setup.updateCodexAvailability(currentAvailability),
      );
    }
    return recheckedState;
  }

  private recordUnexpectedError(error: unknown, channel: string): void {
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

  private setCodexExternalSocketPaths(paths: readonly string[]): void {
    switch (this.codexSession.getState()) {
      case "created":
      case "authentication_required":
      case "ready":
        this.codexSession.setAdditionalLocalSocketPaths(paths);
        return;
      case "disabled":
      case "failed":
      case "stopped":
        return;
      case "starting":
      case "turning":
      case "restarting":
      case "stopping":
        throw new Error("Codex処理中は外部ツールIPC許可を変更できません。");
    }
  }

  private async disableCodexForExternalToolSafety(
    errors: unknown[],
  ): Promise<void> {
    this.codexAvailability = setupCodexAvailabilitySchema.parse({
      kind: "unavailable",
      reason_code: "disabled",
    });
    this.aiStartResult = undefined;
    this.codexAuthenticationRequired = false;
    this.configuredCodexRuntime.settleLaunch();
    const sessionState = this.codexSession.getState();
    if (sessionState !== "disabled" && sessionState !== "stopped") {
      try {
        await this.codexSession.stop({ kind: "record" });
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      this.publishAiStatus();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  private createExternalToolBroker(
    registry: ExternalToolRegistry,
    tmpDirectoryPath: string,
    statusEvidenceCollector: ExternalToolStatusEvidenceCollector,
  ): ExternalToolBroker {
    return new ExternalToolBroker({
      tmp_directory_path: tmpDirectoryPath,
      registry,
      discord_credential_provider:
        new SecretStorageDiscordCredentialProvider(this.secretStorage),
      status_evidence_collector: statusEvidenceCollector,
    });
  }

  private persistDiscordExternalToolConfiguration(
    definition: ExternalToolDefinition,
    botToken: string,
  ): ExternalToolPersistenceResult {
    let secrets: SecretStorageData | undefined;
    try {
      secrets = this.secretStorage.load();
    } catch (error: unknown) {
      return { kind: "credential_storage_unavailable", error };
    }
    try {
      this.secretStorage.save({
        ...(secrets ?? {}),
        discord_bot_token: botToken,
      });
    } catch (error: unknown) {
      return { kind: "credential_storage_unavailable", error };
    }
    try {
      this.database.saveExternalToolDefinition(
        createExternalToolDefinitionRecord(definition),
      );
    } catch (databaseError: unknown) {
      if (secrets?.discord_bot_token == null) {
        return { kind: "startup_failed", error: databaseError };
      }
      try {
        this.secretStorage.save(secrets);
      } catch (restoreError: unknown) {
        return {
          kind: "recovery_required",
          error: new AggregateError(
            [databaseError, restoreError],
            "固定Discord定義の保存失敗後に既存Tokenを復元できませんでした。",
            { cause: databaseError },
          ),
        };
      }
      return { kind: "startup_failed", error: databaseError };
    }
    return { kind: "saved" };
  }

  private async configureDiscordExternalTool(
    input: SetupDiscordExternalToolConfigurationInput,
    signal: AbortSignal,
  ): Promise<SetupExternalToolConfigurationResult> {
    const configuration =
      setupDiscordExternalToolConfigurationInputSchema.parse(input);
    return this.externalTools.configureDiscord(configuration, signal);
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
    const result = await this.operationQueue.enqueue({
      priority: "user",
      kind: "synchronization",
      signal,
      run: (context) => this.syncCoordinator.coordinate(
        {
          mode: "full",
          project_gid: validatedInput.project_gid,
          section_gids: validatedInput.section_gids,
          device_id: validatedInput.device_id,
          app_version: this.options.app_version,
          required_task_gids: [],
        },
        context.signal,
      ),
    });
    if (result.performed_mode !== "full") {
      throw new Error("初回設定のフル同期が完全同期を返しませんでした。");
    }
    await this.afterLocalStateRefresh(signal);
    this.recordDiagnostic("sync.completed", "info");
  }

  private requireConfiguredDeviceSettings(): DeviceSettings {
    return this.operationalContext.requireConfiguredSettings();
  }

  private assertSetupReady(): void {
    if (this.setup.getState().kind !== "ready") {
      throw new Error("初回設定が完了するまで運用機能を利用できません。");
    }
  }

  private assertOperationalReady(): void {
    this.assertSetupReady();
    if (!this.lifecycleRuntime.isReadyActivated()) {
      throw new Error("運用機能の起動が完了していません。");
    }
  }

  private requireRuntime(): AsanaSyncRuntime {
    return this.operationalServices.requireRuntime();
  }

  private requireContext(): OperationalContext {
    return this.operationalContext.requireContext();
  }

  private requireWriter(): AsanaProposalOperationWriter {
    return this.operationalServices.requireWriter();
  }

  private requireApplicationCoordinator(): AsanaProposalApplicationCoordinator {
    return this.operationalServices.requireCoordinator();
  }

  private async initializeExternalAgentBridge(): Promise<void> {
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

  private async startCodexForConfigured(signal: AbortSignal): Promise<void> {
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

  private async afterLocalStateRefresh(signal: AbortSignal): Promise<void> {
    const tasks = parseTaskCache(this.database.getTaskCache())
      .map((entry) => taskSchema.parse(entry.task));
    await this.cleanupAggregation.replaceBrokenVaultLinksFromTasks(
      tasks,
      signal,
    );
    signal.throwIfAborted();
    const displayOrder = this.operationalServices.getDisplayOrder();
    if (displayOrder == null) {
      return;
    }
    const expectedContext = this.requireContext();
    void displayOrder.requestLatest(
      async (operationSignal) => {
        this.assertQueuedMutationReady();
        this.assertContextUnchanged(expectedContext);
        const input = await this.createDisplayOrderInput(operationSignal);
        this.assertContextUnchanged(expectedContext);
        return input;
      },
      signal,
    ).catch((error: unknown) => {
      if (
        !(error instanceof AsanaRequestAbortedError)
        && !(error instanceof AsanaOperationInvalidatedError)
      ) {
        this.recordUnexpectedError(error, "display_order");
      }
    });
  }

  private async createDisplayOrderInput(
    signal: AbortSignal,
  ): Promise<AsanaDisplayOrderInput> {
    const context = this.requireContext();
    const tasks = await this.readClient.listProjectTasks(context.project_gid, signal);
    const ranking = this.database.getRankingCache()?.ranked_tasks
      .map((task) => task.gid) ?? [];
    return asanaDisplayOrderInputSchema.parse(
      buildDisplayOrderInput(context, tasks, ranking),
    );
  }

  private createTaskctlSnapshot(): TaskctlSnapshot {
    const context = this.operationalContext.getContext();
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

  private createAiSnapshot(
    signal: AbortSignal,
    baselineStore: AiSessionBaselineStore,
  ): Promise<AiWorkflowSnapshot> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const expectedContext = this.requireContext();
    if (this.operationQueue.hasOwner(signal)) {
      return this.operationQueue.runOwned(signal, (context) =>
        this.createAiSnapshotOwned(context.signal, baselineStore),
      );
    }
    return this.operationQueue.enqueue({
      priority: "user",
      kind: "ai_snapshot",
      signal,
      beforeStart: () => {
        this.assertQueuedMutationReady();
        this.assertContextUnchanged(expectedContext);
      },
      run: (context) => this.createAiSnapshotOwned(context.signal, baselineStore),
    });
  }

  private createExternalBaseline(
    signal: AbortSignal,
  ): Promise<ExternalAgentBaseline> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const expectedContext = this.requireContext();
    if (this.operationQueue.hasOwner(signal)) {
      return this.operationQueue.runOwned(signal, (context) =>
        this.createExternalBaselineOwned(context.signal),
      );
    }
    return this.operationQueue.enqueue({
      priority: "user",
      kind: "external_snapshot",
      signal,
      beforeStart: () => {
        this.assertOperationalReady();
        this.assertAsanaReauthenticationIdle();
        if (!this.isOnline()) {
          throw new Error("オフライン中は外部提案の基準値を取得できません。");
        }
        this.assertAsanaOperationContextUnchanged(expectedContext);
      },
      run: (context) => this.createExternalBaselineOwned(context.signal),
    });
  }

  private createExternalBaselineOwned(
    signal: AbortSignal,
  ): ExternalAgentBaseline {
    const baseline = this.captureProposalBaselineOwned(signal, "external");
    throwIfAborted(signal);
    const taskctlSnapshot = this.createTaskctlSnapshot();
    throwIfAborted(signal);
    if (
      taskctlSnapshot.sync.kind !== "synced"
      || taskctlSnapshot.sync.synced_at !== baseline.snapshot.synced_at
      || canonicalizeJson(taskctlSnapshot.tasks) !== canonicalizeJson(baseline.snapshot.tasks)
    ) {
      throw new Error("外部提案の基準値とtaskctl基準値が一致しません。");
    }
    return { ...baseline, taskctl_snapshot: taskctlSnapshot };
  }

  private createAiSnapshotOwned(
    signal: AbortSignal,
    baselineStore: AiSessionBaselineStore,
  ): AiWorkflowSnapshot {
    const baseline = this.captureProposalBaselineOwned(signal, "ai");
    throwIfAborted(signal);
    baselineStore.taskctlSnapshot = this.createTaskctlSnapshot();
    const baselineKey = canonicalizeJson(baseline.baseline_snapshot);
    baselineStore.externalData.set(
      baselineKey,
      baseline.baseline_external_data,
    );
    baselineStore.currentTurnKeys.add(baselineKey);
    return baseline.snapshot;
  }

  private captureProposalBaselineOwned(
    signal: AbortSignal,
    purpose: "ai" | "external",
  ): Omit<ExternalAgentBaseline, "taskctl_snapshot"> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const context = this.requireContext();
    const syncState = this.database.getSyncState(context.project_gid);
    if (syncState?.last_successful_sync_at == null) {
      throw new Error(
        purpose === "ai"
          ? "AIターンに必要な同期済み時刻がありません。"
          : "外部提案に必要な同期済み時刻がありません。",
      );
    }
    const metadata = this.database.getProjectMetadataCache(context.project_gid);
    if (metadata == null) {
      throw new Error(
        purpose === "ai"
          ? "AIターンに必要なAsanaメタデータがありません。"
          : "外部提案に必要なAsanaメタデータがありません。",
      );
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
    throwIfAborted(signal);
    return {
      snapshot,
      baseline_snapshot: createBaselineSnapshot(snapshot),
      baseline_external_data: baselineExternalData,
    };
  }

  private requireAiTaskctlSnapshot(
    signal: AbortSignal,
    baselineStore: AiSessionBaselineStore,
  ): TaskctlSnapshot {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const snapshot = baselineStore.taskctlSnapshot;
    if (snapshot == null) {
      throw new Error("AIターンのtaskctl基準スナップショットがありません。");
    }
    return snapshot;
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
    const baselineExternalData = input.baseline_external_data;
    const baselineTasks = baseline.tasks.map((task) => taskSchema.parse(task));
    const currentResponses = await collectApprovalProjectTasks(context.project_gid, signal, {
      gidSchema,
      taskSchema: asanaTaskResponseSchema,
      source: this.interactiveReadClient,
      canonicalizeJson,
    });
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
      proposal_id: identifierSchema.parse(input.proposal_id),
      project_gid: context.project_gid,
      workspace_gid: context.workspace_gid,
      section_gids: context.section_gids,
      device_id: context.device_id,
      created_via: identifierSchema.parse(input.created_via),
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
    const tasks = parseTaskCache(this.database.getTaskCache())
      .map((entry) => taskSchema.parse(entry.task));
    const result = validateRelationGraph(request, tasks, (projected) =>
      normalizeTaskGraph({ tasks: projected, inaccessible_gids: [] }));
    return Promise.resolve(result);
  }

  private assertWritesAllowed(): void {
    this.assertOperationalReady();
    this.assertAsanaReauthenticationIdle();
    const synchronizationState = this.requireRuntime().getState();
    if (
      synchronizationState.kind !== "online"
      || synchronizationState.last_error_code != null
    ) {
      throw new Error("Asana同期が正常なオンライン状態になるまで書き込みを開始できません。");
    }
    if (
      this.journalRecovery.hasPending()
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

  private assertQueuedMutationReady(): void {
    this.assertWritesAllowed();
    if (!this.isOnline()) {
      throw new Error("オフライン中はAsana変更操作を開始できません。");
    }
  }

  private assertMutationRequestAccepted(): void {
    this.assertOperationalReady();
    this.assertAsanaReauthenticationIdle();
    if (!this.isOnline()) {
      throw new Error("オフライン中はAsana変更操作を受け付けられません。");
    }
    const synchronizationState = this.requireRuntime().getState();
    if (synchronizationState.kind !== "syncing") {
      if (synchronizationState.last_successful_sync_at == null) {
        throw new Error("初回同期が完了するまで変更操作を受け付けられません。");
      }
      this.assertWritesAllowed();
      return;
    }
    if (synchronizationState.last_successful_sync_at == null) {
      throw new Error("初回同期が完了するまで変更操作を受け付けられません。");
    }
    if (synchronizationState.last_error_code != null) {
      throw new Error("Asana同期エラーを解消するまで変更操作を受け付けられません。");
    }
    if (
      this.journalRecovery.hasPending()
      || this.database.getIncompleteApplicationJournals().length > 0
    ) {
      throw new Error("未完了のAI適用ジャーナルを復旧するまで変更操作を受け付けられません。");
    }
    const blocked = this.database.getCleanupItems()?.some(
      (item) => item.kind === "oauth_app_mismatch" && item.task_gid == null,
    ) ?? false;
    if (blocked) {
      throw new Error(
        "同一のAsana OAuthアプリ設定を確認するまで変更操作を受け付けられません。",
      );
    }
  }

  private assertAiProposalOperationAvailable(record: AiSessionRecord): void {
    if (record.turnInFlight || record.approvalInFlight) {
      throw new Error("同じAIセッションでAI操作実行中は変更案を操作できません。");
    }
  }

  private assertContextUnchanged(expected: OperationalContext): void {
    const current = this.requireContext();
    if (canonicalizeJson(current) !== canonicalizeJson(expected)) {
      throw new AsanaOperationInvalidatedError("context_changed");
    }
  }

  private assertAsanaOperationContextUnchanged(expected: OperationalContext): void {
    const current = this.requireContext();
    if (asanaOperationContextKey(current) !== asanaOperationContextKey(expected)) {
      throw new AsanaOperationInvalidatedError("context_changed");
    }
  }

  private assertAsanaReauthenticationIdle(): void {
    this.asanaReauthentication.assertIdle();
  }

  private createAsanaPort(): IpcAsanaPort {
    return {
      getAuthenticationState: () => this.getAsanaAuthenticationState(),
      beginReauthentication: (signal) => this.beginAsanaReauthentication(signal),
      completeReauthentication: (input, signal) =>
        this.completeAsanaReauthentication(input, signal),
      cancelReauthentication: (input, signal) =>
        this.cancelAsanaReauthentication(input, signal),
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

  private resetAiSessionWithdrawConfirmations(): void {
    for (const record of this.aiRuntime.activeSessions()) {
      record.workflow.resetPendingWithdrawConfirmation();
    }
  }

  private async refreshCodexThreadIfReady(signal: AbortSignal): Promise<void> {
    if (this.codexSession.getState() !== "ready") {
      return;
    }
    this.aiStartResult = await this.codexSession.startNewSession(signal);
    this.resetAiSessionWithdrawConfirmations();
    this.codexAuthenticationRequired = false;
    this.publishAiStatus();
  }

  private async refreshCodexThreadAfterExternalToolCommit(
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.refreshCodexThreadIfReady(signal);
    } catch (error: unknown) {
      const errors: unknown[] = [error];
      try {
        const deactivation = await this.externalTools.deactivateInternal(
          "startup_failed",
          new AbortController().signal,
        );
        if (deactivation.kind === "unavailable") {
          return;
        }
      } catch (deactivationError: unknown) {
        errors.push(deactivationError);
      }
      await this.externalTools.enterRecovery(
        "startup_failed",
        this.externalTools.currentRecoveryBroker(),
        errors,
        "確定済み外部ツール設定のCodex反映に失敗したためAI機能を無効にしました。",
      );
    }
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
          if (!this.lifecycleRuntime.isReadyActivated()) {
            await this.lifecycleRuntime.activateReady(signal);
          } else {
            await this.verifyConfiguredCodexCapabilities(signal);
          }
        }
        return state;
      },
      beginAsanaAuthorization: async (input, signal) =>
        this.configureAfterSetupTransition(
          await this.setup.beginAsanaAuthorization(input, signal),
        ),
      completeAsanaAuthorization: async (input, signal) =>
        this.configureAfterSetupTransition(
          await this.setup.completeAsanaAuthorization(input, signal),
        ),
      cancelAsanaAuthorization: (input, signal) =>
        this.configureAfterSetupTransition(
          this.setup.cancelAsanaAuthorization(input, signal),
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
      chooseExternalTool: (input, signal) =>
        this.externalTools.runConfigurationOperation(
          signal,
          async (operationSignal) => {
            const state = this.configureAfterSetupTransition(
              await this.setup.chooseExternalTool(input, operationSignal),
            );
            if (state.kind === "external_tool_configured") {
              const selection = setupExternalToolSelectionSchema.parse({
                kind: "configured",
                tool_id: state.tool_id,
                allowed_channel_ids: state.allowed_channel_ids,
              });
              if (selection.kind !== "configured") {
                throw new Error("確定済み固定Discord選択を取得できません。");
              }
              const activation = await this.externalTools.initialize(
                selection,
                operationSignal,
              );
              if (activation.kind === "unavailable") {
                await this.externalTools.markUnavailableSafely(
                  activation.reason_code,
                  new Error("確定済み固定Discord連携を有効化できませんでした。"),
                );
                return this.configureAfterSetupTransition(
                  this.setup.getState(),
                );
              }
              await this.refreshCodexThreadAfterExternalToolCommit(
                operationSignal,
              );
            }
            return state;
          },
        ),
      runFullSync: async (signal) => this.configureAfterSetupTransition(
        await this.setup.runFullSync(signal),
      ),
      runCodexCapability: async (signal) => {
        const state = this.configureAfterSetupTransition(
          await this.setup.runCodexCapabilityCheck(signal),
        );
        if (state.kind === "ready") {
          await this.lifecycleRuntime.activateReady(signal);
        }
        return state;
      },
    };
  }

  private requireGuiEdit(): AsanaGuiEditService {
    return this.operationalServices.requireGuiEdit();
  }

  private createGuiPort(): IpcGuiEditPort {
    return {
      apply: async (input: IpcGuiRequest, signal): Promise<IpcGuiEditResult> => {
        const request = ipcGuiEditInputSchema.parse(input);
        this.assertMutationRequestAccepted();
        const context = this.requireContext();
        try {
          const result = await this.operationQueue.enqueue({
            priority: "user",
            kind: "gui_edit",
            signal,
            beforeStart: () => {
              this.assertQueuedMutationReady();
              this.assertContextUnchanged(context);
            },
            run: (operationContext) => {
              const baseline = this.database.getTaskCacheEntry(request.task_gid);
              if (baseline == null) {
                return this.createGuiRejectedResult(
                  request.task_gid,
                  "task_missing",
                );
              }
              const baselineTask = asanaTaskResponseSchema.parse(
                baseline.asana_response,
              );
              if (hashGuiEditBaseline(baselineTask) !== request.expected_task_hash) {
                return this.createGuiRejectedResult(
                  request.task_gid,
                  "baseline_changed",
                );
              }
              const guiInput: AsanaGuiEditInput = {
                task_gid: request.task_gid,
                project_gid: context.project_gid,
                workspace_gid: context.workspace_gid,
                section_gids: context.section_gids,
                device_id: context.device_id,
                created_via: "gui",
                activity_date: todayJst(this.options.now_provider),
                baseline_task: baselineTask,
                operation: request.operation,
              };
              return this.requireGuiEdit().apply(
                guiInput,
                operationContext.signal,
              );
            },
          });
          return ipcGuiEditResultSchema.parse(result);
        } catch (error: unknown) {
          if (error instanceof AsanaOperationInvalidatedError) {
            return this.createGuiRejectedResult(
              request.task_gid,
              error.reason,
            );
          }
          throw error;
        }
      },
    };
  }

  private createExternalAgentPort(): IpcExternalAgentPort {
    return this.externalAgent;
  }

  private assertVaultMappingSaveAllowed(): void {
    if (this.lifecycleRuntime.isStopped()) {
      throw new ObsidianVaultMappingConflictError();
    }
    if (
      this.externalTools.isConfigurationRunning()
      || this.aiRuntime.hasActiveSessions()
    ) {
      throw new ObsidianVaultMappingConflictError();
    }
    const codexState = this.codexSession.getState();
    if (
      codexState !== "created"
      && codexState !== "authentication_required"
      && codexState !== "ready"
      && codexState !== "disabled"
    ) {
      throw new ObsidianVaultMappingConflictError();
    }
  }

  private async saveVaultMapping(
    input: IpcObsidianVaultMapping,
    signal: AbortSignal,
  ): Promise<IpcObsidianVaultMappings> {
    this.assertOperationalReady();
    validateAbortSignal(signal);
    throwIfAborted(signal);
    if (this.vaultMappingSaveInProgress) {
      throw new ObsidianVaultMappingConflictError();
    }
    this.assertVaultMappingSaveAllowed();
    this.vaultMappingSaveInProgress = true;
    try {
      const requestedMapping = vaultMappingSchema.parse(input);
      const validatedVault = await validateVaultMappingPath(requestedMapping, signal);
      throwIfAborted(signal);
      this.assertOperationalReady();
      this.assertVaultMappingSaveAllowed();
      const mapping = vaultMappingSchema.parse({
        vault_id: validatedVault.vault_id,
        absolute_path: validatedVault.real_path,
      });
      this.database.saveVaultMapping(mapping);
      this.updateCodexVaultPaths();
      return this.database.getVaultMappings();
    } finally {
      this.vaultMappingSaveInProgress = false;
    }
  }

  private createGuiRejectedResult(
    taskGid: string,
    reasonCode:
      | "offline"
      | "baseline_changed"
      | "task_missing"
      | "synchronization_failed"
      | "context_changed",
  ): IpcGuiEditResult {
    return ipcGuiEditResultSchema.parse({
      operation_id: this.options.create_id(),
      task_gid: taskGid,
      outcome: "rejected",
      reason_code: reasonCode,
    });
  }

  private currentAiStatus(): IpcAiStatus {
    if (this.lifecycleRuntime.isStopped() || this.codexSession.getState() === "stopped") {
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
    if (this.codexAuthenticationRequired || this.aiStartResult?.state === "authentication_required") {
      return ipcAiStatusEventSchema.parse({ kind: "authentication_required" });
    }
    const model = this.codexAdapter.getReadyModel();
    if (model != null && isReadyCodexResult(this.aiStartResult)) {
      return ipcAiStatusEventSchema.parse({
        kind: "ready",
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
        this.options.diagnostic(error, "ai_status_listener", serviceErrorDiagnostic);
      }
    }
  }

  private publishAiDelta(event: IpcCodexDelta): void {
    for (const listener of this.aiDeltaListeners) {
      try {
        listener(event);
      } catch (error: unknown) {
        this.options.diagnostic(error, "ai_delta_listener", serviceErrorDiagnostic);
      }
    }
  }

  private createAiSessionWorkspace(sessionId: string): CodexWorkspaceInitializationResult {
    const workspaceUserDataPath = createCodexSessionWorkspaceUserDataPath(
      this.aiSessionWorkspaceParentPath,
      sessionId,
    );
    return initializeCodexWorkspace({ userDataPath: workspaceUserDataPath });
  }

  private async prepareAiSessionExternalTools(
    workspace: CodexWorkspaceInitializationResult,
    signal: AbortSignal,
  ): Promise<AiSessionExternalToolResources> {
    const collector = new ExternalToolStatusEvidenceCollector();
    const registry = this.externalTools.readyRegistry();
    if (registry == null) {
      return { broker: undefined, collector, endpoint: undefined };
    }
    const broker = this.createExternalToolBroker(
      registry,
      workspace.tmpDirectoryPath,
      collector,
    );
    try {
      const startResult = await broker.start(signal);
      if (startResult.kind !== "ready") {
        throw new Error("AIセッションの外部ツールブローカーを起動できませんでした。");
      }
      const installation = installContextctlClientScript({
        workspacePath: workspace.workspacePath,
        connectionInfoPath: startResult.connection_info_path,
        toolDefinitions: [...registry.list()],
      });
      if (installation.kind !== "ready") {
        throw new Error("AIセッションの外部ツール連携を有効化できませんでした。");
      }
      return {
        broker,
        collector,
        endpoint: startResult.endpoint,
      };
    } catch (error: unknown) {
      try {
        await broker.stop();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "AIセッションの外部ツール起動後処理に失敗しました。",
          { cause: error },
        );
      }
      throw error;
    }
  }

  private createAiSessionService(
    workspace: CodexWorkspaceInitializationResult,
    externalToolEndpoint: string | undefined,
  ): CodexSessionService {
    return new CodexSessionService({
      codexExecutablePath: this.options.codex_executable,
      workspacePath: workspace.workspacePath,
      agentsFilePath: workspace.agentsFilePath,
      tmpDirectoryPath: workspace.tmpDirectoryPath,
      expectedCodexHomePathProvider: () => this.codexWorkspace.codexHomePath,
      obsidianReader: this.createCodexObsidianReadPort(),
      readOnlyVaultPaths: [...this.readOnlyVaultPaths()],
      additionalUnixSocketPaths: externalToolEndpoint == null
        ? []
        : [externalToolEndpoint],
      connectionFactory: this.codexConnectionFactory,
      onError: (error: unknown): void => {
        this.options.diagnostic(error, "codex", serviceErrorDiagnostic);
      },
      snapshotProvider: () => this.createTaskctlSnapshot(),
      syncBeforeTurn: (signal) => this.synchronizationOperations.requireSynchronizedBeforeAi(signal),
    });
  }

  private createAiWorkflow(
    session: CodexSessionService,
    externalStatusEvidenceCollector: ExternalToolStatusEvidenceCollector,
    baselineStore: AiSessionBaselineStore,
    sessionId: string,
  ): AiWorkflowService {
    const applicationCoordinator = this.requireApplicationCoordinator();
    return new AiWorkflowService({
      sessionId,
      session,
      snapshotProvider: (signal) => this.createAiSnapshot(signal, baselineStore),
      taskctlSnapshotProvider: (signal) =>
        this.requireAiTaskctlSnapshot(signal, baselineStore),
      baselineExternalDataProvider: (baseline) => {
        const value = baselineStore.externalData.get(canonicalizeJson(baseline));
        if (value == null) {
          throw new Error("AI変更案の基準Custom external dataが失効しています。");
        }
        return value;
      },
      externalStatusEvidenceCollector,
      applicationCoordinator: {
        apply: (input, signal) => this.applyProposalApplication(
          applicationCoordinator,
          input,
          signal,
        ),
      },
      prepareApprovalInput: (input, signal) =>
        this.prepareApprovalInput(input, signal),
      isOnline: () => this.isOnline(),
      logRetryEvent: (event) => this.recordAiWorkflowRetryEvent(event),
    });
  }

  private recordAiWorkflowRetryEvent(event: AiWorkflowRetryLogEvent): void {
    const validatedEvent = aiWorkflowRetryLogEventSchema.parse(event);
    const diagnostic = validatedEvent.severity === "warning"
      ? serviceWarningDiagnostic
      : serviceErrorDiagnostic;
    this.options.diagnostic(
      new AiWorkflowRetryLogEventError(validatedEvent),
      "codex",
      diagnostic,
    );
  }

  private async applyProposalApplication(
    applicationCoordinator: AsanaProposalApplicationCoordinator,
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<AsanaProposalApplicationCoordinator["apply"]>>> {
    return this.synchronizationOperations.applyProposal(
      signal,
      () => applicationCoordinator.apply(input, signal),
      (result) => this.cleanupAggregation.replaceProposalConflictsFromApplication(result),
    );
  }

  private applyExternalProposal(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    return this.applyProposalApplication(
      this.requireApplicationCoordinator(),
      input,
      signal,
    );
  }

  private createAiPort(): IpcAiPort {
    return {
      getStatus: () => {
        this.assertOperationalReady();
        return this.currentAiStatus();
      },
      startNewSession: (signal) => this.aiRuntime.startSession(signal),
      startTurn: (input, signal) => this.aiInteraction.startTurn(input, signal),
      getProposal: (input: IpcAiProposalInput) => {
        return this.aiInteraction.withProposalRecord(input, false, (record) =>
          aiWorkflowProposalViewSchema.parse(
            record.workflow.getProposal(identifierSchema.parse(input.proposal_id)),
          ));
      },
      select: (input: IpcAiSelectionInput) => {
        return this.aiInteraction.withProposalRecord(input, true, (record) =>
          aiWorkflowProposalViewSchema.parse(
            record.workflow.select(aiWorkflowSelectionRequestSchema.parse({
              proposal_id: input.proposal_id,
              selection: input.selection,
            })),
          ));
      },
      editOperation: (input: IpcAiEditInput) => {
        return this.aiInteraction.withProposalRecord(input, true, (record) =>
          aiWorkflowProposalViewSchema.parse(
            record.workflow.editOperation(aiWorkflowOperationEditSchema.parse({
              proposal_id: input.proposal_id,
              operation_id: input.operation_id,
              after: input.after,
              evidence_locator: input.evidence_locator,
            })),
          ));
      },
      reject: (input: IpcAiRejectInput) => {
        this.aiInteraction.withProposalRecord(input, true, (record) => {
          const validatedProposalId = identifierSchema.parse(input.proposal_id);
          record.workflow.rejectProposal(validatedProposalId);
          this.aiRuntime.forgetProposal(record, validatedProposalId);
        });
      },
      approve: (input, signal) => this.aiInteraction.approve(input, signal),
      closeSession: async (sessionId) => {
        const record = this.aiRuntime.requireSession(sessionId);
        await this.aiRuntime.closeRecord(record, "explicit");
        return { completed: true };
      },
      onDelta: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("AI差分の購読関数が必要です。");
        }
        this.aiDeltaListeners.add(listener);
        return (): void => {
          this.aiDeltaListeners.delete(listener);
        };
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
    return createObsidianPort({
      assertOperationalReady: () => this.assertOperationalReady(),
      validateAbortSignal,
      throwIfAborted,
      getVaultMappings: () => this.database.getVaultMappings(),
      saveVaultMapping: (input, signal) => this.saveVaultMapping(input, signal),
      validateVault: (vaultId, signal) => this.obsidian.validateVault(vaultId, signal),
      resolveRelativePath: (vaultId, relativePath, signal) =>
        this.obsidian.resolveRelativePath(vaultId, relativePath, signal),
      noteExists: (vaultId, relativePath, signal) =>
        this.obsidian.noteExists(vaultId, relativePath, signal),
      createOpenUri: createObsidianOpenUri,
      openObsidianUrl: (uri, signal) => this.options.open_obsidian_url(uri, signal),
    });
  }

  private createCodexObsidianReadPort(): CodexObsidianReadPort {
    return createCodexObsidianReadPort({
      validateAbortSignal,
      throwIfAborted,
      getVaultMappings: () => this.database.getVaultMappings(),
      listNotes: (vaultId, signal) => this.obsidian.listNotes(vaultId, signal),
      searchNotes: (vaultId, query, signal) =>
        this.obsidian.searchNotes(vaultId, query, signal),
      readNote: (vaultId, relativePath, signal) =>
        this.obsidian.readNote(vaultId, relativePath, signal),
      recentNotes: (vaultId, limit, signal) =>
        this.obsidian.recentNotes(vaultId, limit, signal),
    });
  }
}

/** 旧保存形式の移行処理を一時的な起動portへ渡します。 */
export function migrateLegacyStorage(database: SqliteConnection): void {
  migrateLegacyProposalConflictIdentifiers(database);
}
