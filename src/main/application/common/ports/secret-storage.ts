/** 保存する秘密情報の形です。 */
export type SecretStorageData = {
  readonly asana_client_secret?: string | undefined;
  readonly access_token?: string | undefined;
  readonly refresh_token?: string | undefined;
};

/** 秘密情報の保存と取得に使うportです。 */
export type SecretStoragePort = {
  readonly load: () => SecretStorageData | undefined;
  readonly save: (data: SecretStorageData) => void;
  readonly clear: () => void;
};
