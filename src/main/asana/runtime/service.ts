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
  combineDiagnosticFailures,
  DiagnosticFailureDispositionError,
} from "../../application/common/errors/diagnostic-failure";
import {
  AsanaOperationQueue,
  type AsanaOperationPriority,
} from "../operation-queue";
import {
  AsanaSyncCoordinator,
  AsanaSyncInProgressError,
  asanaSyncCoordinatorInputSchema,
} from "../sync";
import { isoDateTimeSchema } from "../../../shared/domain";
import type { TaskReadSyncState } from "../../application/common/ports/task-read-repository";
import { AsanaSyncRuntimeAlreadyReportedError } from "./errors";
import {
  createCombinedSignal,
  validateAbortSignal,
} from "../../infrastructure/asana/synchronization-run";
import { SyncRunReservation } from "../../infrastructure/asana/sync-run-reservation";
import {
  asanaSyncRuntimeConfigurationSchema,
  asanaSyncRuntimeStateSchema,
  createAbortResult,
  createAuthenticationRequiredRuntimeState,
  createErrorRuntimeState,
  createFailedResult,
  createOfflineRuntimeState,
  createOnlineRuntimeState,
  createRejectedResult,
  createSynchronizedResult,
  createSyncingRuntimeState,
  type AsanaSyncRuntimeConfiguration,
  type AsanaSyncRuntimeErrorCode,
  type AsanaSyncRuntimeInternalResult,
  type AsanaSyncRuntimeState,
  type AsanaSyncRuntimeSynchronizationMode,
} from "./schemas";

const fullSyncIntervalMilliseconds = 24 * 60 * 60 * 1000;
const onlineSyncIntervalMilliseconds = 60 * 1000;

