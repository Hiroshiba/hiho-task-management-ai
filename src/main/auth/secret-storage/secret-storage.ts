import { safeStorage } from "electron";
import { z } from "zod";
import {
  captureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
  readSecurePersistentTextFile,
  removeSecurePersistentFile,
  writeSecurePersistentTextFileAtomically,
} from "../../local-storage-path";
import {
  encryptedSecretStorageSchema,
  secretStorageSchema,
  type SecretStorageData,
} from "./schemas";
import {
  SecretStorageEncryptionUnavailableError,
  SecretStorageFormatError,
} from "./errors";

const encryptedFileVersion = 1;

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
export class SecretStorage {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = normalizeSecurePersistentFilePath(filePath);
    captureSecurePersistentFile(this.filePath, "秘密情報ファイル");
  }

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
    writeSecurePersistentTextFileAtomically(
      this.filePath,
      serializedFileData,
      "秘密情報ファイル",
    );
  }

  /** 暗号化済み秘密情報を復号して読み出します。 */
  public load(): SecretStorageData | undefined {
    const serializedFileData = readSecurePersistentTextFile(
      this.filePath,
      "秘密情報ファイル",
    );
    if (serializedFileData == null) {
      return undefined;
    }
    assertEncryptionAvailable();
    const fileData = parseJson(serializedFileData, encryptedSecretStorageSchema);

    let plainText: string;
    try {
      plainText = safeStorage.decryptString(Buffer.from(fileData.ciphertext, "base64"));
    } catch (error) {
      throw new SecretStorageFormatError({ cause: error });
    }
    return parseJson(plainText, secretStorageSchema);
  }

  /** 保存済み秘密情報ファイルを削除します。 */
  public clear(): void {
    removeSecurePersistentFile(this.filePath, "秘密情報ファイル");
  }
}
