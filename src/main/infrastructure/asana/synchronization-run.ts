export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

/** 同期実行の結果待機状態を作成します。 */
export function createDeferred<T>(): Deferred<T> {
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

/** 同期要求の中断信号を検証します。 */
export function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

/** 同時に要求された同期モードを統合します。 */
export function mergeRequestedModes(
  first: "full" | "delta" | undefined,
  second: "full" | "delta" | undefined,
): "full" | "delta" | undefined {
  if (first === "full" || second === "full") {
    return "full";
  }
  if (first === "delta" || second === "delta") {
    return "delta";
  }
  return undefined;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("同期中にエラーが発生しました。", { cause: error });
}

/** 同期要求の中断信号を統合します。 */
export function createCombinedSignal(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

/** 同期結果を呼び出し元の中断信号とともに待機します。 */
export function waitForCaller<T>(
  running: Promise<T>,
  signal: AbortSignal,
  createAbortResult: () => T,
): Promise<T> {
  validateAbortSignal(signal);
  if (signal.aborted) {
    return Promise.resolve(createAbortResult());
  }
  return new Promise<T>((resolve, reject) => {
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
