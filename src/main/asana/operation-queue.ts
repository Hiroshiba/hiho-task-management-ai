import { AsanaRequestAbortedError } from "./scheduler";

export type AsanaOperationPriority = "user" | "background";
export type AsanaOperationKind =
  | "synchronization"
  | "gui_edit"
  | "ai_apply"
  | "ai_snapshot"
  | "display_order"
  | "journal_recovery"
  | "context_change";
export type AsanaOperationInvalidationReason =
  | "synchronization_failed"
  | "offline"
  | "context_changed";

/** 待機中のAsana操作が後続処理へ引き継げないことを表します。 */
export class AsanaOperationInvalidatedError extends Error {
  public readonly reason: AsanaOperationInvalidationReason;

  public constructor(reason: AsanaOperationInvalidationReason) {
    super("Asana操作の待機中に実行条件が失われました。");
    this.name = "AsanaOperationInvalidatedError";
    this.reason = reason;
  }
}

/** 実行中のAsana操作が所有する明示的な実行コンテキストです。 */
export type AsanaOperationContext = {
  readonly kind: AsanaOperationKind;
  readonly signal: AbortSignal;
};

type OperationRunner<T> = (
  context: AsanaOperationContext,
) => T | PromiseLike<T>;
type BeforeOperation = (context: AsanaOperationContext) => void | PromiseLike<void>;

type PendingOperation<T> = {
  readonly priority: AsanaOperationPriority;
  readonly kind: AsanaOperationKind;
  readonly signal: AbortSignal;
  readonly run: OperationRunner<T>;
  readonly beforeStart: BeforeOperation | undefined;
  readonly controller: AbortController;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
  readonly onAbort: () => void;
  settled: boolean;
  started: boolean;
};

