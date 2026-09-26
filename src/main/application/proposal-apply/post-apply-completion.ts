import { advanceJournal, type JournalProgressPort, type JournalStage } from "./journal-progress";
import { sortedUniqueTaskGids } from "./operation-order";

type OperationContext = {
  readonly group: { readonly group_id: string };
  readonly operation: { readonly operation_id: string; readonly operation: string };
};

type PendingJournal<TContext extends OperationContext, TResult> = {
  readonly entry: {
    readonly proposal_id: string;
    readonly operation_id: string;
    readonly stage: JournalStage;
  };
  readonly context: TContext;
  readonly task_gid: string;
  readonly operationResults: Map<string, TResult>;
};

type PostApplyResult =
  | { readonly kind: "synchronized"; readonly cause?: unknown }
  | { readonly kind: "recovery_required"; readonly cause?: unknown };

type DiagnosticFields<TKind extends string> = {
  readonly severity: "warning" | "error";
  readonly proposal_id?: string;
  readonly operation_id?: string;
  readonly operation_kind?: TKind;
  readonly api_action: "post_apply";
  readonly journal_stage?: JournalStage;
  readonly effect_certainty: "confirmed";
  readonly task_gid?: string;
  readonly reason_code: "local_resync_required" | "recovery_required";
  readonly recovery_decision: "local_sync_pending" | "unresolved";
  readonly attempt: number;
  readonly phase: "post_apply" | "journal";
};

type CompletionDependencies<
  TContext extends OperationContext,
  TResult,
  TSynchronization extends PostApplyResult,
> = {
  readonly journal: JournalProgressPort;
  readonly postApply: (
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ) => Promise<TSynchronization>;
  readonly parseSynchronization: (value: TSynchronization) => TSynchronization;
  readonly reportDiagnostic: (
    error: unknown,
    fields: DiagnosticFields<TContext["operation"]["operation"]>,
  ) => Error;
  readonly reportSharedCause: (
    error: unknown,
    fields: DiagnosticFields<TContext["operation"]["operation"]>,
  ) => Error;
  readonly createLocalSyncPendingResult: (context: TContext, taskGid: string) => TResult;
};

/** 書き込み済みジャーナルの同期と最終保存を完了します。 */
export async function finalizePendingJournals<
  TContext extends OperationContext,
  TResult,
  TSynchronization extends PostApplyResult,
>(
  pending: readonly PendingJournal<TContext, TResult>[],
  dependencies: CompletionDependencies<TContext, TResult, TSynchronization>,
  signal: AbortSignal,
): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  const requiredTaskGids = sortedUniqueTaskGids(
    pending.map((item) => item.task_gid),
  );
  let synchronization: TSynchronization;
  try {
    synchronization = dependencies.parseSynchronization(
      await dependencies.postApply(requiredTaskGids, signal),
    );
  } catch (error: unknown) {
    const receipt = dependencies.reportSharedCause(error, {
      severity: "error",
      api_action: "post_apply",
      effect_certainty: "confirmed",
      reason_code: "local_resync_required",
      recovery_decision: "local_sync_pending",
      attempt: 1,
      phase: "post_apply",
    });
    for (const item of pending) {
      dependencies.reportDiagnostic(new Error("外部状態は確定しましたが、ローカル同期を完了できませんでした。"), {
        severity: "error",
        proposal_id: item.entry.proposal_id,
        operation_id: item.entry.operation_id,
        operation_kind: item.context.operation.operation,
        api_action: "post_apply",
        journal_stage: item.entry.stage,
        effect_certainty: "confirmed",
        task_gid: item.task_gid,
        reason_code: "local_resync_required",
        recovery_decision: "local_sync_pending",
        attempt: 1,
        phase: "post_apply",
      });
    }
    throw receipt;
  }
  if (synchronization.kind === "recovery_required") {
    if (synchronization.cause != null) {
      dependencies.reportSharedCause(synchronization.cause, {
        severity: "error",
        api_action: "post_apply",
        effect_certainty: "confirmed",
        reason_code: "local_resync_required",
        recovery_decision: "local_sync_pending",
        attempt: 1,
        phase: "post_apply",
      });
    }
    for (const item of pending) {
      dependencies.reportDiagnostic(
        new Error("外部状態は確定しましたが、ローカル同期を完了できませんでした。"),
        {
          severity: "warning",
          proposal_id: item.entry.proposal_id,
          operation_id: item.entry.operation_id,
          operation_kind: item.context.operation.operation,
          api_action: "post_apply",
          journal_stage: item.entry.stage,
          effect_certainty: "confirmed",
          task_gid: item.task_gid,
          reason_code: "local_resync_required",
          recovery_decision: "local_sync_pending",
          attempt: 1,
          phase: "post_apply",
        },
      );
      item.operationResults.set(
        item.context.operation.operation_id,
        dependencies.createLocalSyncPendingResult(item.context, item.task_gid),
      );
    }
    return;
  }
  for (const item of pending) {
    let journalStage: JournalStage = item.entry.stage;
    try {
      advanceJournal(
        dependencies.journal,
        item.entry,
        "ranking_recalculated",
        (stage) => {
          journalStage = stage;
        },
      );
      dependencies.journal.complete(item.entry.proposal_id, item.entry.operation_id, "applied");
    } catch (error: unknown) {
      const receipt = dependencies.reportDiagnostic(error, {
        severity: "error",
        proposal_id: item.entry.proposal_id,
        operation_id: item.entry.operation_id,
        operation_kind: item.context.operation.operation,
        api_action: "post_apply",
        journal_stage: journalStage,
        effect_certainty: "confirmed",
        task_gid: item.task_gid,
        reason_code: "recovery_required",
        recovery_decision: "unresolved",
        attempt: 1,
        phase: "journal",
      });
      throw receipt;
    }
  }
}
