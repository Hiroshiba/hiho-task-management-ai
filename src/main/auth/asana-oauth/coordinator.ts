import { randomBytes } from "node:crypto";
import { z } from "zod";
import { identifierSchema } from "../../../shared/domain";
import { asanaClientSecretSchema } from "../../../shared/setup/schemas";
import { type SecretStorage } from "../secret-storage";
import { AsanaOAuthClient } from "./asana-oauth";
import {
  AsanaOAuthAuthorizationUrlOpenError,
  AsanaOAuthCredentialError,
  AsanaOAuthOutOfBandAbortedError,
  AsanaOAuthOutOfBandAuthorizationIdMismatchError,
  AsanaOAuthOutOfBandCancelledError,
  AsanaOAuthOutOfBandExpiredError,
  AsanaOAuthOutOfBandAuthenticationInProgressError,
  AsanaOAuthOutOfBandNotPendingError,
  AsanaOAuthOutOfBandStoppedError,
} from "./errors";
import {
  oauthAuthorizationIdSchema,
  oauthOutOfBandAuthorizationCodeSchema,
  oauthOutOfBandBeginResultSchema,
  oauthOutOfBandStateSchema,
  type OAuthOutOfBandBeginResult,
  type OAuthOutOfBandState,
} from "./schemas";

const outOfBandPendingTimeoutMilliseconds = 10 * 60 * 1_000;

const coordinatorResultSchema = z
  .object({
    kind: z.literal("authenticated"),
    client_id: identifierSchema,
  })
  .strict();

export type AsanaOAuthCoordinatorResult = z.infer<
  typeof coordinatorResultSchema
>;

const outOfBandInitialBeginInputSchema = z
  .object({
    client_id: identifierSchema,
    client_secret: asanaClientSecretSchema,
  })
  .strict();

const outOfBandReauthenticationBeginInputSchema = z
  .object({
    client_id: identifierSchema,
  })
  .strict();

const outOfBandCompleteInputSchema = z
  .object({
    authorization_id: oauthAuthorizationIdSchema,
    authorization_code: oauthOutOfBandAuthorizationCodeSchema,
  })
  .strict();

const outOfBandCancelInputSchema = z
  .object({
    authorization_id: oauthAuthorizationIdSchema,
  })
  .strict();

export type AsanaOAuthOutOfBandInitialBeginInput = z.infer<
  typeof outOfBandInitialBeginInputSchema
>;
export type AsanaOAuthOutOfBandReauthenticationBeginInput = z.infer<
  typeof outOfBandReauthenticationBeginInputSchema
>;
export type AsanaOAuthOutOfBandCompleteInput = z.infer<
  typeof outOfBandCompleteInputSchema
>;
export type AsanaOAuthOutOfBandCancelInput = z.infer<
  typeof outOfBandCancelInputSchema
>;

/** OAuth Out-of-Band初回認証の入力を検証するスキーマです。 */
export const asanaOAuthOutOfBandInitialBeginInputSchema =
  outOfBandInitialBeginInputSchema;

/** OAuth Out-of-Band再認証の入力を検証するスキーマです。 */
export const asanaOAuthOutOfBandReauthenticationBeginInputSchema =
  outOfBandReauthenticationBeginInputSchema;

/** OAuth Out-of-Band完了の入力を検証するスキーマです。 */
export const asanaOAuthOutOfBandCompleteInputSchema =
  outOfBandCompleteInputSchema;

/** OAuth Out-of-Band取消の入力を検証するスキーマです。 */
export const asanaOAuthOutOfBandCancelInputSchema =
  outOfBandCancelInputSchema;

type OutOfBandMode =
  | {
      readonly kind: "initial";
      readonly clientSecret: string;
    }
  | {
      readonly kind: "reauthentication";
      readonly clientSecret: string;
    };

type OutOfBandActiveTransactionFields = {
  readonly authorizationId: string;
  readonly clientId: string;
  readonly client: AsanaOAuthClient;
  readonly expiresAt: string;
  readonly expiresAtMilliseconds: number;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly abortController: AbortController;
  readonly abortListener: () => void;
  readonly removeAbortListener: () => void;
  readonly mode: OutOfBandMode;
};

type OutOfBandTransaction =
  | { readonly kind: "idle" }
  | (OutOfBandActiveTransactionFields & { readonly kind: "opening" })
  | (OutOfBandActiveTransactionFields & {
      readonly kind: "authorization_pending";
    })
  | (OutOfBandActiveTransactionFields & { readonly kind: "completing" })
  | {
      readonly kind: "expired";
      readonly authorizationId: string;
      readonly expiresAt: string;
    }
  | {
      readonly kind: "cancelled";
      readonly authorizationId: string;
      readonly expiresAt: string;
      readonly reason: "cancelled" | "aborted" | "stopped";
    };

