import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransportError,
} from "../transport";
import { AsanaRequestAbortedError } from "../scheduler";
import {
  AsanaOperationQueue,
  type AsanaOperationPriority,
} from "../operation-queue";
import {
  AsanaSyncCoordinator,
  AsanaSyncInProgressError,
  asanaSyncCoordinatorInputSchema,
  asanaSyncCoordinatorResultSchema,
  type AsanaSyncCoordinatorResult,
} from "../sync";
import { StorageDatabase } from "../../storage";
import { isoDateTimeSchema } from "../../../shared/domain";
import { syncStateSchema } from "../../../shared/storage";
import { AsanaSyncRuntimeAlreadyReportedError } from "./errors";
import {
  asanaSyncRuntimeConfigurationSchema,
  asanaSyncRuntimeResultSchema,
  asanaSyncRuntimeStateSchema,
  type AsanaSyncRuntimeConfiguration,
  type AsanaSyncRuntimeErrorCode,
  type AsanaSyncRuntimeResult,
  type AsanaSyncRuntimeState,
  type AsanaSyncRuntimeSynchronizationMode,
} from "./schemas";

const fullSyncIntervalMilliseconds = 24 * 60 * 60 * 1000;
const onlineSyncIntervalMilliseconds = 60 * 1000;

export type AsanaSyncRuntimeInternalResult =
  | Exclude<AsanaSyncRuntimeResult, { kind: "failed" }>
  | (Extract<AsanaSyncRuntimeResult, { kind: "failed" }> & {
      readonly cause: unknown;
    });

type AsanaSyncCoordinatorPort = Pick<AsanaSyncCoordinator, "coordinate">;
type StorageDatabasePort = Pick<StorageDatabase, "getSyncState">;
type BeforeSynchronization = (
  signal: AbortSignal,
) => void | PromiseLike<void>;
type OnlineReadiness =
  | { readonly kind: "ready" }
  | {
      readonly kind: "unavailable";
      readonly result: AsanaSyncRuntimeInternalResult;
    };
type RuntimeConnectionState =
  | { readonly kind: "offline" }
  | { readonly kind: "recovery_pending" }
  | { readonly kind: "online" };
type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};
type SyncRunIntent = "automatic" | "full";
type SyncRunBase = {
  readonly generation: number;
  readonly deferred: Deferred<AsanaSyncRuntimeInternalResult>;
  readonly promise: Promise<AsanaSyncRuntimeInternalResult>;
  readonly cycleController: AbortController;
  readonly owner: AsanaOperationPriority;
  readonly intent: SyncRunIntent;
  readonly mode: AsanaSyncRuntimeSynchronizationMode | undefined;
  readonly pendingMode: AsanaSyncRuntimeSynchronizationMode | undefined;
};
type QueuedSyncRun = SyncRunBase & {
  readonly phase: "queued";
  readonly pendingMode: undefined;
};
type PreflightingSyncRun = SyncRunBase & {
  readonly phase: "preflighting";
};
type RunningSyncRun = SyncRunBase & {
  readonly phase: "running";
  readonly mode: AsanaSyncRuntimeSynchronizationMode;
};
type SyncRunState =
  | QueuedSyncRun
  | PreflightingSyncRun
  | RunningSyncRun;

function createDeferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  let rejectValue: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  if (resolveValue == null || rejectValue == null) {
    throw new Error("同期結果の待機状態を初期化できません。");
  }
  return {
    promise,
    resolve: resolveValue,
    reject: rejectValue,
  };
}

/** 予期しない同期エラーを通知する関数です。 */
export type AsanaSyncRuntimeUnexpectedErrorNotifier = (
  error: unknown,
) => void;

/** 同期状態の変更を受け取る関数です。 */
export type AsanaSyncRuntimeStateListener = (
  state: AsanaSyncRuntimeState,
) => void;

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

function validateFunction(value: unknown, message: string): void {
  if (typeof value !== "function") {
    throw new TypeError(message);
  }
}

