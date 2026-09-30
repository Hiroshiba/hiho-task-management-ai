import { z } from "zod";
import {
  CodexTurnCoordinator,
  type ActiveTurnStarting as CodexActiveTurnStarting,
} from "./turn-coordinator";
import {
  createModelFormatInstruction,
  parseStructuredOutput,
} from "./turn-output";
import { CodexToolResponseSerializer } from "./tool-response";
import { CodexDynamicToolHandler, executeCodexObsidianQuery } from "./dynamic-tools";
import { createCodexSessionConnectionOverrides } from "./connection-configuration";
import { startCodexSessionThread } from "./thread-start";
import { CodexSessionStartup } from "./startup";
import { CodexSessionNotificationRouter } from "./notification-router";
import { CodexConnectionRecovery } from "./connection-recovery";
import { connectAndStartCodexSession, createCodexSessionConnectionFactory } from "./connection-start";
import { createReadyCodexStartResult, createAuthenticationRequiredCodexStartResult } from "./start-result";
import { validateAbortSignal } from "../codex-app-server/rpc-endpoint";
import { disableCodexAi, type AiDisableRequest, type AiDisableResult } from "./disable-ai";
import { createSafetyViolationError } from "./errors";
import { handleCodexProposalWorkspaceTool, readProposalWorkspaceDraft } from "./proposal-workspace-tool";
import {
  inspectCodexAccount,
  inspectCodexAccountWithRetry,
  inspectCodexModel,
  inspectCodexSkills,
  inspectCodexPermissionProfile,
  type AccountInspectionResult,
} from "./connection-inspector";
import {
  canonicalStringArray,
  validateVerifiedTaskctlLocalIpc,
  validateAdditionalLocalSocketPaths,
  isValidThreadSettingsNotification,
  type ThreadSettingsNotification,
} from "./capability-policy";
import {
  CodexAppServerConnection,
  CodexProcessExitError,
  chatGptLoginStartParamsSchema,
  chatGptLoginStartResultSchema,
  codexDiagnosticSchema,
  codexNotificationSchema,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type CodexConnectionOptions,
  type CodexDiagnostic,
  type CodexNotification,
  type ChatGptLoginStartResult,
} from "../codex-app-server";
import {
  TaskctlBroker,
  TaskctlAbortError,
  taskctlBrokerStartResultSchema,
  taskctlQuerySchema,
  type TaskctlBrokerStartResult,
  type TaskctlRankingSchemas,
  type TaskctlResponse,
  type TaskctlSnapshot,
} from "../taskctl";
import {
  codexObsidianQuerySchema,
  codexObsidianResponseSchema,
  type CodexObsidianQuery,
  type CodexObsidianResponse,
} from "../codex-obsidian";
import { createUtf8ByteLimitedStringSchema } from "../../../domain";
import {
  DiagnosticFailureDispositionError,
  combineDiagnosticFailureDispositions,
  diagnosticFailureDispositionFromError,
} from "../../../application/common/errors/diagnostic-failure";
import {
  codexGeneratedResponseSchema,
  maximumCodexResponseJsonBytes,
  maximumProposalWorkspaceArgumentBytes,
  maximumProposalWorkspaceResponseBytes,
  proposalSchema,
  proposalWorkspaceBatchSchema,
  proposalWorkspaceDiffSchema,
  proposalWorkspaceReadSchema,
  proposalWorkspaceSubmitSchema,
  type CodexGeneratedResponse,
} from "../../../domain";
import type {
  ProposalWorkspacePort,
  ProposalWorkspaceValidation,
} from "../../../application/common/ports/proposal-workspace";
import {
  CodexSessionAbortedError,
  CodexSessionCapabilityError,
  CodexSessionError,
  CodexSessionStateError,
  CodexThreadStartCapabilityError,
} from "./errors";
import {
  codexSessionDeltaSchema,
  codexSessionDiagnosticsSchema,
  codexSessionOptionsSchema,
  codexSessionStartResultSchema,
  codexSessionStateSchema,
  codexSessionTurnInputFactorySchema,
  codexSessionTurnInputSchema,
  codexSessionTurnResultSchema,
  type CodexSessionConnection,
  type CodexSessionConnectionFactory,
  type CodexSessionDelta,
  type CodexSessionDeltaListener,
  type CodexSessionDiagnostic,
  type CodexSessionOptions,
  type CodexSessionStartResult,
  type CodexSessionState,
  type CodexSessionTurnInput,
  type CodexSessionTurnInputFactory,
  type CodexSessionTurnResult,
} from "./schemas";

const maximumStoredDiagnostics = 256;
const maximumFinalMessageBytes = 256 * 1024;

const finalAgentMessageSchema = z
  .object({
    type: z.literal("agentMessage"),
    id: z.string().min(1).max(200),
    text: createUtf8ByteLimitedStringSchema(maximumFinalMessageBytes),
    phase: z.literal("final_answer"),
  })
  .strict();

const structuredOutputEnvelopeSchema = z
  .object({
    response_json: createUtf8ByteLimitedStringSchema(maximumCodexResponseJsonBytes),
  })
  .strict();

