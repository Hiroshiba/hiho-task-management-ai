type Operation = {
  readonly operation: string;
  readonly target?: unknown;
  readonly before?: unknown;
  readonly after?: unknown;
};

function addTemporaryTarget(target: unknown, references: Set<string>): void {
  if (typeof target !== "object" || target == null || !("kind" in target)) {
    return;
  }
  if (target.kind !== "temporary") {
    return;
  }
  if (!("ref" in target) || typeof target.ref !== "string") {
    throw new Error("一時参照のrefがありません。");
  }
  references.add(target.ref);
}

function dependencies(value: unknown): readonly unknown[] {
  if (typeof value !== "object" || value == null || !("dependencies" in value)) {
    return [];
  }
  if (value.dependencies == null) {
    return [];
  }
  if (!Array.isArray(value.dependencies)) {
    throw new Error("依存関係の形式が不正です。");
  }
  return value.dependencies;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function addDependencyTargets(values: readonly unknown[], references: Set<string>): void {
  for (const dependency of values) {
    if (typeof dependency !== "object" || dependency == null || !("target" in dependency)) {
      throw new Error("依存関係の対象がありません。");
    }
    addTemporaryTarget(dependency.target, references);
  }
}

/** 復旧操作が参照する作成予定タスクを返します。 */
export function operationTemporaryReferences(operation: Operation): readonly string[] {
  const references = new Set<string>();
  if (operation.operation === "create_task") {
    if (typeof operation.after !== "object" || operation.after == null) {
      throw new Error("create_taskの適用後状態がありません。");
    }
    if ("parent" in operation.after) {
      addTemporaryTarget(operation.after.parent, references);
    }
    addDependencyTargets(dependencies(operation.after), references);
  } else {
    addTemporaryTarget(operation.target, references);
    if (operation.operation === "set_dependencies") {
      if (!isUnknownArray(operation.before) || !isUnknownArray(operation.after)) {
        throw new Error("依存関係の適用前後がありません。");
      }
      addDependencyTargets([...operation.before, ...operation.after], references);
    }
    if (operation.operation === "set_parent") {
      addTemporaryTarget(operation.before, references);
      addTemporaryTarget(operation.after, references);
    }
  }
  return [...references].sort();
}

/** create_taskが参照する作成予定タスクを返します。 */
export function createTaskTemporaryReferences(operation: Operation): readonly string[] {
  if (operation.operation !== "create_task") {
    throw new Error("create_task以外から一時参照の依存関係を取得できません。");
  }
  return operationTemporaryReferences(operation);
}
