import {
  createCombinedSignal,
  createDeferred,
  mergeRequestedModes,
  validateAbortSignal,
  waitForCaller,
  type Deferred,
} from "./synchronization-run";

type SynchronizationMode = "full" | "delta";
type OperationPriority = "user" | "background";
type SyncRunIntent = "automatic" | "full";
type SyncRunBase<Result> = {
  readonly generation: number;
  readonly deferred: Deferred<Result>;
  readonly promise: Promise<Result>;
  readonly cycleController: AbortController;
  readonly owner: OperationPriority;
  readonly intent: SyncRunIntent;
  readonly mode: SynchronizationMode | undefined;
  readonly pendingMode: SynchronizationMode | undefined;
};
type QueuedSyncRun<Result> = SyncRunBase<Result> & {
  readonly phase: "queued";
  readonly pendingMode: undefined;
};
type PreflightingSyncRun<Result> = SyncRunBase<Result> & {
  readonly phase: "preflighting";
};
type RunningSyncRun<Result> = SyncRunBase<Result> & {
  readonly phase: "running";
  readonly mode: SynchronizationMode;
};
type SyncRunState<Result> =
  | QueuedSyncRun<Result>
  | PreflightingSyncRun<Result>
  | RunningSyncRun<Result>;
type SynchronizationQueue<Result> = {
  enqueue(input: {
    readonly priority: OperationPriority;
    readonly kind: "synchronization";
    readonly signal: AbortSignal;
    readonly run: (context: { readonly signal: AbortSignal }) => Promise<Result>;
  }): Promise<Result>;
  linkOwnedSignal(signal: AbortSignal, ownerSignal: AbortSignal): () => void;
};
type RejectionDisposition<Result> =
  | { readonly kind: "resolve"; readonly result: Result; readonly rearmTimer: boolean }
  | { readonly kind: "reject"; readonly error: unknown; readonly rearmTimer: boolean };
type PreflightResult<Result> =
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly result: Result };
type SyncRunReservationOptions<Result> = {
  readonly operationQueue: SynchronizationQueue<Result>;
  readonly lifecycleSignal: AbortSignal;
  readonly stopSignal: AbortSignal;
  readonly selectMode: () => SynchronizationMode;
  readonly preflight: (signal: AbortSignal) => Promise<PreflightResult<Result>>;
  readonly execute: (mode: SynchronizationMode, signal: AbortSignal) => Promise<Result>;
  readonly shouldContinue: (result: Result) => boolean;
  readonly handleRejection: (
    error: unknown,
    owner: OperationPriority,
  ) => RejectionDisposition<Result>;
  readonly armTimer: () => void;
  readonly clearTimer: () => void;
  readonly createAbortResult: () => Result;
};

/** 同期要求の集約とAsana操作キューへの実行予約を所有します。 */
export class SyncRunReservation<Result> {
  private readonly options: SyncRunReservationOptions<Result>;
  private scheduledRun: SyncRunState<Result> | undefined;
  private activeRunController: AbortController | undefined;
  private runGeneration = 0;
  private activeRunGeneration: number | undefined;

  public constructor(options: SyncRunReservationOptions<Result>) {
    this.options = options;
  }

  /** 同期要求を実行中の予約へ集約するか、新しく予約します。 */
  public request(
    mode: SynchronizationMode | undefined,
    intent: SyncRunIntent,
    signal: AbortSignal,
    priority: OperationPriority,
  ): Promise<Result> {
    validateAbortSignal(signal);
    if (signal.aborted) {
      return Promise.resolve(this.options.createAbortResult());
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
      const ownershipTransferred = scheduledRun.owner === "background"
        && priority === "user";
      const deferred = ownershipTransferred
        ? createDeferred<Result>()
        : scheduledRun.deferred;
      let updatedRun: SyncRunState<Result>;
      if (scheduledRun.phase === "queued") {
        updatedRun = {
          ...scheduledRun,
          deferred,
          promise: deferred.promise,
          owner: ownershipTransferred ? "user" : scheduledRun.owner,
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
          deferred,
          promise: deferred.promise,
          owner: ownershipTransferred ? "user" : scheduledRun.owner,
          intent: mergedIntent,
          mode: updatedMode,
          pendingMode: mode === "full" && scheduledRun.mode === "delta"
            ? "full"
            : scheduledRun.pendingMode,
        };
      } else {
        updatedRun = {
          ...scheduledRun,
          deferred,
          promise: deferred.promise,
          owner: ownershipTransferred ? "user" : scheduledRun.owner,
          intent: mergedIntent,
          pendingMode: mode === "full" && scheduledRun.mode === "delta"
            ? "full"
            : scheduledRun.pendingMode,
        };
      }
      this.scheduledRun = updatedRun;
      if (ownershipTransferred) {
        scheduledRun.deferred.resolve(this.options.createAbortResult());
      }
      return waitForCaller(updatedRun.promise, signal, this.options.createAbortResult);
    }
    return this.scheduleRun(mode, intent, signal, priority);
  }

