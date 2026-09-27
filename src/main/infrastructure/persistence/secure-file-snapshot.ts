import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
  statSync,
  unlinkSync,
  type BigIntStats,
} from "node:fs";
import { dirname } from "node:path";
import {
  assertDirectoryStats,
  assertFileStats,
  assertSameIdentity,
  assertUsableIdentity,
  errorCode,
  inspectPathWithoutSymlinks,
  normalizeSecurePersistentFilePath,
  secureFileMode,
  validateLabel,
  type PathInspection,
  type SecureDirectorySnapshot,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileSnapshot,
} from "./secure-path-guard";

export type FileOperationResult<Result> =
  | { readonly kind: "succeeded"; readonly value: Result }
  | { readonly kind: "failed"; readonly error: unknown };

type CloseResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

function getReadOpenFlags(): number {
  let flags = constants.O_RDONLY;
  if (
    process.platform !== "win32"
    && Number.isSafeInteger(constants.O_NOFOLLOW)
    && constants.O_NOFOLLOW > 0
  ) {
    flags |= constants.O_NOFOLLOW;
  }
  if (
    process.platform !== "win32"
    && Number.isSafeInteger(constants.O_NONBLOCK)
    && constants.O_NONBLOCK > 0
  ) {
    flags |= constants.O_NONBLOCK;
  }
  return flags;
}

/** ファイルハンドルの操作と終了を一括して実行します。 */
export function runWithFileDescriptor<Result>(
  descriptor: number,
  operation: () => Result,
  failureMessage: string,
): Result {
  let operationResult: FileOperationResult<Result>;
  try {
    operationResult = { kind: "succeeded", value: operation() };
  } catch (error) {
    operationResult = { kind: "failed", error };
  }
  let closeResult: CloseResult;
  try {
    closeSync(descriptor);
    closeResult = { kind: "succeeded" };
  } catch (error) {
    closeResult = { kind: "failed", error };
  }
  if (operationResult.kind === "failed" && closeResult.kind === "failed") {
    throw new AggregateError(
      [operationResult.error, closeResult.error],
      failureMessage,
      { cause: operationResult.error },
    );
  }
  if (operationResult.kind === "failed") {
    throw operationResult.error;
  }
  if (closeResult.kind === "failed") {
    throw closeResult.error;
  }
  return operationResult.value;
}

/** 安全なディレクトリの実体を取得します。 */
export function captureDirectory(
  directoryPath: string,
  label: string,
): SecureDirectorySnapshot {
  const inspection = inspectPathWithoutSymlinks(directoryPath, label);
  if (inspection.kind === "missing") {
    throw new Error(`${label}が存在しません。`);
  }
  assertDirectoryStats(inspection.stats, label);
  let followedStats: BigIntStats;
  try {
    followedStats = statSync(directoryPath, { bigint: true });
  } catch (error) {
    throw new Error(`${label}の実体を確認できません。`, { cause: error });
  }
  assertDirectoryStats(followedStats, label);
  assertSameIdentity(inspection.stats, followedStats, label);
  return { device: followedStats.dev, inode: followedStats.ino };
}

/** ディレクトリの実体が変化していないことを検証します。 */
export function assertDirectorySnapshot(
  directoryPath: string,
  expected: SecureDirectorySnapshot,
  label: string,
): void {
  const actual = captureDirectory(directoryPath, label);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`${label}の実体が操作中に変化しました。`);
  }
}

/** ファイルパスの安全な実体を検査します。 */
export function inspectFilePath(filePath: string, label: string): PathInspection {
  const inspection = inspectPathWithoutSymlinks(filePath, label);
  if (inspection.kind === "missing") {
    return inspection;
  }
  assertFileStats(inspection.stats, label);
  let followedStats: BigIntStats;
  try {
    followedStats = statSync(filePath, { bigint: true });
  } catch (error) {
    throw new Error(`${label}の実体を確認できません。`, { cause: error });
  }
  assertFileStats(followedStats, label);
  assertSameIdentity(inspection.stats, followedStats, label);
  return { kind: "existing", stats: followedStats };
}

/** 実体を検証してファイルを開きます。 */
export function openValidatedFile(
  filePath: string,
  expected: BigIntStats,
  label: string,
): number {
  let descriptor: number;
  try {
    descriptor = openSync(filePath, getReadOpenFlags());
  } catch (error) {
    const code = errorCode(error);
    if (code === "ELOOP") {
      throw new Error(`${label}にシンボリックリンクを指定できません。`, { cause: error });
    }
    throw new Error(`${label}を安全に開けません。`, { cause: error });
  }
  try {
    const openedStats = fstatSync(descriptor, { bigint: true });
    assertFileStats(openedStats, label);
    assertSameIdentity(expected, openedStats, label);
    const openedPathInspection = inspectFilePath(filePath, label);
    if (openedPathInspection.kind === "missing") {
      throw new Error(`${label}がオープン中に消失しました。`);
    }
    assertSameIdentity(openedStats, openedPathInspection.stats, label);
  } catch (error) {
    try {
      closeSync(descriptor);
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        `${label}の検証とファイル終了に失敗しました。`,
        { cause: error },
      );
    }
    throw error;
  }
  return descriptor;
}

/** ファイル情報から実体の記録を作ります。 */
export function snapshotFromStats(stats: BigIntStats): SecurePersistentFileSnapshot {
  return { kind: "existing", device: stats.dev, inode: stats.ino };
}

