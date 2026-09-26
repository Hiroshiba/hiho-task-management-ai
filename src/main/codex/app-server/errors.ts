export {
  CodexProtocolError,
  CodexUnknownResponseIdError,
  CodexRpcError,
  CodexResponseValidationError,
  CodexConnectionStateError,
  CodexConnectionStoppedError,
  CodexPendingRequestLimitError,
  CodexRequestTimeoutError,
  CodexRequestAbortedError,
  CodexRequestIdExhaustedError,
  codexRpcOperationSchema,
  codexRpcCodeSchema,
  codexRpcMessageSchema,
  type CodexProtocolFailureCode,
  type CodexRpcOperation,
} from "../../infrastructure/ai/codex-app-server/errors";

/** Codex CLI実行ファイルが見つからないことを表します。 */
export class CodexExecutableNotFoundError extends Error {
  public constructor() {
    super("Codex CLI実行ファイルが見つかりません。");
    this.name = "CodexExecutableNotFoundError";
  }
}

/** Codex CLIの版取得コマンドが失敗したことを表します。 */
export class CodexVersionCommandError extends Error {
  public constructor(cause: unknown) {
    super("Codex CLIの版を取得できませんでした。", { cause });
    this.name = "CodexVersionCommandError";
  }
}

/** Codex app-serverプロセスが異常終了したことを表します。 */
export class CodexProcessExitError extends Error {
  public readonly exitCode: number | null;
  public readonly signal: string | null;

  public constructor(exitCode: number | null, signal: string | null) {
    super(
      `Codex app-serverプロセスが異常終了しました。終了コードは${exitCode == null ? "ありません" : exitCode}、シグナルは${signal == null ? "ありません" : signal}。`,
    );
    this.name = "CodexProcessExitError";
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

/** Codex app-serverプロセスが入出力エラーを起こしたことを表します。 */
export class CodexProcessError extends Error {
  public constructor(cause: unknown) {
    super("Codex app-serverプロセスで入出力エラーが発生しました。", { cause });
    this.name = "CodexProcessError";
  }
}

/** Codex app-serverの強制停止が時間内に完了しなかったことを表します。 */
export class CodexStopTimeoutError extends Error {
  public constructor() {
    super("Codex app-serverの強制停止が時間内に完了しませんでした。");
    this.name = "CodexStopTimeoutError";
  }
}
/** Codex app-serverへ要求を書き込めないことを表します。 */
export class CodexWriteError extends Error {
  public constructor(cause: unknown) {
    super("Codex app-serverへ要求を書き込めません。", { cause });
    this.name = "CodexWriteError";
  }
}

/** Codex app-serverの標準入出力を初期化できないことを表します。 */
export class CodexStdioError extends Error {
  public constructor(cause?: unknown) {
    super(
      "Codex app-serverの標準入出力を初期化できません。",
      cause == null ? undefined : { cause },
    );
    this.name = "CodexStdioError";
  }
}
