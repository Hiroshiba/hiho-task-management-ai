/** AIワークフローの処理失敗を表す基底エラーです。 */
export class AiWorkflowError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause == null ? undefined : { cause });
    this.name = "AiWorkflowError";
  }
}

/** 同期済み状態を取得できないためAIターンを開始できないことを表すエラーです。 */
export class AiWorkflowSyncError extends AiWorkflowError {
  public constructor(cause: unknown) {
    super("AIターン前の同期済み状態を取得できません。", cause);
    this.name = "AiWorkflowSyncError";
  }
}

/** 変更案が存在しないことを表すエラーです。 */
export class AiWorkflowProposalNotFoundError extends AiWorkflowError {
  public constructor() {
    super("指定した変更案は存在しません。");
    this.name = "AiWorkflowProposalNotFoundError";
  }
}

/** 変更案の選択が不正であることを表すエラーです。 */
export class AiWorkflowSelectionError extends AiWorkflowError {
  public constructor(message: string) {
    super(message);
    this.name = "AiWorkflowSelectionError";
  }
}

/** 変更案の利用者編集が不正であることを表すエラーです。 */
export class AiWorkflowEditError extends AiWorkflowError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "AiWorkflowEditError";
  }
}

/** オフラインのため変更案を承認できないことを表すエラーです。 */
export class AiWorkflowOfflineError extends AiWorkflowError {
  public constructor() {
    super("オンライン接続がないため変更案を承認できません。");
    this.name = "AiWorkflowOfflineError";
  }
}

/** AIワークフローの状態が要求と一致しないことを表すエラーです。 */
export class AiWorkflowStateError extends AiWorkflowError {
  public constructor(message: string) {
    super(message);
    this.name = "AiWorkflowStateError";
  }
}
