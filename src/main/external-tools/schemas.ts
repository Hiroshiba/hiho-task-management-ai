import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  gidSchema,
  type JsonValue,
} from "../../shared/domain";

export const externalToolProtocolVersion = 1;
export const externalToolMaxRequestBytes = 64 * 1024;
export const externalToolMaxResponseBytes = 2_400_000;
export const externalToolMaxJsonDepth = 24;
export const externalToolMaxConnections = 8;
export const externalToolMaxSubcommands = 32;
export const externalToolMaxArguments = 32;
export const externalToolMaxArgumentBytes = 4_096;
export const externalToolMaxExecutionMilliseconds = 30_000;
export const externalToolMaxOutputBytes = 1_048_576;
export const externalToolMaxOutputRecords = 10_000;
export const externalToolMaxDomains = 32;
export const externalToolMaxDiagnostics = 64;
export const externalToolMaximumRetries = 2;
export const externalToolMaxStatusEvidence = 256;

const maximumIdentifierCharacters = 64;
const maximumExecutableCharacters = 4_096;
const maximumDomainCharacters = 253;
const maximumArgumentNameCharacters = 66;
const maximumStatusEvidenceLocatorBytes = 4_096;
const maximumStatusEvidenceTargetTaskGidBytes = 200;

const readOnlyCommandHeads = new Set([
  "fetch",
  "find",
  "get",
  "history",
  "inspect",
  "list",
  "lookup",
  "message",
  "query",
  "read",
  "resolve",
  "search",
  "show",
  "status",
  "thread",
  "view",
]);

const forbiddenCommandParts = new Set([
  "add",
  "archive",
  "ban",
  "cancel",
  "clear",
  "close",
  "complete",
  "create",
  "delete",
  "destroy",
  "dispatch",
  "drop",
  "edit",
  "enable",
  "execute",
  "install",
  "invite",
  "merge",
  "modify",
  "move",
  "patch",
  "post",
  "publish",
  "put",
  "react",
  "remove",
  "rename",
  "reply",
  "run",
  "save",
  "send",
  "set",
  "subscribe",
  "truncate",
  "unsubscribe",
  "update",
  "upload",
  "upsert",
  "write",
]);

const forbiddenArgumentNameParts = new Set([
  "auth",
  "base",
  "config",
  "cwd",
  "data",
  "domain",
  "endpoint",
  "exec",
  "file",
  "header",
  "host",
  "input",
  "module",
  "out",
  "output",
  "password",
  "plugin",
  "proxy",
  "request",
  "secret",
  "server",
  "token",
  "url",
  "uri",
]);

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (
      codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
    );
  });
}

function isReadOnlyCommand(value: string): boolean {
  const parts = value.toLowerCase().split(/[._:-]/u);
  const firstPart = parts[0];
  if (firstPart == null || !readOnlyCommandHeads.has(firstPart) || parts.some((part) => part.length === 0)) {
    return false;
  }
  return parts.slice(1).every((part) => {
    for (const forbiddenPart of forbiddenCommandParts) {
      if (part === forbiddenPart || part.startsWith(forbiddenPart)) {
        return false;
      }
    }
    return true;
  });
}

function hasForbiddenWriteArgumentPart(value: string): boolean {
  const parts = value.slice(2).toLowerCase().split("-");
  return parts.some((part) => {
    if (forbiddenCommandParts.has(part)) {
      return true;
    }
    return [...forbiddenCommandParts].some((verb) =>
      part.startsWith(verb) || part.endsWith(verb),
    );
  });
}

function isSafeArgumentName(value: string): boolean {
  if (value !== "--method" && value !== "--http-method" && hasForbiddenWriteArgumentPart(value)) {
    return false;
  }
  if (
    value !== "--method"
    && value !== "--http-method"
    && value.slice(2).toLowerCase().split("-").some((part) => part.startsWith("method"))
  ) {
    return false;
  }
  const parts = value.slice(2).toLowerCase().split("-");
  return parts.every((part) => {
    for (const forbiddenPart of forbiddenArgumentNameParts) {
      if (part === forbiddenPart || part.startsWith(forbiddenPart)) {
        return false;
      }
    }
    return true;
  });
}

