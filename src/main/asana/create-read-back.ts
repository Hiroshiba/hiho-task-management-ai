import { AsanaRequestAbortedError } from "./scheduler";

export const createReadBackDelaysMilliseconds: readonly [number, number, number] = [
  500,
  1_000,
  2_000,
];

/** 新規作成タスクの読み戻しを待機します。 */
export function waitForCreateReadBack(
  delay: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new AsanaRequestAbortedError());
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new AsanaRequestAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}
