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

function mergePendingModes(
  first: AsanaSyncRuntimeSynchronizationMode,
  second: AsanaSyncRuntimeSynchronizationMode,
): AsanaSyncRuntimeSynchronizationMode {
  if (first === "full" || second === "full") {
    return "full";
  }
  return "delta";
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
  private scheduledRunController: AbortController | undefined;
  private scheduled: Promise<AsanaSyncRuntimeInternalResult> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingMode: AsanaSyncRuntimeSynchronizationMode | undefined;
  private runningMode: AsanaSyncRuntimeSynchronizationMode | undefined;
  private scheduledMode: AsanaSyncRuntimeSynchronizationMode | undefined;
  private scheduledPriority: AsanaOperationPriority | undefined;
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
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("GUI事後同期の実行権を所有していません。");
    }
    return this.runOwnedAfterApply(signal);
  }

  /** AI変更適用後の同期と後処理を実行します。 */
  public async afterAiApply(
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("AI適用後同期の実行権を所有していません。");
    }
    return this.runOwnedAfterApply(signal);
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
      this.pendingMode = undefined;
      this.scheduledRunController?.abort();
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
    this.pendingMode = undefined;
    this.scheduledRunController?.abort();
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
      this.pendingMode = undefined;
      this.clearTimer();
      this.stopController.abort();
      this.scheduledRunController?.abort();
      this.activeRunController?.abort();
      this.publishState(this.createOfflineState());
      this.lifecycleSignal.removeEventListener(
        "abort",
        this.lifecycleAbortListener,
      );
    }
    const scheduled = this.scheduled;
    if (scheduled != null) {
      await scheduled;
    }
  }

  private operationQueueHasOwner(signal: AbortSignal): boolean {
    return this.operationQueue.hasOwner(signal);
  }

  private async runOwnedAfterApply(
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    if (signal.aborted) {
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      this.recordAbortState();
      return createAbortResult();
    }
    try {
      return await this.operationQueue.runOwned(signal, (context) =>
        this.execute("delta", context.signal),
      );
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
    const readiness = await this.ensureOnline(signal);
    if (readiness.kind === "unavailable") {
      return readiness.result;
    }
    const mode = forceFull ? "full" : this.selectMode();
    return this.requestMode(mode, signal, priority);
  }

  private async ensureOnline(signal: AbortSignal): Promise<OnlineReadiness> {
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
    try {
      await this.beforeSynchronization(signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        return { kind: "unavailable", result: createAbortResult() };
      }
      throw error;
    }
    if (signal.aborted) {
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
    mode: AsanaSyncRuntimeSynchronizationMode,
    signal: AbortSignal,
    priority: AsanaOperationPriority,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return Promise.resolve(createAbortResult());
    }
    const scheduled = this.scheduled;
    if (scheduled != null) {
      if (
        priority === "user"
        && this.scheduledPriority === "background"
        && this.activeRunController == null
      ) {
        const promotedMode = this.scheduledMode;
        if (promotedMode == null) {
          throw new Error("昇格対象の同期モードがありません。");
        }
        this.scheduledRunController?.abort();
        this.scheduled = undefined;
        this.scheduledRunController = undefined;
        this.scheduledMode = undefined;
        this.scheduledPriority = undefined;
        this.pendingMode = undefined;
        return this.requestMode(
          mergePendingModes(promotedMode, mode),
          signal,
          priority,
        );
      }
      const operationAborted = this.activeRunController == null
        ? this.scheduledRunController?.signal.aborted === true
        : this.activeRunController.signal.aborted;
      if (operationAborted) {
        this.pendingMode = this.pendingMode == null
          ? mode
          : mergePendingModes(this.pendingMode, mode);
      } else if (
        (this.runningMode === "delta" || this.scheduledMode === "delta")
        && mode === "full"
      ) {
        this.pendingMode = "full";
      }
      return this.waitForCaller(scheduled, signal);
    }
    this.clearTimer();
    const generation = this.runGeneration + 1;
    this.runGeneration = generation;
    this.scheduledMode = mode;
    this.pendingMode = undefined;
    const deferred = createDeferred<AsanaSyncRuntimeInternalResult>();
    const cycleController = new AbortController();
    this.scheduledRunController = cycleController;
    this.scheduled = deferred.promise;
    this.scheduledPriority = priority;
    const queuedSignal = createCombinedSignal([
      this.lifecycleSignal,
      this.stopController.signal,
      cycleController.signal,
    ]);
    const queued = this.operationQueue.enqueue({
      priority,
      kind: "synchronization",
      signal: queuedSignal,
      run: (context) => {
        const drained = this.drain(
          this.scheduledMode ?? mode,
          context.signal,
          generation,
        );
        return drained;
      },
    });
    queued.then(
      (result) => deferred.resolve(result),
      (error: unknown) => {
        if (error instanceof AsanaRequestAbortedError) {
          deferred.resolve(createAbortResult());
        } else {
          deferred.reject(error);
        }
        if (this.scheduled === deferred.promise) {
          this.scheduled = undefined;
          this.scheduledRunController = undefined;
          this.scheduledMode = undefined;
          this.scheduledPriority = undefined;
          this.pendingMode = undefined;
          this.armTimer();
        }
      },
    );
    return this.waitForCaller(deferred.promise, signal);
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
    initialMode: AsanaSyncRuntimeSynchronizationMode,
    sharedSignal: AbortSignal,
    generation: number,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    let mode = initialMode;
    this.activeRunGeneration = generation;
    try {
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
        this.runningMode = mode;
        let result: AsanaSyncRuntimeInternalResult;
        try {
          result = await this.execute(mode, operationSignal);
        } finally {
          removeOwnedSignal();
        }
        if (
          result.kind === "aborted"
          || result.kind === "failed"
          || result.kind === "rejected"
        ) {
          this.pendingMode = undefined;
          return result;
        }
        if (this.connectionState.kind !== "online" || this.stopped) {
          this.pendingMode = undefined;
          return result;
        }
        const pendingMode = this.pendingMode;
        this.pendingMode = undefined;
        if (pendingMode != null) {
          mode = pendingMode;
          continue;
        }
        return result;
      }
    } finally {
      if (this.activeRunGeneration === generation) {
        this.activeRunController = undefined;
        this.activeRunGeneration = undefined;
        this.runningMode = undefined;
        this.scheduled = undefined;
        this.scheduledRunController = undefined;
        this.scheduledMode = undefined;
        this.scheduledPriority = undefined;
        this.armTimer();
      }
    }
  }

  private async execute(
    mode: AsanaSyncRuntimeSynchronizationMode,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    let sideEffectStarted = false;
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
      sideEffectStarted = true;
      await this.beforeSynchronization(signal);
    } catch (error: unknown) {
      if (signal.aborted || error instanceof AsanaRequestAbortedError) {
        this.operationQueue.invalidatePendingMutations("synchronization_failed");
        this.recordAbortState();
        return createAbortResult();
      }
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      throw error;
    }
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
        if (sideEffectStarted) {
          this.operationQueue.invalidatePendingMutations("synchronization_failed");
        }
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
      || this.scheduled != null
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
            this.notifyUnexpectedError(error);
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
    this.pendingMode = undefined;
    this.clearTimer();
    this.stopController.abort();
    this.scheduledRunController?.abort();
    this.activeRunController?.abort();
    this.operationQueue.abortActive();
    this.operationQueue.invalidatePendingMutations("offline");
    this.publishState(this.createOfflineState());
  }
}
