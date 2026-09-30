import {
  asanaPostWriteSynchronizationResultSchema,
  type PostWriteSynchronizationFailureCode,
  type PostWriteSynchronizationResult,
  type PostWriteSynchronizationResultWithCause,
} from "../application/common/proposal-application-schemas";
import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaOAuthHttpError,
  AsanaOAuthResponseError,
  AsanaOAuthTransportError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaRequestAbortedError,
  AsanaResponseError,
  AsanaSyncInProgressError,
  AsanaTransportError,
  type AsanaSyncRuntimeInternalResult,
} from "../infrastructure/asana";

type PostWriteErrorClassification =
  | { readonly kind: "recovery_required"; readonly error_code: PostWriteSynchronizationFailureCode }
  | { readonly kind: "unexpected" };

/** Asana書き込み後同期の失敗を復旧可能な種類へ分類します。 */
export function classifyPostWriteSynchronizationError(error: unknown): PostWriteErrorClassification {
  if (error instanceof AsanaAuthenticationError) {
    return { kind: "recovery_required", error_code: "authentication_required" };
  }
  if (error instanceof AsanaPaymentRequiredError) {
    return { kind: "recovery_required", error_code: "payment_required" };
  }
  if (error instanceof AsanaRateLimitError) {
    return { kind: "recovery_required", error_code: "rate_limited" };
  }
  if (error instanceof AsanaHttpError || error instanceof AsanaOAuthHttpError) {
    return { kind: "recovery_required", error_code: "http_error" };
  }
  if (error instanceof AsanaTransportError || error instanceof AsanaOAuthTransportError) {
    return { kind: "recovery_required", error_code: "transport_error" };
  }
  if (error instanceof AsanaResponseError || error instanceof AsanaOAuthResponseError) {
    return { kind: "recovery_required", error_code: "response_error" };
  }
  if (error instanceof AsanaEventsResetError) {
    return { kind: "recovery_required", error_code: "events_reset" };
  }
  if (error instanceof AsanaRequestAbortedError) {
    return { kind: "recovery_required", error_code: "request_aborted" };
  }
  if (error instanceof AsanaSyncInProgressError) {
    return { kind: "recovery_required", error_code: "sync_in_progress" };
  }
  return { kind: "unexpected" };
}

/** 保存済み設定の再照合失敗後もキャッシュ起動できるか判定します。 */
export function canResumeReadyStateAfterRevalidationFailure(error: unknown): boolean {
  if (error instanceof AsanaRequestAbortedError) return false;
  return classifyPostWriteSynchronizationError(error).kind === "recovery_required";
}

/** 書き込み後同期の復旧待ち結果を作ります。 */
export function postWriteRecoveryRequired(
  errorCode: PostWriteSynchronizationFailureCode,
): PostWriteSynchronizationResult {
  return asanaPostWriteSynchronizationResultSchema.parse({
    kind: "recovery_required",
    error_code: errorCode,
  });
}

/** 元の失敗を保持した書き込み後同期の復旧待ち結果を作ります。 */
export function postWriteRecoveryRequiredWithCause(
  errorCode: PostWriteSynchronizationFailureCode,
  cause: unknown,
): PostWriteSynchronizationResultWithCause {
  return { ...postWriteRecoveryRequired(errorCode), cause };
}

/** Asana同期ランタイムの結果を書き込み後同期の結果へ変換します。 */
export function postWriteSynchronizationFromRuntimeResult(
  result: AsanaSyncRuntimeInternalResult,
): PostWriteSynchronizationResultWithCause {
  switch (result.kind) {
    case "synchronized":
      return asanaPostWriteSynchronizationResultSchema.parse({ kind: "synchronized" });
    case "rejected":
      return postWriteRecoveryRequired(result.reason);
    case "aborted":
      return postWriteRecoveryRequired("aborted");
    case "failed":
      switch (result.error_code) {
        case "authentication_required":
        case "payment_required":
        case "rate_limited":
        case "http_error":
        case "transport_error":
        case "response_error":
        case "events_reset":
        case "request_aborted":
        case "sync_in_progress":
          return postWriteRecoveryRequiredWithCause(result.error_code, result.cause);
        case "unexpected_error":
          throw new Error("書き込み後の同期が想定外エラーで停止しました。", { cause: result.cause });
      }
  }
}
