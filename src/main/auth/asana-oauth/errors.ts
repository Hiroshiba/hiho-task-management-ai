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

/** OAuth認可サーバーが認可を拒否したことを表すエラーです。 */
export class AsanaOAuthAuthorizationError extends AsanaOAuthError {
  public constructor() {
    super("OAuth認可が拒否されました。");
    this.name = "AsanaOAuthAuthorizationError";
  }
}

/** OAuth認可URLの起動失敗を表すエラーです。 */
export class AsanaOAuthAuthorizationUrlOpenError extends AsanaOAuthError {
  public readonly kind: "error" | "unknown";

  public constructor(error: unknown) {
    super("OAuth認可URLの起動に失敗しました。");
    this.name = "AsanaOAuthAuthorizationUrlOpenError";
    this.kind = error instanceof Error ? "error" : "unknown";
  }
}

/** OAuth認証処理が既に実行中であることを表すエラーです。 */
export class AsanaOAuthAuthenticationInProgressError extends AsanaOAuthError {
  public constructor() {
    super("OAuth認証処理が既に実行中です。");
    this.name = "AsanaOAuthAuthenticationInProgressError";
  }
}

/** OAuthコールバックの待機が中断されたことを表すエラーです。 */
export class AsanaOAuthCallbackAbortedError extends AsanaOAuthError {
  public constructor() {
    super("OAuthコールバックの待機が中断されました。");
    this.name = "AsanaOAuthCallbackAbortedError";
  }
}

/** OAuthコールバックの待機がタイムアウトしたことを表すエラーです。 */
export class AsanaOAuthCallbackTimeoutError extends AsanaOAuthError {
  public constructor() {
    super("OAuthコールバックの待機がタイムアウトしました。");
    this.name = "AsanaOAuthCallbackTimeoutError";
  }
}

/** OAuthコールバックの不正要求が上限に達したことを表すエラーです。 */
export class AsanaOAuthCallbackAttemptLimitError extends AsanaOAuthError {
  public constructor() {
    super("OAuthコールバックの不正要求が上限に達しました。");
    this.name = "AsanaOAuthCallbackAttemptLimitError";
  }
}

/** OAuthコールバックの同時接続数が上限に達したことを表すエラーです。 */
export class AsanaOAuthCallbackSocketLimitError extends AsanaOAuthError {
  public constructor() {
    super("OAuthコールバックの同時接続数が上限に達しました。");
    this.name = "AsanaOAuthCallbackSocketLimitError";
  }
}

/** OAuthコールバックサーバーの処理に失敗したことを表すエラーです。 */
export class AsanaOAuthCallbackServerError extends AsanaOAuthError {
  public constructor(cause: unknown) {
    super("OAuthコールバックサーバーの処理に失敗しました。", { cause });
    this.name = "AsanaOAuthCallbackServerError";
  }
}
