import { advanceJournal, type JournalStage } from "./journal-progress";
import { sortedUniqueTaskGids } from "./operation-order";
import { type RecoveryApplicationState } from "./recovery-state";
import { type RecoveryPendingJournal } from "./recovery-operations";

type RecoveryEntry = {
  readonly journal: { readonly proposal_id: string; readonly operation_id: string; readonly stage: JournalStage };
  readonly context: { readonly operation: { readonly operation_id: string; readonly operation: string } };
};
type RecoverySynchronization =
  | { readonly kind: "synchronized"; readonly cause?: unknown }
  | { readonly kind: "recovery_required"; readonly cause?: unknown };
type SharedDiagnosticFields = {
  readonly severity: "error";
  readonly api_action: "post_apply";
  readonly effect_certainty: "confirmed";
  readonly reason_code: "local_resync_required";
  readonly recovery_decision: "local_sync_pending";
  readonly attempt: 1;
  readonly phase: "post_apply";
};
type OperationDiagnosticFields = {
  readonly severity: "warning" | "error";
  readonly api_action: "post_apply";
  readonly journal_stage: JournalStage;
  readonly effect_certainty: "confirmed";
  readonly reason_code: "local_resync_required" | "recovery_required";
  readonly recovery_decision: "local_sync_pending" | "unresolved";
  readonly attempt: 1;
  readonly phase: "post_apply" | "journal";
};
type RecoveryCompletionPorts<TEntry extends RecoveryEntry, TResult, TSynchronization extends RecoverySynchronization, TReceipt extends Error> = {
  readonly journal: {
    readonly updateStage: (proposalId: string, operationId: string, stage: JournalStage) => void;
    readonly complete: (proposalId: string, operationId: string, result: "applied" | "not_applied" | "unknown" | "failed") => void;
  };
  readonly postApply: (requiredTaskGids: readonly string[], signal: AbortSignal) => Promise<TSynchronization>;
  readonly parseSynchronization: (value: TSynchronization) => TSynchronization;
  readonly reportSharedCause: (error: unknown, fields: SharedDiagnosticFields) => TReceipt;
  readonly reportOperationEvent: (error: unknown, entry: TEntry, fields: OperationDiagnosticFields, taskGid: string) => TReceipt;
  readonly reportOperationEventOnce: (error: unknown, entry: TEntry, fields: OperationDiagnosticFields, taskGid: string) => TReceipt;
  readonly unknownResult: (context: TEntry["context"], reasonCode: "local_resync_required", taskGid: string) => TResult;
  readonly finalJournalResult: (value: "applied") => "applied" | "not_applied" | "unknown" | "failed";
};

/** 確定済み外部操作のローカル同期と順位再計算を完了します。 */
export async function completeRecoveredOperations<TApplication, TResult, TEntry extends RecoveryEntry, TSynchronization extends RecoverySynchronization, TReceipt extends Error>(
  pendingJournals: readonly { readonly state: RecoveryApplicationState<TApplication, TResult, TEntry>; readonly pending: RecoveryPendingJournal<TEntry> }[],
  ports: RecoveryCompletionPorts<TEntry, TResult, TSynchronization, TReceipt>,
  signal: AbortSignal,
): Promise<void> {
  if (pendingJournals.length > 0) {
      const requiredTaskGids = sortedUniqueTaskGids(
        pendingJournals.map(({ pending }) => pending.task_gid),
      );
      let synchronization: TSynchronization;
      try {
        synchronization = ports.parseSynchronization(
          await ports.postApply(requiredTaskGids, signal),
        );
      } catch (error: unknown) {
        const receipt = ports.reportSharedCause(
          error,
          {
            severity: "error",
            api_action: "post_apply",
            effect_certainty: "confirmed",
            reason_code: "local_resync_required",
            recovery_decision: "local_sync_pending",
            attempt: 1,
            phase: "post_apply",
          },
        );
        for (const { pending } of pendingJournals) {
          ports.reportOperationEvent(
            new Error("外部状態は確定しましたが、ローカル同期を完了できませんでした。"),
            pending.entry,
            {
              severity: "error",
              api_action: "post_apply",
              journal_stage: pending.entry.journal.stage,
              effect_certainty: "confirmed",
              reason_code: "local_resync_required",
              recovery_decision: "local_sync_pending",
              attempt: 1,
              phase: "post_apply",
            },
            pending.task_gid,
          );
        }
        throw receipt;
      }
      if (synchronization.kind === "recovery_required") {
        if (synchronization.cause != null) {
          ports.reportSharedCause(
            synchronization.cause,
            {
              severity: "error",
              api_action: "post_apply",
              effect_certainty: "confirmed",
              reason_code: "local_resync_required",
              recovery_decision: "local_sync_pending",
              attempt: 1,
              phase: "post_apply",
            },
            );
        }
        for (const { state, pending } of pendingJournals) {
          ports.reportOperationEvent(
            new Error("外部状態は確定しましたが、ローカル同期の再開が必要です。"),
            pending.entry,
            {
              severity: "warning",
              api_action: "post_apply",
              journal_stage: pending.entry.journal.stage,
              effect_certainty: "confirmed",
              reason_code: "local_resync_required",
              recovery_decision: "local_sync_pending",
              attempt: 1,
              phase: "post_apply",
            },
            pending.task_gid,
          );
          state.selected.add(pending.entry.context.operation.operation_id);
          state.operationResults.set(
            pending.entry.context.operation.operation_id,
            ports.unknownResult(
              pending.entry.context,
              "local_resync_required",
              pending.task_gid,
            ),
          );
        }
      } else {
        for (const { pending } of pendingJournals) {
          let journalStage: JournalStage = pending.entry.journal.stage;
          try {
            advanceJournal(
              ports.journal,
              pending.entry.journal,
              "ranking_recalculated",
              (stage) => {
                journalStage = stage;
              },
            );
            ports.journal.complete(
              pending.entry.journal.proposal_id,
              pending.entry.journal.operation_id,
              ports.finalJournalResult("applied"),
            );
          } catch (error: unknown) {
            const receipt = ports.reportOperationEventOnce(
              error,
              pending.entry,
              {
                severity: "error",
                api_action: "post_apply",
                journal_stage: journalStage,
                effect_certainty: "confirmed",
                reason_code: "recovery_required",
                recovery_decision: "unresolved",
                attempt: 1,
                phase: "journal",
              },
              pending.task_gid,
            );
            throw receipt;
          }
        }
      }
    }
}
