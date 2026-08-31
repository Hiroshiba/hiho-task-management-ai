import { z } from "zod";

export type CodexProtocolFailureCode =
  | "message_too_large"
  | "json_too_deep"
  | "invalid_message";

export const codexRpcOperationSchema = z.enum([
  "initialize",
  "account/read",
  "account/login/start",
  "model/list",
  "skills/list",
  "permissionProfile/list",
  "mcpServerStatus/list",
  "experimentalFeature/list",
  "thread/start",
  "turn/start",
  "turn/interrupt",
]);

export type CodexRpcOperation = z.infer<typeof codexRpcOperationSchema>;

export const codexRpcCodeSchema = z
  .number()
  .int()
  .min(-2_147_483_648)
  .max(2_147_483_647);

export const codexRpcMessageSchema = z.string().min(1).max(2_000);

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

/** Codex app-serverのJSONL通信が不正であることを表します。 */
export class CodexProtocolError extends Error {
  public readonly failureCode: CodexProtocolFailureCode;

  public constructor(failureCode: CodexProtocolFailureCode, cause: unknown) {
    super("Codex app-serverの通信形式が不正です。", { cause });
    this.name = "CodexProtocolError";
    this.failureCode = failureCode;
  }
}

/** Codex app-serverから未知の応答IDを受け取ったことを表します。 */
export class CodexUnknownResponseIdError extends Error {
  public constructor() {
    super("Codex app-serverから未知の応答IDを受け取りました。");
    this.name = "CodexUnknownResponseIdError";
  }
}

/** Codex app-serverがRPCエラーを返したことを表します。 */
export class CodexRpcError extends Error {
  public readonly operation: CodexRpcOperation;
  public readonly rpcCode: number;
  public readonly rpcMessage: string;

  public constructor(
    operation: CodexRpcOperation,
    rpcCode: number,
    rpcMessage: string,
  ) {
    super("Codex app-serverがRPCエラーを返しました。");
    this.name = "CodexRpcError";
    this.operation = codexRpcOperationSchema.parse(operation);
    this.rpcCode = codexRpcCodeSchema.parse(rpcCode);
    this.rpcMessage = codexRpcMessageSchema.parse(rpcMessage);
  }
}

/** Codex app-serverの応答が期待した型でないことを表します。 */
export class CodexResponseValidationError extends Error {
  public constructor(cause: unknown) {
    super("Codex app-serverの応答を検証できません。", { cause });
    this.name = "CodexResponseValidationError";
  }
}

/** Codex app-serverプロセスが異常終了したことを表します。 */
export class CodexProcessExitError extends Error {
  public readonly exitCode: number | null;
  public readonly signal: string | null;

  public constructor(exitCode: number | null, signal: string | null) {
    super("Codex app-serverプロセスが異常終了しました。");
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

/** Codex app-server接続の状態が要求と一致しないことを表します。 */
export class CodexConnectionStateError extends Error {
  public constructor() {
    super("Codex app-server接続の状態ではこの操作を実行できません。");
    this.name = "CodexConnectionStateError";
  }
}

/** 停止済みのCodex app-server接続へ要求したことを表します。 */
export class CodexConnectionStoppedError extends Error {
  public constructor() {
    super("Codex app-server接続は停止しています。");
    this.name = "CodexConnectionStoppedError";
  }
}

/** Codex app-serverへの保留要求数が上限を超えたことを表します。 */
export class CodexPendingRequestLimitError extends Error {
  public constructor() {
    super("Codex app-serverへの保留要求数が上限を超えました。");
    this.name = "CodexPendingRequestLimitError";
  }
}

/** Codex app-server要求の応答待ち時間が上限を超えたことを表します。 */
export class CodexRequestTimeoutError extends Error {
  public readonly method: string;

  public constructor(method: string) {
    super("Codex app-server要求の応答待ち時間が上限を超えました。");
    this.name = "CodexRequestTimeoutError";
    this.method = method;
  }
}

/** Codex app-server要求がAbortSignalで中断されたことを表します。 */
export class CodexRequestAbortedError extends Error {
  public readonly method: string;

  public constructor(method: string) {
    super("Codex app-server要求が中断されました。");
    this.name = "CodexRequestAbortedError";
    this.method = method;
  }
}

/** Codex app-serverの強制停止が時間内に完了しなかったことを表します。 */
export class CodexStopTimeoutError extends Error {
  public constructor() {
    super("Codex app-serverの強制停止が時間内に完了しませんでした。");
    this.name = "CodexStopTimeoutError";
  }
}

/** Codex app-server要求IDが安全整数の上限へ到達したことを表します。 */
export class CodexRequestIdExhaustedError extends Error {
  public constructor() {
    super("Codex app-server要求IDの上限へ到達しました。");
    this.name = "CodexRequestIdExhaustedError";
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
