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
  getUniqueAsanaHttpStatus,
  hasRestAsanaHttpError,
  type TokenProvider,
} from "../asana/transport";
import {
  AsanaReadClient,
  AsanaSetupClient,
  AsanaTaskWriteClient,
} from "../asana/client";
import {
  AsanaCapabilityCheckService,
  AsanaCapabilityCheckError,
  AsanaSetupResourceCoordinator,
  asanaSetupResourceCoordinatorResultSchema,
  capabilityCheckResultSchema,
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
import {
  combineDiagnosticFailures,
  DiagnosticFailureDispositionError,
  diagnosticFailureDispositionFromError,
} from "./common/errors/diagnostic-failure";
import type { TaskWriteAsanaBridge } from "./common/ports/asana-task-write";
import type { ProposalApplicationHistoryRepository } from "./common/ports/proposal-application-history";
import { CodexSetupAdapter } from "./codex-adapter";
import { CleanupAggregationService } from "./cleanup-aggregation";
import {
  DiagnosticLogService,
  type DiagnosticRecord,
  type ApplicationDiagnostic,
} from "./diagnostics";
import {
  AiWorkflowService,
  AiWorkflowError,
  AiWorkflowOfflineError,
  AiWorkflowRetryLogEventError,
  assertSelectedProposalGraphIsSafe,
  aiWorkflowRetryLogEventSchema,
  createBaselineSnapshot,
  resolveSelectedOperationIds,
  type AiWorkflowRetryLogEvent,
  type ApprovalPreparationInput,
} from "../ai/workflow";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  asanaProposalRecoveryResultSchema,
  asanaPostWriteSynchronizationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryResult,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResult,
  type PostWriteSynchronizationResultWithCause,
} from "./common/proposal-application-schemas";
import {
  ingestAsanaExternalData,
  normalizeAsanaSnapshot,
  normalizeTaskGraph,
} from "../domain";
import {
  classifyProposalConflicts,
  proposalApprovalResultSchema,
} from "../domain/proposal-analysis/conflict-classifier";
import { validateSelectedProposalGraph } from "../domain/proposal-analysis/graph";
import { createBaselineTaskSnapshots } from "./proposal-generate";
import {
  applyExistingStoredProposal,
  applyStoredProposal,
  approveStoredProposal,
  collectApprovalProjectTasks,
  createApplicationSummary,
  createApprovalPreparationInput,
  getStoredProposalOperationStatus,
  recoverStoredProposals,
  assertApprovalInputMatchesStored,
  type StoredProposalExecutionPort,
  type ProposalExecutionWorkflow,
  type StoredProposalExecution,
} from "./proposal-apply";
import { customExternalDataSchema } from "../domain/task-write-values";
import { hashGuiEditBaseline } from "../domain/snapshot-hash";
import type { TaskWriteExternalBaseline } from "./common/task-write-step";
import { createAiIpcPort } from "../ipc/handlers/ai";
import type { ProposalsHandlerWorkflows } from "../ipc/handlers/proposals";
import type { SettingsHandlerWorkflows } from "../ipc/handlers/settings";
import { buildDisplayOrderInput } from "./task-write";
import { applyGuiTaskWriteExecution, projectGuiExecutionResult, recoverGuiTaskWrites, validateRelationGraph, type GuiEditDependencies, type GuiEditExecution, type GuiEditExecutionPort, type GuiEditExecutionWorkflow, type GuiEditInput, type GuiEditStartResult } from "./gui-edit";
import { applyEditRequestSchema } from "../../shared/ipc-contracts/tasks";
import { ExternalToolRuntime } from "../bootstrap/external-tool-runtime";
import { AiEventRuntime, deriveAiStatus } from "../bootstrap/ai-event-runtime";
import {
  AiSessionRuntime,
  type AiSessionBaselineStore as RuntimeAiSessionBaselineStore,
  type AiSessionRecord as RuntimeAiSessionRecord,
} from "../bootstrap/ai-session-runtime";
import { JournalRecoveryRuntime } from "../bootstrap/journal-recovery-runtime";
import { SynchronizationOperations } from "../bootstrap/synchronization-operations";
import { ConfiguredCodexRuntime } from "../bootstrap/configured-codex-runtime";
import {
  AsanaReauthenticationRuntime,
  SetupIpcWorkflow,
  SetupOrchestrator,
  contextMatchesSettings,
  readSettingsState,
  resolveDeviceId,
  type SetupExternalToolConfigurationResult,
  type SetupFullSyncInput,
} from "./settings";
import { OperationalContextRuntime } from "../bootstrap/operational-context-runtime";
import { AiInteractionRuntime } from "../bootstrap/ai-interaction-runtime";
import { MainLifecycleRuntime } from "../bootstrap/main-lifecycle-runtime";
import { OperationalServicesRuntime } from "../bootstrap/operational-services-runtime";
import { SyncStateRuntime, TaskReadIndex, TaskReadWorkflow } from "./task-read";
import { ObsidianReadError, ObsidianReadService, discoverTasksVault } from "../infrastructure/obsidian";
import { ObsidianIntegrationWorkflow } from "./obsidian-integration";
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
  type ExternalAgentServiceOptions,
} from "../external-agent";
import {
  ExternalAgentBridge,
  type ExternalAgentBridgeOptions,
} from "../external-agent/transport";
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
  asanaTaskResponseSchema,
  canonicalizeJson,
  dateSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  parseCustomExternalData,
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
  setupFullSyncInputSchema,
  setupSchemas,
  type SetupDiscordExternalToolConfigurationInput,
  type SetupCodexAvailability,
  type SetupState,
  setupStateSchema,
} from "../../shared/setup";
import {
  type IpcAiPort,
  type IpcGuiEditPort,
  type IpcExternalAgentPort,
  type IpcServicePorts,
  type IpcSetupPort,
  type IpcProposalHistoryPort,
} from "../ipc";
import {
  ipcAiDeltaEventSchema,
  ipcAiStatusEventSchema,
  ipcAsanaAuthenticationStateSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcGuiEditResultSchema,
  ipcGuiEditInputSchema,
  ipcReadModelOverviewResponseSchema,
  ipcReadModelTaskDetailResponseSchema,
  ipcSyncInputSchema,
  ipcProposalHistoryStatusSchema,
  ipcProposalHistoryConfirmInputSchema,
  type IpcProposalHistoryStatus,
  type IpcProposalHistoryConfirmInput,
  type IpcProposalHistorySynchronization,
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
  type IpcAsanaAuthenticationState,
  type IpcAsanaReauthenticationCancelInput,
  type IpcAsanaReauthenticationCompleteInput,
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
import {
  SqliteSettingsRepository,
  SqliteProposalApplicationHistoryRepository,
  type PersistenceRuntime,
  type PersistentTextFile,
  type SqliteConnection,
} from "../infrastructure/persistence";
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
type GuiEditRelationGraphValidationRequest = Parameters<GuiEditDependencies["validateRelation"]>[0];
type GuiEditRelationGraphValidationResult = Awaited<ReturnType<GuiEditDependencies["validateRelation"]>>;
type GuiEditWorkflowResult = GuiEditStartResult | {
  readonly kind: "not_started";
  readonly result: Extract<IpcGuiEditResult, { readonly outcome: "rejected" }>;
};

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

function assertNonNullable<T>(value: T | undefined, message: string): asserts value is T {
  if (value == null) throw new Error(message);
}

function getHistoricalProposalOperationStatus(
  repository: ProposalApplicationHistoryRepository,
  proposalId: string,
  operationId: string,
):
  | {
      readonly kind: "legacy_history";
      readonly source_stage: string;
      readonly source_final_result: "applied" | "not_applied" | "unknown" | "failed" | null;
      readonly confirmation_state: "not_required" | "required" | "confirmed" | "synchronized";
      readonly confirmed_result: "applied" | "not_applied" | "manually_adjusted" | null;
    }
  | { readonly kind: "unknown"; readonly reason_code: "journal_result_unknown"; readonly message: string }
  | undefined {
  const result = repository.getByProposal(proposalId);
  if (result == null) return undefined;
  if (result.kind === "rejected") {
    return {
      kind: "unknown",
      reason_code: "journal_result_unknown",
      message: `旧適用履歴を確認できません。エラーID: ${result.error_id}`,
    };
  }
  const step = result.history.steps.find((item) => item.operation_id === operationId);
  if (step == null) return undefined;
  return {
    kind: "legacy_history",
    source_stage: step.stage,
    source_final_result: step.final_result,
    confirmation_state: step.confirmation_state,
    confirmed_result: step.confirmed_result ?? null,
  };
}

type ApplicationFileStores = {
  readonly secretStorage: PersistentTextFile;
  readonly checkpoint: PersistentTextFile;
  readonly openExternalAgentConfigFile: ExternalAgentBridgeOptions["openConfigFile"];
};

/** TaskHubの主要な依存関係を組み立てるメインプロセスサービスです。 */
export class TaskHubApplication {
  private readonly options: ApplicationOptions;
  private readonly database: StorageDatabase;
  private readonly proposalApplicationHistoryRepository: SqliteProposalApplicationHistoryRepository;
  private readonly settingsRepository: SqliteSettingsRepository<DeviceSettings>;
  private readonly diagnostics: DiagnosticLogService;
  private readonly secretStorage: SecretStorage;
  private readonly scheduler: AsanaRequestScheduler;
  private readonly operationQueue: AsanaOperationQueue;
  private readonly tokenProvider: MutableTokenProviderPort;
  private readonly transport: AsanaTransport;
  private readonly highPriorityTransport: ReturnType<AsanaTransport["withPriority"]>;
  private readonly readClient: AsanaReadClient;
  private readonly interactiveReadClient: AsanaReadClient;
  private readonly writeClient: AsanaTaskWriteClient;
  private readonly oauth: AsanaOAuthCoordinator;
  private readonly syncCoordinator: AsanaSyncCoordinator;
  private readonly codexWorkspace: CodexWorkspaceInitializationResult;
  private readonly aiSessionWorkspaceParentPath: string;
  private readonly codexSession: CodexSessionService;
  private readonly codexConnectionFactory: CodexSessionConnectionFactory;
  private readonly codexAdapter: CodexSetupAdapter;
  private readonly setup: SetupOrchestrator;
  private readonly setupIpc: IpcSetupPort;
  public readonly taskRead: TaskReadWorkflow<
    Extract<ReturnType<typeof ipcReadModelOverviewResponseSchema.parse>, { kind: "ok" }>["value"],
    Extract<ReturnType<typeof ipcReadModelTaskDetailResponseSchema.parse>, { kind: "ok" }>["value"],
    AsanaSyncRuntimeInternalResult,
    AsanaSyncCoordinatorResult,
    AsanaSyncRuntimeState,
    AsanaSyncRuntimeState,
    AsanaSyncCoordinatorResult
  >;
  private readonly obsidian: ObsidianIntegrationWorkflow;
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
    AsanaDisplayOrderService
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
  private aiStartResult: CodexSessionStartResult | undefined;
  private codexAvailability: OperationalContext["codex"] | undefined;
  private codexAuthenticationRequired = false;
  private readonly aiEvents: AiEventRuntime<IpcAiStatus, IpcCodexDelta>;
  private readonly synchronizationOperations: SynchronizationOperations<
    AsanaSyncRuntimeInternalResult,
    PostWriteSynchronizationResultWithCause,
    PostWriteSynchronizationFailureCode
  >;
  private taskWriteExecution: {
    readonly proposal: StoredProposalExecutionPort;
    readonly proposalWorkflow: ProposalExecutionWorkflow;
    readonly gui: GuiEditExecutionPort;
    readonly guiWorkflow: GuiEditExecutionWorkflow;
  } | undefined;
  private readonly journalRecovery: JournalRecoveryRuntime<
    { readonly proposal_id: string; readonly operation_id: string; readonly final_result: null },
    AsanaProposalRecoveryResult
  >;
  private readonly configuredCodexRuntime: ConfiguredCodexRuntime;
  private readonly lifecycleRuntime: MainLifecycleRuntime<
    SetupState,
    ApplicationState,
    AsanaSyncRuntimeInternalResult
  >;

  public constructor(
    options: ApplicationOptions,
    persistence: PersistenceRuntime,
    files: ApplicationFileStores,
    historyRepository: SqliteProposalApplicationHistoryRepository,
  ) {
    applicationOptionsSchemaExport.parse(options);
    this.options = options;
    this.aiEvents = new AiEventRuntime({
      currentStatus: () => this.currentAiStatus(),
      reportListenerError: (error, channel) =>
        this.options.diagnostic(error, channel, serviceErrorDiagnostic),
    });
    this.externalAgentInstanceId = identifierSchema.parse(options.create_id());
    this.operationQueue = new AsanaOperationQueue(options.lifecycle_signal);
    this.database = new StorageDatabase(persistence);
    this.proposalApplicationHistoryRepository = historyRepository;
    this.settingsRepository = new SqliteSettingsRepository(
      persistence.connection,
      (value) => deviceSettingsSchema.parse(value),
    );
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
    this.secretStorage = new SecretStorage(files.secretStorage);
    const checkpoint = new SetupCheckpointStore(files.checkpoint);
    this.scheduler = new AsanaRequestScheduler();
    this.tokenProvider = createMutableTokenProvider();
    this.transport = new AsanaTransport(this.scheduler, this.tokenProvider);
    const normalTransport = this.transport.withPriority("normal");
    this.highPriorityTransport = this.transport.withPriority("high");
    this.readClient = new AsanaReadClient(normalTransport);
    this.interactiveReadClient = new AsanaReadClient(this.highPriorityTransport);
    const setupClient = new AsanaSetupClient(normalTransport);
    this.writeClient = new AsanaTaskWriteClient(normalTransport);
    this.oauth = new AsanaOAuthCoordinator(
      this.secretStorage,
      options.open_authorization_url,
    );
    const resources = new AsanaSetupResourceCoordinator(
      setupClient,
      this.readClient,
    );
    const capability = new AsanaCapabilityCheckService(
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
    this.obsidian = new ObsidianIntegrationWorkflow({
      repository: this.database,
      reader: new ObsidianReadService(this.database),
      discoverTasksVault,
      assertOperationalReady: () => this.assertOperationalReady(),
      isStopped: () => this.lifecycleRuntime.isStopped(),
      isExternalToolConfigurationRunning: () => this.externalTools.isConfigurationRunning(),
      hasActiveAiSessions: () => this.aiRuntime.hasActiveSessions(),
      codexSessionState: () => this.codexSession.getState(),
      configuredReadOnlyVaultPaths: options.read_only_vault_paths,
      setCodexReadOnlyVaultPaths: (paths) => this.codexSession.setReadOnlyVaultPaths(paths),
      openObsidianUrl: (uri, signal) => this.options.open_obsidian_url(uri, signal),
      reportFailure: (error) => {
        if (error instanceof ObsidianReadError) {
          this.options.diagnostic(error, "obsidian", serviceErrorDiagnostic);
        }
      },
    });
    this.codexSession = new CodexSessionService({
      codexExecutablePath: options.codex_executable,
      workspacePath: this.codexWorkspace.workspacePath,
      agentsFilePath: this.codexWorkspace.agentsFilePath,
      tmpDirectoryPath: this.codexWorkspace.tmpDirectoryPath,
      expectedCodexHomePathProvider: () => this.codexWorkspace.codexHomePath,
      obsidianReader: this.obsidian.createCodexPort(),
      readOnlyVaultPaths: [...this.obsidian.readOnlyVaultPaths()],
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
        this.aiEvents.publishDelta(ipcAiDeltaEventSchema.parse({
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
      publishStatus: () => this.aiEvents.publishStatus(),
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
      openConfigFile: files.openExternalAgentConfigFile,
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
      get_saved_operation_result: (proposalId, operationId) =>
        this.getSavedProposalOperationStatus(proposalId, operationId),
      assert_apply_ready: () => this.assertMutationRequestAccepted(),
      open_review: async () => {
        await this.options.open_external_agent_review();
      },
      bridge: externalAgentBridge,
    });
    this.externalAgent = externalAgent;
    this.setup = new SetupOrchestrator({
      device_id: resolveDeviceId({
        settings: this.settingsRepository,
        loadCheckpoint: () => checkpoint.load(),
        parseState: (value) => setupStateSchema.parse(value),
        contextFromState,
        createId: this.options.create_id,
        parseId: (value) => identifierSchema.parse(value),
      }),
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
      asana: setupClient,
      resources: resources,
      capability: capability,
      reportCapabilityFailure: (error) =>
        this.options.diagnostic(error, "setup", serviceErrorDiagnostic),
      database: {
        saveDeviceSettings: (value) => this.settingsRepository.save(value),
        getDeviceSettings: () => this.settingsRepository.get(),
        saveVaultMapping: (value) => this.database.saveVaultMapping(value),
        getVaultMappings: () => this.database.getVaultMappings(),
      },
      checkpoint: {
        load: () => checkpoint.load(),
        save: (value) => checkpoint.save(value),
      },
      externalTool: {
        configureDiscord: (input, signal) =>
          this.configureDiscordExternalTool(input, signal),
        deactivateDiscord: (signal) =>
          this.externalTools.deactivate(signal),
      },
      fullSync: (input, signal) => this.runSetupFullSync(input, signal),
      contracts: {
        validation: setupSchemas.validation,
        parseDeviceSettings: (value) => deviceSettingsSchema.parse(value),
        parseVaultMapping: (value) => vaultMappingSchema.parse(value),
        parseOAuthBeginResult: (value) => oauthOutOfBandBeginResultSchema.parse(value),
        parseOAuthCompleteResult: (value) => asanaOAuthCoordinatorResultSchema.parse(value),
        parseOAuthState: (value) => oauthOutOfBandStateSchema.parse(value),
        createOAuthInProgressError: () => new AsanaOAuthOutOfBandAuthenticationInProgressError(),
        createOAuthIdMismatchError: () => new AsanaOAuthOutOfBandAuthorizationIdMismatchError(),
        parseResourceResult: (value) => asanaSetupResourceCoordinatorResultSchema.parse(value),
        parseCapabilityResult: (value) => capabilityCheckResultSchema.parse(value),
        isCapabilityError: (error): error is AsanaCapabilityCheckError => error instanceof AsanaCapabilityCheckError,
        hasRestAsanaHttpError,
        validateVaultPath: (mapping, signal) => this.obsidian.validateMapping(mapping, signal),
      },
    });
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
      availabilityFromState: codexAvailabilityFromState,
      clientIdFromState,
      readSettings: () => this.settingsRepository.get(),
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
      recover: async (signal) => {
        const execution = this.requireTaskWriteExecution();
        await recoverGuiTaskWrites(execution.gui, signal);
        return asanaProposalRecoveryResultSchema.parse(await recoverStoredProposals(execution.proposal, signal));
      },
      afterRecovery: (result) => this.cleanupAggregation.replaceProposalConflictsFromRecovery(
        result,
        true,
      ),
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
      hasIncompleteJournal: () => this.proposalApplicationHistoryRepository.getIncomplete().length > 0
        || this.requireTaskWriteExecution().proposal.repository.getIncomplete().length > 0
        || this.requireTaskWriteExecution().gui.repository.getIncomplete().length > 0,
      isJournalRecoveryRunning: () => this.journalRecovery.isRunning(),
      assertPostWriteSynchronizationReady: (executionId) => {
        if (this.proposalApplicationHistoryRepository.getIncomplete().length > 0) {
          throw new Error("未確認の旧適用履歴があるため後続同期を開始できません。");
        }
        if (this.requireTaskWriteExecution().proposal.repository.getIncomplete()
          .some((execution) => execution.execution_id !== executionId)) {
          throw new Error("別の未完了proposal executionがあるため後続同期を開始できません。");
        }
        if (this.requireTaskWriteExecution().gui.repository.getIncomplete()
          .some((execution) => execution.execution_id !== executionId)) {
          throw new Error("別の未完了GUI編集executionがあるため後続同期を開始できません。");
        }
      },
      recoverJournal: (signal) => this.journalRecovery.recover(signal),
      afterLocalStateRefresh: (signal) => this.afterLocalStateRefresh(signal),
      synchronizeCodexAfterAsana: (signal) =>
        this.configuredCodexRuntime.synchronizeAfterAsana(signal),
      afterGuiEdit: (requiredTaskGids, executionId, signal) =>
        this.requireRuntime().afterGuiEdit(requiredTaskGids, executionId, signal),
      afterAiApply: (requiredTaskGids, executionId, signal) =>
        this.requireRuntime().afterAiApply(requiredTaskGids, executionId, signal),
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
      assertReauthenticationIdle: () => this.asanaReauthentication.assertIdle(),
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
        this.aiEvents.publishStatus();
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
      requireSettings: () => this.operationalContext.requireConfiguredSettings(),
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
      configureAsana: (settings) => this.operationalContext.configureAsanaFromSettings(settings),
      synchronize: async (signal) => {
        const synchronized = await this.synchronizationOperations.requireSynchronizedResult(
          this.requireRuntime().onOnline(signal),
        );
        await this.synchronizationOperations.afterSynchronizedState(synchronized, signal);
        return synchronized.result;
      },
      restoreContext: () => this.operationalContext.configureFromState(this.setup.getState()),
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
        (signal, executionId) => this.synchronizationOperations.beforeSynchronization(signal, executionId),
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
    });
    this.lifecycleRuntime = new MainLifecycleRuntime<
      SetupState,
      ApplicationState,
      AsanaSyncRuntimeInternalResult
    >({
      validateAbortSignal,
      throwIfAborted,
      initializeExternalAgentBridge: () => this.initializeExternalAgentBridge(),
      ensureTasksVaultMapping: (signal) => this.obsidian.ensureTasksVaultMapping(signal),
      recordDiagnostic: (code) => this.recordDiagnostic(code, "info"),
      reconcileExternalTools: (signal) => this.externalTools.reconcileAtStartup(signal),
      getSetupState: () => this.setup.getState(),
      isOnline: () => this.isOnline(),
      restoreReadyDeviceSettings: () => this.operationalContext.configureAsanaFromSettings(
        this.setup.restoreReadyDeviceSettings(),
      ),
      startSetup: (signal) => this.setup.start(signal),
      restoreCodexSession: (signal) => this.restorePersistedCodexSession(signal),
      isContextState,
      resumeSetup: (state, signal) => this.resumeSetupAtStartup(state, signal),
      configureAsanaFromStoredSettings: () => this.operationalContext.configureAsanaFromSettings(
        this.settingsRepository.get(),
      ),
      configureContextFromState: (state) => this.operationalContext.configureFromState(state),
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
      stopOAuthAuthorization: () => this.oauth.stopOutOfBandAuthorization(),
      stopExternalConfiguration: (errors) => this.externalTools.stopConfiguration(errors),
      externalAgent: this.externalAgent,
      externalAgentBridge: this.externalAgentBridge,
      stopSyncSubscriptions: () => this.taskRead.stop(),
      clearAiListeners: () => {
        this.aiEvents.dispose();
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
    this.setupIpc = new SetupIpcWorkflow({
      setup: this.setup,
      parseState: (value) => setupStateSchema.parse(value),
      afterTransition: (state) => {
        const validatedState = setupStateSchema.parse(state);
        this.operationalContext.configureAsanaFromSettings(this.settingsRepository.get());
        this.operationalContext.configureFromState(validatedState);
        this.aiStartResult = this.codexAdapter.getStartResult() ?? this.aiStartResult;
        this.codexAuthenticationRequired = validatedState.kind === "codex_authentication_required"
          || this.aiStartResult?.state === "authentication_required";
        this.aiEvents.publishStatus();
        return validatedState;
      },
      afterCodexAuthentication: async (signal) => {
        if (!this.lifecycleRuntime.isReadyActivated()) {
          await this.lifecycleRuntime.activateReady(signal);
        } else {
          await this.verifyConfiguredCodexCapabilities(signal);
        }
      },
      afterVaultChoice: (signal) => this.refreshCodexThreadIfReady(signal),
      runExternalToolConfiguration: (signal, run) =>
        this.externalTools.runConfigurationOperation(signal, run),
      afterExternalToolChoice: async (state, signal, commit) => {
        if (state.kind === "external_tool_configured") {
          const selection = setupExternalToolSelectionSchema.parse({
            kind: "configured",
            tool_id: state.tool_id,
            allowed_channel_ids: state.allowed_channel_ids,
          });
          if (selection.kind !== "configured") {
            throw new Error("確定済み固定Discord選択を取得できません。");
          }
          const activation = await this.externalTools.initialize(selection, signal);
          if (activation.kind === "unavailable") {
            await this.externalTools.markUnavailableSafely(
              activation.reason_code,
              new Error("確定済み固定Discord連携を有効化できませんでした。"),
            );
            return commit(this.setup.getState());
          }
          await this.refreshCodexThreadAfterExternalToolCommit(signal);
        }
        return state;
      },
      afterCodexCapability: (signal) => this.lifecycleRuntime.activateReady(signal),
    }).createPort();
    this.codexAvailability = contextFromState(this.setup.getState())?.codex;
    this.operationalContext.configureAsanaFromSettings(this.operationalContext.getSettings());
    this.operationalContext.configureFromState(this.setup.getState());
  }

  /** 現在の設定済みまたは未設定状態を取得します。 */
  public getState(): ApplicationState {
    return readSettingsState({
      readSetupState: () => this.setup.getState(),
      settings: this.settingsRepository,
      parseSetupState: (value) => setupStateSchema.parse(value),
      parseSettings: (value) => deviceSettingsSchema.parse(value),
      parseApplicationState: (value) => applicationStateSchemaExport.parse(value),
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

  /** IPCへ公開するアプリケーションサービスのポートを取得します。 */
  public getIpcPorts(): IpcServicePorts {
    return {
      asana: this.asanaReauthentication.createPort(),
      setup: this.setupIpc,
      gui: this.createGuiPort(),
      externalAgent: this.createExternalAgentPort(),
      ai: this.createAiPort(),
      proposalHistory: this.createProposalHistoryPort(),
      obsidian: this.obsidian.createIpcPort(),
    };
  }

  /** 初回設定とAsana再認証の最終IPCへ公開するworkflowを取得します。 */
  public getSettingsHandlerWorkflows(): SettingsHandlerWorkflows {
    return {
      setup: this.setupIpc,
      asana: this.asanaReauthentication.createPort(),
    };
  }

  /** Obsidianの最終IPCへ公開するworkflowを取得します。 */
  public getObsidianHandlerWorkflow(): ReturnType<ObsidianIntegrationWorkflow["createIpcPort"]> {
    return this.obsidian.createIpcPort();
  }

  /** 変更案の最終IPCに公開するworkflowを取得します。 */
  public getProposalsHandlerWorkflows(): ProposalsHandlerWorkflows {
    return {
      ai: {
        getStatus: () => {
          this.assertOperationalReady();
          return this.currentAiStatus();
        },
        startNewSession: (signal) => this.aiRuntime.startSession(signal),
        startTurn: (input, signal) => this.aiInteraction.startTurn(input, signal),
        getProposal: (input) => this.aiInteraction.withProposalRecord(input, false, (record) =>
          record.workflow.getProposal(identifierSchema.parse(input.proposal_id))),
        select: (input) => this.aiInteraction.withProposalRecord(input, true, (record) =>
          record.workflow.select(aiWorkflowSelectionRequestSchema.parse(input))),
        editOperation: (input) => this.aiInteraction.withProposalRecord(input, true, (record) =>
          record.workflow.editOperation(aiWorkflowOperationEditSchema.parse(input))),
        reject: (input) => this.aiInteraction.withProposalRecord(input, true, (record) => {
          const proposalId = identifierSchema.parse(input.proposal_id);
          record.workflow.rejectProposal(proposalId);
          this.aiRuntime.forgetProposal(record, proposalId);
        }),
        approve: (input, signal) => this.aiInteraction.approve(input, signal),
        closeSession: async (sessionId) => {
          const record = this.aiRuntime.requireSession(sessionId);
          await this.aiRuntime.closeRecord(record, "explicit");
          return { completed: true };
        },
      },
      external: {
        getState: () => this.externalAgent.getState(),
        setEnabled: (input, signal) => this.externalAgent.setEnabled(input, signal),
        edit: (input, signal) => this.externalAgent.edit({
          ...aiWorkflowOperationEditSchema.parse(input),
          revision: input.revision,
        }, signal),
        select: (input, signal) => this.externalAgent.select(input, signal),
        approve: (input, signal) => this.externalAgent.approve(input, signal),
        reject: (input, signal) => this.externalAgent.reject(input, signal),
      },
      history: {
        getStatus: () => this.getProposalHistoryStatus(),
        confirm: (input) => {
          const checked = ipcProposalHistoryConfirmInputSchema.parse(input);
          this.proposalApplicationHistoryRepository.confirm(
            checked.proposal_id,
            checked.operation_id,
            checked.checked_target_id,
            checked.confirmed_result,
          );
          return this.getProposalHistoryStatus();
        },
        synchronize: async (signal) => {
          const result = await this.synchronizeProposalHistory(signal);
          return { status: this.getProposalHistoryStatus(), synced_at: result.synced_at };
        },
      },
      execution: {
        getExecution: (executionId) => this.getProposalExecution(executionId),
        retryExecution: (executionId, signal) => this.retryProposalExecution(executionId, signal),
      },
    };
  }

  /** Electronのフォアグラウンド復帰を同期へ渡します。 */
  public async onForeground(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    this.assertOperationalReady();
    this.asanaReauthentication.assertIdle();
    const runtime = this.requireRuntime();
    const result = await this.synchronizationOperations.requireSynchronizedResult(runtime.onForeground(signal));
    await this.synchronizationOperations.afterSynchronizedState(result, signal);
  }

  /** Electronのオンライン復帰を同期へ渡します。 */
  public async onOnline(): Promise<void> {
    this.assertOperationalReady();
    this.asanaReauthentication.assertIdle();
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
      this.aiEvents.publishStatus();
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
    this.operationalContext.configureFromState(this.setup.getState());
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
    this.aiEvents.publishStatus();
    const detected = await this.detectCodexSafely(signal);
    this.codexAvailability = detected;
    if (detected.kind === "unavailable") {
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      this.aiEvents.publishStatus();
      return;
    }
    const authentication = await this.getCodexAuthenticationStateSafely(signal);
    if (authentication.kind === "unavailable") {
      this.codexAvailability = authentication;
      this.aiStartResult = undefined;
      this.codexAuthenticationRequired = false;
      this.aiEvents.publishStatus();
      return;
    }
    this.codexAuthenticationRequired = authentication.kind === "required";
    this.aiStartResult = this.codexAdapter.getStartResult();
    this.aiEvents.publishStatus();
  }

  private async verifyConfiguredCodexCapabilities(signal: AbortSignal): Promise<void> {
    if (!isReadyCodexResult(this.aiStartResult) || this.codexAuthenticationRequired) {
      return;
    }
    const availability = await this.checkCodexCapabilitiesSafely(signal);
    this.codexAvailability = availability;
    this.aiEvents.publishStatus();
  }

  private async refreshLocalTaskState(signal: AbortSignal): Promise<void> {
    const tasks = parseTaskCache(this.database.getTaskCache())
      .map((entry) => taskSchema.parse(entry.task));
    await this.cleanupAggregation.replaceBrokenVaultLinksFromTasks(
      tasks,
      signal,
    );
    signal.throwIfAborted();
  }

  private async afterLocalStateRefresh(signal: AbortSignal): Promise<void> {
    await this.refreshLocalTaskState(signal);
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
        this.asanaReauthentication.assertIdle();
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
    request: GuiEditRelationGraphValidationRequest,
    signal: AbortSignal,
  ): Promise<GuiEditRelationGraphValidationResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const tasks = parseTaskCache(this.database.getTaskCache())
      .map((entry) => taskSchema.parse(entry.task));
    const result = validateRelationGraph(request, tasks, (projected) =>
      normalizeTaskGraph({ tasks: projected, inaccessible_gids: [] }));
    return Promise.resolve(result);
  }

  private requireTaskWriteExecution(): NonNullable<TaskHubApplication["taskWriteExecution"]> {
    const execution = this.taskWriteExecution;
    assertNonNullable(execution, "保存済みplan実行入口がありません。");
    return execution;
  }

  private getProposalHistoryStatus(): IpcProposalHistoryStatus {
    const entries: IpcProposalHistoryStatus["entries"] = this.proposalApplicationHistoryRepository.getIncomplete().flatMap<IpcProposalHistoryStatus["entries"][number]>((result) => {
      if (result.kind === "rejected") {
        return [{
          kind: "history_invalid",
          proposal_id: result.proposal_id,
          operation_id: result.operation_id,
          error_id: result.error_id,
        }];
      }
      return result.history.steps.flatMap<IpcProposalHistoryStatus["entries"][number]>((step) => {
        if (step.state === "confirmation_required") {
          if (step.final_result != null && step.final_result !== "unknown") {
            throw new Error("旧適用履歴の未確定結果が元の保存結果と一致しません。");
          }
          return [{
            kind: "confirmation_required",
            proposal_id: result.history.proposal_id,
            operation_id: step.operation_id,
            target_id: step.target.kind === "task" ? step.target.gid
              : step.target.kind === "new_task" ? step.target.uuid : step.target.ref,
            target_kind: step.target.kind,
            source_stage: step.stage,
            source_final_result: step.final_result,
          }];
        }
        if (step.state === "synchronization_required") {
          if (step.confirmed_result == null) {
            throw new Error("旧適用履歴の確認済み結果がありません。");
          }
          return [{
            kind: "synchronization_required",
            proposal_id: result.history.proposal_id,
            operation_id: step.operation_id,
            target_id: step.target.kind === "task" ? step.target.gid
              : step.target.kind === "new_task" ? step.target.uuid : step.target.ref,
            target_kind: step.target.kind,
            confirmed_result: step.confirmed_result,
          }];
        }
        return [];
      });
    });
    return ipcProposalHistoryStatusSchema.parse({ entries });
  }

  private createProposalHistoryPort(): IpcProposalHistoryPort {
    return {
      getStatus: () => this.getProposalHistoryStatus(),
      confirm: (input: IpcProposalHistoryConfirmInput) => {
        const checked = ipcProposalHistoryConfirmInputSchema.parse(input);
        this.proposalApplicationHistoryRepository.confirm(
          checked.proposal_id,
          checked.operation_id,
          checked.checked_target_id,
          checked.confirmed_result,
        );
        return this.getProposalHistoryStatus();
      },
      synchronize: (signal: AbortSignal) => this.synchronizeProposalHistory(signal),
    };
  }

  private async synchronizeProposalHistory(signal: AbortSignal): Promise<IpcProposalHistorySynchronization> {
    validateAbortSignal(signal);
    this.assertOperationalReady();
    this.asanaReauthentication.assertIdle();
    if (!this.isOnline()) {
      throw new Error("オフライン中は旧適用履歴の読取同期を実行できません。");
    }
    const expectedContext = this.requireContext();
    this.proposalApplicationHistoryRepository.assertSynchronizationReady();
    const result = await this.operationQueue.enqueue({
      priority: "user",
      kind: "synchronization",
      signal,
      beforeStart: () => {
        this.assertContextUnchanged(expectedContext);
        this.proposalApplicationHistoryRepository.assertSynchronizationReady();
        if (this.journalRecovery.hasPending()) {
          throw new Error("未完了の新しい適用executionがあるため旧履歴を同期できません。");
        }
      },
      run: async (context) => {
        const synchronized = await this.syncCoordinator.coordinateReadOnly({
          mode: "full",
          project_gid: expectedContext.project_gid,
          section_gids: expectedContext.section_gids,
          device_id: expectedContext.device_id,
          app_version: this.options.app_version,
          required_task_gids: [],
        }, context.signal);
        context.signal.throwIfAborted();
        await this.refreshLocalTaskState(context.signal);
        context.signal.throwIfAborted();
        this.requireRuntime().acceptReadOnlySynchronization(synchronized.synced_at, context.signal);
        context.signal.throwIfAborted();
        this.proposalApplicationHistoryRepository.completeSynchronization();
        return synchronized;
      },
    });
    return { status: this.getProposalHistoryStatus(), synced_at: result.synced_at };
  }

  private getSavedProposalOperationStatus(
    proposalId: string,
    operationId: string,
  ): ReturnType<ExternalAgentServiceOptions["get_saved_operation_result"]> {
    const legacy = getHistoricalProposalOperationStatus(this.proposalApplicationHistoryRepository, proposalId, operationId);
    if (legacy != null) return legacy;
    const stored = getStoredProposalOperationStatus(
      this.requireTaskWriteExecution().proposal.repository,
      proposalId,
      operationId,
    );
    if (stored == null) return undefined;
    return {
      kind: "execution",
      ...stored,
    };
  }

  private assertWritesAllowed(): void {
    this.assertOperationalReady();
    this.asanaReauthentication.assertIdle();
    const synchronizationState = this.requireRuntime().getState();
    if (
      synchronizationState.kind !== "online"
      || synchronizationState.last_error_code != null
    ) {
      throw new Error("Asana同期が正常なオンライン状態になるまで書き込みを開始できません。");
    }
    if (
      this.journalRecovery.hasPending()
      || this.proposalApplicationHistoryRepository.getIncomplete().length > 0
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
    this.asanaReauthentication.assertIdle();
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
      || this.proposalApplicationHistoryRepository.getIncomplete().length > 0
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
    this.aiEvents.publishStatus();
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

  /** GUI直接編集の開始前結果または保存済みexecutionを返します。 */
  public async applyGuiEdit(
    input: z.output<typeof applyEditRequestSchema>,
    signal: AbortSignal,
  ): Promise<GuiEditWorkflowResult> {
    const request = applyEditRequestSchema.parse(input);
    const operation = this.toGuiEditOperation(request.operation);
    return this.runGuiEdit({ task_gid: request.task_gid, expected_task_hash: request.expected_task_hash, operation }, signal);
  }

  /** 指定IDの保存済みGUI編集executionを取得します。 */
  public getGuiEditExecution(executionId: string): GuiEditExecution {
    return this.requireTaskWriteExecution().guiWorkflow.getExecution(executionId);
  }

  /** 指定IDの保存済み変更案executionを取得します。 */
  public getProposalExecution(executionId: string): StoredProposalExecution {
    return this.requireTaskWriteExecution().proposalWorkflow.getExecution(executionId);
  }

  /** 変更案の実行条件を確認して明示再試行します。 */
  public async retryProposalExecution(executionId: string, signal: AbortSignal): Promise<StoredProposalExecution> {
    this.assertMutationRequestAccepted();
    const context = this.requireContext();
    return this.operationQueue.enqueue({
      priority: "user",
      kind: "ai_apply",
      signal,
      beforeStart: () => {
        this.assertQueuedMutationReady();
        this.assertContextUnchanged(context);
      },
      run: (operationContext) => this.requireTaskWriteExecution().proposalWorkflow.retryExecution(
        executionId,
        operationContext.signal,
      ),
    });
  }

  /** GUI編集の実行条件を確認して明示再試行します。 */
  public async retryGuiEditExecution(executionId: string, signal: AbortSignal): Promise<GuiEditExecution> {
    this.assertMutationRequestAccepted();
    const context = this.requireContext();
    return this.operationQueue.enqueue({
      priority: "user",
      kind: "gui_edit",
      signal,
      beforeStart: () => {
        this.assertQueuedMutationReady();
        this.assertContextUnchanged(context);
      },
      run: (operationContext) => this.requireTaskWriteExecution().guiWorkflow.retryExecution(
        executionId,
        operationContext.signal,
      ),
    });
  }

  private toGuiEditOperation(operation: z.output<typeof applyEditRequestSchema>["operation"]): GuiEditInput["operation"] {
    if (operation.kind !== "set_due") {
      return operation;
    }
    switch (operation.value.kind) {
      case "none":
        return { kind: "clear_due" };
      case "on":
        return { kind: "set_due", value: { kind: "due_on", due_on: operation.value.value } };
      case "at":
        return { kind: "set_due", value: { kind: "due_at", due_at: operation.value.value } };
    }
  }

  private async runGuiEdit(
    request: Pick<GuiEditInput, "task_gid" | "operation"> & { readonly expected_task_hash: string },
    signal: AbortSignal,
  ): Promise<GuiEditWorkflowResult> {
    this.assertOperationalReady();
    this.asanaReauthentication.assertIdle();
    if (!this.isOnline()) {
      return { kind: "not_started", result: this.createGuiRejectedResult(request.task_gid, "offline") };
    }
    this.assertMutationRequestAccepted();
    const context = this.requireContext();
    try {
      const result = await this.operationQueue.enqueue<GuiEditWorkflowResult>({
        priority: "user",
        kind: "gui_edit",
        signal,
        beforeStart: () => {
          if (!this.isOnline()) {
            throw new AsanaOperationInvalidatedError("offline");
          }
          this.assertQueuedMutationReady();
          this.assertContextUnchanged(context);
        },
        run: (operationContext) => {
          const baseline = this.database.getTaskCacheEntry(request.task_gid);
          if (baseline == null) {
            return { kind: "not_started", result: this.createGuiRejectedResult(
              request.task_gid,
              "task_missing",
            ) };
          }
          const baselineTask = asanaTaskResponseSchema.parse(
            baseline.asana_response,
          );
          if (hashGuiEditBaseline(baselineTask) !== request.expected_task_hash) {
            return { kind: "not_started", result: this.createGuiRejectedResult(
              request.task_gid,
              "baseline_changed",
            ) };
          }
          const guiInput: GuiEditInput = {
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
          return applyGuiTaskWriteExecution(guiInput, this.requireTaskWriteExecution().gui, {
            isOnline: () => this.isOnline(),
            readTask: (taskGid, requestSignal) => this.interactiveReadClient.getTask(taskGid, requestSignal),
            validateRelation: (relation, requestSignal) => this.validateRelationGraph(relation, requestSignal),
          }, operationContext.signal);
        },
      });
      return result;
    } catch (error: unknown) {
      if (error instanceof AsanaOperationInvalidatedError) {
        return { kind: "not_started", result: this.createGuiRejectedResult(
          request.task_gid,
          error.reason,
        ) };
      }
      throw error;
    }
  }

  private createGuiPort(): IpcGuiEditPort {
    return {
      apply: async (input: IpcGuiRequest, signal): Promise<IpcGuiEditResult> => {
        const request = ipcGuiEditInputSchema.parse(input);
        const result = await this.runGuiEdit(request, signal);
        return ipcGuiEditResultSchema.parse(result.kind === "not_started"
          ? result.result
          : projectGuiExecutionResult(result.execution));
      },
    };
  }

  private createExternalAgentPort(): IpcExternalAgentPort {
    return this.externalAgent;
  }

  private createGuiRejectedResult(
    taskGid: string,
    reasonCode:
      | "offline"
      | "baseline_changed"
      | "task_missing"
      | "synchronization_failed"
      | "context_changed",
  ): Extract<IpcGuiEditResult, { readonly outcome: "rejected" }> {
    return {
      operation_id: identifierSchema.parse(this.options.create_id()),
      task_gid: taskGid,
      outcome: "rejected",
      reason_code: reasonCode,
    };
  }

  private currentAiStatus(): IpcAiStatus {
    return deriveAiStatus({
      stopped: this.lifecycleRuntime.isStopped(),
      getSessionState: () => this.codexSession.getState(),
      unavailableReason: this.codexAvailability?.kind === "unavailable"
        ? this.codexAvailability.reason_code
        : undefined,
      authenticationRequired: this.codexAuthenticationRequired
        || this.aiStartResult?.state === "authentication_required",
      isReadySession: () => isReadyCodexResult(this.aiStartResult),
      getModel: () => this.codexAdapter.getReadyModel(),
    }, (value) => ipcAiStatusEventSchema.parse(value));
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
      obsidianReader: this.obsidian.createCodexPort(),
      readOnlyVaultPaths: [...this.obsidian.readOnlyVaultPaths()],
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
      executeApproval: (input, signal, store) => approveStoredProposal(input, signal, {
        parseRequest: (value) => aiWorkflowApprovalRequestSchema.parse(value),
        throwIfAborted,
        getStoredProposal: store.getStoredProposal,
        resolveSelection: (
          stored,
          selection: z.infer<typeof aiWorkflowApprovalRequestSchema>["selection"],
        ) => resolveSelectedOperationIds(stored, selection),
        loadSavedApplication: async (stored, selected, currentSignal) => {
          const existing = await applyExistingStoredProposal(
            stored.proposal_id,
            stored.proposal,
            selected,
            this.requireTaskWriteExecution().proposal,
            currentSignal,
          );
          return existing == null ? undefined : asanaProposalApplicationResultSchema.parse(existing);
        },
        assertGraphSafe: assertSelectedProposalGraphIsSafe,
        isOnline: () => this.isOnline(),
        OfflineError: AiWorkflowOfflineError,
        createPreparationInput: (stored, selected): ApprovalPreparationInput =>
          createApprovalPreparationInput(stored, selected),
        prepareApprovalInput: (prepared, currentSignal) =>
          this.prepareApprovalInput(prepared, currentSignal),
        parseApprovalInput: (value) => asanaProposalApplicationInputSchema.parse(value),
        assertApprovalInputMatchesStored: (validated, stored, selected) =>
          assertApprovalInputMatchesStored(validated, stored, selected, {
            canonicalizeJson,
            createBaselineTaskSnapshots: (tasks) => createBaselineTaskSnapshots(z.array(taskSchema).parse(tasks)),
            WorkflowError: AiWorkflowError,
          }),
        apply: (validated, currentSignal) => this.applyProposalApplication(validated, currentSignal),
        parseApplication: (value) => asanaProposalApplicationResultSchema.parse(value),
        createResult: (stored, application) => aiWorkflowApprovalResultSchema.parse({
          proposal_id: stored.proposal_id,
          ...(application.execution_id == null ? {} : { execution_id: application.execution_id }),
          application: createApplicationSummary(application),
        }),
        forgetProposal: store.forgetProposal,
        WorkflowError: AiWorkflowError,
      }),
      logRetryEvent: (event) => this.recordAiWorkflowRetryEvent(event),
      reportListenerError: (error) => this.options.diagnostic(
        error,
        "ai_delta_listener",
        serviceErrorDiagnostic,
      ),
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
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    return this.synchronizationOperations.applyProposal(
      signal,
      () => this.applyStoredProposalApplication(
        input,
        this.requireTaskWriteExecution().proposal,
        signal,
      ),
      (result) => this.cleanupAggregation.replaceProposalConflictsFromApplication(result),
    );
  }

  private applyStoredProposalApplication(
    input: AsanaProposalApplicationInput,
    port: StoredProposalExecutionPort,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    const validated = asanaProposalApplicationInputSchema.parse(input);
    const baselines = validated.baseline_external_data.map((item) => {
      const parsed = parseCustomExternalData(item.external.data);
      if (parsed.kind !== "valid") {
        throw new Error("承認時のCustom external dataを読み取れません。");
      }
      const baseline = {
        kind: "stored",
        external_gid: item.external.gid,
        data: customExternalDataSchema.parse(parsed.data),
      } satisfies Extract<TaskWriteExternalBaseline, { readonly kind: "stored" }>;
      return { task_gid: item.task_gid, baseline };
    });
    const result = applyStoredProposal({
      ...validated,
      baseline_external_data: baselines,
    }, proposalApprovalResultSchema.parse(classifyProposalConflicts(validated.approval_input)), (operationIds) => {
      const graph = validateSelectedProposalGraph({
        proposal: validated.approval_input.proposal,
        managed_tasks: validated.approval_input.current_tasks,
        selected_operation_ids: [...operationIds],
        temporary_ref_mappings: validated.approval_input.journal_task_mappings,
      });
      if (graph.kind === "unsafe") {
        throw new Error("適用操作に新しい依存関係または親子関係の循環があります。");
      }
    }, port, signal);
    return result.then((value) => asanaProposalApplicationResultSchema.parse(value));
  }

  private applyExternalProposal(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    return this.applyProposalApplication(input, signal);
  }

  private createAiPort(): IpcAiPort {
    return createAiIpcPort({
      assertReady: () => this.assertOperationalReady(),
      currentStatus: () => this.currentAiStatus(),
      startNewSession: (signal) => this.aiRuntime.startSession(signal),
      startTurn: (input: IpcAiTurnInput, signal) => this.aiInteraction.startTurn(input, signal),
      withProposalRecord: <TInput extends { readonly session_id: string }, TResult>(
        input: TInput,
        requireAvailable: boolean,
        run: (record: AiSessionRecord) => TResult,
      ) =>
        this.aiInteraction.withProposalRecord(input, requireAvailable, run),
      parseProposalId: (value) => identifierSchema.parse(value),
      parseSelection: (value: { readonly proposal_id: string; readonly selection: IpcAiSelectionInput["selection"] }) =>
        aiWorkflowSelectionRequestSchema.parse(value),
      parseEdit: (value: {
        readonly proposal_id: string;
        readonly operation_id: string;
        readonly after: IpcAiEditInput["after"];
        readonly evidence_locator: string;
      }) => aiWorkflowOperationEditSchema.parse(value),
      parseView: (value) => aiWorkflowProposalViewSchema.parse(value),
      getProposal: (record: AiSessionRecord, proposalId) => record.workflow.getProposal(proposalId),
      select: (record: AiSessionRecord, input) => record.workflow.select(input),
      editOperation: (record: AiSessionRecord, input) => record.workflow.editOperation(input),
      rejectProposal: (record: AiSessionRecord, proposalId) => record.workflow.rejectProposal(proposalId),
      forgetProposal: (record: AiSessionRecord, proposalId) => this.aiRuntime.forgetProposal(record, proposalId),
      approve: (input: IpcAiApprovalInput, signal) => this.aiInteraction.approve(input, signal),
      closeSession: async (sessionId) => {
        const record = this.aiRuntime.requireSession(sessionId);
        await this.aiRuntime.closeRecord(record, "explicit");
      },
      onDelta: (listener) => this.aiEvents.onDelta(listener),
      onStatus: (listener) => this.aiEvents.onStatus(listener),
    });
  }


}

/** 旧保存形式の移行処理を一時的な起動portへ渡します。 */
export function migrateLegacyStorage(database: SqliteConnection): void {
  migrateLegacyProposalConflictIdentifiers(database);
}
