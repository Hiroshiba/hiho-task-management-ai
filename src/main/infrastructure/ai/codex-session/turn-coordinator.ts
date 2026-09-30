import { z } from "zod";
import {
  turnStartParamsSchema,
  turnStartResultSchema,
  turnInterruptParamsSchema,
  turnInterruptResultSchema,
  type TurnStartResult,
} from "../codex-app-server";
import type { CodexRpcEndpoint } from "../codex-app-server/rpc-endpoint";
import { validateAbortSignal } from "../codex-app-server/rpc-endpoint";
import { validateTurnSkills } from "./capability-policy";
import { prependModelFormatInstruction } from "./turn-output";
import type { CodexNotification } from "../codex-app-server";
import {
  CodexSessionAbortedError,
  CodexSessionOutputValidationError,
  CodexSessionTurnError,
  CodexSessionCapabilityError,
  CodexSessionDisabledError,
  CodexSessionError,
  CodexSessionStateError,
  CodexSessionSyncError,
} from "./errors";
import { isTurnNotification, notificationThreadId, notificationTurnId } from "./notification-methods";

const maximumBufferedNotifications = 128;

type TurnFinalItem = {
  readonly id: string;
  readonly text: string;
  readonly phase: "final_answer";
};

type TurnCompletion = {
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
  readonly error: unknown;
};

export type ActiveTurnStarting<Result> = {
  readonly phase: "starting";
  readonly threadId: string;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly bufferedNotifications: CodexNotification[];
  abortRequested: boolean;
};

export type ActiveTurnRunning<Result, Connection> = {
  readonly phase: "running";
  readonly threadId: string;
  readonly turnId: string;
  readonly resolve: (result: Result) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly connection: Connection;
  abortRequested: boolean;
  interruptSent: boolean;
  finalItem: TurnFinalItem | undefined;
  completion: TurnCompletion | undefined;
};

export type ActiveTurn<Result, Connection> =
  | ActiveTurnStarting<Result>
  | ActiveTurnRunning<Result, Connection>;

type TurnInputItem =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "skill"; readonly name: string; readonly path: string };

type DeltaListener<Delta> = (delta: Delta) => void | PromiseLike<void>;

type TurnCoordinatorOptions<Result, Delta, Response, Connection extends Pick<CodexRpcEndpoint, "startTurn" | "interruptTurn">, Input extends TurnInputItem[]> = {
  readonly inputSchema: z.ZodType<Input>;
  readonly inputFactorySchema: z.ZodType<(signal: AbortSignal) => Input | PromiseLike<Input>>;
  readonly workspacePath: string;
  readonly modelFormatInstruction: string;
  readonly structuredOutputSchema: Record<string, unknown>;
  readonly syncBeforeTurn: (signal: AbortSignal) => void | PromiseLike<void>;
  readonly isThreadConfigurationChanged: () => boolean;
  readonly getState: () => string;
  readonly setTurning: () => void;
  readonly getConnection: () => Connection | undefined;
  readonly getThreadId: () => string | undefined;
  readonly requireSelectedModel: () => string;
  readonly isStructuredOutputVerified: () => boolean;
  readonly recoverAfterStartingAbort: (active: ActiveTurnStarting<Result>, cause: unknown) => Promise<void>;
  readonly disableAi: (request: {
    cause: unknown;
    turnFailure: { kind: "disabled" } | { kind: "provided"; error: unknown };
    diagnosticDisposition: { kind: "record" } | { kind: "already_recorded" } | { kind: "propagate_unrecorded" };
  }) => Promise<unknown>;
  readonly disableAiAfterReportedTurnError: (cause: unknown, turnError: unknown) => Promise<unknown>;

  readonly finalItemSchema: z.ZodType<TurnFinalItem>;
  readonly turnResultSchema: z.ZodType<Result>;
  readonly deltaSchema: z.ZodType<Delta>;
  readonly parseOutput: (text: string) => Response;
  readonly createUnrecordedFailure: (error: unknown) => unknown;
  readonly recordDiagnosticLocally: (code: "sync_error" | "turn_error" | "output_validation_error", error: unknown) => void;
  readonly recordDiagnosticAndNotify: (code: "connection_protocol_error" | "listener_error" | "turn_error", error: unknown) => void;
  readonly onOutputVerified: () => void;
  readonly onTurnFinished: () => void;
};

