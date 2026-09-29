/** 外部連携の業務エラーを表します。 */
export class ExternalAgentServiceError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string, cause?: unknown) {
    super(message, cause == null ? undefined : { cause });
    this.name = "ExternalAgentServiceError";
    this.code = code;
  }
}
