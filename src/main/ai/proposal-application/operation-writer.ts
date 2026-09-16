import { z } from "zod";
import {
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  CustomExternalDataCapacityError,
  customExternalDataSchema,
  dependencySchema,
  parseCustomExternalData,
  serializeCustomExternalData,
  type AsanaTaskResponse,
  type CustomExternalData,
  type Dependency,
  type Duration,
  type ObsidianLink,
} from "../../../shared/domain";
import {
  createInitialCustomExternalData,
  ingestAsanaExternalData,
  mergeCustomExternalData,
  type CustomExternalDataMergeOperation,
} from "../../domain";
import {
  proposalOperationSchema,
} from "../../../shared/ai";
import { AsanaReadClient } from "../../asana/client/client";
import {
  AsanaTaskWriteClient,
  type AsanaTaskCreationInput,
  type AsanaTaskUpdate,
} from "../../asana/client/task-write-client";
import {
  asanaProposalOperationWriterInputSchema,
  asanaProposalOperationWriterResultSchema,
  type AsanaProposalOperationWriterInput,
  type AsanaProposalOperationWriterResult,
  type AsanaProposalWriterSectionGids,
  type AsanaProposalWriterTemporaryRefMapping,
} from "./schemas";

const unclassifiedArea = "未分類";
const importanceTagPrefix = "TaskHub/重要度/";
const areaTagPrefix = "TaskHub/領域/";

type WriterOperation = z.infer<typeof proposalOperationSchema>;
type CreateOperation = Extract<WriterOperation, { operation: "create_task" }>;
type NonCreateOperation = Exclude<WriterOperation, CreateOperation>;
type OperationTarget = NonCreateOperation["target"];
type TaskStatusValue = "not_started" | "in_progress" | "completed" | "withdrawn";
type WriterInput = AsanaProposalOperationWriterInput;
type WriterResult = AsanaProposalOperationWriterResult;
type WriterConflictReasonCode = Extract<WriterResult, { outcome: "conflict" }>["reason_code"];
type SectionGids = AsanaProposalWriterSectionGids;
type TemporaryRefMapping = AsanaProposalWriterTemporaryRefMapping;
type AsanaTag = z.infer<typeof asanaTagResponseSchema>;
type ExternalResponse = NonNullable<AsanaTaskResponse["external"]>;
type BaselineExternalInput = NonNullable<WriterInput["baseline_external_data"]>;
type ParentValue = string | null;
type DueValue =
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type StatusDefinition = {
  readonly status: TaskStatusValue;
  readonly section_gid: string;
  readonly completed: boolean;
};
type CurrentExternal = {
  readonly response: ExternalResponse;
  readonly data: CustomExternalData;
};
type ExternalReadResult =
  | { readonly kind: "valid"; readonly value: CurrentExternal }
  | {
      readonly kind: "conflict";
      readonly reason_code: "external_unreadable" | "external_identity_mismatch";
    };
type FieldClassification = "before" | "partial" | "after" | "conflict";
type ExternalMergePlan =
  | {
      readonly kind: "none";
      readonly expected: undefined;
      readonly write: false;
    }
  | {
      readonly kind: "ready";
      readonly expected: CustomExternalData;
      readonly serialized: string;
      readonly write: boolean;
    }
  | {
      readonly kind: "conflict";
      readonly reason_code: "merge_conflict" | "external_capacity_exceeded";
    };

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function createResult(
  operationId: string,
  taskGid: string,
  outcome: "applied" | "already_applied",
  reasonCode: "applied" | "already_applied",
): WriterResult {
  return asanaProposalOperationWriterResultSchema.parse({
    operation_id: operationId,
    task_gid: taskGid,
    outcome,
    reason_code: reasonCode,
  });
}

function createConflictResult(
  operationId: string,
  taskGid: string,
  reasonCode: WriterConflictReasonCode,
  sideEffect: "none" | "possible",
): WriterResult {
  return asanaProposalOperationWriterResultSchema.parse({
    operation_id: operationId,
    task_gid: taskGid,
    outcome: "conflict",
    reason_code: reasonCode,
    side_effect: sideEffect,
  });
}

function parseTask(task: unknown, expectedGid: string | undefined): AsanaTaskResponse {
  const parsedTask = asanaTaskResponseSchema.parse(task);
  if (expectedGid != null && parsedTask.gid !== expectedGid) {
    throw new Error("AsanaタスクのGIDが対象と一致しません。");
  }
  return parsedTask;
}

function createMappingMap(
  mappings: readonly TemporaryRefMapping[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const mapping of mappings) {
    if (result.has(mapping.temporary_ref)) {
      throw new Error("temporary_ref対応が重複しています。");
    }
    result.set(mapping.temporary_ref, mapping.task_gid);
  }
  return result;
}

function resolveTargetGid(
  target: OperationTarget,
  mappings: ReadonlyMap<string, string>,
): string {
  if (target.kind === "existing") {
    return target.gid;
  }
  const gid = mappings.get(target.ref);
  if (gid == null) {
    throw new Error("temporary_refをタスクGIDへ解決できません。");
  }
  return gid;
}

function resolveParentGid(
  value: Extract<WriterOperation, { operation: "set_parent" }>["before"],
  mappings: ReadonlyMap<string, string>,
): ParentValue {
  if (value.kind === "absent") {
    return null;
  }
  return resolveTargetGid(value, mappings);
}

function resolveDependencies(
  dependencies: readonly Extract<WriterOperation, { operation: "set_dependencies" }>["before"][number][],
  mappings: ReadonlyMap<string, string>,
): readonly Dependency[] {
  return dependencies.map((dependency) => dependencySchema.parse({
    task_gid: resolveTargetGid(dependency.target, mappings),
    scope: dependency.scope,
    source: dependency.source,
  }));
}

function sortByKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): T[] {
  return [...values].sort((left, right) => compareStrings(keyOf(left), keyOf(right)));
}

function dependencyKey(value: Dependency): string {
  return canonicalizeJson(value);
}

function sameDependencies(
  left: readonly Dependency[],
  right: readonly Dependency[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const leftKeys = sortByKey(left, dependencyKey).map(dependencyKey);
  const rightKeys = sortByKey(right, dependencyKey).map(dependencyKey);
  return leftKeys.every((value, index) => value === rightKeys[index]);
}

function obsidianKey(value: ObsidianLink): string {
  return `${value.vault_id}\u0000${value.path}`;
}

function sameObsidianLink(left: ObsidianLink, right: ObsidianLink): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function findObsidianLink(
  links: readonly ObsidianLink[],
  target: ObsidianLink,
): ObsidianLink | undefined {
  return links.find((link) => obsidianKey(link) === obsidianKey(target));
}

function taskDueValue(task: AsanaTaskResponse): DueValue {
  if (task.due_on != null && task.due_at != null) {
    throw new Error("対象タスクの期限形式が不正です。");
  }
  if (task.due_on != null) {
    return { kind: "due_on", due_on: task.due_on };
  }
  if (task.due_at != null) {
    return { kind: "due_at", due_at: task.due_at };
  }
  return { kind: "absent" };
}

function sameDueValue(left: DueValue, right: DueValue): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function expectedStatus(
  status: TaskStatusValue,
  sectionGids: SectionGids,
): StatusDefinition {
  switch (status) {
    case "not_started":
      return { status, section_gid: sectionGids.not_started, completed: false };
    case "in_progress":
      return { status, section_gid: sectionGids.in_progress, completed: false };
    case "completed":
      return { status, section_gid: sectionGids.completed, completed: true };
    case "withdrawn":
      return { status, section_gid: sectionGids.withdrawn, completed: true };
  }
}

function taskProjectMembership(
  task: AsanaTaskResponse,
  projectGid: string,
): AsanaTaskResponse["memberships"][number] | undefined {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length > 1) {
    throw new Error("対象タスクの専用プロジェクト所属が重複しています。");
  }
  return memberships[0];
}