const structuredOutputEnvelopeJsonSchema = {
  type: "object",
  properties: {
    response_json: { type: "string" },
  },
  required: ["response_json"],
  additionalProperties: false,
} satisfies Record<string, unknown>;

const maximumDynamicToolResponseBytes = 64 * 1024;
const taskctlDynamicToolName = "taskctl";
const taskctlDynamicToolSpec = {
  type: "function",
  name: taskctlDynamicToolName,
  description: "同期済みTaskHubタスク情報を読み取るdynamic toolです。",
  inputSchema: z.toJSONSchema(taskctlQuerySchema, { target: "draft-07" }),
} satisfies Record<string, unknown>;

const obsidianDynamicToolName = "obsidian";
const obsidianDynamicToolSpec = {
  type: "function",
  name: obsidianDynamicToolName,
  description: "登録済みObsidian Vaultを読み取るdynamic toolです。",
  inputSchema: z.toJSONSchema(codexObsidianQuerySchema, { target: "draft-07" }),
} satisfies Record<string, unknown>;

const proposalWorkspaceToolName = "proposal_workspace";
const proposalWorkspaceToolInputSchema = z.discriminatedUnion("action", [
  proposalWorkspaceReadSchema.safeExtend({ action: z.literal("read") }),
  proposalWorkspaceDiffSchema.safeExtend({ action: z.literal("diff") }),
  proposalWorkspaceBatchSchema.safeExtend({ action: z.literal("edit") }),
  proposalWorkspaceSubmitSchema.safeExtend({
    action: z.literal("validate"),
    offset: z.number().int().nonnegative().safe().optional(),
  }),
  proposalWorkspaceSubmitSchema.safeExtend({ action: z.literal("submit") }),
]);
const proposalWorkspaceToolSpec = {
  type: "function",
  name: proposalWorkspaceToolName,
  description: "今回のAI変更案を部分読み取り、意味編集、検証、提出するdynamic toolです。",
  inputSchema: z.toJSONSchema(proposalWorkspaceToolInputSchema, { target: "draft-07" }),
} satisfies Record<string, unknown>;

type ActiveProposalWorkspace = {
  readonly workspace: ProposalWorkspacePort;
  readonly validate: (proposal: z.infer<typeof proposalSchema>) => ProposalWorkspaceValidation<null>;
};

type InternalDiagnostic = {
  readonly code: CodexSessionDiagnostic["code"];
  readonly cause: unknown;
};

type AiDisableDiagnosticDisposition = AiDisableRequest["diagnosticDisposition"];

type SessionStopDisposition =
  | { readonly kind: "record" }
  | { readonly kind: "propagate_unrecorded" };

type ActiveTurnStarting = CodexActiveTurnStarting<CodexSessionTurnResult>;

function combineSessionFailure(
  responseError: unknown,
  additionalErrors: readonly unknown[],
): DiagnosticFailureDispositionError {
  const primaryDisposition = diagnosticFailureDispositionFromError(responseError);
  const additionalDispositions = additionalErrors.map(
    diagnosticFailureDispositionFromError,
  );
  return new DiagnosticFailureDispositionError(
    combineDiagnosticFailureDispositions(
      primaryDisposition,
      additionalDispositions,
    ),
  );
}

function createRecordedSessionFailure(
  recordedError: unknown,
  responseError: unknown,
): DiagnosticFailureDispositionError {
  return new DiagnosticFailureDispositionError({
    kind: "recorded_only",
    recorded_error: recordedError,
    response_error: responseError,
  });
}

function createUnrecordedSessionFailure(error: unknown): DiagnosticFailureDispositionError {
  return new DiagnosticFailureDispositionError({
    kind: "unrecorded_only",
    unrecorded_error: error,
    response_error: error,
  });
}

function validateTaskctlLocalIpc(
  startResult: TaskctlBrokerStartResult,
  tmpDirectoryPath: string,
): string {
  const parsedResult = taskctlBrokerStartResultSchema.safeParse(startResult);
  if (!parsedResult.success) {
    throw new CodexSessionCapabilityError(
      "taskctlローカルIPCの起動結果を検証できません。",
      parsedResult.error,
    );
  }
  return validateVerifiedTaskctlLocalIpc(parsedResult.data, tmpDirectoryPath);
}

/** Codexセッションで利用する実接続ファクトリを作成します。 */
export function createCodexAppServerConnectionFactory(
  options: CodexConnectionOptions,
  onError: CodexSessionOptions["onError"],
): CodexSessionConnectionFactory {
  return createCodexSessionConnectionFactory(
    options,
    (connectionOptions) => new CodexAppServerConnection(connectionOptions, onError),
  );
}

