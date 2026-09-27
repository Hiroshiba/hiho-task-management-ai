import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  inspectPathWithoutSymlinks,
  normalizeDirectoryPath,
  normalizeSecurePersistentFilePath,
  secureDirectoryMode,
  validateLabel,
  type SecureDirectorySnapshot,
  type SecurePersistentFileIdentity,
  type SecurePersistentFileSnapshot,
} from "./infrastructure/persistence/secure-path-guard";
import {
  assertDirectorySnapshot,
  assertSnapshotEqual,
  captureDirectory,
  captureFileWithParent,
  matchesSecurePersistentFileIdentity,
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
} from "./infrastructure/persistence/secure-file-snapshot";
export {
  SecurePersistentFileSizeLimitError,
  readSecurePersistentTextFile,
  readSecurePersistentTextFileWithByteLimit,
  readSecurePersistentFileBytesWithByteLimit,
  writeSecurePersistentTextFileAtomically,
  removeSecurePersistentFile,
} from "./infrastructure/persistence/persistent-text-file";

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
