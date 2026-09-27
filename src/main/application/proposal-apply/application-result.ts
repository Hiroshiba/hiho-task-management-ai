type OperationOutcome = "applied" | "already_applied" | "not_applied" | "unknown";
type GroupOutcome = OperationOutcome | "partially_applied";
type OperationResult = {
  readonly group_id: string;
  readonly operation_id: string;
  readonly outcome: OperationOutcome;
};
type GroupResult = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly operation_ids: readonly string[];
  readonly outcome: GroupOutcome;
};
type ApplicationResult<TOperationResult extends OperationResult> = {
  readonly proposal_id: string;
  readonly outcome: GroupOutcome;
  readonly operations: readonly TOperationResult[];
  readonly groups: readonly GroupResult[];
};
type Proposal = {
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operations: readonly { readonly operation_id: string }[];
  }[];
};
function applicationGroupOutcome(
  operations: readonly OperationResult[],
): GroupOutcome {
  const hasUnknown = operations.some((operation) => operation.outcome === "unknown");
  const hasApplied = operations.some((operation) => operation.outcome === "applied");
  const hasAlreadyApplied = operations.some(
    (operation) => operation.outcome === "already_applied",
  );
  const hasNotApplied = operations.some(
    (operation) => operation.outcome === "not_applied",
  );
  if (hasUnknown && !hasApplied && !hasAlreadyApplied) {
    return "unknown";
  }
  if (hasUnknown || (hasNotApplied && (hasApplied || hasAlreadyApplied))) {
    return "partially_applied";
  }
  if (hasNotApplied) {
    return "not_applied";
  }
  if (hasApplied) {
    return "applied";
  }
  return "already_applied";
}

function applicationResultOutcome(
  groups: readonly GroupResult[],
): GroupOutcome {
  const hasUnknown = groups.some((group) => group.outcome === "unknown");
  const hasApplied = groups.some((group) => group.outcome === "applied");
  const hasAlreadyApplied = groups.some(
    (group) => group.outcome === "already_applied",
  );
  const hasPartiallyApplied = groups.some(
    (group) => group.outcome === "partially_applied",
  );
  const hasNotApplied = groups.some(
    (group) => group.outcome === "not_applied",
  );
  const hasAppliedFact = hasApplied || hasAlreadyApplied || hasPartiallyApplied;
  if (hasUnknown && !hasAppliedFact) {
    return "unknown";
  }
  if (hasUnknown || hasPartiallyApplied || (hasNotApplied && hasAppliedFact)) {
    return "partially_applied";
  }
  if (hasNotApplied) {
    return "not_applied";
  }
  if (hasApplied) {
    return "applied";
  }
  return "already_applied";
}

export function buildApplicationResult<TOperationResult extends OperationResult>(
  proposalId: string,
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
  operationResults: ReadonlyMap<string, TOperationResult>,
): ApplicationResult<TOperationResult> {
  const operations: TOperationResult[] = [];
  const groups: GroupResult[] = [];
  for (const group of proposal.groups) {
    const selected = group.operations.filter((operation) =>
      selectedOperationIds.has(operation.operation_id));
    if (selected.length === 0) {
      continue;
    }
    const groupOperations: TOperationResult[] = [];
    for (const operation of selected) {
      const result = operationResults.get(operation.operation_id);
      if (result == null) {
        throw new Error("適用操作の結果がありません。");
      }
      operations.push(result);
      groupOperations.push(result);
    }
    groups.push({
      group_id: group.group_id,
      atomic: group.atomic,
      operation_ids: selected.map((operation) => operation.operation_id),
      outcome: applicationGroupOutcome(groupOperations),
    });
  }
  if (operations.length === 0 || groups.length === 0) {
    throw new Error("適用対象の操作がありません。");
  }
  return {
    proposal_id: proposalId,
    outcome: applicationResultOutcome(groups),
    operations,
    groups,
  };
}
