import { createHash, randomBytes } from "node:crypto";
import type { TokenProvider } from "../../asana/transport";
import { identifierSchema } from "../../../shared/domain";
import { asanaClientSecretSchema } from "../../../shared/setup/schemas";
import {
  SecretStorage,
  type SecretStorageData,
} from "../secret-storage";
import {
  asanaOAuthOutOfBandRedirectUri,
  codeVerifierSchema,
  oauthAuthorizationRequestSchema,
  oauthOutOfBandAuthorizationCodeSchema,
  oauthStateSchema,
  oauthTokenErrorResponseSchema,
  oauthTokenResponseSchema,
  type OAuthAuthorizationRequest,
  type OAuthTokenErrorCode,
  type OAuthTokenResponse,
} from "./schemas";
import {
  AsanaOAuthCredentialError,
  AsanaOAuthCredentialStateError,
  AsanaOAuthHttpError,
  AsanaOAuthResponseError,
  AsanaOAuthStateError,
  AsanaOAuthTokenEndpointError,
  AsanaOAuthTransportError,
} from "./errors";

const authorizationEndpoint = "https://app.asana.com/-/oauth_authorize";
const tokenEndpoint = "https://app.asana.com/-/oauth_token";
const fetchTimeoutMilliseconds = 30_000;
const randomValueByteLength = 32;
const jsonContentType = "application/json";

type PendingAuthorization = {
  readonly state: ReturnType<typeof oauthStateSchema.parse>;
  readonly codeVerifier: ReturnType<typeof codeVerifierSchema.parse>;
};

function createRandomValue(): string {
  return randomBytes(randomValueByteLength).toString("base64url");
}

function createCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
}

function requestId(response: Response): string | undefined {
  const value = response.headers.get("x-request-id");
  if (value != null && value.length > 0) {
    return value;
  }
  const asanaValue = response.headers.get("x-asana-request-id");
  if (asanaValue != null && asanaValue.length > 0) {
    return asanaValue;
  }
  return undefined;
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType === jsonContentType;
}

function canContainStructuredTokenError(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}

async function readStructuredTokenErrorCode(
  response: Response,
): Promise<OAuthTokenErrorCode | undefined> {
  if (!isJsonResponse(response)) {
    return undefined;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined;
  }
  const result = oauthTokenErrorResponseSchema.safeParse(payload);
  if (!result.success) {
    return undefined;
  }
  return result.data.error;
}

function readRefreshSecrets(
  secretStorage: SecretStorage,
): {
  readonly clientSecret: string;
  readonly refreshToken: string;
} {
  const stored = secretStorage.load();
  if (
    stored == null
    || stored.asana_client_secret == null
    || stored.refresh_token == null
  ) {
    throw new AsanaOAuthCredentialError();
  }
  return {
    clientSecret: stored.asana_client_secret,
    refreshToken: stored.refresh_token,
  };
}

function readLatestSecrets(secretStorage: SecretStorage): SecretStorageData {
  const latest = secretStorage.load();
  if (latest == null) {
    throw new AsanaOAuthCredentialStateError();
  }
  return latest;
}

function assertClientSecretUnchanged(
  latest: SecretStorageData,
  clientSecret: string,
): void {
  if (latest.asana_client_secret !== clientSecret) {
    throw new AsanaOAuthCredentialStateError();
  }
}

function assertRefreshTokenUnchanged(
  latest: SecretStorageData,
  refreshToken: string,
): void {
  if (latest.refresh_token !== refreshToken) {
    throw new AsanaOAuthCredentialStateError();
  }
}

function readAccessToken(secretStorage: SecretStorage): string {
  const stored = secretStorage.load();
  if (stored == null || stored.access_token == null) {
    throw new AsanaOAuthCredentialError();
  }
  return stored.access_token;
}

function requireRefreshToken(response: OAuthTokenResponse): string {
  if (response.refresh_token == null) {
    throw new AsanaOAuthResponseError(
      200,
      new Error("OAuth認可コード交換応答にrefresh_tokenがありません。"),
    );
  }
  return response.refresh_token;
}

function createInitialSecretData(
  clientSecret: string,
  accessToken: string,
  refreshToken: string,
  latest: SecretStorageData | undefined,
): SecretStorageData {
  return {
    ...latest,
    asana_client_secret: clientSecret,
    access_token: accessToken,
    refresh_token: refreshToken,
  };
}

/** Asana OAuth PKCE認証とトークン管理を提供します。 */
export class AsanaOAuthClient implements TokenProvider {
  private readonly clientId: string;
  private pendingAuthorization: PendingAuthorization | undefined;

  public constructor(
    clientId: string,
    private readonly secretStorage: SecretStorage,
  ) {
    this.clientId = identifierSchema.parse(clientId);
  }

