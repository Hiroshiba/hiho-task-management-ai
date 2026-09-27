import { randomUUID } from "node:crypto";
import {
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  assertFileStats,
  assertSameIdentity,
  inspectPathWithoutSymlinks,
  normalizeDirectoryPath,
  normalizeSecurePersistentFilePath,
  secureDirectoryMode,
  secureFileMode,
  validateLabel,
  type SecureDirectorySnapshot,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileSnapshot,
} from "./infrastructure/persistence/secure-path-guard";
import {
  assertDirectorySnapshot,
  assertSecurePersistentFileSnapshot,
  assertSnapshotEqual,
  assertStatsMatchSnapshot,
  captureDirectory,
  captureFileWithParent,
  captureSecurePersistentFile,
  ensureSecurePersistentFile,
  inspectFilePath,
  matchesSecurePersistentFileIdentity,
  openValidatedFile,
  removeTemporaryFile,
  runWithFileDescriptor,
  snapshotFromStats,
  type FileOperationResult,
} from "./infrastructure/persistence/secure-file-snapshot";

export {
  normalizeSecurePersistentFilePath,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileSnapshot,
} from "./infrastructure/persistence/secure-path-guard";
export {
  assertSecurePersistentFileSnapshot,
  captureSecurePersistentFile,
  ensureSecurePersistentFile,
};

export type SecurePersistentFileIsolationResult =
  | { readonly kind: "isolated"; readonly isolationPath: string }
  | { readonly kind: "source_recreated"; readonly isolationPath: string }
  | { readonly kind: "identity_mismatch"; readonly isolationPath: string }
  | {
      readonly kind: "verification_failed";
      readonly isolationPath: string;
      readonly error: unknown;
    };

export type SecurePersistentFileLocation =
  | { readonly kind: "source_path" }
  | { readonly kind: "isolation_path"; readonly path: string };

export type SecurePersistentFileRemovalResult =
  | { readonly kind: "removed" }
  | {
      readonly kind: "identity_remains";
      readonly location: SecurePersistentFileLocation;
      readonly error: unknown;
    }
  | { readonly kind: "identity_removed_boundary_violation"; readonly error: unknown };

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

/** userDataを安全な永続保存ディレクトリとして検証します。 */
export function ensureSecureUserDataDirectory(userDataPath: string): string {
  const normalizedPath = normalizeDirectoryPath(userDataPath);
  const label = "userDataディレクトリ";
  const inspection = inspectPathWithoutSymlinks(normalizedPath, label);
  if (inspection.kind === "missing") {
    try {
      mkdirSync(normalizedPath, { recursive: true, mode: secureDirectoryMode });
    } catch (error) {
      throw new Error("userDataディレクトリを作成できません。", { cause: error });
    }
  }
  captureDirectory(normalizedPath, label);
  return normalizedPath;
}

/** 永続保存ファイルを同一ディレクトリの隔離パスへ移し、実体を検証します。 */
export function isolateSecurePersistentFile(
  filePath: string,
  expected: SecurePersistentFileIdentity,
  label: string,
): SecurePersistentFileIsolationResult {
  const normalizedPath = normalizeSecurePersistentFilePath(filePath);
  const validatedLabel = validateLabel(label);
  const parentPath = dirname(normalizedPath);
  const parentLabel = `${validatedLabel}の親ディレクトリ`;
  const parentSnapshot = captureDirectory(parentPath, parentLabel);
  const currentFile = captureFileWithParent(normalizedPath, validatedLabel);
  assertSnapshotEqual(expected, currentFile, validatedLabel);
  const isolationPath = normalizeSecurePersistentFilePath(
    join(parentPath, `${randomUUID()}.dispose`),
  );
  if (dirname(isolationPath) !== parentPath) {
    throw new Error(`${validatedLabel}の隔離先が同じディレクトリではありません。`);
  }
  const isolationTarget = captureFileWithParent(isolationPath, validatedLabel);
  if (isolationTarget.kind === "existing") {
    throw new Error(`${validatedLabel}の隔離先がすでに存在します。`);
  }
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
  const finalSource = captureFileWithParent(normalizedPath, validatedLabel);
  assertSnapshotEqual(expected, finalSource, validatedLabel);
  const finalIsolationTarget = captureFileWithParent(isolationPath, validatedLabel);
  if (finalIsolationTarget.kind === "existing") {
    throw new Error(`${validatedLabel}の隔離先が操作中に作成されました。`);
  }
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
  try {
    renameSync(normalizedPath, isolationPath);
  } catch (error) {
    throw new Error(`${validatedLabel}を隔離できません。`, { cause: error });
  }
  try {
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    const isolatedFile = captureFileWithParent(isolationPath, validatedLabel);
    if (isolatedFile.kind === "missing") {
      throw new Error(`${validatedLabel}を隔離後に確認できません。`);
    }
    if (
      isolatedFile.device !== expected.device
      || isolatedFile.inode !== expected.inode
    ) {
      return { kind: "identity_mismatch", isolationPath };
    }
    const source = captureFileWithParent(normalizedPath, validatedLabel);
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    if (source.kind === "existing") {
      return { kind: "source_recreated", isolationPath };
    }
    return { kind: "isolated", isolationPath };
  } catch (error: unknown) {
    return { kind: "verification_failed", isolationPath, error };
  }
}

