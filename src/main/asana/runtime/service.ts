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

type AsanaSyncCoordinatorPort = Pick<AsanaSyncCoordinator, "coordinate">;
type StorageDatabasePort = Pick<StorageDatabase, "getSyncState">;
type BeforeSynchronization = (
  signal: AbortSignal,
) => void | PromiseLike<void>;
type OnlineReadiness =
  | { readonly kind: "ready" }
  | {
      readonly kind: "unavailable";
      readonly result: AsanaSyncRuntimeResult;
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

function createAbortResult(): AsanaSyncRuntimeResult {
  return asanaSyncRuntimeResultSchema.parse({
    kind: "aborted",
    reason: "aborted",
  });
}

function createRejectedResult(
  reason: "offline" | "stopped",
): AsanaSyncRuntimeResult {
  return asanaSyncRuntimeResultSchema.parse({
    kind: "rejected",
    reason,
  });
}

function createFailedResult(
  errorCode: AsanaSyncRuntimeErrorCode,
): AsanaSyncRuntimeResult {
  return asanaSyncRuntimeResultSchema.parse({
    kind: "failed",
    error_code: errorCode,
  });
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
): AsanaSyncRuntimeResult {
  return asanaSyncRuntimeResultSchema.parse({
    kind: "synchronized",
    requested_mode: requestedMode,
    performed_mode: result.performed_mode,
    synced_at: result.synced_at,
    result,
  });
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
  private readonly stopController = new AbortController();
  private readonly listeners = new Set<AsanaSyncRuntimeStateListener>();
  private readonly lifecycleAbortListener = (): void => {
    this.handleLifecycleAbort();
  };
  private activeRunController: AbortController | undefined;
  private running: Promise<AsanaSyncRuntimeResult> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pendingMode: AsanaSyncRuntimeSynchronizationMode | undefined;
  private pendingBarrier = false;
  private runningMode: AsanaSyncRuntimeSynchronizationMode | undefined;
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
  ) {
    validateFunction(coordinator?.coordinate, "Asana同期コーディネーターが必要です。");
    validateFunction(database?.getSyncState, "同期状態の保存先が必要です。");
    validateAbortSignal(lifecycleSignal);
    validateFunction(beforeSynchronization, "同期前フックが必要です。");
    validateFunction(notifyUnexpectedError, "予期しないエラー通知関数が必要です。");
    validateFunction(nowProvider, "現在時刻関数が必要です。");
    this.configuration = asanaSyncRuntimeConfigurationSchema.parse(configuration);
    this.coordinator = coordinator;
    this.database = database;
    this.lifecycleSignal = lifecycleSignal;
    this.beforeSynchronization = beforeSynchronization;
    this.notifyUnexpectedError = notifyUnexpectedError;
    this.nowProvider = nowProvider;
    const existingState = this.readSyncState();
    this.lastSuccessfulSyncAt = existingState?.last_successful_sync_at;
    this.connectionState = this.configuration.initial_online && !lifecycleSignal.aborted
      ? { kind: "online" }
      : { kind: "offline" };
    this.stopped = lifecycleSignal.aborted;
    this.state = asanaSyncRuntimeStateSchema.parse(
      this.connectionState.kind === "online"
        ? this.createOnlineState()
        : this.createOfflineState(),
    );
    lifecycleSignal.addEventListener("abort", this.lifecycleAbortListener, {
      once: true,
    });
  }

  /** 起動後の同期を実行します。 */
  public start(signal: AbortSignal): Promise<AsanaSyncRuntimeResult> {
    return this.requestSelectedMode(false, signal);
  }

  /** フォアグラウンド復帰後の同期を実行します。 */
  public onForeground(signal: AbortSignal): Promise<AsanaSyncRuntimeResult> {
    return this.requestSelectedMode(false, signal);
  }

  /** AIターン開始前の鮮度確保を実行します。 */
  public beforeAiTurn(signal: AbortSignal): Promise<AsanaSyncRuntimeResult> {
    return this.requestSelectedMode(false, signal);
  }

  /** GUI変更後の同期と後処理を実行します。 */
  public async afterGuiEdit(
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeResult> {
    return this.requestAfterApplyBarrier(signal);
  }

  /** AI変更適用後の同期と後処理を実行します。 */
  public async afterAiApply(
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeResult> {
    return this.requestAfterApplyBarrier(signal);
  }

  /** 通常の手動同期を実行します。 */
  public manualSync(signal: AbortSignal): Promise<AsanaSyncRuntimeResult> {
    return this.requestSelectedMode(false, signal);
  }

  /** 完全同期を指定して手動同期を実行します。 */
  public manualFullSync(signal: AbortSignal): Promise<AsanaSyncRuntimeResult> {
    return this.requestSelectedMode(true, signal);
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
      this.pendingBarrier = false;
      this.activeRunController?.abort();
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
    this.pendingBarrier = false;
    this.activeRunController?.abort();
    this.publishState(this.createOfflineState());
    this.armTimer();
  }

  /** オンライン復帰後の同期を実行します。 */
  public async onOnline(signal: AbortSignal): Promise<AsanaSyncRuntimeResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return createAbortResult();
    }
    if (this.stopped) {
      return createRejectedResult("stopped");
    }
    this.setOnline(true);
    return this.requestSelectedMode(false, signal);
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
      this.pendingBarrier = false;
      this.clearTimer();
      this.stopController.abort();
      this.activeRunController?.abort();
      this.publishState(this.createOfflineState());
      this.lifecycleSignal.removeEventListener(
        "abort",
        this.lifecycleAbortListener,
      );
    }
    const running = this.running;
    if (running != null) {
      await running;
    }
  }

  private async requestAfterApplyBarrier(
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeResult> {
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
    return this.requestMode("delta", signal, true);
  }

  private async requestSelectedMode(
    forceFull: boolean,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeResult> {
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
    return this.requestMode(mode, signal, false);
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
      this.publishState(this.createOnlineState());
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
    barrier: boolean,
  ): Promise<AsanaSyncRuntimeResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return Promise.resolve(createAbortResult());
    }
    const running = this.running;
    if (running != null) {
      const operationAborted = this.activeRunController == null
        ? false
        : this.activeRunController.signal.aborted;
      if (barrier) {
        this.pendingBarrier = true;
      } else if (operationAborted) {
        this.pendingMode = this.pendingMode == null
          ? mode
          : mergePendingModes(this.pendingMode, mode);
      } else if (this.runningMode === "delta" && mode === "full") {
        this.pendingMode = "full";
      }
      return this.waitForCaller(running, signal);
    }
    this.clearTimer();
    const generation = this.runGeneration + 1;
    this.runGeneration = generation;
    this.activeRunGeneration = generation;
    this.runningMode = mode;
    this.pendingBarrier = false;
    this.pendingMode = undefined;
    const deferred = createDeferred<AsanaSyncRuntimeResult>();
    this.running = deferred.promise;
    const sharedSignal = createCombinedSignal([
      this.lifecycleSignal,
      this.stopController.signal,
    ]);
    queueMicrotask(() => {
      const drained = this.drain(mode, sharedSignal, generation);
      drained.then(deferred.resolve, deferred.reject);
    });
    return this.waitForCaller(deferred.promise, signal);
  }

  private waitForCaller(
    running: Promise<AsanaSyncRuntimeResult>,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeResult> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return Promise.resolve(createAbortResult());
    }
    return new Promise<AsanaSyncRuntimeResult>((resolve, reject) => {
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
  ): Promise<AsanaSyncRuntimeResult> {
    let mode = initialMode;
    try {
      while (true) {
        const operationController = new AbortController();
        this.activeRunController = operationController;
        const operationSignal = createCombinedSignal([
          sharedSignal,
          operationController.signal,
        ]);
        this.runningMode = mode;
        const result = await this.execute(mode, operationSignal);
        if (this.connectionState.kind !== "online" || this.stopped) {
          this.pendingMode = undefined;
          this.pendingBarrier = false;
          return result;
        }
        const pendingMode = this.pendingMode;
        const pendingBarrier = this.pendingBarrier;
        this.pendingMode = undefined;
        this.pendingBarrier = false;
        if (pendingMode != null) {
          mode = pendingMode;
          continue;
        }
        if (pendingBarrier) {
          mode = "delta";
          continue;
        }
        return result;
      }
    } finally {
      if (this.activeRunGeneration === generation) {
        this.running = undefined;
        this.activeRunController = undefined;
        this.activeRunGeneration = undefined;
        this.runningMode = undefined;
        this.armTimer();
      }
    }
  }

  private async execute(
    mode: AsanaSyncRuntimeSynchronizationMode,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeResult> {
    if (
      signal.aborted
      || this.connectionState.kind !== "online"
      || this.stopped
    ) {
      if (signal.aborted) {
        return createAbortResult();
      }
      if (this.stopped) {
        return createRejectedResult("stopped");
      }
      return createRejectedResult("offline");
    }
    try {
      await this.beforeSynchronization(signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        return createAbortResult();
      }
      throw error;
    }
    if (
      signal.aborted
      || this.connectionState.kind !== "online"
      || this.stopped
    ) {
      if (signal.aborted) {
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
        return createAbortResult();
      }
      const result = asanaSyncCoordinatorResultSchema.parse(coordinated);
      this.lastSuccessfulSyncAt = result.synced_at;
      this.lastErrorCode = undefined;
      this.publishState(this.createOnlineState());
      return createSynchronizedResult(mode, result);
    } catch (error: unknown) {
      if (signal.aborted || error instanceof AsanaRequestAbortedError) {
        if (this.connectionState.kind === "online" && !this.stopped) {
          this.publishState(this.createOnlineState());
        }
        return createAbortResult();
      }
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
      return createFailedResult(knownCode);
    }
  }

  private createOnlineState(): AsanaSyncRuntimeState {
    return asanaSyncRuntimeStateSchema.parse({
      kind: "online",
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
      || this.running != null
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
      const timerRun = this.requestSelectedMode(false, timerSignal);
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
    this.pendingBarrier = false;
    this.clearTimer();
    this.stopController.abort();
    this.activeRunController?.abort();
    this.publishState(this.createOfflineState());
  }
}