type AsanaSyncCoordinatorPort = Pick<AsanaSyncCoordinator, "coordinate" | "resultSchema">;
type SyncStateRepository = { getSyncState(projectGid: string): TaskReadSyncState | undefined };
type BeforeSynchronization = (
  signal: AbortSignal,
  executionId?: string,
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
/** 予期しない同期エラーを通知する関数です。 */
export type AsanaSyncRuntimeUnexpectedErrorNotifier = (
  error: unknown,
) => void;

/** 同期失敗を最終的な未処理エラーへ渡す関数です。 */
export type AsanaSyncRuntimeUnhandledErrorForwarder = (
  error: unknown,
) => void;

/** 同期状態の変更を受け取る関数です。 */
export type AsanaSyncRuntimeStateListener = (
  state: AsanaSyncRuntimeState,
  cause?: unknown,
) => void;

function validateFunction(value: unknown, message: string): void {
  if (typeof value !== "function") {
    throw new TypeError(message);
  }
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

/** Asana同期の起動契機とライフサイクルを調整します。 */
export class AsanaSyncRuntime {
  private readonly coordinator: AsanaSyncCoordinatorPort;
  private readonly stateRepository: SyncStateRepository;
  private readonly configuration: AsanaSyncRuntimeConfiguration;
  private readonly lifecycleSignal: AbortSignal;
  private readonly beforeSynchronization: BeforeSynchronization;
  private readonly notifyUnexpectedError: AsanaSyncRuntimeUnexpectedErrorNotifier;
  private readonly forwardUnhandledError: AsanaSyncRuntimeUnhandledErrorForwarder;
  private readonly nowProvider: () => string;
  private readonly operationQueue: AsanaOperationQueue;
  private readonly parseSyncState: (value: unknown) => TaskReadSyncState;
  private readonly stopController = new AbortController();
  private readonly listeners = new Set<AsanaSyncRuntimeStateListener>();
  private readonly lifecycleAbortListener = (): void => {
    this.handleLifecycleAbort();
  };
  private readonly runReservation: SyncRunReservation<AsanaSyncRuntimeInternalResult>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private connectionState: RuntimeConnectionState;
  private stopped: boolean;
  private lastSuccessfulSyncAt: string | undefined;
  private lastErrorCode: AsanaSyncRuntimeErrorCode | undefined;
  private state: AsanaSyncRuntimeState;

  public constructor(
    coordinator: AsanaSyncCoordinatorPort,
    stateRepository: SyncStateRepository,
    configuration: AsanaSyncRuntimeConfiguration,
    lifecycleSignal: AbortSignal,
    beforeSynchronization: BeforeSynchronization,
    notifyUnexpectedError: AsanaSyncRuntimeUnexpectedErrorNotifier,
    forwardUnhandledError: AsanaSyncRuntimeUnhandledErrorForwarder,
    nowProvider: () => string,
    operationQueue: AsanaOperationQueue,
    parseSyncState: (value: unknown) => TaskReadSyncState,
  ) {
    validateFunction(coordinator?.coordinate, "Asana同期コーディネーターが必要です。");
    validateFunction(
      stateRepository == null ? undefined : stateRepository.getSyncState.bind(stateRepository),
      "同期状態の保存先が必要です。",
    );
    validateAbortSignal(lifecycleSignal);
    validateFunction(beforeSynchronization, "同期前フックが必要です。");
    validateFunction(notifyUnexpectedError, "予期しないエラー通知関数が必要です。");
    validateFunction(forwardUnhandledError, "未処理エラー転送関数が必要です。");
    validateFunction(nowProvider, "現在時刻関数が必要です。");
    validateFunction(parseSyncState, "同期状態の検証関数が必要です。");
    if (!(operationQueue instanceof AsanaOperationQueue)) {
      throw new TypeError("Asana操作キューが必要です。");
    }
    this.configuration = asanaSyncRuntimeConfigurationSchema.parse(configuration);
    this.coordinator = coordinator;
    this.stateRepository = stateRepository;
    this.lifecycleSignal = lifecycleSignal;
    this.beforeSynchronization = beforeSynchronization;
    this.notifyUnexpectedError = notifyUnexpectedError;
    this.forwardUnhandledError = forwardUnhandledError;
    this.nowProvider = nowProvider;
    this.operationQueue = operationQueue;
    this.parseSyncState = parseSyncState;
    const existingState = this.readSyncState();
    this.lastSuccessfulSyncAt = existingState?.last_successful_sync_at;
    this.connectionState = this.configuration.initial_online && !lifecycleSignal.aborted
      ? { kind: "online" }
      : { kind: "offline" };
    this.stopped = lifecycleSignal.aborted;
    this.state = asanaSyncRuntimeStateSchema.parse(
      this.connectionState.kind === "online"
        ? createOnlineRuntimeState(
            this.lastSuccessfulSyncAt,
            this.lastErrorCode,
            undefined,
          )
        : createOfflineRuntimeState(
            this.lastSuccessfulSyncAt,
            this.lastErrorCode,
          ),
    );
    this.runReservation = new SyncRunReservation<AsanaSyncRuntimeInternalResult>({
      operationQueue: this.operationQueue,
      lifecycleSignal: this.lifecycleSignal,
      stopSignal: this.stopController.signal,
      selectMode: () => this.selectMode(),
      preflight: (sharedSignal) => this.preflightSynchronization(sharedSignal),
      execute: (mode, operationSignal) => this.execute(mode, [], operationSignal),
      shouldContinue: (result) => {
        if (
          result.kind === "aborted"
          || result.kind === "failed"
          || result.kind === "rejected"
        ) {
          return false;
        }
        return this.connectionState.kind === "online" && !this.stopped;
      },
      handleRejection: (error, owner) => {
        if (error instanceof AsanaRequestAbortedError) {
          return { kind: "resolve", result: createAbortResult(), rearmTimer: true };
        }
        if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
          return { kind: "reject", error, rearmTimer: true };
        }
        if (owner === "background") {
          const rejection = this.notifyBackgroundFailure(error);
          return {
            kind: "reject",
            error: rejection,
            rearmTimer: !(
              rejection instanceof DiagnosticFailureDispositionError
              && rejection.disposition.kind !== "recorded_only"
            ),
          };
        }
        return { kind: "reject", error, rearmTimer: true };
      },
      armTimer: () => this.armTimer(),
      clearTimer: () => this.clearTimer(),
      createAbortResult,
    });
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
    executionId: string,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("GUI事後同期の実行権を所有していません。");
    }
    return this.runOwnedAfterApply(requiredTaskGids, executionId, signal);
  }

  /** AI変更適用後の同期と後処理を実行します。 */
  public async afterAiApply(
    requiredTaskGids: readonly string[],
    executionId: string,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    validateAbortSignal(signal);
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("AI適用後同期の実行権を所有していません。");
    }
    return this.runOwnedAfterApply(requiredTaskGids, executionId, signal);
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
      this.runReservation.abort();
      this.operationQueue.abortActive();
      this.operationQueue.invalidatePendingMutations("offline");
      this.publishState(createOfflineRuntimeState(this.lastSuccessfulSyncAt, this.lastErrorCode));
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
    this.runReservation.abort();
    this.operationQueue.abortActive();
    this.operationQueue.invalidatePendingMutations("offline");
    this.publishState(createOfflineRuntimeState(this.lastSuccessfulSyncAt, this.lastErrorCode));
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

  /** 専用の読取同期で保存した状態をランタイムへ反映します。 */
  public acceptReadOnlySynchronization(syncedAt: string, signal: AbortSignal): void {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    if (!this.operationQueueHasOwner(signal)) {
      throw new Error("読取同期の実行権を所有していません。");
    }
    const saved = this.readSyncState();
    if (saved?.last_successful_sync_at !== syncedAt) {
      throw new Error("読取同期の保存時刻が同期結果と一致しません。");
    }
    this.lastSuccessfulSyncAt = saved.last_successful_sync_at;
    this.lastErrorCode = undefined;
    this.connectionState = { kind: "online" };
    this.publishState(createOnlineRuntimeState(this.lastSuccessfulSyncAt, undefined, []));
    this.armTimer();
  }

  /** 同期ランタイムを停止します。 */
  public async stop(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true;
      this.connectionState = { kind: "offline" };
      this.clearTimer();
      this.stopController.abort();
      this.runReservation.abort();
      this.publishState(createOfflineRuntimeState(this.lastSuccessfulSyncAt, this.lastErrorCode));
      this.lifecycleSignal.removeEventListener(
        "abort",
        this.lifecycleAbortListener,
      );
    }
    const scheduledRun = this.runReservation.currentPromise();
    if (scheduledRun != null) {
      await scheduledRun;
    }
  }

  private operationQueueHasOwner(signal: AbortSignal): boolean {
    return this.operationQueue.hasOwner(signal);
  }

  private async runOwnedAfterApply(
    requiredTaskGids: readonly string[],
    executionId: string,
    signal: AbortSignal,
  ): Promise<AsanaSyncRuntimeInternalResult> {
    if (signal.aborted) {
      this.operationQueue.invalidatePendingMutations("synchronization_failed");
      this.recordAbortState();
      return createAbortResult();
    }
    try {
      return await this.operationQueue.runOwned(signal, async (context) => {
        const readiness = await this.preflightSynchronization(context.signal, executionId);
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
    return this.runReservation.request(mode, intent, signal, priority);
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
    executionId?: string,
  ): Promise<OnlineReadiness> {
    const readiness = this.ensureOnline(signal);
    if (readiness.kind === "unavailable") {
      return readiness;
    }
    try {
      await this.beforeSynchronization(signal, executionId);
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
      this.publishState(createOnlineRuntimeState(
        this.lastSuccessfulSyncAt,
        this.lastErrorCode,
        undefined,
      ));
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

  private readSyncState(): TaskReadSyncState | undefined {
    const state = this.stateRepository.getSyncState(this.configuration.project_gid);
    if (state == null) {
      return undefined;
    }
    const parsed = this.parseSyncState(state);
    if (parsed.project_gid !== this.configuration.project_gid) {
      throw new Error("保存済み同期状態のプロジェクトGIDが一致しません。");
    }
    return parsed;
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
      this.publishState(createSyncingRuntimeState(
        this.lastSuccessfulSyncAt,
        this.lastErrorCode,
        mode,
      ));
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
      const result = this.coordinator.resultSchema.parse(coordinated);
      this.lastSuccessfulSyncAt = result.synced_at;
      this.lastErrorCode = undefined;
      this.publishState(
        createOnlineRuntimeState(
          this.lastSuccessfulSyncAt,
          this.lastErrorCode,
          result.normalization_notifications,
        ),
      );
      return createSynchronizedResult(mode, result, this.coordinator.resultSchema);
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
        this.publishState(createErrorRuntimeState(
          this.lastSuccessfulSyncAt,
          "unexpected_error",
        ));
        throw error;
      }
      this.lastErrorCode = knownCode;
      if (knownCode === "authentication_required") {
        this.publishState(
          createAuthenticationRequiredRuntimeState(this.lastSuccessfulSyncAt),
          error,
        );
      } else {
        this.publishState(
          createErrorRuntimeState(this.lastSuccessfulSyncAt, knownCode),
          error,
        );
      }
      return createFailedResult(knownCode, error);
    }
  }

  private recordAbortState(): void {
    this.lastErrorCode = "request_aborted";
    if (this.connectionState.kind === "online" && !this.stopped) {
      this.publishState(createErrorRuntimeState(
        this.lastSuccessfulSyncAt,
        "request_aborted",
      ));
      return;
    }
    this.publishState(createOfflineRuntimeState(this.lastSuccessfulSyncAt, this.lastErrorCode));
  }

  private publishState(state: AsanaSyncRuntimeState, cause?: unknown): void {
    this.state = asanaSyncRuntimeStateSchema.parse(state);
    for (const listener of this.listeners) {
      try {
        listener(this.state, cause);
      } catch (error: unknown) {
        this.notifyUnexpectedError(error);
      }
    }
  }

  private processTimerFailure(error: unknown): void {
    if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
      this.armTimer();
      return;
    }
    if (error instanceof DiagnosticFailureDispositionError) {
      switch (error.disposition.kind) {
        case "recorded_only":
          this.armTimer();
          return;
        case "unrecorded_only":
        case "recorded_and_unrecorded":
          this.forwardTerminalError(error.disposition.unrecorded_error);
          return;
      }
    }
    this.processTimerFailure(this.notifyBackgroundFailure(error));
  }

  private notifyBackgroundFailure(
    error: unknown,
  ): AsanaSyncRuntimeAlreadyReportedError | DiagnosticFailureDispositionError {
    try {
      this.notifyUnexpectedError(error);
      return new AsanaSyncRuntimeAlreadyReportedError(error);
    } catch (diagnosticError: unknown) {
      if (diagnosticError instanceof DiagnosticFailureDispositionError) {
        return diagnosticError;
      }
      return combineDiagnosticFailures([error, diagnosticError]);
    }
  }

  private forwardTerminalError(error: unknown): void {
    queueMicrotask(() => this.forwardUnhandledError(error));
  }

  private armTimer(): void {
    if (
      this.timer != null
      || this.runReservation.hasScheduledRun()
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
      try {
        const timerRun = this.requestSelectedMode(false, timerSignal, "background");
        void timerRun.then(
          () => {
            this.armTimer();
          },
          (error: unknown) => {
            this.processTimerFailure(error);
          },
        );
      } catch (error: unknown) {
        this.processTimerFailure(error);
      }
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
    this.runReservation.abort();
    this.operationQueue.abortActive();
    this.operationQueue.invalidatePendingMutations("offline");
    this.publishState(createOfflineRuntimeState(this.lastSuccessfulSyncAt, this.lastErrorCode));
  }
}