function mergeRequestedModes(
  first: AsanaSyncRuntimeSynchronizationMode | undefined,
  second: AsanaSyncRuntimeSynchronizationMode | undefined,
): AsanaSyncRuntimeSynchronizationMode | undefined {
  if (first === "full" || second === "full") {
    return "full";
  }
  if (first === "delta" || second === "delta") {
    return "delta";
  }
  return undefined;
}

function classifyKnownError(error: unknown): AsanaSyncRuntimeErrorCode | undefined {
  if (error instanceof AsanaAuthenticationError) {
    return "authentication_required";
  }
  if (error instanceof AsanaPaymentRequiredError) {
    return "payment_required";
  }
  if (error instanceof AsanaRateLimitError) {
    return "rate_limited";
  }
  if (error instanceof AsanaHttpError) {
    return "http_error";
  }
  if (error instanceof AsanaTransportError) {
    return "transport_error";
  }
  if (error instanceof AsanaResponseError) {
    return "response_error";
  }
  if (error instanceof AsanaEventsResetError) {
    return "events_reset";
  }
  if (error instanceof AsanaRequestAbortedError) {
    return "request_aborted";
  }
  if (error instanceof AsanaSyncInProgressError) {
    return "sync_in_progress";
  }
  return undefined;
}

function createAbortResult(): AsanaSyncRuntimeInternalResult {
  const result = asanaSyncRuntimeResultSchema.parse({
    kind: "aborted",
    reason: "aborted",
  });
  if (result.kind !== "aborted") {
    throw new Error("同期中断結果の種別が不正です。");
  }
  return result;
}

function createRejectedResult(
  reason: "offline" | "stopped",
): AsanaSyncRuntimeInternalResult {
  const result = asanaSyncRuntimeResultSchema.parse({
    kind: "rejected",
    reason,
  });
  if (result.kind !== "rejected") {
    throw new Error("同期拒否結果の種別が不正です。");
  }
  return result;
}

function createFailedResult(
  errorCode: AsanaSyncRuntimeErrorCode,
  cause: unknown,
): AsanaSyncRuntimeInternalResult {
  const result = asanaSyncRuntimeResultSchema.parse({
    kind: "failed",
    error_code: errorCode,
  });
  if (result.kind !== "failed") {
    throw new Error("同期失敗結果の種別が不正です。");
  }
  return { ...result, cause };
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("同期中にエラーが発生しました。", { cause: error });
}

function createSynchronizedResult(
  requestedMode: AsanaSyncRuntimeSynchronizationMode,
  result: AsanaSyncCoordinatorResult,
): AsanaSyncRuntimeInternalResult {
  const synchronized = asanaSyncRuntimeResultSchema.parse({
    kind: "synchronized",
    requested_mode: requestedMode,
    performed_mode: result.performed_mode,
    synced_at: result.synced_at,
    result,
  });
  if (synchronized.kind !== "synchronized") {
    throw new Error("同期成功結果の種別が不正です。");
  }
  return synchronized;
}

