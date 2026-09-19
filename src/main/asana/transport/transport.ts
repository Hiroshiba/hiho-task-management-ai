import { z } from "zod";
import {
  isJsonValue,
  type JsonValue,
} from "../../../shared/domain";
import {
  AsanaRequestAbortedError,
  AsanaRequestScheduler,
  type AsanaRequestKind,
  type AsanaRequestPriority,
  type AsanaRequestPriorityScope,
} from "../scheduler";
import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransportError,
  type AsanaHttpErrorResponse,
  safeParseAsanaHttpErrorResponse,
} from "./errors";
import { asanaSyncTokenSchema } from "../sync-token";
import type {
  AsanaRequest,
  AsanaTransportRequestPort,
  TokenProvider,
} from "./types";

const asanaBaseUrl = "https://app.asana.com/api/1.0/";
const fetchTimeoutMilliseconds = 30_000;
const responseBodyReadTimeoutMilliseconds = 5_000;
const maximumResponseBodyBytes = 64 * 1_024;
const responseBodyCancellationTimeoutMilliseconds = 100;
const maximumTemporaryRetries = 3;
const retryBackoffMilliseconds: readonly [number, number, number] = [
  500,
  1_000,
  2_000,
];
const httpDatePattern = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"]+"|[^;\s]+))?\s*$/i;
const eventsResetResponseSchema = z
  .object({
    sync: asanaSyncTokenSchema,
  })
  .strip();

type RequestPathAndQuery = {
  readonly path: readonly string[];
  readonly query?: Readonly<Record<string, string | readonly string[]>>;
};

type RefreshState = {
  readonly sourceToken: string;
  readonly promise: Promise<string>;
};

function assertValidPath(path: readonly string[]): void {
  if (path.length === 0) {
    throw new Error("Asana APIのpathが空です。");
  }
  for (const segment of path) {
    if (
      typeof segment !== "string"
      || segment.length === 0
      || /[\\/\s]/u.test(segment)
      || hasControlCharacter(segment)
    ) {
      throw new Error("Asana APIのpath segmentが不正です。");
    }
  }
}

function assertValidQueryKey(key: string): void {
  if (key.length === 0 || /\s/u.test(key) || hasControlCharacter(key)) {
    throw new Error("Asana APIのquery keyが不正です。");
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint == null) {
      throw new Error("Asana APIのpath segmentを検証できません。");
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function buildUrl(request: RequestPathAndQuery): string {
  assertValidPath(request.path);
  const path = request.path.map((segment) => encodeURIComponent(segment)).join("/");
  const url = `${asanaBaseUrl}${path}`;
  if (request.query == null) {
    return url;
  }
  if (typeof request.query !== "object" || Array.isArray(request.query)) {
    throw new Error("Asana APIのqueryがオブジェクトではありません。");
  }

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(request.query)) {
    assertValidQueryKey(key);
    if (typeof value === "string") {
      searchParams.append(key, value);
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error("Asana APIのquery値が不正です。");
    }
    for (const item of value) {
      if (typeof item !== "string") {
        throw new Error("Asana APIのquery配列値が不正です。");
      }
      searchParams.append(key, item);
    }
  }
  const serializedQuery = searchParams.toString();
  if (serializedQuery.length === 0) {
    return url;
  }
  return `${url}?${serializedQuery}`;
}

function serializeBody(body: JsonValue): string {
  if (!isJsonValue(body)) {
    throw new Error("Asana APIのrequest bodyがJSON値ではありません。");
  }
  const serialized = JSON.stringify(body);
  if (serialized === undefined) {
    throw new Error("Asana APIのrequest bodyをJSON化できません。");
  }
  return serialized;
}

function isJsonContentType(contentType: string | null): boolean {
  return contentType != null && jsonContentTypePattern.test(contentType);
}

function validateAccessToken(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || /\s/u.test(value)
    || hasControlCharacter(value)
  ) {
    throw new AsanaAuthenticationError();
  }
  return value;
}

function parseRetryAfter(retryAfter: string | null): number {
  if (retryAfter == null) {
    throw new AsanaRateLimitError();
  }
  const value = retryAfter.trim();
  if (/^\d+$/u.test(value)) {
    const seconds = Number(value);
    const milliseconds = seconds * 1_000;
    if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(milliseconds)) {
      throw new AsanaRateLimitError();
    }
    return milliseconds;
  }
  if (!httpDatePattern.test(value)) {
    throw new AsanaRateLimitError();
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AsanaRateLimitError();
  }
  const delay = timestamp - Date.now();
  if (delay < 0) {
    throw new AsanaRateLimitError();
  }
  return delay;
}

function getRetryBackoff(retryCount: number): number {
  const delay = retryBackoffMilliseconds[retryCount];
  if (delay == null) {
    throw new Error("Asana APIの一時再試行回数が不正です。");
  }
  return delay;
}

