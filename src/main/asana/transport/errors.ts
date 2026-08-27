/** Asana APIとの通信に失敗したことを表します。 */
export class AsanaTransportError extends Error {
  public constructor(cause: unknown) {
    super("Asana APIとの通信に失敗しました。", { cause });
    this.name = "AsanaTransportError";
  }
}

/** Asana APIの成功レスポンスを解釈できないことを表します。 */
export class AsanaResponseError extends Error {
  public constructor(cause: unknown) {
    super("Asana APIのレスポンスを解釈できません。", { cause });
    this.name = "AsanaResponseError";
  }
}

/** Asana APIの認証に失敗したことを表します。 */
export class AsanaAuthenticationError extends Error {
  public constructor() {
    super("Asana APIの認証に失敗しました。");
    this.name = "AsanaAuthenticationError";
  }
}

/** Asana Events APIが新しい同期トークンを要求したことを表すエラーです。 */
export class AsanaEventsResetError extends Error {
  public readonly syncToken: string;

  public constructor(syncToken: string) {
    super("Asana Events APIの同期トークンを更新してください。");
    this.name = "AsanaEventsResetError";
    this.syncToken = syncToken;
  }
}

/** Asana APIが支払いを要求したことを表します。 */
export class AsanaPaymentRequiredError extends Error {
  public constructor() {
    super("Asana APIの利用に支払いが必要です。");
    this.name = "AsanaPaymentRequiredError";
  }
}

/** Asana APIがその他のHTTPエラーを返したことを表します。 */
export class AsanaHttpError extends Error {
  public readonly status: number;
  public readonly requestId?: string;

  public constructor(status: number, requestId: string | undefined) {
    super("Asana APIがHTTPエラーを返しました。");
    this.name = "AsanaHttpError";
    this.status = status;
    if (requestId != null) {
      this.requestId = requestId;
    }
  }
}

/** Asana APIのレート制限により再試行できないことを表します。 */
export class AsanaRateLimitError extends Error {
  public constructor() {
    super("Asana APIのRetry-Afterが不正です、または再試行上限に達しました。");
    this.name = "AsanaRateLimitError";
  }
}
