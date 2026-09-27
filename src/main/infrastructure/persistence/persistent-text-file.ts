import { randomUUID } from "node:crypto";
import {
  fchmodSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  assertFileStats,
  assertSameIdentity,
  normalizeSecurePersistentFilePath,
  secureFileMode,
  validateLabel,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileSnapshot,
} from "./secure-path-guard";
import {
  assertDirectorySnapshot,
  assertSnapshotEqual,
  assertStatsMatchSnapshot,
  captureDirectory,
  captureFileWithParent,
  captureSecurePersistentFile,
  inspectFilePath,
  openValidatedFile,
  removeTemporaryFile,
  runWithFileDescriptor,
  snapshotFromStats,
  type FileOperationResult,
} from "./secure-file-snapshot";

/** サイズ上限を持つ永続ファイルの読み込み上限を超えたことを表します。 */
export class SecurePersistentFileSizeLimitError extends Error {
  public constructor(label: string) {
    super(`${label}がサイズ上限を超えています。`);
    this.name = "SecurePersistentFileSizeLimitError";
  }
}

type PersistentTextFileReadLimit =
  | { readonly kind: "unbounded" }
  | { readonly kind: "bounded"; readonly maximumBytes: number };

const persistentTextFileReadLimitSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);

function assertPersistentTextFileReadSize(
  stats: BigIntStats,
  readLimit: PersistentTextFileReadLimit,
  label: string,
): void {
  if (
    readLimit.kind === "bounded"
    && stats.size > BigInt(readLimit.maximumBytes)
  ) {
    throw new SecurePersistentFileSizeLimitError(label);
  }
}

function readPersistentTextFileAtMost(
  descriptor: number,
  maximumBytes: number,
): Buffer {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    const read = readSync(
      descriptor,
      buffer,
      bytesRead,
      buffer.byteLength - bytesRead,
      null,
    );
    if (read === 0) {
      break;
    }
    bytesRead += read;
  }
  return buffer.subarray(0, bytesRead);
}

function readSecurePersistentFileInternal<Result>(
  filePath: string,
  label: string,
  readLimit: PersistentTextFileReadLimit,
  decode: (buffer: Buffer) => Result,
): Result | undefined {
  const normalizedPath = normalizeSecurePersistentFilePath(filePath);
  const validatedLabel = validateLabel(label);
  const parentPath = dirname(normalizedPath);
  const parentLabel = `${validatedLabel}の親ディレクトリ`;
  const parentSnapshot = captureDirectory(parentPath, parentLabel);
  const inspection = inspectFilePath(normalizedPath, validatedLabel);
  if (inspection.kind === "missing") {
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    return undefined;
  }
  const descriptor = openValidatedFile(
    normalizedPath,
    inspection.stats,
    validatedLabel,
  );
  const readResult = runWithFileDescriptor(
    descriptor,
    () => {
      const openedStats = fstatSync(descriptor, { bigint: true });
      assertFileStats(openedStats, validatedLabel);
      assertSameIdentity(inspection.stats, openedStats, validatedLabel);
      assertPersistentTextFileReadSize(openedStats, readLimit, validatedLabel);
      const buffer = readLimit.kind === "bounded"
        ? readPersistentTextFileAtMost(descriptor, readLimit.maximumBytes)
        : readFileSync(descriptor);
      const afterReadStats = fstatSync(descriptor, { bigint: true });
      assertFileStats(afterReadStats, validatedLabel);
      assertSameIdentity(openedStats, afterReadStats, validatedLabel);
      assertPersistentTextFileReadSize(afterReadStats, readLimit, validatedLabel);
      const afterReadPathInspection = inspectFilePath(
        normalizedPath,
        validatedLabel,
      );
      if (afterReadPathInspection.kind === "missing") {
        throw new Error(`${validatedLabel}が読み取り中に消失しました。`);
      }
      assertSameIdentity(
        afterReadStats,
        afterReadPathInspection.stats,
        validatedLabel,
      );
      if (
        openedStats.size !== afterReadStats.size
        || openedStats.mode !== afterReadStats.mode
        || openedStats.mtimeNs !== afterReadStats.mtimeNs
        || openedStats.ctimeNs !== afterReadStats.ctimeNs
        || BigInt(buffer.byteLength) !== openedStats.size
      ) {
        throw new Error(`${validatedLabel}が読み取り中に変化しました。`);
      }
      return decode(buffer);
    },
    `${validatedLabel}の読み取りとファイル終了に失敗しました。`,
  );
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
  return readResult;
}

