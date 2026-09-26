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
import { inspect } from "node:util";
import { z } from "zod";
import { isoDateTimeSchema } from "../shared/domain";
import {
  diagnosticCodeSchema,
  diagnosticLogEntrySchema,
} from "../shared/storage";
import {
  AiWorkflowRetryLogEventError,
  aiWorkflowRetryLogEventSchema,
  type AiWorkflowRetryLogEvent,
} from "./ai/workflow/retry";
import type { DiagnosticRecord } from "./application/diagnostics";
import {
  CodexRpcError,
  codexRpcCodeSchema,
  codexRpcMessageSchema,
  codexRpcOperationSchema,
  type CodexRpcOperation,
} from "./codex/app-server/errors";
import {
  CodexThreadStartCapabilityError,
  codexThreadStartCapabilityFailureCodeSchema,
  type CodexThreadStartCapabilityFailureCode,
} from "./codex/session/errors";
import {
  AsanaHttpError,
  type AsanaHttpErrorResponseBodyKind,
} from "./asana/transport";
import { redactSensitiveText } from "./redact-sensitive-text";

const maximumLogBytes = 1 * 1024 * 1024;
const maximumZodIssues = 10;
const maximumZodIssuePathElements = 10;
const persistentErrorLogFileName = "taskhub-error.log";
const persistentErrorLogFailureMessage = "永続エラーログの書き込みに失敗しました。";
let persistentErrorLogFailureOutputEnabled = true;

const persistentErrorLogSourceSchema = z.enum([
  "main",
  "service",
  "ipc",
  "uncaught_exception",
]);

const persistentErrorLogContextSchema = z.enum([
  "service_diagnostic",
  "ipc_diagnostic",
  "diagnostic_storage",
  "external_url",
  "registry_dispose",
  "background_operation",
  "application_stop",
  "application_update",
  "main_window",
  "application_quit",
  "bootstrap",
  "uncaught_exception",
]);

const safeZodIssuePathFieldSchema = z.enum([
  "data",
  "sync",
  "has_more",
  "action",
  "resource",
  "parent",
  "user",
  "created_at",
  "change",
  "gid",
  "resource_type",
  "field",
  "new_value",
  "other",
]);
const safeZodIssuePathIndexSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger);
const safeZodIssuePathSegmentSchema = z.union([
  safeZodIssuePathFieldSchema,
  safeZodIssuePathIndexSchema,
]);
const safeZodIssueCodeSchema = z.enum([
  "invalid_type",
  "too_big",
  "too_small",
  "invalid_format",
  "not_multiple_of",
  "unrecognized_keys",
  "invalid_union",
  "invalid_key",
  "invalid_element",
  "invalid_value",
  "custom",
  "other",
]);
const safeZodIssueExpectedSchema = z.enum([
  "string",
  "number",
  "int",
  "boolean",
  "bigint",
  "symbol",
  "undefined",
  "null",
  "never",
  "void",
  "date",
  "array",
  "object",
  "tuple",
  "record",
  "map",
  "set",
  "file",
  "nonoptional",
  "nan",
  "function",
]);
const safeZodIssueSchema = z
  .object({
    path: z.array(safeZodIssuePathSegmentSchema).max(maximumZodIssuePathElements),
    code: safeZodIssueCodeSchema,
    expected: safeZodIssueExpectedSchema.optional(),
  })
  .strict();

const safeCodexTurnFailureSchema = z.enum([
  "contextWindowExceeded",
  "sessionBudgetExceeded",
  "usageLimitExceeded",
  "serverOverloaded",
  "cyberPolicy",
  "misalignmentPolicyViolation",
  "internalServerError",
  "unauthorized",
  "badRequest",
  "threadRollbackFailed",
  "sandboxError",
  "other",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
]);
const codexTurnFailureInfoEnvelopeSchema = z
  .object({
    codexErrorInfo: z.unknown().optional(),
  })
  .strip();
