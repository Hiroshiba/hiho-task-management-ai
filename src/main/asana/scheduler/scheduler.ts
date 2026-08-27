const maximumReadConcurrency = 5;
const maximumWriteConcurrency = 1;
const maximumAttempts = 120;
const attemptWindowMilliseconds = 60_000;

export type AsanaRequestKind = "read" | "write";

interface QueueItem {
  readonly isCancelled: () => boolean;
  readonly start: () => void;
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
  private readonly readQueue: QueueItem[] = [];
  private readonly writeQueue: QueueItem[] = [];
  private readonly attemptTimestamps: number[] = [];
  private readActiveCount = 0;
  private writeActiveCount = 0;
  private rateLimitTimer: ReturnType<typeof setTimeout> | undefined;
  private nextKindToStart: AsanaRequestKind = "read";

  /** Asanaリクエストをスケジュールします。 */
  public schedule<T>(
    kind: AsanaRequestKind,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (kind !== "read" && kind !== "write") {
      throw new Error("Asanaリクエスト種別が不正です。");
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
        this.readQueue.push(item);
      } else {
        this.writeQueue.push(item);
      }
      this.pump();
    });
  }

  private pump(): void {
    this.removeCancelledItems(this.readQueue);
    this.removeCancelledItems(this.writeQueue);
    this.removeExpiredAttempts();
    if (this.readQueue.length === 0 && this.writeQueue.length === 0) {
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

    if (
      this.attemptTimestamps.length >= maximumAttempts
      && (this.readQueue.length > 0 || this.writeQueue.length > 0)
    ) {
      this.scheduleRateLimitTimer();
    } else {
      this.clearRateLimitTimer();
    }
  }

  private removeCancelledItems(queue: QueueItem[]): void {
    const remainingItems = queue.filter((item) => !item.isCancelled());
    queue.length = 0;
    queue.push(...remainingItems);
  }

  private tryStart(kind: AsanaRequestKind): boolean {
    const queue = kind === "read" ? this.readQueue : this.writeQueue;
    const item = this.takeRunnableItem(queue);
    if (item == null) {
      return false;
    }
    const activeCount = kind === "read"
      ? this.readActiveCount
      : this.writeActiveCount;
    const maximumConcurrency = kind === "read"
      ? maximumReadConcurrency
      : maximumWriteConcurrency;
    if (activeCount >= maximumConcurrency) {
      queue.unshift(item);
      return false;
    }
    item.start();
    this.nextKindToStart = kind === "read" ? "write" : "read";
    return true;
  }

  private takeRunnableItem(queue: QueueItem[]): QueueItem | undefined {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item == null) {
        throw new Error("Asanaリクエストキューの項目を取得できません。");
      }
      if (!item.isCancelled()) {
        return item;
      }
    }
    return undefined;
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
