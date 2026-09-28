import { z } from "zod";
import { errorIdSchema, identifierSchema, responseSchema, type IpcResult } from "./common";

const credentialAssignmentPattern =
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bot[_ -]?token|token|client[_ -]?secret|authorization|password|secret|credential)\b(\s*[:=])\s*(?:bearer\s+)?(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]&#?]+)/giu;
const jsonCredentialPattern =
  /((?:["'])(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|bot[_ -]?token|token|client[_ -]?secret|authorization|password|secret|credential)(?:["'])\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/giu;
const bearerPattern = /\b(bearer\s+)(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}\]]+)/giu;
const credentialQueryPattern =
  /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|client[_-]?secret|authorization|password|secret|token|code)=)[^&#\s]+/giu;
const obviousCredentialPattern =
  /\b(?:sk|rk|gh[pousr]|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/giu;
const jwtPattern =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu;

function redactSensitiveText(value: string): string {
  return value
    .replace(credentialQueryPattern, "$1<伏せ字>")
    .replace(jsonCredentialPattern, "$1<伏せ字>")
    .replace(bearerPattern, "$1<伏せ字>")
    .replace(credentialAssignmentPattern, "$1$2<伏せ字>")
    .replace(obviousCredentialPattern, "<伏せ字>")
    .replace(jwtPattern, "<伏せ字>");
}

function nonErrorName(value: unknown): string {
  if (value === null) return "Null";
  if (value === undefined) return "Undefined";
  if (typeof value === "object") return "Object";
  if (typeof value === "function") return "Function";
  if (typeof value === "string") return "String";
  if (typeof value === "number") return "Number";
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "bigint") return "BigInt";
  return "Symbol";
}

function nonErrorMessage(value: unknown): string {
  if (typeof value === "object" && value != null) {
    const ancestors = new WeakSet<object>();
    return JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "bigint") return nested.toString();
      if (typeof nested === "object" && nested != null) {
        if (ancestors.has(nested)) return "[Circular]";
        ancestors.add(nested);
      }
      return nested;
    }) ?? "Object";
  }
  if (typeof value === "function") return "[function]";
  return String(value);
}

function errorStack(value: unknown): string | undefined {
  if (value instanceof Error) return value.stack;
  if (typeof value !== "object" || value == null) return undefined;
  const stack: unknown = Object.getOwnPropertyDescriptor(value, "stack")?.value;
  return typeof stack === "string" ? stack : undefined;
}

function serializeError(value: unknown, ancestors: WeakSet<Error>): DiagnosticError {
  if (value instanceof Error && ancestors.has(value)) {
    return { name: "CyclicError", message: "原因が循環しています。", stack: "CyclicError: 原因が循環しています。" };
  }
  if (value instanceof Error) ancestors.add(value);
  try {
    const redactedName = redactSensitiveText(value instanceof Error ? value.name : nonErrorName(value)).slice(0, 200);
    const name = redactedName.length === 0 ? "Error" : redactedName;
    const redactedMessage = redactSensitiveText(value instanceof Error ? value.message : nonErrorMessage(value)).slice(0, 4_096);
    const message = redactedMessage.length === 0 ? "例外の値が空です。" : redactedMessage;
    const rawStack = errorStack(value);
    const redactedStack = rawStack == null ? "" : redactSensitiveText(rawStack).slice(0, 16_384);
    const stack = redactedStack.length === 0 ? `${name}: ${message}` : redactedStack;
    let cause: DiagnosticError | undefined;
    if (value instanceof Error && Object.prototype.hasOwnProperty.call(value, "cause")) {
      cause = serializeError(value.cause, ancestors);
    }
    return { name, message, stack, ...(cause == null ? {} : { cause }) };
  } finally {
    if (value instanceof Error) ancestors.delete(value);
  }
}

/** 例外の値と原因を伏せ字済みの診断情報へ直列化します。 */
export function serializeDiagnosticError(value: unknown): DiagnosticError {
  return serializeError(value, new WeakSet<Error>());
}

export const diagnosticsChannels = {
  report: "diagnostics:report",
} satisfies Record<string, string>;

export type DiagnosticError = {
  readonly name: string;
  readonly message: string;
  readonly stack: string;
  readonly cause?: DiagnosticError | undefined;
};
const diagnosticErrorSchema: z.ZodType<DiagnosticError> = z.lazy(() => z.object({
  name: z.string().min(1).max(200),
  message: z.string().min(1).max(4_096),
  stack: z.string().min(1).max(16_384),
  cause: diagnosticErrorSchema.optional(),
}).strict());

const diagnosticRequestSchema = z
  .object({
    level: z.enum(["error", "warning"]),
    error: diagnosticErrorSchema,
    operation_id: identifierSchema.optional(),
  })
  .strict();
const diagnosticResultSchema = z.object({ error_id: errorIdSchema }).strict();

export const diagnosticsContracts = {
  report: {
    channel: diagnosticsChannels.report,
    request: diagnosticRequestSchema,
    response: responseSchema(diagnosticResultSchema),
  },
};

export type DiagnosticsApi = {
  readonly report: (
    input: z.infer<typeof diagnosticRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof diagnosticResultSchema>>>;
};
