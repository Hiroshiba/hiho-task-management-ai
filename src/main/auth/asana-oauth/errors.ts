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

/** OAuthトークン応答の形式不正を表すエラーです。 */
export class AsanaOAuthResponseError extends AsanaOAuthError {
  public readonly status: number;

  public constructor(status: number, cause: unknown) {
    super("OAuthトークン応答の形式が不正です。", { cause });
    this.name = "AsanaOAuthResponseError";
    this.status = status;
  }
}
