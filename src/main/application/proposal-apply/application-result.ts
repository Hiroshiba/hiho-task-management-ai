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
type RecoveryEntry = {
  readonly journal: {
    readonly plan: { readonly group_order: number; readonly operation_order: number };
  };
  readonly context: {
    readonly group: { readonly group_id: string; readonly atomic: boolean };
    readonly operation: { readonly operation_id: string };
  };
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

export function buildRecoveryApplicationResult<TOperationResult extends OperationResult>(
  proposalId: string,
  entries: readonly RecoveryEntry[],
  selectedOperationIds: ReadonlySet<string>,
  operationResults: ReadonlyMap<string, TOperationResult>,
): ApplicationResult<TOperationResult> {
  const groupsById = new Map<string, {
    readonly group: { readonly group_id: string; readonly atomic: boolean };
    readonly group_order: number;
    readonly operations: TOperationResult[];
    readonly operation_ids: string[];
  }>();
  const sortedEntries = [...entries].sort((left, right) =>
    left.journal.plan.operation_order - right.journal.plan.operation_order);
  for (const entry of sortedEntries) {
    const operationId = entry.context.operation.operation_id;
    if (!selectedOperationIds.has(operationId)) {
      continue;
    }
    const result = operationResults.get(operationId);
    if (result == null) {
      throw new Error("復旧操作の結果がありません。");
    }
    const current = groupsById.get(entry.context.group.group_id);
    if (current == null) {
      groupsById.set(entry.context.group.group_id, {
        group: entry.context.group,
        group_order: entry.journal.plan.group_order,
        operations: [result],
        operation_ids: [operationId],
      });
      continue;
    }
    current.operations.push(result);
    current.operation_ids.push(operationId);
  }
  const groups = [...groupsById.values()]
    .sort((left, right) => left.group_order - right.group_order)
    .map((group) => ({
      group_id: group.group.group_id,
      atomic: group.group.atomic,
      operation_ids: group.operation_ids,
      outcome: applicationGroupOutcome(group.operations),
    }));
  const operations = [...operationResults.entries()]
    .filter(([operationId]) => selectedOperationIds.has(operationId))
    .sort(([left], [right]) => {
      const leftEntry = sortedEntries.find(
        (entry) => entry.context.operation.operation_id === left,
      );
      const rightEntry = sortedEntries.find(
        (entry) => entry.context.operation.operation_id === right,
      );
      if (leftEntry == null || rightEntry == null) {
        throw new Error("復旧操作の順序が見つかりません。");
      }
      return leftEntry.journal.plan.operation_order
        - rightEntry.journal.plan.operation_order;
    })
    .map(([, result]) => result);
  if (operations.length === 0 || groups.length === 0) {
    throw new Error("復旧対象の操作がありません。");
  }
  return {
    proposal_id: proposalId,
    outcome: applicationResultOutcome(groups),
    operations,
    groups,
  };
}


type RecoveryState<TApplication, TEntry, TOperationResult extends OperationResult> = {
  readonly application: TApplication | undefined;
  readonly entries: readonly TEntry[];
  readonly selected: ReadonlySet<string>;
  readonly operationResults: ReadonlyMap<string, TOperationResult>;
};

/** 復旧した操作を元の提案順で適用結果へまとめます。 */
export function collectRecoveryApplications<
  TApplication extends { readonly proposal_id: string; readonly proposal: Proposal },
  TEntry extends { readonly journal: { readonly proposal_id: string } },
  TOperationResult extends OperationResult,
  TResult,
>(
  states: readonly RecoveryState<TApplication, TEntry, TOperationResult>[],
  ports: {
    readonly createRecoveryResult: (proposalId: string, entries: readonly TEntry[], selected: ReadonlySet<string>, results: ReadonlyMap<string, TOperationResult>) => TResult;
    readonly createApplicationResult: (proposalId: string, proposal: TApplication["proposal"], selected: ReadonlySet<string>, results: ReadonlyMap<string, TOperationResult>) => TResult;
  },
): TResult[] {
  const applications: TResult[] = [];
  for (const state of states) {
    if (state.selected.size === 0) {
      continue;
    }
    if (state.application == null) {
      applications.push(ports.createRecoveryResult(
        state.entries[0]?.journal.proposal_id ?? "",
        state.entries,
        state.selected,
        state.operationResults,
      ));
    } else {
      applications.push(ports.createApplicationResult(
        state.application.proposal_id,
        state.application.proposal,
        state.selected,
        state.operationResults,
      ));
    }
  }
  return applications;
}
