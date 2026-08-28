import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";

const secureDirectoryMode = 0o700;
const secureFileMode = 0o600;
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "永続保存パスは絶対パスで指定してください。")
  .refine((value) => !value.includes("\0"), "永続保存パスにNUL文字を指定できません。");
const labelSchema = z.string().min(1).max(200);

type MissingPath = {
  readonly kind: "missing";
};

type ExistingPath = {
  readonly kind: "existing";
  readonly stats: BigIntStats;
};

type PathInspection = MissingPath | ExistingPath;

type FileOperationResult<Result> =
  | { readonly kind: "succeeded"; readonly value: Result }
  | { readonly kind: "failed"; readonly error: unknown };

type CloseResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type SecurePersistentFileSnapshot =
  | MissingPath
  | {
      readonly kind: "existing";
      readonly device: bigint;
      readonly inode: bigint;
    };

type SecureDirectorySnapshot = {
  readonly device: bigint;
  readonly inode: bigint;
};

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/** 永続保存ファイルの絶対パスを正規化します。 */
export function normalizeSecurePersistentFilePath(filePath: string): string {
  const normalizedPath = resolve(absolutePathSchema.parse(filePath));
  if (normalizedPath === parse(normalizedPath).root) {
    throw new TypeError("永続保存ファイルにルートパスを指定できません。");
  }
  return normalizedPath;
}

function normalizeDirectoryPath(directoryPath: string): string {
  return resolve(absolutePathSchema.parse(directoryPath));
}

function validateLabel(label: string): string {
  return labelSchema.parse(label);
}

function inspectPathWithoutSymlinks(
  absolutePath: string,
  label: string,
): PathInspection {
  const rootPath = parse(absolutePath).root;
  let currentPath = rootPath;
  let stats: BigIntStats;
  try {
    stats = lstatSync(rootPath, { bigint: true });
  } catch (error) {
    throw new Error(`${label}のルートパスを確認できません。`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label}のパスにシンボリックリンクを指定できません。`);
  }
  const segments = relative(rootPath, absolutePath)
    .split(sep)
    .filter((segment) => segment.length > 0);
  for (const [index, segment] of segments.entries()) {
    currentPath = join(currentPath, segment);
    try {
      stats = lstatSync(currentPath, { bigint: true });
    } catch (error) {
      if (isNoEntryError(error)) {
        return { kind: "missing" };
      }
      throw new Error(`${label}のパスを確認できません。`, { cause: error });
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label}のパスにシンボリックリンクを指定できません。`);
    }
    if (index < segments.length - 1 && !stats.isDirectory()) {
      throw new Error(`${label}の親パスはディレクトリでなければなりません。`);
    }
  }
  return { kind: "existing", stats };
}

function assertUsableIdentity(stats: BigIntStats, label: string): void {
  if (stats.dev < 0n || stats.ino <= 0n) {
    throw new Error(`${label}のデバイス番号とinodeを確認できません。`);
  }
}

function assertSameIdentity(
  expected: BigIntStats,
  actual: BigIntStats,
  label: string,
): void {
  assertUsableIdentity(expected, label);
  assertUsableIdentity(actual, label);
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) {
    throw new Error(`${label}の実体が検証中に変化しました。`);
  }
}

function assertOwnedByCurrentUser(stats: BigIntStats, label: string): void {
  if (process.platform === "win32") {
    return;
  }
  if (typeof process.getuid !== "function") {
    throw new Error("現在ユーザーのIDを確認できません。");
  }
  if (stats.uid !== BigInt(process.getuid())) {
    throw new Error(`${label}は現在のユーザーが所有していません。`);
  }
}

function assertDirectoryStats(stats: BigIntStats, label: string): void {
  if (!stats.isDirectory()) {
    throw new Error(`${label}は通常ディレクトリでなければなりません。`);
  }
  assertOwnedByCurrentUser(stats, label);
  if (
    process.platform !== "win32"
    && (stats.mode & 0o7777n) !== BigInt(secureDirectoryMode)
  ) {
    throw new Error(`${label}の権限は0700でなければなりません。`);
  }
  assertUsableIdentity(stats, label);
}

function assertFileStats(stats: BigIntStats, label: string): void {
  if (!stats.isFile()) {
    throw new Error(`${label}は通常ファイルでなければなりません。`);
  }
  assertOwnedByCurrentUser(stats, label);
  if (
    process.platform !== "win32"
    && (stats.mode & 0o7777n) !== BigInt(secureFileMode)
  ) {
    throw new Error(`${label}の権限は0600でなければなりません。`);
  }
  assertUsableIdentity(stats, label);
}

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

function runWithFileDescriptor<Result>(
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

function captureDirectory(
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

function assertDirectorySnapshot(
  directoryPath: string,
  expected: SecureDirectorySnapshot,
  label: string,
): void {
  const actual = captureDirectory(directoryPath, label);
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error(`${label}の実体が操作中に変化しました。`);
  }
}

function inspectFilePath(filePath: string, label: string): PathInspection {
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

function openValidatedFile(
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

function snapshotFromStats(stats: BigIntStats): SecurePersistentFileSnapshot {
  return { kind: "existing", device: stats.dev, inode: stats.ino };
}

function assertSnapshotEqual(
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

function assertStatsMatchSnapshot(
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

function captureFileWithParent(
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

function removeTemporaryFile(
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
): void {
  const actual = captureSecurePersistentFile(filePath, label);
  assertSnapshotEqual(expected, actual, validateLabel(label));
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

/** 永続保存テキストを検証済みファイルハンドルから読み取ります。 */
export function readSecurePersistentTextFile(
  filePath: string,
  label: string,
): string | undefined {
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
      const buffer = readFileSync(descriptor);
      const afterReadStats = fstatSync(descriptor, { bigint: true });
      assertFileStats(afterReadStats, validatedLabel);
      assertSameIdentity(openedStats, afterReadStats, validatedLabel);
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
      return buffer.toString("utf8");
    },
    `${validatedLabel}の読み取りとファイル終了に失敗しました。`,
  );
  assertDirectorySnapshot(parentPath, parentSnapshot, parentLabel);
  return readResult;
}

/** 永続保存テキストを0600の一時ファイルから原子的に保存します。 */
export function writeSecurePersistentTextFileAtomically(
  filePath: string,
  content: string,
  label: string,
): void {
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
  let saveResult: FileOperationResult<void>;
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
    assertSnapshotEqual(securedTemporary, savedTarget, validatedLabel);
    saveResult = { kind: "succeeded", value: undefined };
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
