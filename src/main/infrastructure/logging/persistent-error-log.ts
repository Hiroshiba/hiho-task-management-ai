import { z } from "zod";
import {
  AiWorkflowRetryLogEventError,
  aiWorkflowRetryLogEventSchema,
  type AiWorkflowRetryLogEvent,
} from "../../application/common/ports/ai-workflow-retry";
import { redactSensitiveText } from "./redact-sensitive-text";
import { getErrorMessage, getErrorName, getStackTrace, isObject } from "./error-detail-base";
import { getSafeZodDetail, maximumZodIssues, safeZodIssueSchema, type SafeZodIssue } from "./safe-zod-issues";

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
const asanaHttpErrorResponseBodyKindSchema = z.enum([
  "parsed",
  "non_json",
  "invalid_json",
  "invalid_shape",
  "unavailable",
  "timeout",
  "too_large",
]);

type SafeCodexTurnFailure = z.infer<typeof safeCodexTurnFailureSchema>;
type RestAsanaHttpErrorDetail = {
  readonly status: number;
  readonly requestId?: string;
  readonly errors?: readonly {
    readonly message?: string | undefined;
    readonly help?: string | undefined;
    readonly phrase?: string | undefined;
  }[];
  readonly responseBodyKind?: z.infer<typeof asanaHttpErrorResponseBodyKindSchema>;
};
type RestAsanaHttpErrorDetailProvider = (
  value: unknown,
) => RestAsanaHttpErrorDetail | undefined;
type CodexDiagnosticDetailAdapter = {
  readonly capabilityFailureSchema: z.ZodType<string>;
  readonly rpcOperationSchema: z.ZodType<string>;
  readonly rpcCodeSchema: z.ZodType<number>;
  readonly read: (value: unknown, redactText: (value: string) => string) => {
    readonly capability_failure?: string;
    readonly rpc_operation?: string;
    readonly rpc_code?: number;
    readonly rpc_message?: string;
  };
};

type ErrorDetail = {
  error_name: string;
  error_message: string;
  stack_trace: string;
  cause_chain: ErrorDetail[];
  aggregate_errors: ErrorDetail[];
  zod_issues?: SafeZodIssue[] | undefined;
  codex_turn_failure?: SafeCodexTurnFailure | undefined;
  capability_failure?: string | undefined;
  rpc_operation?: string | undefined;
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
    response_body_kind: asanaHttpErrorResponseBodyKindSchema.optional(),
  })
  .strict();

type AsanaHttpErrorDetail = z.infer<typeof asanaHttpErrorDetailSchema>;

function createErrorDetailSchema(
  codexDiagnosticDetail: CodexDiagnosticDetailAdapter,
): z.ZodType<ErrorDetail> {
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
        capability_failure: codexDiagnosticDetail.capabilityFailureSchema.optional(),
        rpc_operation: codexDiagnosticDetail.rpcOperationSchema.optional(),
        rpc_code: codexDiagnosticDetail.rpcCodeSchema.optional(),
        rpc_message: z.string().optional(),
        retry_event: aiWorkflowRetryLogEventSchema.optional(),
        asana_http: asanaHttpErrorDetailSchema.optional(),
      })
      .strict(),
  );
  return errorDetailSchema;
}

function getAsanaHttpDetail(
  value: unknown,
  getRestAsanaHttpErrorDetail: RestAsanaHttpErrorDetailProvider,
): Pick<ErrorDetail, "asana_http"> {
  const httpError = getRestAsanaHttpErrorDetail(value);
  if (httpError == null) {
    return {};
  }
  const errors = httpError.errors?.map((error) => ({
    ...(error.message == null ? {} : { message: redactSensitiveText(error.message) }),
    ...(error.help == null ? {} : { help: redactSensitiveText(error.help) }),
    ...(error.phrase == null ? {} : { phrase: redactSensitiveText(error.phrase) }),
  }));
  const detail = asanaHttpErrorDetailSchema.parse({
    status: httpError.status,
    ...(httpError.requestId == null
      ? {}
      : { request_id: redactSensitiveText(httpError.requestId) }),
    ...(errors == null ? {} : { errors }),
    ...(httpError.responseBodyKind == null
      ? {}
      : { response_body_kind: httpError.responseBodyKind }),
  });
  return { asana_http: detail };
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

function createErrorDetail(
  value: unknown,
  ancestors: WeakSet<object>,
  getRestAsanaHttpErrorDetail: RestAsanaHttpErrorDetailProvider,
  codexDiagnosticDetail: CodexDiagnosticDetailAdapter,
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
      ...codexDiagnosticDetail.read(value, redactSensitiveText),
      ...getAiWorkflowRetryEventDetail(value),
      ...getAsanaHttpDetail(value, getRestAsanaHttpErrorDetail),
    };

    if (value instanceof Error && Object.prototype.hasOwnProperty.call(value, "cause")) {
      detail.cause_chain.push(createErrorDetail(
        value.cause,
        ancestors,
        getRestAsanaHttpErrorDetail,
        codexDiagnosticDetail,
      ));
    }
    if (value instanceof AggregateError) {
      for (const aggregateError of value.errors) {
        detail.aggregate_errors.push(createErrorDetail(
          aggregateError,
          ancestors,
          getRestAsanaHttpErrorDetail,
          codexDiagnosticDetail,
        ));
      }
    }
    return detail;
  } finally {
    if (objectValue) {
      ancestors.delete(value);
    }
  }
}

/** 診断詳細形式と伏せ字処理をJSONL sinkへ渡す整形器を作ります。 */
export function createPersistentErrorLogFormatter(
  getRestAsanaHttpErrorDetail: RestAsanaHttpErrorDetailProvider,
  codexDiagnosticDetail: CodexDiagnosticDetailAdapter,
): {
  readonly createDetail: (error: unknown) => ErrorDetail;
  readonly redactText: (value: string) => string;
} {
  const errorDetailSchema = createErrorDetailSchema(codexDiagnosticDetail);
  return {
    createDetail(error: unknown): ErrorDetail {
      return errorDetailSchema.parse(
        createErrorDetail(
          error,
          new WeakSet<object>(),
          getRestAsanaHttpErrorDetail,
          codexDiagnosticDetail,
        ),
      );
    },
    redactText: redactSensitiveText,
  };
}
