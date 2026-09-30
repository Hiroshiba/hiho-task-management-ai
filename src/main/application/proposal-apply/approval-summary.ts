type ApplicationResult<TOutcome extends string, TReason extends string> = {
  readonly outcome: TOutcome;
  readonly operations: readonly {
    readonly group_id: string;
    readonly operation_id: string;
    readonly outcome: TOutcome;
    readonly reason_code: TReason;
    readonly task_gid?: string | undefined;
  }[];
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly outcome: TOutcome;
    readonly operation_ids: readonly string[];
  }[];
};

/** 適用結果を承認画面へ渡す要約に変換します。 */
export function createApplicationSummary<TOutcome extends string, TReason extends string>(
  result: ApplicationResult<TOutcome, TReason>,
): {
  readonly outcome: TOutcome;
  readonly operations: readonly {
    readonly group_id: string;
    readonly operation_id: string;
    readonly outcome: TOutcome;
    readonly reason_code: TReason;
    readonly task_gid?: string;
  }[];
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly outcome: TOutcome;
    readonly operation_ids: readonly string[];
  }[];
} {
  const operations = result.operations.map((operation) => {
    const base = {
      group_id: operation.group_id,
      operation_id: operation.operation_id,
      outcome: operation.outcome,
      reason_code: operation.reason_code,
    };
    if (operation.task_gid == null) {
      return base;
    }
    return { ...base, task_gid: operation.task_gid };
  });
  const groups = result.groups.map((group) => ({
    group_id: group.group_id,
    atomic: group.atomic,
    outcome: group.outcome,
    operation_ids: [...group.operation_ids],
  }));
  return {
    outcome: result.outcome,
    operations,
    groups,
  };
}