type OutOfBandActiveTransaction = Extract<
  OutOfBandTransaction,
  { readonly kind: "opening" | "authorization_pending" | "completing" }
>;

type OutOfBandExpirableTransaction = Extract<
  OutOfBandTransaction,
  { readonly kind: "opening" | "authorization_pending" }
>;

function createOutOfBandAuthorizationId(): string {
  return oauthAuthorizationIdSchema.parse(
    randomBytes(32).toString("base64url"),
  );
}

/** Asana OAuth認証調整の結果を検証するスキーマです。 */
export const asanaOAuthCoordinatorResultSchema = coordinatorResultSchema;

function assertOutOfBandNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AsanaOAuthOutOfBandAbortedError();
  }
}

function assertOutOfBandBeginAvailable(
  transaction: OutOfBandTransaction,
): void {
  if (isOutOfBandActiveTransaction(transaction)) {
    throw new AsanaOAuthOutOfBandAuthenticationInProgressError();
  }
}

function readOutOfBandAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new AsanaOAuthOutOfBandAbortedError();
}

function runOutOfBandAuthorizationUrlOpen(
  operation: () => Promise<void> | void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const removeAbortListener = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    const resolveOperation = (): void => {
      if (settled) {
        return;
      }
      if (signal.aborted) {
        rejectOperation(readOutOfBandAbortError(signal));
        return;
      }
      settled = true;
      removeAbortListener();
      resolve();
    };
    const rejectOperation = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOperation(readOutOfBandAbortError(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let operationPromise: Promise<void>;
    try {
      operationPromise = Promise.resolve(operation());
    } catch (error) {
      if (signal.aborted) {
        rejectOperation(readOutOfBandAbortError(signal));
        return;
      }
      rejectOperation(new AsanaOAuthAuthorizationUrlOpenError(error));
      return;
    }
    operationPromise.then(resolveOperation, (error: unknown) => {
      if (signal.aborted) {
        rejectOperation(readOutOfBandAbortError(signal));
        return;
      }
      rejectOperation(new AsanaOAuthAuthorizationUrlOpenError(error));
    });
  });
}

function createOutOfBandCancellationError(
  reason: "cancelled" | "aborted" | "stopped",
): AsanaOAuthOutOfBandCancelledError | AsanaOAuthOutOfBandAbortedError | AsanaOAuthOutOfBandStoppedError {
  switch (reason) {
    case "cancelled":
      return new AsanaOAuthOutOfBandCancelledError();
    case "aborted":
      return new AsanaOAuthOutOfBandAbortedError();
    case "stopped":
      return new AsanaOAuthOutOfBandStoppedError();
  }
}

function toOutOfBandState(
  transaction: OutOfBandTransaction,
): OAuthOutOfBandState {
  switch (transaction.kind) {
    case "idle":
      return oauthOutOfBandStateSchema.parse({ kind: "idle" });
    case "opening":
    case "authorization_pending":
    case "completing":
      return oauthOutOfBandStateSchema.parse({
        kind: transaction.kind,
        authorization_id: transaction.authorizationId,
        expires_at: transaction.expiresAt,
      });
    case "expired":
      return oauthOutOfBandStateSchema.parse({
        kind: transaction.kind,
        authorization_id: transaction.authorizationId,
        expires_at: transaction.expiresAt,
      });
    case "cancelled":
      return oauthOutOfBandStateSchema.parse({
        kind: transaction.kind,
        authorization_id: transaction.authorizationId,
        expires_at: transaction.expiresAt,
      });
  }
}

function isOutOfBandActiveTransaction(
  transaction: OutOfBandTransaction,
): transaction is OutOfBandActiveTransaction {
  return (
    transaction.kind === "opening"
    || transaction.kind === "authorization_pending"
    || transaction.kind === "completing"
  );
}

function isOutOfBandExpirableTransaction(
  transaction: OutOfBandTransaction,
): transaction is OutOfBandExpirableTransaction {
  return transaction.kind === "opening" || transaction.kind === "authorization_pending";
}

