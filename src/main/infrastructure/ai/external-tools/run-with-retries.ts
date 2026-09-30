type RetryableError = Error & { readonly retryable: boolean };

type RunWithRetries<Tool, Invocation, CredentialProvider, Output> = (
  tool: Tool,
  invocation: Invocation,
  credentialProvider: CredentialProvider,
  signal: AbortSignal,
) => Promise<Output>;

/** 外部ツールの再試行可能な実行失敗だけを再送します。 */
export function createExternalToolRunWithRetries<Tool, Invocation, CredentialProvider, Output>(
  errorType: new (code: never, message: string, retryable: boolean, cause?: unknown) => RetryableError,
  execute: RunWithRetries<Tool, Invocation, CredentialProvider, Output>,
  throwIfAborted: (signal: AbortSignal) => void,
  createAbortError: (signal: AbortSignal) => Error,
  maximumRetries: number,
  retryDelayMilliseconds: number,
): RunWithRetries<Tool, Invocation, CredentialProvider, Output> {
  function waitForRetry(retryCount: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }, retryDelayMilliseconds * retryCount);
      const onAbort = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        rejectPromise(createAbortError(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  return async (tool, invocation, credentialProvider, signal): Promise<Output> => {
    let retryCount = 0;
    while (true) {
      throwIfAborted(signal);
      try {
        return await execute(tool, invocation, credentialProvider, signal);
      } catch (error) {
        if (!(error instanceof errorType && error.retryable) || retryCount >= maximumRetries) {
          throw error;
        }
        retryCount += 1;
        await waitForRetry(retryCount, signal);
      }
    }
  };
}
