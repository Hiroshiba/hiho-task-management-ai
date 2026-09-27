type StoredForApproval<TProposal, TBaseline, TExternal, TGraph, TSplit, TTrusted> = {
  readonly proposal_id: string;
  readonly proposal: TProposal;
  readonly baseline: TBaseline;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: TExternal;
  readonly snapshot: { readonly areas: readonly string[] };
  readonly graph_validation: TGraph;
  readonly explicit_split_request_references: readonly TSplit[];
  readonly trusted_status_evidence: readonly TTrusted[];
};

/** 保持中の変更案から承認前の再取得入力を作ります。 */
export function createApprovalPreparationInput<TProposal, TBaseline, TExternal, TGraph, TSplit, TTrusted>(
  stored: StoredForApproval<TProposal, TBaseline, TExternal, TGraph, TSplit, TTrusted>,
  selectedOperationIds: readonly string[],
): {
  readonly proposal_id: string;
  readonly proposal: TProposal;
  readonly baseline_snapshot: TBaseline;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: TExternal;
  readonly existing_areas: readonly string[];
  readonly graph_validation_result: TGraph;
  readonly selected_operation_ids: readonly string[];
  readonly explicit_split_request_references: TSplit[];
  readonly trusted_status_evidence: TTrusted[];
  readonly created_via: "codex";
} {
  return {
    proposal_id: stored.proposal_id,
    proposal: stored.proposal,
    baseline_snapshot: stored.baseline,
    baseline_snapshot_hash: stored.baseline_snapshot_hash,
    baseline_external_data: stored.baseline_external_data,
    existing_areas: stored.snapshot.areas,
    graph_validation_result: stored.graph_validation,
    selected_operation_ids: selectedOperationIds,
    explicit_split_request_references: [...stored.explicit_split_request_references],
    trusted_status_evidence: [...stored.trusted_status_evidence],
    created_via: "codex",
  };
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameSortedIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort(compareStrings);
  const rightSorted = [...right].sort(compareStrings);
  return leftSorted.length === rightSorted.length
    && leftSorted.every((value, index) => value === rightSorted[index]);
}

/** 再取得された承認入力が保持中の提案と基準値に一致するか確認します。 */
export function assertApprovalInputMatchesStored<TProposal, TTask, TBaseline extends {
  readonly tasks: readonly TTask[];
}, TInput extends {
  readonly approval_input: {
    readonly proposal: unknown;
    readonly baseline_tasks: readonly unknown[];
    readonly selected_operation_ids: readonly string[];
  };
}>(
  input: TInput,
  stored: { readonly proposal: TProposal; readonly baseline: TBaseline },
  selectedOperationIds: readonly string[],
  dependencies: {
    readonly canonicalizeJson: (value: unknown) => string;
    readonly createBaselineTaskSnapshots: (tasks: TInput["approval_input"]["baseline_tasks"]) => readonly TTask[];
    readonly WorkflowError: new (message: string) => Error;
  },
): void {
  if (dependencies.canonicalizeJson(input.approval_input.proposal)
    !== dependencies.canonicalizeJson(stored.proposal)) {
    throw new dependencies.WorkflowError("承認入力の変更案が保持中の変更案と一致しません。");
  }
  if (
    dependencies.canonicalizeJson(
      dependencies.createBaselineTaskSnapshots(input.approval_input.baseline_tasks),
    ) !== dependencies.canonicalizeJson(stored.baseline.tasks)
  ) {
    throw new dependencies.WorkflowError("承認入力の基準タスクが保持中の基準値と一致しません。");
  }
  if (!sameSortedIds(input.approval_input.selected_operation_ids, selectedOperationIds)) {
    throw new dependencies.WorkflowError("承認入力の選択操作が一致しません。");
  }
}
