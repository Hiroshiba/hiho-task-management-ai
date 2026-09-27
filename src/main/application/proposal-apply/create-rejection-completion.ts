import { type JournalStage } from "./journal-progress";

type RejectionEntry = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly stage: JournalStage;
};
type RejectionContext = {
  readonly group: { readonly group_id: string };
  readonly operation: { readonly operation_id: string; readonly operation: string };
};
type RejectionFields = {
  readonly severity: "error";
  readonly api_action: "create_task" | "journal_plan";
  readonly journal_stage: JournalStage;
  readonly effect_certainty: "none";
  readonly reason_code: "external_api_failed" | "recovery_required";
  readonly recovery_decision: "not_applied" | "unresolved";
  readonly attempt: number;
  readonly phase: "external_write" | "journal";
};
type RejectionPorts<TEntry extends RejectionEntry, TContext extends RejectionContext, TResult, TDisposition extends { readonly kind: string }> = {
  readonly reportOperationEventOnce: (error: unknown, entry: { readonly journal: TEntry; readonly context: TContext }, fields: RejectionFields, taskGid: string | undefined) => { readonly disposition: TDisposition };
  readonly dispositionFromError: (error: unknown) => TDisposition;
  readonly combineDispositions: (primary: TDisposition, additional: readonly TDisposition[]) => TDisposition;
  readonly createDispositionError: (disposition: TDisposition) => Error;
  readonly journal: { readonly complete: (proposalId: string, operationId: string, result: "applied" | "not_applied" | "unknown" | "failed") => void };
  readonly finalJournalResult: (value: "not_applied") => "applied" | "not_applied" | "unknown" | "failed";
  readonly createResult: (groupId: string, operationId: string, outcome: "not_applied", reasonCode: "external_api_failed", taskGid: string | undefined) => TResult;
};

/** 作成APIの確定的な拒否を未適用として保存します。 */
export function completeDefinitiveCreateTaskRejection<TEntry extends RejectionEntry, TContext extends RejectionContext, TResult, TDisposition extends { readonly kind: string }>(
  error: unknown,
  entry: TEntry,
  entryForProgress: TEntry,
  context: TContext,
  writeAttemptCount: number,
  taskGid: string | undefined,
  ports: RejectionPorts<TEntry, TContext, TResult, TDisposition>,
): TResult {
    let diagnosticDisposition: TDisposition;
    try {
      diagnosticDisposition = ports.reportOperationEventOnce(
        error,
        { journal: entryForProgress, context },
        {
          severity: "error",
          api_action: "create_task",
          journal_stage: entryForProgress.stage,
          effect_certainty: "none",
          reason_code: "external_api_failed",
          recovery_decision: "not_applied",
          attempt: Math.max(1, writeAttemptCount),
          phase: "external_write",
        },
        taskGid,
      ).disposition;
    } catch (diagnosticError: unknown) {
      diagnosticDisposition = ports.dispositionFromError(diagnosticError);
    }

    type CompletionState =
      | { readonly kind: "completed" }
      | { readonly kind: "failed"; readonly error: unknown };
    let completion: CompletionState;
    try {
      ports.journal.complete(
        entry.proposal_id,
        entry.operation_id,
        ports.finalJournalResult("not_applied"),
      );
      completion = { kind: "completed" };
    } catch (completionError: unknown) {
      completion = { kind: "failed", error: completionError };
    }

    if (completion.kind === "failed") {
      let completionDiagnosticDisposition: TDisposition;
      try {
        completionDiagnosticDisposition = ports.reportOperationEventOnce(
          completion.error,
          { journal: entryForProgress, context },
          {
            severity: "error",
            api_action: "journal_plan",
            journal_stage: entryForProgress.stage,
            effect_certainty: "none",
            reason_code: "recovery_required",
            recovery_decision: "unresolved",
            attempt: Math.max(1, writeAttemptCount),
            phase: "journal",
          },
          taskGid,
        ).disposition;
      } catch (diagnosticError: unknown) {
        completionDiagnosticDisposition = ports.dispositionFromError(
          diagnosticError,
        );
      }
      throw ports.createDispositionError(
        ports.combineDispositions(
          diagnosticDisposition,
          [completionDiagnosticDisposition],
        ),
      );
    }

    if (diagnosticDisposition.kind !== "recorded_only") {
      throw ports.createDispositionError(diagnosticDisposition);
    }
    return ports.createResult(
      context.group.group_id,
      context.operation.operation_id,
      "not_applied",
      "external_api_failed",
      taskGid,
    );
}