/** Codex app-serverと一時taskctlを一つのAIセッションとして管理します。 */
export class CodexSessionService {
  private readonly options: CodexSessionOptions;
  private readonly taskctlSchemas: TaskctlRankingSchemas;
  private readonly broker: TaskctlBroker;
  private readonly structuredOutputSchema: Record<string, unknown>;
  private readonly modelFormatInstruction: string;
  private readonly responseSerializer: CodexToolResponseSerializer<TaskctlResponse, CodexObsidianResponse>;
  private readonly dynamicToolHandler: CodexDynamicToolHandler<TaskctlResponse, CodexObsidianResponse, CodexObsidianQuery>;
  private readonly startup: CodexSessionStartup<CodexSessionConnection, TaskctlBrokerStartResult, CodexSessionStartResult>;
  private readonly notificationRouter: CodexSessionNotificationRouter;
  private readonly connectionRecovery: CodexConnectionRecovery<CodexSessionTurnResult, CodexSessionConnection>;
  private readOnlyVaultPaths: readonly string[];
  private additionalLocalSocketPaths: readonly string[];
  private readonly diagnostics: InternalDiagnostic[] = [];
  private state: CodexSessionState = "created";
  private connection: CodexSessionConnection | undefined;
  private removeNotificationListener: (() => void) | undefined;
  private removeDiagnosticListener: (() => void) | undefined;
  private removeDynamicToolListener: (() => void) | undefined;
  private taskctlStartResult: TaskctlBrokerStartResult | undefined;
  private frozenTaskctlSnapshot: TaskctlSnapshot | undefined;
  private activeProposalWorkspace: ActiveProposalWorkspace | undefined;
  private threadId: string | undefined;
  private selectedModel: string | undefined;
  private threadSettingsNotification: ThreadSettingsNotification | undefined;
  private skillConfiguration: Array<{ path: string; enabled: boolean }> = [];
  private threadConfigurationChanged = false;
  private connectionConfigurationChanged = false;
  private lifecycleSignal: AbortSignal | undefined;
  private lifecycleAbortListener: (() => void) | undefined;
  private recoveryAbortController: AbortController | undefined;
  private readonly turnCoordinator: CodexTurnCoordinator<CodexSessionTurnResult, CodexSessionDelta, CodexGeneratedResponse, CodexSessionConnection, CodexSessionTurnInput>;
  private successfullyStarted = false;
  private structuredOutputVerified = false;
  private safetyViolation = false;
  private stopPromise: Promise<void> | undefined;
  private disablePromise: Promise<AiDisableResult> | undefined;