/** Codexターンの通知順序、最終結果、差分購読を管理します。 */
export class CodexTurnCoordinator<Result, Delta, Response, Connection extends Pick<CodexRpcEndpoint, "startTurn" | "interruptTurn">, Input extends TurnInputItem[]> {
  public activeTurn: ActiveTurn<Result, Connection> | undefined;
  private readonly deltaListeners = new Set<DeltaListener<Delta>>();
  private readonly options: TurnCoordinatorOptions<Result, Delta, Response, Connection, Input>;

  public constructor(options: TurnCoordinatorOptions<Result, Delta, Response, Connection, Input>) {
    this.options = options;
  }

  /** 同期後に構造化出力を指定して一つのCodexターンを開始します。 */
  public async startTurn(
    input: Input,
    signal: AbortSignal,
  ): Promise<Result> {
    validateAbortSignal(signal);
    const validatedInput = this.options.inputSchema.parse(input);
    validateTurnSkills(validatedInput, this.options.workspacePath);
    return this.startTurnWithPreparation(() => validatedInput, signal);
  }

  /** 同期完了後にターン入力を作成して構造化出力を指定したCodexターンを開始します。 */
  public async startTurnWithPreparation(
    prepareInput: (signal: AbortSignal) => Input | PromiseLike<Input>,
    signal: AbortSignal,
  ): Promise<Result> {
    validateAbortSignal(signal);
    const validatedPrepareInput = this.options.inputFactorySchema.parse(prepareInput);
    if (this.options.isThreadConfigurationChanged()) {
      throw new CodexSessionCapabilityError(
        "Codexスレッド構成が変更されました。新しいセッションを開始してください。",
      );
    }
    if (this.options.getState() !== "ready" || this.activeTurn != null) {
      if (this.options.getState() === "disabled") {
        throw new CodexSessionDisabledError();
      }
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const connection = this.options.getConnection();
    const currentThreadId = this.options.getThreadId();
    if (connection == null || currentThreadId == null) {
      throw new CodexSessionStateError();
    }

    let activeTurn: ActiveTurnStarting<Result> | undefined;
    const turnPromise = new Promise<Result>((resolve, reject) => {
      const abortListener = (): void => {
        const current = this.activeTurn;
        if (current == null || current.threadId !== currentThreadId) {
          return;
        }
        current.abortRequested = true;
        if (current.phase === "running") {
          void this.interruptAfterAbort(current);
        }
      };
      activeTurn = {
        phase: "starting",
        threadId: currentThreadId,
        resolve,
        reject,
        signal,
        abortListener,
        bufferedNotifications: [],
        abortRequested: false,
      };
    });
    const createdActiveTurn = activeTurn;
    if (createdActiveTurn == null) {
      throw new CodexSessionError("Codexターンの初期化に失敗しました。");
    }
    this.activeTurn = createdActiveTurn;
    this.options.setTurning();
    signal.addEventListener("abort", createdActiveTurn.abortListener, { once: true });
    if (signal.aborted) {
      createdActiveTurn.abortListener();
    }

    try {
      await this.options.syncBeforeTurn(signal);
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      } else {
        this.options.recordDiagnosticLocally("sync_error", error);
        const syncError = new CodexSessionSyncError(error);
        this.finishTurn(
          createdActiveTurn,
          this.options.createUnrecordedFailure(syncError),
        );
      }
      return turnPromise;
    }
    if (createdActiveTurn.abortRequested || signal.aborted) {
      this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      return turnPromise;
    }
    if (this.activeTurn !== createdActiveTurn) {
      return turnPromise;
    }

    let validatedInput: Input;
    try {
      validatedInput = this.options.inputSchema.parse(
        await Promise.resolve(validatedPrepareInput(signal)),
      );
      validateTurnSkills(validatedInput, this.options.workspacePath);
      validatedInput = prependModelFormatInstruction(
        validatedInput,
        this.options.modelFormatInstruction,
        this.options.inputSchema,
      );
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      } else {
        this.options.recordDiagnosticLocally("turn_error", error);
        this.finishTurn(
          createdActiveTurn,
          this.options.createUnrecordedFailure(error),
        );
      }
      return turnPromise;
    }

