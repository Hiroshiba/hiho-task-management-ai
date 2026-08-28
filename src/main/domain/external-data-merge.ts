import { z } from "zod";
import {
  canonicalizeJson,
  customExternalDataSchema,
  dateSchema,
  dependenciesSchema,
  identifierSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
  serializeCustomExternalData,
  type CustomExternalData,
  type ObsidianLink,
} from "../../shared/domain";

const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);
const customExternalDataMergeFieldSchema = z.enum([
  "dependencies",
  "obsidian_links",
  "last_active_status",
  "parent_work_mode",
  "activity_anchor_on",
]);

const setDependenciesOperationSchema = z
  .object({
    operation: z.literal("set_dependencies"),
    before: dependenciesSchema,
    after: dependenciesSchema,
  })
  .strict();

const setObsidianLinksOperationSchema = z
  .object({
    operation: z.literal("set_obsidian_links"),
    before: obsidianLinksSchema,
    after: obsidianLinksSchema,
  })
  .strict();

const setLastActiveStatusOperationSchema = z
  .object({
    operation: z.literal("set_last_active_status"),
    before: activeTaskStatusSchema,
    after: activeTaskStatusSchema,
  })
  .strict();

const setParentWorkModeOperationSchema = z
  .object({
    operation: z.literal("set_parent_work_mode"),
    before: parentWorkModeSchema,
    after: parentWorkModeSchema,
  })
  .strict();

const setActivityAnchorOnOperationSchema = z
  .object({
    operation: z.literal("set_activity_anchor_on"),
    before: dateSchema,
    after: dateSchema,
  })
  .strict();

const customExternalDataMergeOperationSchema = z.discriminatedUnion("operation", [
  setDependenciesOperationSchema,
  setObsidianLinksOperationSchema,
  setLastActiveStatusOperationSchema,
  setParentWorkModeOperationSchema,
  setActivityAnchorOnOperationSchema,
]);

const customExternalDataMergeOperationsSchema = z
  .array(customExternalDataMergeOperationSchema)
  .min(1, "Custom external dataの変更操作を1件以上指定してください。")
  .max(5, "Custom external dataの変更操作は5件まで指定できます。")
  .superRefine((operations, context) => {
    const seen = new Set<string>();
    operations.forEach((operation, index) => {
      if (seen.has(operation.operation)) {
        context.addIssue({
          code: "custom",
          path: [index, "operation"],
          message: "同じCustom external dataのフィールドを複数回変更できません。",
        });
        return;
      }
      seen.add(operation.operation);
    });
  });

const mergeInputSchema = z
  .object({
    baseline: customExternalDataSchema,
    current: customExternalDataSchema,
    operations: customExternalDataMergeOperationsSchema,
    last_writer: identifierSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.baseline.id !== input.current.id) {
      context.addIssue({
        code: "custom",
        path: ["current", "id"],
        message: "baselineとcurrentのCustom external dataが同一タスクではありません。",
      });
    }

    input.operations.forEach((operation, index) => {
      let matches: boolean;
      switch (operation.operation) {
        case "set_dependencies":
          matches = sameCollection(
            operation.before,
            input.baseline.dependencies,
            (value) => value.task_gid,
          );
          break;
        case "set_obsidian_links":
          matches = sameCollection(
            operation.before,
            input.baseline.obsidian_links,
            (value) => `${value.vault_id}\u0000${value.path}`,
          );
          break;
        case "set_last_active_status":
          matches = operation.before === input.baseline.last_active_status;
          break;
        case "set_parent_work_mode":
          matches = operation.before === input.baseline.parent_work_mode;
          break;
        case "set_activity_anchor_on":
          matches = operation.before === input.baseline.activity_anchor_on;
          break;
      }
      if (!matches) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "before"],
          message: "変更操作のbeforeがbaselineの値と一致しません。",
        });
      }
    });
  });

const customExternalDataMergeConflictSchema = z
  .object({
    kind: z.literal("conflict"),
    field: customExternalDataMergeFieldSchema,
    key: z.string().min(1).optional(),
  })
  .strict();

