type OperationContext = {
  readonly group: { readonly group_id: string };
  readonly operation: { readonly operation_id: string };
};
type WriterResult =
  | { readonly outcome: "applied" | "already_applied"; readonly task_gid: string }
  | { readonly outcome: "conflict"; readonly side_effect: "none" | "possible"; readonly task_gid: string };
type ApplicationReasonCode =
  | "applied" | "already_applied" | "approval_conflict" | "atomic_group_blocked"
  | "writer_conflict" | "external_id_collision" | "recovery_required"
  | "recovery_context_missing" | "task_not_found" | "duplicate_external_id"
  | "journal_target_mismatch" | "external_api_failed" | "local_resync_required";
type RecoveryReasonCode = "recovery_context_missing" | "task_not_found" | "duplicate_external_id" | "journal_target_mismatch" | "recovery_required";

/** 操作の適用結果を対象GIDの有無に合わせて組み立てます。 */
export function createOperationResult<TOutcome extends "applied" | "already_applied" | "not_applied" | "unknown", TReason extends ApplicationReasonCode>(
  groupId: string,
  operationId: string,
  outcome: TOutcome,
  reasonCode: TReason,
  taskGid: string | undefined,
): { readonly group_id: string; readonly operation_id: string; readonly task_gid?: string; readonly outcome: TOutcome; readonly reason_code: TReason } {
  if (taskGid == null) {
    return {
      group_id: groupId,
      operation_id: operationId,
      outcome,
      reason_code: reasonCode,
    };
  }
  return {
    group_id: groupId,
    operation_id: operationId,
    task_gid: taskGid,
    outcome,
    reason_code: reasonCode,
  };
}

/** writerの結果を適用操作の結果へ変換します。 */
export function writerResultToApplicationResult(
  context: OperationContext,
  result: WriterResult,
) {
  switch (result.outcome) {
    case "applied":
      return createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "applied",
        "applied",
        result.task_gid,
      );
    case "already_applied":
      return createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        result.task_gid,
      );
    case "conflict":
      if (result.side_effect === "possible") {
        return unknownOperationResult(context, "recovery_required", result.task_gid);
      }
      return createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "not_applied",
        "writer_conflict",
        result.task_gid,
      );
  }
}

/** 確定できない操作結果を組み立てます。 */
export function unknownOperationResult(
  context: OperationContext,
  reasonCode: ApplicationReasonCode,
  taskGid: string | undefined,
) {
  return createOperationResult(
    context.group.group_id,
    context.operation.operation_id,
    "unknown",
    reasonCode,
    taskGid,
  );
}

/** 未完了ジャーナルを要整理項目へ変換します。 */
export function incompleteJournalResult(
  journal: { readonly proposal_id: string; readonly operation_id: string },
  reasonCode: RecoveryReasonCode,
  taskGid: string | undefined,
) {
  if (taskGid == null) {
    return {
      proposal_id: journal.proposal_id,
      operation_id: journal.operation_id,
      outcome: "unknown" as const,
      reason_code: reasonCode,
    };
  }
  return {
    proposal_id: journal.proposal_id,
    operation_id: journal.operation_id,
    task_gid: taskGid,
    outcome: "unknown" as const,
    reason_code: reasonCode,
  };
}
