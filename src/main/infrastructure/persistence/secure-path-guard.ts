import { lstatSync, type BigIntStats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";

export const secureDirectoryMode = 0o700;
export const secureFileMode = 0o600;
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

export type PathInspection = MissingPath | ExistingPath;

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

export type SecureDirectorySnapshot = {
  readonly device: bigint;
  readonly inode: bigint;
};

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** ファイル操作の例外からコードを読み取ります。 */
export function errorCode(error: unknown): string | undefined {
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

/** 永続保存ディレクトリの絶対パスを正規化します。 */
export function normalizeDirectoryPath(directoryPath: string): string {
  return resolve(absolutePathSchema.parse(directoryPath));
}

/** 永続保存対象の表示名を検証します。 */
export function validateLabel(label: string): string {
  return labelSchema.parse(label);
}

/** パスの各階層を調べ、シンボリックリンクを拒否します。 */
export function inspectPathWithoutSymlinks(
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

/** 実体の識別に使うデバイス番号とinodeを検証します。 */
export function assertUsableIdentity(stats: BigIntStats, label: string): void {
  if (stats.dev < 0n || stats.ino <= 0n) {
    throw new Error(`${label}のデバイス番号とinodeを確認できません。`);
  }
}

/** 検査前後のファイル実体が一致することを検証します。 */
export function assertSameIdentity(
  expected: BigIntStats,
  actual: BigIntStats,
  label: string,
): void {
  assertUsableIdentity(expected, label);
  assertUsableIdentity(actual, label);
  const deviceMatches = expected.dev === actual.dev
    || (process.platform === "win32" && (expected.dev === 0n || actual.dev === 0n));
  if (!deviceMatches || expected.ino !== actual.ino) {
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

/** ディレクトリの種類、所有者、権限を検証します。 */
export function assertDirectoryStats(stats: BigIntStats, label: string): void {
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

/** ファイルの種類、所有者、権限を検証します。 */
export function assertFileStats(stats: BigIntStats, label: string): void {
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
