import { effectCertaintyForJournalStage, type JournalStage } from "./journal-progress";

type RecoveryReasonCode = "recovery_context_missing" | "task_not_found" | "duplicate_external_id" | "journal_target_mismatch" | "recovery_required";
type JournalPlan<TOperationKind extends string> = {
  readonly operation: { readonly operation: TOperationKind; readonly temporary_ref?: string };
  readonly temporary_ref_to_gid: readonly { readonly temporary_ref: string; readonly task_gid: string }[];
};
type Journal<TOperationKind extends string> = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly stage: JournalStage;
  readonly target:
    | { readonly kind: "task"; readonly gid: string }
    | { readonly kind: "new_task"; readonly uuid: string }
    | { readonly kind: "temporary"; readonly ref: string };
  readonly final_result?: "applied" | "not_applied" | "unknown" | "failed" | undefined;
  readonly recovery_reason?: string | undefined;
  readonly recovery_cause?: unknown;
  readonly plan?: JournalPlan<TOperationKind> | undefined;
};
type DiagnosticFields<TOperationKind extends string> = {
  readonly severity: "warning" | "error";
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly operation_kind?: TOperationKind;
  readonly api_action: "journal_plan";
  readonly journal_stage: JournalStage;
  readonly effect_certainty: "none" | "possible" | "confirmed";
  readonly task_gid?: string;
  readonly reason_code: string;
  readonly recovery_decision: "inspect" | "unresolved";
  readonly attempt: 1;
  readonly phase: "recovery";
};
type RecoveryJournalPorts<TOperationKind extends string, TJournal extends Journal<TOperationKind>, TPlannedJournal extends TJournal & { readonly plan: JournalPlan<TOperationKind> }, TUnresolved> = {
  readonly hasPlan: (journal: TJournal) => journal is TPlannedJournal;
  readonly journal: {
    readonly complete: (proposalId: string, operationId: string, result: "applied" | "not_applied" | "unknown" | "failed") => void;
    readonly clearRecoveryCause: (proposalId: string, operationId: string) => void;
  };
  readonly finalJournalResult: (value: "unknown") => "applied" | "not_applied" | "unknown" | "failed";
  readonly createUnresolved: (journal: TJournal, reasonCode: RecoveryReasonCode, taskGid: string | undefined) => TUnresolved;
  readonly reportJournalEvent: (error: unknown, fields: DiagnosticFields<TOperationKind>) => Error;
  readonly throwIfAborted: (signal: AbortSignal) => void;
};

/** 未完了ジャーナルの復旧開始を記録し、旧形式とunknownを未確定へ分類します。 */
export function startRecoveryJournals<TOperationKind extends string, TJournal extends Journal<TOperationKind>, TPlannedJournal extends TJournal & { readonly plan: JournalPlan<TOperationKind> }, TUnresolved>(
  incomplete: readonly TJournal[],
  ports: RecoveryJournalPorts<TOperationKind, TJournal, TPlannedJournal, TUnresolved>,
  signal: AbortSignal,
): {
  readonly plannedJournalsByProposal: Map<string, TPlannedJournal[]>;
  readonly unresolved: TUnresolved[];
  readonly addUnresolved: (journal: TJournal, reasonCode: RecoveryReasonCode, taskGid: string | undefined) => void;
} {

    for (const journal of incomplete) {
      ports.reportJournalEvent(
        new Error("未完了のAI適用ジャーナルの復旧を開始しました。"),
        {
          severity: "warning",
          proposal_id: journal.proposal_id,
          operation_id: journal.operation_id,
          ...(ports.hasPlan(journal)
            ? { operation_kind: journal.plan.operation.operation }
            : {}),
          api_action: "journal_plan",
          journal_stage: journal.stage,
          effect_certainty: effectCertaintyForJournalStage(journal.stage),
          ...(journal.target.kind === "task" ? { task_gid: journal.target.gid } : {}),
          reason_code: "recovery_started",
          recovery_decision: "inspect",
          attempt: 1,
          phase: "recovery",
        },
      );
    }
    const plannedJournalsByProposal = new Map<string, TPlannedJournal[]>();
    const unresolved: TUnresolved[] = [];
    const unresolvedKeys = new Set<string>();
    const addUnresolved = (
      journal: TJournal,
      reasonCode: RecoveryReasonCode,
      taskGid: string | undefined,
    ): void => {
      const key = `${journal.proposal_id}\u0000${journal.operation_id}`;
      if (unresolvedKeys.has(key)) {
        return;
      }
      unresolvedKeys.add(key);
      unresolved.push(ports.createUnresolved(journal, reasonCode, taskGid));
    };
    for (const journal of incomplete) {
      if (!ports.hasPlan(journal)) {
        continue;
      }
      if (journal.final_result === "unknown") {
        const operation = journal.plan.operation;
        const createdTaskGid = operation.operation === "create_task"
          ? journal.plan.temporary_ref_to_gid.find(
            (mapping) => mapping.temporary_ref === operation.temporary_ref,
          )?.task_gid
          : undefined;
        const taskGid = journal.target.kind === "task"
          ? journal.target.gid
          : createdTaskGid;
        const effectCertainty = effectCertaintyForJournalStage(journal.stage);
        addUnresolved(journal, "recovery_required", taskGid);
        ports.reportJournalEvent(
          new Error("既にunknownの適用ジャーナルは外部操作を再開せず未確定として扱います。"),
          {
            severity: "error",
            proposal_id: journal.proposal_id,
            operation_id: journal.operation_id,
            operation_kind: journal.plan.operation.operation,
            api_action: "journal_plan",
            journal_stage: journal.stage,
            effect_certainty: effectCertainty,
            ...(taskGid == null ? {} : { task_gid: taskGid }),
            reason_code: "recovery_required",
            recovery_decision: "unresolved",
            attempt: 1,
            phase: "recovery",
          },
        );
      }
      const journals = plannedJournalsByProposal.get(journal.proposal_id) ?? [];
      journals.push(journal);
      plannedJournalsByProposal.set(journal.proposal_id, journals);
    }

    for (const journal of incomplete) {
      ports.throwIfAborted(signal);
      if (ports.hasPlan(journal)) {
        continue;
      }
      if (journal.final_result == null) {
        ports.journal.complete(
          journal.proposal_id,
          journal.operation_id,
          ports.finalJournalResult("unknown"),
        );
      }
      const reasonCode = journal.stage === "legacy_unresolved"
        && journal.recovery_reason === "journal_target_mismatch"
        ? "journal_target_mismatch"
        : "recovery_context_missing";
      addUnresolved(journal, reasonCode, undefined);
      ports.reportJournalEvent(
        journal.stage === "legacy_unresolved"
          && journal.recovery_cause != null
          ? journal.recovery_cause
          : new Error("旧形式のAI適用ジャーナルには安全な復旧計画がありません。"),
        {
          severity: "error",
          proposal_id: journal.proposal_id,
          operation_id: journal.operation_id,
          api_action: "journal_plan",
          journal_stage: journal.stage,
          effect_certainty: "possible",
          ...(journal.target.kind === "task" ? { task_gid: journal.target.gid } : {}),
          reason_code: reasonCode,
          recovery_decision: "unresolved",
          attempt: 1,
          phase: "recovery",
        },
      );
      ports.journal.clearRecoveryCause(journal.proposal_id, journal.operation_id);
    }

    return { plannedJournalsByProposal, unresolved, addUnresolved };
}