  public constructor(options: CodexSessionOptions, taskctlSchemas: TaskctlRankingSchemas) {
    this.options = codexSessionOptionsSchema.parse(options);
    this.taskctlSchemas = taskctlSchemas;
    this.readOnlyVaultPaths = [...this.options.readOnlyVaultPaths];
    this.additionalLocalSocketPaths = [...(this.options.additionalUnixSocketPaths ?? [])];
    this.broker = new TaskctlBroker({
      tmpDirectoryPath: this.options.tmpDirectoryPath,
      snapshotProvider: () => {
        if (this.frozenTaskctlSnapshot != null) {
          return this.frozenTaskctlSnapshot;
        }
        return this.options.snapshotProvider();
      },
    }, taskctlSchemas);
    this.structuredOutputSchema = structuredOutputEnvelopeJsonSchema;
    this.modelFormatInstruction = createModelFormatInstruction(codexGeneratedResponseSchema, codexSessionTurnInputSchema);
    this.responseSerializer = new CodexToolResponseSerializer(
      maximumProposalWorkspaceResponseBytes,
      maximumDynamicToolResponseBytes,
      taskctlSchemas.taskctlResponseSchema,
      codexObsidianResponseSchema,
    );
    this.dynamicToolHandler = new CodexDynamicToolHandler({
      getActiveTurn: () => this.turnCoordinator.activeTurn,
      getThreadId: () => this.threadId,
      responseSerializer: this.responseSerializer,
      executeTaskctlQuery: (query) => this.broker.executeQuery(query),
      obsidianQuerySchema: codexObsidianQuerySchema,
      executeObsidianQuery: (query, signal) => this.executeObsidianQuery(query, signal),
      createInvalidObsidianResponse: () => ({
        ok: false,
        error: { code: "invalid_request", message: "Obsidian要求の形式が不正です。" },
      }),
      readObsidianErrorResponse: (error) => this.options.isObsidianReadFailure(error)
        ? { ok: false, error: { code: error.code, message: error.message } }
        : undefined,
      createTaskctlAbortError: () => new TaskctlAbortError(),
    });
    this.startup = new CodexSessionStartup({
      getState: () => this.state,
      setState: (state) => { this.state = state; },
      getConnection: () => this.connection,
      getTaskctlStartResult: () => this.taskctlStartResult,
      setTaskctlStartResult: (result) => { this.taskctlStartResult = result; },
      hasActiveTurn: () => this.turnCoordinator.activeTurn != null,
      isSafetyViolation: () => this.safetyViolation,
      isConnectionConfigurationChanged: () => this.connectionConfigurationChanged,
      installLifecycleAbort: (signal) => this.installLifecycleAbort(signal),
      startTaskctl: (signal) => this.broker.start(signal),
      connectWithInitialRetry: (signal) => this.connectWithInitialRetry(signal),
      assertSafetyIntact: () => this.assertSafetyIntact(),
      markSuccessfullyStarted: () => { this.successfullyStarted = true; },
      createStartResult: () => this.createStartResult(),
      createAuthenticationRequiredResult: () => this.createAuthenticationRequiredResult(),
      cleanupResources: () => this.cleanupResources(),
      recordDiagnosticLocally: (code, error) => this.recordDiagnosticLocally(code, error),
      restartConnectionForConfigurationChange: (signal) => this.restartConnectionForConfigurationChange(signal),
      inspectAccountWithRetry: (connection, signal) => this.inspectAccountWithRetry(connection, signal),
      inspectModel: (connection, signal) => this.inspectModel(connection, signal),
      inspectSkills: (connection, signal) => this.inspectSkills(connection, signal),
      inspectPermissionProfile: (connection, signal) => this.inspectPermissionProfile(connection, signal),
      startThreadOnCurrentConnection: (signal) => this.startThreadOnCurrentConnection(signal),
      disableAi: (request) => this.disableAi(request),
      combineSessionFailure,
      createRecordedSessionFailure,
      createSafetyViolationError,
    });
    this.notificationRouter = new CodexSessionNotificationRouter({
      notificationSchema: codexNotificationSchema,
      diagnosticSchema: codexDiagnosticSchema,
      tmpDirectoryPath: this.options.tmpDirectoryPath,
      getState: () => this.state,
      getThreadId: () => this.threadId,
      setThreadSettingsNotification: (notification) => { this.threadSettingsNotification = notification; },
      recordDiagnosticLocally: (code, error) => this.recordDiagnosticLocally(code, error),
      recordDiagnosticAndNotify: (code, error) => this.recordDiagnosticAndNotify(code, error),
      markSafetyViolation: (error, disposition) => this.markSafetyViolation(error, disposition),
      failActiveTurn: (error, turnError) => {
        const active = this.turnCoordinator.activeTurn;
        if (active != null) {
          this.turnCoordinator.finishTurn(active, createRecordedSessionFailure(error, turnError));
        }
      },
      onProcessExit: (diagnostic) => {
        const processExitError = new CodexProcessExitError(diagnostic.exitCode, diagnostic.signal);
        this.handleProcessExit(processExitError);
      },
      onSkillsChanged: () => { this.threadConfigurationChanged = true; },
      onTurnNotification: (notification) => {
        this.turnCoordinator.handleTurnNotification(notification, (active, error) => {
          void this.recoverAfterStartingAbort(active, error);
        });
      },
    });
    this.connectionRecovery = new CodexConnectionRecovery({
      getActiveTurn: () => this.turnCoordinator.activeTurn,
      finishTurn: (active, error) => this.turnCoordinator.finishTurn(active, error),
      getLifecycleSignal: () => this.lifecycleSignal,
      getRecoveryAbortController: () => this.recoveryAbortController,
      setRecoveryAbortController: (controller) => { this.recoveryAbortController = controller; },
      getState: () => this.state,
      setState: (state) => { this.state = state; },
      cleanupConnection: () => this.cleanupConnection(),
      disableAi: (request) => this.disableAi(request),
      connectAndStartThread: (signal) => this.connectAndStartThread(signal),
      recordDiagnosticLocally: (code, error) => this.recordDiagnosticLocally(code, error),
      recordDiagnosticAndNotify: (code, error) => this.recordDiagnosticAndNotify(code, error),
      assertSafetyIntact: () => this.assertSafetyIntact(),
      isSafetyViolation: () => this.safetyViolation,
      getConnection: () => this.connection,
      isSuccessfullyStarted: () => this.successfullyStarted,
      isProcessExitError: (error) => error instanceof CodexProcessExitError,
      createSafetyViolationError,
      createRecordedSessionFailure,
    });
    this.turnCoordinator = new CodexTurnCoordinator({
      inputSchema: codexSessionTurnInputSchema,
      inputFactorySchema: codexSessionTurnInputFactorySchema,
      workspacePath: this.options.workspacePath,
      modelFormatInstruction: this.modelFormatInstruction,
      structuredOutputSchema: this.structuredOutputSchema,
      syncBeforeTurn: this.options.syncBeforeTurn,
      isThreadConfigurationChanged: () => this.threadConfigurationChanged,
      getState: () => this.state,
      setTurning: () => { this.state = "turning"; },
      getConnection: () => this.connection,
      getThreadId: () => this.threadId,
      requireSelectedModel: () => this.requireSelectedModel(),
      isStructuredOutputVerified: () => this.structuredOutputVerified,
      recoverAfterStartingAbort: (active, cause) => this.recoverAfterStartingAbort(active, cause),
      disableAi: (request) => this.disableAi(request),
      disableAiAfterReportedTurnError: (cause, error) => this.disableAiAfterReportedTurnError(cause, error),
      finalItemSchema: finalAgentMessageSchema,
      turnResultSchema: codexSessionTurnResultSchema,
      deltaSchema: codexSessionDeltaSchema,
      parseOutput: (text) => parseStructuredOutput(text, structuredOutputEnvelopeSchema, codexGeneratedResponseSchema),
      createUnrecordedFailure: createUnrecordedSessionFailure,
      recordDiagnosticLocally: (code, error) => this.recordDiagnosticLocally(code, error),
      recordDiagnosticAndNotify: (code, error) => this.recordDiagnosticAndNotify(code, error),
      onOutputVerified: () => { this.structuredOutputVerified = true; },
      onTurnFinished: () => {
        this.activeProposalWorkspace = undefined;
        if (this.state === "turning") {
          this.state = "ready";
        }
      },
    });
  }