function outOfBandTerminalError(
  transaction: OutOfBandTransaction,
): AsanaOAuthOutOfBandExpiredError
  | AsanaOAuthOutOfBandCancelledError
  | AsanaOAuthOutOfBandAbortedError
  | AsanaOAuthOutOfBandStoppedError
  | AsanaOAuthOutOfBandNotPendingError {
  switch (transaction.kind) {
    case "expired":
      return new AsanaOAuthOutOfBandExpiredError();
    case "cancelled":
      return createOutOfBandCancellationError(transaction.reason);
    case "idle":
    case "opening":
    case "authorization_pending":
    case "completing":
      return new AsanaOAuthOutOfBandNotPendingError();
  }
}

/** Asana OAuth認証を一つのライフサイクルとして調整します。 */
export class AsanaOAuthCoordinator {
  private outOfBandTransaction: OutOfBandTransaction = { kind: "idle" };

  public constructor(
    private readonly secretStorage: SecretStorage,
    private readonly openAuthorizationUrl: (
      authorizationUrl: string,
      signal: AbortSignal,
    ) => Promise<void> | void,
  ) {}

  /** OAuth Out-of-Band初回認証を開始します。 */
  public beginInitialOutOfBandAuthorization(
    input: AsanaOAuthOutOfBandInitialBeginInput,
    signal: AbortSignal,
  ): Promise<OAuthOutOfBandBeginResult> {
    const validatedInput = outOfBandInitialBeginInputSchema.parse(input);
    return this.beginOutOfBandAuthorization(
      validatedInput.client_id,
      {
        kind: "initial",
        clientSecret: validatedInput.client_secret,
      },
      signal,
    );
  }

  /** 保存済みClient Secretを使うOAuth Out-of-Band再認証を開始します。 */
  public beginOutOfBandReauthentication(
    input: AsanaOAuthOutOfBandReauthenticationBeginInput,
    signal: AbortSignal,
  ): Promise<OAuthOutOfBandBeginResult> {
    const validatedInput = outOfBandReauthenticationBeginInputSchema.parse(input);
    assertOutOfBandNotAborted(signal);
    assertOutOfBandBeginAvailable(this.outOfBandTransaction);
    const stored = this.secretStorage.load();
    if (stored == null || stored.asana_client_secret == null) {
      throw new AsanaOAuthCredentialError();
    }
    return this.beginOutOfBandAuthorization(
      validatedInput.client_id,
      {
        kind: "reauthentication",
        clientSecret: stored.asana_client_secret,
      },
      signal,
    );
  }

  /** OAuth Out-of-Band認可コードを完了してトークンを保存します。 */
  public async completeOutOfBandAuthorization(
    input: AsanaOAuthOutOfBandCompleteInput,
    signal: AbortSignal,
  ): Promise<AsanaOAuthCoordinatorResult> {
    const validatedInput = outOfBandCompleteInputSchema.parse(input);
    const transaction = this.requireOutOfBandPending(
      validatedInput.authorization_id,
    );
    if (signal.aborted) {
      this.cancelOutOfBandTransaction(transaction, "aborted");
      throw new AsanaOAuthOutOfBandAbortedError();
    }
    if (Date.now() >= transaction.expiresAtMilliseconds) {
      this.expireOutOfBandTransaction(transaction);
      throw new AsanaOAuthOutOfBandExpiredError();
    }

    transaction.removeAbortListener();
    clearTimeout(transaction.timer);
    const abortController = transaction.abortController;
    const abortListener = (): void => {
      const current = this.readOutOfBandTransaction();
      if (
        !isOutOfBandActiveTransaction(current)
        || current.authorizationId !== transaction.authorizationId
      ) {
        return;
      }
      const error = new AsanaOAuthOutOfBandAbortedError();
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
      this.cancelOutOfBandTransaction(current, "aborted");
    };
    signal.addEventListener("abort", abortListener, { once: true });

    const completingTransaction: OutOfBandTransaction = {
      ...transaction,
      kind: "completing",
      abortListener,
      removeAbortListener: () => {
        signal.removeEventListener("abort", abortListener);
      },
    };
    this.outOfBandTransaction = completingTransaction;
    if (signal.aborted) {
      abortListener();
      throw new AsanaOAuthOutOfBandAbortedError();
    }
    try {
      if (transaction.mode.kind === "initial") {
        await transaction.client.exchangeInitialOutOfBandAuthorizationCode(
          validatedInput.authorization_code,
          transaction.mode.clientSecret,
          abortController.signal,
        );
      } else {
        await transaction.client.exchangeOutOfBandAuthorizationCode(
          validatedInput.authorization_code,
          transaction.mode.clientSecret,
          abortController.signal,
        );
      }
      const current = this.readOutOfBandTransaction();
      if (current.kind === "expired" || current.kind === "cancelled") {
        throw outOfBandTerminalError(current);
      }
      if (
        !isOutOfBandActiveTransaction(current)
        || current.authorizationId !== transaction.authorizationId
      ) {
        throw new AsanaOAuthOutOfBandNotPendingError();
      }
      if (abortController.signal.aborted) {
        throw abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new AsanaOAuthOutOfBandAbortedError();
      }
      this.finishOutOfBandTransaction(current);
      return coordinatorResultSchema.parse({
        kind: "authenticated",
        client_id: transaction.clientId,
      });
    } catch (error) {
      const current = this.readOutOfBandTransaction();
      if (current.kind === "expired" || current.kind === "cancelled") {
        throw outOfBandTerminalError(current);
      }
      if (
        isOutOfBandActiveTransaction(current)
        && current.authorizationId === transaction.authorizationId
      ) {
        this.finishOutOfBandTransaction(current);
      }
      if (abortController.signal.aborted) {
        throw abortController.signal.reason instanceof Error
          ? abortController.signal.reason
          : new AsanaOAuthOutOfBandAbortedError();
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abortListener);
    }
  }

