import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { z } from "zod";
import { setupStateSchema, type SetupState } from "../../shared/setup";

const checkpointVersion = 1;
const directoryMode = 0o700;
const fileMode = 0o600;

const checkpointSchema = z
  .object({
    version: z.literal(checkpointVersion),
    state: setupStateSchema,
  })
  .strict();

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validatePath(filePath: string): string {
  if (typeof filePath !== "string" || !isAbsolute(filePath)) {
    throw new TypeError("初回設定チェックポイントのパスは絶対パスで指定してください。");
  }
  const normalizedPath = resolve(filePath);
  if (normalizedPath === parse(normalizedPath).root) {
    throw new TypeError("初回設定チェックポイントへルートを指定できません。");
  }
  return normalizedPath;
}

function ensureDirectory(directoryPath: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(directoryPath);
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      throw error;
    }
    mkdirSync(directoryPath, { recursive: true, mode: directoryMode });
    stats = lstatSync(directoryPath);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("初回設定チェックポイントの保存先が不正です。");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== directoryMode) {
    throw new Error("初回設定チェックポイントの保存先権限が不正です。");
  }
}

function removeTemporaryFile(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      throw error;
    }
  }
}

/** 初回設定状態を秘密なしのJSONとして原子的に保存します。 */
export class SetupCheckpointStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = validatePath(filePath);
  }

  /** 保存済み初回設定状態を検証して読み出します。 */
  public load(): SetupState | undefined {
    let serialized: string;
    try {
      serialized = readFileSync(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNoEntryError(error)) {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error: unknown) {
      throw new Error("初回設定チェックポイントのJSONが不正です。", { cause: error });
    }
    try {
      return checkpointSchema.parse(parsed).state;
    } catch (error: unknown) {
      throw new Error("初回設定チェックポイントの内容が不正です。", { cause: error });
    }
  }

  /** 初回設定状態を一時ファイルから原子的に保存します。 */
  public save(state: SetupState): void {
    const validatedState = setupStateSchema.parse(state);
    const directoryPath = dirname(this.filePath);
    ensureDirectory(directoryPath);
    const temporaryFilePath = `${this.filePath}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(
      checkpointSchema.parse({ version: checkpointVersion, state: validatedState }),
    );
    try {
      writeFileSync(temporaryFilePath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: fileMode,
      });
      chmodSync(temporaryFilePath, fileMode);
      renameSync(temporaryFilePath, this.filePath);
    } catch (error: unknown) {
      try {
        removeTemporaryFile(temporaryFilePath);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "初回設定チェックポイントの保存と後処理に失敗しました。",
          { cause: error },
        );
      }
      throw error;
    }
  }
}