  /** OAuth Out-of-Band用のPKCE認可要求を生成します。 */
  public createOutOfBandAuthorizationRequest(): OAuthAuthorizationRequest {
    const state = oauthStateSchema.parse(createRandomValue());
    const codeVerifier = codeVerifierSchema.parse(createRandomValue());
    this.pendingAuthorization = { state, codeVerifier };
    const url = new URL(authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: asanaOAuthOutOfBandRedirectUri,
      response_type: "code",
      state,
      code_challenge: createCodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    return oauthAuthorizationRequestSchema.parse({
      authorization_url: url.href,
      state,
    });
  }

  /** OAuth Out-of-Bandの初回認可コードを交換して秘密情報を保存します。 */
  public async exchangeInitialOutOfBandAuthorizationCode(
    code: string,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const validatedClientSecret = asanaClientSecretSchema.parse(clientSecret);
    const validatedCode = oauthOutOfBandAuthorizationCodeSchema.parse(code);
    const pendingAuthorization = this.takePendingAuthorizationWithoutState();
    const response = await this.requestAuthorizationCodeToken(
      validatedCode,
      pendingAuthorization,
      validatedClientSecret,
      signal,
    );
    const refreshToken = requireRefreshToken(response);
    signal.throwIfAborted();
    const latest = this.secretStorage.load();
    this.secretStorage.save(
      createInitialSecretData(
        validatedClientSecret,
        response.access_token,
        refreshToken,
        latest,
      ),
    );
  }

  /** OAuth Out-of-Bandの再認可コードを交換してトークンを保存します。 */
  public async exchangeOutOfBandAuthorizationCode(
    code: string,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const validatedClientSecret = asanaClientSecretSchema.parse(clientSecret);
    const validatedCode = oauthOutOfBandAuthorizationCodeSchema.parse(code);
    const pendingAuthorization = this.takePendingAuthorizationWithoutState();
    const response = await this.requestAuthorizationCodeToken(
      validatedCode,
      pendingAuthorization,
      validatedClientSecret,
      signal,
    );
    const refreshToken = requireRefreshToken(response);
    const latest = readLatestSecrets(this.secretStorage);
    assertClientSecretUnchanged(latest, validatedClientSecret);
    signal.throwIfAborted();
    this.secretStorage.save({
      ...latest,
      access_token: response.access_token,
      refresh_token: refreshToken,
    });
  }

  /** OAuth認可要求のPKCE秘密情報を破棄します。 */
  public discardPendingAuthorization(): void {
    this.pendingAuthorization = undefined;
  }

  private takePendingAuthorizationWithoutState(): PendingAuthorization {
    const pendingAuthorization = this.pendingAuthorization;
    if (pendingAuthorization == null) {
      throw new AsanaOAuthStateError();
    }
    this.pendingAuthorization = undefined;
    return pendingAuthorization;
  }

  private requestAuthorizationCodeToken(
    validatedCode: string,
    pendingAuthorization: PendingAuthorization,
    clientSecret: string,
    signal: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    return this.requestToken(
      new URLSearchParams({
        grant_type: "authorization_code",
        client_id: this.clientId,
        client_secret: clientSecret,
        redirect_uri: asanaOAuthOutOfBandRedirectUri,
        code: validatedCode,
        code_verifier: pendingAuthorization.codeVerifier,
      }),
      signal,
    );
  }

  /** 保存済みアクセストークンをTokenProviderとして返します。 */
  public getAccessToken(): Promise<string> {
    return Promise.resolve(readAccessToken(this.secretStorage));
  }

  /** 保存済みリフレッシュトークンでアクセストークンを更新します。 */
  public async refreshAccessToken(): Promise<string> {
    const { clientSecret, refreshToken } = readRefreshSecrets(this.secretStorage);
    const response = await this.requestToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    );
    const latest = readLatestSecrets(this.secretStorage);
    assertClientSecretUnchanged(latest, clientSecret);
    assertRefreshTokenUnchanged(latest, refreshToken);
    if (response.refresh_token == null) {
      this.secretStorage.save({
        ...latest,
        access_token: response.access_token,
      });
    } else {
      this.secretStorage.save({
        ...latest,
        access_token: response.access_token,
        refresh_token: response.refresh_token,
      });
    }
    return response.access_token;
  }

  private async requestToken(
    form: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<OAuthTokenResponse> {
    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMilliseconds);
    const requestSignal = signal == null
      ? timeoutSignal
      : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          Accept: jsonContentType,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: requestSignal,
      });
    } catch (error) {
      if (signal != null && signal.aborted) {
        signal.throwIfAborted();
      }
      throw new AsanaOAuthTransportError(error);
    }

    const responseRequestId = requestId(response);
    if (response.status < 200 || response.status > 299) {
      if (canContainStructuredTokenError(response.status)) {
        const errorCode = await readStructuredTokenErrorCode(response);
        if (errorCode != null) {
          throw new AsanaOAuthTokenEndpointError(
            response.status,
            errorCode,
            responseRequestId,
          );
        }
      }
      throw new AsanaOAuthHttpError(response.status, responseRequestId);
    }
    if (!isJsonResponse(response)) {
      throw new AsanaOAuthResponseError(
        response.status,
        new Error("OAuthトークン応答のContent-Typeがapplication/jsonではありません。"),
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new AsanaOAuthResponseError(response.status, error);
    }
    try {
      return oauthTokenResponseSchema.parse(payload);
    } catch (error) {
      throw new AsanaOAuthResponseError(response.status, error);
    }
  }
}