  /** OAuth Out-of-Band認証を利用者操作で取り消します。 */
  public cancelOutOfBandAuthorization(
    input: AsanaOAuthOutOfBandCancelInput,
  ): void {
    const validatedInput = outOfBandCancelInputSchema.parse(input);
    const transaction = this.outOfBandTransaction;
    if (transaction.kind === "idle") {
      throw new AsanaOAuthOutOfBandNotPendingError();
    }
    if (transaction.kind === "expired") {
      throw new AsanaOAuthOutOfBandExpiredError();
    }
    if (transaction.kind === "cancelled") {
      throw createOutOfBandCancellationError(transaction.reason);
    }
    if (transaction.authorizationId !== validatedInput.authorization_id) {
      throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
    }
    this.cancelOutOfBandTransaction(transaction, "cancelled");
  }

  /** OAuth Out-of-Band認証の公開状態を取得します。 */
  public getOutOfBandState(): OAuthOutOfBandState {
    const transaction = this.outOfBandTransaction;
    if (
      isOutOfBandExpirableTransaction(transaction)
      && Date.now() >= transaction.expiresAtMilliseconds
    ) {
      this.expireOutOfBandTransaction(transaction);
    }
    return toOutOfBandState(this.outOfBandTransaction);
  }

  /** OAuth Out-of-Band認証の待機または完了処理を停止します。 */
  public stopOutOfBandAuthorization(): void {
    const transaction = this.outOfBandTransaction;
    if (isOutOfBandActiveTransaction(transaction)) {
      this.cancelOutOfBandTransaction(transaction, "stopped");
    }
  }

  private readOutOfBandTransaction(): OutOfBandTransaction {
    return this.outOfBandTransaction;
  }

