type OperationTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };
type RecoveryOperation = {
  readonly operation: string;
  readonly operation_id: string;
  readonly temporary_ref?: string;
  readonly target?: OperationTarget;
};

export type OperationContext<TOperation extends RecoveryOperation> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};
export type RecoveryBaselineExternal = { readonly gid: string; readonly data: string };
export type RecoverySettings = {
  readonly project_gid: string;
  readonly workspace_gid: string;
  readonly section_gids: {
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  };
  readonly device_id: string;
  readonly created_via: string;
  readonly activity_date: string;
};

/** 復旧操作の対象GIDを一時参照の対応から求めます。 */
export function targetGid(
  operation: RecoveryOperation,
  mappings: ReadonlyMap<string, string>,
): string | undefined {
  if (operation.operation === "create_task") {
    if (operation.temporary_ref == null) {
      throw new Error("create_taskのtemporary_refがありません。");
    }
    return mappings.get(operation.temporary_ref);
  }
  if (operation.target == null) {
    throw new Error("操作の対象がありません。");
  }
  if (operation.target.kind === "existing") {
    return operation.target.gid;
  }
  return mappings.get(operation.target.ref);
}

/** 復旧計画へ保存する対象参照を求めます。 */
export function operationTargetForJournal(
  operation: RecoveryOperation,
  uuids: ReadonlyMap<string, string>,
):
  | { readonly kind: "new_task"; readonly uuid: string }
  | { readonly kind: "task"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string } {
  if (operation.operation === "create_task") {
    const uuid = uuids.get(operation.operation_id);
    if (uuid == null) {
      throw new Error("create_taskの事前発行UUIDがありません。");
    }
    return { kind: "new_task", uuid };
  }
  if (operation.target == null) {
    throw new Error("操作の対象がありません。");
  }
  if (operation.target.kind === "existing") {
    return { kind: "task", gid: operation.target.gid };
  }
  return { kind: "temporary", ref: operation.target.ref };
}

/** 選択操作に必要な適用基準外部データを確かめます。 */
export function validateBaselineCoverage<TOperation extends RecoveryOperation>(
  contexts: readonly OperationContext<TOperation>[],
  selectedOperationIds: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, RecoveryBaselineExternal>,
): void {
  for (const context of contexts) {
    if (
      !selectedOperationIds.has(context.operation.operation_id)
      || context.operation.operation === "create_task"
      || !operationUsesCustomExternalData(context.operation)
    ) {
      continue;
    }
    const gid = targetGid(context.operation, mappings);
    if (gid != null && !baselines.has(gid)) {
      throw new Error("選択操作の適用基準外部データがありません。");
    }
  }
}

/** 操作でCustom external dataの適用基準が必要か判定します。 */
export function operationUsesCustomExternalData(operation: RecoveryOperation): boolean {
  return operation.operation !== "create_task"
    && operation.operation !== "complete"
    && operation.operation !== "withdraw";
}

/** 保存済み計画から復旧設定を取得します。 */
export function recoverySettingsFromPlan(plan: RecoverySettings): RecoverySettings {
  return {
    project_gid: plan.project_gid,
    workspace_gid: plan.workspace_gid,
    section_gids: plan.section_gids,
    device_id: plan.device_id,
    created_via: plan.created_via,
    activity_date: plan.activity_date,
  };
}
