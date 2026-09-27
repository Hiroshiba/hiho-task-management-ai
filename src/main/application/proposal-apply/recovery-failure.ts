import { effectCertaintyForJournalStage, type JournalStage } from "./journal-progress";

type RecoveryJournal<TOperationKind extends string> = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly stage: JournalStage;
  readonly target:
    | { readonly kind: "task"; readonly gid: string }
    | { readonly kind: "new_task"; readonly uuid: string }
    | { readonly kind: "temporary"; readonly ref: string };
  readonly plan?: { readonly operation: { readonly operation: TOperationKind } } | undefined;
};
type RecoveryFailureFields<TOperationKind extends string> = {
  readonly severity: "error";
  readonly proposal_id?: string;
  readonly operation_id?: string;
  readonly operation_kind?: TOperationKind;
  readonly api_action: "journal_plan";
  readonly journal_stage?: JournalStage;
  readonly effect_certainty: "possible" | "none" | "confirmed";
  readonly task_gid?: string;
  readonly reason_code: "recovery_failed";
  readonly recovery_decision: "failed";
  readonly attempt: 1;
  readonly phase: "recovery";
};
type RecoveryFailurePorts<TOperationKind extends string, TJournal extends RecoveryJournal<TOperationKind>, TPlannedJournal extends TJournal & { readonly plan: { readonly operation: { readonly operation: TOperationKind } } }, TReceipt extends Error, TDisposition> = {
  readonly isReceipt: (error: unknown) => error is TReceipt;
  readonly getIncomplete: () => readonly TJournal[];
  readonly hasPlan: (journal: TJournal) => journal is TPlannedJournal;
  readonly reportEscaped: (error: unknown, fields: RecoveryFailureFields<TOperationKind>) => TReceipt;
  readonly reportJournal: (error: unknown, fields: RecoveryFailureFields<TOperationKind>) => TReceipt;
  readonly fromError: (error: unknown) => TDisposition;
  readonly combine: (primary: TDisposition, additional: readonly TDisposition[]) => TDisposition;
  readonly createReceipt: (disposition: TDisposition) => TReceipt;
};

/** 復旧失敗を既存ジャーナルの診断へ結び付けて送出します。 */
export function throwRecoveryFailure<TOperationKind extends string, TJournal extends RecoveryJournal<TOperationKind>, TPlannedJournal extends TJournal & { readonly plan: { readonly operation: { readonly operation: TOperationKind } } }, TReceipt extends Error, TDisposition>(
  error: unknown,
  signal: AbortSignal,
  ports: RecoveryFailurePorts<TOperationKind, TJournal, TPlannedJournal, TReceipt, TDisposition>,
): never {

      if (signal.aborted) {
        throw error;
      }
      if (ports.isReceipt(error)) {
        throw error;
      }
      let incomplete: readonly TJournal[];
      try {
        incomplete = ports.getIncomplete();
      } catch (diagnosticError: unknown) {
        throw ports.createReceipt(
          ports.combine(
            ports.fromError(error),
            [ports.fromError(diagnosticError)],
          ),
        );
      }
      if (incomplete.length === 0) {
        throw ports.reportEscaped(error, {
          severity: "error",
          api_action: "journal_plan",
          effect_certainty: "possible",
          reason_code: "recovery_failed",
          recovery_decision: "failed",
          attempt: 1,
          phase: "recovery",
        });
      }
      let receipt: TReceipt | undefined;
      for (const journal of incomplete) {
        receipt = ports.reportJournal(error, {
          severity: "error",
          proposal_id: journal.proposal_id,
          operation_id: journal.operation_id,
          ...(ports.hasPlan(journal)
            ? { operation_kind: journal.plan.operation.operation }
            : {}),
          api_action: "journal_plan",
          journal_stage: journal.stage,
          effect_certainty: effectCertaintyForJournalStage(journal.stage),
          ...(journal.target.kind === "task" ? { task_gid: journal.target.gid } : {}),
          reason_code: "recovery_failed",
          recovery_decision: "failed",
          attempt: 1,
          phase: "recovery",
        });
      }
      if (receipt == null) {
        throw new Error("復旧失敗の診断receiptがありません。");
      }
      throw receipt;
}