  private async beginOutOfBandAuthorization(
    clientId: string,
    mode: OutOfBandMode,
    signal: AbortSignal,
  ): Promise<OAuthOutOfBandBeginResult> {
    assertOutOfBandNotAborted(signal);
    assertOutOfBandBeginAvailable(this.outOfBandTransaction);
    const validatedClientId = identifierSchema.parse(clientId);
    const validatedClientSecret = asanaClientSecretSchema.parse(mode.clientSecret);
    const validatedMode: OutOfBandMode = mode.kind === "initial"
      ? { kind: "initial", clientSecret: validatedClientSecret }
      : { kind: "reauthentication", clientSecret: validatedClientSecret };
    const client = new AsanaOAuthClient(
      validatedClientId,
      this.secretStorage,
    );
    const authorizationRequest = client.createOutOfBandAuthorizationRequest();
    const authorizationId = createOutOfBandAuthorizationId();
    const expiresAtMilliseconds = Date.now() + outOfBandPendingTimeoutMilliseconds;
    const expiresAt = new Date(expiresAtMilliseconds).toISOString();
    const abortController = new AbortController();
    const timer = setTimeout(
      () => this.expireOutOfBandAuthorization(authorizationId),
      outOfBandPendingTimeoutMilliseconds,
    );
    const abortListener = (): void => {
      const current = this.readOutOfBandTransaction();
      if (
        !isOutOfBandActiveTransaction(current)
        || current.authorizationId !== authorizationId
      ) {
        return;
      }
      const error = new AsanaOAuthOutOfBandAbortedError();
      if (!abortController.signal.aborted) {
        abortController.abort(error);
      }
      this.cancelOutOfBandTransaction(current, "aborted");
    };
    const transaction: OutOfBandTransaction = {
      kind: "opening",
      authorizationId,
      clientId: validatedClientId,
      client,
      expiresAt,
      expiresAtMilliseconds,
      timer,
      abortController,
      abortListener,
      removeAbortListener: () => {
        signal.removeEventListener("abort", abortListener);
      },
      mode: validatedMode,
    };
    this.outOfBandTransaction = transaction;
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) {
      abortListener();
      throw new AsanaOAuthOutOfBandAbortedError();
    }
    try {
      await runOutOfBandAuthorizationUrlOpen(
        () => this.openAuthorizationUrl(
          authorizationRequest.authorization_url,
          abortController.signal,
        ),
        abortController.signal,
      );
      const current = this.readOutOfBandTransaction();
      if (current.kind === "expired" || current.kind === "cancelled") {
        throw outOfBandTerminalError(current);
      }
      if (
        !isOutOfBandActiveTransaction(current)
        || current.kind !== "opening"
        || current.authorizationId !== authorizationId
      ) {
        throw new AsanaOAuthOutOfBandNotPendingError();
      }
      if (Date.now() >= expiresAtMilliseconds) {
        this.expireOutOfBandTransaction(current);
        throw new AsanaOAuthOutOfBandExpiredError();
      }
      this.outOfBandTransaction = {
        ...current,
        kind: "authorization_pending",
      };
      return oauthOutOfBandBeginResultSchema.parse({
        authorization_id: authorizationId,
        expires_at: expiresAt,
      });
    } catch (error) {
      const current = this.readOutOfBandTransaction();
      if (current.kind === "expired" || current.kind === "cancelled") {
        throw outOfBandTerminalError(current);
      }
      if (
        isOutOfBandActiveTransaction(current)
        && current.authorizationId === authorizationId
      ) {
        this.finishOutOfBandTransaction(current);
      }
      throw error;
    } finally {
      if (this.outOfBandTransaction.kind === "opening") {
        signal.removeEventListener("abort", abortListener);
      }
    }
  }

  private requireOutOfBandPending(
    authorizationId: string,
  ): Extract<OutOfBandTransaction, { readonly kind: "authorization_pending" }> {
    const transaction = this.outOfBandTransaction;
    if (transaction.kind === "expired" || transaction.kind === "cancelled") {
      throw outOfBandTerminalError(transaction);
    }
    if (transaction.kind === "idle") {
      throw new AsanaOAuthOutOfBandNotPendingError();
    }
    if (transaction.authorizationId !== authorizationId) {
      throw new AsanaOAuthOutOfBandAuthorizationIdMismatchError();
    }
    if (transaction.kind !== "authorization_pending") {
      throw new AsanaOAuthOutOfBandNotPendingError();
    }
    return transaction;
  }

  private expireOutOfBandAuthorization(authorizationId: string): void {
    const transaction = this.outOfBandTransaction;
    if (
      !isOutOfBandExpirableTransaction(transaction)
      || transaction.authorizationId !== authorizationId
    ) {
      return;
    }
    this.expireOutOfBandTransaction(transaction);
  }

  private expireOutOfBandTransaction(
    transaction: OutOfBandExpirableTransaction,
  ): void {
    const error = new AsanaOAuthOutOfBandExpiredError();
    if (!transaction.abortController.signal.aborted) {
      transaction.abortController.abort(error);
    }
    transaction.client.discardPendingAuthorization();
    transaction.removeAbortListener();
    clearTimeout(transaction.timer);
    this.outOfBandTransaction = {
      kind: "expired",
      authorizationId: transaction.authorizationId,
      expiresAt: transaction.expiresAt,
    };
  }

  private cancelOutOfBandTransaction(
    transaction: OutOfBandActiveTransaction,
    reason: "cancelled" | "aborted" | "stopped",
  ): void {
    const error = createOutOfBandCancellationError(reason);
    if (!transaction.abortController.signal.aborted) {
      transaction.abortController.abort(error);
    }
    transaction.client.discardPendingAuthorization();
    transaction.removeAbortListener();
    clearTimeout(transaction.timer);
    this.outOfBandTransaction = {
      kind: "cancelled",
      authorizationId: transaction.authorizationId,
      expiresAt: transaction.expiresAt,
      reason,
    };
  }

  private finishOutOfBandTransaction(
    transaction: OutOfBandActiveTransaction,
  ): void {
    transaction.client.discardPendingAuthorization();
    transaction.removeAbortListener();
    clearTimeout(transaction.timer);
    this.outOfBandTransaction = { kind: "idle" };
  }

}