function requestKind<T>(request: AsanaRequest<T>): AsanaRequestKind {
  return request.method === "GET" ? "read" : "write";
}

function isRetrySafe<T>(request: AsanaRequest<T>): boolean {
  if (request.method === "GET") {
    return true;
  }
  return request.retry_safe;
}

function requestBody<T>(request: AsanaRequest<T>): string | undefined {
  if (request.method === "GET") {
    return undefined;
  }
  return serializeBody(request.body);
}

function isEventsRequest<T>(request: AsanaRequest<T>): boolean {
  if (
    request.method !== "GET"
    || request.path.length !== 1
    || request.path[0] !== "events"
  ) {
    return false;
  }
  if (request.query == null) {
    return false;
  }
  return typeof request.query.resource === "string";
}

function validateRequest<T>(request: AsanaRequest<T>): void {
  if (
    request.response_schema == null
    || typeof request.response_schema.parse !== "function"
  ) {
    throw new Error("Asana APIのresponse_schemaが不正です。");
  }
  if (
    request.method !== "GET"
    && request.method !== "POST"
    && request.method !== "PUT"
  ) {
    throw new Error("Asana APIのmethodが不正です。");
  }
  if (!Array.isArray(request.path)) {
    throw new Error("Asana APIのpathが配列ではありません。");
  }
  assertValidPath(request.path);
  if (request.method === "POST" || request.method === "PUT") {
    if (!isJsonValue(request.body)) {
      throw new Error("Asana APIのrequest bodyがJSON値ではありません。");
    }
  }
  if (request.method !== "GET" && typeof request.retry_safe !== "boolean") {
    throw new Error("Asana APIの書き込み要求にretry_safeがありません。");
  }
}

type ResponseBodyReadResult =
  | { readonly kind: "read"; readonly bytes: Uint8Array }
  | { readonly kind: "unavailable" | "timeout" | "too_large" };

type ResponseBodyChunkResult =
  | { readonly kind: "read"; readonly value: ReadableStreamReadResult<Uint8Array> }
  | { readonly kind: "aborted" | "unavailable" | "timeout" };

type ResponseBodyCancellationResult = "cancelled" | "failed" | "timed_out";

type NonSuccessfulResponseResult =
  | { readonly kind: "events_reset"; readonly syncToken: string }
  | { readonly kind: "refresh_authentication" }
  | { readonly kind: "retry"; readonly delay: number }
  | { readonly kind: "throw"; readonly error: Error };

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