const customExternalDataMergedResultSchema = z
  .object({
    kind: z.literal("merged"),
    data: customExternalDataSchema,
  })
  .strict();

const customExternalDataAlreadyAppliedResultSchema = z
  .object({
    kind: z.literal("already_applied"),
    data: customExternalDataSchema,
  })
  .strict();

const mergeResultSchema = z.discriminatedUnion("kind", [
  customExternalDataMergedResultSchema,
  customExternalDataAlreadyAppliedResultSchema,
  customExternalDataMergeConflictSchema,
]);

export type CustomExternalDataMergeInput = z.infer<
  typeof mergeInputSchema
>;
export type CustomExternalDataMergeOperation = z.infer<
  typeof customExternalDataMergeOperationSchema
>;
export type CustomExternalDataMergeResult = z.infer<
  typeof mergeResultSchema
>;

/** Custom external dataのマージ入力を検証するスキーマです。 */
export const customExternalDataMergeInputSchema = mergeInputSchema;

/** Custom external dataのマージ結果を検証するスキーマです。 */
export const customExternalDataMergeResultSchema = mergeResultSchema;

type MergeField = z.infer<typeof customExternalDataMergeFieldSchema>;

type CollectionValue<T> =
  | { readonly kind: "present"; readonly value: T }
  | { readonly kind: "absent" };

type ResolvedValue<T> =
  | { readonly kind: "resolved"; readonly value: T; readonly changed: boolean }
  | { readonly kind: "conflict"; readonly field: MergeField; readonly key?: string };

const mergeFieldOrder = [
  "dependencies",
  "obsidian_links",
  "last_active_status",
  "parent_work_mode",
  "activity_anchor_on",
];

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function operationField(operation: CustomExternalDataMergeOperation): MergeField {
  switch (operation.operation) {
    case "set_dependencies":
      return "dependencies";
    case "set_obsidian_links":
      return "obsidian_links";
    case "set_last_active_status":
      return "last_active_status";
    case "set_parent_work_mode":
      return "parent_work_mode";
    case "set_activity_anchor_on":
      return "activity_anchor_on";
  }
}

function sameScalarValue<T>(left: T, right: T): boolean {
  return left === right;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function createCollectionMap<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (result.has(key)) {
      throw new Error("Custom external dataのコレクションキーが重複しています。");
    }
    result.set(key, value);
  }
  return result;
}

function collectionValue<T>(
  values: ReadonlyMap<string, T>,
  key: string,
): CollectionValue<T> {
  if (!values.has(key)) {
    return { kind: "absent" };
  }
  const value = values.get(key);
  if (value == null) {
    throw new Error("Custom external dataのコレクション値を取得できません。");
  }
  return { kind: "present", value };
}

function sameCollectionValue<T>(
  left: CollectionValue<T>,
  right: CollectionValue<T>,
): boolean {
  if (left.kind === "absent" || right.kind === "absent") {
    return left.kind === right.kind;
  }
  return sameJsonValue(left.value, right.value);
}

function allCollectionKeys<T>(
  values: readonly (readonly T[])[],
  keyOf: (value: T) => string,
): string[] {
  const keys = new Set<string>();
  for (const collection of values) {
    for (const value of collection) {
      keys.add(keyOf(value));
    }
  }
  return [...keys].sort(compareStrings);
}

function sortCollection<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): T[] {
  return [...values].sort((left, right) => compareStrings(keyOf(left), keyOf(right)));
}

function sameCollection<T>(
  left: readonly T[],
  right: readonly T[],
  keyOf: (value: T) => string,
): boolean {
  const leftMap = new Map<string, T>();
  for (const value of left) {
    const key = keyOf(value);
    if (leftMap.has(key)) {
      return false;
    }
    leftMap.set(key, value);
  }
  const rightMap = new Map<string, T>();
  for (const value of right) {
    const key = keyOf(value);
    if (rightMap.has(key)) {
      return false;
    }
    rightMap.set(key, value);
  }
  if (leftMap.size !== rightMap.size) {
    return false;
  }
  for (const [key, leftValue] of leftMap) {
    const rightValue = rightMap.get(key);
    if (rightValue == null || !sameJsonValue(leftValue, rightValue)) {
      return false;
    }
  }
  return true;
}

