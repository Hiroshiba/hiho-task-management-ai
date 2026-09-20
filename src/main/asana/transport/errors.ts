import { z } from "zod";

const asanaHttpErrorResponseBodyKindSchema = z.enum([
  "parsed",
  "non_json",
  "invalid_json",
  "invalid_shape",
  "unavailable",
  "timeout",
  "too_large",
]);

const asanaHttpErrorResponseErrorSchema = z
  .object({
    message: z.string().optional(),
    help: z.string().optional(),
    phrase: z.string().optional(),
  })
  .strip()
  .superRefine((error, context) => {
    if (error.message == null && error.help == null && error.phrase == null) {
      context.addIssue({
        code: "custom",
        message: "Asana APIのErrorResponse要素に許可されたフィールドがありません。",
      });
    }
  });

function rejectTopLevelErrorFields(
  value: unknown,
  context: z.RefinementCtx,
): unknown {
  if (typeof value === "object" && value != null && !Array.isArray(value)) {
    for (const key of ["message", "help", "phrase"]) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        context.addIssue({
          code: "custom",
          message: `Asana APIのErrorResponseに${key}をトップレベル指定できません。`,
        });
      }
    }
  }
  return value;
}

const asanaHttpErrorResponseFieldsSchema = z.object({
  errors: z.array(asanaHttpErrorResponseErrorSchema).min(1),
}).strip();
const asanaHttpErrorResponsePayloadSchema = z.preprocess(
  rejectTopLevelErrorFields,
  asanaHttpErrorResponseFieldsSchema,
);
const asanaHttpErrorResponseSchema = z.preprocess(
  rejectTopLevelErrorFields,
  z.union([
    asanaHttpErrorResponseFieldsSchema.extend({
      response_body_kind: z.literal("parsed").optional(),
    }),
    z.object({
      response_body_kind: asanaHttpErrorResponseBodyKindSchema.exclude(["parsed"]),
    }).strip(),
  ]),
);

