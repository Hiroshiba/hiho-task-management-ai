import { z } from "zod";
import { setupStateSchema, type SetupState } from "../../shared/setup";
import {
  captureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
  readSecurePersistentTextFile,
  writeSecurePersistentTextFileAtomically,
} from "../local-storage-path";

const checkpointVersion = 1;

const checkpointSchema = z
  .object({
    version: z.literal(checkpointVersion),
    state: setupStateSchema,
  })
  .strict();

/** 初回設定状態を秘密なしのJSONとして原子的に保存します。 */
export class SetupCheckpointStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = normalizeSecurePersistentFilePath(filePath);
    captureSecurePersistentFile(this.filePath, "初回設定チェックポイント");
  }

  /** 保存済み初回設定状態を検証して読み出します。 */
  public load(): SetupState | undefined {
    const serialized = readSecurePersistentTextFile(
      this.filePath,
      "初回設定チェックポイント",
    );
    if (serialized == null) {
      return undefined;
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
    const serialized = JSON.stringify(
      checkpointSchema.parse({ version: checkpointVersion, state: validatedState }),
    );
    writeSecurePersistentTextFileAtomically(
      this.filePath,
      serialized,
      "初回設定チェックポイント",
    );
  }
}
