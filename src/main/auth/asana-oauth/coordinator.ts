import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  identifierSchema,
} from "../../../shared/domain";
import {
  type SecretStorage,
  type SecretStorageData,
} from "../secret-storage";
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
const maximumClientSecretBytes = 1024;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint != null
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

const clientSecretSchema = createUtf8ByteLimitedStringSchema(
  maximumClientSecretBytes,
)
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "Asana Client Secretを空白だけにできません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "Asana Client Secretに制御文字を指定できません。",
  });

const coordinatorInputSchema = z
  .object({
    client_id: identifierSchema,
    client_secret: clientSecretSchema,
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

function createCredentialData(
  clientSecret: string,
  latest: SecretStorageData | undefined,
): SecretStorageData {
  const externalCredentialReferences = latest?.external_credential_references;
  if (externalCredentialReferences == null) {
    return { asana_client_secret: clientSecret };
  }
  return {
    asana_client_secret: clientSecret,
    external_credential_references: externalCredentialReferences,
  };
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
      () => {
        const latest = this.secretStorage.load();
        this.secretStorage.save(
          createCredentialData(validatedInput.client_secret, latest),
        );
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
      () => {
        const latest = this.secretStorage.load();
        if (latest == null || latest.asana_client_secret == null) {
          throw new AsanaOAuthCredentialError();
        }
      },
    );
  }

  private async authenticateExclusively(
    input: AsanaOAuthReauthenticationInput,
    signal: AbortSignal,
    prepareCredentials: () => void,
  ): Promise<AsanaOAuthCoordinatorResult> {
    assertNotAborted(signal);
    if (this.authenticationInProgress) {
      throw new AsanaOAuthAuthenticationInProgressError();
    }
    this.authenticationInProgress = true;
    try {
      prepareCredentials();
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
      await client.exchangeAuthorizationCode(
        callbackResult.state,
        callbackResult.code,
        signal,
      );
      assertNotAborted(signal);
      return coordinatorResultSchema.parse({
        kind: "authenticated",
        client_id: input.client_id,
      });
    } finally {
      this.authenticationInProgress = false;
    }
  }
}