function createCombinedSignal(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

/** Asana同期の起動契機とライフサイクルを調整します。 */
export class AsanaSyncRuntime {
  private readonly coordinator: AsanaSyncCoordinatorPort;
  private readonly database: StorageDatabasePort;
  private readonly configuration: AsanaSyncRuntimeConfiguration;
  private readonly lifecycleSignal: AbortSignal;
  private readonly beforeSynchronization: BeforeSynchronization;
  private readonly notifyUnexpectedError: AsanaSyncRuntimeUnexpectedErrorNotifier;
  private readonly nowProvider: () => string;
  private readonly operationQueue: AsanaOperationQueue;
  private readonly stopController = new AbortController();
  private readonly listeners = new Set<AsanaSyncRuntimeStateListener>();
  private readonly lifecycleAbortListener = (): void => {
    this.handleLifecycleAbort();
  };
  private activeRunController: AbortController | undefined;
  private scheduledRun: SyncRunState | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runGeneration = 0;
  private activeRunGeneration: number | undefined;
  private connectionState: RuntimeConnectionState;
  private stopped: boolean;
  private lastSuccessfulSyncAt: string | undefined;
  private lastErrorCode: AsanaSyncRuntimeErrorCode | undefined;
  private state: AsanaSyncRuntimeState;

  public constructor(
    coordinator: AsanaSyncCoordinatorPort,
    database: StorageDatabasePort,
    configuration: AsanaSyncRuntimeConfiguration,
    lifecycleSignal: AbortSignal,
    beforeSynchronization: BeforeSynchronization,
    notifyUnexpectedError: AsanaSyncRuntimeUnexpectedErrorNotifier,
    nowProvider: () => string,
    operationQueue: AsanaOperationQueue,
  ) {
    validateFunction(coordinator?.coordinate, "Asana同期コーディネーターが必要です。");
    validateFunction(database?.getSyncState, "同期状態の保存先が必要です。");
    validateAbortSignal(lifecycleSignal);
    validateFunction(beforeSynchronization, "同期前フックが必要です。");
    validateFunction(notifyUnexpectedError, "予期しないエラー通知関数が必要です。");
    validateFunction(nowProvider, "現在時刻関数が必要です。");
    if (!(operationQueue instanceof AsanaOperationQueue)) {
      throw new TypeError("Asana操作キューが必要です。");
    }
    this.configuration = asanaSyncRuntimeConfigurationSchema.parse(configuration);
    this.coordinator = coordinator;
    this.database = database;
    this.lifecycleSignal = lifecycleSignal;
    this.beforeSynchronization = beforeSynchronization;
    this.notifyUnexpectedError = notifyUnexpectedError;
    this.nowProvider = nowProvider;
    this.operationQueue = operationQueue;
    const existingState = this.readSyncState();
    this.lastSuccessfulSyncAt = existingState?.last_successful_sync_at;
    this.connectionState = this.configuration.initial_online && !lifecycleSignal.aborted
      ? { kind: "online" }
      : { kind: "offline" };
    this.stopped = lifecycleSignal.aborted;
    this.state = asanaSyncRuntimeStateSchema.parse(
      this.connectionState.kind === "online"
        ? this.createOnlineState(undefined)
        : this.createOfflineState(),
    );
    lifecycleSignal.addEventListener("abort", this.lifecycleAbortListener, {
      once: true,
    });
  }

  /** 起動後の同期を実行します。 */
  public start(signal: AbortSignal): Promise<AsanaSyncRuntimeInternalResult> {
    return this.requestSelectedMode(false, signal, "user");
  }

  /** フォアグラウンド復帰後の同期を実行します。 */
  public onForeground(signal: AbortSignal): Promise<AsanaSyncRuntimeInternalResult> {
    return this.requestSelectedMode(false, signal, "user");
  }

  /** AIターン開始前の鮮度確保を実行します。 */
  public beforeAiTurn(signal: AbortSignal): Promise<AsanaSyncRuntimeInternalResult> {
    return this.requestSelectedMode(false, signal, "user");
  }

  /** GUI変更後の同期と後処理を実行します。 */
  public async afterGuiEdit(
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("GUI事後同期の実行権を所有していません。");
    }
    return this.runOwnedAfterApply(requiredTaskGids, signal);
  }

  /** AI変更適用後の同期と後処理を実行します。 */
  public async afterAiApply(
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("AI適用後同期の実行権を所有していません。");
    }
    return this.runOwnedAfterApply(requiredTaskGids, signal);
  }

  /** 通常の手動同期を実行します。 */
  public manualSync(signal: AbortSignal): Promise<AsanaSyncRuntimeInternalResult> {
    return this.requestSelectedMode(false, signal, "user");
  }

  /** 完全同期を指定して手動同期を実行します。 */
  public manualFullSync(signal: AbortSignal): Promise<AsanaSyncRuntimeInternalResult> {
    return this.requestSelectedMode(true, signal, "user");
  }

  /** オンライン状態を設定します。 */
  public setOnline(online: boolean): void {
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態は真偽値で指定してください。");
    }
    if (this.stopped) {
      throw new Error("同期ランタイムは停止済みです。");
    }
    if (!online) {
      if (this.connectionState.kind === "offline") {
        return;
      }
      this.connectionState = { kind: "offline" };
      this.clearTimer();
      this.scheduledRun?.cycleController.abort();
      this.activeRunController?.abort();
      this.operationQueue.abortActive();
      this.operationQueue.invalidatePendingMutations("offline");
      this.publishState(this.createOfflineState());
      return;
    }
    if (this.connectionState.kind === "offline") {
      this.connectionState = { kind: "recovery_pending" };
    }
    this.armTimer();
  }

  /** ネットワーク接続を保ったまま同期前復旧待ちへ移行します。 */
  public deferSynchronizationUntilRecovery(): void {
    if (this.stopped) {
      throw new Error("同期ランタイムは停止済みです。");
    }
    if (this.connectionState.kind === "online") {
      this.connectionState = { kind: "recovery_pending" };
    }
    this.clearTimer();
    this.scheduledRun?.cycleController.abort();
    this.activeRunController?.abort();
    this.operationQueue.abortActive();
    this.operationQueue.invalidatePendingMutations("offline");
    this.publishState(this.createOfflineState());
    this.armTimer();
  }

  /** オンライン復帰後の同期を実行します。 */
  public async onOnline(signal: AbortSignal): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return createAbortResult();
    }
    if (this.stopped) {
      return createRejectedResult("stopped");
    }
    this.setOnline(true);
    return this.requestSelectedMode(false, signal, "user");
  }

  /** 同期状態の購読を登録します。 */
  public subscribe(listener: AsanaSyncRuntimeStateListener): () => void {
    validateFunction(listener, "同期状態の購読関数が必要です。");
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** 同期状態を取得します。 */
  public getState(): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse(this.state);
  }

  /** 同期ランタイムを停止します。 */
  public async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.connectionState = { kind: "offline" };
      this.clearTimer();
      this.stopController.abort();
      this.scheduledRun?.cycleController.abort();
      this.activeRunController?.abort();
      this.publishState(this.createOfflineState());
      this.lifecycleSignal.removeEventListener(
        "abort",
        this.lifecycleAbortListener,
      );
    }
    const scheduledRun = this.scheduledRun;
    if (scheduledRun != null) {
      await scheduledRun.promise;
    }
  }

  private operationQueueHasOwner(signal: AbortSignal): boolean {
    return this.operationQueue.hasOwner(signal);
  }

  private async runOwnedAfterApply(
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    if (signal.aborted) {
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      this.recordAbortState();
      return createAbortResult();
    }
    try {
      return await this.operationQueue.runOwned(signal, async (context) => {
        const readiness = await this.preflightSynchronization(context.signal);
        if (readiness.kind === "unavailable") {
          this.operationQueue.invalidatePendingMutations("synchronization_failed");
          return readiness.result;
        }
        return this.execute("delta", requiredTaskGids, context.signal);
      });
    } catch (error: unknown) {
      if (error instanceof AsanaRequestAbortedError) {
        this.operationQueue.invalidatePendingMutations("synchronization_failed");
        this.recordAbortState();
        return createAbortResult();
      }
      throw error;
    }
  }

  private async requestSelectedMode(
    forceFull: boolean,
    signal: AbortSignal,
    priority: AsanaOperationPriority,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return createAbortResult();
    }
    if (this.stopped) {
      return createRejectedResult("stopped");
    }
    if (this.connectionState.kind === "offline") {
      return createRejectedResult("offline");
    }
    const intent = forceFull ? "full" : "automatic";
    const mode = forceFull ? "full" : undefined;
    return this.requestMode(mode, intent, signal, priority);
  }

  private ensureOnline(signal: AbortSignal): OnlineReadiness {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return { kind: "unavailable", result: createAbortResult() };
    }
    if (this.stopped) {
      return { kind: "unavailable", result: createRejectedResult("stopped") };
    }
    if (this.connectionState.kind === "online") {
      return { kind: "ready" };
    }
    if (this.connectionState.kind === "offline") {
      return { kind: "unavailable", result: createRejectedResult("offline") };
    }
    return { kind: "ready" };
  }

  private async preflightSynchronization(
    signal: AbortSignal,
  ): Promise<OnlineReadiness> {
    const readiness = this.ensureOnline(signal);
    if (readiness.kind === "unavailable") {
      return readiness;
    }
    try {
      await this.beforeSynchronization(signal);
    } catch (error: unknown) {
      if (signal.aborted || error instanceof AsanaRequestAbortedError) {
        this.operationQueue.invalidatePendingMutations("synchronization_failed");
        this.recordAbortState();
        return { kind: "unavailable", result: createAbortResult() };
      }
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      throw error;
    }
    if (signal.aborted) {
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      this.recordAbortState();
      return { kind: "unavailable", result: createAbortResult() };
    }
    if (this.stopped) {
      return { kind: "unavailable", result: createRejectedResult("stopped") };
    }
    const currentConnectionState = this.readConnectionState();
    if (currentConnectionState.kind === "offline") {
      return { kind: "unavailable", result: createRejectedResult("offline") };
    }
    if (currentConnectionState.kind === "recovery_pending") {
      this.connectionState = { kind: "online" };
      this.lastErrorCode = undefined;
      this.publishState(this.createOnlineState(undefined));
    }
    return { kind: "ready" };
  }

  private readConnectionState(): RuntimeConnectionState {
    return this.connectionState;
  }

  private selectMode(): AsanaSyncRuntimeSynchronizationMode {
    const state = this.readSyncState();
    if (state == null || state.last_full_sync_at == null) {
      return "full";
    }
    const now = Date.parse(isoDateTimeSchema.parse(this.nowProvider()));
    const lastFull = Date.parse(state.last_full_sync_at);
    if (now - lastFull >= fullSyncIntervalMilliseconds) {
      return "full";
    }
    return "delta";
  }

  private readSyncState(): ReturnType<StorageDatabase["getSyncState"]> {
    const state = this.database.getSyncState(this.configuration.project_gid);
    if (state == null) {
      return undefined;
    }
    const parsed = syncStateSchema.parse(state);
    if (parsed.project_gid !== this.configuration.project_gid) {
      throw new Error("保存済み同期状態のプロジェクトGIDが一致しません。");
    }
    return parsed;
  }

  private requestMode(
    mode: AsanaSyncRuntimeSynchronizationMode | undefined,
    intent: SyncRunIntent,
    signal: AbortSignal,
    priority: AsanaOperationPriority,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return Promise.resolve(createAbortResult());
    }
    const scheduledRun = this.scheduledRun;
    if (scheduledRun != null) {
      if (
        scheduledRun.phase === "queued"
        && scheduledRun.owner === "background"
        && priority === "user"
      ) {
        const promotedMode = mergeRequestedModes(scheduledRun.mode, mode);
        const promotedIntent = scheduledRun.intent === "full" || intent === "full"
          ? "full"
          : "automatic";
        scheduledRun.cycleController.abort();
        if (this.scheduledRun?.generation === scheduledRun.generation) {
          this.scheduledRun = undefined;
        }
        return this.scheduleRun(promotedMode, promotedIntent, signal, priority);
      }
      const mergedIntent = scheduledRun.intent === "full" || intent === "full"
        ? "full"
        : "automatic";
      let updatedRun: SyncRunState;
      if (scheduledRun.phase === "queued") {
        updatedRun = {
          ...scheduledRun,
          intent: mergedIntent,
          mode: mergeRequestedModes(scheduledRun.mode, mode),
          pendingMode: undefined,
        };
      } else if (scheduledRun.phase === "preflighting") {
        const updatedMode = mode === "full" && scheduledRun.mode == null
          ? "full"
          : scheduledRun.mode;
        updatedRun = {
          ...scheduledRun,
          intent: mergedIntent,
          mode: updatedMode,
          pendingMode: mode === "full" && scheduledRun.mode === "delta"
            ? "full"
            : scheduledRun.pendingMode,
        };
      } else {
        updatedRun = {
          ...scheduledRun,
          intent: mergedIntent,
          pendingMode: mode === "full" && scheduledRun.mode === "delta"
            ? "full"
            : scheduledRun.pendingMode,
        };
      }
      this.scheduledRun = updatedRun;
      return this.waitForCaller(scheduledRun.promise, signal);
    }
    return this.scheduleRun(mode, intent, signal, priority);
  }

  private scheduleRun(
    mode: AsanaSyncRuntimeSynchronizationMode | undefined,
    intent: SyncRunIntent,
    signal: AbortSignal,
    owner: AsanaOperationPriority,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    this.clearTimer();
    this.runGeneration += 1;
    const generation = this.runGeneration;
    const deferred = createDeferred<AsanaSyncRuntimeInternalResult>();
    const cycleController = new AbortController();
    const scheduledRun: QueuedSyncRun = {
      phase: "queued",
      generation,
      deferred,
      promise: deferred.promise,
      cycleController,
      owner,
      intent,
      mode,
      pendingMode: undefined,
    };
    this.scheduledRun = scheduledRun;
    const queuedSignal = createCombinedSignal([
      this.lifecycleSignal,
      this.stopController.signal,
      cycleController.signal,
    ]);
    const queued = this.operationQueue.enqueue({
      priority: owner,
      kind: "synchronization",
      signal: queuedSignal,
      run: (context) => this.drain(generation, context.signal),
    });
    void queued.then(
      (result) => this.completeRun(scheduledRun, result),
      (error: unknown) => this.rejectRun(scheduledRun, error),
    );
    return this.waitForCaller(deferred.promise, signal);
  }

  private completeRun(
    run: SyncRunBase,
    result: AsanaSyncRuntimeInternalResult,
  ): void {
    if (this.scheduledRun?.generation === run.generation) {
      this.scheduledRun = undefined;
    }
    run.deferred.resolve(result);
    this.armTimer();
  }

  private rejectRun(run: SyncRunBase, error: unknown): void {
    if (error instanceof AsanaRequestAbortedError) {
      run.deferred.resolve(createAbortResult());
    } else if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
      run.deferred.reject(error);
    } else if (run.owner === "background") {
      let rejection: unknown = error;
      try {
        this.notifyUnexpectedError(error);
      } catch (diagnosticError: unknown) {
        rejection = new AggregateError(
          [error, diagnosticError],
          "バックグラウンド同期エラーの記録に失敗しました。",
          { cause: error },
        );
      }
      run.deferred.reject(new AsanaSyncRuntimeAlreadyReportedError(rejection));
    } else {
      run.deferred.reject(error);
    }
    if (this.scheduledRun?.generation === run.generation) {
      this.scheduledRun = undefined;
    }
    this.armTimer();
  }

  private waitForCaller(
    running: Promise<AsanaSyncRuntimeInternalResult>,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return Promise.resolve(createAbortResult());
    }
    return new Promise<AsanaSyncRuntimeInternalResult>((resolve, reject) => {
      let settled = false;
      const removeAbortListener = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener();
        resolve(createAbortResult());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      running.then(
        (result) => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener();
          resolve(result);
        },
        (error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          removeAbortListener();
          reject(toError(error));
        },
      );
    });
  }

  private async drain(
    generation: number,
    sharedSignal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    const queuedRun = this.scheduledRun;
    if (queuedRun == null || queuedRun.generation !== generation) {
      throw new Error("同期キューの実行状態が一致しません。");
    }
    if (queuedRun.phase !== "queued") {
      throw new Error("同期キューの開始状態が不正です。");
    }
    const preflightingRun: PreflightingSyncRun = {
      ...queuedRun,
      phase: "preflighting",
      pendingMode: undefined,
    };
    this.scheduledRun = preflightingRun;
    this.activeRunGeneration = generation;
    try {
      const selectedRun = this.scheduledRun;
      if (
        selectedRun == null
        || selectedRun.generation !== generation
        || selectedRun.phase !== "preflighting"
      ) {
        throw new Error("同期モード選択前の実行状態が一致しません。");
      }
      const selectedMode = selectedRun.mode
        ?? (selectedRun.intent === "full" ? "full" : this.selectMode());
      const modeSelectedRun: PreflightingSyncRun = {
        ...selectedRun,
        mode: selectedMode,
      };
      this.scheduledRun = modeSelectedRun;
      const readiness = await this.preflightSynchronization(sharedSignal);
      if (readiness.kind === "unavailable") {
        return readiness.result;
      }
      const currentRun = this.scheduledRun;
      const currentMode = currentRun?.mode;
      if (
        currentRun == null
        || currentRun.generation !== generation
        || currentRun.phase !== "preflighting"
        || currentMode == null
      ) {
        throw new Error("同期前処理の実行状態が一致しません。");
      }
      let runningRun: RunningSyncRun = {
        ...currentRun,
        phase: "running",
        mode: currentMode,
      };
      this.scheduledRun = runningRun;
      let mode = runningRun.mode;
      while (true) {
        const operationController = new AbortController();
        this.activeRunController = operationController;
        const operationSignal = createCombinedSignal([
          sharedSignal,
          operationController.signal,
        ]);
        const removeOwnedSignal = this.operationQueue.linkOwnedSignal(
          operationSignal,
          sharedSignal,
        );
        let result: AsanaSyncRuntimeInternalResult;
        try {
          result = await this.execute(mode, [], operationSignal);
        } finally {
          removeOwnedSignal();
          if (this.activeRunGeneration === generation) {
            this.activeRunController = undefined;
          }
        }
        if (
          result.kind === "aborted"
          || result.kind === "failed"
          || result.kind === "rejected"
        ) {
          return result;
        }
        if (this.connectionState.kind !== "online" || this.stopped) {
          return result;
        }
        const latestRun = this.scheduledRun;
        if (
          latestRun == null
          || latestRun.generation !== generation
          || latestRun.phase !== "running"
        ) {
          throw new Error("同期実行状態が一致しません。");
        }
        runningRun = latestRun;
        const pendingMode = runningRun.pendingMode;
        if (pendingMode != null) {
          mode = pendingMode;
          runningRun = {
            ...runningRun,
            mode,
            pendingMode: undefined,
          };
          this.scheduledRun = runningRun;
          continue;
        }
        return result;
      }
    } finally {
      if (this.activeRunGeneration === generation) {
        this.activeRunController = undefined;
        this.activeRunGeneration = undefined;
      }
    }
  }

  private async execute(
    mode: AsanaSyncRuntimeSynchronizationMode,
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    if (
      signal.aborted
      || this.connectionState.kind !== "online"
      || this.stopped
    ) {
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      if (signal.aborted) {
        this.recordAbortState();
        return createAbortResult();
      }
      if (this.stopped) {
        return createRejectedResult("stopped");
      }
      return createRejectedResult("offline");
    }
    try {
      this.publishState(this.createSyncingState(mode));
      const input = asanaSyncCoordinatorInputSchema.parse({
        mode,
        project_gid: this.configuration.project_gid,
        section_gids: this.configuration.section_gids,
        device_id: this.configuration.device_id,
        app_version: this.configuration.app_version,
        required_task_gids: [...requiredTaskGids],
      });
      const coordinated = await this.coordinator.coordinate(input, signal);
      if (signal.aborted) {
        this.operationQueue.invalidatePendingMutations("synchronization_failed");
        this.recordAbortState();
        return createAbortResult();
      }
      const result = asanaSyncCoordinatorResultSchema.parse(coordinated);
      this.lastSuccessfulSyncAt = result.synced_at;
      this.lastErrorCode = undefined;
      this.publishState(
        this.createOnlineState(result.normalization_notifications),
      );
      return createSynchronizedResult(mode, result);
    } catch (error: unknown) {
      if (signal.aborted || error instanceof AsanaRequestAbortedError) {
        this.operationQueue.invalidatePendingMutations("synchronization_failed");
        this.recordAbortState();
        return createAbortResult();
      }
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      const knownCode = classifyKnownError(error);
      if (knownCode == null) {
        this.lastErrorCode = "unexpected_error";
        this.publishState(this.createErrorState("unexpected_error"));
        throw error;
      }
      this.lastErrorCode = knownCode;
      if (knownCode === "authentication_required") {
        this.publishState(this.createAuthenticationRequiredState());
      } else {
        this.publishState(this.createErrorState(knownCode));
      }
      return createFailedResult(knownCode, error);
    }
  }

  private recordAbortState(): void {
    this.lastErrorCode = "request_aborted";
    if (this.connectionState.kind === "online" && !this.stopped) {
      this.publishState(this.createErrorState("request_aborted"));
      return;
    }
    this.publishState(this.createOfflineState());
  }

  private createOnlineState(
    normalizationNotifications:
      AsanaSyncCoordinatorResult["normalization_notifications"] | undefined,
  ): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse({
      kind: "online",
      ...(normalizationNotifications == null
        ? {}
        : { normalization_notifications: normalizationNotifications }),
      ...(this.lastSuccessfulSyncAt == null
        ? {}
        : { last_successful_sync_at: this.lastSuccessfulSyncAt }),
      ...(this.lastErrorCode == null
        ? {}
        : { last_error_code: this.lastErrorCode }),
    });
  }

  private createOfflineState(): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse({
      kind: "offline",
      ...(this.lastSuccessfulSyncAt == null
        ? {}
        : { last_successful_sync_at: this.lastSuccessfulSyncAt }),
      ...(this.lastErrorCode == null
        ? {}
        : { last_error_code: this.lastErrorCode }),
    });
  }

  private createSyncingState(
    mode: AsanaSyncRuntimeSynchronizationMode,
  ): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse({
      kind: "syncing",
      requested_mode: mode,
      ...(this.lastSuccessfulSyncAt == null
        ? {}
        : { last_successful_sync_at: this.lastSuccessfulSyncAt }),
      ...(this.lastErrorCode == null
        ? {}
        : { last_error_code: this.lastErrorCode }),
    });
  }

  private createAuthenticationRequiredState(): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse({
      kind: "authentication_required",
      error_code: "authentication_required",
      ...(this.lastSuccessfulSyncAt == null
        ? {}
        : { last_successful_sync_at: this.lastSuccessfulSyncAt }),
    });
  }

  private createErrorState(
    errorCode: AsanaSyncRuntimeErrorCode,
  ): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse({
      kind: "error",
      error_code: errorCode,
      ...(this.lastSuccessfulSyncAt == null
        ? {}
        : { last_successful_sync_at: this.lastSuccessfulSyncAt }),
    });
  }

  private publishState(state: AsanaSyncRuntimeState): void {
    this.state = asanaSyncRuntimeStateSchema.parse(state);
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error: unknown) {
        this.notifyUnexpectedError(error);
      }
    }
  }

  private armTimer(): void {
    if (
      this.timer != null
      || this.scheduledRun != null
      || this.connectionState.kind === "offline"
      || this.stopped
    ) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.connectionState.kind === "offline" || this.stopped) {
        return;
      }
      const timerSignal = createCombinedSignal([
        this.lifecycleSignal,
        this.stopController.signal,
      ]);
      const timerRun = this.requestSelectedMode(false, timerSignal, "background");
      void timerRun.then(
        () => {
          this.armTimer();
        },
        (error: unknown) => {
          try {
            if (!(error instanceof AsanaSyncRuntimeAlreadyReportedError)) {
              this.notifyUnexpectedError(error);
            }
          } finally {
            this.armTimer();
          }
        },
      );
    }, onlineSyncIntervalMilliseconds);
  }

  private clearTimer(): void {
    if (this.timer == null) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private handleLifecycleAbort(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.connectionState = { kind: "offline" };
    this.clearTimer();
    this.stopController.abort();
    this.scheduledRun?.cycleController.abort();
    this.activeRunController?.abort();
    this.operationQueue.abortActive();
    this.operationQueue.invalidatePendingMutations("offline");
    this.publishState(this.createOfflineState());
  }
}
