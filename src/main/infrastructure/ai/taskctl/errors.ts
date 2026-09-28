/** taskctlブローカーの処理に失敗したことを表します。 */
export class TaskctlBrokerError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskctlBrokerError";
  }
}

/** taskctl要求の実行時間が上限を超えたことを表します。 */
export class TaskctlExecutionTimeoutError extends TaskctlBrokerError {
  public constructor() {
    super("taskctl要求の実行時間が上限を超えました。");
    this.name = "TaskctlExecutionTimeoutError";
  }
}

/** taskctlブローカーの要求がAbortSignalで中断されたことを表します。 */
export class TaskctlAbortError extends Error {
  public constructor() {
    super("taskctlブローカーの起動が中断されました。");
    this.name = "TaskctlAbortError";
  }
}
