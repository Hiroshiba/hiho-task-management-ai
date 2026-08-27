import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { z } from "zod";
import {
  authorizationCodeSchema,
  oauthStateSchema,
  redirectUriSchema,
} from "./schemas";
import {
  AsanaOAuthAuthorizationError,
  AsanaOAuthCallbackAbortedError,
  AsanaOAuthCallbackAttemptLimitError,
  AsanaOAuthCallbackServerError,
  AsanaOAuthCallbackSocketLimitError,
  AsanaOAuthCallbackTimeoutError,
} from "./errors";

const maximumInvalidRequestCount = 10;
const maximumHeaderCount = 32;
const maximumHeaderBytes = 8 * 1024;
const maximumUrlLength = 2 * 1024;
const maximumConcurrentSockets = 8;
const maximumTimeoutMilliseconds = 86_400_000;
const maximumCleanupWaitMilliseconds = 1_000;

const successHtml = "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>認証完了</title></head><body><p>認証が完了しました。この画面を閉じてアプリへ戻ってください。</p></body></html>";
const failureHtml = "<!doctype html><html lang=\"ja\"><head><meta charset=\"utf-8\"><title>認証失敗</title></head><body><p>認証に失敗しました。アプリへ戻ってやり直してください。</p></body></html>";
const contentSecurityPolicy = "default-src 'none'; base-uri 'none'; connect-src 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; object-src 'none'; script-src 'none'; style-src 'none'";

function isLoopbackHost(hostname: string): boolean {
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (unbracketedHostname === "localhost") {
    return true;
  }
  if (isIP(unbracketedHostname) === 4) {
    const octets = unbracketedHostname.split(".");
    return octets[0] === "127";
  }
  return isIP(unbracketedHostname) === 6 && unbracketedHostname === "::1";
}

/** OAuth loopback redirect URIを検証するスキーマです。 */
export const asanaOAuthLoopbackRedirectUriSchema = redirectUriSchema.superRefine((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:"
    || !isLoopbackHost(url.hostname)
    || url.port.length === 0
    || !Number.isSafeInteger(port)
    || port < 1024
    || port > 65535
    || url.pathname === "/"
    || value.includes("\\")
    || url.search.length > 0
    || url.hash.length > 0
    || url.username.length > 0
    || url.password.length > 0
  ) {
    context.addIssue({
      code: "custom",
      message: "OAuthのloopback redirect URIが不正です。",
    });
  }
});

const loopbackCallbackInputSchema = z
  .object({
    redirect_uri: asanaOAuthLoopbackRedirectUriSchema,
    expected_state: oauthStateSchema,
    timeout_milliseconds: z
      .number()
      .int()
      .positive()
      .max(maximumTimeoutMilliseconds),
  })
  .strict();

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint != null
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

const oauthErrorCodeSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._~-]+$/u);
const oauthErrorParameterSchema = z
  .string()
  .min(1)
  .max(maximumUrlLength)
  .refine((value) => !hasControlCharacter(value));
const oauthErrorUriSchema = z.url().max(maximumUrlLength);

const loopbackCallbackResultSchema = z
  .object({
    code: authorizationCodeSchema,
    state: oauthStateSchema,
  })
  .strict();

export type AsanaOAuthLoopbackCallbackInput = z.infer<
  typeof loopbackCallbackInputSchema
>;
export type AsanaOAuthLoopbackCallbackResult = z.infer<
  typeof loopbackCallbackResultSchema
>;

/** OAuth loopback callbackの入力を検証するスキーマです。 */
export const asanaOAuthLoopbackCallbackInputSchema =
  loopbackCallbackInputSchema;

/** OAuth loopback callbackの結果を検証するスキーマです。 */
export const asanaOAuthLoopbackCallbackResultSchema =
  loopbackCallbackResultSchema;

function isSameValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes);
}

function bindHost(redirectUri: URL): string {
  if (redirectUri.hostname.startsWith("[") && redirectUri.hostname.endsWith("]")) {
    return redirectUri.hostname.slice(1, -1);
  }
  return redirectUri.hostname;
}

function bindPort(redirectUri: URL): number {
  const port = Number(redirectUri.port);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error("OAuthのloopback portが不正です。");
  }
  return port;
}

type CallbackRequestInspection =
  | { readonly kind: "invalid" }
  | { readonly kind: "authorization_error" }
  | {
      readonly kind: "success";
      readonly code: string;
      readonly state: string;
    };

