import { z } from "zod";
import {
  isJsonValue,
  type JsonValue,
} from "../../../shared/domain";
import {
  AsanaRequestAbortedError,
  AsanaRequestScheduler,
  type AsanaRequestKind,
} from "../scheduler";
import {
  AsanaAuthenticationError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransportError,
} from "./errors";
import type {
  AsanaRequest,
  TokenProvider,
} from "./types";

const asanaBaseUrl = "https://app.asana.com/api/1.0/";
const fetchTimeoutMilliseconds = 30_000;
const maximumTemporaryRetries = 3;
const retryBackoffMilliseconds: readonly [number, number, number] = [
  500,
  1_000,
  2_000,
];
const httpDatePattern = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset\s*=\s*(?:"[^"]+"|[^;\s]+))?\s*$/i;

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
  if (request.method === "POST") {
    return false;
  }
  return request.retry_safe;
}

function requestBody<T>(request: AsanaRequest<T>): string | undefined {
  if (request.method === "GET") {
    return undefined;
  }
  return serializeBody(request.body);
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
  if (request.method === "PUT" && typeof request.retry_safe !== "boolean") {
    throw new Error("Asana APIのPUTにretry_safeがありません。");
  }
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

      if (response.status === 401) {
        if (authenticationRetried) {
          throw new AsanaAuthenticationError();
        }
        refreshedToken = await this.refreshAfterUnauthorized(accessToken);
        authenticationRetried = true;
        continue;
      }
      if (response.status === 402) {
        throw new AsanaPaymentRequiredError();
      }
      if (response.status === 429) {
        const delay = parseRetryAfter(response.headers.get("retry-after"));
        if (temporaryRetryCount >= maximumTemporaryRetries) {
          throw new AsanaRateLimitError();
        }
        await this.waitForRetry(delay, signal);
        temporaryRetryCount += 1;
        continue;
      }
      if (response.status >= 500 && response.status <= 599 && retrySafe) {
        if (temporaryRetryCount >= maximumTemporaryRetries) {
          throw new AsanaHttpError(
            response.status,
            this.requestId(response),
          );
        }
        await this.waitForRetry(
          getRetryBackoff(temporaryRetryCount),
          signal,
        );
        temporaryRetryCount += 1;
        continue;
      }
      if (!response.ok) {
        throw new AsanaHttpError(
          response.status,
          this.requestId(response),
        );
      }
      return this.parseSuccessfulResponse(response, request.response_schema);
    }
  }

  private executeAttempt<T>(
    request: AsanaRequest<T>,
    url: string,
    body: string | undefined,
    accessToken: string,
    signal: AbortSignal,
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
    return this.scheduler.schedule(
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

  private async refreshAfterUnauthorized(usedToken: string): Promise<string> {
    const pendingRefresh = this.refreshState;
    if (pendingRefresh != null && pendingRefresh.sourceToken === usedToken) {
      return pendingRefresh.promise;
    }
    if (pendingRefresh != null) {
      await pendingRefresh.promise;
      const currentToken = await this.getAccessToken();
      if (currentToken !== usedToken) {
        return currentToken;
      }
    }
    if (
      this.lastRefreshSourceToken === usedToken
      && this.lastRefreshToken != null
    ) {
      return this.lastRefreshToken;
    }

    const currentToken = await this.getAccessToken();
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
      return await refreshPromise;
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
    return response.headers.get("x-request-id")
      ?? response.headers.get("x-asana-request-id")
      ?? undefined;
  }

  private async parseSuccessfulResponse<T>(
    response: Response,
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (response.status === 204) {
      try {
        return schema.parse(undefined);
      } catch (error) {
        throw new AsanaResponseError(error);
      }
    }
    if (!isJsonContentType(response.headers.get("content-type"))) {
      throw new AsanaResponseError(
        new Error("Asana APIのContent-Typeがapplication/jsonではありません。"),
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
