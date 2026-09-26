import type { Server } from "node:net";

/** 外部ツールIPCサーバーの開始、中断、停止の通知を合流します。 */
export function listenExternalToolServer(
  server: Server,
  endpoint: string,
  stopSignal: AbortSignal,
  createStoppedError: () => Error,
  errorCode: (error: unknown) => string | undefined,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const removeListeners = (): void => {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      stopSignal.removeEventListener("abort", onAbort);
    };
    const rejectStopped = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeListeners();
      rejectPromise(createStoppedError());
    };
    const onError = (error: Error): void => {
      if (stopSignal.aborted) {
        rejectStopped();
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      removeListeners();
      rejectPromise(error);
    };
    const onListening = (): void => {
      if (stopSignal.aborted) {
        onAbort();
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      removeListeners();
      resolvePromise();
    };
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      const onClosed = (error?: Error): void => {
        if (error != null && errorCode(error) !== "ERR_SERVER_NOT_RUNNING") {
          if (settled) {
            return;
          }
          settled = true;
          removeListeners();
          rejectPromise(error);
          return;
        }
        rejectStopped();
      };
      try {
        server.close(onClosed);
      } catch (error) {
        if (settled) {
          return;
        }
        settled = true;
        removeListeners();
        rejectPromise(error instanceof Error
          ? error
          : new Error("外部ツールIPCサーバーの停止に失敗しました。", { cause: error }));
      }
    };
    server.once("error", onError);
    server.once("listening", onListening);
    stopSignal.addEventListener("abort", onAbort, { once: true });
    try {
      server.listen({
        path: endpoint,
        readableAll: false,
        writableAll: false,
      });
    } catch (error) {
      if (stopSignal.aborted) {
        rejectStopped();
        return;
      }
      if (settled) {
        return;
      }
      settled = true;
      removeListeners();
      rejectPromise(error instanceof Error
        ? error
        : new Error("外部ツールIPCサーバーの起動に失敗しました。", { cause: error }));
      return;
    }
    if (stopSignal.aborted) {
      onAbort();
    }
  });
}