function resolveScalar<T>(
  field: MergeField,
  baseline: T,
  current: T,
  after: T,
): ResolvedValue<T> {
  if (sameScalarValue(current, baseline)) {
    return {
      kind: "resolved",
      value: after,
      changed: !sameScalarValue(current, after),
    };
  }
  if (sameScalarValue(current, after)) {
    return { kind: "resolved", value: current, changed: false };
  }
  return { kind: "conflict", field };
}

function resolveActivityAnchorOn(
  baseline: string,
  current: string,
  after: string,
): { readonly value: string; readonly changed: boolean } {
  const validatedBaseline = dateSchema.parse(baseline);
  const validatedCurrent = dateSchema.parse(current);
  const validatedAfter = dateSchema.parse(after);
  const currentOrBaseline = compareStrings(validatedCurrent, validatedBaseline) >= 0
    ? validatedCurrent
    : validatedBaseline;
  const value = compareStrings(validatedAfter, currentOrBaseline) > 0
    ? validatedAfter
    : currentOrBaseline;
  return {
    value,
    changed: value !== validatedCurrent,
  };
}

function resolveCollection<T>(
  field: "dependencies" | "obsidian_links",
  baseline: readonly T[],
  current: readonly T[],
  after: readonly T[],
  keyOf: (value: T) => string,
  conflictKeyOf: (value: T) => string,
): ResolvedValue<T[]> {
  const baselineMap = createCollectionMap(baseline, keyOf);
  const currentMap = createCollectionMap(current, keyOf);
  const afterMap = createCollectionMap(after, keyOf);
  const keys = allCollectionKeys([baseline, current, after], keyOf);
  const mergedMap = new Map(currentMap);
  let changed = false;

  for (const key of keys) {
    const baselineValue = collectionValue(baselineMap, key);
    const currentValue = collectionValue(currentMap, key);
    const afterValue = collectionValue(afterMap, key);
    if (sameCollectionValue(baselineValue, afterValue)) {
      continue;
    }

    let selectedValue: CollectionValue<T>;
    if (sameCollectionValue(currentValue, baselineValue)) {
      selectedValue = afterValue;
    } else if (sameCollectionValue(currentValue, afterValue)) {
      selectedValue = currentValue;
    } else {
      let conflictValue: T | undefined;
      if (afterValue.kind === "present") {
        conflictValue = afterValue.value;
      } else if (currentValue.kind === "present") {
        conflictValue = currentValue.value;
      } else if (baselineValue.kind === "present") {
        conflictValue = baselineValue.value;
      }
      if (conflictValue == null) {
        throw new Error("Custom external dataの競合キーを取得できません。");
      }
      return {
        kind: "conflict",
        field,
        key: conflictKeyOf(conflictValue),
      };
    }

    if (selectedValue.kind === "present") {
      mergedMap.set(key, selectedValue.value);
    } else {
      mergedMap.delete(key);
    }
    if (!sameCollectionValue(currentValue, selectedValue)) {
      changed = true;
    }
  }

  const merged = [...mergedMap.keys()]
    .sort(compareStrings)
    .map((key) => {
      const value = mergedMap.get(key);
      if (value == null) {
        throw new Error("Custom external dataのマージ値を取得できません。");
      }
      return value;
    });
  return { kind: "resolved", value: merged, changed };
}

function sortedOperations(
  operations: readonly CustomExternalDataMergeOperation[],
): CustomExternalDataMergeOperation[] {
  return [...operations].sort((left, right) =>
    mergeFieldOrder.indexOf(operationField(left)) - mergeFieldOrder.indexOf(operationField(right)));
}