  private installLifecycleAbort(signal: AbortSignal): void {
    this.lifecycleSignal = signal;
    this.lifecycleAbortListener = () => {
      void this.stop({ kind: "record" }).catch((error: unknown) => {
        this.recordDiagnosticLocally("connection_stop_error", error);
      });
    };
    signal.addEventListener("abort", this.lifecycleAbortListener, { once: true });
  }

  /** 同期後に発行したAI変更案ワークスペースを現在のターンへ設定します。 */
  public activateProposalWorkspace(
    workspace: ProposalWorkspacePort,
    validate: ActiveProposalWorkspace["validate"],
  ): void {
    if (this.turnCoordinator.activeTurn?.phase !== "starting" || this.activeProposalWorkspace != null) {
      throw new CodexSessionStateError();
    }
    if (!this.options.isProposalWorkspace(workspace) || typeof validate !== "function") {
      throw new CodexSessionError("AI変更案ワークスペースの設定が不正です。");
    }
    this.activeProposalWorkspace = { workspace, validate };
  }

  /** Codexが読み取り専用で参照できるVaultを更新します。 */
  public setReadOnlyVaultPaths(paths: readonly string[]): void {
    if (
      this.state !== "created"
      && this.state !== "authentication_required"
      && this.state !== "ready"
    ) {
      throw new CodexSessionStateError();
    }
    const validatedPaths = codexSessionOptionsSchema.shape.readOnlyVaultPaths.parse(paths);
    if (canonicalStringArray(validatedPaths) === canonicalStringArray(this.readOnlyVaultPaths)) {
      return;
    }
    this.readOnlyVaultPaths = validatedPaths;
    this.threadConfigurationChanged = true;
    this.connectionConfigurationChanged = true;
  }

  /** Codexが接続できる追加ローカルIPCを更新します。 */
  public setAdditionalLocalSocketPaths(paths: readonly string[]): void {
    if (
      this.state !== "created"
      && this.state !== "authentication_required"
      && this.state !== "ready"
    ) {
      throw new CodexSessionStateError();
    }
    const validatedPaths = validateAdditionalLocalSocketPaths(
      paths,
      this.options.tmpDirectoryPath,
    );
    if (
      canonicalStringArray(validatedPaths)
      === canonicalStringArray(this.additionalLocalSocketPaths)
    ) {
      return;
    }
    this.additionalLocalSocketPaths = validatedPaths;
    this.threadConfigurationChanged = true;
    this.connectionConfigurationChanged = true;
  }

  /** 専用ワークスペースのスキル更新後に新規スレッドを必須化します。 */
  public requireThreadConfigurationRefresh(): void {
    if (
      this.state !== "created"
      && this.state !== "authentication_required"
      && this.state !== "ready"
    ) {
      throw new CodexSessionStateError();
    }
    this.threadConfigurationChanged = true;
  }

  /** Codex認証、能力、スキルを検査して新規スレッドを開始します。 */
  public async start(signal: AbortSignal): Promise<CodexSessionStartResult> {
    return this.startup.start(signal);
  }

  /** ChatGPTログイン後に能力検査と新規スレッド開始を再開します。 */
  public async completeAuthentication(signal: AbortSignal): Promise<CodexSessionStartResult> {
    return this.startup.completeAuthentication(signal);
  }

  /** GUIの新規セッション用に現在接続で新しいスレッドを開始します。 */
  public async startNewSession(signal: AbortSignal): Promise<CodexSessionStartResult> {
    return this.startup.startNewSession(signal);
  }

