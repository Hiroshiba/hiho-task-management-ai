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
import { diagnosticCodeSchema } from "../shared/storage";
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

const maximumLogBytes = 1 * 1024 * 1024;
const maximumZodIssues = 10;
const maximumZodIssuePathElements = 10;
const persistentErrorLogFileName = "taskhub-error.log";
const persistentErrorLogFailureMessage = "永続エラーログの書き込みに失敗しました。";
const credentialAssignmentPattern =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|secret|credential)\b(\s*[:=])\s*(?:bearer\s+)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]&#?]+)/giu;
const jsonCredentialPattern =
  /((?:["'])(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|secret|credential)(?:["'])\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/giu;
const bearerPattern = /\b(bearer\s+)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]]+)/giu;
const credentialQueryPattern =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|secret|token|code)=)[^&#\s]+/giu;
const obviousCredentialPattern =
  /\b(?:sk|rk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const jwtPattern =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;
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
};

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
    })
    .strict(),
);

const persistentErrorLogRecordSchema = z
  .object({
    occurred_at: isoDateTimeSchema,
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

function redactSensitiveText(value: string): string {
  return value
    .replace(credentialQueryPattern, "$1<伏せ字>")
    .replace(jsonCredentialPattern, "$1<伏せ字>")
    .replace(bearerPattern, "$1<伏せ字>")
    .replace(credentialAssignmentPattern, "$1$2<伏せ字>")
    .replace(obviousCredentialPattern, "<伏せ字>")
    .replace(jwtPattern, "<伏せ字>");
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

/** 開発者向けのエラーを再起動後も確認できるJSONLログへ保存します。 */
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

  /** 元エラーの本文とスタックトレースを記録します。 */
  public record(
    source: PersistentErrorLogSource,
    diagnosticCode: DiagnosticRecord["code"],
    context: PersistentErrorLogContext,
    error: unknown,
  ): void {
    if (this.writing) {
      writePersistentErrorLogFailure(
        {
          "元エラー": error,
          "書き込みエラー": new Error("永続エラーログの記録中に再入しました。"),
        },
      );
      return;
    }
    this.writing = true;
    try {
      const record = persistentErrorLogRecordSchema.parse({
        occurred_at: new Date().toISOString(),
        source,
        diagnostic_code: diagnosticCode,
        context,
        error: createErrorDetail(error, new WeakSet<object>()),
      });
      this.writeRecord(record);
    } catch (writeError) {
      writePersistentErrorLogFailure({
        "元エラー": error,
        "書き込みエラー": writeError,
      });
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