export function safeParseAsanaHttpErrorResponse(
  value: unknown,
): AsanaHttpErrorResponse | undefined {
  const parsed = asanaHttpErrorResponsePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

const asanaHttpErrorStatusSchema = z.number().int().min(100).max(599);
const asanaHttpErrorRequestIdSchema = z.string().min(1);
const asanaHttpErrorSourceSchema = z.enum(["rest", "oauth"]);

export type AsanaHttpErrorResponseBodyKind = z.infer<
  typeof asanaHttpErrorResponseBodyKindSchema
>;
export type AsanaHttpErrorResponseError = z.infer<
  typeof asanaHttpErrorResponseErrorSchema
>;
export type AsanaHttpErrorResponse = z.infer<typeof asanaHttpErrorResponseSchema>;
export type AsanaHttpErrorSource = z.infer<typeof asanaHttpErrorSourceSchema>;

/** Asana APIとの通信に失敗したことを表します。 */
export class AsanaTransportError extends Error {
  public constructor(cause: unknown) {
    super("Asana APIとの通信に失敗しました。", { cause });
    this.name = "AsanaTransportError";
  }
}

/** Asana APIの成功レスポンスを解釈できないことを表します。 */
export class AsanaResponseError extends Error {
  public constructor(cause: unknown) {
    super("Asana APIのレスポンスを解釈できません。", { cause });
    this.name = "AsanaResponseError";
  }
}

/** Asana APIの認証に失敗したことを表します。 */
export class AsanaAuthenticationError extends Error {
  public constructor(cause?: unknown) {
    super("Asana APIの認証に失敗しました。", { cause });
    this.name = "AsanaAuthenticationError";
  }
}

/** Asana Events APIが新しい同期トークンを要求したことを表すエラーです。 */
export class AsanaEventsResetError extends Error {
  public readonly syncToken: string;

  public constructor(syncToken: string) {
    super("Asana Events APIの同期トークンを更新してください。");
    this.name = "AsanaEventsResetError";
    this.syncToken = syncToken;
  }
}

/** Asana APIが支払いを要求したことを表します。 */
export class AsanaPaymentRequiredError extends Error {
  public constructor(cause?: unknown) {
    super("Asana APIの利用に支払いが必要です。", { cause });
    this.name = "AsanaPaymentRequiredError";
  }
}

/** Asana APIがその他のHTTPエラーを返したことを表します。 */
export class AsanaHttpError extends Error {
  public readonly status: number;
  public readonly requestId?: string;
  public readonly source: AsanaHttpErrorSource;
  public readonly errors?: readonly AsanaHttpErrorResponseError[];
  public readonly responseBodyKind?: AsanaHttpErrorResponseBodyKind;

  public constructor(
    status: number,
    requestId: string | undefined,
    response: AsanaHttpErrorResponse,
    source: AsanaHttpErrorSource,
  ) {
    super("Asana APIがHTTPエラーを返しました。");
    this.name = "AsanaHttpError";
    this.status = asanaHttpErrorStatusSchema.parse(status);
    this.source = asanaHttpErrorSourceSchema.parse(source);
    const validatedResponse = asanaHttpErrorResponseSchema.parse(response);
    if (requestId != null) {
      this.requestId = asanaHttpErrorRequestIdSchema.parse(requestId);
    }
    if ("errors" in validatedResponse) {
      this.errors = validatedResponse.errors;
    }
    if (validatedResponse.response_body_kind != null) {
      this.responseBodyKind = validatedResponse.response_body_kind;
    }
  }
}

/** REST由来のAsana HTTPエラーを原因連鎖から検出します。 */
export function hasRestAsanaHttpError(value: unknown): boolean {
  return hasRestAsanaHttpErrorIn(value, new WeakSet<object>());
}

function hasRestAsanaHttpErrorIn(
  value: unknown,
  ancestors: WeakSet<object>,
): boolean {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  ancestors.add(value);
  try {
    if (value instanceof AsanaHttpError && value.source === "rest") {
      return true;
    }
    if (
      value instanceof Error
      && Object.prototype.hasOwnProperty.call(value, "cause")
      && hasRestAsanaHttpErrorIn(value.cause, ancestors)
    ) {
      return true;
    }
    if (value instanceof AggregateError) {
      return value.errors.some((error) => hasRestAsanaHttpErrorIn(error, ancestors));
    }
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function collectRestAsanaHttpStatuses(
  value: unknown,
  statuses: Set<number>,
  ancestors: WeakSet<object>,
): void {
  if (typeof value !== "object" || value == null) {
    return;
  }
  if (ancestors.has(value)) {
    return;
  }
  ancestors.add(value);
  try {
    if (value instanceof AsanaHttpError && value.source === "rest") {
      statuses.add(value.status);
    }
    if (value instanceof Error && Object.prototype.hasOwnProperty.call(value, "cause")) {
      collectRestAsanaHttpStatuses(value.cause, statuses, ancestors);
    }
    if (value instanceof AggregateError) {
      for (const aggregateError of value.errors) {
        collectRestAsanaHttpStatuses(aggregateError, statuses, ancestors);
      }
    }
  } finally {
    ancestors.delete(value);
  }
}

/** 原因連鎖から一意なREST由来Asana HTTP statusを取得します。 */
export function getUniqueAsanaHttpStatus(value: unknown): number | undefined {
  const statuses = new Set<number>();
  collectRestAsanaHttpStatuses(value, statuses, new WeakSet<object>());
  if (statuses.size !== 1) {
    return undefined;
  }
  const [status] = statuses;
  if (status == null) {
    throw new Error("Asana HTTP statusの抽出結果が不正です。");
  }
  return status;
}

/** Asana APIのレート制限により再試行できないことを表します。 */
export class AsanaRateLimitError extends Error {
  public constructor(cause?: unknown) {
    super("Asana APIのRetry-Afterが不正です、または再試行上限に達しました。", {
      cause,
    });
    this.name = "AsanaRateLimitError";
  }
}