const safeCodexTurnFailureObjectKeys: readonly string[] = [
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "activeTurnNotSteerable",
];

type SafeZodIssue = z.infer<typeof safeZodIssueSchema>;
type SafeZodIssuePathSegment = z.infer<typeof safeZodIssuePathSegmentSchema>;
type SafeZodIssueCode = z.infer<typeof safeZodIssueCodeSchema>;
type SafeZodIssueExpected = z.infer<typeof safeZodIssueExpectedSchema>;
type SafeCodexTurnFailure = z.infer<typeof safeCodexTurnFailureSchema>;
type AsanaHttpErrorResponseBodyKindValue = AsanaHttpErrorResponseBodyKind;

export type PersistentErrorLogSource = z.infer<
  typeof persistentErrorLogSourceSchema
>;
export type PersistentErrorLogContext = z.infer<
  typeof persistentErrorLogContextSchema
>;

type ErrorDetail = {
  error_name: string;
  error_message: string;
  stack_trace: string;
  cause_chain: ErrorDetail[];
  aggregate_errors: ErrorDetail[];
  zod_issues?: SafeZodIssue[] | undefined;
  codex_turn_failure?: SafeCodexTurnFailure | undefined;
  capability_failure?: CodexThreadStartCapabilityFailureCode | undefined;
  rpc_operation?: CodexRpcOperation | undefined;
  rpc_code?: number | undefined;
  rpc_message?: string | undefined;
  retry_event?: AiWorkflowRetryLogEvent | undefined;
  asana_http?: AsanaHttpErrorDetail | undefined;
};

const asanaHttpErrorDetailSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    request_id: z.string().optional(),
    errors: z
      .array(
        z
          .object({
            message: z.string().optional(),
            help: z.string().optional(),
            phrase: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .optional(),
    response_body_kind: z
      .enum([
        "parsed",
        "non_json",
        "invalid_json",
        "invalid_shape",
        "unavailable",
        "timeout",
        "too_large",
      ] satisfies AsanaHttpErrorResponseBodyKindValue[])
      .optional(),
  })
  .strict();

type AsanaHttpErrorDetail = z.infer<typeof asanaHttpErrorDetailSchema>;

const errorDetailSchema: z.ZodType<ErrorDetail> = z.lazy(() =>
  z
    .object({
      error_name: z.string(),
      error_message: z.string(),
      stack_trace: z.string(),
      cause_chain: z.array(errorDetailSchema),
      aggregate_errors: z.array(errorDetailSchema),
      zod_issues: z.array(safeZodIssueSchema).max(maximumZodIssues).optional(),
      codex_turn_failure: safeCodexTurnFailureSchema.optional(),
      capability_failure: codexThreadStartCapabilityFailureCodeSchema.optional(),
      rpc_operation: codexRpcOperationSchema.optional(),
      rpc_code: codexRpcCodeSchema.optional(),
      rpc_message: z.string().optional(),
      retry_event: aiWorkflowRetryLogEventSchema.optional(),
      asana_http: asanaHttpErrorDetailSchema.optional(),
    })
    .strict(),
);

const persistentErrorLogRecordSchema = z
  .object({
    occurred_at: isoDateTimeSchema,
    severity: diagnosticLogEntrySchema.shape.severity,
    source: persistentErrorLogSourceSchema,
    diagnostic_code: diagnosticCodeSchema,
    context: persistentErrorLogContextSchema,
    error: errorDetailSchema,
  })
  .strict();

type PersistentErrorLogRecord = z.infer<typeof persistentErrorLogRecordSchema>;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "ログ保存先は絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "ログ保存先にNUL文字を指定できません。");

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 永続エラーログの失敗を標準エラーへ通知します。 */
function writePersistentErrorLogFailure(error: unknown): void {
  if (!persistentErrorLogFailureOutputEnabled) {
    return;
  }
  try {
    const failureDetails = redactSensitiveText(inspect(
      error,
      { depth: null, maxStringLength: null, maxArrayLength: null },
    ));
    const failureMessage = `${persistentErrorLogFailureMessage}\n${failureDetails}\n`;
    writeSync(2, Buffer.from(failureMessage, "utf8"));
  } catch {
    persistentErrorLogFailureOutputEnabled = false;
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value != null;
}

function getNonErrorName(value: unknown): string {
  if (value == null) {
    return "Nullish";
  }
  if (typeof value === "function") {
    return "Function";
  }
  if (typeof value === "object") {
    return "Object";
  }
  if (typeof value === "string") {
    return "String";
  }
  if (typeof value === "number") {
    return "Number";
  }
  if (typeof value === "boolean") {
    return "Boolean";
  }
  if (typeof value === "bigint") {
    return "BigInt";
  }
  return "Symbol";
}

function getErrorName(value: unknown): string {
  if (!(value instanceof Error)) {
    return getNonErrorName(value);
  }
  return redactSensitiveText(value.name);
}

function stringifyThrownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, {
    depth: null,
    maxStringLength: null,
    maxArrayLength: null,
  });
}

