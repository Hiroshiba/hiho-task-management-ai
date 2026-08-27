type SecretStorageErrorOptions = {
  readonly cause?: unknown;
};

function toErrorOptions(options: SecretStorageErrorOptions | undefined): ErrorOptions {
  if (options?.cause == null) {
    return {};
  }
  return { cause: options.cause };
}

/** 秘密情報保存処理の失敗を表すエラーです。 */
export class SecretStorageError extends Error {
  public constructor(message: string, options?: SecretStorageErrorOptions) {
    super(message, toErrorOptions(options));
    this.name = "SecretStorageError";
  }
}

/** OS保護ストレージが利用できないことを表すエラーです。 */
export class SecretStorageEncryptionUnavailableError extends SecretStorageError {
  public constructor(options?: SecretStorageErrorOptions) {
    super("OS保護ストレージを利用できません。", options);
    this.name = "SecretStorageEncryptionUnavailableError";
  }
}

/** 秘密情報ファイルの形式が不正なことを表すエラーです。 */
export class SecretStorageFormatError extends SecretStorageError {
  public constructor(options?: SecretStorageErrorOptions) {
    super("秘密情報ファイルの形式が不正です。", options);
    this.name = "SecretStorageFormatError";
  }
}
