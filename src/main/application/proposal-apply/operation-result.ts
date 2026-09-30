type ApplicationReasonCode =
  | "applied" | "already_applied" | "approval_conflict" | "atomic_group_blocked"
  | "writer_conflict" | "external_id_collision" | "recovery_required"
  | "recovery_context_missing" | "task_not_found" | "duplicate_external_id"
  | "journal_target_mismatch" | "external_api_failed" | "local_resync_required";

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