function getErrorMessage(value: unknown): string {
  const message = value instanceof Error
    ? stringifyThrownValue(value.message)
    : stringifyThrownValue(value);
  return redactSensitiveText(message);
}

function getStackTrace(value: unknown): string {
  if (!(value instanceof Error) || typeof value.stack !== "string") {
    return "";
  }
  return redactSensitiveText(value.stack);
}

function getAsanaHttpDetail(
  value: unknown,
): Pick<ErrorDetail, "asana_http"> {
  if (!(value instanceof AsanaHttpError) || value.source !== "rest") {
    return {};
  }
  const errors = value.errors?.map((error) => ({
    ...(error.message == null ? {} : { message: redactSensitiveText(error.message) }),
    ...(error.help == null ? {} : { help: redactSensitiveText(error.help) }),
    ...(error.phrase == null ? {} : { phrase: redactSensitiveText(error.phrase) }),
  }));
  const detail = asanaHttpErrorDetailSchema.parse({
    status: value.status,
    ...(value.requestId == null
      ? {}
      : { request_id: redactSensitiveText(value.requestId) }),
    ...(errors == null ? {} : { errors }),
    ...(value.responseBodyKind == null
      ? {}
      : { response_body_kind: value.responseBodyKind }),
  });
  return { asana_http: detail };
}

type CodexRpcDetail = {
  rpc_operation?: CodexRpcOperation | undefined;
  rpc_code?: number | undefined;
  rpc_message?: string | undefined;
};

function getCodexRpcDetail(value: unknown): CodexRpcDetail {
  if (!(value instanceof CodexRpcError)) {
    return {};
  }
  return {
    rpc_operation: codexRpcOperationSchema.parse(value.operation),
    rpc_code: codexRpcCodeSchema.parse(value.rpcCode),
    rpc_message: redactSensitiveText(codexRpcMessageSchema.parse(value.rpcMessage)),
  };
}

function getAiWorkflowRetryEventDetail(
  value: unknown,
): Pick<ErrorDetail, "retry_event"> {
  if (!(value instanceof AiWorkflowRetryLogEventError)) {
    return {};
  }
  return {
    retry_event: aiWorkflowRetryLogEventSchema.parse(value.event),
  };
}

function sanitizeZodIssuePathSegment(value: PropertyKey): SafeZodIssuePathSegment {
  if (typeof value === "number") {
    const parsedIndex = safeZodIssuePathIndexSchema.safeParse(value);
    return parsedIndex.success ? parsedIndex.data : "other";
  }
  if (typeof value !== "string") {
    return "other";
  }
  const parsedField = safeZodIssuePathFieldSchema.safeParse(value);
  return parsedField.success ? parsedField.data : "other";
}

function getSafeZodIssuePath(path: readonly PropertyKey[]): SafeZodIssuePathSegment[] {
  return path
    .slice(0, maximumZodIssuePathElements)
    .map((segment) => sanitizeZodIssuePathSegment(segment));
}