/** 永続保存テキストを検証済みファイルハンドルから読み取ります。 */
export function readSecurePersistentTextFile(
  filePath: string,
  label: string,
): string | undefined {
  return readSecurePersistentFileInternal(
    filePath,
    label,
    { kind: "unbounded" },
    (buffer) => buffer.toString("utf8"),
  );
}

/** 永続保存テキストを指定サイズ以下で検証済みファイルハンドルから読み取ります。 */
export function readSecurePersistentTextFileWithByteLimit(
  filePath: string,
  label: string,
  maximumBytes: number,
): string | undefined {
  const validatedMaximumBytes = persistentTextFileReadLimitSchema.parse(maximumBytes);
  return readSecurePersistentFileInternal(
    filePath,
    label,
    { kind: "bounded", maximumBytes: validatedMaximumBytes },
    (buffer) => new TextDecoder("utf-8", { fatal: true }).decode(buffer),
  );
}

/** 永続保存ファイルを上限付きで検証済みファイルハンドルから読み取ります。 */
export function readSecurePersistentFileBytesWithByteLimit(
  filePath: string,
  label: string,
  maximumBytes: number,
): Buffer | undefined {
  const validatedMaximumBytes = persistentTextFileReadLimitSchema.parse(maximumBytes);
  return readSecurePersistentFileInternal(
    filePath,
    label,
    { kind: "bounded", maximumBytes: validatedMaximumBytes },
    (buffer) => buffer,
  );
}

/** 永続保存テキストを0600の一時ファイルから原子的に保存し、保存先の実体を返します。 */
export function writeSecurePersistentTextFileAtomically(
  filePath: string,
  content: string,
  label: string,
): SecurePersistentFileIdentity {
  const normalizedPath = normalizeSecurePersistentFilePath(filePath);
  const validatedContent = z.string().parse(content);
  const validatedLabel = validateLabel(label);
  const parentPath = dirname(normalizedPath);
  const parentLabel = `${validatedLabel}の親ディレクトリ`;
  const parentSnapshot = captureDirectory(parentPath, parentLabel);
  const targetSnapshot = captureFileWithParent(normalizedPath, validatedLabel);
  const temporaryPath = `${normalizedPath}.${randomUUID()}.tmp`;
  const temporaryLabel = `${validatedLabel}の一時ファイル`;
  let temporarySnapshot: SecurePersistentFileSnapshot | undefined;
  let saveResult: FileOperationResult<SecurePersistentFileIdentity>;
  try {
    const descriptor = openSync(temporaryPath, "wx", secureFileMode);
    const temporaryStats = runWithFileDescriptor(
      descriptor,
      () => {
        if (process.platform !== "win32") {
          fchmodSync(descriptor, secureFileMode);
        }
        const initialStats = fstatSync(descriptor, { bigint: true });
        assertFileStats(initialStats, temporaryLabel);
        temporarySnapshot = snapshotFromStats(initialStats);
        writeFileSync(descriptor, validatedContent, { encoding: "utf8" });
        if (process.platform !== "win32") {
          fchmodSync(descriptor, secureFileMode);
        }
        const writtenStats = fstatSync(descriptor, { bigint: true });
        assertFileStats(writtenStats, temporaryLabel);
        assertSameIdentity(initialStats, writtenStats, temporaryLabel);
        if (writtenStats.size !== BigInt(Buffer.byteLength(validatedContent, "utf8"))) {
          throw new Error(`${temporaryLabel}の書き込みサイズが一致しません。`);
        }
        return writtenStats;
      },
      `${temporaryLabel}の書き込みとファイル終了に失敗しました。`,
    );
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    const securedTemporary = captureFileWithParent(temporaryPath, temporaryLabel);
    if (securedTemporary.kind === "missing") {
      throw new Error(`${temporaryLabel}を確認できません。`);
    }
    assertStatsMatchSnapshot(temporaryStats, securedTemporary, temporaryLabel);
    const currentTarget = captureFileWithParent(normalizedPath, validatedLabel);
    assertSnapshotEqual(targetSnapshot, currentTarget, validatedLabel);
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    renameSync(temporaryPath, normalizedPath);
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    const savedTarget = captureFileWithParent(normalizedPath, validatedLabel);
    if (savedTarget.kind === "missing") {
      throw new Error(`${validatedLabel}が保存後に見つかりません。`);
    }
    assertSnapshotEqual(securedTemporary, savedTarget, validatedLabel);
    saveResult = { kind: "succeeded", value: savedTarget };
  } catch (error) {
    saveResult = { kind: "failed", error };
  }
  let cleanupResult: FileOperationResult<void> = {
    kind: "succeeded",
    value: undefined,
  };
  if (temporarySnapshot != null) {
    try {
      removeTemporaryFile(temporaryPath, temporarySnapshot, temporaryLabel);
    } catch (error) {
      cleanupResult = { kind: "failed", error };
    }
  }
  if (saveResult.kind === "failed" && cleanupResult.kind === "failed") {
    throw new AggregateError(
      [saveResult.error, cleanupResult.error],
      `${validatedLabel}の保存と一時ファイル削除に失敗しました。`,
      { cause: saveResult.error },
    );
  }
  if (saveResult.kind === "failed") {
    throw saveResult.error;
  }
  if (cleanupResult.kind === "failed") {
    throw cleanupResult.error;
  }
  return saveResult.value;
}

