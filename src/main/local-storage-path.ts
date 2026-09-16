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
  readSync,
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

export type SecurePersistentFileSnapshot =
  | MissingPath
  | {
      readonly kind: "existing";
      readonly device: bigint;
      readonly inode: bigint;
    };

export type SecurePersistentFileIdentity = Extract<
  SecurePersistentFileSnapshot,
  { readonly kind: "existing" }
>;

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

type SecureDirectorySnapshot = {
  readonly device: bigint;
  readonly inode: bigint;
};

type PersistentTextFileReadLimit =
  | { readonly kind: "unbounded" }
  | { readonly kind: "bounded"; readonly maximumBytes: number };

const persistentTextFileReadLimitSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER - 1);

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

function matchesSecurePersistentFileIdentity(
  snapshot: SecurePersistentFileSnapshot,
  expected: SecurePersistentFileIdentity,
): boolean {
  return snapshot.kind === "existing"
    && snapshot.device === expected.device
    && snapshot.inode === expected.inode;
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
): SecurePersistentFileSnapshot {
  const actual = captureSecurePersistentFile(filePath, label);
  assertSnapshotEqual(expected, actual, validateLabel(label));
  return actual;
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