function taskParentGid(task: AsanaTaskResponse): ParentValue {
  return task.parent == null ? null : task.parent.gid;
}

function taskHasProject(task: AsanaTaskResponse, projectGid: string): boolean {
  return task.projects.some((project) => project.gid === projectGid)
    || task.memberships.some((membership) => membership.project.gid === projectGid);
}

function validateTaskTags(task: AsanaTaskResponse): void {
  const seen = new Set<string>();
  for (const tag of task.tags) {
    if (seen.has(tag.gid)) {
      throw new Error("対象タスクのタグGIDが重複しています。");
    }
    seen.add(tag.gid);
  }
}

function categoryTags(task: AsanaTaskResponse, prefix: string): readonly AsanaTag[] {
  validateTaskTags(task);
  return task.tags.filter((tag) => tag.name.startsWith(prefix));
}

function workspaceTagsFromResponse(
  tags: readonly z.infer<typeof asanaTagResponseSchema>[],
): readonly AsanaTag[] {
  const result: AsanaTag[] = [];
  const seenGids = new Set<string>();
  for (const tag of tags) {
    const parsed = asanaTagResponseSchema.parse(tag);
    if (seenGids.has(parsed.gid)) {
      throw new Error("ワークスペースタグGIDが重複しています。");
    }
    seenGids.add(parsed.gid);
    result.push(parsed);
  }
  return result;
}

function resolveWorkspaceTag(
  name: string,
  tags: readonly AsanaTag[],
): AsanaTag {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length !== 1) {
    throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
  }
  const match = matches[0];
  if (match == null) {
    throw new Error("対象タグをワークスペースタグへ解決できません。");
  }
  return match;
}

function importanceTagName(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("重要度が不正です。");
  }
  return `${importanceTagPrefix}${value}`;
}

function areaTagName(value: string): string {
  return `${areaTagPrefix}${value}`;
}

function parseBaselineExternal(
  external: BaselineExternalInput,
): { readonly response: ExternalResponse; readonly data: CustomExternalData } {
  const parsed = parseCustomExternalData(external.data);
  if (parsed.kind !== "valid") {
    throw new Error("baselineのCustom external dataがvalidではありません。");
  }
  customExternalDataSchema.parse(parsed.data);
  return {
    response: { gid: external.gid, data: external.data },
    data: parsed.data,
  };
}

