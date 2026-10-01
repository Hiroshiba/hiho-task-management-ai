import { safeStorage } from "electron";
import { z } from "zod";
import type { SecretStorageData, SecretStoragePort } from "../../application/common/ports/secret-storage";
import type { PersistentTextFile } from "./persistent-text-file";
import {
  encryptedSecretStorageSchema,
  legacyEncryptedSecretStorageSchema,
  legacySecretStorageSchema,
  secretStorageSchema,
} from "./secret-storage-schemas";
import {
  SecretStorageEncryptionUnavailableError,
  SecretStorageFormatError,
} from "./secret-storage-errors";

const encryptedFileVersion = 2;
const encryptedVersionEnvelopeSchema = z.object({ version: z.unknown() }).passthrough();

function assertLinuxStorageBackend(): void {
  let backend: string;
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch (error) {
    throw new SecretStorageEncryptionUnavailableError({ cause: error });
  }

  switch (backend) {
    case "gnome_libsecret":
    case "kwallet":
    case "kwallet5":
    case "kwallet6":
      return;
    case "basic_text":
    case "unknown":
      throw new SecretStorageEncryptionUnavailableError();
    default:
      throw new Error("OS保護ストレージのバックエンドが想定外です。");
  }
}

function assertEncryptionAvailable(): void {
  if (process.platform === "linux") {
    assertLinuxStorageBackend();
  }

  let available: boolean;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch (error) {
    throw new SecretStorageEncryptionUnavailableError({ cause: error });
  }
  if (!available) {
    throw new SecretStorageEncryptionUnavailableError();
  }
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SecretStorageFormatError({ cause: error });
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    throw new SecretStorageFormatError({ cause: error });
  }
}

/** ElectronのOS保護ストレージを使って秘密情報を保存します。 */
export class SecretStorage implements SecretStoragePort {
  public constructor(
    private readonly file: PersistentTextFile,
    private readonly rememberLegacySecrets: (values: readonly string[]) => void,
  ) {}

  /** 秘密情報を暗号化して原子的に保存します。 */
  public save(data: SecretStorageData): void {
    const validatedData = secretStorageSchema.parse(data);
    assertEncryptionAvailable();

    const ciphertext = safeStorage
      .encryptString(JSON.stringify(validatedData))
      .toString("base64");
    const fileData = encryptedSecretStorageSchema.parse({
      version: encryptedFileVersion,
      ciphertext,
    });
    const serializedFileData = JSON.stringify(fileData);
    this.file.replaceAtomically(serializedFileData, "秘密情報ファイル");
  }

  /** 暗号化済み秘密情報を復号して読み出します。 */
  public load(): SecretStorageData | undefined {
    const serializedFileData = this.file.read();
    if (serializedFileData == null) {
      return undefined;
    }
    assertEncryptionAvailable();
    const envelope = parseJson(serializedFileData, encryptedVersionEnvelopeSchema);
    if (envelope.version !== 1 && envelope.version !== encryptedFileVersion) {
      throw new SecretStorageFormatError();
    }
    const fileData =
      envelope.version === 1
        ? parseJson(serializedFileData, legacyEncryptedSecretStorageSchema)
        : parseJson(serializedFileData, encryptedSecretStorageSchema);

    let plainText: string;
    try {
      plainText = safeStorage.decryptString(Buffer.from(fileData.ciphertext, "base64"));
    } catch (error) {
      throw new SecretStorageFormatError({ cause: error });
    }
    if (fileData.version === encryptedFileVersion) {
      return parseJson(plainText, secretStorageSchema);
    }
    const legacy = parseJson(plainText, legacySecretStorageSchema);
    this.rememberLegacySecrets(
      [
        legacy.discord_bot_token,
        ...Object.values(legacy.external_credential_references ?? {}),
      ].filter((value): value is string => typeof value === "string" && value.length > 0),
    );
    const migrated = secretStorageSchema.parse({
      asana_client_secret: legacy.asana_client_secret,
      access_token: legacy.access_token,
      refresh_token: legacy.refresh_token,
    });
    this.save(migrated);
    return migrated;
  }

  /** 保存済み秘密情報ファイルを削除します。 */
  public clear(): void {
    this.file.remove();
  }
}