export type AsanaOperationQueueInput<T> = {
  readonly priority: AsanaOperationPriority;
  readonly kind: AsanaOperationKind;
  readonly signal: AbortSignal;
  readonly run: OperationRunner<T>;
  readonly beforeStart?: BeforeOperation;
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

function validateOperationPriority(priority: AsanaOperationPriority): void {
  if (priority !== "user" && priority !== "background") {
    throw new TypeError("Asana操作の優先度が不正です。");
  }
}

function validateOperationKind(kind: AsanaOperationKind): void {
  if (
    kind !== "synchronization"
    && kind !== "gui_edit"
    && kind !== "ai_apply"
    && kind !== "ai_snapshot"
    && kind !== "display_order"
    && kind !== "journal_recovery"
    && kind !== "context_change"
  ) {
    throw new TypeError("Asana操作の種別が不正です。");
  }
}

function validateFunction(value: unknown, message: string): void {
  if (typeof value !== "function") {
    throw new TypeError(message);
  }
}

function createOperationSignal(
  lifecycleSignal: AbortSignal,
  stopSignal: AbortSignal,
  operationSignal: AbortSignal,
  callerSignal: AbortSignal,
): AbortSignal {
  return AbortSignal.any([
    lifecycleSignal,
    stopSignal,
    operationSignal,
    callerSignal,
  ]);
}

/** Asanaプロジェクト内の高水準操作を明示的に直列化します。 */
export class AsanaOperationQueue {
  private readonly lifecycleSignal: AbortSignal;
  private readonly stopController = new AbortController();
  private readonly lifecycleAbortListener = (): void => {
    void this.stop();
  };
  private readonly userQueue: PendingOperation<unknown>[] = [];
  private readonly backgroundQueue: PendingOperation<unknown>[] = [];
  private readonly owners = new WeakMap<AbortSignal, AsanaOperationContext>();
  private active: PendingOperation<unknown> | undefined;
  private activeCompletion: Promise<void> | undefined;
  private stopped: boolean;
  private pumping = false;
  private stopPromise: Promise<void> | undefined;

  public constructor(lifecycleSignal: AbortSignal) {
    validateAbortSignal(lifecycleSignal);
    this.lifecycleSignal = lifecycleSignal;
    this.stopped = lifecycleSignal.aborted;
    if (!this.stopped) {
      lifecycleSignal.addEventListener("abort", this.lifecycleAbortListener, {
        once: true,
      });
    }
  }

  /** 操作を優先度付きキューへ追加します。 */
  public enqueue<T>(input: AsanaOperationQueueInput<T>): Promise<T> {
    validateOperationPriority(input.priority);
    validateOperationKind(input.kind);
    validateAbortSignal(input.signal);
    validateFunction(input.run, "Asana操作関数が必要です。");
    if (input.beforeStart != null) {
      validateFunction(input.beforeStart, "Asana操作開始前検証関数が不正です。");
    }
    if (input.signal.aborted || this.stopped) {
      return Promise.reject(new AsanaRequestAbortedError());
    }

    let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
    let rejectPromise: ((reason: unknown) => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    if (resolvePromise == null || rejectPromise == null) {
      throw new Error("Asana操作の待機状態を初期化できません。");
    }

    const controller = new AbortController();
    const pending: PendingOperation<T> = {
      priority: input.priority,
      kind: input.kind,
      signal: input.signal,
      run: input.run,
      beforeStart: input.beforeStart,
      controller,
      resolve: resolvePromise,
      reject: rejectPromise,
      onAbort: (): void => {
        this.cancelPending(pending, new AsanaRequestAbortedError());
      },
      settled: false,
      started: false,
    };
    input.signal.addEventListener("abort", pending.onAbort, { once: true });
    if (input.signal.aborted) {
      pending.onAbort();
      return promise;
    }
    this.queueFor(pending.priority).push(pending);
    this.pump();
    return promise;
  }

  /** 実行中操作が所有するコンテキストで内部処理を実行します。 */
  public runOwned<T>(
    signal: AbortSignal,
    run: OperationRunner<T>,
  ): Promise<T> {
    validateAbortSignal(signal);
    validateFunction(run, "所有済みAsana操作関数が必要です。");
    const context = this.owners.get(signal);
    if (context == null) {
      throw new Error("Asana操作の実行権を所有していません。");
    }
    if (context.signal.aborted || signal.aborted) {
      return Promise.reject(new AsanaRequestAbortedError());
    }
    const scopedContext: AsanaOperationContext = {
      kind: context.kind,
      signal,
    };
    return Promise.resolve().then(() => run(scopedContext));
  }

  /** 指定signalが現在の操作の所有signalかを確認します。 */
  public hasOwner(signal: AbortSignal): boolean {
    validateAbortSignal(signal);
    return this.owners.has(signal);
  }

  /** 実行中操作へ中断を通知します。 */
  public abortActive(): void {
    this.active?.controller.abort();
  }

  /** 所有済み操作から派生したsignalを内部処理へ明示的に引き継ぎます。 */
  public linkOwnedSignal(
    signal: AbortSignal,
    ownerSignal: AbortSignal,
  ): () => void {
    validateAbortSignal(signal);
    validateAbortSignal(ownerSignal);
    const context = this.owners.get(ownerSignal);
    if (context == null) {
      throw new Error("Asana操作の実行権を所有していません。");
    }
    this.owners.set(signal, context);
    return (): void => {
      this.owners.delete(signal);
    };
  }

  /** 待機中の編集と表示順操作を実行条件の喪失として失効させます。 */
  public invalidatePendingMutations(
    reason: AsanaOperationInvalidationReason,
  ): void {
    const error = new AsanaOperationInvalidatedError(reason);
    const pending = [
      ...this.userQueue,
      ...this.backgroundQueue,
    ];
    for (const operation of pending) {
      if (
        operation.kind !== "gui_edit"
        && operation.kind !== "ai_apply"
        && operation.kind !== "ai_snapshot"
        && operation.kind !== "display_order"
      ) {
        continue;
      }
      this.cancelPending(operation, error);
    }
    this.pump();
  }

  /** キューを停止し、待機中と実行中の操作を中断します。 */
  public stop(): Promise<void> {
    const runningStop = this.stopPromise;
    if (runningStop != null) {
      return runningStop;
    }
    this.stopped = true;
    this.stopController.abort();
    const pending = [
      ...this.userQueue,
      ...this.backgroundQueue,
    ];
    for (const operation of pending) {
      this.cancelPending(operation, new AsanaRequestAbortedError());
    }
    this.lifecycleSignal.removeEventListener(
      "abort",
      this.lifecycleAbortListener,
    );
    const active = this.active;
    const activeCompletion = this.activeCompletion;
    const wait = active == null || activeCompletion == null
      ? Promise.resolve()
      : activeCompletion;
    this.stopPromise = wait;
    return wait;
  }

  private queueFor(
    priority: AsanaOperationPriority,
  ): PendingOperation<unknown>[] {
    return priority === "user" ? this.userQueue : this.backgroundQueue;
  }

  private cancelPending(
    operation: PendingOperation<unknown>,
    error: unknown,
  ): void {
    if (operation.started || operation.settled) {
      return;
    }
    operation.settled = true;
    operation.signal.removeEventListener("abort", operation.onAbort);
    operation.reject(error);
  }

  private takeNext(): PendingOperation<unknown> | undefined {
    while (this.userQueue.length > 0) {
      const operation = this.userQueue.shift();
      if (operation == null) {
        throw new Error("Asana操作キューの先頭を取得できません。");
      }
      if (!operation.settled) {
        return operation;
      }
    }
    while (this.backgroundQueue.length > 0) {
      const operation = this.backgroundQueue.shift();
      if (operation == null) {
        throw new Error("Asana操作キューの先頭を取得できません。");
      }
      if (!operation.settled) {
        return operation;
      }
    }
    return undefined;
  }

  private pump(): void {
    if (this.pumping || this.active != null || this.stopped) {
      return;
    }
    this.pumping = true;
    const operation = this.takeNext();
    if (operation == null) {
      this.pumping = false;
      return;
    }
    operation.started = true;
    operation.signal.removeEventListener("abort", operation.onAbort);
    this.active = operation;
    const context: AsanaOperationContext = {
      kind: operation.kind,
      signal: createOperationSignal(
        this.lifecycleSignal,
        this.stopController.signal,
        operation.controller.signal,
        operation.signal,
      ),
    };
    this.owners.set(context.signal, context);
    let resolveCompletion: (() => void) | undefined;
    this.activeCompletion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    if (resolveCompletion == null) {
      throw new Error("Asana操作の完了待機状態を初期化できません。");
    }
    const complete = resolveCompletion;
    this.pumping = false;
    void this.execute(operation, context).then(
      () => complete(),
      (error: unknown) => {
        complete();
        if (!operation.settled) {
          operation.settled = true;
          operation.reject(error);
          return;
        }
        queueMicrotask(() => {
          throw error;
        });
      },
    );
  }

  private async execute(
    operation: PendingOperation<unknown>,
    context: AsanaOperationContext,
  ): Promise<void> {
    try {
      if (context.signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      if (operation.beforeStart != null) {
        await operation.beforeStart(context);
      }
      if (context.signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      const value = await operation.run(context);
      if (!operation.settled) {
        operation.settled = true;
        operation.resolve(value);
      }
    } catch (error: unknown) {
      if (!operation.settled) {
        operation.settled = true;
        operation.reject(error);
      }
    }
    this.owners.delete(context.signal);
    if (this.active !== operation) {
      throw new Error("Asana操作キューの実行状態が一致しません。");
    }
    this.active = undefined;
    this.activeCompletion = undefined;
    this.pump();
  }
}
