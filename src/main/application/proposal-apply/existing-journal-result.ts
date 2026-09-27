import { type JournalStage } from "./journal-progress";

type Operation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
  readonly target?:
    | { readonly kind: "existing"; readonly gid: string }
    | { readonly kind: "temporary"; readonly ref: string };
};
type OperationContext<TOperation extends Operation> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
type ExistingJournal = {
  readonly target:
    | { readonly kind: "task"; readonly gid: string }
    | { readonly kind: "new_task"; readonly uuid: string }
    | { readonly kind: "temporary"; readonly ref: string };
  readonly final_result?: "applied" | "not_applied" | "unknown" | "failed" | undefined;
  readonly stage: JournalStage;
};
type ExistingJournalDisposition<TResult, TPlannedJournal> =
  | { readonly kind: "return_result"; readonly block_group: boolean; readonly result: TResult }
  | { readonly kind: "resume_local_completion"; readonly entry: TPlannedJournal; readonly result: TResult; readonly task_gid: string }
  | { readonly kind: "persist_final_result"; readonly entry: TPlannedJournal; readonly result: TResult; readonly task_gid: string };
type ExistingJournalPorts<TOperation extends Operation, TResult, TJournal extends ExistingJournal, TPlannedJournal extends TJournal> = {
  readonly hasPlan: (journal: TJournal) => journal is TPlannedJournal;
  readonly createTemporaryRef: (operation: TOperation) => string;
  readonly createResult: (groupId: string, operationId: string, outcome: "already_applied" | "not_applied", reasonCode: "already_applied" | "external_api_failed", taskGid: string | undefined) => TResult;
  readonly unknownResult: (context: OperationContext<TOperation>, reasonCode: "recovery_required", taskGid: string | undefined) => TResult;
};

/** 既存ジャーナルの最終結果かローカル完了の再開先を決めます。 */
export function resolveExistingJournal<TOperation extends Operation, TResult, TJournal extends ExistingJournal, TPlannedJournal extends TJournal>(
  context: OperationContext<TOperation>,
  journal: TJournal,
  mappings: ReadonlyMap<string, string>,
  ports: ExistingJournalPorts<TOperation, TResult, TJournal, TPlannedJournal>,
): ExistingJournalDisposition<TResult, TPlannedJournal> {
  let taskGid: string | undefined;
  if (journal.target.kind === "task") {
    taskGid = journal.target.gid;
  } else if (
    journal.target.kind === "new_task"
    && context.operation.operation === "create_task"
  ) {
    taskGid = mappings.get(ports.createTemporaryRef(context.operation));
  } else if (journal.target.kind === "temporary") {
    let operationTemporaryRef: string | undefined;
    if (context.operation.operation === "create_task") {
      operationTemporaryRef = ports.createTemporaryRef(context.operation);
    } else if (context.operation.target?.kind === "temporary") {
      operationTemporaryRef = context.operation.target.ref;
    }
    if (operationTemporaryRef === journal.target.ref) {
      taskGid = mappings.get(journal.target.ref);
    }
  }
  if (journal.final_result === "applied") {
    const result = taskGid == null
      ? ports.unknownResult(context, "recovery_required", undefined)
      : ports.createResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        taskGid,
      );
    return { kind: "return_result", block_group: taskGid == null, result };
  }
  if (journal.final_result != null) {
    const result = journal.final_result === "not_applied"
      ? ports.createResult(
        context.group.group_id,
        context.operation.operation_id,
        "not_applied",
        "external_api_failed",
        taskGid,
      )
      : ports.unknownResult(context, "recovery_required", taskGid);
    return { kind: "return_result", block_group: true, result };
  }
  if (journal.stage === "prepared") {
    return {
      kind: "return_result",
      block_group: true,
      result: ports.createResult(
        context.group.group_id,
        context.operation.operation_id,
        "not_applied",
        "external_api_failed",
        taskGid,
      ),
    };
  }
  if (
    (journal.stage === "read_back" || journal.stage === "metadata_verified")
    && ports.hasPlan(journal)
    && taskGid != null
  ) {
    return {
      kind: "resume_local_completion",
      entry: journal,
      result: ports.createResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        taskGid,
      ),
      task_gid: taskGid,
    };
  }
  if (
    journal.stage === "ranking_recalculated"
    && ports.hasPlan(journal)
    && taskGid != null
  ) {
    return {
      kind: "persist_final_result",
      entry: journal,
      result: ports.createResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        taskGid,
      ),
      task_gid: taskGid,
    };
  }
  return {
    kind: "return_result",
    block_group: true,
    result: ports.unknownResult(context, "recovery_required", taskGid),
  };
}
