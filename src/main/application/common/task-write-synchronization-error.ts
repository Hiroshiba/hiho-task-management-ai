import type { TaskWriteSynchronizationFailureCode } from "./ports/asana-task-write";

/** GUI編集後の同期失敗コードを保存境界まで伝えます。 */
export class TaskWriteSynchronizationError extends Error {
  public constructor(
    public readonly code: TaskWriteSynchronizationFailureCode,
    cause: unknown,
  ) {
    super("書き込み後のAsana同期が完了しませんでした。", { cause });
  }
}
