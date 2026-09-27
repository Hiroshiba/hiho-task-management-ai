import { z } from "zod";
import {
  AiWorkflowRetryLogEventError,
  aiWorkflowRetryLogEventSchema,
  type AiWorkflowRetryLogEvent,
} from "./ai/workflow/retry";
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
import { getErrorMessage, getErrorName, getStackTrace, isObject } from "./infrastructure/logging/error-detail-base";
import { getSafeZodDetail, maximumZodIssues, safeZodIssueSchema, type SafeZodIssue } from "./infrastructure/logging/safe-zod-issues";

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

type SafeCodexTurnFailure = z.infer<typeof safeCodexTurnFailureSchema>;
type AsanaHttpErrorResponseBodyKindValue = AsanaHttpErrorResponseBodyKind;

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
      error_name: getErrorName(value, redactSensitiveText),
      error_message: getErrorMessage(value, redactSensitiveText),
      stack_trace: getStackTrace(value, redactSensitiveText),
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

/** 現行の診断詳細形式と伏せ字処理をJSONL sinkへ渡します。 */
export const persistentErrorLogFormatter = {
  createDetail(error: unknown): ErrorDetail {
    return errorDetailSchema.parse(createErrorDetail(error, new WeakSet<object>()));
  },
  redactText: redactSensitiveText,
};