async function releaseResponseBody(
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

async function readResponseBody(
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

/** Asana APIのレスポンスをスケジュールして取得します。 */
export class AsanaTransport {
  private readonly scheduler: AsanaRequestScheduler;
  private readonly tokenProvider: TokenProvider;
  private refreshState: RefreshState | undefined;
  private lastRefreshSourceToken: string | undefined;
  private lastRefreshToken: string | undefined;

  public constructor(
    scheduler: AsanaRequestScheduler,
    tokenProvider: TokenProvider,
  ) {
    this.scheduler = scheduler;
    this.tokenProvider = tokenProvider;
  }

  /** Asana APIリクエストを実行します。 */
  public async request<T>(
    request: AsanaRequest<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return this.requestAtPriority(
      request,
      signal,
      this.scheduler.withPriority("normal"),
    );
  }

  /** 指定優先度でAsana APIリクエストを実行する範囲を作成します。 */
  public withPriority(
    priority: AsanaRequestPriority,
  ): AsanaTransportRequestPort {
    const priorityScope = this.scheduler.withPriority(priority);
    return {
      request: <T>(
        request: AsanaRequest<T>,
        signal: AbortSignal,
      ): Promise<T> => this.requestAtPriority(request, signal, priorityScope),
    };
  }

  private async requestAtPriority<T>(
    request: AsanaRequest<T>,
    signal: AbortSignal,
    priorityScope: AsanaRequestPriorityScope,
  ): Promise<T> {
    validateRequest(request);
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }

    const url = buildUrl(request);
    const body = requestBody(request);
    const retrySafe = isRetrySafe(request);
    let temporaryRetryCount = 0;
    let authenticationRetried = false;
    let refreshedToken: string | undefined;

    while (true) {
      const accessToken = refreshedToken ?? await this.getAccessToken();
      refreshedToken = undefined;
      let response: Response;
      try {
        response = await this.executeAttempt(
          request,
          url,
          body,
          accessToken,
          signal,
          priorityScope,
        );
      } catch (error) {
        if (!(error instanceof AsanaTransportError)) {
          throw error;
        }
        if (!retrySafe || temporaryRetryCount >= maximumTemporaryRetries) {
          throw error;
        }
        await this.waitForRetry(
          getRetryBackoff(temporaryRetryCount),
          signal,
        );
        temporaryRetryCount += 1;
        continue;
      }

      if (!response.ok) {
        const result = await this.consumeNonSuccessfulResponse(
          response,
          request,
          signal,
          authenticationRetried,
          retrySafe,
          temporaryRetryCount,
        );
        if (signal.aborted) {
          throw new AsanaRequestAbortedError();
        }
        switch (result.kind) {
          case "events_reset":
            throw new AsanaEventsResetError(result.syncToken);
          case "refresh_authentication":
            refreshedToken = await this.refreshAfterUnauthorized(accessToken, signal);
            authenticationRetried = true;
            continue;
          case "retry":
            await this.waitForRetry(result.delay, signal);
            temporaryRetryCount += 1;
            continue;
          case "throw":
            throw result.error;
        }
      }
      return this.parseSuccessfulResponse(response, request.response_schema, signal);
    }
  }

  private async consumeNonSuccessfulResponse<T>(
    response: Response,
    request: AsanaRequest<T>,
    signal: AbortSignal,
    authenticationRetried: boolean,
    retrySafe: boolean,
    temporaryRetryCount: number,
  ): Promise<NonSuccessfulResponseResult> {
    if (response.status === 412 && isEventsRequest(request)) {
      try {
        return {
          kind: "events_reset",
          syncToken: await this.parseEventsResetResponse(response, signal),
        };
      } catch (error) {
        if (error instanceof AsanaRequestAbortedError) {
          throw error;
        }
        return {
          kind: "throw",
          error: error instanceof AsanaResponseError
            ? error
            : new AsanaResponseError(error),
        };
      }
    }
    if (response.status === 401) {
      const httpError = await this.createHttpError(response, signal);
      return authenticationRetried
        ? { kind: "throw", error: new AsanaAuthenticationError(httpError) }
        : { kind: "refresh_authentication" };
    }
    if (response.status === 402) {
      return {
        kind: "throw",
        error: new AsanaPaymentRequiredError(
          await this.createHttpError(response, signal),
        ),
      };
    }
    if (response.status === 429) {
      if (!retrySafe) {
        return {
          kind: "throw",
          error: new AsanaRateLimitError(
            await this.createHttpError(response, signal),
          ),
        };
      }
      let delay: number | undefined;
      let retryAfterError: AsanaRateLimitError | undefined;
      try {
        delay = parseRetryAfter(response.headers.get("retry-after"));
      } catch (error) {
        if (!(error instanceof AsanaRateLimitError)) {
          throw error;
        }
        retryAfterError = error;
      }
      const httpError = await this.createHttpError(response, signal);
      if (retryAfterError != null) {
        return {
          kind: "throw",
          error: new AsanaRateLimitError(
            new AggregateError(
              [httpError, retryAfterError],
              "Asana APIのRetry-AfterとHTTP応答を記録しました。",
            ),
          ),
        };
      }
      if (delay == null) {
        throw new Error("Asana APIの再試行待機時間がありません。");
      }
      if (temporaryRetryCount >= maximumTemporaryRetries) {
        return {
          kind: "throw",
          error: new AsanaRateLimitError(httpError),
        };
      }
      return { kind: "retry", delay };
    }
    if (response.status >= 500 && response.status <= 599 && retrySafe) {
      const httpError = await this.createHttpError(response, signal);
      if (temporaryRetryCount >= maximumTemporaryRetries) {
        return { kind: "throw", error: httpError };
      }
      return {
        kind: "retry",
        delay: getRetryBackoff(temporaryRetryCount),
      };
    }
    return {
      kind: "throw",
      error: await this.createHttpError(response, signal),
    };
  }

  private executeAttempt<T>(
    request: AsanaRequest<T>,
    url: string,
    body: string | undefined,
    accessToken: string,
    signal: AbortSignal,
    priorityScope: AsanaRequestPriorityScope,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    };
    if (request.method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const init: RequestInit = {
      method: request.method,
      headers,
    };
    if (body != null) {
      init.body = body;
    }
    return priorityScope.schedule(
      requestKind(request),
      signal,
      () => this.fetchWithTimeout(url, init, signal),
    );
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Response> {
    const timeoutController = new AbortController();
    const combinedSignal = AbortSignal.any([
      signal,
      timeoutController.signal,
    ]);
    const timeout = setTimeout(() => {
      timeoutController.abort();
    }, fetchTimeoutMilliseconds);
    try {
      return await fetch(url, {
        ...init,
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      throw new AsanaTransportError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async refreshAfterUnauthorized(
    usedToken: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    const pendingRefresh = this.refreshState;
    if (pendingRefresh != null && pendingRefresh.sourceToken === usedToken) {
      const token = await pendingRefresh.promise;
      if (signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      return token;
    }
    if (pendingRefresh != null) {
      await pendingRefresh.promise;
      if (signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      const currentToken = await this.getAccessToken();
      if (signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      if (currentToken !== usedToken) {
        return currentToken;
      }
    }
    if (
      this.lastRefreshSourceToken === usedToken
      && this.lastRefreshToken != null
    ) {
      if (signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      return this.lastRefreshToken;
    }

    const currentToken = await this.getAccessToken();
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    if (currentToken !== usedToken) {
      return currentToken;
    }

    const refreshOperation = (async (): Promise<string> => {
      return this.tokenProvider.refreshAccessToken();
    })();
    const refreshPromise = refreshOperation.then((token) => {
      const validatedToken = validateAccessToken(token);
      this.lastRefreshSourceToken = usedToken;
      this.lastRefreshToken = validatedToken;
      return validatedToken;
    });
    const refreshState: RefreshState = {
      sourceToken: usedToken,
      promise: refreshPromise,
    };
    this.refreshState = refreshState;
    try {
      const token = await refreshPromise;
      if (signal.aborted) {
        throw new AsanaRequestAbortedError();
      }
      return token;
    } finally {
      if (this.refreshState === refreshState) {
        this.refreshState = undefined;
      }
    }
  }

  private async getAccessToken(): Promise<string> {
    const token = await this.tokenProvider.getAccessToken();
    return validateAccessToken(token);
  }

  private async waitForRetry(
    delay: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new AsanaRequestAbortedError();
    }
    await new Promise<void>((resolve, reject) => {
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

  private requestId(response: Response): string | undefined {
    const requestId = response.headers.get("x-request-id");
    if (requestId != null && requestId.length > 0) {
      return requestId;
    }
    const asanaRequestId = response.headers.get("x-asana-request-id");
    return asanaRequestId == null || asanaRequestId.length === 0
      ? undefined
      : asanaRequestId;
  }

  private async createHttpError(
    response: Response,
    signal: AbortSignal,
  ): Promise<AsanaHttpError> {
    return new AsanaHttpError(
      response.status,
      this.requestId(response),
      await this.parseHttpErrorResponse(response, signal),
      "rest",
    );
  }

  private async parseHttpErrorResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<AsanaHttpErrorResponse> {
    if (!isJsonContentType(response.headers.get("content-type"))) {
      const release = await releaseResponseBody(response, signal);
      return {
        response_body_kind: release === "released" ? "non_json" : "unavailable",
      };
    }

    const body = await readResponseBody(response, signal);
    if (body.kind !== "read") {
      return { response_body_kind: body.kind };
    }

    let payload: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
      payload = JSON.parse(text);
    } catch {
      return { response_body_kind: "invalid_json" };
    }

    const parsed = safeParseAsanaHttpErrorResponse(payload);
    if (parsed == null) {
      return { response_body_kind: "invalid_shape" };
    }
    return {
      response_body_kind: "parsed",
      ...parsed,
    };
  }

  private async parseEventsResetResponse(
    response: Response,
    signal: AbortSignal,
  ): Promise<string> {
    if (!isJsonContentType(response.headers.get("content-type"))) {
      const release = await releaseResponseBody(response, signal);
      throw new AsanaResponseError(
        new Error(
          release === "released"
            ? "Asana Events APIのContent-Typeがapplication/jsonではありません。"
            : "Asana Events APIの応答本文を解放できません。",
        ),
      );
    }

    const body = await readResponseBody(response, signal);
    if (body.kind !== "read") {
      throw new AsanaResponseError(
        new Error(`Asana Events APIの応答本文を取得できません。分類: ${body.kind}`),
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(body.bytes),
      );
    } catch {
      throw new AsanaResponseError(
        new Error("Asana Events APIの応答本文をJSONとして解釈できません。"),
      );
    }
    try {
      const parsed = eventsResetResponseSchema.parse(payload);
      return parsed.sync;
    } catch (error) {
      throw new AsanaResponseError(error);
    }
  }

  private async parseSuccessfulResponse<T>(
    response: Response,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (response.status === 204) {
      try {
        return schema.parse(undefined);
      } catch (error) {
        throw new AsanaResponseError(error);
      }
    }
    if (!isJsonContentType(response.headers.get("content-type"))) {
      const release = await releaseResponseBody(response, signal);
      throw new AsanaResponseError(
        new Error(
          release === "released"
            ? "Asana APIのContent-Typeがapplication/jsonではありません。"
            : "Asana APIの応答本文を解放できません。",
        ),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AsanaResponseError(error);
    }
    try {
      return schema.parse(payload);
    } catch (error) {
      throw new AsanaResponseError(error);
    }
  }
}
