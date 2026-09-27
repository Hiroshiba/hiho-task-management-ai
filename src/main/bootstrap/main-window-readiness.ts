import type { BrowserWindow } from "electron";

/** メインウィンドウの表示完了と待機拒否をまとめます。 */
export interface MainWindowReadyWait {
  readonly promise: Promise<void>;
  readonly reject: (error: unknown) => void;
}

/** メインウィンドウが表示可能になるまで待機します。 */
export function createMainWindowReadyWait(
  window: BrowserWindow,
  signal: AbortSignal,
  showAndFocus: () => boolean,
): MainWindowReadyWait {
  let settled = false;
  let resolvePromise: ((value?: void | PromiseLike<void>) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;

  function cleanup(): void {
    window.removeListener("ready-to-show", onReadyToShow);
    window.removeListener("closed", onClosed);
    signal.removeEventListener("abort", onAbort);
  }

  function rejectReady(error: unknown): void {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (rejectPromise == null) {
      throw new Error("メインウィンドウの表示待機を初期化できません。");
    }
    rejectPromise(error);
  }

  function resolveReady(): void {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    if (resolvePromise == null) {
      throw new Error("メインウィンドウの表示待機を初期化できません。");
    }
    resolvePromise();
  }

  function onReadyToShow(): void {
    try {
      if (window.isDestroyed()) {
        rejectReady(new Error("メインウィンドウが破棄されました。"));
        return;
      }
      if (!showAndFocus()) {
        rejectReady(new Error("メインウィンドウを表示できません。"));
        return;
      }
    } catch (error) {
      rejectReady(error);
      return;
    }
    resolveReady();
  }

  function onClosed(): void {
    rejectReady(new Error("メインウィンドウが閉じられました。"));
  }

  function onAbort(): void {
    rejectReady(new Error("メインウィンドウの表示待機が中断されました。"));
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }

  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  window.once("ready-to-show", onReadyToShow);
  window.once("closed", onClosed);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  return { promise, reject: rejectReady };
}
