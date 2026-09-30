import { AsanaRequestAbortedError } from "./request-aborted-error";

const responseBodyReadTimeoutMilliseconds = 5_000;
const maximumResponseBodyBytes = 64 * 1_024;
const responseBodyCancellationTimeoutMilliseconds = 100;

type ResponseBodyReadResult =
  | { readonly kind: "read"; readonly bytes: Uint8Array }
  | { readonly kind: "unavailable" | "timeout" | "too_large" };

type ResponseBodyChunkResult =
  | { readonly kind: "read"; readonly value: ReadableStreamReadResult<Uint8Array> }
  | { readonly kind: "aborted" | "unavailable" | "timeout" };

type ResponseBodyCancellationResult = "cancelled" | "failed" | "timed_out";

async function readResponseBodyChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<ResponseBodyChunkResult> {
  if (signal.aborted) {
    return { kind: "aborted" };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<ResponseBodyChunkResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve({ kind: "timeout" });
    }, timeoutMilliseconds);
  });
  const abortPromise = new Promise<ResponseBodyChunkResult>((resolve) => {
    onAbort = () => {
      resolve({ kind: "aborted" });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => reader.read()).then(
        (value): ResponseBodyChunkResult => ({ kind: "read", value }),
        (): ResponseBodyChunkResult => ({ kind: "unavailable" }),
      ),
      timeoutPromise,
      abortPromise,
    ]);
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
    if (onAbort != null) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function cancelResponseBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ResponseBodyCancellationResult> {
  let cancellation: Promise<ResponseBodyCancellationResult>;
  try {
    cancellation = reader.cancel().then(
      () => "cancelled" as const,
      () => "failed" as const,
    );
  } catch {
    return "failed";
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<ResponseBodyCancellationResult>((resolve) => {
    timeout = setTimeout(() => {
      resolve("timed_out");
    }, responseBodyCancellationTimeoutMilliseconds);
  });
  try {
    return await Promise.race([cancellation, timeoutPromise]);
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
  }
}

async function cancelAndClassifyResponseBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
  kind: Exclude<ResponseBodyReadResult, { kind: "read" }>["kind"],
): Promise<ResponseBodyReadResult> {
  const cancellation = await cancelResponseBodyReader(reader);
  if (signal.aborted) {
    throw new AsanaRequestAbortedError();
  }
  return cancellation === "cancelled"
    ? { kind }
    : { kind: "unavailable" };
}

/** Asana API応答の本文を解放します。 */
export async function releaseResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<"released" | "unavailable"> {
  if (response.body == null) {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    return "released";
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    return "unavailable";
  }
  const cancellation = await cancelResponseBodyReader(reader);
  let releaseError: unknown;
  try {
    reader.releaseLock();
  } catch (error) {
    releaseError = error;
  }
  if (signal.aborted) {
    throw new AsanaRequestAbortedError();
  }
  return cancellation === "cancelled" && releaseError == null
    ? "released"
    : "unavailable";
}

async function consumeResponseBodyReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ResponseBodyReadResult> {
  let cancellationStarted = false;
  const cancelAndClassify = async (
    kind: Exclude<ResponseBodyReadResult, { kind: "read" }>["kind"],
  ): Promise<ResponseBodyReadResult> => {
    cancellationStarted = true;
    return cancelAndClassifyResponseBody(reader, signal, kind);
  };
  try {
    if (signal.aborted) {
      return await cancelAndClassify("unavailable");
    }
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const deadline = Date.now() + responseBodyReadTimeoutMilliseconds;
    while (true) {
      const remainingMilliseconds = deadline - Date.now();
      if (remainingMilliseconds <= 0) {
        return await cancelAndClassify("timeout");
      }
      const chunk = await readResponseBodyChunk(
        reader,
        signal,
        remainingMilliseconds,
      );
      if (chunk.kind === "aborted") {
        return await cancelAndClassify("unavailable");
      }
      if (chunk.kind === "timeout") {
        return await cancelAndClassify("timeout");
      }
      if (chunk.kind === "unavailable") {
        return await cancelAndClassify("unavailable");
      }
      if (chunk.kind !== "read") {
        throw new Error("Asana API応答の本文読み取り結果が不正です。");
      }
      if (chunk.value.done) {
        if (signal.aborted) {
          return await cancelAndClassify("unavailable");
        }
        return { kind: "read", bytes: Buffer.concat(chunks, totalBytes) };
      }
      if (signal.aborted) {
        return await cancelAndClassify("unavailable");
      }
      if (chunk.value.value == null) {
        return await cancelAndClassify("unavailable");
      }
      totalBytes += chunk.value.value.byteLength;
      if (totalBytes > maximumResponseBodyBytes) {
        return await cancelAndClassify("too_large");
      }
      chunks.push(chunk.value.value);
    }
  } catch (error) {
    if (!cancellationStarted) {
      cancellationStarted = true;
      await cancelResponseBodyReader(reader);
    }
    if (signal.aborted || error instanceof AsanaRequestAbortedError) {
      throw new AsanaRequestAbortedError();
    }
    return { kind: "unavailable" };
  }
}

/** Asana API応答の本文を制限内で読み取ります。 */
export async function readResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<ResponseBodyReadResult> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength != null
    && /^\d+$/u.test(contentLength)
    && BigInt(contentLength) > BigInt(maximumResponseBodyBytes)
  ) {
    const release = await releaseResponseBody(response, signal);
    return release === "released" ? { kind: "too_large" } : { kind: "unavailable" };
  }
  if (response.body == null) {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    return { kind: "unavailable" };
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    return { kind: "unavailable" };
  }
  let body: ResponseBodyReadResult | undefined;
  let readError: unknown;
  let releaseError: unknown;
  try {
    body = await consumeResponseBodyReader(reader, signal);
  } catch (error) {
    readError = error;
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      releaseError = error;
    }
  }
  if (signal.aborted || readError instanceof AsanaRequestAbortedError) {
    throw new AsanaRequestAbortedError();
  }
  if (releaseError != null || readError != null || body == null) {
    return { kind: "unavailable" };
  }
  return body;
}
