import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import { z } from "zod";
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
const secretFileMode = 0o600;
const secretDirectoryMode = 0o700;

type SaveResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type CleanupResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

function validateFilePath(filePath: string): void {
  if (!isAbsolute(filePath)) {
    throw new Error("秘密情報ファイルのパスは絶対パスで指定してください。");
  }
}

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

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === code
  );
}

function readSecretFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function removeTemporaryFile(filePath: string): CleanupResult {
  try {
    unlinkSync(filePath);
    return { kind: "succeeded" };
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return { kind: "succeeded" };
    }
    return { kind: "failed", error };
  }
}

function finishSave(
  temporaryFilePath: string,
  saveResult: SaveResult,
): void {
  const cleanupResult = removeTemporaryFile(temporaryFilePath);

  if (saveResult.kind === "failed") {
    if (cleanupResult.kind === "failed") {
      throw new AggregateError(
        [saveResult.error, cleanupResult.error],
        "秘密情報の保存と一時ファイル削除に失敗しました。",
        { cause: saveResult.error },
      );
    }
    throw saveResult.error;
  }
  if (cleanupResult.kind === "failed") {
    throw cleanupResult.error;
  }
}

/** ElectronのOS保護ストレージを使って秘密情報を保存します。 */
export class SecretStorage {
  public constructor(private readonly filePath: string) {
    validateFilePath(filePath);
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
    const directoryPath = dirname(this.filePath);
    mkdirSync(directoryPath, { recursive: true, mode: secretDirectoryMode });
    const temporaryFilePath = `${this.filePath}.${randomUUID()}.tmp`;
    let saveResult: SaveResult;
    try {
      writeFileSync(temporaryFilePath, serializedFileData, {
        encoding: "utf8",
        flag: "wx",
        mode: secretFileMode,
      });
      chmodSync(temporaryFilePath, secretFileMode);
      renameSync(temporaryFilePath, this.filePath);
      saveResult = { kind: "succeeded" };
    } catch (error) {
      saveResult = { kind: "failed", error };
    }
    finishSave(temporaryFilePath, saveResult);
  }

  /** 暗号化済み秘密情報を復号して読み出します。 */
  public load(): SecretStorageData | undefined {
    const serializedFileData = readSecretFile(this.filePath);
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
    rmSync(this.filePath, { force: true });
  }
}
