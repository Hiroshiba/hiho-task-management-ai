type Classification<TReason extends string> =
  | { readonly kind: "applicable" | "already_applied"; readonly affected_task_gids: readonly string[] }
  | { readonly kind: "conflict"; readonly reason_codes: readonly TReason[]; readonly affected_task_gids: readonly string[] };

type OperationResult<TReason extends string> =
  | { readonly group_id: string; readonly operation_id: string; readonly kind: "applicable" | "already_applied"; readonly affected_task_gids: readonly string[] }
  | { readonly group_id: string; readonly operation_id: string; readonly kind: "conflict"; readonly reason_codes: readonly TReason[]; readonly affected_task_gids: readonly string[] };

type GroupResult = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly applicable: boolean;
  readonly operation_ids: readonly string[];
};

/** 選択された操作の文脈を抽出します。 */
export function createSelectedOperationContexts<TContext extends { readonly operation: { readonly operation_id: string } }>(
  contexts: readonly TContext[],
  selectedOperationIds: ReadonlySet<string>,
): readonly TContext[] {
  return contexts.filter((context) =>
    selectedOperationIds.has(context.operation.operation_id));
}

/** 操作ごとの承認競合結果を組み立てます。 */
export function createOperationResults<TReason extends string>(
  contexts: readonly { readonly group: { readonly group_id: string }; readonly operation: { readonly operation_id: string } }[],
  classifications: ReadonlyMap<string, Classification<TReason>>,
): OperationResult<TReason>[] {
  return contexts.map((context) => {
    const classification = classifications.get(context.operation.operation_id);
    if (classification == null) {
      throw new Error("操作の競合分類結果がありません。");
    }
    switch (classification.kind) {
      case "applicable":
        return {
          group_id: context.group.group_id,
          operation_id: context.operation.operation_id,
          kind: classification.kind,
          affected_task_gids: [...classification.affected_task_gids],
        };
      case "already_applied":
        return {
          group_id: context.group.group_id,
          operation_id: context.operation.operation_id,
          kind: classification.kind,
          affected_task_gids: [...classification.affected_task_gids],
        };
      case "conflict":
        return {
          group_id: context.group.group_id,
          operation_id: context.operation.operation_id,
          kind: classification.kind,
          reason_codes: [...classification.reason_codes],
          affected_task_gids: [...classification.affected_task_gids],
        };
    }
  });
}

/** グループごとの承認競合結果を組み立てます。 */
export function createGroupResults<TReason extends string>(
  proposal: { readonly groups: readonly { readonly group_id: string; readonly atomic: boolean; readonly operations: readonly { readonly operation_id: string }[] }[] },
  selectedOperationIds: ReadonlySet<string>,
  classifications: ReadonlyMap<string, Classification<TReason>>,
): GroupResult[] {
  const groups: GroupResult[] = [];
  for (const group of proposal.groups) {
    const selectedOperations = group.operations.filter((operation) =>
      selectedOperationIds.has(operation.operation_id));
    if (selectedOperations.length === 0) {
      continue;
    }
    const selectedClassifications = selectedOperations.map((operation) => {
      const classification = classifications.get(operation.operation_id);
      if (classification == null) {
        throw new Error("グループの競合分類結果がありません。");
      }
      return classification;
    });
    const hasApplicableOperation = selectedClassifications.some(
      (classification) => classification.kind !== "conflict",
    );
    const hasConflict = selectedClassifications.some(
      (classification) => classification.kind === "conflict",
    );
    groups.push({
      group_id: group.group_id,
      atomic: group.atomic,
      applicable: group.atomic
        ? hasApplicableOperation && !hasConflict
        : hasApplicableOperation,
      operation_ids: selectedOperations.map((operation) => operation.operation_id),
    });
  }
  return groups;
}
