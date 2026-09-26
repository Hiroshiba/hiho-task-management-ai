import { z } from "zod";
import {
  accountReadParamsSchema,
  accountReadResultSchema,
  chatGptLoginStartParamsSchema,
  chatGptLoginStartResultSchema,
  codexDiagnosticSchema,
  codexNotificationSchema,
  codexRpcIdSchema,
  dynamicToolCallParamsSchema,
  dynamicToolCallResponseSchema,
  experimentalFeatureListParamsSchema,
  experimentalFeatureListResultSchema,
  modelListParamsSchema,
  modelListResultSchema,
  mcpServerStatusListParamsSchema,
  mcpServerStatusListResultSchema,
  permissionProfileListParamsSchema,
  permissionProfileListResultSchema,
  skillsListParamsSchema,
  skillsListResultSchema,
  threadStartParamsSchema,
  threadStartResultSchema,
  turnInterruptParamsSchema,
  turnInterruptResultSchema,
  turnStartParamsSchema,
  turnStartResultSchema,
  type AccountReadParams,
  type AccountReadResult,
  type ChatGptLoginStartParams,
  type ChatGptLoginStartResult,
  type CodexDiagnostic,
  type CodexNotification,
  type CodexRpcId,
  type DynamicToolCallParams,
  type DynamicToolCallResponse,
  type ExperimentalFeatureListParams,
  type ExperimentalFeatureListResult,
  type ModelListParams,
  type ModelListResult,
  type McpServerStatusListParams,
  type McpServerStatusListResult,
  type PermissionProfileListParams,
  type PermissionProfileListResult,
  type SkillsListParams,
  type SkillsListResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnStartParams,
  type TurnStartResult,
} from "./index";
import {
  CodexConnectionStateError,
  CodexConnectionStoppedError,
  codexRpcCodeSchema,
  codexRpcOperationSchema,
  CodexPendingRequestLimitError,
  CodexProtocolError,
  CodexResponseValidationError,
  CodexRequestAbortedError,
  CodexRequestIdExhaustedError,
  CodexRequestTimeoutError,
  CodexRpcError,
  CodexUnknownResponseIdError,
} from "./errors";

const maxPendingRequests = 128;
const maxStoredDiagnostics = 256;
const maxRequestId = Number.MAX_SAFE_INTEGER;

type CodexErrorHandler = (error: unknown) => void;

const codexErrorHandlerSchema = z.custom<CodexErrorHandler>(
  (value) => typeof value === "function",
  "Codexエラー記録関数が必要です。",
);

const rpcResponseResultSchema = z
  .object({
    id: codexRpcIdSchema,
    result: z.unknown(),
  })
  .strict();

const rpcErrorSchema = z
  .object({
    code: codexRpcCodeSchema,
    message: z.string().min(1).max(2_000),
    data: z.unknown().optional(),
  })
  .strict();

const rpcResponseErrorSchema = z
  .object({
    id: codexRpcIdSchema,
    error: rpcErrorSchema,
  })
  .strict();

const rpcNotificationEnvelopeSchema = z
  .object({
    method: z.string().min(1).max(200),
    params: z.unknown().optional(),
    emittedAtMs: z.number().finite().optional(),
  })
  .strip();

const rpcServerRequestEnvelopeSchema = z
  .object({
    method: z.string().min(1).max(200),
    id: codexRpcIdSchema,
    params: z.unknown().optional(),
  })
  .strict();

type RpcResponseResult = z.infer<typeof rpcResponseResultSchema>;
type RpcResponseError = z.infer<typeof rpcResponseErrorSchema>;
type RpcNotificationEnvelope = z.infer<typeof rpcNotificationEnvelopeSchema>;
type RpcServerRequestEnvelope = z.infer<typeof rpcServerRequestEnvelopeSchema>;
interface PendingRequest {
  readonly operation: z.infer<typeof codexRpcOperationSchema>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timeout: NodeJS.Timeout;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
}

type ConnectionState = "created" | "starting" | "ready" | "failed" | "stopping" | "stopped";

/** 型付きCodex通知を受け取る購読関数の型です。 */
export type CodexNotificationListener =
  (notification: CodexNotification) => void | PromiseLike<void>;

/** Codex診断を受け取る購読関数の型です。 */
export type CodexDiagnosticListener =
  (diagnostic: CodexDiagnostic) => void | PromiseLike<void>;