function getSafeZodIssueCode(issue: z.ZodIssue): SafeZodIssueCode {
  const parsedCode = safeZodIssueCodeSchema.safeParse(issue.code);
  return parsedCode.success ? parsedCode.data : "other";
}

function getSafeZodIssueExpected(issue: z.ZodIssue): SafeZodIssueExpected | undefined {
  if (!("expected" in issue)) {
    return undefined;
  }
  const parsedExpected = safeZodIssueExpectedSchema.safeParse(issue.expected);
  return parsedExpected.success ? parsedExpected.data : undefined;
}

function getSafeZodIssues(value: unknown): SafeZodIssue[] {
  if (!(value instanceof z.ZodError)) {
    return [];
  }
  return value.issues.slice(0, maximumZodIssues).map((issue) => {
    const expected = getSafeZodIssueExpected(issue);
    return safeZodIssueSchema.parse({
      path: getSafeZodIssuePath(issue.path),
      code: getSafeZodIssueCode(issue),
      ...(expected === undefined ? {} : { expected }),
    });
  });
}

function getSafeZodDetail(value: unknown): Pick<ErrorDetail, "zod_issues"> {
  const issues = getSafeZodIssues(value);
  return issues.length === 0 ? {} : { zod_issues: issues };
}

function getSafeCodexTurnFailure(value: unknown): SafeCodexTurnFailure | undefined {
  const parsedEnvelope = codexTurnFailureInfoEnvelopeSchema.safeParse(value);
  if (!parsedEnvelope.success) {
    return undefined;
  }
  const codexErrorInfo = parsedEnvelope.data.codexErrorInfo;
  const parsedString = safeCodexTurnFailureSchema.safeParse(codexErrorInfo);
  if (parsedString.success) {
    return parsedString.data;
  }
  if (
    typeof codexErrorInfo !== "object"
    || codexErrorInfo == null
    || Array.isArray(codexErrorInfo)
  ) {
    return undefined;
  }
  for (const key of safeCodexTurnFailureObjectKeys) {
    if (Object.prototype.hasOwnProperty.call(codexErrorInfo, key)) {
      const parsedKey = safeCodexTurnFailureSchema.safeParse(key);
      if (parsedKey.success) {
        return parsedKey.data;
      }
    }
  }
  return undefined;
}

function getSafeCodexTurnFailureDetail(
  value: unknown,
): Pick<ErrorDetail, "codex_turn_failure"> {
  const failure = getSafeCodexTurnFailure(value);
  return failure == null ? {} : { codex_turn_failure: failure };
}

function getSafeCodexThreadStartCapabilityDetail(
  value: unknown,
): Pick<ErrorDetail, "capability_failure"> {
  if (!(value instanceof CodexThreadStartCapabilityError)) {
    return {};
  }
  return {
    capability_failure: codexThreadStartCapabilityFailureCodeSchema.parse(
      value.failureCode,
    ),
  };
}