function isAllowedDomain(value: string): boolean {
  if (
    value.length === 0
    || value !== value.toLowerCase()
    || hasControlCharacter(value)
    || value.includes("/")
    || value.includes(":")
    || value.includes("@")
  ) {
    return false;
  }
  const labels = value.split(".");
  return labels.every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
  );
}

/** 外部ツール出力へ利用できる安全なJSON値を判定します。 */
function isSafeJsonValue(value: unknown): value is JsonValue {
  type Frame = {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting: boolean;
  };
  const stack: Frame[] = [{ value, depth: 0, exiting: false }];
  const ancestors = new WeakSet<object>();
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      throw new Error("JSON検証のスタックが不正です。");
    }
    if (frame.exiting) {
      if (typeof frame.value !== "object" || frame.value == null) {
        throw new Error("JSON検証の状態が不正です。");
      }
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.value === null || typeof frame.value === "boolean") {
      continue;
    }
    if (typeof frame.value === "string") {
      if (hasControlCharacter(frame.value)) {
        return false;
      }
      continue;
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        return false;
      }
      continue;
    }
    if (typeof frame.value !== "object" || frame.depth > externalToolMaxJsonDepth) {
      return false;
    }
    if (ancestors.has(frame.value)) {
      return false;
    }
    ancestors.add(frame.value);
    stack.push({ value: frame.value, depth: frame.depth, exiting: true });
    if (Array.isArray(frame.value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(frame.value, "length");
      if (
        lengthDescriptor == null
        || !("value" in lengthDescriptor)
        || lengthDescriptor.value !== frame.value.length
      ) {
        return false;
      }
      const ownKeys = Reflect.ownKeys(frame.value);
      let elementCount = 0;
      for (const key of ownKeys) {
        if (key === "length") {
          continue;
        }
        if (typeof key !== "string" || !/^\d+$/u.test(key)) {
          return false;
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= frame.value.length || String(index) !== key) {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
        if (descriptor == null || !("value" in descriptor)) {
          return false;
        }
        elementCount += 1;
        stack.push({ value: descriptor.value, depth: frame.depth + 1, exiting: false });
      }
      if (elementCount !== frame.value.length) {
        return false;
      }
      continue;
    }
    const prototype = Reflect.getPrototypeOf(frame.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of Reflect.ownKeys(frame.value)) {
      if (typeof key !== "string" || hasControlCharacter(key)) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key);
      if (
        descriptor == null
        || descriptor.enumerable !== true
        || !("value" in descriptor)
      ) {
        return false;
      }
      stack.push({ value: descriptor.value, depth: frame.depth + 1, exiting: false });
    }
  }
  return true;
}

const toolIdSchema = z
  .string()
  .min(1)
  .max(maximumIdentifierCharacters)
  .regex(/^[a-z][a-z0-9._-]*$/u, "外部ツールIDが不正です。");

