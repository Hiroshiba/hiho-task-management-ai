import {
  AsanaOAuthCredentialError,
  AsanaOAuthHttpError,
  AsanaOAuthResponseError,
  AsanaOAuthTokenEndpointError,
  AsanaOAuthTransportError,
} from "./oauth";
import {
  AsanaAuthenticationError,
  AsanaHttpError,
  AsanaResponseError,
  AsanaTransportError,
  type TokenProvider,
} from "./transport";

function requiresAsanaReauthentication(error: unknown): boolean {
  if (error instanceof AsanaOAuthCredentialError) {
    return true;
  }
  if (!(error instanceof AsanaOAuthTokenEndpointError)) {
    return false;
  }
  return error.code === "invalid_client"
    || error.code === "invalid_grant"
    || error.code === "unauthorized_client";
}

class AsanaOAuthRefreshHttpError extends AsanaHttpError {
  public readonly cause: AsanaOAuthHttpError;

  public constructor(error: AsanaOAuthHttpError) {
    super(error.status, error.requestId, { response_body_kind: "unavailable" }, "oauth");
    this.cause = error;
  }
}

function throwTokenProviderError(error: unknown): never {
  if (requiresAsanaReauthentication(error)) {
    throw new AsanaAuthenticationError(error);
  }
  if (error instanceof AsanaOAuthTransportError) {
    throw new AsanaTransportError(error);
  }
  if (error instanceof AsanaOAuthResponseError) {
    throw new AsanaResponseError(error);
  }
  if (error instanceof AsanaOAuthHttpError) {
    throw new AsanaOAuthRefreshHttpError(error);
  }
  throw error;
}

/** 認証完了時に有効なAsanaトークンの供給元を切り替えます。 */
export class AsanaMutableTokenProvider implements TokenProvider {
  private provider: TokenProvider | undefined;

  /** 有効なトークン供給元を設定します。 */
  public setProvider(provider: TokenProvider): void {
    if (
      typeof provider?.getAccessToken !== "function"
      || typeof provider.refreshAccessToken !== "function"
    ) {
      throw new TypeError("Asana TokenProviderが不正です。");
    }
    this.provider = provider;
  }

  /** アクセストークンを取得します。 */
  public async getAccessToken(): Promise<string> {
    if (this.provider == null) {
      throw new AsanaAuthenticationError();
    }
    try {
      return await this.provider.getAccessToken();
    } catch (error) {
      throwTokenProviderError(error);
    }
  }

  /** アクセストークンを更新します。 */
  public async refreshAccessToken(): Promise<string> {
    if (this.provider == null) {
      throw new AsanaAuthenticationError();
    }
    try {
      return await this.provider.refreshAccessToken();
    } catch (error) {
      throwTokenProviderError(error);
    }
  }
}
