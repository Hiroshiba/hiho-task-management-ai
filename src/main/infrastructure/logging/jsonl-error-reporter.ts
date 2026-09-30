import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  errorReportContextSchema,
  type ErrorId,
  type ErrorReportContext,
  type ErrorReporter,
} from "../../application/common/errors/error-reporter";
import { redactKnownSecrets } from "./redact-known-secrets";
import { writeErrorReportFailure } from "./stderr-error-report";

const maximumLogBytes = 1 * 1024 * 1024;
const errorLogFileName = "taskhub-error.log";

type ErrorDetail = {
  error_name: string;
  error_message: string;
  stack_trace: string;
  cause_chain: ErrorDetail[];
  aggregate_errors: ErrorDetail[];
};

const errorDetailSchema: z.ZodType<ErrorDetail> = z.lazy(() =>
  z.object({
    error_name: z.string(),
    error_message: z.string(),
    stack_trace: z.string(),
    cause_chain: z.array(errorDetailSchema),
    aggregate_errors: z.array(errorDetailSchema),
  }).passthrough(),
);

type ErrorLogFormatter = {
  readonly createDetail: (error: unknown) => unknown;
  readonly redactText: (value: string) => string;
};

const errorLogFormatterSchema = z.custom<ErrorLogFormatter>(
  (value) => typeof value === "object" && value != null
    && "createDetail" in value && typeof value.createDetail === "function"
    && "redactText" in value && typeof value.redactText === "function",
  "エラーログの詳細整形が必要です。",
);

const errorLogRecordSchema = z
  .object({
    occurred_at: z.iso.datetime(),
    severity: errorReportContextSchema.shape.level,
    source: errorReportContextSchema.shape.source,
    diagnostic_code: errorReportContextSchema.shape.diagnosticCode,
    context: errorReportContextSchema.shape.context,
    operation_id: errorReportContextSchema.shape.operationId,
    error_id: z.uuid(),
    error: errorDetailSchema,
  })
  .strict();

type ErrorLogRecord = z.infer<typeof errorLogRecordSchema>;
type ReportedState =
  | { readonly kind: "persisted"; readonly errorId: ErrorId }
  | { readonly kind: "fallback"; readonly errorId: ErrorId; readonly failure: unknown };

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "ログ保存先は絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "ログ保存先にNUL文字を指定できません。");

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertRegularFile(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isFile()) {
    throw new Error("永続エラーログの保存先が通常ファイルではありません。");
  }
}

function assertRegularDirectory(path: string): void {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("永続エラーログの保存先が通常ディレクトリではありません。");
  }
}