/** 隔離ファイルを削除し、削除後の境界違反を検出します。 */
export function removeSecurePersistentFileFromIsolation(
  isolationPath: string,
  sourcePath: string,
  expected: SecurePersistentFileIdentity,
  label: string,
): SecurePersistentFileRemovalResult {
  const normalizedIsolationPath = normalizeSecurePersistentFilePath(isolationPath);
  const normalizedSourcePath = normalizeSecurePersistentFilePath(sourcePath);
  const validatedLabel = validateLabel(label);
  const parentPath = dirname(normalizedSourcePath);
  const parentLabel = `${validatedLabel}の親ディレクトリ`;
  if (
    dirname(normalizedIsolationPath) !== parentPath
    || normalizedIsolationPath === normalizedSourcePath
  ) {
    throw new Error(`${validatedLabel}の隔離先が同じディレクトリではありません。`);
  }
  const parentSnapshot = captureDirectory(parentPath, parentLabel);
  const sourceBeforeRemoval = captureFileWithParent(normalizedSourcePath, validatedLabel);
  const isolationBeforeRemoval = captureFileWithParent(
    normalizedIsolationPath,
    validatedLabel,
  );
  if (!matchesSecurePersistentFileIdentity(isolationBeforeRemoval, expected)) {
    if (matchesSecurePersistentFileIdentity(sourceBeforeRemoval, expected)) {
      return {
        kind: "identity_remains",
        location: { kind: "source_path" },
        error: new Error(`${validatedLabel}の実体が隔離先以外で確認されました。`),
      };
    }
    return {
      kind: "identity_removed_boundary_violation",
      error: new Error(`${validatedLabel}の隔離先から期待する実体が失われました。`),
    };
  }
  if (sourceBeforeRemoval.kind === "existing") {
    return {
      kind: "identity_remains",
      location: { kind: "isolation_path", path: normalizedIsolationPath },
      error: new Error(`${validatedLabel}の元パスが削除前に再作成されました。`),
    };
  }
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
  const currentIsolation = captureFileWithParent(
    normalizedIsolationPath,
    validatedLabel,
  );
  const currentSource = captureFileWithParent(normalizedSourcePath, validatedLabel);
  if (!matchesSecurePersistentFileIdentity(currentIsolation, expected)) {
    if (matchesSecurePersistentFileIdentity(currentSource, expected)) {
      return {
        kind: "identity_remains",
        location: { kind: "source_path" },
        error: new Error(`${validatedLabel}の実体が隔離先以外で確認されました。`),
      };
    }
    return {
      kind: "identity_removed_boundary_violation",
      error: new Error(`${validatedLabel}の隔離先から期待する実体が失われました。`),
    };
  }
  if (currentSource.kind === "existing") {
    return {
      kind: "identity_remains",
      location: { kind: "isolation_path", path: normalizedIsolationPath },
      error: new Error(`${validatedLabel}の元パスが削除前に再作成されました。`),
    };
  }
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);

  let unlinkAttempt: FileOperationResult<void>;
  try {
    unlinkSync(normalizedIsolationPath);
    unlinkAttempt = { kind: "succeeded", value: undefined };
  } catch (error: unknown) {
    unlinkAttempt = { kind: "failed", error };
  }

  try {
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    const isolationAfterRemoval = captureFileWithParent(
      normalizedIsolationPath,
      validatedLabel,
    );
    const sourceAfterRemoval = captureFileWithParent(
      normalizedSourcePath,
      validatedLabel,
    );
    assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
    if (matchesSecurePersistentFileIdentity(sourceAfterRemoval, expected)) {
      return {
        kind: "identity_remains",
        location: { kind: "source_path" },
        error: new Error(`${validatedLabel}の実体が元パスへ移動しました。`),
      };
    }
    if (isolationAfterRemoval.kind === "existing") {
      if (matchesSecurePersistentFileIdentity(isolationAfterRemoval, expected)) {
        return {
          kind: "identity_remains",
          location: { kind: "isolation_path", path: normalizedIsolationPath },
          error: createSecurePersistentFileStillExistsError(
            sourceAfterRemoval,
            unlinkAttempt,
            validatedLabel,
          ),
        };
      }
      return {
        kind: "identity_removed_boundary_violation",
        error: new Error(`${validatedLabel}の隔離先が削除中に別の実体へ置き換わりました。`),
      };
    }
    if (sourceAfterRemoval.kind === "existing") {
      return {
        kind: "identity_removed_boundary_violation",
        error: new Error(`${validatedLabel}の元パスが削除後に再作成されました。`),
      };
    }
    if (unlinkAttempt.kind === "failed") {
      return {
        kind: "identity_removed_boundary_violation",
        error: new Error(`${validatedLabel}の削除失敗後に実体が見つかりません。`, {
          cause: unlinkAttempt.error,
        }),
      };
    }
    return { kind: "removed" };
  } catch (error: unknown) {
    return classifySecurePersistentFileRemovalFailure(
      normalizedIsolationPath,
      normalizedSourcePath,
      expected,
      parentPath,
      parentSnapshot,
      validatedLabel,
      error,
      unlinkAttempt,
    );
  }
}