function readCurrentExternal(task: AsanaTaskResponse): ExternalReadResult {
  if (task.external == null) {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  const ingestion = ingestAsanaExternalData(task);
  if (ingestion.kind === "identity_mismatch") {
    return { kind: "conflict", reason_code: "external_identity_mismatch" };
  }
  if (ingestion.kind !== "valid") {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  if (serializeCustomExternalData(ingestion.data) !== task.external.data) {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  return {
    kind: "valid",
    value: { response: task.external, data: ingestion.data },
  };
}

function sameExternalData(left: CustomExternalData, right: CustomExternalData): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

type ExpectedExternal = {
  readonly gid: string;
  readonly data: CustomExternalData;
};

type CategoryTagTransition =
  | {
      readonly kind: "operation";
      readonly prefix: string;
      readonly before_name: string;
      readonly after_name: string;
      readonly default_before: string | number;
      readonly before_value: string | number;
      readonly after_value: string | number;
    }
  | {
      readonly kind: "created_task";
      readonly prefix: string;
      readonly after_name: string;
    };

export type ProposalOperationCreatedTaskCallback = (
  operationId: string,
  taskGid: string,
) => void;
export type ProposalOperationRecoveryState = FieldClassification;
export type ProposalOperationRecoveryInspection = {
  readonly core_state: ProposalOperationRecoveryState;
  readonly metadata_state: ProposalOperationRecoveryState;
  readonly task: AsanaTaskResponse;
};
type CoreWriteResult =
  | { readonly kind: "completed"; readonly changed: boolean }
  | {
      readonly kind: "conflict";
      readonly side_effect: "none" | "possible";
      readonly reason_code?: WriterConflictReasonCode;
    };
type OperationWriteGuard = (
  task: AsanaTaskResponse,
) => WriterConflictReasonCode | undefined;

function classifyValue<T>(
  current: T,
  before: T,
  after: T,
  equal: (left: T, right: T) => boolean,
): FieldClassification {
  if (equal(current, before)) {
    return "before";
  }
  if (equal(current, after)) {
    return "after";
  }
  return "conflict";
}

function sameParentValue(left: ParentValue, right: ParentValue): boolean {
  return left === right;
}

function sameDueProposalValue(
  left: Extract<NonCreateOperation, { operation: "set_due" }>["before"],
  right: Extract<NonCreateOperation, { operation: "set_due" }>["before"],
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

type DurationOperationValue =
  | Extract<NonCreateOperation, { operation: "set_duration" }>["before"]
  | Extract<NonCreateOperation, { operation: "clear_duration" }>["after"];

function optionalDuration(value: DurationOperationValue): Duration | undefined {
  if ("kind" in value) {
    return undefined;
  }
  return value;
}

function sameDurationValue(left: Duration | undefined, right: Duration | undefined): boolean {
  if (left == null || right == null) {
    return left == null && right == null;
  }
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function operationUsesExternalData(operation: NonCreateOperation): boolean {
  switch (operation.operation) {
    case "complete":
    case "withdraw":
      return false;
    default:
      return true;
  }
}

function operationTarget(operation: NonCreateOperation): OperationTarget {
  return operation.target;
}

function statusForOperation(
  operation: NonCreateOperation,
): TaskStatusValue {
  switch (operation.operation) {
    case "set_status":
      return operation.after;
    case "complete":
      return "completed";
    case "withdraw":
      return "withdrawn";
    default:
      throw new Error("状態操作ではありません。");
  }
}

function statusBeforeForOperation(
  operation: NonCreateOperation,
): TaskStatusValue {
  switch (operation.operation) {
    case "set_status":
      return operation.before;
    case "complete":
    case "withdraw":
      return operation.before;
    default:
      throw new Error("状態操作ではありません。");
  }
}

function externalOperationAnchor(
  baseline: CustomExternalData,
  activityDate: string,
): CustomExternalDataMergeOperation {
  return {
    operation: "set_activity_anchor_on",
    before: baseline.activity_anchor_on,
    after: activityDate,
  };
}

function externalOperationsForOperation(
  operation: NonCreateOperation,
  baseline: CustomExternalData,
  mappings: ReadonlyMap<string, string>,
  activityDate: string,
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
      if (!sameDueProposalValue(operation.before, operation.after)) {
        operations.push(externalOperationAnchor(baseline, activityDate));
      }
      break;
    case "clear_due":
      operations.push(externalOperationAnchor(baseline, activityDate));
      break;
    case "set_duration":
    case "clear_duration": {
      const before = optionalDuration(operation.before);
      const after = optionalDuration(operation.after);
      if (!sameDurationValue(before, baseline.duration)) {
        throw new Error("所要時間操作のbaselineが一致しません。");
      }
      if (!sameDurationValue(before, after)) {
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
      const before = resolveDependencies(operation.before, mappings);
      const after = resolveDependencies(operation.after, mappings);
      if (!sameDependencies(before, baseline.dependencies)) {
        throw new Error("依存関係操作のbaselineが一致しません。");
      }
      if (!sameDependencies(before, after)) {
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
      const before = resolveParentGid(operation.before, mappings);
      const after = resolveParentGid(operation.after, mappings);
      if (!sameParentValue(before, after)) {
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
      const existing = findObsidianLink(baseline.obsidian_links, operation.after);
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
      const existing = findObsidianLink(baseline.obsidian_links, operation.before);
      if (existing == null || !sameObsidianLink(existing, operation.before)) {
        throw new Error("Obsidianリンク操作のbaselineが一致しません。");
      }
      operations.push({
        operation: "set_obsidian_links",
        before: baseline.obsidian_links,
        after: baseline.obsidian_links.filter(
          (link) => obsidianKey(link) !== obsidianKey(operation.before),
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

function classifyExternalMetadata(
  operation: NonCreateOperation,
  baseline: CustomExternalData,
  current: CustomExternalData,
  mappings: ReadonlyMap<string, string>,
  activityDate: string,
): FieldClassification {
  const operations = externalOperationsForOperation(
    operation,
    baseline,
    mappings,
    activityDate,
  );
  const states = operations.map((externalOperation): FieldClassification => {
    switch (externalOperation.operation) {
      case "set_dependencies":
        return classifyCollectionOperation(
          current.dependencies,
          externalOperation.before,
          externalOperation.after,
          (value) => value.task_gid,
        );
      case "set_obsidian_links":
        return classifyCollectionOperation(
          current.obsidian_links,
          externalOperation.before,
          externalOperation.after,
          obsidianKey,
        );
      case "set_last_active_status":
        return classifyValue(
          current.last_active_status,
          externalOperation.before,
          externalOperation.after,
          (left, right) => left === right,
        );
      case "set_parent_work_mode":
        return classifyValue(
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
        return classifyValue(
          current.duration,
          externalOperation.before,
          externalOperation.after,
          sameDurationValue,
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

function optionalWorkspaceTag(
  name: string,
  tags: readonly AsanaTag[],
): AsanaTag | undefined {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length > 1) {
    throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
  }
  return matches[0];
}

function classifyCategoryTags(
  task: AsanaTaskResponse,
  prefix: string,
  beforeName: string,
  afterName: string,
  defaultBefore: string | number,
  beforeValue: string | number,
  afterValue: string | number,
  tags: readonly AsanaTag[],
): FieldClassification {
  const current = categoryTags(task, prefix);
  const beforeTag = optionalWorkspaceTag(beforeName, tags);
  const afterTag = resolveWorkspaceTag(afterName, tags);
  const beforeIsDefault = beforeValue === defaultBefore && current.length === 0;
  const beforeTagIsExact = beforeTag != null
    && current.length === 1
    && current[0]?.gid === beforeTag.gid
    && current[0]?.name === beforeTag.name;
  const beforeExact = beforeIsDefault || beforeTagIsExact;
  const afterExact = current.length === 1
    && current[0]?.gid === afterTag.gid
    && current[0]?.name === afterTag.name;
  if (beforeValue === afterValue && beforeExact) {
    return "after";
  }
  if (afterExact) {
    return "after";
  }
  if (beforeExact) {
    return "before";
  }
  if (
    beforeTag != null
    && current.length === 2
    && current.some((tag) => tag.gid === beforeTag.gid && tag.name === beforeTag.name)
    && current.some((tag) => tag.gid === afterTag.gid && tag.name === afterTag.name)
  ) {
    return "partial";
  }
  return "conflict";
}

function classifyStatusOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGids: SectionGids,
): FieldClassification {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    return "conflict";
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    return "conflict";
  }
  const before = expectedStatus(statusBeforeForOperation(operation), sectionGids);
  const after = expectedStatus(statusForOperation(operation), sectionGids);
  const sectionGid = membership.section.gid;
  if (sectionGid === after.section_gid && task.completed === after.completed) {
    return "after";
  }
  if (sectionGid === before.section_gid && task.completed === before.completed) {
    return "before";
  }
  if (
    sectionGid === after.section_gid
    && task.completed === before.completed
    && before.completed !== after.completed
  ) {
    return "partial";
  }
  return "conflict";
}

function classifyOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGids: SectionGids,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[] | undefined,
): FieldClassification {
  switch (operation.operation) {
    case "update_title":
      return classifyValue(task.name, operation.before, operation.after, (left, right) => left === right);
    case "update_notes":
      return classifyValue(task.notes, operation.before, operation.after, (left, right) => left === right);
    case "set_status":
    case "complete":
    case "withdraw": {
      return classifyStatusOperation(operation, task, projectGid, sectionGids);
    }
    case "set_importance": {
      const workspaceTags = requireWorkspaceTags(tags);
      return classifyCategoryTags(
        task,
        importanceTagPrefix,
        importanceTagName(operation.before),
        importanceTagName(operation.after),
        3,
        operation.before,
        operation.after,
        workspaceTags,
      );
    }
    case "set_due": {
      const current = taskDueValue(task);
      return classifyValue(current, operation.before, operation.after, sameDueProposalValue);
    }
    case "clear_due": {
      const current = taskDueValue(task);
      return classifyValue(
        current,
        operation.before,
        { kind: "absent" },
        sameDueProposalValue,
      );
    }
    case "set_area": {
      const workspaceTags = requireWorkspaceTags(tags);
      return classifyCategoryTags(
        task,
        areaTagPrefix,
        areaTagName(operation.before),
        areaTagName(operation.after),
        unclassifiedArea,
        operation.before,
        operation.after,
        workspaceTags,
      );
    }
    case "set_parent": {
      const current = taskParentGid(task);
      const before = resolveParentGid(operation.before, mappings);
      const after = resolveParentGid(operation.after, mappings);
      return classifyValue(current, before, after, sameParentValue);
    }
    case "set_duration":
    case "clear_duration":
    case "set_dependencies":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
      return "after";
  }
  throw new Error("未対応のAsana操作です。");
}

function validateCurrentExternal(
  result: ExternalReadResult,
  baseline: { readonly response: ExternalResponse; readonly data: CustomExternalData },
): ExternalReadResult {
  if (result.kind === "conflict") {
    return result;
  }
  if (result.value.response.gid !== baseline.response.gid) {
    return { kind: "conflict", reason_code: "external_identity_mismatch" };
  }
  return result;
}

function mergeExternalPlan(
  baseline: { readonly response: ExternalResponse; readonly data: CustomExternalData },
  current: CurrentExternal,
  operations: readonly CustomExternalDataMergeOperation[],
  lastWriter: string,
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
    if (error instanceof CustomExternalDataCapacityError) {
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
      serialized: serializeCustomExternalData(result.data),
      write: result.kind === "merged",
    };
  } catch (error) {
    if (error instanceof CustomExternalDataCapacityError) {
      return { kind: "conflict", reason_code: "external_capacity_exceeded" };
    }
    throw error;
  }
}

function requireWorkspaceTags(tags: readonly AsanaTag[] | undefined): readonly AsanaTag[] {
  if (tags == null) {
    throw new Error("ワークスペースタグが必要です。");
  }
  return tags;
}

function createDueUpdate(
  due: Extract<NonCreateOperation, { operation: "set_due" }>["after"],
): AsanaTaskUpdate {
  switch (due.kind) {
    case "due_on":
      return { kind: "due_on", value: due.due_on };
    case "due_at":
      return { kind: "due_at", value: due.due_at };
  }
}

function createExternalState(
  input: WriterInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
): ExpectedExternal {
  const externalId = input.create_external_id;
  if (externalId == null) {
    throw new Error("create_taskには事前発行UUIDが必要です。");
  }
  const status = operation.after.status ?? "not_started";
  const initialized = createInitialCustomExternalData({
    id: externalId,
    activity_anchor_on: input.activity_date,
    last_active_status: status,
    device_id: input.device_id,
    created_via: input.created_via,
  });
  const parsed = parseCustomExternalData(initialized.data);
  if (parsed.kind !== "valid") {
    throw new Error("Custom external dataの初期化結果が不正です。");
  }
  const data = customExternalDataSchema.parse({
    ...parsed.data,
    parent_work_mode: operation.after.parent_work_mode ?? "unknown",
    dependencies: operation.after.dependencies == null
      ? []
      : resolveDependencies(operation.after.dependencies, mappings),
    obsidian_links: operation.after.obsidian_links ?? [],
    ...(operation.after.duration == null ? {} : { duration: operation.after.duration }),
  });
  return {
    gid: initialized.gid,
    data,
  };
}

function taskExternalMatches(
  task: AsanaTaskResponse,
  expected: ExpectedExternal,
): boolean {
  const current = readCurrentExternal(task);
  return current.kind === "valid"
    && current.value.response.gid === expected.gid
    && sameExternalData(current.value.data, expected.data);
}

function expectedExternalWriteGuard(expected: ExpectedExternal): OperationWriteGuard {
  return (task) => {
    const current = readCurrentExternal(task);
    if (current.kind === "conflict") {
      return current.reason_code;
    }
    if (current.value.response.gid !== expected.gid) {
      return "external_identity_mismatch";
    }
    return sameExternalData(current.value.data, expected.data)
      ? undefined
      : "merge_conflict";
  };
}

function classifyCreateCore(
  task: AsanaTaskResponse,
  input: WriterInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[],
): FieldClassification {
  if (
    !taskHasProject(task, input.project_gid)
    || task.name !== operation.after.title
    || task.notes !== (operation.after.notes ?? "")
    || !sameDueValue(
      taskDueValue(task),
      operation.after.due ?? { kind: "absent" },
    )
  ) {
    return "conflict";
  }
  const importTag = resolveWorkspaceTag(
    importanceTagName(operation.after.importance ?? 3),
    tags,
  );
  const areaTag = resolveWorkspaceTag(
    areaTagName(operation.after.area ?? unclassifiedArea),
    tags,
  );
  const importTags = categoryTags(task, importanceTagPrefix);
  const areaTags = categoryTags(task, areaTagPrefix);
  const importState: FieldClassification = importTags.length === 0
    ? "before"
    : importTags.length === 1
        && importTags[0]?.gid === importTag.gid
        && importTags[0]?.name === importTag.name
      ? "after"
      : "conflict";
  const areaState: FieldClassification = areaTags.length === 0
    ? "before"
    : areaTags.length === 1
        && areaTags[0]?.gid === areaTag.gid
        && areaTags[0]?.name === areaTag.name
      ? "after"
      : "conflict";
  const status = expectedStatus(
    operation.after.status ?? "not_started",
    input.section_gids,
  );
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === input.project_gid,
  );
  if (memberships.length > 1) {
    return "conflict";
  }
  const membership = memberships[0];
  let statusState: FieldClassification;
  if (membership == null) {
    statusState = task.completed ? "conflict" : "before";
  } else if (membership.section == null) {
    statusState = "conflict";
  } else if (
    membership.section.gid === status.section_gid
    && task.completed === status.completed
  ) {
    statusState = "after";
  } else if (
    membership.section.gid === status.section_gid
    && !task.completed
    && status.completed
  ) {
    statusState = "partial";
  } else if (
    membership.section.gid === input.section_gids.not_started
    && !task.completed
  ) {
    statusState = "before";
  } else {
    statusState = "conflict";
  }
  const expectedParent = operation.after.parent == null
    ? null
    : resolveTargetGid(operation.after.parent, mappings);
  const currentParent = taskParentGid(task);
  const parentState: FieldClassification = currentParent === expectedParent
    ? "after"
    : currentParent == null && expectedParent != null
      ? "before"
      : "conflict";
  const states = [importState, areaState, statusState, parentState];
  if (states.some((state) => state === "conflict")) {
    return "conflict";
  }
  if (states.every((state) => state === "after")) {
    return "after";
  }
  if (states.every((state) => state === "before")) {
    return "before";
  }
  return "partial";
}

async function fetchWorkspaceTags(
  readClient: AsanaReadClient,
  workspaceGid: string,
  signal: AbortSignal,
): Promise<readonly AsanaTag[]> {
  const tags = await readClient.listWorkspaceTags(workspaceGid, signal);
  return workspaceTagsFromResponse(tags);
}

function classifyCategoryTransition(
  task: AsanaTaskResponse,
  transition: CategoryTagTransition,
  tags: readonly AsanaTag[],
): FieldClassification {
  if (transition.kind === "operation") {
    return classifyCategoryTags(
      task,
      transition.prefix,
      transition.before_name,
      transition.after_name,
      transition.default_before,
      transition.before_value,
      transition.after_value,
      tags,
    );
  }
  const current = categoryTags(task, transition.prefix);
  const desired = resolveWorkspaceTag(transition.after_name, tags);
  if (
    current.length === 1
    && current[0]?.gid === desired.gid
    && current[0]?.name === desired.name
  ) {
    return "after";
  }
  return current.length === 0 ? "before" : "conflict";
}

async function applyCategoryTag(
  taskGid: string,
  transition: CategoryTagTransition,
  tags: readonly AsanaTag[],
  readClient: AsanaReadClient,
  writeClient: AsanaTaskWriteClient,
  beforeWrite: OperationWriteGuard,
  signal: AbortSignal,
): Promise<CoreWriteResult> {
  const desired = resolveWorkspaceTag(transition.after_name, tags);
  let changed = false;
  let current = parseTask(await readClient.getTask(taskGid, signal), taskGid);
  let state = classifyCategoryTransition(current, transition, tags);
  if (state === "conflict") {
    return { kind: "conflict", side_effect: "none" };
  }
  if (state === "after") {
    return { kind: "completed", changed };
  }
  const currentTags = categoryTags(current, transition.prefix);
  if (!currentTags.some((tag) => tag.gid === desired.gid && tag.name === desired.name)) {
    const guardReason = beforeWrite(current);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    await writeClient.addTaskTag(taskGid, desired.gid, signal);
    changed = true;
    current = parseTask(await readClient.getTask(taskGid, signal), taskGid);
    state = classifyCategoryTransition(current, transition, tags);
    if (state === "conflict" || state === "before") {
      return { kind: "conflict", side_effect: "possible" };
    }
    if (state === "after") {
      return { kind: "completed", changed };
    }
  }
  current = parseTask(await readClient.getTask(taskGid, signal), taskGid);
  state = classifyCategoryTransition(current, transition, tags);
  if (state === "after") {
    return { kind: "completed", changed };
  }
  if (state !== "partial") {
    return { kind: "conflict", side_effect: changed ? "possible" : "none" };
  }
  const obsolete = categoryTags(current, transition.prefix).filter(
    (tag) => tag.gid !== desired.gid,
  );
  for (const tag of obsolete) {
    current = parseTask(await readClient.getTask(taskGid, signal), taskGid);
    state = classifyCategoryTransition(current, transition, tags);
    if (state === "after") {
      return { kind: "completed", changed };
    }
    if (state !== "partial") {
      return { kind: "conflict", side_effect: changed ? "possible" : "none" };
    }
    const currentObsolete = categoryTags(current, transition.prefix).find(
      (candidate) => candidate.gid === tag.gid,
    );
    if (currentObsolete == null) {
      return { kind: "conflict", side_effect: changed ? "possible" : "none" };
    }
    const guardReason = beforeWrite(current);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    await writeClient.removeTaskTag(taskGid, currentObsolete.gid, signal);
    changed = true;
    current = parseTask(await readClient.getTask(taskGid, signal), taskGid);
    state = classifyCategoryTransition(current, transition, tags);
    if (state !== "after" && state !== "partial") {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  current = parseTask(await readClient.getTask(taskGid, signal), taskGid);
  return classifyCategoryTransition(current, transition, tags) === "after"
    ? { kind: "completed", changed }
    : { kind: "conflict", side_effect: changed ? "possible" : "none" };
}

function classifyStatusTransition(
  task: AsanaTaskResponse,
  projectGid: string,
  before: StatusDefinition,
  after: StatusDefinition,
  allowMissingMembership: boolean,
): FieldClassification {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length === 0 && allowMissingMembership && !task.completed) {
    return "before";
  }
  if (memberships.length !== 1) {
    return "conflict";
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    return "conflict";
  }
  const sectionGid = membership.section.gid;
  if (sectionGid === after.section_gid && task.completed === after.completed) {
    return "after";
  }
  if (sectionGid === before.section_gid && task.completed === before.completed) {
    return "before";
  }
  if (
    sectionGid === after.section_gid
    && task.completed === before.completed
    && before.completed !== after.completed
  ) {
    return "partial";
  }
  return "conflict";
}

async function applyStatus(
  taskGid: string,
  projectGid: string,
  before: StatusDefinition,
  after: StatusDefinition,
  allowMissingMembership: boolean,
  readClient: AsanaReadClient,
  writeClient: AsanaTaskWriteClient,
  beforeWrite: OperationWriteGuard,
  signal: AbortSignal,
): Promise<CoreWriteResult> {
  let changed = false;
  let task = parseTask(await readClient.getTask(taskGid, signal), taskGid);
  let state = classifyStatusTransition(
    task,
    projectGid,
    before,
    after,
    allowMissingMembership,
  );
  if (state === "conflict") {
    return { kind: "conflict", side_effect: "none" };
  }
  if (state === "after") {
    return { kind: "completed", changed };
  }
  const membership = taskProjectMembership(task, projectGid);
  if (membership == null || membership.section == null || membership.section.gid !== after.section_gid) {
    const guardReason = beforeWrite(task);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    if (membership == null) {
      await writeClient.addTaskToProject(
        taskGid,
        projectGid,
        after.section_gid,
        { kind: "none" },
        signal,
      );
    } else {
      await writeClient.addTaskToSection(
        taskGid,
        after.section_gid,
        { kind: "none" },
        signal,
      );
    }
    changed = true;
    task = parseTask(await readClient.getTask(taskGid, signal), taskGid);
    state = classifyStatusTransition(
      task,
      projectGid,
      before,
      after,
      allowMissingMembership,
    );
    if (state !== "partial" && state !== "after") {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  task = parseTask(await readClient.getTask(taskGid, signal), taskGid);
  state = classifyStatusTransition(
    task,
    projectGid,
    before,
    after,
    allowMissingMembership,
  );
  if (state === "after") {
    return { kind: "completed", changed };
  }
  if (state === "conflict" || (state === "before" && before.section_gid !== after.section_gid)) {
    return { kind: "conflict", side_effect: changed ? "possible" : "none" };
  }
  if (task.completed !== after.completed) {
    const guardReason = beforeWrite(task);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    await writeClient.updateTask(
      taskGid,
      { kind: "completed", value: after.completed },
      signal,
    );
    changed = true;
    task = parseTask(await readClient.getTask(taskGid, signal), taskGid);
    state = classifyStatusTransition(
      task,
      projectGid,
      before,
      after,
      allowMissingMembership,
    );
    if (state !== "after") {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  return { kind: "completed", changed };
}

async function applyNonCreateAsanaOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  input: WriterInput,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[] | undefined,
  readClient: AsanaReadClient,
  writeClient: AsanaTaskWriteClient,
  beforeWrite: OperationWriteGuard,
  signal: AbortSignal,
): Promise<CoreWriteResult> {
  switch (operation.operation) {
    case "update_title":
      if (task.name === operation.after) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      await writeClient.updateTask(task.gid, { kind: "title", value: operation.after }, signal);
      return { kind: "completed", changed: true };
    case "update_notes":
      if (task.notes === operation.after) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      await writeClient.updateTask(task.gid, { kind: "notes", value: operation.after }, signal);
      return { kind: "completed", changed: true };
    case "set_status":
    case "complete":
    case "withdraw": {
      const before = expectedStatus(
        statusBeforeForOperation(operation),
        input.section_gids,
      );
      const after = expectedStatus(statusForOperation(operation), input.section_gids);
      return applyStatus(
        task.gid,
        input.project_gid,
        before,
        after,
        false,
        readClient,
        writeClient,
        beforeWrite,
        signal,
      );
    }
    case "set_importance": {
      const workspaceTags = requireWorkspaceTags(tags);
      return applyCategoryTag(
        task.gid,
        {
          kind: "operation",
          prefix: importanceTagPrefix,
          before_name: importanceTagName(operation.before),
          after_name: importanceTagName(operation.after),
          default_before: 3,
          before_value: operation.before,
          after_value: operation.after,
        },
        workspaceTags,
        readClient,
        writeClient,
        beforeWrite,
        signal,
      );
    }
    case "set_due": {
      const current = taskDueValue(task);
      if (sameDueValue(current, operation.after)) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      await writeClient.updateTask(task.gid, createDueUpdate(operation.after), signal);
      return { kind: "completed", changed: true };
    }
    case "clear_due":
      if (taskDueValue(task).kind === "absent") {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      await writeClient.updateTask(task.gid, { kind: "clear_due" }, signal);
      return { kind: "completed", changed: true };
    case "set_area": {
      const workspaceTags = requireWorkspaceTags(tags);
      return applyCategoryTag(
        task.gid,
        {
          kind: "operation",
          prefix: areaTagPrefix,
          before_name: areaTagName(operation.before),
          after_name: areaTagName(operation.after),
          default_before: unclassifiedArea,
          before_value: operation.before,
          after_value: operation.after,
        },
        workspaceTags,
        readClient,
        writeClient,
        beforeWrite,
        signal,
      );
    }
    case "set_dependencies":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
    case "set_duration":
    case "clear_duration":
      return { kind: "completed", changed: false };
    case "set_parent": {
      const current = taskParentGid(task);
      const desired = resolveParentGid(operation.after, mappings);
      if (current === desired) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      if (desired == null) {
        await writeClient.clearTaskParent(task.gid, signal);
      } else {
        await writeClient.setTaskParent(task.gid, desired, signal);
      }
      return { kind: "completed", changed: true };
    }
  }
  throw new Error("未対応のAsana操作です。");
}

function externalConflictResult(
  operationId: string,
  taskGid: string,
  reasonCode: "external_unreadable" | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded",
  sideEffect: "none" | "possible",
): WriterResult {
  return createConflictResult(operationId, taskGid, reasonCode, sideEffect);
}

/** 承認済みAI変更操作をAsanaへ適用します。 */
export class AsanaProposalOperationWriter {
  private readonly readClient: AsanaReadClient;
  private readonly writeClient: AsanaTaskWriteClient;

  public constructor(
    readClient: AsanaReadClient,
    writeClient: AsanaTaskWriteClient,
  ) {
    this.readClient = readClient;
    this.writeClient = writeClient;
  }

  /** 承認済みの単一AI変更操作を適用します。 */
  public async apply(
    input: WriterInput,
    signal: AbortSignal,
  ): Promise<WriterResult> {
    return this.applyInternal(input, signal, () => {});
  }

  /** 作成タスクのGIDを外部属性更新前に通知して操作を適用します。 */
  public async applyWithCreateTaskCallback(
    input: WriterInput,
    signal: AbortSignal,
    onCreateTaskCreated: ProposalOperationCreatedTaskCallback,
  ): Promise<WriterResult> {
    if (typeof onCreateTaskCreated !== "function") {
      throw new TypeError("作成タスクGID通知コールバックが必要です。");
    }
    return this.applyInternal(input, signal, onCreateTaskCreated);
  }

  /** 作成操作から承認済みの初期Custom external dataを再構成します。 */
  public createInitialExternalBaseline(input: WriterInput): BaselineExternalInput {
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    if (validatedInput.operation.operation !== "create_task") {
      throw new Error("create_task以外から初期Custom external dataを再構成できません。");
    }
    const expected = createExternalState(
      validatedInput,
      validatedInput.operation,
      createMappingMap(validatedInput.temporary_ref_to_gid),
    );
    return {
      gid: expected.gid,
      data: serializeCustomExternalData(expected.data),
    };
  }

  /** 保存済み復旧計画の外部状態を読み取り、操作前後を判定します。 */
  public async inspectRecovery(
    input: WriterInput,
    signal: AbortSignal,
  ): Promise<ProposalOperationRecoveryInspection> {
    validateAbortSignal(signal);
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    const mappings = createMappingMap(validatedInput.temporary_ref_to_gid);
    if (validatedInput.operation.operation === "create_task") {
      if (validatedInput.existing_task == null) {
        throw new Error("create_taskの復旧対象タスクがありません。");
      }
      const task = parseTask(validatedInput.existing_task, undefined);
      const expectedExternal = createExternalState(
        validatedInput,
        validatedInput.operation,
        mappings,
      );
      const tags = await fetchWorkspaceTags(
        this.readClient,
        validatedInput.workspace_gid,
        signal,
      );
      return {
        core_state: classifyCreateCore(
          task,
          validatedInput,
          validatedInput.operation,
          mappings,
          tags,
        ),
        metadata_state: taskExternalMatches(task, expectedExternal)
          ? "after"
          : "conflict",
        task,
      };
    }
    const taskGid = resolveTargetGid(
      operationTarget(validatedInput.operation),
      mappings,
    );
    const task = parseTask(
      await this.readClient.getTask(taskGid, signal),
      taskGid,
    );
    if (!taskHasProject(task, validatedInput.project_gid)) {
      return { core_state: "conflict", metadata_state: "conflict", task };
    }
    const baselineExternal = validatedInput.baseline_external_data == null
      ? undefined
      : parseBaselineExternal(validatedInput.baseline_external_data);
    if (operationUsesExternalData(validatedInput.operation) && baselineExternal == null) {
      throw new Error("この操作にはbaseline外部データが必要です。");
    }
    let currentExternal: CurrentExternal | undefined;
    let metadataState: FieldClassification = "after";
    if (operationUsesExternalData(validatedInput.operation)) {
      if (baselineExternal == null) {
        throw new Error("この操作にはbaseline外部データが必要です。");
      }
      const currentExternalResult = validateCurrentExternal(
        readCurrentExternal(task),
        baselineExternal,
      );
      if (currentExternalResult.kind === "conflict") {
        metadataState = "conflict";
      } else {
        currentExternal = currentExternalResult.value;
        metadataState = classifyExternalMetadata(
          validatedInput.operation,
          baselineExternal.data,
          currentExternal.data,
          mappings,
          validatedInput.activity_date,
        );
      }
    }
    const requiresTags = validatedInput.operation.operation === "set_importance"
      || validatedInput.operation.operation === "set_area";
    const tags = requiresTags
      ? await fetchWorkspaceTags(this.readClient, validatedInput.workspace_gid, signal)
      : undefined;
    const classification = classifyOperation(
      validatedInput.operation,
      task,
      validatedInput.project_gid,
      validatedInput.section_gids,
      mappings,
      tags,
    );
    return {
      core_state: classification,
      metadata_state: metadataState,
      task,
    };
  }

  private async applyInternal(
    input: WriterInput,
    signal: AbortSignal,
    onCreateTaskCreated: ProposalOperationCreatedTaskCallback,
  ): Promise<WriterResult> {
    validateAbortSignal(signal);
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    const mappings = createMappingMap(validatedInput.temporary_ref_to_gid);
    if (validatedInput.operation.operation === "create_task") {
      return this.applyCreate(validatedInput, mappings, signal, onCreateTaskCreated);
    }
    return this.applyNonCreate(validatedInput, mappings, signal);
  }

  private async applyCreate(
    input: WriterInput,
    mappings: ReadonlyMap<string, string>,
    signal: AbortSignal,
    onCreateTaskCreated: ProposalOperationCreatedTaskCallback,
  ): Promise<WriterResult> {
    if (input.operation.operation !== "create_task") {
      throw new Error("create_task以外の操作を作成処理へ渡せません。");
    }
    const operation = input.operation;
    const expectedExternal = createExternalState(input, operation, mappings);
    const tags = await fetchWorkspaceTags(this.readClient, input.workspace_gid, signal);
    if (input.existing_task != null) {
      const existing = parseTask(input.existing_task, undefined);
      const currentExternal = readCurrentExternal(existing);
      if (currentExternal.kind === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          existing.gid,
          currentExternal.reason_code,
          "possible",
        );
      }
      if (currentExternal.value.response.gid !== expectedExternal.gid) {
        return externalConflictResult(
          operation.operation_id,
          existing.gid,
          "external_identity_mismatch",
          "possible",
        );
      }
      if (!taskExternalMatches(existing, expectedExternal)) {
        return createConflictResult(
          operation.operation_id,
          existing.gid,
          "read_back_mismatch",
          "possible",
        );
      }
      const coreState = classifyCreateCore(existing, input, operation, mappings, tags);
      if (coreState === "conflict") {
        return createConflictResult(
          operation.operation_id,
          existing.gid,
          "read_back_mismatch",
          "possible",
        );
      }
      if (coreState === "after") {
        return createResult(operation.operation_id, existing.gid, "already_applied", "already_applied");
      }
      const attributes = await this.applyCreateAttributes(
        existing.gid,
        input,
        operation,
        mappings,
        tags,
        expectedExternalWriteGuard(expectedExternal),
        signal,
      );
      if (attributes.kind === "conflict") {
        return createConflictResult(
          operation.operation_id,
          existing.gid,
          "read_back_mismatch",
          "possible",
        );
      }
      const readBack = parseTask(
        await this.readClient.getTask(existing.gid, signal),
        existing.gid,
      );
      if (
        classifyCreateCore(readBack, input, operation, mappings, tags) !== "after"
        || !taskExternalMatches(readBack, expectedExternal)
      ) {
        return createConflictResult(
          operation.operation_id,
          existing.gid,
          "read_back_mismatch",
          "possible",
        );
      }
      return createResult(operation.operation_id, existing.gid, "applied", "applied");
    }

    const creationInput: AsanaTaskCreationInput = {
      project_gid: input.project_gid,
      title: operation.after.title,
      completed: false,
      external: {
        gid: expectedExternal.gid,
        data: serializeCustomExternalData(expectedExternal.data),
      },
      ...(operation.after.notes != null ? { notes: operation.after.notes } : {}),
      ...(operation.after.due?.kind === "due_on"
        ? { due_on: operation.after.due.due_on }
        : {}),
      ...(operation.after.due?.kind === "due_at"
        ? { due_at: operation.after.due.due_at }
        : {}),
    };
    const createdTaskReference = await this.writeClient.createTask(
      creationInput,
      signal,
    );
    onCreateTaskCreated(operation.operation_id, createdTaskReference.gid);
    const created = parseTask(
      await this.readClient.getTask(createdTaskReference.gid, signal),
      createdTaskReference.gid,
    );
    const createdExternal = readCurrentExternal(created);
    if (createdExternal.kind === "conflict") {
      return externalConflictResult(
        operation.operation_id,
        created.gid,
        createdExternal.reason_code,
        "possible",
      );
    }
    if (createdExternal.value.response.gid !== expectedExternal.gid) {
      return externalConflictResult(
        operation.operation_id,
        created.gid,
        "external_identity_mismatch",
        "possible",
      );
    }
    const attributes = await this.applyCreateAttributes(
      created.gid,
      input,
      operation,
      mappings,
      tags,
      expectedExternalWriteGuard(expectedExternal),
      signal,
    );
    if (attributes.kind === "conflict") {
      return createConflictResult(
        operation.operation_id,
        created.gid,
        "read_back_mismatch",
        "possible",
      );
    }
    const readBack = parseTask(
      await this.readClient.getTask(created.gid, signal),
      created.gid,
    );
    if (
      classifyCreateCore(readBack, input, operation, mappings, tags) !== "after"
      || !taskExternalMatches(readBack, expectedExternal)
    ) {
      return createConflictResult(
        operation.operation_id,
        created.gid,
        "read_back_mismatch",
        "possible",
      );
    }
    return createResult(
      operation.operation_id,
      created.gid,
      "applied",
      "applied",
    );
  }

  private async applyCreateAttributes(
    taskGid: string,
    input: WriterInput,
    operation: CreateOperation,
    mappings: ReadonlyMap<string, string>,
    tags: readonly AsanaTag[],
    beforeWrite: OperationWriteGuard,
    signal: AbortSignal,
  ): Promise<CoreWriteResult> {
    let task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
    if (classifyCreateCore(task, input, operation, mappings, tags) === "conflict") {
      return { kind: "conflict", side_effect: "none" };
    }
    let changed = false;
    const importanceResult = await applyCategoryTag(
      taskGid,
      {
        kind: "created_task",
        prefix: importanceTagPrefix,
        after_name: importanceTagName(operation.after.importance ?? 3),
      },
      tags,
      this.readClient,
      this.writeClient,
      beforeWrite,
      signal,
    );
    if (importanceResult.kind === "conflict") {
      return {
        kind: "conflict",
        side_effect: importanceResult.side_effect === "possible" || changed
          ? "possible"
          : "none",
      };
    }
    changed = changed || importanceResult.changed;
    const areaResult = await applyCategoryTag(
      taskGid,
      {
        kind: "created_task",
        prefix: areaTagPrefix,
        after_name: areaTagName(operation.after.area ?? unclassifiedArea),
      },
      tags,
      this.readClient,
      this.writeClient,
      beforeWrite,
      signal,
    );
    if (areaResult.kind === "conflict") {
      return {
        kind: "conflict",
        side_effect: areaResult.side_effect === "possible" || changed
          ? "possible"
          : "none",
      };
    }
    changed = changed || areaResult.changed;
    const statusResult = await applyStatus(
      taskGid,
      input.project_gid,
      expectedStatus("not_started", input.section_gids),
      expectedStatus(operation.after.status ?? "not_started", input.section_gids),
      true,
      this.readClient,
      this.writeClient,
      beforeWrite,
      signal,
    );
    if (statusResult.kind === "conflict") {
      return {
        kind: "conflict",
        side_effect: statusResult.side_effect === "possible" || changed
          ? "possible"
          : "none",
      };
    }
    changed = changed || statusResult.changed;
    const desiredParent = operation.after.parent == null
      ? null
      : resolveTargetGid(operation.after.parent, mappings);
    task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
    const currentParent = taskParentGid(task);
    if (currentParent !== desiredParent) {
      if (currentParent != null || desiredParent == null) {
        return {
          kind: "conflict",
          side_effect: changed ? "possible" : "none",
        };
      }
      const guardReason = beforeWrite(task);
      if (guardReason != null) {
        return {
          kind: "conflict",
          side_effect: changed ? "possible" : "none",
          reason_code: guardReason,
        };
      }
      await this.writeClient.setTaskParent(taskGid, desiredParent, signal);
      changed = true;
      task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
      if (taskParentGid(task) !== desiredParent) {
        return { kind: "conflict", side_effect: "possible" };
      }
    }
    return { kind: "completed", changed };
  }

  private async applyNonCreate(
    input: WriterInput,
    mappings: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<WriterResult> {
    if (input.operation.operation === "create_task") {
      throw new Error("create_taskを非作成処理へ渡せません。");
    }
    const operation = input.operation;
    const taskGid = resolveTargetGid(operationTarget(operation), mappings);
    let task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
    if (!taskHasProject(task, input.project_gid)) {
      return createConflictResult(
        operation.operation_id,
        taskGid,
        "baseline_changed",
        "none",
      );
    }
    const baselineExternalInput = input.baseline_external_data;
    const baselineExternal = baselineExternalInput == null
      ? undefined
      : parseBaselineExternal(baselineExternalInput);
    if (operationUsesExternalData(operation) && baselineExternal == null) {
      throw new Error("この操作にはbaseline外部データが必要です。");
    }
    const tags = operation.operation === "set_importance" || operation.operation === "set_area"
      ? await fetchWorkspaceTags(this.readClient, input.workspace_gid, signal)
      : undefined;
    let coreState = classifyOperation(
      operation,
      task,
      input.project_gid,
      input.section_gids,
      mappings,
      tags,
    );
    if (coreState === "conflict") {
      return createConflictResult(
        operation.operation_id,
        taskGid,
        "baseline_changed",
        "none",
      );
    }
    const externalOperations = baselineExternal == null
      ? []
      : externalOperationsForOperation(
          operation,
          baselineExternal.data,
          mappings,
          input.activity_date,
        );
    let initialMetadataState: FieldClassification = "after";
    if (operationUsesExternalData(operation)) {
      if (baselineExternal == null) {
        throw new Error("この操作にはbaseline外部データが必要です。");
      }
      const initialExternalResult = validateCurrentExternal(
        readCurrentExternal(task),
        baselineExternal,
      );
      if (initialExternalResult.kind === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          initialExternalResult.reason_code,
          "none",
        );
      }
      initialMetadataState = classifyExternalMetadata(
        operation,
        baselineExternal.data,
        initialExternalResult.value.data,
        mappings,
        input.activity_date,
      );
      if (initialMetadataState === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          "merge_conflict",
          "none",
        );
      }
    }
    if (coreState === "after" && initialMetadataState === "after") {
      return createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
    }
    const beforeCoreWrite: OperationWriteGuard = (currentTask) => {
      if (!taskHasProject(currentTask, input.project_gid)) {
        return "baseline_changed";
      }
      if (!operationUsesExternalData(operation)) {
        return undefined;
      }
      if (baselineExternal == null) {
        throw new Error("この操作にはbaseline外部データが必要です。");
      }
      const currentExternalResult = validateCurrentExternal(
        readCurrentExternal(currentTask),
        baselineExternal,
      );
      if (currentExternalResult.kind === "conflict") {
        return currentExternalResult.reason_code;
      }
      return classifyExternalMetadata(
        operation,
        baselineExternal.data,
        currentExternalResult.value.data,
        mappings,
        input.activity_date,
      ) === "conflict"
        ? "merge_conflict"
        : undefined;
    };
    let asanaChanged = false;
    let externalChanged = false;
    if (coreState !== "after") {
      task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
      if (!taskHasProject(task, input.project_gid)) {
        return createConflictResult(
          operation.operation_id,
          taskGid,
          "baseline_changed",
          "none",
        );
      }
      coreState = classifyOperation(
        operation,
        task,
        input.project_gid,
        input.section_gids,
        mappings,
        tags,
      );
      if (coreState === "conflict") {
        return createConflictResult(
          operation.operation_id,
          taskGid,
          "baseline_changed",
          "none",
        );
      }
      if (coreState !== "after") {
        const guardReason = beforeCoreWrite(task);
        if (guardReason != null) {
          if (
            guardReason === "external_unreadable"
            || guardReason === "external_identity_mismatch"
            || guardReason === "merge_conflict"
          ) {
            return externalConflictResult(
              operation.operation_id,
              taskGid,
              guardReason,
              "none",
            );
          }
          return createConflictResult(
            operation.operation_id,
            taskGid,
            guardReason,
            "none",
          );
        }
        const coreResult = await applyNonCreateAsanaOperation(
          operation,
          task,
          input,
          mappings,
          tags,
          this.readClient,
          this.writeClient,
          beforeCoreWrite,
          signal,
        );
        if (coreResult.kind === "conflict") {
          if (
            coreResult.reason_code === "external_unreadable"
            || coreResult.reason_code === "external_identity_mismatch"
            || coreResult.reason_code === "merge_conflict"
          ) {
            return externalConflictResult(
              operation.operation_id,
              taskGid,
              coreResult.reason_code,
              coreResult.side_effect,
            );
          }
          return createConflictResult(
            operation.operation_id,
            taskGid,
            coreResult.reason_code ?? "baseline_changed",
            coreResult.side_effect,
          );
        }
        asanaChanged = coreResult.changed;
        coreState = "after";
      }
    }

    if (externalOperations.length > 0) {
      if (baselineExternal == null) {
        throw new Error("Custom external dataのbaselineがありません。");
      }
      task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
      const latestExternalResult = validateCurrentExternal(
        readCurrentExternal(task),
        baselineExternal,
      );
      if (latestExternalResult.kind === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          latestExternalResult.reason_code,
          asanaChanged ? "possible" : "none",
        );
      }
      let metadataState = classifyExternalMetadata(
        operation,
        baselineExternal.data,
        latestExternalResult.value.data,
        mappings,
        input.activity_date,
      );
      if (metadataState === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          "merge_conflict",
          asanaChanged ? "possible" : "none",
        );
      }
      if (metadataState === "after" && coreState === "after" && !asanaChanged) {
        return createResult(
          operation.operation_id,
          taskGid,
          "already_applied",
          "already_applied",
        );
      }
      if (metadataState !== "after") {
        task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
        const beforeWriteExternalResult = validateCurrentExternal(
          readCurrentExternal(task),
          baselineExternal,
        );
        if (beforeWriteExternalResult.kind === "conflict") {
          return externalConflictResult(
            operation.operation_id,
            taskGid,
            beforeWriteExternalResult.reason_code,
            asanaChanged ? "possible" : "none",
          );
        }
        metadataState = classifyExternalMetadata(
          operation,
          baselineExternal.data,
          beforeWriteExternalResult.value.data,
          mappings,
          input.activity_date,
        );
        if (metadataState === "conflict") {
          return externalConflictResult(
            operation.operation_id,
            taskGid,
            "merge_conflict",
            asanaChanged ? "possible" : "none",
          );
        }
        if (metadataState !== "after") {
          if (!taskHasProject(task, input.project_gid)) {
            return createConflictResult(
              operation.operation_id,
              taskGid,
              "baseline_changed",
              asanaChanged ? "possible" : "none",
            );
          }
          const coreStateBeforeExternal = classifyOperation(
            operation,
            task,
            input.project_gid,
            input.section_gids,
            mappings,
            tags,
          );
          if (coreStateBeforeExternal !== "after") {
            return createConflictResult(
              operation.operation_id,
              taskGid,
              "read_back_mismatch",
              asanaChanged ? "possible" : "none",
            );
          }
          const externalPlan = mergeExternalPlan(
            baselineExternal,
            beforeWriteExternalResult.value,
            externalOperations,
            input.device_id,
          );
          if (externalPlan.kind === "conflict") {
            return externalConflictResult(
              operation.operation_id,
              taskGid,
              externalPlan.reason_code,
              asanaChanged ? "possible" : "none",
            );
          }
          if (externalPlan.kind !== "ready") {
            throw new Error("Custom external dataのマージ結果がありません。");
          }
          if (externalPlan.write) {
            await this.writeClient.updateTask(
              taskGid,
              {
                kind: "external",
                value: {
                  gid: beforeWriteExternalResult.value.response.gid,
                  data: externalPlan.serialized,
                },
              },
              signal,
            );
            externalChanged = true;
          }
        }
      }
    }
    if (!asanaChanged && !externalChanged && coreState === "after") {
      return createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
    }

    task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
    const readBackCoreState = classifyOperation(
      operation,
      task,
      input.project_gid,
      input.section_gids,
      mappings,
      tags,
    );
    if (readBackCoreState !== "after") {
      return createConflictResult(
        operation.operation_id,
        taskGid,
        "read_back_mismatch",
        "possible",
      );
    }
    if (operationUsesExternalData(operation)) {
      if (baselineExternal == null) {
        throw new Error("この操作にはbaseline外部データが必要です。");
      }
      const readBackExternal = validateCurrentExternal(
        readCurrentExternal(task),
        baselineExternal,
      );
      if (readBackExternal.kind === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          readBackExternal.reason_code,
          "possible",
        );
      }
      const readBackMetadataState = classifyExternalMetadata(
        operation,
        baselineExternal.data,
        readBackExternal.value.data,
        mappings,
        input.activity_date,
      );
      if (readBackMetadataState !== "after") {
        return createConflictResult(
          operation.operation_id,
          taskGid,
          "read_back_mismatch",
          "possible",
        );
      }
    }
    if (!asanaChanged && !externalChanged && coreState === "after") {
      return createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
    }
    return createResult(operation.operation_id, taskGid, "applied", "applied");
  }
}
