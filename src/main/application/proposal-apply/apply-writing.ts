type Operation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
};
type Context<TOperation extends Operation> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
type Journal = { readonly proposal_id: string; readonly operation_id: string };
type ExistingJournalDisposition<TPlannedJournal extends Journal, TResult> =
  | {
      readonly kind: "return_result";
      readonly block_group: boolean;
      readonly result: TResult;
    }
  | {
      readonly kind: "resume_local_completion";
      readonly entry: TPlannedJournal;
      readonly result: TResult;
      readonly task_gid: string;
    }
  | {
      readonly kind: "persist_final_result";
      readonly entry: TPlannedJournal;
      readonly result: TResult;
      readonly task_gid: string;
    };
type PendingJournal<TOperation extends Operation, TPlannedJournal extends Journal, TResult> = {
  readonly entry: TPlannedJournal;
  readonly context: Context<TOperation>;
  readonly task_gid: string;
  readonly operationResults: Map<string, TResult>;
};
type WritePlan<TOperation extends Operation, TJournal extends Journal, TPlannedJournal extends TJournal, TResult> = {
  readonly contexts: readonly Context<TOperation>[];
  readonly selected: ReadonlySet<string>;
  readonly mappings: ReadonlyMap<string, string>;
  readonly existingJournals: ReadonlyMap<string, TJournal>;
  readonly existingJournalOperationIds: ReadonlySet<string>;
  readonly applicableContexts: readonly Context<TOperation>[];
  readonly operationResults: Map<string, TResult>;
  readonly operationGroupsBlocked: Set<string>;
  readonly failedTemporaryRefs: Set<string>;
  readonly preparedEntries: ReadonlyMap<string, TPlannedJournal>;
};
type JournalDiagnostic<TOperation extends Operation> = {
  readonly severity: "warning";
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly operation_kind: TOperation["operation"];
  readonly api_action: "journal_plan";
  readonly effect_certainty: "none";
  readonly task_gid: string | undefined;
  readonly reason_code: "external_api_failed";
  readonly recovery_decision: "not_applied";
  readonly attempt: 1;
  readonly phase: "application";
};
type CompletionDiagnostic = {
  readonly severity: "error";
  readonly api_action: "post_apply";
  readonly journal_stage: "ranking_recalculated";
  readonly effect_certainty: "confirmed";
  readonly reason_code: "recovery_required";
  readonly recovery_decision: "unresolved";
  readonly attempt: 1;
  readonly phase: "journal";
};
type WritePorts<TOperation extends Operation, TJournal extends Journal, TPlannedJournal extends TJournal, TResult> = {
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly operationTemporaryReferences: (operation: TOperation) => readonly string[];
  readonly targetGid: (
    operation: TOperation,
    mappings: ReadonlyMap<string, string>,
  ) => string | undefined;
  readonly createResult: (
    groupId: string,
    operationId: string,
    outcome: "not_applied",
    reasonCode: "external_api_failed" | "atomic_group_blocked" | "writer_conflict",
    taskGid: string | undefined,
  ) => TResult;
  readonly existingJournalDisposition: (
    context: Context<TOperation>,
    journal: TJournal,
    mappings: ReadonlyMap<string, string>,
  ) => ExistingJournalDisposition<TPlannedJournal, TResult>;
  readonly journal: {
    readonly complete: (
      proposalId: string,
      operationId: string,
      result: "applied",
    ) => void;
  };
  readonly reportJournalEvent: (
    error: unknown,
    fields: JournalDiagnostic<TOperation>,
  ) => Error;
  readonly reportCompletionFailure: (
    error: unknown,
    entry: { readonly journal: TPlannedJournal; readonly context: Context<TOperation> },
    fields: CompletionDiagnostic,
    taskGid: string,
  ) => Error;
  readonly writePrepared: (
    context: Context<TOperation>,
    entry: TPlannedJournal,
  ) => Promise<{
    readonly result: TResult;
    readonly pending: { readonly entry: TPlannedJournal; readonly task_gid: string } | undefined;
    readonly blockAtomicGroup: boolean;
  }>;
};

function addFailedCreateReference<TOperation extends Operation>(
  operation: TOperation,
  failedTemporaryRefs: Set<string>,
): void {
  if (operation.operation !== "create_task") {
    return;
  }
  if (operation.temporary_ref == null) {
    throw new Error("create_taskのtemporary_refがありません。");
  }
  failedTemporaryRefs.add(operation.temporary_ref);
}

function markAtomicGroupBlocked<
  TOperation extends Operation,
  TJournal extends Journal,
  TPlannedJournal extends TJournal,
  TResult,
>(
  plan: WritePlan<TOperation, TJournal, TPlannedJournal, TResult>,
  groupId: string,
  ports: WritePorts<TOperation, TJournal, TPlannedJournal, TResult>,
): void {
  plan.operationGroupsBlocked.add(groupId);
  for (const context of plan.contexts) {
    if (
      context.group.group_id !== groupId
      || !plan.selected.has(context.operation.operation_id)
      || plan.existingJournalOperationIds.has(context.operation.operation_id)
      || plan.operationResults.has(context.operation.operation_id)
    ) {
      continue;
    }
    addFailedCreateReference(context.operation, plan.failedTemporaryRefs);
    plan.operationResults.set(
      context.operation.operation_id,
      ports.createResult(
        groupId,
        context.operation.operation_id,
        "not_applied",
        "atomic_group_blocked",
        ports.targetGid(context.operation, plan.mappings),
      ),
    );
  }
}

