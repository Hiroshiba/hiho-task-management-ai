const maximumReadConcurrency = 5;
const maximumWriteConcurrency = 1;
const maximumAttempts = 120;
const attemptWindowMilliseconds = 60_000;
const lowPriorityRateHeadroom = 10;
const maximumHighPriorityStartsWhileLowWaiting = 8;

export type AsanaRequestKind = "read" | "write";
export type AsanaRequestPriority = "high" | "normal" | "low";

/** 優先度を固定したAsanaリクエスト受付範囲を表します。 */
export interface AsanaRequestPriorityScope {
  schedule<T>(
    kind: AsanaRequestKind,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
}

interface QueueItem {
  readonly isCancelled: () => boolean;
  readonly start: () => void;
}

interface PriorityQueues {
  readonly high: QueueItem[];
  readonly normal: QueueItem[];
  readonly low: QueueItem[];
}

interface QueueSelection {
  readonly item: QueueItem;
  readonly priority: AsanaRequestPriority;
}

const priorityOrder: readonly AsanaRequestPriority[] = [
  "high",
  "normal",
  "low",
];

function createPriorityQueues(): PriorityQueues {
  return { high: [], normal: [], low: [] };
}

function validatePriority(priority: AsanaRequestPriority): void {
  if (priority !== "high" && priority !== "normal" && priority !== "low") {
    throw new Error("Asanaリクエストの優先度が不正です。");
  }
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

/** Asanaリクエストが実行開始前に中断されたことを表します。 */
export class AsanaRequestAbortedError extends Error {
  public constructor() {
    super("Asanaリクエストが実行開始前に中断されました。");
    this.name = "AsanaRequestAbortedError";
  }
}

/** Asanaリクエストを並列数とレート上限に従って実行します。 */
export class AsanaRequestScheduler {
  private readonly readQueues = createPriorityQueues();
  private readonly writeQueues = createPriorityQueues();
  private readonly attemptTimestamps: number[] = [];
  private readActiveCount = 0;
  private writeActiveCount = 0;
  private rateLimitTimer: ReturnType<typeof setTimeout> | undefined;
  private nextKindToStart: AsanaRequestKind = "read";
  private highPriorityStartsWhileLowWaiting = 0;

  /** Asanaリクエストをスケジュールします。 */
  public schedule<T>(
    kind: AsanaRequestKind,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.scheduleAtPriority("normal", kind, signal, operation);
  }

  /** 指定優先度のAsanaリクエスト受付範囲を作成します。 */
  public withPriority(
    priority: AsanaRequestPriority,
  ): AsanaRequestPriorityScope {
    validatePriority(priority);
    return {
      schedule: <T>(
        kind: AsanaRequestKind,
        signal: AbortSignal,
        operation: () => Promise<T>,
      ): Promise<T> => this.scheduleAtPriority(priority, kind, signal, operation),
    };
  }

  private scheduleAtPriority<T>(
    priority: AsanaRequestPriority,
    kind: AsanaRequestKind,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    validatePriority(priority);
    if (kind !== "read" && kind !== "write") {
      throw new Error("Asanaリクエスト種別が不正です。");
    }
    validateAbortSignal(signal);
    if (typeof operation !== "function") {
      throw new TypeError("Asanaリクエスト操作関数が必要です。");
    }
    if (signal.aborted) {
      return Promise.reject(new AsanaRequestAbortedError());
    }

    return new Promise<T>((resolve, reject) => {
      let started = false;
      let cancelled = false;

      const removeAbortListener = (): void => {
        signal.removeEventListener("abort", onAbort);
      };

      const finish = (): void => {
        if (kind === "read") {
          this.readActiveCount -= 1;
        } else {
          this.writeActiveCount -= 1;
        }
        this.pump();
      };

      const start = (): void => {
        if (cancelled) {
          return;
        }
        started = true;
        removeAbortListener();
        if (kind === "read") {
          this.readActiveCount += 1;
        } else {
          this.writeActiveCount += 1;
        }
        this.attemptTimestamps.push(Date.now());
        this.notePriorityStart(priority);

        const result = (async (): Promise<T> => operation())();
        void result.then(resolve, reject).finally(finish);
      };

      const cancel = (): void => {
        if (started || cancelled) {
          return;
        }
        cancelled = true;
        removeAbortListener();
        reject(new AsanaRequestAbortedError());
        this.pump();
      };

      const onAbort = (): void => {
        cancel();
      };

      const item: QueueItem = {
        isCancelled: (): boolean => cancelled,
        start,
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (kind === "read") {
        this.readQueues[priority].push(item);
      } else {
        this.writeQueues[priority].push(item);
      }
      if (signal.aborted) {
        cancel();
        return;
      }
      this.pump();
    });
  }

  private pump(): void {
    this.removeCancelledItems(this.readQueues);
    this.removeCancelledItems(this.writeQueues);
    this.removeExpiredAttempts();
    if (!this.hasPendingItems()) {
      this.highPriorityStartsWhileLowWaiting = 0;
      this.clearRateLimitTimer();
      return;
    }
    if (this.attemptTimestamps.length >= maximumAttempts) {
      this.scheduleRateLimitTimer();
      return;
    }
    this.clearRateLimitTimer();

    let didStart = true;
    while (didStart && this.attemptTimestamps.length < maximumAttempts) {
      const firstKind = this.nextKindToStart;
      const secondKind = firstKind === "read" ? "write" : "read";
      const startedFirst = this.tryStart(firstKind);
      const startedSecond = this.attemptTimestamps.length < maximumAttempts
        ? this.tryStart(secondKind)
        : false;
      didStart = startedFirst || startedSecond;
    }

    if (this.hasPendingItems() && this.mustWaitForRateLimit()) {
      this.scheduleRateLimitTimer();
    } else if (!this.hasPendingItems()) {
      this.clearRateLimitTimer();
    } else {
      this.clearRateLimitTimer();
    }
  }

  private removeCancelledItems(queues: PriorityQueues): void {
    for (const priority of priorityOrder) {
      const queue = queues[priority];
      const remainingItems = queue.filter((item) => !item.isCancelled());
      queue.length = 0;
      queue.push(...remainingItems);
    }
  }

  private tryStart(kind: AsanaRequestKind): boolean {
    const queues = kind === "read" ? this.readQueues : this.writeQueues;
    const selection = this.takeRunnableItem(queues);
    if (selection == null) {
      return false;
    }
    const activeCount = kind === "read"
      ? this.readActiveCount
      : this.writeActiveCount;
    const maximumConcurrency = kind === "read"
      ? maximumReadConcurrency
      : maximumWriteConcurrency;
    if (activeCount >= maximumConcurrency) {
      queues[selection.priority].unshift(selection.item);
      return false;
    }
    selection.item.start();
    this.nextKindToStart = kind === "read" ? "write" : "read";
    return true;
  }

  private takeRunnableItem(
    queues: PriorityQueues,
  ): QueueSelection | undefined {
    if (this.shouldForceLowPriority(queues)) {
      const lowQueue = queues.low;
      while (lowQueue.length > 0) {
        const item = lowQueue.shift();
        if (item == null) {
          throw new Error("Asanaリクエストキューの項目を取得できません。");
        }
        if (!item.isCancelled()) {
          return { item, priority: "low" };
        }
      }
    }
    for (const priority of priorityOrder) {
      if (priority === "low" && !this.canStartLowPriority()) {
        continue;
      }
      const queue = queues[priority];
      while (queue.length > 0) {
        const item = queue.shift();
        if (item == null) {
          throw new Error("Asanaリクエストキューの項目を取得できません。");
        }
        if (!item.isCancelled()) {
          return { item, priority };
        }
      }
    }
    return undefined;
  }

  private shouldForceLowPriority(queues: PriorityQueues): boolean {
    return this.hasPendingPriority(queues, "low")
      && this.attemptTimestamps.length <= maximumAttempts - lowPriorityRateHeadroom
      && this.highPriorityStartsWhileLowWaiting
        >= maximumHighPriorityStartsWhileLowWaiting;
  }

  private canStartLowPriority(): boolean {
    if (this.attemptTimestamps.length > maximumAttempts - lowPriorityRateHeadroom) {
      return false;
    }
    const hasHigherPriority =
      this.hasPendingPriority(this.readQueues, "high")
      || this.hasPendingPriority(this.readQueues, "normal")
      || this.hasPendingPriority(this.writeQueues, "high")
      || this.hasPendingPriority(this.writeQueues, "normal");
    if (!hasHigherPriority) {
      return true;
    }
    return this.highPriorityStartsWhileLowWaiting
      >= maximumHighPriorityStartsWhileLowWaiting;
  }

  private notePriorityStart(priority: AsanaRequestPriority): void {
    if (priority === "low") {
      this.highPriorityStartsWhileLowWaiting = 0;
      return;
    }
    if (this.hasPendingLowPriority()) {
      this.highPriorityStartsWhileLowWaiting += 1;
    }
  }

  private mustWaitForRateLimit(): boolean {
    if (this.attemptTimestamps.length >= maximumAttempts) {
      return true;
    }
    return this.hasPendingLowPriority()
      && this.attemptTimestamps.length > maximumAttempts - lowPriorityRateHeadroom
      && !this.hasPendingHigherPriority();
  }

  private hasPendingHigherPriority(): boolean {
    return this.hasPendingPriority(this.readQueues, "high")
      || this.hasPendingPriority(this.readQueues, "normal")
      || this.hasPendingPriority(this.writeQueues, "high")
      || this.hasPendingPriority(this.writeQueues, "normal");
  }

  private hasPendingItems(): boolean {
    return this.hasPendingQueue(this.readQueues) || this.hasPendingQueue(this.writeQueues);
  }

  private hasPendingLowPriority(): boolean {
    return this.hasPendingPriority(this.readQueues, "low")
      || this.hasPendingPriority(this.writeQueues, "low");
  }

  private hasPendingQueue(queues: PriorityQueues): boolean {
    return priorityOrder.some((priority) => this.hasPendingPriority(queues, priority));
  }

  private hasPendingPriority(
    queues: PriorityQueues,
    priority: AsanaRequestPriority,
  ): boolean {
    return queues[priority].some((item) => !item.isCancelled());
  }

  private removeExpiredAttempts(): void {
    const expiration = Date.now() - attemptWindowMilliseconds;
    while (this.attemptTimestamps.length > 0) {
      const timestamp = this.attemptTimestamps[0];
      if (timestamp == null) {
        throw new Error("Asanaリクエストの実行時刻を取得できません。");
      }
      if (timestamp > expiration) {
        return;
      }
      this.attemptTimestamps.shift();
    }
  }

  private scheduleRateLimitTimer(): void {
    if (this.rateLimitTimer != null) {
      return;
    }
    const oldestAttempt = this.attemptTimestamps[0];
    if (oldestAttempt == null) {
      throw new Error("Asanaリクエストの実行時刻がありません。");
    }
    const delay = Math.max(
      0,
      oldestAttempt + attemptWindowMilliseconds - Date.now(),
    );
    this.rateLimitTimer = setTimeout(() => {
      this.rateLimitTimer = undefined;
      this.pump();
    }, delay);
  }

  private clearRateLimitTimer(): void {
    if (this.rateLimitTimer == null) {
      return;
    }
    clearTimeout(this.rateLimitTimer);
    this.rateLimitTimer = undefined;
  }
}
