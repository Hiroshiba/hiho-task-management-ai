import { writeSync } from "node:fs";
import { getErrorMessage, getErrorName, getStackTrace, isObject } from "./error-detail-base";
import { redactKnownSecrets } from "./redact-known-secrets";

type ErrorDetail = {
  error_name: string;
  error_message: string;
  stack_trace: string;
  cause_chain: ErrorDetail[];
  aggregate_errors: ErrorDetail[];
};

function createFallbackDetail(
  error: unknown,
  knownSecrets: readonly string[],
  redactText: (value: string) => string,
  ancestors: WeakSet<object>,
): ErrorDetail {
  if (isObject(error) && ancestors.has(error)) {
    return {
      error_name: "CyclicError",
      error_message: "循環参照を検出しました。",
      stack_trace: "",
      cause_chain: [],
      aggregate_errors: [],
    };
  }
  const objectError = isObject(error);
  if (objectError) ancestors.add(error);
  try {
    const sanitize = (value: string): string => redactKnownSecrets(value, knownSecrets, redactText);
    const detail: ErrorDetail = {
      error_name: getErrorName(error, sanitize),
      error_message: getErrorMessage(error, sanitize),
      stack_trace: getStackTrace(error, sanitize),
      cause_chain: [],
      aggregate_errors: [],
    };
    if (error instanceof Error && Object.prototype.hasOwnProperty.call(error, "cause")) {
      detail.cause_chain.push(createFallbackDetail(error.cause, knownSecrets, redactText, ancestors));
    }
    if (error instanceof AggregateError) {
      for (const aggregateError of error.errors) {
        detail.aggregate_errors.push(createFallbackDetail(aggregateError, knownSecrets, redactText, ancestors));
      }
    }
    return detail;
  } finally {
    if (objectError) ancestors.delete(error);
  }
}

/** ログ保存先の故障時に置換済みの原因とスタックを標準エラーへ記録します。 */
export function writeErrorReportFailure(
  error: unknown,
  knownSecrets: readonly string[],
  redactText: (value: string) => string,
): void {
  const details = createFallbackDetail(error, knownSecrets, redactText, new WeakSet<object>());
  const failureMessage = `永続エラーログの書き込みに失敗しました。\n${JSON.stringify(details)}\n`;
  writeSync(2, Buffer.from(failureMessage, "utf8"));
}
