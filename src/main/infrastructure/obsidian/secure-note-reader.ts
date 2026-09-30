import { constants, type BigIntStats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { ObsidianReadError } from "./read-error";
import {
  assertFileStateUnchanged,
  assertSameFileIdentity,
  errorCode,
  isMissingFileSystemError,
  throwIfAborted,
  type ResolvedNotePath,
} from "./vault-path-security";

const maximumFileBytes = 1_048_576;
const maximumTotalReadBytes = 16 * 1_024 * 1_024;
const maximumReadChunkBytes = 64 * 1_024;

export type ReadBudget = {
  total_bytes: number;
};

type ReadAttempt =
  | {
      readonly kind: "succeeded";
      readonly buffer: Buffer;
      readonly stats: BigIntStats;
    }
  | { readonly kind: "failed"; readonly error: unknown };

type ReadFileResult = {
  readonly buffer: Buffer;
  readonly stats: BigIntStats;
};

type CloseAttempt =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

function getSecureFileOpenFlags(): number {
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

function validateFileSize(size: bigint): void {
  if (size < 0n || size > BigInt(maximumFileBytes)) {
    throw new ObsidianReadError(
      "limit_exceeded",
      "Markdownファイルが一ファイルの読取上限を超えています。",
    );
  }
}

/** Vaultの読取量を予約します。 */
export function reserveReadBytes(budget: ReadBudget, size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximumFileBytes) {
    throw new ObsidianReadError(
      "limit_exceeded",
      "Markdownファイルが一ファイルの読取上限を超えています。",
    );
  }
  if (budget.total_bytes + size > maximumTotalReadBytes) {
    throw new ObsidianReadError(
      "limit_exceeded",
      "Vaultの総読取量が上限を超えています。",
    );
  }
  budget.total_bytes += size;
}

/** ファイルの同一性と容量を確認しながら読み取ります。 */
export async function readFileWithLimit(
  resolvedPath: ResolvedNotePath,
  signal: AbortSignal,
): Promise<ReadFileResult> {
  let file: FileHandle;
  try {
    throwIfAborted(signal);
    file = await open(resolvedPath.read_path, getSecureFileOpenFlags());
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
    }
    const code = errorCode(error);
    if (code === "ELOOP") {
      throw new ObsidianReadError(
        "symlink_rejected",
        "シンボリックリンクのMarkdownファイルは読み取れません。",
        error,
      );
    }
    if (isMissingFileSystemError(error)) {
      throw new ObsidianReadError(
        "path_changed",
        "Markdownファイルがオープン前に消失しました。",
        error,
      );
    }
    if (
      code === "EINVAL"
      || code === "ENOTSUP"
      || code === "EOPNOTSUPP"
    ) {
      throw new ObsidianReadError(
        "path_security",
        "Markdownファイルの安全なオープンを保証できません。",
        error,
      );
    }
    throw error;
  }
  let readResult: ReadAttempt | undefined;
  try {
    throwIfAborted(signal);
    const openedStats = await file.stat({ bigint: true });
    if (!openedStats.isFile()) {
      throw new ObsidianReadError(
        "note_not_file",
        "指定されたMarkdownパスは通常ファイルではありません。",
      );
    }
    assertSameFileIdentity(resolvedPath.pre_open_stats, openedStats);
    validateFileSize(openedStats.size);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let readCompleted = false;
    while (!readCompleted && totalBytes <= maximumFileBytes) {
      throwIfAborted(signal);
      const remainingBytes = maximumFileBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(maximumReadChunkBytes, remainingBytes),
      );
      const fileReadResult = await file.read(chunk, 0, chunk.byteLength, null);
      if (fileReadResult.bytesRead === 0) {
        readCompleted = true;
        continue;
      }
      chunks.push(chunk.subarray(0, fileReadResult.bytesRead));
      totalBytes += fileReadResult.bytesRead;
      if (totalBytes > maximumFileBytes) {
        throw new ObsidianReadError(
          "limit_exceeded",
          "Markdownファイルが一ファイルの読取上限を超えています。",
        );
      }
    }
    if (!readCompleted) {
      throw new ObsidianReadError(
        "limit_exceeded",
        "Markdownファイルが一ファイルの読取上限を超えています。",
      );
    }
    if (BigInt(totalBytes) !== openedStats.size) {
      throw new ObsidianReadError(
        "path_changed",
        "Markdownファイルが読み取り中に変更されました。",
      );
    }
    throwIfAborted(signal);
    const afterReadStats = await file.stat({ bigint: true });
    if (!afterReadStats.isFile()) {
      throw new ObsidianReadError(
        "note_not_file",
        "指定されたMarkdownパスは通常ファイルではありません。",
      );
    }
    assertFileStateUnchanged(openedStats, afterReadStats);
    readResult = {
      kind: "succeeded",
      buffer: Buffer.concat(chunks, totalBytes),
      stats: afterReadStats,
    };
  } catch (error) {
    readResult = { kind: "failed", error };
  }
  let closeResult: CloseAttempt;
  try {
    await file.close();
    closeResult = { kind: "succeeded" };
  } catch (error) {
    closeResult = { kind: "failed", error };
  }
  if (readResult == null) {
    throw new Error("Markdownファイルの読取結果を取得できません。");
  }
  if (readResult.kind === "failed" && closeResult.kind === "failed") {
    throw new AggregateError(
      [readResult.error, closeResult.error],
      "Markdownファイルの読取と終了処理に失敗しました。",
      { cause: readResult.error },
    );
  }
  if (readResult.kind === "failed") {
    throw readResult.error;
  }
  if (closeResult.kind === "failed") {
    throw closeResult.error;
  }
  return {
    buffer: readResult.buffer,
    stats: readResult.stats,
  };
}