/** ファイル実体の記録が一致することを検証します。 */
export function assertSnapshotEqual(
  expected: SecurePersistentFileSnapshot,
  actual: SecurePersistentFileSnapshot,
  label: string,
): void {
  if (expected.kind === "missing") {
    if (actual.kind === "existing") {
      throw new Error(`${label}が操作中に作成されました。`);
    }
    return;
  }
  if (actual.kind === "missing") {
    throw new Error(`${label}が操作中に消失しました。`);
  }
  if (expected.device !== actual.device || expected.inode !== actual.inode) {
    throw new Error(`${label}の実体が操作中に変化しました。`);
  }
}

/** ファイル実体が指定された実体に一致するか調べます。 */
export function matchesSecurePersistentFileIdentity(
  snapshot: SecurePersistentFileSnapshot,
  expected: SecurePersistentFileIdentity,
): boolean {
  return snapshot.kind === "existing"
    && snapshot.device === expected.device
    && snapshot.inode === expected.inode;
}

/** ファイル情報と実体の記録が一致することを検証します。 */
export function assertStatsMatchSnapshot(
  stats: BigIntStats,
  snapshot: SecurePersistentFileSnapshot,
  label: string,
): void {
  if (snapshot.kind === "missing") {
    throw new Error(`${label}が検証中に消失しました。`);
  }
  assertUsableIdentity(stats, label);
  if (stats.dev !== snapshot.device || stats.ino !== snapshot.inode) {
    throw new Error(`${label}の実体が検証中に変化しました。`);
  }
}

/** 親ディレクトリを含めてファイルの実体を取得します。 */
export function captureFileWithParent(
  filePath: string,
  label: string,
): SecurePersistentFileSnapshot {
  const parentPath = dirname(filePath);
  const parentSnapshot = captureDirectory(parentPath, `${label}の親ディレクトリ`);
  const inspection = inspectFilePath(filePath, label);
  if (inspection.kind === "missing") {
    assertDirectorySnapshot(
      parentPath,
      parentSnapshot,
      `${label}の親ディレクトリ`,
    );
    return { kind: "missing" };
  }
  const descriptor = openValidatedFile(filePath, inspection.stats, label);
  const openedStats = runWithFileDescriptor(
    descriptor,
    () => fstatSync(descriptor, { bigint: true }),
    `${label}の確認とファイル終了に失敗しました。`,
  );
  assertFileStats(openedStats, label);
  assertSameIdentity(inspection.stats, openedStats, label);
  assertDirectorySnapshot(
    parentPath,
    parentSnapshot,
    `${label}の親ディレクトリ`,
  );
  const finalInspection = inspectFilePath(filePath, label);
  if (finalInspection.kind === "missing") {
    throw new Error(`${label}が検証中に消失しました。`);
  }
  assertSameIdentity(openedStats, finalInspection.stats, label);
  return snapshotFromStats(openedStats);
}

/** 実体を検証して一時ファイルを削除します。 */
export function removeTemporaryFile(
  filePath: string,
  expected: SecurePersistentFileSnapshot,
  label: string,
): void {
  const current = captureFileWithParent(filePath, label);
  if (current.kind === "missing") {
    return;
  }
  assertSnapshotEqual(expected, current, label);
  unlinkSync(filePath);
}

/** 永続保存ファイルの現在の安全な実体を取得します。 */
export function captureSecurePersistentFile(
  filePath: string,
  label: string,
): SecurePersistentFileSnapshot {
  return captureFileWithParent(
    normalizeSecurePersistentFilePath(filePath),
    validateLabel(label),
  );
}

/** 永続保存ファイルが同じ安全な実体であることを検証します。 */
export function assertSecurePersistentFileSnapshot(
  filePath: string,
  expected: SecurePersistentFileSnapshot,
  label: string,
): SecurePersistentFileSnapshot {
  const actual = captureSecurePersistentFile(filePath, label);
  assertSnapshotEqual(expected, actual, validateLabel(label));
  return actual;
}

/** 永続保存ファイルを検証し、未作成なら0600の空ファイルを作成します。 */
export function ensureSecurePersistentFile(
  filePath: string,
  label: string,
): SecurePersistentFileSnapshot {
  const normalizedPath = normalizeSecurePersistentFilePath(filePath);
  const validatedLabel = validateLabel(label);
  const existing = captureFileWithParent(normalizedPath, validatedLabel);
  if (existing.kind === "existing") {
    return existing;
  }
  const parentPath = dirname(normalizedPath);
  const parentSnapshot = captureDirectory(
    parentPath,
    `${validatedLabel}の親ディレクトリ`,
  );
  let descriptor: number;
  try {
    descriptor = openSync(normalizedPath, "wx", secureFileMode);
  } catch (error) {
    throw new Error(`${validatedLabel}を0600で作成できません。`, { cause: error });
  }
  const createdStats = runWithFileDescriptor(
    descriptor,
    () => {
      if (process.platform !== "win32") {
        fchmodSync(descriptor, secureFileMode);
      }
      const stats = fstatSync(descriptor, { bigint: true });
      assertFileStats(stats, validatedLabel);
      return stats;
    },
    `${validatedLabel}の作成とファイル終了に失敗しました。`,
  );
  assertDirectorySnapshot(
    parentPath,
    parentSnapshot,
    `${validatedLabel}の親ディレクトリ`,
  );
  const created = captureFileWithParent(normalizedPath, validatedLabel);
  if (created.kind === "missing") {
    throw new Error(`${validatedLabel}を作成後に確認できません。`);
  }
  assertStatsMatchSnapshot(createdStats, created, validatedLabel);
  return created;
}