function nextRevision(baselineRevision: number, currentRevision: number): number {
  const maximumRevision = Math.max(baselineRevision, currentRevision);
  if (!Number.isSafeInteger(maximumRevision) || maximumRevision >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Custom external dataのrevを安全な整数として更新できません。");
  }
  return maximumRevision + 1;
}

function mergeData(
  input: CustomExternalDataMergeInput,
): CustomExternalDataMergeResult {
  const baseline = input.baseline;
  const current = input.current;
  let dependencies = sortCollection(current.dependencies, (value) => value.task_gid);
  let obsidianLinks = sortCollection(
    current.obsidian_links,
    (value) => `${value.vault_id}\u0000${value.path}`,
  );
  let lastActiveStatus = current.last_active_status;
  let parentWorkMode = current.parent_work_mode;
  let activityAnchorOn = current.activity_anchor_on;
  let changed = false;

  for (const operation of sortedOperations(input.operations)) {
    switch (operation.operation) {
      case "set_dependencies": {
        const field = "dependencies";
        const resolved = resolveCollection(
          field,
          baseline.dependencies,
          current.dependencies,
          operation.after,
          (value) => value.task_gid,
          (value) => value.task_gid,
        );
        if (resolved.kind === "conflict") {
          return mergeResultSchema.parse(resolved);
        }
        dependencies = resolved.value;
        changed = changed || resolved.changed;
        break;
      }
      case "set_obsidian_links": {
        const field = "obsidian_links";
        const keyOf = (value: ObsidianLink): string =>
          `${value.vault_id}\u0000${value.path}`;
        const resolved = resolveCollection(
          field,
          baseline.obsidian_links,
          current.obsidian_links,
          operation.after,
          keyOf,
          (value) => `${value.vault_id}:${value.path}`,
        );
        if (resolved.kind === "conflict") {
          return mergeResultSchema.parse(resolved);
        }
        obsidianLinks = resolved.value;
        changed = changed || resolved.changed;
        break;
      }
      case "set_last_active_status": {
        const field = "last_active_status";
        const resolved = resolveScalar(
          field,
          baseline.last_active_status,
          current.last_active_status,
          operation.after,
        );
        if (resolved.kind === "conflict") {
          return mergeResultSchema.parse(resolved);
        }
        lastActiveStatus = resolved.value;
        changed = changed || resolved.changed;
        break;
      }
      case "set_parent_work_mode": {
        const field = "parent_work_mode";
        const resolved = resolveScalar(
          field,
          baseline.parent_work_mode,
          current.parent_work_mode,
          operation.after,
        );
        if (resolved.kind === "conflict") {
          return mergeResultSchema.parse(resolved);
        }
        parentWorkMode = resolved.value;
        changed = changed || resolved.changed;
        break;
      }
      case "set_activity_anchor_on": {
        const resolved = resolveActivityAnchorOn(
          baseline.activity_anchor_on,
          current.activity_anchor_on,
          operation.after,
        );
        activityAnchorOn = resolved.value;
        changed = changed || resolved.changed;
        break;
      }
    }
  }

  if (!changed) {
    return mergeResultSchema.parse({
      kind: "already_applied",
      data: current,
    });
  }

  const mergedData: CustomExternalData = {
    ...current,
    rev: nextRevision(baseline.rev, current.rev),
    last_active_status: lastActiveStatus,
    activity_anchor_on: activityAnchorOn,
    parent_work_mode: parentWorkMode,
    dependencies,
    obsidian_links: obsidianLinks,
    provenance: {
      ...current.provenance,
      last_writer: input.last_writer,
    },
  };
  serializeCustomExternalData(mergedData);
  return mergeResultSchema.parse({
    kind: "merged",
    data: mergedData,
  });
}

/** Custom external dataをフィールド単位で3-wayマージします。 */
export function mergeCustomExternalData(
  input: CustomExternalDataMergeInput,
): CustomExternalDataMergeResult {
  const validatedInput = mergeInputSchema.parse(input);
  return mergeData(validatedInput);
}
