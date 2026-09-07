type StartupGateState =
  | { readonly kind: "starting" }
  | { readonly kind: "ready" }
  | { readonly kind: "failed"; readonly error: unknown }
  | { readonly kind: "stopped" };

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolveValue: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  if (resolveValue == null) {
    throw new Error("起動状態の完了処理を初期化できません。");
  }
  return { promise, resolve: resolveValue };
}

/** 起動状態をIPC処理と共有するゲートです。 */
export interface StartupGate {
  isReady(): boolean;
  assertReady(): void;
  waitForStartup(signal: AbortSignal): Promise<void>;
  markReady(): void;
  markFailed(error: unknown): void;
  markStopped(): void;
}

/** 起動前に機能操作を拒否したことを表します。 */
export class StartupGateNotReadyError extends Error {
  public constructor() {
    super("アプリケーションの起動が完了していません。起動処理を待ってください。");
    this.name = "StartupGateNotReadyError";
  }
}

/** 起動処理が失敗したことを表します。 */
export class StartupGateFailedError extends Error {
  public constructor(cause: unknown) {
    super("アプリケーションの起動に失敗しました。", { cause });
    this.name = "StartupGateFailedError";
  }
}

/** 停止済みのアプリケーションへ操作したことを表します。 */
export class StartupGateStoppedError extends Error {
  public constructor() {
    super("アプリケーションは停止済みです。");
    this.name = "StartupGateStoppedError";
  }
}

/** 起動待機が終了処理で中断されたことを表します。 */
export class StartupGateAbortedError extends Error {
  public constructor() {
    super("アプリケーションの起動待機が中断されました。");
    this.name = "StartupGateAbortedError";
  }
}

function waitForCompletion(
  completion: Promise<StartupGateState>,
  signal: AbortSignal,
): Promise<StartupGateState> {
  if (signal.aborted) {
    return Promise.reject(new StartupGateAbortedError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new StartupGateAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void completion.then((state) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(state);
    });
    if (signal.aborted) {
      onAbort();
    }
  });
}

/** 起動状態を管理するゲートを作成します。 */
export function createStartupGate(): StartupGate {
  let state: StartupGateState = { kind: "starting" };
  const completion = createDeferred<StartupGateState>();

  const settleStartingState = (
    nextState: Exclude<StartupGateState, { readonly kind: "starting" }>,
  ): void => {
    if (state.kind !== "starting") {
      throw new Error("起動状態は一度だけ確定できます。");
    }
    state = nextState;
    completion.resolve(nextState);
  };

  const assertReady = (): void => {
    switch (state.kind) {
      case "starting":
        throw new StartupGateNotReadyError();
      case "ready":
        return;
      case "failed":
        throw new StartupGateFailedError(state.error);
      case "stopped":
        throw new StartupGateStoppedError();
    }
  };

  const isReady = (): boolean => state.kind === "ready";

  const waitForStartup = async (signal: AbortSignal): Promise<void> => {
    let settledState = state;
    if (settledState.kind === "starting") {
      settledState = await waitForCompletion(completion.promise, signal);
    }
    switch (settledState.kind) {
      case "ready":
        return;
      case "failed":
        throw new StartupGateFailedError(settledState.error);
      case "stopped":
        throw new StartupGateStoppedError();
      case "starting":
        throw new Error("起動状態が確定していません。");
    }
  };

  const markReady = (): void => {
    settleStartingState({ kind: "ready" });
  };

  const markFailed = (error: unknown): void => {
    settleStartingState({ kind: "failed", error });
  };

  const markStopped = (): void => {
    if (state.kind === "stopped") {
      return;
    }
    if (state.kind === "starting") {
      settleStartingState({ kind: "stopped" });
      return;
    }
    state = { kind: "stopped" };
  };

  return {
    isReady,
    assertReady,
    waitForStartup,
    markReady,
    markFailed,
    markStopped,
  };
}