function hasTooManyHeaders(request: IncomingMessage): boolean {
  return (
    Object.keys(request.headers).length > maximumHeaderCount
    || request.rawHeaders.length / 2 > maximumHeaderCount
  );
}

function inspectCallbackRequest(
  request: IncomingMessage,
  redirectUri: URL,
  expectedState: string,
): CallbackRequestInspection {
  if (
    request.method !== "GET"
    || request.url == null
    || request.url.length === 0
    || request.url.length > maximumUrlLength
    || !request.url.startsWith("/")
    || hasTooManyHeaders(request)
  ) {
    return { kind: "invalid" };
  }

  let callbackUri: URL;
  try {
    callbackUri = new URL(request.url, redirectUri);
  } catch {
    return { kind: "invalid" };
  }
  if (
    callbackUri.origin !== redirectUri.origin
    || callbackUri.pathname !== redirectUri.pathname
    || callbackUri.hash.length > 0
  ) {
    return { kind: "invalid" };
  }

  const stateValues = callbackUri.searchParams.getAll("state");
  const errorValues = callbackUri.searchParams.getAll("error");
  if (errorValues.length > 0) {
    const allowedErrorKeys = new Set([
      "error",
      "error_description",
      "error_uri",
      "state",
    ]);
    const errorDescriptionValues = callbackUri.searchParams.getAll(
      "error_description",
    );
    const errorUriValues = callbackUri.searchParams.getAll("error_uri");
    if (
      errorValues.length !== 1
      || stateValues.length !== 1
      || errorDescriptionValues.length > 1
      || errorUriValues.length > 1
      || [...callbackUri.searchParams.entries()].some(([key, value]) => {
        return (
          !allowedErrorKeys.has(key)
          || !oauthErrorParameterSchema.safeParse(value).success
        );
      })
    ) {
      return { kind: "invalid" };
    }
    const errorCodeResult = oauthErrorCodeSchema.safeParse(errorValues[0]);
    const errorDescriptionValid =
      errorDescriptionValues.length === 0
      || oauthErrorParameterSchema.safeParse(errorDescriptionValues[0]).success;
    const errorUriValid =
      errorUriValues.length === 0
      || oauthErrorUriSchema.safeParse(errorUriValues[0]).success;
    const stateResult = oauthStateSchema.safeParse(stateValues[0]);
    if (
      !errorCodeResult.success
      || !errorDescriptionValid
      || !errorUriValid
      || !stateResult.success
      || !isSameValue(stateResult.data, expectedState)
    ) {
      return { kind: "invalid" };
    }
    return { kind: "authorization_error" };
  }

  const codeValues = callbackUri.searchParams.getAll("code");
  if (
    codeValues.length !== 1
    || stateValues.length !== 1
    || [...callbackUri.searchParams.keys()].some(
      (key) => key !== "code" && key !== "state",
    )
  ) {
    return { kind: "invalid" };
  }
  const codeResult = authorizationCodeSchema.safeParse(codeValues[0]);
  const stateResult = oauthStateSchema.safeParse(stateValues[0]);
  if (!codeResult.success || !stateResult.success) {
    return { kind: "invalid" };
  }
  if (!isSameValue(stateResult.data, expectedState)) {
    return { kind: "invalid" };
  }
  return {
    kind: "success",
    code: codeResult.data,
    state: stateResult.data,
  };
}

function sendBrowserResponse(
  response: ServerResponse,
  statusCode: number,
  html: string,
  onFinish: () => void,
  onError: (error: Error) => void,
): void {
  let finished = false;
  const handleError = (error: Error): void => {
    if (finished) {
      return;
    }
    finished = true;
    response.off("finish", handleFinish);
    response.off("error", handleError);
    onError(error);
  };
  const handleFinish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    response.off("finish", handleFinish);
    response.off("error", handleError);
    onFinish();
  };
  response.once("finish", handleFinish);
  response.once("error", handleError);
  try {
    const body = Buffer.from(html, "utf8");
    response.statusCode = statusCode;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Length", body.byteLength);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", contentSecurityPolicy);
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Connection", "close");
    response.end(body);
  } catch (error) {
    handleError(
      error instanceof Error
        ? error
        : new Error("OAuthコールバック応答に失敗しました。"),
    );
  }
}

