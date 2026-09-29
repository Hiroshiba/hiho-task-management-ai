import type { SecretStorageData } from "../../application/common/ports/secret-storage";

/** 保存済み資格情報から診断用の伏せ字対象を抽出します。 */
export function knownSecretsFromStorage(data: SecretStorageData | undefined): readonly string[] {
  if (data == null) return [];
  return [
    data.asana_client_secret,
    data.access_token,
    data.refresh_token,
    data.discord_bot_token,
    ...Object.values(data.external_credential_references ?? {}),
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
}
