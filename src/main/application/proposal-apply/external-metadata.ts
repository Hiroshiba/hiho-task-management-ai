import {
  mergeCustomExternalData,
  type CustomExternalDataMergeInput,
  type CustomExternalDataMergeOperation,
} from "../../domain";

type ExternalData = CustomExternalDataMergeInput["baseline"];
type Dependency = ExternalData["dependencies"][number];
type ObsidianLink = ExternalData["obsidian_links"][number];
type Duration = NonNullable<ExternalData["duration"]>;
type Target = { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };
type Parent = Target | { readonly kind: "absent" };
type ProposalDependency = {
  readonly target: Target;
  readonly scope: Dependency["scope"];
  readonly source: string;
};
type Due = { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type DurationValue = Duration | { readonly kind: "absent" };
type TaskStatus = "not_started" | "in_progress" | "completed" | "withdrawn";

type ExternalOperation =
  | { readonly operation: "update_title" | "update_notes" | "set_area"; readonly before: string; readonly after: string }
  | { readonly operation: "set_importance"; readonly before: number; readonly after: number }
  | { readonly operation: "set_status"; readonly before: TaskStatus; readonly after: ExternalData["last_active_status"] }
  | { readonly operation: "set_due"; readonly before: Due; readonly after: Due }
  | { readonly operation: "clear_due" }
  | { readonly operation: "set_duration" | "clear_duration"; readonly before: DurationValue; readonly after: DurationValue }
  | { readonly operation: "set_dependencies"; readonly before: readonly ProposalDependency[]; readonly after: readonly ProposalDependency[] }
  | { readonly operation: "set_parent"; readonly before: Parent; readonly after: Parent }
  | { readonly operation: "set_parent_work_mode"; readonly before: ExternalData["parent_work_mode"]; readonly after: ExternalData["parent_work_mode"] }
  | { readonly operation: "link_obsidian"; readonly after: ObsidianLink }
  | { readonly operation: "unlink_obsidian"; readonly before: ObsidianLink }
  | { readonly operation: "complete" | "withdraw" };

type FieldClassification = "before" | "partial" | "after" | "conflict";

export type ExternalMetadataDependencies = {
  readonly canonicalizeJson: (value: unknown) => string;
  readonly sameDueProposalValue: (left: Due, right: Due) => boolean;
  readonly optionalDuration: (value: DurationValue) => Duration | undefined;
  readonly sameDurationValue: (left: Duration | undefined, right: Duration | undefined) => boolean;
  readonly resolveDependencies: (values: readonly ProposalDependency[], mappings: ReadonlyMap<string, string>) => readonly Dependency[];
  readonly sameDependencies: (left: readonly Dependency[], right: readonly Dependency[]) => boolean;
  readonly resolveParentGid: (value: Parent, mappings: ReadonlyMap<string, string>) => string | null;
  readonly sameParentValue: (left: string | null, right: string | null) => boolean;
  readonly findObsidianLink: (links: readonly ObsidianLink[], target: ObsidianLink) => ObsidianLink | undefined;
  readonly sameObsidianLink: (left: ObsidianLink, right: ObsidianLink) => boolean;
  readonly obsidianKey: (link: ObsidianLink) => string;
  readonly classifyValue: <T>(current: T, before: T, after: T, equal: (left: T, right: T) => boolean) => FieldClassification;
};

function externalOperationAnchor(
  baseline: ExternalData,
  activityDate: string,
): CustomExternalDataMergeOperation {
  return {
    operation: "set_activity_anchor_on",
    before: baseline.activity_anchor_on,
    after: activityDate,
  };
}

/** 操作から外部メタデータの変更内容を取り出します。 */
export function externalOperationsForOperation(
  operation: ExternalOperation,
  baseline: ExternalData,
  mappings: ReadonlyMap<string, string>,
  activityDate: string,
  dependencies: ExternalMetadataDependencies,
): readonly CustomExternalDataMergeOperation[] {
  const operations: CustomExternalDataMergeOperation[] = [];
  switch (operation.operation) {
    case "update_title":
      if (operation.before !== operation.after) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "update_notes":
      if (operation.before !== operation.after) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "set_status": {
      if (operation.before === operation.after) {
        break;
      }
      operations.push({
        operation: "set_last_active_status",
        before: baseline.last_active_status,
        after: operation.after,
      });
      if (
        (operation.before === "completed" || operation.before === "withdrawn")
        && (operation.after === "not_started" || operation.after === "in_progress")
      ) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    }
    case "set_importance":
      if (operation.before !== operation.after) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "set_due":
      if (!dependencies.sameDueProposalValue(operation.before, operation.after)) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "clear_due":
      operations.push(externalOperationAnchor(baseline, activityDate));
      break;
    case "set_duration":
    case "clear_duration": {
      const before = dependencies.optionalDuration(operation.before);
      const after = dependencies.optionalDuration(operation.after);
      if (!dependencies.sameDurationValue(before, baseline.duration)) {
        throw new Error("所要時間操作のbaselineが一致しません。");
      }
      if (!dependencies.sameDurationValue(before, after)) {
        operations.push({
          operation: "set_duration",
          before,
          after,
        });
      }
      break;
    }
    case "set_area":
      if (operation.before !== operation.after) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "set_dependencies": {
      const before = dependencies.resolveDependencies(operation.before, mappings);
      const after = dependencies.resolveDependencies(operation.after, mappings);
      if (!dependencies.sameDependencies(before, baseline.dependencies)) {
        throw new Error("依存関係操作のbaselineが一致しません。");
      }
      if (!dependencies.sameDependencies(before, after)) {
        operations.push({
          operation: "set_dependencies",
          before: [...before],
          after: [...after],
        });
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    }
    case "set_parent": {
      const before = dependencies.resolveParentGid(operation.before, mappings);
      const after = dependencies.resolveParentGid(operation.after, mappings);
      if (!dependencies.sameParentValue(before, after)) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    }
    case "set_parent_work_mode":
      if (operation.before !== baseline.parent_work_mode) {
        throw new Error("親作業モード操作のbaselineが一致しません。");
      }
      if (operation.before !== operation.after) {
        operations.push({
          operation: "set_parent_work_mode",
          before: operation.before,
          after: operation.after,
        });
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "link_obsidian": {
      const existing = dependencies.findObsidianLink(baseline.obsidian_links, operation.after);
      if (existing != null) {
        throw new Error("Obsidianリンク操作のbaselineが一致しません。");
      }
      operations.push({
        operation: "set_obsidian_links",
        before: baseline.obsidian_links,
        after: [...baseline.obsidian_links, operation.after],
      });
      break;
    }
    case "unlink_obsidian": {
      const existing = dependencies.findObsidianLink(baseline.obsidian_links, operation.before);
      if (existing == null || !dependencies.sameObsidianLink(existing, operation.before)) {
        throw new Error("Obsidianリンク操作のbaselineが一致しません。");
      }
      operations.push({
        operation: "set_obsidian_links",
        before: baseline.obsidian_links,
        after: baseline.obsidian_links.filter(
          (link) => dependencies.obsidianKey(link) !== dependencies.obsidianKey(operation.before),
        ),
      });
      break;
    }
    case "complete":
    case "withdraw":
      break;
  }
  return operations;
}

function classifyCollectionOperation<T>(
  current: readonly T[],
  before: readonly T[],
  after: readonly T[],
  keyOf: (value: T) => string,
  canonicalizeJson: (value: unknown) => string,
): FieldClassification {
  const beforeMap = new Map(before.map((value) => [keyOf(value), value]));
  const afterMap = new Map(after.map((value) => [keyOf(value), value]));
  const currentMap = new Map(current.map((value) => [keyOf(value), value]));
  const changedKeys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const states: FieldClassification[] = [];
  for (const key of changedKeys) {
    const beforeValue = beforeMap.get(key);
    const afterValue = afterMap.get(key);
    if (
      beforeValue != null
      && afterValue != null
      && canonicalizeJson(beforeValue) === canonicalizeJson(afterValue)
    ) {
      continue;
    }
    const currentValue = currentMap.get(key);
    if (
      currentValue == null
      ? beforeValue == null
      : beforeValue != null
        && canonicalizeJson(currentValue) === canonicalizeJson(beforeValue)
    ) {
      states.push("before");
    } else if (
      currentValue == null
        ? afterValue == null
        : afterValue != null
          && canonicalizeJson(currentValue) === canonicalizeJson(afterValue)
    ) {
      states.push("after");
    } else {
      return "conflict";
    }
  }
  if (states.length === 0 || states.every((state) => state === "after")) {
    return "after";
  }
  if (states.every((state) => state === "before")) {
    return "before";
  }
  return "partial";
}

/** 外部メタデータが変更前後のどちらの状態にあるか判定します。 */
export function classifyExternalMetadata(
  operation: ExternalOperation,
  baseline: ExternalData,
  current: ExternalData,
  mappings: ReadonlyMap<string, string>,
  activityDate: string,
  dependencies: ExternalMetadataDependencies,
): FieldClassification {
  const operations = externalOperationsForOperation(
    operation,
    baseline,
    mappings,
    activityDate,
    dependencies,
  );
  const states = operations.map((externalOperation): FieldClassification => {
    switch (externalOperation.operation) {
      case "set_dependencies":
        return classifyCollectionOperation(
          current.dependencies,
          externalOperation.before,
          externalOperation.after,
          (value) => value.task_gid,
          dependencies.canonicalizeJson,
        );
      case "set_obsidian_links":
        return classifyCollectionOperation(
          current.obsidian_links,
          externalOperation.before,
          externalOperation.after,
          dependencies.obsidianKey,
          dependencies.canonicalizeJson,
        );
      case "set_last_active_status":
        return dependencies.classifyValue(
          current.last_active_status,
          externalOperation.before,
          externalOperation.after,
          (left, right) => left === right,
        );
      case "set_parent_work_mode":
        return dependencies.classifyValue(
          current.parent_work_mode,
          externalOperation.before,
          externalOperation.after,
          (left, right) => left === right,
        );
      case "set_activity_anchor_on":
        {
          const expectedAfter = externalOperation.before < externalOperation.after
            ? externalOperation.after
            : externalOperation.before;
          if (current.activity_anchor_on >= expectedAfter) {
            return "after";
          }
          return current.activity_anchor_on === externalOperation.before
            ? "before"
            : "conflict";
        }
      case "set_duration":
        return dependencies.classifyValue(
          current.duration,
          externalOperation.before,
          externalOperation.after,
          dependencies.sameDurationValue,
        );
    }
    throw new Error("未対応のCustom external data操作です。");
  });
  if (states.some((state) => state === "conflict")) {
    return "conflict";
  }
  if (states.length === 0 || states.every((state) => state === "after")) {
    return "after";
  }
  if (states.every((state) => state === "before")) {
    return "before";
  }
  return "partial";
}

type ExternalMergePlan =
  | { readonly kind: "none"; readonly expected: undefined; readonly write: false }
  | { readonly kind: "ready"; readonly expected: ExternalData; readonly serialized: string; readonly write: boolean }
  | { readonly kind: "conflict"; readonly reason_code: "merge_conflict" | "external_capacity_exceeded" };

/** Custom external dataのマージ結果と書込要否を判定します。 */
export function mergeExternalPlan(
  baseline: { readonly data: ExternalData },
  current: { readonly data: ExternalData },
  operations: readonly CustomExternalDataMergeOperation[],
  lastWriter: string,
  serialize: (data: ExternalData) => string,
  isCapacityError: (error: unknown) => boolean,
): ExternalMergePlan {
  if (operations.length === 0) {
    return { kind: "none", expected: undefined, write: false };
  }
  let result: ReturnType<typeof mergeCustomExternalData>;
  try {
    result = mergeCustomExternalData({
      baseline: baseline.data,
      current: current.data,
      operations: [...operations],
      last_writer: lastWriter,
    });
  } catch (error) {
    if (isCapacityError(error)) {
      return { kind: "conflict", reason_code: "external_capacity_exceeded" };
    }
    throw error;
  }
  if (result.kind === "conflict") {
    return { kind: "conflict", reason_code: "merge_conflict" };
  }
  try {
    return {
      kind: "ready",
      expected: result.data,
      serialized: serialize(result.data),
      write: result.kind === "merged",
    };
  } catch (error) {
    if (isCapacityError(error)) {
      return { kind: "conflict", reason_code: "external_capacity_exceeded" };
    }
    throw error;
  }
}