    let params: ReturnType<typeof turnStartParamsSchema.parse>;
    try {
      params = turnStartParamsSchema.parse({
        threadId: currentThreadId,
        input: validatedInput,
        cwd: this.options.workspacePath,
        approvalPolicy: "never",
        model: this.options.requireSelectedModel(),
        outputSchema: this.options.structuredOutputSchema,
      });
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      } else {
        this.options.recordDiagnosticLocally("turn_error", error);
        this.finishTurn(
          createdActiveTurn,
          this.options.createUnrecordedFailure(error),
        );
      }
      return turnPromise;
    }

    let started: TurnStartResult;
    try {
      started = await connection.startTurn(params, signal);
      started = turnStartResultSchema.parse(started);
    } catch (error: unknown) {
      if (this.activeTurn !== createdActiveTurn) {
        return turnPromise;
      }
      if (createdActiveTurn.abortRequested || signal.aborted) {
        await this.options.recoverAfterStartingAbort(createdActiveTurn, error);
      } else if (!this.options.isStructuredOutputVerified()) {
        await this.options.disableAi({
          cause: error,
          turnFailure: { kind: "provided", error },
          diagnosticDisposition: { kind: "propagate_unrecorded" },
        });
      } else {
        this.options.recordDiagnosticLocally("turn_error", error);
        this.finishTurn(
          createdActiveTurn,
          this.options.createUnrecordedFailure(error),
        );
      }
      return turnPromise;
    }
    if (this.activeTurn !== createdActiveTurn) {
      return turnPromise;
    }
    if (createdActiveTurn.abortRequested || signal.aborted) {
      await this.options.recoverAfterStartingAbort(
        createdActiveTurn,
        new CodexSessionAbortedError(),
      );
      return turnPromise;
    }
    const runningTurn: ActiveTurnRunning<Result, Connection> = {
      phase: "running",
      threadId: currentThreadId,
      turnId: started.turn.id,
      resolve: createdActiveTurn.resolve,
      reject: createdActiveTurn.reject,
      signal: createdActiveTurn.signal,
      abortListener: createdActiveTurn.abortListener,
      connection,
      abortRequested: createdActiveTurn.abortRequested,
      interruptSent: false,
      finalItem: undefined,
      completion: undefined,
    };
    this.activeTurn = runningTurn;
    if (runningTurn.abortRequested) {
      void this.interruptAfterAbort(runningTurn);
    }
    this.processBufferedNotifications(runningTurn, createdActiveTurn.bufferedNotifications);
    this.completeTurnIfReady(runningTurn);
    return turnPromise;
  }

  private async interruptAfterAbort(active: ActiveTurnRunning<Result, Connection>): Promise<void> {
    if (this.activeTurn !== active || active.interruptSent) {
      return;
    }
    active.interruptSent = true;
    const controller = new AbortController();
    const params = turnInterruptParamsSchema.parse({
      threadId: active.threadId,
      turnId: active.turnId,
    });
    try {
      const result = await active.connection.interruptTurn(params, controller.signal);
      turnInterruptResultSchema.parse(result);
    } catch (error: unknown) {
      this.options.recordDiagnosticAndNotify("turn_error", error);
      await this.options.disableAiAfterReportedTurnError(
        error,
        new CodexSessionAbortedError(),
      );
    }
  }

  /** 実行中のCodexターンを中断します。 */
  public async interrupt(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    const current = this.activeTurn;
    if (
      this.options.getState() !== "turning"
      || current == null
      || current.phase !== "running"
    ) {
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const params = turnInterruptParamsSchema.parse({
      threadId: current.threadId,
      turnId: current.turnId,
    });
    const result = await current.connection.interruptTurn(params, signal);
    turnInterruptResultSchema.parse(result);
  }

  /** ターン差分の購読を登録します。 */
  public onDelta(listener: DeltaListener<Delta>): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** 開始中の通知を保持し、実行中の通知を処理します。 */
  public handleTurnNotification(
    notification: CodexNotification,
    recoverAfterStartingAbort: (active: ActiveTurnStarting<Result>, error: CodexSessionTurnError) => void,
  ): void {
    const active = this.activeTurn;
    if (active == null || !isTurnNotification(notification)) {
      return;
    }
    if (notificationThreadId(notification) !== active.threadId) {
      return;
    }
    if (active.phase === "starting") {
      if (active.abortRequested) {
        return;
      }
      if (active.bufferedNotifications.length >= maximumBufferedNotifications) {
        active.abortRequested = true;
        recoverAfterStartingAbort(active, new CodexSessionTurnError());
        return;
      }
      active.bufferedNotifications.push(notification);
      return;
    }
    if (notificationTurnId(notification) !== active.turnId) {
      return;
    }
    this.handleRunningTurnNotification(active, notification);
  }

  /** 開始中に保留した通知を受信順に処理します。 */
  public processBufferedNotifications(
    active: ActiveTurnRunning<Result, Connection>,
    notifications: readonly CodexNotification[],
  ): void {
    for (const notification of notifications) {
      if (this.activeTurn !== active) {
        return;
      }
      if (notificationTurnId(notification) !== active.turnId) {
        continue;
      }
      this.handleRunningTurnNotification(active, notification);
    }
  }

  /** ターンを一度だけ完了し、中断購読とターン状態を解放します。 */
  public finishTurn(active: ActiveTurn<Result, Connection>, value: unknown): void {
    if (this.activeTurn !== active) {
      return;
    }
    this.activeTurn = undefined;
    active.signal.removeEventListener("abort", active.abortListener);
    this.options.onTurnFinished();
    if (this.isTurnResult(value)) {
      active.resolve(value);
      return;
    }
    active.reject(value);
  }

  private handleRunningTurnNotification(
    active: ActiveTurnRunning<Result, Connection>,
    notification: CodexNotification,
  ): void {
    switch (notification.method) {
      case "turn/started":
        return;
      case "turn/completed":
        active.completion = {
          status: notification.params.turn.status,
          error: notification.params.turn.error,
        };
        this.completeTurnIfReady(active);
        return;
      case "item/completed": {
        const finalItem = this.options.finalItemSchema.safeParse(notification.params.item);
        if (finalItem.success) {
          active.finalItem = finalItem.data;
        }
        this.completeTurnIfReady(active);
        return;
      }
      case "item/agentMessage/delta":
        this.emitDelta({
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          delta: notification.params.delta,
        });
        return;
      default:
        return;
    }
  }

  /** 完了通知と最終応答が揃ったターンを確定します。 */
  public completeTurnIfReady(active: ActiveTurnRunning<Result, Connection>): void {
    if (this.activeTurn !== active || active.completion == null) {
      return;
    }
    if (active.abortRequested) {
      this.finishTurn(active, new CodexSessionAbortedError());
      return;
    }
    if (active.completion.status !== "completed") {
      const error = new CodexSessionTurnError(active.completion.error);
      this.options.recordDiagnosticLocally("turn_error", error);
      this.finishTurn(active, this.options.createUnrecordedFailure(error));
      return;
    }
    const finalItem = active.finalItem;
    if (finalItem == null || finalItem.phase !== "final_answer") {
      const error = new CodexSessionOutputValidationError(
        new Error("最終agentMessageがありません。"),
      );
      this.options.recordDiagnosticLocally("output_validation_error", error);
      this.finishTurn(active, error);
      return;
    }
    let response: Response;
    try {
      response = this.options.parseOutput(finalItem.text);
    } catch (error: unknown) {
      this.options.recordDiagnosticLocally("output_validation_error", error);
      this.finishTurn(active, error);
      return;
    }
    this.options.onOutputVerified();
    const result = this.options.turnResultSchema.parse({
      threadId: active.threadId,
      turnId: active.turnId,
      response,
    });
    this.finishTurn(active, result);
  }

  private emitDelta(delta: unknown): void {
    const parsed = this.options.deltaSchema.safeParse(delta);
    if (!parsed.success) {
      this.options.recordDiagnosticAndNotify("connection_protocol_error", parsed.error);
      return;
    }
    for (const listener of this.deltaListeners) {
      try {
        const result = listener(parsed.data);
        if (result != null) {
          void Promise.resolve(result).catch((error: unknown) => {
            this.options.recordDiagnosticAndNotify("listener_error", error);
          });
        }
      } catch (error: unknown) {
        this.options.recordDiagnosticAndNotify("listener_error", error);
      }
    }
  }

  private isTurnResult(value: unknown): value is Result {
    return this.options.turnResultSchema.safeParse(value).success;
  }
}
