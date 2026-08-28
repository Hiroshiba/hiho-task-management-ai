import { AsanaRequestAbortedError } from "../scheduler";
import {
  AsanaTaskWriteClient,
  type AsanaTaskInsertionPosition,
} from "../client/task-write-client";
import { AsanaTransport } from "../transport";
import {
  asanaDisplayOrderInputSchema,
  asanaDisplayOrderResultSchema,
  type AsanaDisplayOrderInput,
  type AsanaDisplayOrderResult,
} from "./schemas";

const debounceMilliseconds = 3_000;

type DisplayOrderWriteClient = Pick<
  AsanaTaskWriteClient,
  "addTaskToProject"
>;

/** 表示順同期の診断通知関数を表します。 */
export type AsanaDisplayOrderUnexpectedErrorNotifier = (
  error: unknown,
) => void;

type Waiter = {
  readonly signal: AbortSignal;
  readonly resolve: (result: AsanaDisplayOrderResult) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  settled: boolean;
};

type PendingBatch = {
  input: AsanaDisplayOrderInput;
  readonly waiters: Waiter[];
};

type RunningBatch = {
  readonly promise: Promise<AsanaDisplayOrderResult>;
};

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

function createWaiter(signal: AbortSignal): {
  readonly waiter: Waiter;
  readonly promise: Promise<AsanaDisplayOrderResult>;
} {
  let resolvePromise: ((result: AsanaDisplayOrderResult) => void) | undefined;
  let rejectPromise: ((error: unknown) => void) | undefined;
  const promise = new Promise<AsanaDisplayOrderResult>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  if (resolvePromise == null || rejectPromise == null) {
    throw new Error("表示順同期の待機処理を初期化できません。");
  }
  const onAbort = (): void => {
    if (waiter.settled) {
      return;
    }
    waiter.settled = true;
    signal.removeEventListener("abort", onAbort);
    waiter.reject(new AsanaRequestAbortedError());
  };
  const waiter: Waiter = {
    signal,
    resolve: resolvePromise,
    reject: rejectPromise,
    onAbort,
    settled: false,
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return { waiter, promise };
}

function resolveWaiter(
  waiter: Waiter,
  result: AsanaDisplayOrderResult,
): void {
  if (waiter.settled) {
    return;
  }
  waiter.settled = true;
  waiter.signal.removeEventListener("abort", waiter.onAbort);
  waiter.resolve(result);
}

function rejectWaiter(waiter: Waiter, error: unknown): void {
  if (waiter.settled) {
    return;
  }
  waiter.settled = true;
  waiter.signal.removeEventListener("abort", waiter.onAbort);
  waiter.reject(error);
}

function createDesiredOrder(
  current: readonly string[],
  ranking: readonly string[],
): string[] {
  const currentGids = new Set(current);
  const desired = ranking.filter((gid) => currentGids.has(gid));
  for (const gid of current) {
    if (!desired.includes(gid)) {
      desired.push(gid);
    }
  }
  return desired;
}

/** 低優先度のAsana通信を使う表示順同期を生成します。 */
export function createAsanaDisplayOrderService(
  transport: AsanaTransport,
  notifyUnexpectedError: AsanaDisplayOrderUnexpectedErrorNotifier,
  lifecycleSignal: AbortSignal,
): AsanaDisplayOrderService {
  if (typeof transport?.withPriority !== "function") {
    throw new TypeError("表示順同期のAsana通信が必要です。");
  }
  return new AsanaDisplayOrderService(
    new AsanaTaskWriteClient(transport.withPriority("low")),
    notifyUnexpectedError,
    lifecycleSignal,
  );
}

/** Asanaのアクティブセクション表示順を遅延同期します。 */
export class AsanaDisplayOrderService {
  private readonly writeClient: DisplayOrderWriteClient;
  private readonly notifyUnexpectedError: AsanaDisplayOrderUnexpectedErrorNotifier;
  private readonly lifecycleSignal: AbortSignal;
  private readonly stopController = new AbortController();
  private readonly lifecycleAbortListener = (): void => {
    void this.stop().catch((error: unknown) => {
      if (!(error instanceof AsanaRequestAbortedError)) {
        this.notifyUnexpectedError(error);
      }
    });
  };
  private pending: PendingBatch | undefined;
  private running: RunningBatch | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  public constructor(
    writeClient: DisplayOrderWriteClient,
    notifyUnexpectedError: AsanaDisplayOrderUnexpectedErrorNotifier,
    lifecycleSignal: AbortSignal,
  ) {
    if (typeof writeClient?.addTaskToProject !== "function") {
      throw new TypeError("表示順同期の書き込みクライアントが必要です。");
    }
    if (typeof notifyUnexpectedError !== "function") {
      throw new TypeError("表示順同期の診断通知関数が必要です。");
    }
    validateAbortSignal(lifecycleSignal);
    this.writeClient = writeClient;
    this.notifyUnexpectedError = notifyUnexpectedError;
    this.lifecycleSignal = lifecycleSignal;
    this.stopped = lifecycleSignal.aborted;
    if (!this.stopped) {
      lifecycleSignal.addEventListener(
        "abort",
        this.lifecycleAbortListener,
        { once: true },
      );
    }
  }

  /** 表示順同期を数秒間まとめて要求します。 */
  public request(
    input: AsanaDisplayOrderInput,
    signal: AbortSignal,
  ): Promise<AsanaDisplayOrderResult> {
    validateAbortSignal(signal);
    const validatedInput = asanaDisplayOrderInputSchema.parse(input);
    if (signal.aborted || this.stopped) {
      return Promise.reject(new AsanaRequestAbortedError());
    }
    const waiting = createWaiter(signal);
    if (waiting.waiter.settled) {
      return waiting.promise;
    }
    this.enqueue(validatedInput, waiting.waiter);
    if (this.running == null && this.debounceTimer == null) {
      this.scheduleDebounceTimer();
    }
    return waiting.promise;
  }

  /** 保留中の表示順同期を直ちに実行します。 */
  public async flush(
    input: AsanaDisplayOrderInput,
    signal: AbortSignal,
  ): Promise<AsanaDisplayOrderResult> {
    validateAbortSignal(signal);
    const validatedInput = asanaDisplayOrderInputSchema.parse(input);
    if (signal.aborted || this.stopped) {
      throw new AsanaRequestAbortedError();
    }
    const waiting = createWaiter(signal);
    if (waiting.waiter.settled) {
      return waiting.promise;
    }
    this.enqueue(validatedInput, waiting.waiter);
    this.clearDebounceTimer();
    if (this.running == null) {
      await this.drain();
    }
    return waiting.promise;
  }

  /** 表示順同期を停止し保留中の処理を中断します。 */
  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearDebounceTimer();
    this.stopController.abort();
    const pending = this.pending;
    this.pending = undefined;
    if (pending != null) {
      for (const waiter of pending.waiters) {
        rejectWaiter(waiter, new AsanaRequestAbortedError());
      }
    }
    this.lifecycleSignal.removeEventListener(
      "abort",
      this.lifecycleAbortListener,
    );
    const running = this.running;
    if (running != null) {
      try {
        await running.promise;
      } catch (error: unknown) {
        if (!(error instanceof AsanaRequestAbortedError)) {
          throw error;
        }
      }
    }
  }

  private enqueue(input: AsanaDisplayOrderInput, waiter: Waiter): void {
    if (this.pending == null) {
      this.pending = { input, waiters: [waiter] };
      return;
    }
    this.pending.input = input;
    this.pending.waiters.push(waiter);
  }

  private takePendingBatch(): PendingBatch | undefined {
    const pending = this.pending;
    this.pending = undefined;
    return pending;
  }

  private scheduleDebounceTimer(): void {
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.drain().catch((error: unknown) => {
        if (!this.stopped && !(error instanceof AsanaRequestAbortedError)) {
          this.notifyUnexpectedError(error);
        }
      });
    }, debounceMilliseconds);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer == null) {
      return;
    }
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  private async drain(): Promise<void> {
    while (this.pending != null && !this.stopped) {
      const batch = this.pending;
      this.pending = undefined;
      const running = this.startRun(batch.input);
      try {
        const result = await running.promise;
        for (const waiter of batch.waiters) {
          resolveWaiter(waiter, result);
        }
      } catch (error: unknown) {
        for (const waiter of batch.waiters) {
          rejectWaiter(waiter, error);
        }
        const pending = this.takePendingBatch();
        if (pending != null) {
          for (const pendingWaiter of pending.waiters) {
            rejectWaiter(pendingWaiter, error);
          }
        }
        throw error;
      } finally {
        if (this.running === running) {
          this.running = undefined;
        }
      }
    }
  }

  private startRun(input: AsanaDisplayOrderInput): RunningBatch {
    const signal = AbortSignal.any([
      this.lifecycleSignal,
      this.stopController.signal,
    ]);
    const promise = Promise.resolve().then(() => this.execute(input, signal));
    const running: RunningBatch = { promise };
    this.running = running;
    return running;
  }

  private async execute(
    input: AsanaDisplayOrderInput,
    signal: AbortSignal,
  ): Promise<AsanaDisplayOrderResult> {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    const movedTaskGids: string[] = [];
    const sections: readonly [
      "not_started",
      "in_progress",
    ] = ["not_started", "in_progress"];
    for (const section of sections) {
      const current = input.current_order[section];
      const desired = createDesiredOrder(current, input.ranking);
      const working = [...current];
      for (const [index, gid] of desired.entries()) {
        if (working[index] === gid) {
          continue;
        }
        const currentIndex = working.indexOf(gid);
        if (currentIndex < 0) {
          throw new Error("表示順同期の対象GIDが現在順序にありません。");
        }
        const anchor = working[index];
        if (anchor == null) {
          throw new Error("表示順同期の挿入位置を確定できません。");
        }
        const position: AsanaTaskInsertionPosition = {
          kind: "before",
          task_gid: anchor,
        };
        await this.writeClient.addTaskToProject(
          gid,
          input.project_gid,
          input.section_gids[section],
          position,
          signal,
        );
        working.splice(currentIndex, 1);
        working.splice(index, 0, gid);
        movedTaskGids.push(gid);
      }
    }
    return asanaDisplayOrderResultSchema.parse({
      outcome: movedTaskGids.length === 0 ? "already_applied" : "applied",
      moved_task_gids: movedTaskGids,
    });
  }
}