function sendRawInvalidResponse(
  socket: Duplex,
  onFinish: () => void,
  onError: () => void,
): void {
  const body = Buffer.from(failureHtml, "utf8");
  const headers = [
    "HTTP/1.1 400 Bad Request",
    "Content-Type: text/html; charset=utf-8",
    `Content-Length: ${body.byteLength}`,
    "Cache-Control: no-store",
    `Content-Security-Policy: ${contentSecurityPolicy}`,
    "Pragma: no-cache",
    "Referrer-Policy: no-referrer",
    "X-Content-Type-Options: nosniff",
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  let finished = false;
  const finish = (succeeded: boolean): void => {
    if (finished) {
      return;
    }
    finished = true;
    socket.off("close", onClose);
    socket.off("error", onSocketError);
    if (succeeded) {
      onFinish();
      return;
    }
    onError();
  };
  const onClose = (): void => {
    finish(false);
  };
  const onSocketError = (): void => {
    finish(false);
  };
  if (socket.destroyed || !socket.writable) {
    socket.destroy();
    finish(false);
    return;
  }
  socket.once("close", onClose);
  socket.once("error", onSocketError);
  try {
    socket.end(
      Buffer.concat([Buffer.from(headers, "ascii"), body]),
      (error?: Error | null) => {
        finish(error == null);
      },
    );
  } catch {
    finish(false);
  }
}

/** OAuth loopback redirectを1回だけ受信します。 */
export async function waitForAsanaOAuthLoopbackCallback(
  input: AsanaOAuthLoopbackCallbackInput,
  signal: AbortSignal,
  onListening: () => Promise<void> | void,
): Promise<AsanaOAuthLoopbackCallbackResult> {
  const validatedInput = loopbackCallbackInputSchema.parse(input);
  if (signal.aborted) {
    throw new AsanaOAuthCallbackAbortedError();
  }
  const redirectUri = new URL(validatedInput.redirect_uri);
  const host = bindHost(redirectUri);
  const port = bindPort(redirectUri);

  return new Promise<AsanaOAuthLoopbackCallbackResult>((resolve, reject) => {
    let settled = false;
    let completionStarted = false;
    let listeningPromise: Promise<void> | undefined;
    let invalidRequestCount = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const sockets = new Set<Socket>();
    const invalidConnectionSockets = new Set<Duplex>();
    const server: Server = createServer({ maxHeaderSize: maximumHeaderBytes });
    let cleanupInProgress = false;
    let cleanupErrors: Error[] | undefined;

    const cleanup = async (): Promise<Error | undefined> => {
      const errors: Error[] = [];
      cleanupInProgress = true;
      cleanupErrors = errors;
      const rememberCleanupError = (error: unknown): void => {
        errors.push(
          error instanceof Error
            ? error
            : new Error("OAuthコールバックの終了処理に失敗しました。"),
        );
      };
      const runCleanup = (operation: () => void): void => {
        try {
          operation();
        } catch (error) {
          rememberCleanupError(error);
        }
      };
      const waitForServerClose = (): Promise<void> => {
        if (!server.listening) {
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          let completed = false;
          let closeTimeout: ReturnType<typeof setTimeout> | undefined;
          const complete = (error?: Error | null): void => {
            if (completed) {
              return;
            }
            completed = true;
            if (closeTimeout != null) {
              try {
                clearTimeout(closeTimeout);
              } catch (clearTimeoutError) {
                rememberCleanupError(clearTimeoutError);
              }
              closeTimeout = undefined;
            }
            if (error != null) {
              rememberCleanupError(error);
            }
            resolve();
          };
          const onCloseTimeout = (): void => {
            rememberCleanupError(
              new Error("OAuthコールバックサーバーの終了がタイムアウトしました。"),
            );
            runCleanup(() => server.off("error", onServerError));
            complete();
          };
          try {
            closeTimeout = setTimeout(
              onCloseTimeout,
              maximumCleanupWaitMilliseconds,
            );
            server.close((error?: Error | null) => {
              runCleanup(() => server.off("error", onServerError));
              complete(error);
            });
          } catch (error) {
            rememberCleanupError(error);
            complete();
          }
        });
      };
      try {
        if (timeout != null) {
          const currentTimeout = timeout;
          runCleanup(() => clearTimeout(currentTimeout));
          timeout = undefined;
        }
        runCleanup(() => signal.removeEventListener("abort", onAbort));
        for (const socket of sockets) {
          runCleanup(() => socket.destroy());
        }
        sockets.clear();
        invalidConnectionSockets.clear();
        runCleanup(() => server.off("connection", onConnection));
        runCleanup(() => server.off("clientError", onClientError));
        runCleanup(() => server.off("request", handleRequest));
        try {
          await waitForServerClose();
        } catch (error) {
          rememberCleanupError(error);
        }
        runCleanup(() => server.off("error", onServerError));
      } finally {
        cleanupInProgress = false;
        cleanupErrors = undefined;
      }
      const firstError = errors.at(0);
      if (firstError == null) {
        return undefined;
      }
      if (errors.length === 1) {
        return firstError;
      }
      return new AggregateError(
        errors,
        "OAuthコールバックの終了処理で複数のエラーが発生しました。",
      );
    };
    const finalizeFailure = async (error: Error): Promise<void> => {
      let cleanupError: Error | undefined;
      try {
        cleanupError = await cleanup();
      } catch (cleanupException) {
        cleanupError = cleanupException instanceof Error
          ? cleanupException
          : new Error("OAuthコールバックの終了処理に失敗しました。");
      }
      if (cleanupError != null) {
        reject(
          new AsanaOAuthCallbackServerError(
            new AggregateError(
              [error, cleanupError],
              "OAuthコールバックの終了処理に失敗しました。",
              { cause: error },
            ),
          ),
        );
        return;
      }
      reject(error);
    };
    const finalizeSuccess = async (
      result: AsanaOAuthLoopbackCallbackResult,
    ): Promise<void> => {
      let cleanupError: Error | undefined;
      try {
        cleanupError = await cleanup();
      } catch (cleanupException) {
        cleanupError = cleanupException instanceof Error
          ? cleanupException
          : new Error("OAuthコールバックの終了処理に失敗しました。");
      }
      if (cleanupError != null) {
        reject(
          new AsanaOAuthCallbackServerError(
            new AggregateError(
              [
                new Error("OAuthコールバックの成功後に終了処理へ失敗しました。"),
                cleanupError,
              ],
              "OAuthコールバックの終了処理に失敗しました。",
            ),
          ),
        );
        return;
      }
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      finalizeFailure(error).catch((finalizationError: unknown) => {
        reject(
          new AsanaOAuthCallbackServerError(
            new AggregateError(
              [error, finalizationError],
              "OAuthコールバックの終了処理に失敗しました。",
              { cause: error },
            ),
          ),
        );
      });
    };
    const succeed = (result: AsanaOAuthLoopbackCallbackResult): void => {
      if (settled || completionStarted) {
        return;
      }
      completionStarted = true;
      if (listeningPromise == null) {
        fail(new AsanaOAuthCallbackServerError(
          new Error("OAuthコールバックサーバーの待機準備が完了していません。"),
        ));
        return;
      }
      listeningPromise.then(() => {
        if (settled) {
          return;
        }
        settled = true;
        finalizeSuccess(result).catch((finalizationError: unknown) => {
          reject(
            new AsanaOAuthCallbackServerError(
              new AggregateError(
                [
                  new Error("OAuthコールバックの成功後に終了処理へ失敗しました。"),
                  finalizationError,
                ],
                "OAuthコールバックの終了処理に失敗しました。",
              ),
            ),
          );
        });
      }).catch((error: unknown) => {
        if (signal.aborted) {
          fail(new AsanaOAuthCallbackAbortedError());
          return;
        }
        fail(new AsanaOAuthCallbackServerError(error));
      });
    };
    const recordInvalidRequest = (): Error | undefined => {
      invalidRequestCount += 1;
      if (invalidRequestCount >= maximumInvalidRequestCount) {
        return new AsanaOAuthCallbackAttemptLimitError();
      }
      return undefined;
    };
    const recordInvalidConnection = (socket: Duplex): Error | undefined => {
      if (invalidConnectionSockets.has(socket)) {
        return undefined;
      }
      invalidConnectionSockets.add(socket);
      return recordInvalidRequest();
    };
    const onAbort = (): void => {
      fail(new AsanaOAuthCallbackAbortedError());
    };
    const onTimeout = (): void => {
      fail(new AsanaOAuthCallbackTimeoutError());
    };
    const onServerError = (error: Error): void => {
      if (cleanupInProgress && cleanupErrors != null) {
        cleanupErrors.push(error);
        return;
      }
      fail(new AsanaOAuthCallbackServerError(error));
    };
    const onClientError = (_error: Error, socket: Duplex): void => {
      if (settled || completionStarted) {
        socket.destroy();
        return;
      }
      const terminalError = recordInvalidConnection(socket);
      const finishInvalidResponse = (): void => {
        if (terminalError != null) {
          fail(terminalError);
        }
      };
      sendRawInvalidResponse(socket, finishInvalidResponse, finishInvalidResponse);
    };
    const onConnection = (socket: Socket): void => {
      if (settled || completionStarted) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => {
        sockets.delete(socket);
      });
      socket.once("error", () => {
        if (settled || completionStarted) {
          socket.destroy();
          return;
        }
        const terminalError = recordInvalidConnection(socket);
        socket.destroy();
        if (terminalError != null) {
          fail(terminalError);
        }
      });
      if (sockets.size > maximumConcurrentSockets) {
        fail(new AsanaOAuthCallbackSocketLimitError());
      }
    };
    const handleRequest = (
      request: IncomingMessage,
      response: ServerResponse,
    ): void => {
      if (settled) {
        response.destroy();
        return;
      }
      if (completionStarted) {
        response.destroy();
        return;
      }
      const socket = request.socket;
      const inspection = inspectCallbackRequest(
        request,
        redirectUri,
        validatedInput.expected_state,
      );
      let responseFinished = false;
      let responseAbandoned = false;
      let pendingResponseError: Error | undefined;
      const inspectionState: {
        kind: CallbackRequestInspection["kind"] | undefined;
      } = { kind: undefined };
      const onDisconnect = (): void => {
        if (responseFinished || responseAbandoned || settled) {
          return;
        }
        responseAbandoned = true;
        socket.off("close", onDisconnect);
        if (pendingResponseError != null) {
          fail(pendingResponseError);
          return;
        }
        if (
          inspectionState.kind === "invalid"
          || inspectionState.kind === "success"
          || inspectionState.kind === "authorization_error"
        ) {
          return;
        }
        const terminalError = recordInvalidConnection(socket);
        if (terminalError != null) {
          fail(terminalError);
        }
      };
      const finishRequest = (): void => {
        responseFinished = true;
        socket.off("close", onDisconnect);
      };
      const sendInvalidResponse = (terminalError: Error | undefined): void => {
        pendingResponseError = terminalError;
        sendBrowserResponse(
          response,
          400,
          failureHtml,
          () => {
            if (responseAbandoned || settled) {
              return;
            }
            finishRequest();
            if (terminalError != null) {
              fail(terminalError);
            }
          },
          () => {
            if (responseAbandoned || settled) {
              return;
            }
            finishRequest();
            if (terminalError != null) {
              fail(terminalError);
            }
          },
        );
      };
      socket.once("close", onDisconnect);
      inspectionState.kind = inspection.kind;
      if (inspection.kind === "invalid") {
        const terminalError = recordInvalidRequest();
        invalidConnectionSockets.add(socket);
        sendInvalidResponse(terminalError);
        return;
      }
      if (inspection.kind === "authorization_error") {
        sendInvalidResponse(new AsanaOAuthAuthorizationError());
        return;
      }
      const callbackResult = loopbackCallbackResultSchema.parse({
        code: inspection.code,
        state: inspection.state,
      });
      sendBrowserResponse(
        response,
        200,
        successHtml,
        () => {
          if (responseAbandoned || settled) {
            return;
          }
          finishRequest();
          succeed(callbackResult);
        },
        () => {
          if (responseAbandoned || settled) {
            return;
          }
          finishRequest();
          const terminalError = recordInvalidConnection(socket);
          if (terminalError != null) {
            fail(terminalError);
          }
        },
      );
    };

    server.maxHeadersCount = maximumHeaderCount;
    server.on("error", onServerError);
    server.on("clientError", onClientError);
    server.on("connection", onConnection);
    server.on("request", handleRequest);
    signal.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(onTimeout, validatedInput.timeout_milliseconds);
    try {
      server.listen({ host, port }, () => {
        if (settled) {
          return;
        }
        try {
          listeningPromise = Promise.resolve(onListening());
        } catch (error) {
          fail(new AsanaOAuthCallbackServerError(error));
          return;
        }
        listeningPromise.catch((error: unknown) => {
          if (signal.aborted) {
            fail(new AsanaOAuthCallbackAbortedError());
            return;
          }
          fail(new AsanaOAuthCallbackServerError(error));
        });
      });
    } catch (error) {
      fail(new AsanaOAuthCallbackServerError(error));
    }
  });
}