/** Codex dynamic toolの呼び出しを処理する関数の型です。 */
export type CodexDynamicToolHandler = (
  params: DynamicToolCallParams,
  signal: AbortSignal,
) => DynamicToolCallResponse | PromiseLike<DynamicToolCallResponse>;

function responseIdKey(id: CodexRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/** RPC要求と起動に渡された中断信号を検証します。 */
export function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function compareNumericRequestId(id: CodexRpcId, nextId: number): boolean {
  return (
    typeof id === "number" &&
    Number.isSafeInteger(id) &&
    id > 0 &&
    id < nextId
  );
}

function knownNotificationMethod(method: string): boolean {
  return [
    "thread/started",
    "turn/started",
    "turn/completed",
    "item/completed",
    "thread/settings/updated",
    "account/updated",
    "account/login/completed",
    "skills/changed",
    "item/agentMessage/delta",
  ].includes(method);
}

/** Codex app-serverのRPC要求、応答、通知を管理します。 */
export abstract class CodexRpcEndpoint {
  protected state: ConnectionState = "created";
  protected terminalError: Error | undefined;
  protected dynamicToolHandler: CodexDynamicToolHandler | undefined;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly dynamicToolRequests = new Map<string, AbortController>();
  private readonly diagnostics: CodexDiagnostic[] = [];
  private readonly notificationListeners = new Set<CodexNotificationListener>();
  private readonly diagnosticListeners = new Set<CodexDiagnosticListener>();
  private readonly requestTimeoutMs: number;
  private readonly onError: CodexErrorHandler;

  protected constructor(requestTimeoutMs: number, onError: CodexErrorHandler) {
    this.requestTimeoutMs = requestTimeoutMs;
    this.onError = codexErrorHandlerSchema.parse(onError);
  }

  protected abstract writeMessage(message: unknown): Promise<void>;
  protected abstract failConnection(error: unknown): void;

  /** account/readで現在のCodex認証状態を取得します。 */
  public async readAccount(
    params: AccountReadParams,
    signal: AbortSignal,
  ): Promise<AccountReadResult> {
    const validatedParams = accountReadParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "account/read",
      validatedParams,
      accountReadResultSchema,
      signal,
    );
  }

  /** ChatGPTブラウザログインを開始します。 */
  public async startChatGptLogin(
    params: ChatGptLoginStartParams,
    signal: AbortSignal,
  ): Promise<ChatGptLoginStartResult> {
    const validatedParams = chatGptLoginStartParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "account/login/start",
      validatedParams,
      chatGptLoginStartResultSchema,
      signal,
    );
  }

  /** 利用可能なCodexモデルを取得します。 */
  public async listModels(
    params: ModelListParams,
    signal: AbortSignal,
  ): Promise<ModelListResult> {
    const validatedParams = modelListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "model/list",
      validatedParams,
      modelListResultSchema,
      signal,
    );
  }

  /** 利用可能なスキル一覧を取得します。 */
  public async listSkills(
    params: SkillsListParams,
    signal: AbortSignal,
  ): Promise<SkillsListResult> {
    const validatedParams = skillsListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "skills/list",
      validatedParams,
      skillsListResultSchema,
      signal,
    );
  }

  /** 利用可能な権限プロファイルを取得します。 */
  public async listPermissionProfiles(
    params: PermissionProfileListParams,
    signal: AbortSignal,
  ): Promise<PermissionProfileListResult> {
    const validatedParams = permissionProfileListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "permissionProfile/list",
      validatedParams,
      permissionProfileListResultSchema,
      signal,
    );
  }

  /** 接続中のMCPサーバー状態を取得します。 */
  public async listMcpServerStatuses(
    params: McpServerStatusListParams,
    signal: AbortSignal,
  ): Promise<McpServerStatusListResult> {
    const validatedParams = mcpServerStatusListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "mcpServerStatus/list",
      validatedParams,
      mcpServerStatusListResultSchema,
      signal,
    );
  }

  /** 実効化されたCodex機能一覧を取得します。 */
  public async listExperimentalFeatures(
    params: ExperimentalFeatureListParams,
    signal: AbortSignal,
  ): Promise<ExperimentalFeatureListResult> {
    const validatedParams = experimentalFeatureListParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "experimentalFeature/list",
      validatedParams,
      experimentalFeatureListResultSchema,
      signal,
    );
  }

  /** 新しいCodexスレッドを開始します。 */
  public async startThread(
    params: ThreadStartParams,
    signal: AbortSignal,
  ): Promise<ThreadStartResult> {
    const validatedParams = threadStartParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "thread/start",
      validatedParams,
      threadStartResultSchema,
      signal,
    );
  }

  /** Codexスレッドのターンを開始します。 */
  public async startTurn(
    params: TurnStartParams,
    signal: AbortSignal,
  ): Promise<TurnStartResult> {
    const validatedParams = turnStartParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "turn/start",
      validatedParams,
      turnStartResultSchema,
      signal,
    );
  }

  /** 実行中のCodexターンを中断します。 */
  public async interruptTurn(
    params: TurnInterruptParams,
    signal: AbortSignal,
  ): Promise<TurnInterruptResult> {
    const validatedParams = turnInterruptParamsSchema.parse(params);
    validateAbortSignal(signal);
    this.ensureReady();
    return this.requestInternal(
      "turn/interrupt",
      validatedParams,
      turnInterruptResultSchema,
      signal,
    );
  }

  /** Codex dynamic toolのhandlerを登録します。 */
  public onDynamicToolCall(handler: CodexDynamicToolHandler): () => void {
    if (typeof handler !== "function") {
      throw new TypeError("Codex dynamic toolのhandlerが必要です。");
    }
    if (
      this.state === "failed"
      || this.state === "stopping"
      || this.state === "stopped"
    ) {
      throw new CodexConnectionStateError();
    }
    if (this.dynamicToolHandler != null) {
      throw new CodexConnectionStateError();
    }
    this.dynamicToolHandler = handler;
    return () => {
      if (this.dynamicToolHandler !== handler) {
        return;
      }
      this.dynamicToolHandler = undefined;
    };
  }

  /** 型付き通知の購読を登録します。 */
  public onNotification(listener: CodexNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  /** Codex診断の購読を登録します。 */
  public onDiagnostic(listener: CodexDiagnosticListener): () => void {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  }

  /** 保持中のCodex診断を読み出します。 */
  public getDiagnostics(): readonly CodexDiagnostic[] {
    return [...this.diagnostics];
  }

  protected ensureReady(): void {
    if (this.state !== "ready") {
      if (this.state === "stopped" || this.state === "stopping") {
        throw new CodexConnectionStoppedError();
      }
      throw new CodexConnectionStateError();
    }
  }

  protected requestInternal<Output>(
    operation: z.infer<typeof codexRpcOperationSchema>,
    params: unknown,
    schema: z.ZodType<Output>,
    signal: AbortSignal,
  ): Promise<Output> {
    validateAbortSignal(signal);
    const validatedOperation = codexRpcOperationSchema.parse(operation);
    if (this.state !== "starting" && this.state !== "ready") {
      if (this.state === "stopped" || this.state === "stopping") {
        return Promise.reject(new CodexConnectionStoppedError());
      }
      if (this.terminalError != null) {
        return Promise.reject(this.terminalError);
      }
      return Promise.reject(new CodexConnectionStateError());
    }
    if (this.pendingRequests.size >= maxPendingRequests) {
      return Promise.reject(new CodexPendingRequestLimitError());
    }
    if (this.nextRequestId >= maxRequestId) {
      return Promise.reject(new CodexRequestIdExhaustedError());
    }
    if (signal.aborted) {
      return Promise.reject(new CodexRequestAbortedError(validatedOperation));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    const key = responseIdKey(id);

    return new Promise<Output>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.handleRequestTimeout(key, validatedOperation);
      }, this.requestTimeoutMs);
      const abortListener = (): void => {
        this.handleRequestAbort(key, validatedOperation);
      };
      this.pendingRequests.set(key, {
        operation: validatedOperation,
        resolve: (value: unknown) => {
          resolve(schema.parse(value));
        },
        reject,
        timeout,
        signal,
        abortListener,
      });
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        this.handleRequestAbort(key, validatedOperation);
        return;
      }
      try {
        void this.writeMessage({ method: validatedOperation, id, params }).catch((error: unknown) => {
          this.failConnection(error);
        });
      } catch (error: unknown) {
        const pending = this.pendingRequests.get(key);
        if (pending != null) {
          this.pendingRequests.delete(key);
          this.cleanupPending(pending);
        }
        this.failConnection(error);
        const rejection =
          error instanceof Error
            ? error
            : new Error("Codex app-server要求の送信に失敗しました。", { cause: error });
        reject(rejection);
      }
    });
  }

  protected sendNotification(method: string, params: unknown): Promise<void> {
    return this.writeMessage({ method, params });
  }

  protected handleParsedMessage(parsed: unknown): void {
    const result = rpcResponseResultSchema.safeParse(parsed);
    if (result.success) {
      this.handleResponseResult(result.data);
      return;
    }
    const errorResponse = rpcResponseErrorSchema.safeParse(parsed);
    if (errorResponse.success) {
      this.handleResponseError(errorResponse.data);
      return;
    }
    const serverRequest = rpcServerRequestEnvelopeSchema.safeParse(parsed);
    if (serverRequest.success) {
      this.handleServerRequest(serverRequest.data);
      return;
    }
    const notification = rpcNotificationEnvelopeSchema.safeParse(parsed);
    if (notification.success) {
      this.handleNotification(notification.data);
      return;
    }
    throw new CodexProtocolError(
      "invalid_message",
      new Error("Codex app-serverメッセージの形式が不正です。"),
    );
  }

  private handleResponseResult(response: RpcResponseResult): void {
    this.ensureIssuedNumericResponseId(response.id);
    const key = responseIdKey(response.id);
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    try {
      pending.resolve(response.result);
    } catch (error: unknown) {
      const validationError = new CodexResponseValidationError(error);
      pending.reject(validationError);
      throw validationError;
    }
  }

  private handleResponseError(response: RpcResponseError): void {
    this.ensureIssuedNumericResponseId(response.id);
    const key = responseIdKey(response.id);
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    const rpcError = new CodexRpcError(
      pending.operation,
      response.error.code,
      response.error.message,
    );
    pending.reject(rpcError);
  }

  private ensureIssuedNumericResponseId(id: CodexRpcId): void {
    if (!compareNumericRequestId(id, this.nextRequestId)) {
      throw new CodexUnknownResponseIdError();
    }
  }

  private handleNotification(notification: RpcNotificationEnvelope): void {
    if (!knownNotificationMethod(notification.method)) {
      this.emitDiagnostic({
        kind: "unknown_notification",
        code: "unknown_notification",
        method: notification.method,
      });
      return;
    }
    const known = codexNotificationSchema.safeParse({
      method: notification.method,
      ...(notification.params === undefined ? {} : { params: notification.params }),
    });
    if (!known.success) {
      throw new CodexProtocolError(
        "invalid_message",
        new Error("既知のCodex通知を検証できません。"),
      );
    }
    this.emitNotification(known.data);
  }

  private handleServerRequest(request: RpcServerRequestEnvelope): void {
    const handler = this.dynamicToolHandler;
    if (request.method === "item/tool/call" && handler != null) {
      const parsedParams = dynamicToolCallParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.emitDiagnostic({
          kind: "protocol_error",
          code: "protocol_error",
          error: parsedParams.error,
        });
        this.sendServerRequestError(
          request.id,
          -32602,
          "Codex dynamic toolの引数が不正です。",
        );
        return;
      }
      this.startDynamicToolCall(request.id, parsedParams.data, handler);
      return;
    }
    this.emitDiagnostic({
      kind: "server_request_rejected",
      code: "server_request_rejected",
      method: request.method,
    });
    this.sendServerRequestError(
      request.id,
      -32601,
      "サーバー開始要求は許可されていません。",
    );
  }

  private startDynamicToolCall(
    id: CodexRpcId,
    params: DynamicToolCallParams,
    handler: CodexDynamicToolHandler,
  ): void {
    const key = responseIdKey(id);
    if (this.dynamicToolRequests.has(key)) {
      const protocolError = new CodexProtocolError(
        "invalid_message",
        new Error("Codex dynamic tool要求IDが重複しています。"),
      );
      this.emitDiagnostic({
        kind: "protocol_error",
        code: "protocol_error",
        error: protocolError,
      });
      this.sendServerRequestError(
        id,
        -32600,
        "Codex dynamic tool要求が不正です。",
      );
      return;
    }
    const controller = new AbortController();
    this.dynamicToolRequests.set(key, controller);
    const responsePromise = Promise.resolve()
      .then(() => handler(params, controller.signal))
      .then((response) => dynamicToolCallResponseSchema.parse(response));
    void responsePromise.then(
      (response) => {
        if (
          controller.signal.aborted
          || this.state === "failed"
          || this.state === "stopping"
          || this.state === "stopped"
        ) {
          return;
        }
        return this.writeMessage({ id, result: response });
      },
      (error: unknown) => this.respondDynamicToolError(id, controller, error),
    ).catch((error: unknown) => {
      this.failConnection(error);
    }).finally(() => {
      if (this.dynamicToolRequests.get(key) === controller) {
        this.dynamicToolRequests.delete(key);
      }
    });
  }

  private respondDynamicToolError(
    id: CodexRpcId,
    controller: AbortController,
    error: unknown,
  ): Promise<void> {
    if (
      controller.signal.aborted
      || this.state === "failed"
      || this.state === "stopping"
      || this.state === "stopped"
    ) {
      return Promise.resolve();
    }
    this.emitDiagnostic({
      kind: "protocol_error",
      code: "protocol_error",
      error,
    });
    return this.writeMessage({
      id,
      error: {
        code: -32603,
        message: "Codex dynamic toolの内部エラーが発生しました。",
      },
    });
  }

  private sendServerRequestError(
    id: CodexRpcId,
    code: number,
    message: string,
  ): void {
    void this.writeMessage({
      id,
      error: { code, message },
    }).catch((error: unknown) => {
      this.failConnection(error);
    });
  }

  protected abortDynamicToolRequests(): void {
    for (const controller of this.dynamicToolRequests.values()) {
      controller.abort();
    }
    this.dynamicToolRequests.clear();
  }

  private handleRequestTimeout(key: string, method: string): void {
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    pending.reject(new CodexRequestTimeoutError(method));
  }

  private handleRequestAbort(key: string, method: string): void {
    const pending = this.pendingRequests.get(key);
    if (pending == null) {
      return;
    }
    this.pendingRequests.delete(key);
    this.cleanupPending(pending);
    pending.reject(new CodexRequestAbortedError(method));
  }

  private cleanupPending(pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    pending.signal.removeEventListener("abort", pending.abortListener);
  }

  private emitNotification(notification: CodexNotification): void {
    for (const listener of this.notificationListeners) {
      try {
        const result = listener(notification);
        this.handleListenerResult(result, "notification");
      } catch (error: unknown) {
        this.reportListenerError("notification", error);
      }
    }
  }

  protected emitDiagnostic(diagnostic: CodexDiagnostic): void {
    const validatedDiagnostic = codexDiagnosticSchema.parse(diagnostic);
    this.storeDiagnostic(validatedDiagnostic);
    this.notifyDiagnosticListeners(validatedDiagnostic);
  }

  private notifyDiagnosticListeners(diagnostic: CodexDiagnostic): void {
    for (const listener of this.diagnosticListeners) {
      try {
        const result = listener(diagnostic);
        this.handleListenerResult(result, "diagnostic");
      } catch (error: unknown) {
        this.storeListenerError("diagnostic", error);
      }
    }
  }

  private handleListenerResult(
    result: void | PromiseLike<void>,
    source: "notification" | "diagnostic",
  ): void {
    if (result == null) {
      return;
    }
    void Promise.resolve(result).catch((error: unknown) => {
      this.reportListenerError(source, error);
    });
  }

  private reportListenerError(source: "notification" | "diagnostic", error: unknown): void {
    if (source === "notification") {
      this.emitDiagnostic({
        kind: "listener_error",
        code: "listener_error",
        source,
        error,
      });
      return;
    }
    this.storeListenerError(source, error);
  }

  private storeListenerError(source: "notification" | "diagnostic", error: unknown): void {
    this.storeDiagnostic({
      kind: "listener_error",
      code: "listener_error",
      source,
      error,
    });
    this.onError(error);
  }

  private storeDiagnostic(diagnostic: CodexDiagnostic): void {
    if (this.diagnostics.length >= maxStoredDiagnostics) {
      this.diagnostics.shift();
    }
    this.diagnostics.push(diagnostic);
  }

  protected toConnectionError(error: unknown): Error {
    if (
      error instanceof CodexProtocolError ||
      error instanceof CodexUnknownResponseIdError ||
      error instanceof CodexRpcError ||
      error instanceof CodexResponseValidationError
    ) {
      return error;
    }
    return new CodexProtocolError("invalid_message", error);
  }

  protected rejectPending(error: unknown): void {
    for (const pending of this.pendingRequests.values()) {
      this.cleanupPending(pending);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

}
