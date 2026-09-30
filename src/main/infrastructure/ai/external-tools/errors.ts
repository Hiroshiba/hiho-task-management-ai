import {
  externalToolErrorCodeSchema,
  type ExternalToolErrorCode,
} from "./schemas";

/** 外部ツール処理の構造化エラーを表します。 */
export class ExternalToolError extends Error {
  public readonly code: ExternalToolErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: ExternalToolErrorCode,
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "ExternalToolError";
    this.code = externalToolErrorCodeSchema.parse(code);
    this.retryable = retryable;
  }
}