  /** 実行予約と実行中の同期へ中断を通知します。 */
  public abort(): void {
    this.scheduledRun?.cycleController.abort();
    this.activeRunController?.abort();
  }

  /** 同期の実行予約が残っているか返します。 */
  public hasScheduledRun(): boolean {
    return this.scheduledRun != null;
  }

  /** 実行予約の完了を待つPromiseを返します。 */
  public currentPromise(): Promise<Result> | undefined {
    return this.scheduledRun?.promise;
  }

  private scheduleRun(
    mode: SynchronizationMode | undefined,
    intent: SyncRunIntent,
    signal: AbortSignal,
    owner: OperationPriority,
  ): Promise<Result> {
    this.options.clearTimer();
    this.runGeneration += 1;
    const generation = this.runGeneration;
    const deferred = createDeferred<Result>();
    const cycleController = new AbortController();
    const scheduledRun: QueuedSyncRun<Result> = {
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
      this.options.lifecycleSignal,
      this.options.stopSignal,
      cycleController.signal,
    ]);
    const queued = this.options.operationQueue.enqueue({
      priority: owner,
      kind: "synchronization",
      signal: queuedSignal,
      run: (context) => this.drain(generation, context.signal),
    });
    void queued.then(
      (result) => this.completeRun(scheduledRun, result),
      (error: unknown) => this.rejectRun(scheduledRun, error),
    );
    return waitForCaller(deferred.promise, signal, this.options.createAbortResult);
  }

  private completeRun(run: SyncRunBase<Result>, result: Result): void {
    const completedRun = this.scheduledRun?.generation === run.generation
      ? this.scheduledRun
      : run;
    if (this.scheduledRun?.generation === run.generation) {
      this.scheduledRun = undefined;
    }
    completedRun.deferred.resolve(result);
    this.options.armTimer();
  }

  private rejectRun(run: SyncRunBase<Result>, error: unknown): void {
    const rejectedRun = this.scheduledRun?.generation === run.generation
      ? this.scheduledRun
      : run;
    const disposition = this.options.handleRejection(error, rejectedRun.owner);
    if (disposition.kind === "resolve") {
      rejectedRun.deferred.resolve(disposition.result);
    } else {
      rejectedRun.deferred.reject(disposition.error);
    }
    if (this.scheduledRun?.generation === run.generation) {
      this.scheduledRun = undefined;
    }
    if (disposition.rearmTimer) {
      this.options.armTimer();
    }
  }

  private async drain(generation: number, sharedSignal: AbortSignal): Promise<Result> {
    const queuedRun = this.scheduledRun;
    if (queuedRun == null || queuedRun.generation !== generation) {
      throw new Error("同期キューの実行状態が一致しません。");
    }
    if (queuedRun.phase !== "queued") {
      throw new Error("同期キューの開始状態が不正です。");
    }
    const preflightingRun: PreflightingSyncRun<Result> = {
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
        ?? (selectedRun.intent === "full" ? "full" : this.options.selectMode());
      const modeSelectedRun: PreflightingSyncRun<Result> = {
        ...selectedRun,
        mode: selectedMode,
      };
      this.scheduledRun = modeSelectedRun;
      const readiness = await this.options.preflight(sharedSignal);
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
      let runningRun: RunningSyncRun<Result> = {
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
        const removeOwnedSignal = this.options.operationQueue.linkOwnedSignal(
          operationSignal,
          sharedSignal,
        );
        let result: Result;
        try {
          result = await this.options.execute(mode, operationSignal);
        } finally {
          removeOwnedSignal();
          if (this.activeRunGeneration === generation) {
            this.activeRunController = undefined;
          }
        }
        if (!this.options.shouldContinue(result)) {
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
}
