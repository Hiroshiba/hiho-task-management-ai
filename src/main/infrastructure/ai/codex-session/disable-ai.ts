import type { ActiveTurn } from "./turn-coordinator";
import { CodexSessionDisabledError } from "./errors";

export type AiDisableRequest = {
  readonly cause: unknown;
  readonly turnFailure: { readonly kind: "disabled" } | { readonly kind: "provided"; readonly error: unknown };
  readonly diagnosticDisposition: { readonly kind: "record" } | { readonly kind: "already_recorded" } | { readonly kind: "propagate_unrecorded" };
};

export type AiDisableResult =
  | { readonly kind: "completed" }
  | { readonly kind: "cleanup_failed"; readonly errors: readonly unknown[] };

type FailureDisposition =
  | { readonly kind: "recorded_only"; readonly recorded_error: unknown; readonly response_error: unknown }
  | { readonly kind: "unrecorded_only"; readonly unrecorded_error: unknown; readonly response_error: unknown };

type DisableAiOptions<Result, Connection> = {
  readonly setDisabled: () => void;
  readonly recordDiagnosticAndNotify: (code: "ai_disabled" | "connection_stop_error", error: unknown) => void;
  readonly recordDiagnosticLocally: (code: "ai_disabled" | "connection_stop_error", error: unknown) => void;
  readonly cleanupResources: () => Promise<unknown[]>;
  readonly getActiveTurn: () => ActiveTurn<Result, Connection> | undefined;
  readonly finishTurn: (active: ActiveTurn<Result, Connection>, error: unknown) => void;
  readonly createTurnFailure: (cause: FailureDisposition, cleanup: readonly FailureDisposition[]) => unknown;
};

/** CodexのAI機能を無効化して残るターンを失敗させます。 */
export async function disableCodexAi<Result, Connection>(
  request: AiDisableRequest,
  options: DisableAiOptions<Result, Connection>,
): Promise<AiDisableResult> {
  options.setDisabled();
  if (request.diagnosticDisposition.kind === "record") {
    options.recordDiagnosticAndNotify("ai_disabled", request.cause);
  } else {
    options.recordDiagnosticLocally("ai_disabled", request.cause);
  }
  const cleanupErrors = await options.cleanupResources();
  const cleanupDispositions: FailureDisposition[] = cleanupErrors.map(
    (error): FailureDisposition => {
      if (request.diagnosticDisposition.kind !== "propagate_unrecorded") {
        options.recordDiagnosticAndNotify("connection_stop_error", error);
        return {
          kind: "recorded_only",
          recorded_error: error,
          response_error: error,
        };
      }
      options.recordDiagnosticLocally("connection_stop_error", error);
      return {
        kind: "unrecorded_only",
        unrecorded_error: error,
        response_error: error,
      };
    },
  );
  const turnError = request.turnFailure.kind === "provided"
    ? request.turnFailure.error
    : new CodexSessionDisabledError(request.cause);
  const causeDisposition: FailureDisposition = request.diagnosticDisposition.kind === "propagate_unrecorded"
    ? {
        kind: "unrecorded_only",
        unrecorded_error: request.cause,
        response_error: turnError,
      }
    : {
        kind: "recorded_only",
        recorded_error: request.cause,
        response_error: turnError,
      };
  const active = options.getActiveTurn();
  if (active != null) {
    options.finishTurn(
      active,
      options.createTurnFailure(causeDisposition, cleanupDispositions),
    );
  }
  if (cleanupErrors.length > 0) {
    return { kind: "cleanup_failed", errors: cleanupErrors };
  }
  return { kind: "completed" };
}