function removeExistingFile(path: string): void {
  try {
    assertRegularFile(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  unlinkSync(path);
}

function renameExistingFile(source: string, destination: string): void {
  try {
    assertRegularFile(source);
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }
  removeExistingFile(destination);
  renameSync(source, destination);
  if (process.platform !== "win32") {
    chmodSync(destination, 0o600);
  }
}

function writeBuffer(fileDescriptor: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const bytesWritten = writeSync(
      fileDescriptor,
      data,
      offset,
      data.byteLength - offset,
    );
    if (bytesWritten <= 0) {
      throw new Error("永続エラーログを書き込めませんでした。");
    }
    offset += bytesWritten;
  }
}

function normalizeThrownError(error: unknown, message: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(message, { cause: error });
}

function restoreAppendStart(
  fileDescriptor: number,
  appendStartSize: number,
  appendError: unknown,
): never {
  try {
    ftruncateSync(fileDescriptor, appendStartSize);
  } catch (truncateError) {
    throw new AggregateError(
      [appendError, truncateError],
      "永続エラーログの途中書き込みを復元できませんでした。",
    );
  }
  throw normalizeThrownError(appendError, "永続エラーログの書き込みに失敗しました。");
}

/** エラーと警告を単一のJSONLファイルへ記録します。 */
export class JsonlErrorReporter implements ErrorReporter {
  private readonly logsPath: string;
  private readonly errorLogPath: string;
  private readonly knownSecrets: () => readonly string[];
  private readonly formatter: ErrorLogFormatter;
  private readonly reported = new WeakMap<object, ReportedState>();
  private writing = false;

  public constructor(
    logsPath: string,
    knownSecrets: () => readonly string[],
    formatter: ErrorLogFormatter,
  ) {
    const validatedLogsPath = absolutePathSchema.parse(logsPath);
    this.knownSecrets = knownSecrets;
    this.formatter = errorLogFormatterSchema.parse(formatter);
    this.logsPath = resolve(validatedLogsPath);
    this.errorLogPath = join(this.logsPath, errorLogFileName);
    mkdirSync(this.logsPath, { recursive: true, mode: 0o700 });
    assertRegularDirectory(this.logsPath);
    if (process.platform !== "win32") {
      chmodSync(this.logsPath, 0o700);
    }
  }

  /** 同じエラーを重複させず、保存または標準エラーへの記録後にIDを返します。 */
  public reportErrorOnce(error: unknown, context: ErrorReportContext): ErrorId {
    return this.report(error, context, false);
  }

  /** JSONLの保存失敗を呼び出し元へ伝え、同じエラーを重複記録しません。 */
  public reportErrorOnceStrict(error: unknown, context: ErrorReportContext): ErrorId {
    return this.report(error, context, true);
  }

  private report(error: unknown, context: ErrorReportContext, strict: boolean): ErrorId {
    const validatedContext = errorReportContextSchema.parse(context);
    const existing = this.reportedState(error);
    if (existing != null) {
      if (strict && existing.kind === "fallback") {
        throw existing.failure;
      }
      return existing.errorId;
    }
    const errorId = randomUUID();
    const reportableError = error instanceof Error
      ? error
      : new Error("Error以外の値が例外として渡されました。", { cause: error });
    try {
      const record = errorLogRecordSchema.parse({
        occurred_at: new Date().toISOString(),
        severity: validatedContext.level,
        source: validatedContext.source,
        diagnostic_code: validatedContext.diagnosticCode,
        context: validatedContext.context,
        ...(validatedContext.operationId == null
          ? {}
          : { operation_id: validatedContext.operationId }),
        error_id: errorId,
        error: this.formatter.createDetail(reportableError),
      });
      this.writeRecord(record);
      this.markReported(error, { kind: "persisted", errorId });
    } catch (failure) {
      const fallbackError = new AggregateError(
        [reportableError, failure],
        "永続エラーログの保存に失敗しました。",
        { cause: reportableError },
      );
      writeErrorReportFailure(fallbackError, this.knownSecrets(), this.formatter.redactText);
      const fallbackState = { kind: "fallback", errorId, failure } satisfies ReportedState;
      this.markReported(error, fallbackState);
      this.markReported(failure, fallbackState);
      if (strict) {
        throw failure;
      }
    }
    return errorId;
  }

  private reportedState(error: unknown): ReportedState | undefined {
    if ((typeof error !== "object" || error == null) && typeof error !== "function") {
      return undefined;
    }
    return this.reported.get(error);
  }

  private markReported(error: unknown, state: ReportedState): void {
    if ((typeof error !== "object" || error == null) && typeof error !== "function") {
      return;
    }
    this.reported.set(error, state);
  }

  private writeRecord(record: ErrorLogRecord): void {
    if (this.writing) {
      throw new Error("永続エラーログの記録中に再入しました。");
    }
    this.writing = true;
    try {
      const knownSecrets = z.array(z.string().min(1)).parse(this.knownSecrets());
      const serialized = JSON.stringify(record, (_key, value: unknown): unknown =>
        typeof value === "string"
          ? redactKnownSecrets(value, knownSecrets, this.formatter.redactText)
          : value);
      if (serialized == null) {
        throw new Error("永続エラーログをシリアライズできませんでした。");
      }
      this.append(serialized);
    } finally {
      this.writing = false;
    }
  }

  private append(serializedRecord: string): void {
    const data = Buffer.from(`${serializedRecord}\n`, "utf8");
    this.rotateIfNeeded(data.byteLength);
    const noFollowFlag =
      process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number"
        ? constants.O_NOFOLLOW
        : 0;
    const flags = constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollowFlag;
    let fileDescriptor: number | undefined;
    let appendError: unknown = undefined;
    try {
      fileDescriptor = openSync(this.errorLogPath, flags, 0o600);
      if (process.platform !== "win32") {
        fchmodSync(fileDescriptor, 0o600);
      }
      const appendStartSize = fstatSync(fileDescriptor).size;
      try {
        writeBuffer(fileDescriptor, data);
        fsyncSync(fileDescriptor);
      } catch (error) {
        restoreAppendStart(fileDescriptor, appendStartSize, error);
      }
    } catch (error) {
      appendError = error;
    } finally {
      if (fileDescriptor != null) {
        try {
          closeSync(fileDescriptor);
        } catch (closeError) {
          appendError = appendError == null
            ? closeError
            : new AggregateError(
              [appendError, closeError],
              "永続エラーログを閉じられませんでした。",
            );
        }
      }
    }
    if (appendError != null) {
      throw normalizeThrownError(appendError, "永続エラーログの追記に失敗しました。");
    }
  }

  private rotateIfNeeded(nextRecordBytes: number): void {
    let currentBytes = 0;
    try {
      assertRegularFile(this.errorLogPath);
      currentBytes = lstatSync(this.errorLogPath).size;
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    if (currentBytes + nextRecordBytes <= maximumLogBytes) {
      return;
    }
    renameExistingFile(
      join(this.logsPath, `${errorLogFileName}.2`),
      join(this.logsPath, `${errorLogFileName}.3`),
    );
    renameExistingFile(
      join(this.logsPath, `${errorLogFileName}.1`),
      join(this.logsPath, `${errorLogFileName}.2`),
    );
    renameExistingFile(
      this.errorLogPath,
      join(this.logsPath, `${errorLogFileName}.1`),
    );
  }
}