/** 保存済み計画を順に適用し、適用後同期が必要なジャーナルを返します。 */
export async function applyPreparedApplication<
  TOperation extends Operation,
  TJournal extends Journal,
  TPlannedJournal extends TJournal,
  TResult extends { readonly outcome: string },
>(
  proposalId: string,
  plan: WritePlan<TOperation, TJournal, TPlannedJournal, TResult>,
  ports: WritePorts<TOperation, TJournal, TPlannedJournal, TResult>,
  signal: AbortSignal,
): Promise<PendingJournal<TOperation, TPlannedJournal, TResult>[]> {
  const pendingJournals: PendingJournal<TOperation, TPlannedJournal, TResult>[] = [];
  for (const context of plan.applicableContexts) {
    ports.throwIfAborted(signal);
    if (plan.operationResults.has(context.operation.operation_id)) {
      continue;
    }
    const hasFailedTemporaryReference = ports.operationTemporaryReferences(
      context.operation,
    ).some((temporaryRef) => plan.failedTemporaryRefs.has(temporaryRef));
    if (
      hasFailedTemporaryReference
      && !plan.existingJournals.has(context.operation.operation_id)
    ) {
      addFailedCreateReference(context.operation, plan.failedTemporaryRefs);
      ports.reportJournalEvent(
        new Error("一時参照元の操作が完了していないため、この操作を適用しませんでした。"),
        {
          severity: "warning",
          proposal_id: proposalId,
          operation_id: context.operation.operation_id,
          operation_kind: context.operation.operation,
          api_action: "journal_plan",
          effect_certainty: "none",
          task_gid: ports.targetGid(context.operation, plan.mappings),
          reason_code: "external_api_failed",
          recovery_decision: "not_applied",
          attempt: 1,
          phase: "application",
        },
      );
      plan.operationResults.set(
        context.operation.operation_id,
        ports.createResult(
          context.group.group_id,
          context.operation.operation_id,
          "not_applied",
          "external_api_failed",
          ports.targetGid(context.operation, plan.mappings),
        ),
      );
      if (context.group.atomic) {
        markAtomicGroupBlocked(plan, context.group.group_id, ports);
      }
      continue;
    }
    const existingJournal = plan.existingJournals.get(context.operation.operation_id);
    if (existingJournal != null) {
      const disposition = ports.existingJournalDisposition(
        context,
        existingJournal,
        plan.mappings,
      );
      plan.operationResults.set(context.operation.operation_id, disposition.result);
      if (disposition.kind === "resume_local_completion") {
        pendingJournals.push({
          entry: disposition.entry,
          context,
          task_gid: disposition.task_gid,
          operationResults: plan.operationResults,
        });
      } else if (disposition.kind === "persist_final_result") {
        try {
          ports.journal.complete(
            disposition.entry.proposal_id,
            disposition.entry.operation_id,
            "applied",
          );
        } catch (error: unknown) {
          throw ports.reportCompletionFailure(
            error,
            { journal: disposition.entry, context },
            {
              severity: "error",
              api_action: "post_apply",
              journal_stage: "ranking_recalculated",
              effect_certainty: "confirmed",
              reason_code: "recovery_required",
              recovery_decision: "unresolved",
              attempt: 1,
              phase: "journal",
            },
            disposition.task_gid,
          );
        }
      } else if (disposition.block_group && context.group.atomic) {
        markAtomicGroupBlocked(plan, context.group.group_id, ports);
      }
      if (
        disposition.kind === "return_result"
        && context.operation.operation === "create_task"
        && disposition.result.outcome !== "already_applied"
      ) {
        addFailedCreateReference(context.operation, plan.failedTemporaryRefs);
      }
      continue;
    }

    const entry = plan.preparedEntries.get(context.operation.operation_id);
    if (entry == null) {
      throw new Error("prepared済み適用ジャーナルが見つかりません。");
    }
    const writeResult = await ports.writePrepared(context, entry);
    plan.operationResults.set(context.operation.operation_id, writeResult.result);
    if (writeResult.blockAtomicGroup && context.group.atomic) {
      markAtomicGroupBlocked(plan, context.group.group_id, ports);
    }
    if (writeResult.pending != null) {
      pendingJournals.push({
        entry: writeResult.pending.entry,
        context,
        task_gid: writeResult.pending.task_gid,
        operationResults: plan.operationResults,
      });
    }
  }

  for (const context of plan.contexts) {
    if (
      plan.selected.has(context.operation.operation_id)
      && !plan.operationResults.has(context.operation.operation_id)
    ) {
      const taskGid = ports.targetGid(context.operation, plan.mappings);
      addFailedCreateReference(context.operation, plan.failedTemporaryRefs);
      plan.operationResults.set(
        context.operation.operation_id,
        ports.createResult(
          context.group.group_id,
          context.operation.operation_id,
          "not_applied",
          plan.operationGroupsBlocked.has(context.group.group_id)
            ? "atomic_group_blocked"
            : "writer_conflict",
          taskGid,
        ),
      );
    }
  }
  return pendingJournals;
}