function createErrorDetail(
  value: unknown,
  ancestors: WeakSet<object>,
): ErrorDetail {
  if (isObject(value) && ancestors.has(value)) {
    return {
      error_name: "CyclicError",
      error_message: "循環参照を検出しました。",
      stack_trace: "",
      cause_chain: [],
      aggregate_errors: [],
    };
  }

  const objectValue = isObject(value);
  if (objectValue) {
    ancestors.add(value);
  }

  try {
    const detail: ErrorDetail = {
      error_name: getErrorName(value),
      error_message: getErrorMessage(value),
      stack_trace: getStackTrace(value),
      cause_chain: [],
      aggregate_errors: [],
      ...getSafeZodDetail(value),
      ...getSafeCodexTurnFailureDetail(value),
      ...getSafeCodexThreadStartCapabilityDetail(value),
      ...getCodexRpcDetail(value),
      ...getAiWorkflowRetryEventDetail(value),
      ...getAsanaHttpDetail(value),
    };

    if (value instanceof Error && Object.prototype.hasOwnProperty.call(value, "cause")) {
      detail.cause_chain.push(createErrorDetail(value.cause, ancestors));
    }
    if (value instanceof AggregateError) {
      for (const aggregateError of value.errors) {
        detail.aggregate_errors.push(createErrorDetail(aggregateError, ancestors));
      }
    }
    return detail;
  } finally {
    if (objectValue) {
      ancestors.delete(value);
    }
  }
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

/** エラー詳細と安全な訂正再試行イベントをJSONLログへ保存します。 */
export class PersistentErrorLog {
  private readonly logsPath: string;
  private readonly errorLogPath: string;
  private writing = false;

  public constructor(logsPath: string) {
    const validatedLogsPath = absolutePathSchema.parse(logsPath);
    this.logsPath = resolve(validatedLogsPath);
    this.errorLogPath = join(this.logsPath, persistentErrorLogFileName);
    mkdirSync(this.logsPath, { recursive: true, mode: 0o700 });
    assertRegularDirectory(this.logsPath);
    if (process.platform !== "win32") {
      chmodSync(this.logsPath, 0o700);
    }
  }

  /** エラー詳細と安全な訂正再試行イベントを記録します。 */
  public record(
    source: PersistentErrorLogSource,
    diagnosticCode: DiagnosticRecord["code"],
    context: PersistentErrorLogContext,
    severity: DiagnosticRecord["severity"],
    error: unknown,
  ): void {
    this.recordInternal(source, diagnosticCode, context, severity, error, false);
  }

  /** application journal診断を記録し、保存失敗を呼び出し元へ返します。 */
  public recordStrict(
    source: PersistentErrorLogSource,
    diagnosticCode: DiagnosticRecord["code"],
    context: PersistentErrorLogContext,
    severity: DiagnosticRecord["severity"],
    error: unknown,
  ): void {
    this.recordInternal(source, diagnosticCode, context, severity, error, true);
  }

  private recordInternal(
    source: PersistentErrorLogSource,
    diagnosticCode: DiagnosticRecord["code"],
    context: PersistentErrorLogContext,
    severity: DiagnosticRecord["severity"],
    error: unknown,
    strict: boolean,
  ): void {
    if (this.writing) {
      const reentrantError = new AggregateError(
        [error, new Error("永続エラーログの記録中に再入しました。")],
        "永続エラーログの記録中に再入しました。",
        { cause: error },
      );
      if (strict) {
        throw reentrantError;
      }
      writePersistentErrorLogFailure(reentrantError);
      return;
    }
    this.writing = true;
    try {
      const record = persistentErrorLogRecordSchema.parse({
        occurred_at: new Date().toISOString(),
        severity,
        source,
        diagnostic_code: diagnosticCode,
        context,
        error: createErrorDetail(error, new WeakSet<object>()),
      });
      this.writeRecord(record);
    } catch (writeError) {
      if (strict) {
        throw writeError;
      }
      writePersistentErrorLogFailure(
        new AggregateError(
          [error, writeError],
          "永続エラーログの保存に失敗しました。",
          { cause: error },
        ),
      );
    } finally {
      this.writing = false;
    }
  }

  private writeRecord(record: PersistentErrorLogRecord): void {
    const serializedRecord = JSON.stringify(record);
    if (serializedRecord == null) {
      throw new Error("永続エラーログをシリアライズできませんでした。");
    }
    this.append(serializedRecord);
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
      join(this.logsPath, `${persistentErrorLogFileName}.2`),
      join(this.logsPath, `${persistentErrorLogFileName}.3`),
    );
    renameExistingFile(
      join(this.logsPath, `${persistentErrorLogFileName}.1`),
      join(this.logsPath, `${persistentErrorLogFileName}.2`),
    );
    renameExistingFile(
      this.errorLogPath,
      join(this.logsPath, `${persistentErrorLogFileName}.1`),
    );
  }
}

export { writePersistentErrorLogFailure };
