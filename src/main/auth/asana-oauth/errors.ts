import {
  oauthTokenErrorCodeSchema,
  type OAuthTokenErrorCode,
} from "./schemas";

/** Asana OAuth処理の失敗を表すエラーです。 */
export class AsanaOAuthError extends Error {
  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AsanaOAuthError";
  }
}

/** OAuth認可状態の検証失敗を表すエラーです。 */
export class AsanaOAuthStateError extends AsanaOAuthError {
  public constructor() {
    super("OAuth認可状態が一致しません。");
    this.name = "AsanaOAuthStateError";
  }
}

/** OAuthに必要な秘密情報の不足を表すエラーです。 */
export class AsanaOAuthCredentialError extends AsanaOAuthError {
  public constructor() {
    super("OAuthに必要な秘密情報が保存されていません。");
    this.name = "AsanaOAuthCredentialError";
  }
}

/** OAuth認証情報が処理中に変更されたことを表すエラーです。 */
export class AsanaOAuthCredentialStateError extends AsanaOAuthError {
  public constructor() {
    super("OAuth認証情報が処理中に変更されたため、認証を中断しました。");
    this.name = "AsanaOAuthCredentialStateError";
  }
}

/** OAuthトークンエンドポイントとの通信失敗を表すエラーです。 */
export class AsanaOAuthTransportError extends AsanaOAuthError {
  public constructor(cause: unknown) {
    super("OAuthトークンエンドポイントとの通信に失敗しました。", { cause });
    this.name = "AsanaOAuthTransportError";
  }
}

/** OAuthトークンエンドポイントのHTTP失敗を表すエラーです。 */
export class AsanaOAuthHttpError extends AsanaOAuthError {
  public readonly status: number;
  public readonly requestId?: string;

  public constructor(status: number, requestId: string | undefined) {
    super("OAuthトークンエンドポイントがHTTPエラーを返しました。");
    this.name = "AsanaOAuthHttpError";
    this.status = status;
    if (requestId != null && requestId.length > 0) {
      this.requestId = requestId;
    }
  }
}

/** OAuthトークンエンドポイントの構造化エラーを表すエラーです。 */
export class AsanaOAuthTokenEndpointError extends AsanaOAuthHttpError {
  public readonly code: OAuthTokenErrorCode;

  public constructor(
    status: number,
    code: OAuthTokenErrorCode,
    requestId: string | undefined,
  ) {
    super(status, requestId);
    this.name = "AsanaOAuthTokenEndpointError";
    this.code = oauthTokenErrorCodeSchema.parse(code);
  }
}

/** OAuthトークン応答の形式不正を表すエラーです。 */
export class AsanaOAuthResponseError extends AsanaOAuthError {
  public readonly status: number;

  public constructor(status: number, cause: unknown) {
    super("OAuthトークン応答の形式が不正です。", { cause });
    this.name = "AsanaOAuthResponseError";
    this.status = status;
  }
}

/** OAuth認可URLの起動失敗を表すエラーです。 */
export class AsanaOAuthAuthorizationUrlOpenError extends AsanaOAuthError {
  public readonly kind: "error" | "unknown";

  public constructor(error: unknown) {
    super("OAuth認可URLの起動に失敗しました。", { cause: error });
    this.name = "AsanaOAuthAuthorizationUrlOpenError";
    this.kind = error instanceof Error ? "error" : "unknown";
  }
}

/** OAuth Out-of-Band認証が既に実行中であることを表すエラーです。 */
export class AsanaOAuthOutOfBandAuthenticationInProgressError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認証処理が既に実行中です。");
    this.name = "AsanaOAuthOutOfBandAuthenticationInProgressError";
  }
}

/** OAuth Out-of-Band取引が待機状態でないことを表すエラーです。 */
export class AsanaOAuthOutOfBandNotPendingError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認証処理は待機状態ではありません。");
    this.name = "AsanaOAuthOutOfBandNotPendingError";
  }
}

/** OAuth Out-of-Bandの認可識別子が一致しないことを表すエラーです。 */
export class AsanaOAuthOutOfBandAuthorizationIdMismatchError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認可識別子が一致しません。");
    this.name = "AsanaOAuthOutOfBandAuthorizationIdMismatchError";
  }
}

/** OAuth Out-of-Band認証の期限切れを表すエラーです。 */
export class AsanaOAuthOutOfBandExpiredError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認証の有効期限が切れています。");
    this.name = "AsanaOAuthOutOfBandExpiredError";
  }
}

/** OAuth Out-of-Band認証が取り消されたことを表すエラーです。 */
export class AsanaOAuthOutOfBandCancelledError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認証が取り消されました。");
    this.name = "AsanaOAuthOutOfBandCancelledError";
  }
}

/** OAuth Out-of-Band認証が中断されたことを表すエラーです。 */
export class AsanaOAuthOutOfBandAbortedError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認証が中断されました。");
    this.name = "AsanaOAuthOutOfBandAbortedError";
  }
}

/** OAuth Out-of-Band認証が停止されたことを表すエラーです。 */
export class AsanaOAuthOutOfBandStoppedError extends AsanaOAuthError {
  public constructor() {
    super("OAuth Out-of-Band認証が停止されました。");
    this.name = "AsanaOAuthOutOfBandStoppedError";
  }
}