  /** ChatGPTのブラウザログイン開始要求をCodexへ渡します。 */
  public async startChatGptLogin(signal: AbortSignal): Promise<ChatGptLoginStartResult> {
    validateAbortSignal(signal);
    const connection = this.connection;
    if (
      connection == null
      || this.state !== "authentication_required"
    ) {
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const params = chatGptLoginStartParamsSchema.parse({ type: "chatgpt" });
    return chatGptLoginStartResultSchema.parse(
      await connection.startChatGptLogin(params, signal),
    );
  }

  /** 同期後に構造化出力を指定して一つのCodexターンを開始します。 */
  public async startTurn(input: CodexSessionTurnInput, signal: AbortSignal): Promise<CodexSessionTurnResult> {
    return this.turnCoordinator.startTurn(input, signal);
  }

  /** 同期完了後にターン入力を作成して構造化出力を指定したCodexターンを開始します。 */
  public async startTurnWithPreparation(
    prepareInput: CodexSessionTurnInputFactory,
    signal: AbortSignal,
  ): Promise<CodexSessionTurnResult> {
    return this.turnCoordinator.startTurnWithPreparation(prepareInput, signal);
  }

  private async recoverAfterStartingAbort(active: ActiveTurnStarting, cause: unknown): Promise<void> {
    await this.connectionRecovery.recoverAfterStartingAbort(active, cause);
  }

  /** 実行中のCodexターンを中断します。 */
  public async interrupt(signal: AbortSignal): Promise<void> {
    await this.turnCoordinator.interrupt(signal);
  }

  /** CodexのagentMessage差分を購読します。 */
  public onDelta(listener: CodexSessionDeltaListener): () => void {
    return this.turnCoordinator.onDelta(listener);
  }

  /** セッションの状態を取得します。 */
  public getState(): CodexSessionState {
    return codexSessionStateSchema.parse(this.state);
  }

  /** ターン中にtaskctlへ返すスナップショットを固定します。 */
  public freezeTaskctlSnapshot(snapshot: TaskctlSnapshot): void {
    if (this.turnCoordinator.activeTurn == null) {
      throw new CodexSessionStateError();
    }
    this.frozenTaskctlSnapshot = this.taskctlSchemas.taskctlSnapshotSchema.parse(snapshot);
  }

  /** ターン中に固定したtaskctlスナップショットを解放します。 */
  public releaseTaskctlSnapshot(): void {
    this.frozenTaskctlSnapshot = undefined;
  }

  /** セッション診断の概要を取得します。 */
  public getDiagnostics(): CodexSessionDiagnostic[] {
    return codexSessionDiagnosticsSchema.parse(
      this.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        cause_present: diagnostic.cause != null,
      })),
    );
  }

  /** 接続、taskctl、保留ターンを停止します。 */
  public stop(disposition: SessionStopDisposition): Promise<void> {
    if (this.stopPromise != null) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal(disposition);
    return this.stopPromise;
  }

  private async stopInternal(disposition: SessionStopDisposition): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopping";
    if (this.lifecycleSignal != null && this.lifecycleAbortListener != null) {
      this.lifecycleSignal.removeEventListener("abort", this.lifecycleAbortListener);
    }
    this.lifecycleSignal = undefined;
    this.lifecycleAbortListener = undefined;
    this.recoveryAbortController?.abort();
    this.recoveryAbortController = undefined;
    const active = this.turnCoordinator.activeTurn;
    if (active != null) {
      this.turnCoordinator.finishTurn(active, new CodexSessionAbortedError());
    }
    const errors = await this.cleanupResources();
    if (errors.length > 0) {
      for (const error of errors) {
        this.recordDiagnosticLocally("connection_stop_error", error);
        if (disposition.kind === "record") {
          this.options.onError(error);
        }
      }
      this.state = "failed";
      const failure = new CodexSessionError(
        "Codexセッションの停止に失敗しました。",
        new AggregateError(errors),
      );
      if (disposition.kind === "record") {
        throw createRecordedSessionFailure(failure, failure);
      }
      throw createUnrecordedSessionFailure(failure);
    }
    this.state = "stopped";
  }

  private async connectWithInitialRetry(signal: AbortSignal): Promise<void> {
    await this.connectionRecovery.connectWithInitialRetry(signal);
  }

  private async connectAndStartThread(signal: AbortSignal): Promise<void> {
    await connectAndStartCodexSession({
      expectedCodexHomePathProvider: this.options.expectedCodexHomePathProvider,
      hasTaskctlStartResult: () => this.taskctlStartResult != null,
      createConnectionOverrides: (expectedCodexHomePath) => {
        const taskctlStartResult = this.taskctlStartResult;
        if (taskctlStartResult == null) {
          throw new CodexSessionStateError();
        }
        return createCodexSessionConnectionOverrides(expectedCodexHomePath, {
          codexExecutablePath: this.options.codexExecutablePath,
          workspacePath: this.options.workspacePath,
          tmpDirectoryPath: this.options.tmpDirectoryPath,
          readOnlyVaultPaths: this.readOnlyVaultPaths,
          additionalLocalSocketPaths: this.additionalLocalSocketPaths,
          validateTaskctlLocalIpc: (tmpDirectoryPath) => validateTaskctlLocalIpc(taskctlStartResult, tmpDirectoryPath),
        });
      },
      connectionFactory: this.options.connectionFactory,
      clearStructuredOutputVerified: () => { this.structuredOutputVerified = false; },
      setConnection: (connection) => { this.connection = connection; },
      setRemoveNotificationListener: (remove) => { this.removeNotificationListener = remove; },
      setRemoveDiagnosticListener: (remove) => { this.removeDiagnosticListener = remove; },
      setRemoveDynamicToolListener: (remove) => { this.removeDynamicToolListener = remove; },
      receiveNotification: (notification) => this.receiveNotification(notification),
      receiveDiagnostic: (diagnostic) => this.receiveDiagnostic(diagnostic),
      handleDynamicTool: (params, toolSignal) => this.handleDynamicTool(params, toolSignal),
      clearConnectionConfigurationChanged: () => { this.connectionConfigurationChanged = false; },
      inspectAccount: (connection, inspectionSignal) => this.inspectAccount(connection, inspectionSignal),
      inspectModel: (connection, inspectionSignal) => this.inspectModel(connection, inspectionSignal),
      inspectSkills: (connection, inspectionSignal) => this.inspectSkills(connection, inspectionSignal),
      inspectPermissionProfile: (connection, inspectionSignal) => this.inspectPermissionProfile(connection, inspectionSignal),
      startThreadOnCurrentConnection: (threadSignal) => this.startThreadOnCurrentConnection(threadSignal),
      assertSafetyIntact: () => this.assertSafetyIntact(),
      isSafetyViolation: () => this.safetyViolation,
      setAuthenticationRequired: () => { this.state = "authentication_required"; },
      cleanupConnection: () => this.cleanupConnection(),
      createSafetyViolationError,
    }, signal);
  }

  private async restartConnectionForConfigurationChange(signal: AbortSignal): Promise<void> {
    await this.connectionRecovery.restartConnectionForConfigurationChange(signal);
  }

  private async inspectAccount(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<AccountInspectionResult> {
    return inspectCodexAccount(connection, signal);
  }

  private async inspectAccountWithRetry(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<AccountInspectionResult> {
    return inspectCodexAccountWithRetry(connection, signal, () => this.assertSafetyIntact());
  }

  private async inspectModel(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    this.selectedModel = undefined;
    this.selectedModel = await inspectCodexModel(connection, signal);
  }

  private async inspectSkills(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    this.skillConfiguration = await inspectCodexSkills(connection, signal, this.options.workspacePath);
    this.threadConfigurationChanged = false;
  }

  private async inspectPermissionProfile(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    await inspectCodexPermissionProfile(connection, signal, this.options.workspacePath);
  }

  private async startThreadOnCurrentConnection(signal: AbortSignal): Promise<void> {
    await startCodexSessionThread({
      connection: this.connection,
      requireSelectedModel: () => this.requireSelectedModel(),
      workspacePath: this.options.workspacePath,
      agentsFilePath: this.options.agentsFilePath,
      tmpDirectoryPath: this.options.tmpDirectoryPath,
      skillConfiguration: this.skillConfiguration,
      dynamicTools: [taskctlDynamicToolSpec, obsidianDynamicToolSpec, proposalWorkspaceToolSpec],
      isThreadConfigurationChanged: () => this.threadConfigurationChanged,
      clearThreadSettingsNotification: () => { this.threadSettingsNotification = undefined; },
      setThreadId: (threadId) => { this.threadId = threadId; },
      validateStoredThreadSettingsNotification: (threadId) => this.validateStoredThreadSettingsNotification(threadId),
      assertSafetyIntact: () => this.assertSafetyIntact(),
    }, signal);
  }

  private async handleDynamicTool(
    params: DynamicToolCallParams,
    signal: AbortSignal,
  ): Promise<DynamicToolCallResponse> {
    if (params.tool === proposalWorkspaceToolName) {
      return this.handleProposalWorkspaceTool(params, signal);
    }
    return this.dynamicToolHandler.handleDynamicTool(params, signal);
  }

  private handleProposalWorkspaceTool(params: DynamicToolCallParams, signal: AbortSignal): DynamicToolCallResponse {
    return handleCodexProposalWorkspaceTool(params, signal, {
      inputSchema: proposalWorkspaceToolInputSchema,
      getActiveTurn: () => this.turnCoordinator.activeTurn,
      getActiveWorkspace: () => this.activeProposalWorkspace,
      getThreadId: () => this.threadId,
      responseSerializer: this.responseSerializer,
      maximumArgumentBytes: maximumProposalWorkspaceArgumentBytes,
      readDraft: (workspace) => readProposalWorkspaceDraft(workspace, proposalSchema),
      createAbortError: () => new TaskctlAbortError(),
    });
  }

  private async executeObsidianQuery(
    query: CodexObsidianQuery,
    signal: AbortSignal,
  ): Promise<CodexObsidianResponse> {
    return executeCodexObsidianQuery(query, signal, this.options.obsidianReader);
  }

  private validateStoredThreadSettingsNotification(threadId: string): void {
    const notification = this.threadSettingsNotification;
    if (notification == null || notification.threadId !== threadId) {
      return;
    }
    if (!isValidThreadSettingsNotification(notification)) {
      if (notification.sandboxValidation.kind !== "valid") {
        this.markSafetyViolation(
          new CodexThreadStartCapabilityError(notification.sandboxValidation.failureCode),
          { kind: "record" },
        );
      } else {
        this.markSafetyViolation(
          new CodexSessionCapabilityError("Codexスレッドの権限制約が変更されました。"),
          { kind: "record" },
        );
      }
    }
  }

  private createStartResult(): CodexSessionStartResult {
    return createReadyCodexStartResult({
      resultSchema: codexSessionStartResultSchema,
      assertSafetyIntact: () => this.assertSafetyIntact(),
      taskctlStartResult: this.taskctlStartResult,
      workspacePath: this.options.workspacePath,
      agentsFilePath: this.options.agentsFilePath,
      threadId: this.threadId,
      requireSelectedModel: () => this.requireSelectedModel(),
      structuredOutputVerified: this.structuredOutputVerified,
    });
  }

  private requireSelectedModel(): string {
    const model = this.selectedModel;
    if (model == null) {
      throw new CodexSessionStateError();
    }
    return model;
  }

  private createAuthenticationRequiredResult(): CodexSessionStartResult {
    return createAuthenticationRequiredCodexStartResult({
      resultSchema: codexSessionStartResultSchema,
      assertSafetyIntact: () => this.assertSafetyIntact(),
      taskctlStartResult: this.taskctlStartResult,
      workspacePath: this.options.workspacePath,
      agentsFilePath: this.options.agentsFilePath,
    });
  }

  private receiveNotification(notification: CodexNotification): void {
    this.notificationRouter.receiveNotification(notification);
  }

  private receiveDiagnostic(diagnostic: CodexDiagnostic): void {
    this.notificationRouter.receiveDiagnostic(diagnostic);
  }

  private handleProcessExit(error: CodexProcessExitError): void {
    this.connectionRecovery.handleProcessExit(error);
  }

  private assertSafetyIntact(): void {
    if (this.safetyViolation) {
      throw createSafetyViolationError();
    }
  }

  private markSafetyViolation(
    cause: unknown,
    disposition: AiDisableDiagnosticDisposition,
  ): void {
    this.safetyViolation = true;
    void this.disableAi({
      cause,
      turnFailure: {
        kind: "provided",
        error: createSafetyViolationError(cause),
      },
      diagnosticDisposition: disposition,
    });
  }

  private disableAi(request: AiDisableRequest): Promise<AiDisableResult> {
    return this.beginAiDisable(request);
  }

  private disableAiAfterReportedTurnError(
    cause: unknown,
    turnError: unknown,
  ): Promise<AiDisableResult> {
    return this.beginAiDisable({
      cause,
      turnFailure: { kind: "provided", error: turnError },
      diagnosticDisposition: { kind: "already_recorded" },
    });
  }

  private beginAiDisable(request: AiDisableRequest): Promise<AiDisableResult> {
    if (this.disablePromise != null) {
      return this.disablePromise;
    }
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.resolve({ kind: "completed" });
    }
    if (this.state === "disabled") {
      return Promise.resolve({ kind: "completed" });
    }
    this.disablePromise = this.disableAiInternal(request);
    return this.disablePromise;
  }

  private async disableAiInternal(request: AiDisableRequest): Promise<AiDisableResult> {
    return disableCodexAi(request, {
      setDisabled: () => { this.state = "disabled"; },
      recordDiagnosticAndNotify: (code, error) => this.recordDiagnosticAndNotify(code, error),
      recordDiagnosticLocally: (code, error) => this.recordDiagnosticLocally(code, error),
      cleanupResources: () => this.cleanupResources(),
      getActiveTurn: () => this.turnCoordinator.activeTurn,
      finishTurn: (active, error) => this.turnCoordinator.finishTurn(active, error),
      createTurnFailure: (cause, cleanup) => new DiagnosticFailureDispositionError(
        combineDiagnosticFailureDispositions(cause, cleanup),
      ),
    });
  }

  private async cleanupConnection(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const removeNotificationListener = this.removeNotificationListener;
    const removeDiagnosticListener = this.removeDiagnosticListener;
    const removeDynamicToolListener = this.removeDynamicToolListener;
    this.removeNotificationListener = undefined;
    this.removeDiagnosticListener = undefined;
    this.removeDynamicToolListener = undefined;
    if (removeNotificationListener != null) {
      try {
        removeNotificationListener();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (removeDiagnosticListener != null) {
      try {
        removeDiagnosticListener();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (removeDynamicToolListener != null) {
      try {
        removeDynamicToolListener();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    const connection = this.connection;
    this.connection = undefined;
    this.threadId = undefined;
    this.threadSettingsNotification = undefined;
    this.skillConfiguration = [];
    this.threadConfigurationChanged = false;
    this.connectionConfigurationChanged = false;
    this.frozenTaskctlSnapshot = undefined;
    if (connection != null) {
      try {
        await connection.stop();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async cleanupResources(): Promise<unknown[]> {
    const errors = await this.cleanupConnection();
    try {
      await this.broker.stop();
    } catch (error: unknown) {
      errors.push(error);
    }
    return errors;
  }

  private recordDiagnosticLocally(
    code: CodexSessionDiagnostic["code"],
    cause: unknown,
  ): void {
    if (this.diagnostics.length >= maximumStoredDiagnostics) {
      this.diagnostics.shift();
    }
    this.diagnostics.push({ code, cause });
  }

  private recordDiagnosticAndNotify(
    code: CodexSessionDiagnostic["code"],
    cause: unknown,
  ): void {
    this.recordDiagnosticLocally(code, cause);
    this.options.onError(cause);
  }

}
