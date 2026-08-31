import { z } from "zod";

/** Codexセッション処理の基底エラーです。 */
export class CodexSessionError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause == null ? undefined : { cause });
    this.name = "CodexSessionError";
  }
}

/** Codexセッションの状態が要求と一致しないことを表します。 */
export class CodexSessionStateError extends CodexSessionError {
  public constructor() {
    super("Codexセッションの状態ではこの操作を実行できません。");
    this.name = "CodexSessionStateError";
  }
}

/** CodexセッションのAI機能が無効化されたことを表します。 */
export class CodexSessionDisabledError extends CodexSessionError {
  public constructor(cause?: unknown) {
    super("CodexセッションのAI機能は無効です。", cause);
    this.name = "CodexSessionDisabledError";
  }
}

/** ChatGPT認証を利用できないことを表します。 */
export class CodexSessionAuthenticationError extends CodexSessionError {
  public constructor() {
    super("ChatGPTのCodex認証を利用できません。");
    this.name = "CodexSessionAuthenticationError";
  }
}

/** Codexセッションの能力検査に失敗したことを表します。 */
export class CodexSessionCapabilityError extends CodexSessionError {
  public constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "CodexSessionCapabilityError";
  }
}

export const codexThreadStartCapabilityFailureCodeSchema = z.enum([
  "model_mismatch",
  "cwd_mismatch",
  "approval_policy_mismatch",
  "instruction_source_missing",
  "instruction_source_unexpected",
  "sandbox_invalid",
  "sandbox_danger_full_access",
  "sandbox_read_only_network_enabled",
  "sandbox_external_restricted",
  "sandbox_external_enabled",
]);

export type CodexThreadStartCapabilityFailureCode = z.infer<
  typeof codexThreadStartCapabilityFailureCodeSchema
>;

/** Codexスレッド開始後の能力検査に失敗したことを表します。 */
export class CodexThreadStartCapabilityError extends CodexSessionCapabilityError {
  public readonly failureCode: CodexThreadStartCapabilityFailureCode;

  public constructor(failureCode: CodexThreadStartCapabilityFailureCode) {
    super("Codexスレッドの権限制約を確認できません。");
    this.name = "CodexThreadStartCapabilityError";
    this.failureCode = codexThreadStartCapabilityFailureCodeSchema.parse(failureCode);
  }
}

/** Codex接続の安全性を確認できないことを表します。 */
export class CodexSessionSafetyViolationError extends CodexSessionCapabilityError {
  public constructor(cause?: unknown) {
    super("Codex接続の安全性を確認できないためAIを開始できません。", cause);
    this.name = "CodexSessionSafetyViolationError";
  }
}

/** AIターン直前の同期に失敗したことを表します。 */
export class CodexSessionSyncError extends CodexSessionError {
  public constructor(cause: unknown) {
    super("AIターン開始前の同期に失敗しました。", cause);
    this.name = "CodexSessionSyncError";
  }
}

/** Codexターンの実行に失敗したことを表します。 */
export class CodexSessionTurnError extends CodexSessionError {
  public constructor(cause?: unknown) {
    super("Codexターンを完了できませんでした。", cause);
    this.name = "CodexSessionTurnError";
  }
}

/** Codexターンの構造化出力を検証できないことを表します。 */
export class CodexSessionOutputValidationError extends CodexSessionError {
  public constructor(cause: unknown) {
    super("Codexの最終応答を構造化出力として検証できません。", cause);
    this.name = "CodexSessionOutputValidationError";
  }
}

/** CodexターンがAbortSignalで中断されたことを表します。 */
export class CodexSessionAbortedError extends CodexSessionError {
  public constructor() {
    super("Codexターンが中断されました。");
    this.name = "CodexSessionAbortedError";
  }
}
