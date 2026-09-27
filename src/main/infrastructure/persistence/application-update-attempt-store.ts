import { z } from "zod";
import type { PersistentTextFile } from "./persistent-text-file";

export const stableVersionSchema = z.string().max(64).regex(/^\d+\.\d+\.\d+$/);

const applicationUpdateAttemptSchema = z.object({
  targetVersion: stableVersionSchema,
  status: z.enum(["pending", "failed"]),
}).strict();

type ApplicationUpdateAttempt = z.infer<typeof applicationUpdateAttemptSchema>;

/** アプリ本体の更新試行を安全なファイルへ保存します。 */
export class ApplicationUpdateAttemptStore {
  public constructor(private readonly file: PersistentTextFile) {}

  /** 保存済みの更新試行を読み出します。 */
  public load(): ApplicationUpdateAttempt | undefined {
    const serialized = this.file.readWithByteLimit(1_024);
    if (serialized == null) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(serialized);
    return applicationUpdateAttemptSchema.parse(parsed);
  }

  /** 更新試行を原子的に保存します。 */
  public save(attempt: ApplicationUpdateAttempt): void {
    this.file.replaceAtomically(
      JSON.stringify(applicationUpdateAttemptSchema.parse(attempt)),
      "アプリ本体の更新試行",
    );
  }

  /** 保存済みの更新試行を削除します。 */
  public clear(): void {
    this.file.remove();
  }
}
