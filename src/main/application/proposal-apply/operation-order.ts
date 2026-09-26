type OrderedOperationContext = {
  readonly operation: {
    readonly operation: string;
    readonly operation_id: string;
    readonly temporary_ref?: string;
  };
};

function operationPhase(operation: OrderedOperationContext["operation"]): number {
  if (operation.operation === "create_task") {
    return 0;
  }
  switch (operation.operation) {
    case "set_dependencies":
    case "set_parent":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
      return 2;
    default:
      return 1;
  }
}

/** 操作IDで操作を比較します。 */
export function compareOperationContexts<T extends OrderedOperationContext>(
  left: T,
  right: T,
): number {
  if (left.operation.operation_id < right.operation.operation_id) {
    return -1;
  }
  if (left.operation.operation_id > right.operation.operation_id) {
    return 1;
  }
  return 0;
}

/** タスクGIDを重複なく昇順に並べます。 */
export function sortedUniqueTaskGids(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function orderCreateTaskContexts<T extends OrderedOperationContext>(
  contexts: readonly T[],
  mappings: ReadonlyMap<string, string>,
  createTaskTemporaryReferences: (operation: T["operation"]) => readonly string[],
): readonly T[] {
  const contextByTemporaryRef = new Map<string, T>();
  const contextByOperationId = new Map<string, T>();
  const dependentOperationIds = new Map<string, Set<string>>();
  const dependencyCounts = new Map<string, number>();
  for (const context of contexts) {
    if (context.operation.operation !== "create_task") {
      throw new Error("create_task以外を作成順に含められません。");
    }
    const temporaryRef = context.operation.temporary_ref;
    if (temporaryRef == null) {
      throw new Error("create_taskのtemporary_refがありません。");
    }
    if (contextByTemporaryRef.has(temporaryRef)) {
      throw new Error("create_taskのtemporary_refが重複しています。");
    }
    if (contextByOperationId.has(context.operation.operation_id)) {
      throw new Error("create_taskのoperation_idが重複しています。");
    }
    contextByTemporaryRef.set(temporaryRef, context);
    contextByOperationId.set(context.operation.operation_id, context);
    dependentOperationIds.set(context.operation.operation_id, new Set());
    dependencyCounts.set(context.operation.operation_id, 0);
  }

  for (const context of contexts) {
    for (const temporaryRef of createTaskTemporaryReferences(context.operation)) {
      const dependency = contextByTemporaryRef.get(temporaryRef);
      if (dependency == null) {
        if (mappings.has(temporaryRef)) {
          continue;
        }
        throw new Error("create_taskが参照するtemporary_refを解決できません。");
      }
      const dependents = dependentOperationIds.get(
        dependency.operation.operation_id,
      );
      const dependencyCount = dependencyCounts.get(
        context.operation.operation_id,
      );
      if (dependents == null || dependencyCount == null) {
        throw new Error("create_taskの一時参照グラフが不正です。");
      }
      if (dependents.has(context.operation.operation_id)) {
        continue;
      }
      dependents.add(context.operation.operation_id);
      dependencyCounts.set(context.operation.operation_id, dependencyCount + 1);
    }
  }

  const ready = contexts
    .filter((context) => dependencyCounts.get(context.operation.operation_id) === 0)
    .sort(compareOperationContexts);
  const ordered: T[] = [];
  while (ready.length > 0) {
    const context = ready.shift();
    if (context == null) {
      throw new Error("create_taskの作成順を取得できません。");
    }
    ordered.push(context);
    const dependents = dependentOperationIds.get(context.operation.operation_id);
    if (dependents == null) {
      throw new Error("create_taskの一時参照グラフが不正です。");
    }
    for (const dependentOperationId of [...dependents].sort()) {
      const dependent = contextByOperationId.get(dependentOperationId);
      const dependencyCount = dependencyCounts.get(dependentOperationId);
      if (dependent == null || dependencyCount == null || dependencyCount < 1) {
        throw new Error("create_taskの一時参照グラフが不正です。");
      }
      const remainingCount = dependencyCount - 1;
      dependencyCounts.set(dependentOperationId, remainingCount);
      if (remainingCount === 0) {
        ready.push(dependent);
        ready.sort(compareOperationContexts);
      }
    }
  }
  if (ordered.length !== contexts.length) {
    throw new Error("create_taskの一時参照関係が循環しています。");
  }
  return ordered;
}

/** 作成時の一時参照と操作の段階に従って適用順を確定します。 */
export function orderApplicableContexts<T extends OrderedOperationContext>(
  contexts: readonly T[],
  mappings: ReadonlyMap<string, string>,
  createTaskTemporaryReferences: (operation: T["operation"]) => readonly string[],
): readonly T[] {
  const createContexts = contexts.filter(
    (context) => context.operation.operation === "create_task",
  );
  const remainingContexts = contexts
    .filter((context) => context.operation.operation !== "create_task")
    .sort((left, right) => {
      const phaseDifference = operationPhase(left.operation)
        - operationPhase(right.operation);
      if (phaseDifference !== 0) {
        return phaseDifference;
      }
      return compareOperationContexts(left, right);
    });
  return [
    ...orderCreateTaskContexts(createContexts, mappings, createTaskTemporaryReferences),
    ...remainingContexts,
  ];
}