const executableSchema = z
  .string()
  .min(1)
  .max(maximumExecutableCharacters)
  .refine((value) => !hasControlCharacter(value), "実行ファイルに制御文字を指定できません。")
  .refine(
    (value) => !/[;&|<>`$]/u.test(value),
    "実行ファイルにシェル演算子を指定できません。",
  );

const commandSchema = z
  .string()
  .min(1)
  .max(maximumIdentifierCharacters)
  .regex(/^[a-z][a-z0-9._:-]*$/u, "外部ツールのサブコマンドが不正です。")
  .refine(isReadOnlyCommand, "書き込み系サブコマンドは登録できません。");

const argumentSchema = z
  .string()
  .refine((value) => value.length > 0, "外部ツール引数を空にできません。")
  .refine((value) => value.length <= maximumExecutableCharacters, "外部ツール引数が長すぎます。")
  .refine((value) => !hasControlCharacter(value), "外部ツール引数に制御文字を指定できません。")
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= externalToolMaxArgumentBytes,
    "外部ツール引数が長すぎます。",
  );

const argumentNameSchema = z
  .string()
  .min(3)
  .max(maximumArgumentNameCharacters)
  .regex(/^--[a-z][a-z0-9-]{0,63}$/u, "外部ツール引数名が不正です。")
  .refine(isSafeArgumentName, "危険な外部ツール引数名は登録できません。");

const domainSchema = z
  .string()
  .min(1)
  .max(maximumDomainCharacters)
  .refine(isAllowedDomain, "外部ツールの許可ドメインが不正です。");

const httpMethodSchema = z.enum(["GET", "HEAD", "OPTIONS"]);

const capabilitySchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "外部ツールの能力値が不正です。");

const windowsPipePrefix = "\\\\.\\pipe\\";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(maximumExecutableCharacters)
  .refine(isAbsolute, "パスは絶対パスで指定してください。")
  .refine((value) => !hasControlCharacter(value), "パスに制御文字を指定できません。")
  .refine((value) => !value.includes("\0"), "パスにNUL文字を指定できません。")
  .refine(
    (value) => !value.toLowerCase().startsWith(windowsPipePrefix),
    "名前付きパイプは専用形式で指定してください。",
  );

const endpointSchema = absolutePathSchema.refine(
  () => process.platform !== "win32",
  "Windowsでは安全なIPC権限境界を検証できません。",
);

const jsonValueSchema = z.custom<JsonValue>(isSafeJsonValue, {
  message: "外部ツール出力は制御文字のないJSON値でなければなりません。",
});

const statusEvidenceLocatorSchema = createUtf8ByteLimitedStringSchema(
  maximumStatusEvidenceLocatorBytes,
)
  .refine((value) => value.trim() === value && value.length > 0, {
    message: "外部状態根拠locatorは前後に空白のない空でない文字列で指定してください。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "外部状態根拠locatorに制御文字を指定できません。",
  });

const statusEvidenceTargetTaskGidSchema = createUtf8ByteLimitedStringSchema(
  maximumStatusEvidenceTargetTaskGidBytes,
)
  .refine((value) => gidSchema.safeParse(value).success, {
    message: "外部状態根拠の対象タスクGIDが不正です。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "外部状態根拠の対象タスクGIDに制御文字を指定できません。",
  });

const statusEvidenceAttemptIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value && !/\s/u.test(value), {
    message: "外部状態根拠attempt IDは空白を含まない値で指定してください。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "外部状態根拠attempt IDに制御文字を指定できません。",
  });

/** 外部ツール実行開始時に捕捉する収集attemptを検証するスキーマです。 */
export const externalToolStatusEvidenceAttemptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inactive") }).strict(),
  z
    .object({
      kind: z.literal("active"),
      attempt_id: statusEvidenceAttemptIdSchema,
    })
    .strict(),
]);

/** 外部ツール出力から得た完了・取り下げ根拠を検証するスキーマです。 */
export const externalToolStatusEvidenceSchema = z
  .object({
    kind: z.literal("external_tool"),
    locator: statusEvidenceLocatorSchema,
    target_task_gid: statusEvidenceTargetTaskGidSchema,
    status: z.enum(["closed", "completed", "cancelled"]),
  })
  .strict();

/** 一回の外部ツール応答に含める構造化根拠を検証するスキーマです。 */
export const externalToolStatusEvidenceCollectionSchema = z
  .array(externalToolStatusEvidenceSchema)
  .max(externalToolMaxStatusEvidence)
  .superRefine((evidence, context) => {
    const seen = new Set<string>();
    evidence.forEach((item, index) => {
      if (seen.has(item.locator)) {
        context.addIssue({
          code: "custom",
          path: [index, "locator"],
          message: "外部状態根拠locatorを重複指定できません。",
        });
        return;
      }
      seen.add(item.locator);
    });
  });

export const externalToolErrorCodeSchema = z.enum([
  "invalid_request",
  "capability_invalid",
  "tool_not_registered",
  "forbidden_subcommand",
  "forbidden_write_operation",
  "forbidden_network",
  "tool_not_found",
  "tool_execution_failed",
  "execution_timeout",
  "output_too_large",
  "invalid_output",
  "invalid_utf8",
  "broker_unavailable",
  "broker_stopped",
  "broker_start_failed",
  "broker_stop_failed",
  "ipc_unavailable",
  "permission_denied",
  "response_too_large",
  "registry_conflict",
  "aborted",
  "internal_error",
]);

const disabledReasonSchema = z.enum([
  "unsupported_platform",
  "ipc_unavailable",
  "permission_denied",
]);

const diagnosticCodeSchema = z.enum([
  "startup_error",
  "server_error",
  "socket_error",
  "request_error",
  "execution_error",
  "response_error",
  "stop_error",
]);

/** 読み取り専用外部ツールの登録内容を検証するスキーマです。 */
export const externalToolDefinitionSchema = z
  .object({
    tool_id: toolIdSchema,
    executable: executableSchema,
    allowed_subcommands: z
      .array(commandSchema)
      .min(1)
      .max(externalToolMaxSubcommands),
    timeout_ms: z
      .number()
      .int()
      .min(1)
      .max(externalToolMaxExecutionMilliseconds),
    max_output_bytes: z
      .number()
      .int()
      .min(1)
      .max(externalToolMaxOutputBytes),
    read_only: z.literal(true),
    allowed_argument_names: z.array(argumentNameSchema).max(64),
    allowed_domains: z.array(domainSchema).max(externalToolMaxDomains).optional(),
    allowed_http_methods: z.array(httpMethodSchema).max(3).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const subcommands = new Set(value.allowed_subcommands);
    if (subcommands.size !== value.allowed_subcommands.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed_subcommands"],
        message: "同じサブコマンドを重複して登録できません。",
      });
    }
    if (value.allowed_domains != null) {
      const domains = new Set(value.allowed_domains);
      if (domains.size !== value.allowed_domains.length) {
        context.addIssue({
          code: "custom",
          path: ["allowed_domains"],
          message: "同じ許可ドメインを重複して登録できません。",
        });
      }
    }
    const argumentNames = new Set(value.allowed_argument_names);
    if (argumentNames.size !== value.allowed_argument_names.length) {
      context.addIssue({
        code: "custom",
        path: ["allowed_argument_names"],
        message: "同じ外部ツール引数名を重複して登録できません。",
      });
    }
    if (value.allowed_http_methods != null) {
      const methods = new Set(value.allowed_http_methods);
      if (methods.size !== value.allowed_http_methods.length) {
        context.addIssue({
          code: "custom",
          path: ["allowed_http_methods"],
          message: "同じHTTPメソッドを重複して登録できません。",
        });
      }
    }
  });

const invocationShape = {
  tool_id: toolIdSchema,
  subcommand: commandSchema,
  args: z.array(argumentSchema).max(externalToolMaxArguments),
};

/** 外部ツールを呼び出す読み取り専用要求を検証するスキーマです。 */
export const externalToolInvocationSchema = z.object(invocationShape).strict();

/** 外部ツールIPC要求を検証するスキーマです。 */
export const externalToolRequestSchema = z
  .object({
    version: z.literal(externalToolProtocolVersion),
    capability: capabilitySchema,
    ...invocationShape,
  })
  .strict();

export const externalToolOutputSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("json"),
      value: jsonValueSchema,
    })
    .strict(),
  z
    .object({
      format: z.literal("jsonl"),
      values: z.array(jsonValueSchema).min(1).max(externalToolMaxOutputRecords),
    })
    .strict(),
]);

/** 外部ツールの安全な構造化出力を検証するスキーマです。 */
export const externalToolExecutionResultSchema = z
  .object({
    tool_id: toolIdSchema,
    output: externalToolOutputSchema,
    evidence: externalToolStatusEvidenceCollectionSchema,
  })
  .strict();

const externalToolErrorSchema = z
  .object({
    code: externalToolErrorCodeSchema,
    message: z.string().min(1).max(120),
  })
  .strict();

/** 外部ツールIPCの構造化応答を検証するスキーマです。 */
export const externalToolResponseSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      tool_id: toolIdSchema,
      output: externalToolOutputSchema,
      evidence: externalToolStatusEvidenceCollectionSchema,
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: externalToolErrorSchema,
    })
    .strict(),
]);

/** 外部ツールブローカーの起動結果を検証するスキーマです。 */
export const externalToolBrokerStartResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ready"),
      version: z.literal(externalToolProtocolVersion),
      endpoint: endpointSchema,
      connection_info_path: absolutePathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("disabled"),
      reason: disabledReasonSchema,
    })
    .strict(),
]);

/** 外部ツールブローカーの安全な診断概要を検証するスキーマです。 */
export const externalToolDiagnosticSchema = z
  .object({
    code: diagnosticCodeSchema,
    cause_present: z.boolean(),
  })
  .strict();

/** 外部ツールブローカーの診断概要配列を検証するスキーマです。 */
export const externalToolDiagnosticsSchema = z
  .array(externalToolDiagnosticSchema)
  .max(externalToolMaxDiagnostics);

/** 外部ツールブローカーの起動設定を検証するスキーマです。 */
export const externalToolBrokerOptionsSchema = z
  .object({
    tmp_directory_path: absolutePathSchema,
    child_work_root_path: absolutePathSchema,
    registry: z.custom<ExternalToolRegistryLike>(
      (value) =>
        typeof value === "object"
        && value != null
        && typeof Reflect.get(value, "get") === "function"
        && typeof Reflect.get(value, "list") === "function",
      "外部ツールレジストリが必要です。",
    ),
    status_evidence_collector: z.custom<ExternalToolStatusEvidenceCollectorPort>(
      (value) => typeof value === "object"
        && value != null
        && typeof Reflect.get(value, "captureAttempt") === "function"
        && typeof Reflect.get(value, "record") === "function",
      "外部状態根拠collectorが必要です。",
    ),
  })
  .strict();

/** 外部ツール接続情報を検証するスキーマです。 */
export const externalToolConnectionInfoSchema = z
  .object({
    version: z.literal(externalToolProtocolVersion),
    endpoint: endpointSchema,
    capability: capabilitySchema,
  })
  .strict();

export type ExternalToolDefinition = z.infer<typeof externalToolDefinitionSchema>;
export type ExternalToolInvocation = z.infer<typeof externalToolInvocationSchema>;
export type ExternalToolRequest = z.infer<typeof externalToolRequestSchema>;
export type ExternalToolOutput = z.infer<typeof externalToolOutputSchema>;
export type ExternalToolStatusEvidence = z.infer<
  typeof externalToolStatusEvidenceSchema
>;
export type ExternalToolStatusEvidenceAttempt = z.infer<
  typeof externalToolStatusEvidenceAttemptSchema
>;
export type ExternalToolExecutionResult = z.infer<
  typeof externalToolExecutionResultSchema
>;
export type ExternalToolResponse = z.infer<typeof externalToolResponseSchema>;
export type ExternalToolBrokerStartResult = z.infer<
  typeof externalToolBrokerStartResultSchema
>;
export type ExternalToolDiagnostic = z.infer<typeof externalToolDiagnosticSchema>;
export type ExternalToolBrokerOptions = z.infer<typeof externalToolBrokerOptionsSchema>;
export type ExternalToolErrorCode = z.infer<typeof externalToolErrorCodeSchema>;
export type ExternalToolDisabledReason = z.infer<typeof disabledReasonSchema>;
export type ExternalToolDiagnosticCode = z.infer<typeof diagnosticCodeSchema>;

export type ExternalToolRegistryLike = {
  readonly get: (toolId: string) => ExternalToolDefinition;
  readonly list: () => readonly ExternalToolDefinition[];
};

export type ExternalToolStatusEvidenceCollectorPort = {
  readonly captureAttempt: () => ExternalToolStatusEvidenceAttempt;
  readonly record: (
    attempt: ExternalToolStatusEvidenceAttempt,
    output: ExternalToolOutput,
  ) => readonly ExternalToolStatusEvidence[];
};

export { isSafeJsonValue };
