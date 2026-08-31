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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
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

const maximumLogBytes = 1 * 1024 * 1024;
const maximumStackFrames = 32;
const maximumStackBytes = 32 * 1024;
const maximumStackFrameCharacters = 256;
const maximumErrorNameCharacters = 64;
const maximumErrorDepth = 4;
const maximumAggregateErrors = 8;
const maximumErrorNodes = 16;
const maximumRpcMessageBytes = 1 * 1024;
const maximumRpcMessageCharacters = 2_000;
const persistentErrorLogFileName = "taskhub-error.log";
const persistentErrorLogFailureMessage = "永続エラーログの書き込みに失敗しました。";
const safeErrorNamePattern = /^[A-Za-z][A-Za-z0-9]*(?:Error|Exception)$/u;
const parenthesizedStackFramePattern =
  /^\s{2,}at\s+[^()\r\n]*\(([^()\r\n]+):([0-9]{1,6}):([0-9]{1,6})\)\s*$/u;
const directStackFramePattern =
  /^\s{2,}at\s+([^()\r\n]+):([0-9]{1,6}):([0-9]{1,6})\s*$/u;
const nodeStackSourcePattern = /^node:[A-Za-z0-9._/-]+$/u;
const safeRelativeCodePathPattern = /^[A-Za-z0-9._+@~-]+(?:[\\/][A-Za-z0-9._+@~-]+)*$/u;
const rpcDiagnosticMessageOperations: readonly CodexRpcOperation[] = [
  "initialize",
  "account/read",
  "model/list",
  "skills/list",
  "permissionProfile/list",
  "experimentalFeature/list",
  "thread/start",
  "turn/interrupt",
];
const rpcCredentialAssignmentPattern =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|secret|credential)\b(\s*[:=])\s*(?:bearer\s+)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]&#?]+)/giu;
const rpcJsonCredentialPattern =
  /((?:["'])(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|password|secret|credential)(?:["'])\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/giu;
const rpcBearerPattern = /\b(bearer\s+)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]]+)/giu;
const rpcCredentialQueryPattern =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization|password|secret|token|code)=)[^&#\s]+/giu;
const rpcObviousCredentialPattern =
  /\b(?:sk|rk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const rpcJwtPattern =
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

export type PersistentErrorLogSource = z.infer<
  typeof persistentErrorLogSourceSchema
>;
export type PersistentErrorLogContext = z.infer<
  typeof persistentErrorLogContextSchema
>;

type SafeErrorDetail = {
  error_name: string;
  stack_frames: string[];
  cause_chain: SafeErrorDetail[];
  aggregate_errors: SafeErrorDetail[];
  rpc_operation?: CodexRpcOperation | undefined;
  rpc_code?: number | undefined;
  rpc_message?: string | undefined;
};

const safeErrorDetailSchema: z.ZodType<SafeErrorDetail> = z.lazy(() =>
  z
    .object({
      error_name: z.string().min(1).max(maximumErrorNameCharacters),
      stack_frames: z
        .array(z.string().max(maximumStackFrameCharacters))
        .max(maximumStackFrames),
      cause_chain: z.array(safeErrorDetailSchema).max(1),
      aggregate_errors: z
        .array(safeErrorDetailSchema)
        .max(maximumAggregateErrors),
      rpc_operation: codexRpcOperationSchema.optional(),
      rpc_code: codexRpcCodeSchema.optional(),
      rpc_message: z.string().min(1).max(maximumRpcMessageCharacters).optional(),
    })
    .strict(),
);

const persistentErrorLogRecordSchema = z
  .object({
    occurred_at: isoDateTimeSchema,
    source: persistentErrorLogSourceSchema,
    diagnostic_code: diagnosticCodeSchema,
    context: persistentErrorLogContextSchema,
    error: safeErrorDetailSchema,
  })
  .strict();

type PersistentErrorLogRecord = z.infer<typeof persistentErrorLogRecordSchema>;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "ログ保存先は絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "ログ保存先にNUL文字を指定できません。");

type ErrorNodeBudget = {
  remaining: number;
};

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** 永続エラーログの失敗を固定文で標準エラーへ通知します。 */
function writePersistentErrorLogFailure(error: unknown): void {
  if (!persistentErrorLogFailureOutputEnabled) {
    return;
  }
  try {
    const failureMessage = `${persistentErrorLogFailureMessage} 原因: ${getSafeErrorName(error)}\n`;
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

function getSafeErrorName(value: unknown): string {
  if (!(value instanceof Error)) {
    return getNonErrorName(value);
  }
  const name = value.name;
  if (
    typeof name === "string"
    && name.length <= maximumErrorNameCharacters
    && safeErrorNamePattern.test(name)
  ) {
    return name;
  }
  return "Error";
}

function readCause(error: Error): unknown {
  if (!Object.prototype.hasOwnProperty.call(error, "cause")) {
    return undefined;
  }
  return error.cause;
}

class StackSanitizer {
  private readonly cwdPath: string;

  public constructor() {
    this.cwdPath = resolve(process.cwd());
  }

  public sanitize(frame: string): string | undefined {
    const match =
      parenthesizedStackFramePattern.exec(frame)
      ?? directStackFramePattern.exec(frame);
    if (match == null) {
      return undefined;
    }
    const source = match[1];
    const line = match[2];
    const column = match[3];
    if (source == null || line == null || column == null) {
      return undefined;
    }
    if (nodeStackSourcePattern.test(source)) {
      return `<node>:${line}:${column}`;
    }
    return this.sanitizePathSource(source, line, column);
  }

  private sanitizePathSource(
    source: string,
    line: string,
    column: string,
  ): string | undefined {
    if (source.includes("\0")) {
      return undefined;
    }
    const fileUrl = /^file:/iu.test(source);
    let pathSource = source;
    if (fileUrl) {
      try {
        pathSource = fileURLToPath(source);
      } catch {
        return `<path>:${line}:${column}`;
      }
    }
    if (
      !fileUrl
      && !isWindowsAbsolutePathSource(pathSource)
      && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(pathSource)
    ) {
      return undefined;
    }
    if (!isAbsolutePathSource(pathSource)) {
      return undefined;
    }
    if (
      process.platform !== "win32"
      && isWindowsAbsolutePathSource(pathSource)
    ) {
      return `<path>:${line}:${column}`;
    }
    let resolvedPath: string;
    try {
      resolvedPath = resolve(this.cwdPath, pathSource);
    } catch {
      return `<path>:${line}:${column}`;
    }
    const relativePath = relative(this.cwdPath, resolvedPath);
    if (!isSafeCwdRelativePath(relativePath)) {
      return `<path>:${line}:${column}`;
    }
    let sourceStats: ReturnType<typeof lstatSync>;
    try {
      sourceStats = lstatSync(resolvedPath);
    } catch {
      return `<path>:${line}:${column}`;
    }
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      return `<path>:${line}:${column}`;
    }
    const normalizedRelativePath = relativePath.replaceAll("\\", "/");
    if (normalizedRelativePath.length <= maximumStackFrameCharacters) {
      return `<cwd>/${normalizedRelativePath}:${line}:${column}`;
    }
    return `<path>:${line}:${column}`;
  }
}

function isAbsolutePathSource(value: string): boolean {
  return (
    isAbsolute(value)
    || isWindowsAbsolutePathSource(value)
  );
}

function isWindowsAbsolutePathSource(value: string): boolean {
  return (
    /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("//")
    || value.startsWith("\\\\?\\")
    || value.startsWith("//?/")
  );
}

function isSafeCwdRelativePath(value: string): boolean {
  if (
    value === ""
    || value.includes("\0")
    || isAbsolute(value)
    || value === ".."
    || value.startsWith(`..${sep}`)
    || value.startsWith("../")
    || value.startsWith("..\\")
    || !safeRelativeCodePathPattern.test(value)
  ) {
    return false;
  }
  return true;
}

function limitUtf8String(value: string, maximumBytes: number): string {
  let lowerBound = 0;
  let upperBound = Math.min(value.length, maximumBytes);
  const boundedValue = value.slice(0, upperBound);
  if (Buffer.byteLength(boundedValue, "utf8") <= maximumBytes) {
    return boundedValue;
  }
  while (lowerBound < upperBound) {
    const middle = Math.ceil((lowerBound + upperBound) / 2);
    if (Buffer.byteLength(boundedValue.slice(0, middle), "utf8") <= maximumBytes) {
      lowerBound = middle;
    } else {
      upperBound = middle - 1;
    }
  }
  const truncatedValue = boundedValue.slice(0, lowerBound);
  if (truncatedValue.length === 0) {
    return truncatedValue;
  }
  const lastCodeUnit = truncatedValue.charCodeAt(truncatedValue.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    return truncatedValue.slice(0, -1);
  }
  return truncatedValue;
}

function getStackFrames(
  error: unknown,
  stackSanitizer: StackSanitizer,
): string[] {
  if (!(error instanceof Error)) {
    return [];
  }
  const stack = error.stack;
  if (typeof stack !== "string") {
    return [];
  }
  const boundedStack = limitUtf8String(stack, maximumStackBytes);
  const stackFrames: string[] = [];
  for (const frame of boundedStack
    .split(/\r?\n/u)
    .slice(1, maximumStackFrames + 1)) {
    const sanitizedFrame = stackSanitizer.sanitize(frame);
    if (sanitizedFrame != null) {
      stackFrames.push(sanitizedFrame);
    }
  }
  return stackFrames;
}

function getAggregateErrors(error: unknown): unknown[] {
  if (!(error instanceof AggregateError)) {
    return [];
  }
  const aggregateErrors: unknown[] = [];
  for (const childError of error.errors) {
    aggregateErrors.push(childError);
    if (aggregateErrors.length >= maximumAggregateErrors) {
      break;
    }
  }
  return aggregateErrors;
}

type SafeCodexRpcDetail = {
  rpc_operation?: CodexRpcOperation | undefined;
  rpc_code?: number | undefined;
  rpc_message?: string | undefined;
};

const safeRpcMessageSchema = z
  .string()
  .min(1)
  .max(maximumRpcMessageCharacters)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= maximumRpcMessageBytes,
    "Codex RPCメッセージがサイズ上限を超えています。",
  )
  .refine(
    (value) => !containsUnsafeRpcCharacter(value),
    "Codex RPCメッセージに制御文字を含められません。",
  );

function isUnsafeRpcCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  if (codePoint == null) {
    throw new Error("Codex RPCメッセージの文字を判定できません。");
  }
  return (
    codePoint <= 0x1f
    || (codePoint >= 0x7f && codePoint <= 0x9f)
    || codePoint === 0x2028
    || codePoint === 0x2029
    || (codePoint >= 0x202a && codePoint <= 0x202e)
    || (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function containsUnsafeRpcCharacter(value: string): boolean {
  for (const character of value) {
    if (isUnsafeRpcCharacter(character)) {
      return true;
    }
  }
  return false;
}

function replaceUnsafeRpcCharacters(value: string): string {
  return Array.from(
    value,
    (character) => isUnsafeRpcCharacter(character) ? " " : character,
  ).join("");
}

function sanitizeRpcMessage(value: string): string | undefined {
  const validatedMessage = codexRpcMessageSchema.parse(value);
  const sanitizedMessage = limitUtf8String(
    replaceUnsafeRpcCharacters(
      validatedMessage
        .replace(rpcCredentialQueryPattern, "$1<伏せ字>")
        .replace(rpcJsonCredentialPattern, "$1<伏せ字>")
        .replace(rpcBearerPattern, "$1<伏せ字>")
        .replace(rpcCredentialAssignmentPattern, "$1$2<伏せ字>")
        .replace(rpcObviousCredentialPattern, "<伏せ字>")
        .replace(rpcJwtPattern, "<伏せ字>"),
    )
      .replace(/\s+/gu, " ")
      .trim(),
    maximumRpcMessageBytes,
  );
  if (sanitizedMessage.length === 0) {
    return undefined;
  }
  return safeRpcMessageSchema.parse(sanitizedMessage);
}

function getSafeCodexRpcDetail(value: unknown): SafeCodexRpcDetail {
  if (!(value instanceof CodexRpcError)) {
    return {};
  }
  if (!rpcDiagnosticMessageOperations.includes(value.operation)) {
    return {
      rpc_operation: codexRpcOperationSchema.parse(value.operation),
      rpc_code: codexRpcCodeSchema.parse(value.rpcCode),
    };
  }
  const rpcMessage = sanitizeRpcMessage(value.rpcMessage);
  return {
    rpc_operation: codexRpcOperationSchema.parse(value.operation),
    rpc_code: codexRpcCodeSchema.parse(value.rpcCode),
    ...(rpcMessage == null ? {} : { rpc_message: rpcMessage }),
  };
}

function createSafeErrorDetail(
  value: unknown,
  stackSanitizer: StackSanitizer,
  depth: number,
  ancestors: WeakSet<object>,
  budget: ErrorNodeBudget,
): SafeErrorDetail {
  if (budget.remaining <= 0) {
    return {
      error_name: "TruncatedError",
      stack_frames: [],
      cause_chain: [],
      aggregate_errors: [],
    };
  }
  if (isObject(value) && ancestors.has(value)) {
    return {
      error_name: "CyclicError",
      stack_frames: [],
      cause_chain: [],
      aggregate_errors: [],
    };
  }

  budget.remaining -= 1;
  if (isObject(value)) {
    ancestors.add(value);
  }

  const detail: SafeErrorDetail = {
    error_name: getSafeErrorName(value),
    stack_frames: getStackFrames(value, stackSanitizer),
    cause_chain: [],
    aggregate_errors: [],
    ...getSafeCodexRpcDetail(value),
  };

  if (depth < maximumErrorDepth) {
    if (value instanceof Error) {
      const cause = readCause(value);
      if (cause !== undefined) {
        detail.cause_chain.push(
          createSafeErrorDetail(
            cause,
            stackSanitizer,
            depth + 1,
            ancestors,
            budget,
          ),
        );
      }
    }
    for (const aggregateError of getAggregateErrors(value)) {
      detail.aggregate_errors.push(
        createSafeErrorDetail(
          aggregateError,
          stackSanitizer,
          depth + 1,
          ancestors,
          budget,
        ),
      );
    }
  }

  if (isObject(value)) {
    ancestors.delete(value);
  }
  return detail;
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
  private readonly stackSanitizer: StackSanitizer;
  private writing = false;

  public constructor(logsPath: string) {
    const validatedLogsPath = absolutePathSchema.parse(logsPath);
    this.logsPath = resolve(validatedLogsPath);
    this.errorLogPath = join(this.logsPath, persistentErrorLogFileName);
    this.stackSanitizer = new StackSanitizer();
    mkdirSync(this.logsPath, { recursive: true, mode: 0o700 });
    assertRegularDirectory(this.logsPath);
    if (process.platform !== "win32") {
      chmodSync(this.logsPath, 0o700);
    }
  }

  /** 固定項目だけで元エラーを安全に記録します。 */
  public record(
    source: PersistentErrorLogSource,
    diagnosticCode: DiagnosticRecord["code"],
    context: PersistentErrorLogContext,
    error: unknown,
  ): void {
    if (this.writing) {
      writePersistentErrorLogFailure(undefined);
      return;
    }
    this.writing = true;
    try {
      const record = persistentErrorLogRecordSchema.parse({
        occurred_at: new Date().toISOString(),
        source,
        diagnostic_code: diagnosticCode,
        context,
        error: createSafeErrorDetail(
          error,
          this.stackSanitizer,
          0,
          new WeakSet<object>(),
          { remaining: maximumErrorNodes },
        ),
      });
      this.writeRecord(record);
    } catch (error) {
      writePersistentErrorLogFailure(error);
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
    if (data.byteLength > maximumLogBytes) {
      throw new Error("永続エラーログの1件が上限を超えています。");
    }
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
