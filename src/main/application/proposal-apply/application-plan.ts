type Group<TOperation extends { readonly operation_id: string }> = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly operations: readonly TOperation[];
};

type Context<TOperation extends { readonly operation_id: string }> = {
  readonly group: { readonly group_id: string; readonly atomic: boolean };
  readonly operation: TOperation;
};

/** 変更案のグループを操作順の一覧へ展開します。 */
export function flattenProposal<TOperation extends { readonly operation_id: string }>(
  proposal: { readonly groups: readonly Group<TOperation>[] },
): readonly Context<TOperation>[] {
  return proposal.groups.flatMap((group) =>
    group.operations.map((operation) => ({ group, operation })));
}

/** 操作IDを重複検査して変更案の操作を索引化します。 */
export function operationMap<TContext extends Context<{ readonly operation_id: string }>>(
  contexts: readonly TContext[],
): ReadonlyMap<string, TContext> {
  const result = new Map<string, TContext>();
  for (const context of contexts) {
    if (result.has(context.operation.operation_id)) {
      throw new Error("proposalのoperation_idが重複しています。");
    }
    result.set(context.operation.operation_id, context);
  }
  return result;
}

/** 承認競合の操作を重複検査して索引化します。 */
export function approvalOperationMap<TOperation extends { readonly operation_id: string }>(
  approval: { readonly operations: readonly TOperation[] },
): ReadonlyMap<string, TOperation> {
  const result = new Map<string, TOperation>();
  for (const operation of approval.operations) {
    if (result.has(operation.operation_id)) {
      throw new Error("承認競合結果のoperation_idが重複しています。");
    }
    result.set(operation.operation_id, operation);
  }
  return result;
}

/** 承認競合のグループを重複検査して索引化します。 */
export function approvalGroupMap<TGroup extends { readonly group_id: string }>(
  approval: { readonly groups: readonly TGroup[] },
): ReadonlyMap<string, TGroup> {
  const result = new Map<string, TGroup>();
  for (const group of approval.groups) {
    if (result.has(group.group_id)) {
      throw new Error("承認競合結果のgroup_idが重複しています。");
    }
    result.set(group.group_id, group);
  }
  return result;
}

/** 承認済みでグループも適用可能な操作IDを集めます。 */
export function collectApplicableOperationIds(
  contexts: readonly Context<{ readonly operation_id: string }>[],
  selectedOperationIds: ReadonlySet<string>,
  approvalOperations: ReadonlyMap<string, { readonly kind: string }>,
  approvalGroups: ReadonlyMap<string, { readonly applicable: boolean }>,
): readonly string[] {
  const operationIds: string[] = [];
  for (const context of contexts) {
    if (!selectedOperationIds.has(context.operation.operation_id)) {
      continue;
    }
    const classification = approvalOperations.get(context.operation.operation_id);
    if (classification == null) {
      throw new Error("承認競合結果の操作がありません。");
    }
    const group = approvalGroups.get(context.group.group_id);
    if (group == null) {
      throw new Error("承認競合結果のグループがありません。");
    }
    if (classification.kind === "applicable" && group.applicable) {
      operationIds.push(context.operation.operation_id);
    }
  }
  return operationIds;
}

type TemporaryMapping = { readonly temporary_ref: string; readonly task_gid: string };

/** 一時参照の対応を重複検査して索引化します。 */
export function temporaryMappingMap(mappings: readonly TemporaryMapping[]): Map<string, string> {
  const result = new Map<string, string>();
  const gids = new Set<string>();
  for (const mapping of mappings) {
    if (result.has(mapping.temporary_ref) || gids.has(mapping.task_gid)) {
      throw new Error("temporary_ref対応が重複しています。");
    }
    result.set(mapping.temporary_ref, mapping.task_gid);
    gids.add(mapping.task_gid);
  }
  return result;
}

/** 一時参照の対応を参照ID順の配列にします。 */
export function mappingArray(mappings: ReadonlyMap<string, string>): TemporaryMapping[] {
  return [...mappings.entries()]
    .sort((left, right) => {
      if (left[0] < right[0]) {
        return -1;
      }
      if (left[0] > right[0]) {
        return 1;
      }
      return 0;
    })
    .map(([temporary_ref, task_gid]) => ({ temporary_ref, task_gid }));
}

/** 一時参照へ重複しないタスクGIDを記録します。 */
export function addTemporaryMapping(
  mappings: Map<string, string>,
  temporaryRef: string,
  taskGid: string,
): void {
  const current = mappings.get(temporaryRef);
  if (current != null && current !== taskGid) {
    throw new Error("temporary_refの対応先が変化しました。");
  }
  for (const [ref, gid] of mappings) {
    if (ref !== temporaryRef && gid === taskGid) {
      throw new Error("同じタスクGIDへ複数のtemporary_refを対応できません。");
    }
  }
  mappings.set(temporaryRef, taskGid);
}
