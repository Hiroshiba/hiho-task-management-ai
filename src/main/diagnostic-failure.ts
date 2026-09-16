import { z } from "zod";

const diagnosticFailureDispositionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("recorded_only"),
    recorded_error: z.unknown(),
    response_error: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal("unrecorded_only"),
    unrecorded_error: z.unknown(),
    response_error: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal("recorded_and_unrecorded"),
    recorded_error: z.unknown(),
    unrecorded_error: z.unknown(),
    response_error: z.unknown(),
  }).strict(),
]);

export type DiagnosticFailureDisposition = z.infer<
  typeof diagnosticFailureDispositionSchema
>;

function diagnosticFailureCause(
  disposition: DiagnosticFailureDisposition,
): unknown {
  switch (disposition.kind) {
    case "recorded_only":
      return disposition.recorded_error;
    case "unrecorded_only":
      return disposition.unrecorded_error;
    case "recorded_and_unrecorded":
      return new AggregateError(
        [disposition.recorded_error, disposition.unrecorded_error],
        "記録済みと未記録のエラーが併存しています。",
        { cause: disposition.response_error },
      );
  }
}

/** 診断記録の状態とIPC応答に使う元エラーを表します。 */
export class DiagnosticFailureDispositionError extends Error {
  public readonly disposition: DiagnosticFailureDisposition;

  public constructor(disposition: DiagnosticFailureDisposition) {
    const validatedDisposition = diagnosticFailureDispositionSchema.parse(disposition);
    super("診断記録が必要な処理に失敗しました。", {
      cause: diagnosticFailureCause(validatedDisposition),
    });
    this.name = "DiagnosticFailureDispositionError";
    this.disposition = validatedDisposition;
  }
}

/** 未記録の通常エラーを診断失敗のDispositionへ変換します。 */
export function diagnosticFailureDispositionFromError(
  error: unknown,
): DiagnosticFailureDisposition {
  if (error instanceof DiagnosticFailureDispositionError) {
    return error.disposition;
  }
  return {
    kind: "unrecorded_only",
    unrecorded_error: error,
    response_error: error,
  };
}

function aggregateDispositionErrors(
  errors: readonly unknown[],
  message: string,
): unknown {
  if (errors.length === 0) {
    throw new Error("診断Dispositionにエラーがありません。");
  }
  if (errors.length === 1) {
    const [error] = errors;
    return error;
  }
  return new AggregateError(errors, message, { cause: errors[0] });
}

/** 型付きDispositionを記録状態ごとにまとめます。 */
export function combineDiagnosticFailureDispositions(
  primaryDisposition: DiagnosticFailureDisposition,
  additionalDispositions: readonly DiagnosticFailureDisposition[],
): DiagnosticFailureDisposition {
  const validatedPrimaryDisposition = diagnosticFailureDispositionSchema.parse(
    primaryDisposition,
  );
  const validatedAdditionalDispositions = additionalDispositions.map((disposition) =>
    diagnosticFailureDispositionSchema.parse(disposition));
  const validatedDispositions = [
    validatedPrimaryDisposition,
    ...validatedAdditionalDispositions,
  ];
  const recordedErrors: unknown[] = [];
  const unrecordedErrors: unknown[] = [];
  for (const disposition of validatedDispositions) {
    switch (disposition.kind) {
      case "recorded_only":
        recordedErrors.push(disposition.recorded_error);
        break;
      case "unrecorded_only":
        unrecordedErrors.push(disposition.unrecorded_error);
        break;
      case "recorded_and_unrecorded":
        recordedErrors.push(disposition.recorded_error);
        unrecordedErrors.push(disposition.unrecorded_error);
        break;
    }
  }
  const responseError = validatedPrimaryDisposition.response_error;
  if (recordedErrors.length === 0) {
    return {
      kind: "unrecorded_only",
      unrecorded_error: aggregateDispositionErrors(
        unrecordedErrors,
        "複数の未記録エラーが併存しています。",
      ),
      response_error: responseError,
    };
  }
  if (unrecordedErrors.length === 0) {
    return {
      kind: "recorded_only",
      recorded_error: aggregateDispositionErrors(
        recordedErrors,
        "複数の記録済みエラーが併存しています。",
      ),
      response_error: responseError,
    };
  }
  return {
    kind: "recorded_and_unrecorded",
    recorded_error: aggregateDispositionErrors(
      recordedErrors,
      "複数の記録済みエラーが併存しています。",
    ),
    unrecorded_error: aggregateDispositionErrors(
      unrecordedErrors,
      "複数の未記録エラーが併存しています。",
    ),
    response_error: responseError,
  };
}

/** 通常エラー群の記録状態を保ったDispositionへまとめます。 */
export function combineDiagnosticFailures(
  errors: readonly unknown[],
): DiagnosticFailureDispositionError {
  if (errors.length === 0) {
    throw new Error("診断対象のエラーがありません。");
  }
  const [primaryError, ...additionalErrors] = errors;
  const primaryDisposition = diagnosticFailureDispositionFromError(primaryError);
  const additionalDispositions = additionalErrors.map(
    diagnosticFailureDispositionFromError,
  );
  return new DiagnosticFailureDispositionError(
    combineDiagnosticFailureDispositions(
      primaryDisposition,
      additionalDispositions,
    ),
  );
}
