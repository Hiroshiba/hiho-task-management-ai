import { z } from "zod";
import { identifierSchema } from "../../../shared/domain";
import { asanaClientSecretSchema } from "../../../shared/setup/schemas";
import { type SecretStorage } from "../secret-storage";
import { AsanaOAuthClient } from "./asana-oauth";
import {
  asanaOAuthLoopbackRedirectUriSchema,
  waitForAsanaOAuthLoopbackCallback,
} from "./loopback-callback";
import {
  AsanaOAuthAuthenticationInProgressError,
  AsanaOAuthAuthorizationUrlOpenError,
  AsanaOAuthCallbackAbortedError,
  AsanaOAuthCredentialError,
} from "./errors";

const maximumTimeoutMilliseconds = 86_400_000;

const coordinatorInputSchema = z
  .object({
    client_id: identifierSchema,
    client_secret: asanaClientSecretSchema,
    redirect_uri: asanaOAuthLoopbackRedirectUriSchema,
    timeout_milliseconds: z
      .number()
      .int()
      .positive()
      .max(maximumTimeoutMilliseconds),
  })
  .strict();

const reauthenticationInputSchema = coordinatorInputSchema
  .omit({ client_secret: true })
  .strict();

const coordinatorResultSchema = z
  .object({
    kind: z.literal("authenticated"),
    client_id: identifierSchema,
  })
  .strict();

export type AsanaOAuthCoordinatorInput = z.infer<typeof coordinatorInputSchema>;
export type AsanaOAuthCoordinatorResult = z.infer<
  typeof coordinatorResultSchema
>;
export type AsanaOAuthReauthenticationInput = z.infer<
  typeof reauthenticationInputSchema
>;

type AuthenticationMode =
  | {
      readonly kind: "initial";
      readonly clientSecret: string;
    }
  | {
      readonly kind: "reauthentication";
    };

/** Asana OAuth認証調整の入力を検証するスキーマです。 */
export const asanaOAuthCoordinatorInputSchema = coordinatorInputSchema;

/** Asana OAuth認証調整の結果を検証するスキーマです。 */
export const asanaOAuthCoordinatorResultSchema = coordinatorResultSchema;

/** 設定済みAsana OAuth再認証の入力を検証するスキーマです。 */
export const asanaOAuthReauthenticationInputSchema = reauthenticationInputSchema;

function toAuthorizationUrlOpenError(
  error: unknown,
): AsanaOAuthAuthorizationUrlOpenError {
  return new AsanaOAuthAuthorizationUrlOpenError(error);
}

function runAbortableOperation(
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
      settled = true;
      removeAbortListener();
      resolve();
    };
    const rejectOperation = (error: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      reject(toAuthorizationUrlOpenError(error));
    };
    const onAbort = (): void => {
      rejectOperation(new AsanaOAuthCallbackAbortedError());
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
      rejectOperation(error);
      return;
    }
    operationPromise.then(resolveOperation, rejectOperation);
  });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new AsanaOAuthCallbackAbortedError();
  }
}

/** Asana OAuth認証を一つのライフサイクルとして調整します。 */
export class AsanaOAuthCoordinator {
  private authenticationInProgress = false;

  public constructor(
    private readonly secretStorage: SecretStorage,
    private readonly openAuthorizationUrl: (
      authorizationUrl: string,
      signal: AbortSignal,
    ) => Promise<void> | void,
  ) {}

  /** Asana OAuth認証を開始してトークンを保存します。 */
  public async authenticate(
    input: AsanaOAuthCoordinatorInput,
    signal: AbortSignal,
  ): Promise<AsanaOAuthCoordinatorResult> {
    const validatedInput = coordinatorInputSchema.parse(input);
    return this.authenticateExclusively(
      validatedInput,
      signal,
      {
        kind: "initial",
        clientSecret: validatedInput.client_secret,
      },
    );
  }

  /** 保存済みClient Secretを使って設定済みAsana OAuthを再認証します。 */
  public async reauthenticate(
    input: AsanaOAuthReauthenticationInput,
    signal: AbortSignal,
  ): Promise<AsanaOAuthCoordinatorResult> {
    const validatedInput = reauthenticationInputSchema.parse(input);
    return this.authenticateExclusively(
      validatedInput,
      signal,
      { kind: "reauthentication" },
    );
  }

  private async authenticateExclusively(
    input: AsanaOAuthReauthenticationInput,
    signal: AbortSignal,
    mode: AuthenticationMode,
  ): Promise<AsanaOAuthCoordinatorResult> {
    assertNotAborted(signal);
    if (this.authenticationInProgress) {
      throw new AsanaOAuthAuthenticationInProgressError();
    }
    this.authenticationInProgress = true;
    try {
      if (mode.kind === "reauthentication") {
        const latest = this.secretStorage.load();
        if (latest == null || latest.asana_client_secret == null) {
          throw new AsanaOAuthCredentialError();
        }
      }
      assertNotAborted(signal);

      const client = new AsanaOAuthClient(
        input.client_id,
        input.redirect_uri,
        this.secretStorage,
      );
      const authorizationRequest = client.createAuthorizationRequest();
      const callbackResult = await waitForAsanaOAuthLoopbackCallback(
        {
          redirect_uri: input.redirect_uri,
          expected_state: authorizationRequest.state,
          timeout_milliseconds: input.timeout_milliseconds,
        },
        signal,
        () => runAbortableOperation(
          () => this.openAuthorizationUrl(authorizationRequest.authorization_url, signal),
          signal,
        ),
      );
      assertNotAborted(signal);
      if (mode.kind === "initial") {
        await client.exchangeInitialAuthorizationCode(
          callbackResult.state,
          callbackResult.code,
          mode.clientSecret,
          signal,
        );
      } else {
        await client.exchangeAuthorizationCode(
          callbackResult.state,
          callbackResult.code,
          signal,
        );
      }
      return coordinatorResultSchema.parse({
        kind: "authenticated",
        client_id: input.client_id,
      });
    } finally {
      this.authenticationInProgress = false;
    }
  }
}