/** 永続保存ファイルを安全な実体確認後に削除します。 */
export function removeSecurePersistentFile(
  filePath: string,
  label: string,
): void {
  const normalizedPath = normalizeSecurePersistentFilePath(filePath);
  const validatedLabel = validateLabel(label);
  const parentPath = dirname(normalizedPath);
  const parentLabel = `${validatedLabel}の親ディレクトリ`;
  const parentSnapshot = captureDirectory(parentPath, parentLabel);
  const expected = captureFileWithParent(normalizedPath, validatedLabel);
  if (expected.kind === "missing") {
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    return;
  }
  const current = captureFileWithParent(normalizedPath, validatedLabel);
  assertSnapshotEqual(expected, current, validatedLabel);
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
  unlinkSync(normalizedPath);
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
}

/** 永続テキストファイルの読み書きと削除を提供します。 */
export interface PersistentTextFile {
  read(): string | undefined;
  readWithByteLimit(maximumBytes: number): string | undefined;
  replaceAtomically(content: string, label: string): void;
  remove(): void;
}

/** 永続テキストファイルの生存期間を管理します。 */
export class PersistentTextFileHandle implements PersistentTextFile {
  private readonly filePath: string;
  private closed = false;

  public constructor(filePath: string, private readonly label: string) {
    this.filePath = normalizeSecurePersistentFilePath(filePath);
    captureSecurePersistentFile(this.filePath, label);
  }

  /** 検証済みファイルからテキストを読み取ります。 */
  public read(): string | undefined {
    this.assertOpen();
    return readSecurePersistentTextFile(this.filePath, this.label);
  }

  /** 指定サイズ以下の検証済みファイルからテキストを読み取ります。 */
  public readWithByteLimit(maximumBytes: number): string | undefined {
    this.assertOpen();
    return readSecurePersistentTextFileWithByteLimit(
      this.filePath,
      this.label,
      maximumBytes,
    );
  }

  /** 一時ファイルからテキストを原子的に置き換えます。 */
  public replaceAtomically(content: string, label: string): void {
    this.assertOpen();
    writeSecurePersistentTextFileAtomically(this.filePath, content, label);
  }

  /** 検証済みファイルを削除します。 */
  public remove(): void {
    this.assertOpen();
    removeSecurePersistentFile(this.filePath, this.label);
  }

  /** ファイルへのアクセスを終了します。 */
  public close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`${this.label}の保存処理は終了しています。`);
    }
  }
}