function createSecurePersistentFileStillExistsError(
  source: SecurePersistentFileSnapshot,
  unlinkAttempt: FileOperationResult<void>,
  label: string,
): Error {
  if (source.kind === "existing") {
    const sourceRecreatedError = new Error(`${label}の元パスが削除後に再作成されました。`);
    if (unlinkAttempt.kind === "failed") {
      return new AggregateError(
        [unlinkAttempt.error, sourceRecreatedError],
        `${label}の削除失敗と元パスの再作成を検出しました。`,
        { cause: unlinkAttempt.error },
      );
    }
    return sourceRecreatedError;
  }
  if (unlinkAttempt.kind === "failed") {
    return new Error(`${label}の削除に失敗しました。`, {
      cause: unlinkAttempt.error,
    });
  }
  return new Error(`${label}の隔離先が削除後に再作成されました。`);
}

function classifySecurePersistentFileRemovalFailure(
  isolationPath: string,
  sourcePath: string,
  expected: SecurePersistentFileIdentity,
  parentPath: string,
  parentSnapshot: SecureDirectorySnapshot,
  label: string,
  verificationError: unknown,
  unlinkAttempt: FileOperationResult<void>,
): SecurePersistentFileRemovalResult {
  try {
    assertDirectorySnapshot(parentPath, parentSnapshot, `${label}の親ディレクトリ`);
    const isolation = captureFileWithParent(isolationPath, label);
    const source = captureFileWithParent(sourcePath, label);
    assertDirectorySnapshot(parentPath, parentSnapshot, `${label}の親ディレクトリ`);
    if (matchesSecurePersistentFileIdentity(isolation, expected)) {
      const retainedError = unlinkAttempt.kind === "failed"
        ? new AggregateError(
            [verificationError, unlinkAttempt.error],
            `${label}の削除と削除後検証に失敗しました。`,
            { cause: verificationError },
          )
        : verificationError;
      return {
        kind: "identity_remains",
        location: { kind: "isolation_path", path: isolationPath },
        error: retainedError,
      };
    }
    if (matchesSecurePersistentFileIdentity(source, expected)) {
      return {
        kind: "identity_remains",
        location: { kind: "source_path" },
        error: new Error(`${label}の実体が隔離先以外で確認されました。`, {
          cause: verificationError,
        }),
      };
    }
    return {
      kind: "identity_removed_boundary_violation",
      error: verificationError,
    };
  } catch (inspectionError: unknown) {
    if (unlinkAttempt.kind === "failed") {
      return {
        kind: "identity_remains",
        location: { kind: "isolation_path", path: isolationPath },
        error: new AggregateError(
          [verificationError, inspectionError, unlinkAttempt.error],
          `${label}の削除と削除後検証に失敗しました。`,
          { cause: verificationError },
        ),
      };
    }
    return {
      kind: "identity_removed_boundary_violation",
      error: new AggregateError(
        [verificationError, inspectionError],
        `${label}の削除後に実体を安全に確認できません。`,
        { cause: verificationError },
      ),
    };
  }
}

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
