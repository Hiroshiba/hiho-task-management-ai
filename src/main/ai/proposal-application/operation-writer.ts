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
type FieldClassification = "before" | "after" | "conflict";
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
  outcome: WriterResult["outcome"],
  reasonCode: WriterResult["reason_code"],
): WriterResult {
  return asanaProposalOperationWriterResultSchema.parse({
    operation_id: operationId,
    task_gid: taskGid,
    outcome,
    reason_code: reasonCode,
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

function statusDefinitionForTask(
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGids: SectionGids,
): StatusDefinition {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    throw new Error("対象タスクの専用プロジェクト所属を一意に確認できません。");
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    throw new Error("対象タスクの状態セクションを確認できません。");
  }
  const status = [
    expectedStatus("not_started", sectionGids),
    expectedStatus("in_progress", sectionGids),
    expectedStatus("completed", sectionGids),
    expectedStatus("withdrawn", sectionGids),
  ].find((definition) => definition.section_gid === membership.section?.gid);
  if (status == null) {
    throw new Error("対象タスクの状態セクションが不正です。");
  }
  if (status.completed !== task.completed) {
    throw new Error("対象タスクの状態セクションと完了フラグが一致しません。");
  }
  return status;
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

function importanceValueFromTag(tag: AsanaTag): number {
  switch (tag.name) {
    case "TaskHub/重要度/1":
      return 1;
    case "TaskHub/重要度/2":
      return 2;
    case "TaskHub/重要度/3":
      return 3;
    case "TaskHub/重要度/4":
      return 4;
    case "TaskHub/重要度/5":
      return 5;
    default:
      throw new Error("重要度タグ名が不正です。");
  }
}

function taskImportance(task: AsanaTaskResponse): number {
  const tags = categoryTags(task, importanceTagPrefix);
  if (tags.length === 0) {
    return 3;
  }
  return Math.max(...tags.map(importanceValueFromTag));
}

function taskArea(task: AsanaTaskResponse): string {
  const tags = categoryTags(task, areaTagPrefix);
  if (tags.length !== 1) {
    return unclassifiedArea;
  }
  const tag = tags[0];
  if (tag == null) {
    return unclassifiedArea;
  }
  const area = tag.name.slice(areaTagPrefix.length);
  if (area.trim().length === 0) {
    throw new Error("領域タグ名が不正です。");
  }
  return area;
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

type CategoryTagPlan = {
  readonly tag: AsanaTag;
  readonly remove: readonly AsanaTag[];
  readonly add: boolean;
};

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

function classifyOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  external: CustomExternalData | undefined,
  projectGid: string,
  sectionGids: SectionGids,
  mappings: ReadonlyMap<string, string>,
): FieldClassification {
  switch (operation.operation) {
    case "update_title":
      return classifyValue(task.name, operation.before, operation.after, (left, right) => left === right);
    case "update_notes":
      return classifyValue(task.notes, operation.before, operation.after, (left, right) => left === right);
    case "set_status":
    case "complete":
    case "withdraw": {
      const current = statusDefinitionForTask(task, projectGid, sectionGids).status;
      return classifyValue(
        current,
        statusBeforeForOperation(operation),
        statusForOperation(operation),
        (left, right) => left === right,
      );
    }
    case "set_importance":
      return classifyValue(taskImportance(task), operation.before, operation.after, (left, right) => left === right);
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
    case "set_area":
      return classifyValue(taskArea(task), operation.before, operation.after, (left, right) => left === right);
    case "set_dependencies": {
      if (external == null) {
        throw new Error("依存関係操作にはCustom external dataが必要です。");
      }
      const before = resolveDependencies(operation.before, mappings);
      const after = resolveDependencies(operation.after, mappings);
      return classifyValue(external.dependencies, before, after, sameDependencies);
    }
    case "set_parent": {
      const current = taskParentGid(task);
      const before = resolveParentGid(operation.before, mappings);
      const after = resolveParentGid(operation.after, mappings);
      return classifyValue(current, before, after, sameParentValue);
    }
    case "set_parent_work_mode": {
      if (external == null) {
        throw new Error("親作業モード操作にはCustom external dataが必要です。");
      }
      return classifyValue(
        external.parent_work_mode,
        operation.before,
        operation.after,
        (left, right) => left === right,
      );
    }
    case "link_obsidian": {
      if (external == null) {
        throw new Error("Obsidianリンク操作にはCustom external dataが必要です。");
      }
      const current = findObsidianLink(external.obsidian_links, operation.after);
      if (current == null) {
        return "before";
      }
      return sameObsidianLink(current, operation.after) ? "after" : "conflict";
    }
    case "unlink_obsidian": {
      if (external == null) {
        throw new Error("Obsidianリンク操作にはCustom external dataが必要です。");
      }
      const current = findObsidianLink(external.obsidian_links, operation.before);
      if (current == null) {
        return "after";
      }
      return sameObsidianLink(current, operation.before) ? "before" : "conflict";
    }
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

function categoryTagPlan(
  task: AsanaTaskResponse,
  prefix: string,
  desired: AsanaTag,
): CategoryTagPlan {
  const current = categoryTags(task, prefix);
  const existing = current.find((tag) => tag.gid === desired.gid && tag.name === desired.name);
  if (existing == null) {
    return { tag: desired, remove: current, add: true };
  }
  return {
    tag: desired,
    remove: current.filter((tag) => tag.gid !== desired.gid),
    add: false,
  };
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
  });
  return {
    gid: initialized.gid,
    data,
  };
}

function taskCategoryMatches(
  task: AsanaTaskResponse,
  prefix: string,
  desired: AsanaTag,
): boolean {
  const current = categoryTags(task, prefix);
  if (current.length !== 1) {
    return false;
  }
  const tag = current[0];
  return tag != null && tag.gid === desired.gid && tag.name === desired.name;
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

function taskMatchesCreate(
  task: AsanaTaskResponse,
  input: WriterInput,
  operation: CreateOperation,
  expectedExternal: ExpectedExternal,
  tags: readonly AsanaTag[],
): boolean {
  if (!taskHasProject(task, input.project_gid)) {
    return false;
  }
  if (task.name !== operation.after.title) {
    return false;
  }
  if (task.notes !== (operation.after.notes ?? "")) {
    return false;
  }
  const expectedDue = operation.after.due ?? { kind: "absent" };
  if (!sameDueValue(taskDueValue(task), expectedDue)) {
    return false;
  }
  const expectedStatusDefinition = expectedStatus(
    operation.after.status ?? "not_started",
    input.section_gids,
  );
  const currentStatus = statusDefinitionForTask(task, input.project_gid, input.section_gids);
  if (
    currentStatus.status !== expectedStatusDefinition.status
    || currentStatus.section_gid !== expectedStatusDefinition.section_gid
    || currentStatus.completed !== expectedStatusDefinition.completed
  ) {
    return false;
  }
  const workspaceTag = resolveWorkspaceTag(
    importanceTagName(operation.after.importance ?? 3),
    tags,
  );
  if (!taskCategoryMatches(task, importanceTagPrefix, workspaceTag)) {
    return false;
  }
  const areaTag = resolveWorkspaceTag(
    areaTagName(operation.after.area ?? unclassifiedArea),
    tags,
  );
  if (!taskCategoryMatches(task, areaTagPrefix, areaTag)) {
    return false;
  }
  const expectedParent = operation.after.parent == null
    ? null
    : resolveTargetGid(operation.after.parent, createMappingMap(input.temporary_ref_to_gid));
  if (taskParentGid(task) !== expectedParent) {
    return false;
  }
  return taskExternalMatches(task, expectedExternal);
}

function verifyExternal(
  task: AsanaTaskResponse,
  expected: ExpectedExternal | undefined,
): boolean {
  if (expected == null) {
    return true;
  }
  return taskExternalMatches(task, expected);
}

function verifyOperationAfter(
  task: AsanaTaskResponse,
  operation: NonCreateOperation,
  input: WriterInput,
  mappings: ReadonlyMap<string, string>,
  expectedExternal: ExpectedExternal | undefined,
  tags: readonly AsanaTag[] | undefined,
): boolean {
  if (!taskHasProject(task, input.project_gid)) {
    return false;
  }
  switch (operation.operation) {
    case "update_title":
      if (task.name !== operation.after) {
        return false;
      }
      break;
    case "update_notes":
      if (task.notes !== operation.after) {
        return false;
      }
      break;
    case "set_status":
    case "complete":
    case "withdraw": {
      const current = statusDefinitionForTask(task, input.project_gid, input.section_gids);
      if (current.status !== statusForOperation(operation)) {
        return false;
      }
      break;
    }
    case "set_importance": {
      const workspaceTags = requireWorkspaceTags(tags);
      const desired = resolveWorkspaceTag(importanceTagName(operation.after), workspaceTags);
      if (!taskCategoryMatches(task, importanceTagPrefix, desired)) {
        return false;
      }
      break;
    }
    case "set_due":
      if (!sameDueValue(taskDueValue(task), operation.after)) {
        return false;
      }
      break;
    case "clear_due":
      if (taskDueValue(task).kind !== "absent") {
        return false;
      }
      break;
    case "set_area": {
      const workspaceTags = requireWorkspaceTags(tags);
      const desired = resolveWorkspaceTag(areaTagName(operation.after), workspaceTags);
      if (!taskCategoryMatches(task, areaTagPrefix, desired)) {
        return false;
      }
      break;
    }
    case "set_dependencies":
      if (expectedExternal == null) {
        return false;
      }
      if (!sameDependencies(
        expectedExternal.data.dependencies,
        resolveDependencies(operation.after, mappings),
      )) {
        return false;
      }
      break;
    case "set_parent":
      if (
        taskParentGid(task)
        !== resolveParentGid(operation.after, mappings)
      ) {
        return false;
      }
      break;
    case "set_parent_work_mode":
      if (expectedExternal == null || expectedExternal.data.parent_work_mode !== operation.after) {
        return false;
      }
      break;
    case "link_obsidian":
      if (
        expectedExternal == null
        || findObsidianLink(expectedExternal.data.obsidian_links, operation.after) == null
      ) {
        return false;
      }
      break;
    case "unlink_obsidian":
      if (
        expectedExternal == null
        || findObsidianLink(expectedExternal.data.obsidian_links, operation.before) != null
      ) {
        return false;
      }
      break;
  }
  return verifyExternal(task, expectedExternal);
}

async function fetchWorkspaceTags(
  readClient: AsanaReadClient,
  workspaceGid: string,
  signal: AbortSignal,
): Promise<readonly AsanaTag[]> {
  const tags = await readClient.listWorkspaceTags(workspaceGid, signal);
  return workspaceTagsFromResponse(tags);
}

async function applyCategoryTagPlan(
  taskGid: string,
  plan: CategoryTagPlan,
  writeClient: AsanaTaskWriteClient,
  signal: AbortSignal,
): Promise<boolean> {
  let changed = false;
  if (plan.add) {
    await writeClient.addTaskTag(taskGid, plan.tag.gid, signal);
    changed = true;
  }
  for (const tag of plan.remove) {
    await writeClient.removeTaskTag(taskGid, tag.gid, signal);
    changed = true;
  }
  return changed;
}

async function applyCategoryTag(
  task: AsanaTaskResponse,
  prefix: string,
  desired: AsanaTag,
  writeClient: AsanaTaskWriteClient,
  signal: AbortSignal,
): Promise<boolean> {
  return applyCategoryTagPlan(
    task.gid,
    categoryTagPlan(task, prefix, desired),
    writeClient,
    signal,
  );
}

async function applyStatus(
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGid: string,
  completed: boolean,
  writeClient: AsanaTaskWriteClient,
  signal: AbortSignal,
): Promise<boolean> {
  let changed = false;
  const membership = taskProjectMembership(task, projectGid);
  if (membership == null) {
    await writeClient.addTaskToProject(
      task.gid,
      projectGid,
      sectionGid,
      { kind: "none" },
      signal,
    );
    changed = true;
  } else if (membership.section == null || membership.section.gid !== sectionGid) {
    await writeClient.addTaskToSection(
      task.gid,
      sectionGid,
      { kind: "none" },
      signal,
    );
    changed = true;
  }
  if (task.completed !== completed) {
    await writeClient.updateTask(
      task.gid,
      { kind: "completed", value: completed },
      signal,
    );
    changed = true;
  }
  return changed;
}

async function applyNonCreateAsanaOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  input: WriterInput,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[] | undefined,
  writeClient: AsanaTaskWriteClient,
  signal: AbortSignal,
): Promise<boolean> {
  switch (operation.operation) {
    case "update_title":
      if (task.name === operation.after) {
        return false;
      }
      await writeClient.updateTask(task.gid, { kind: "title", value: operation.after }, signal);
      return true;
    case "update_notes":
      if (task.notes === operation.after) {
        return false;
      }
      await writeClient.updateTask(task.gid, { kind: "notes", value: operation.after }, signal);
      return true;
    case "set_status":
    case "complete":
    case "withdraw": {
      const status = expectedStatus(statusForOperation(operation), input.section_gids);
      return applyStatus(
        task,
        input.project_gid,
        status.section_gid,
        status.completed,
        writeClient,
        signal,
      );
    }
    case "set_importance": {
      const workspaceTags = requireWorkspaceTags(tags);
      const desired = resolveWorkspaceTag(importanceTagName(operation.after), workspaceTags);
      return applyCategoryTag(task, importanceTagPrefix, desired, writeClient, signal);
    }
    case "set_due": {
      const current = taskDueValue(task);
      if (sameDueValue(current, operation.after)) {
        return false;
      }
      await writeClient.updateTask(task.gid, createDueUpdate(operation.after), signal);
      return true;
    }
    case "clear_due":
      if (taskDueValue(task).kind === "absent") {
        return false;
      }
      await writeClient.updateTask(task.gid, { kind: "clear_due" }, signal);
      return true;
    case "set_area": {
      const workspaceTags = requireWorkspaceTags(tags);
      const desired = resolveWorkspaceTag(areaTagName(operation.after), workspaceTags);
      return applyCategoryTag(task, areaTagPrefix, desired, writeClient, signal);
    }
    case "set_dependencies":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
      return false;
    case "set_parent": {
      const current = taskParentGid(task);
      const desired = resolveParentGid(operation.after, mappings);
      if (current === desired) {
        return false;
      }
      if (desired == null) {
        await writeClient.clearTaskParent(task.gid, signal);
      } else {
        await writeClient.setTaskParent(task.gid, desired, signal);
      }
      return true;
    }
  }
  throw new Error("未対応のAsana操作です。");
}

function externalConflictResult(
  operationId: string,
  taskGid: string,
  reasonCode: "external_unreadable" | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded",
): WriterResult {
  return createResult(operationId, taskGid, "conflict", reasonCode);
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
    validateAbortSignal(signal);
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    const mappings = createMappingMap(validatedInput.temporary_ref_to_gid);
    if (validatedInput.operation.operation === "create_task") {
      return this.applyCreate(validatedInput, mappings, signal);
    }
    return this.applyNonCreate(validatedInput, mappings, signal);
  }

  private async applyCreate(
    input: WriterInput,
    mappings: ReadonlyMap<string, string>,
    signal: AbortSignal,
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
        );
      }
      if (currentExternal.value.response.gid !== expectedExternal.gid) {
        return externalConflictResult(
          operation.operation_id,
          existing.gid,
          "external_identity_mismatch",
        );
      }
      if (taskMatchesCreate(existing, input, operation, expectedExternal, tags)) {
        return createResult(operation.operation_id, existing.gid, "already_applied", "already_applied");
      }
      return createResult(operation.operation_id, existing.gid, "conflict", "read_back_mismatch");
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
    const created = parseTask(
      await this.writeClient.createTask(creationInput, signal),
      undefined,
    );
    const createdExternal = readCurrentExternal(created);
    if (createdExternal.kind === "conflict") {
      return externalConflictResult(
        operation.operation_id,
        created.gid,
        createdExternal.reason_code,
      );
    }
    if (createdExternal.value.response.gid !== expectedExternal.gid) {
      return externalConflictResult(
        operation.operation_id,
        created.gid,
        "external_identity_mismatch",
      );
    }

    const importanceTag = resolveWorkspaceTag(
      importanceTagName(operation.after.importance ?? 3),
      tags,
    );
    await applyCategoryTag(
      created,
      importanceTagPrefix,
      importanceTag,
      this.writeClient,
      signal,
    );
    const areaTag = resolveWorkspaceTag(
      areaTagName(operation.after.area ?? unclassifiedArea),
      tags,
    );
    await applyCategoryTag(
      created,
      areaTagPrefix,
      areaTag,
      this.writeClient,
      signal,
    );
    const status = expectedStatus(operation.after.status ?? "not_started", input.section_gids);
    await applyStatus(
      created,
      input.project_gid,
      status.section_gid,
      status.completed,
      this.writeClient,
      signal,
    );
    const desiredParent = operation.after.parent == null
      ? null
      : resolveTargetGid(operation.after.parent, mappings);
    if (taskParentGid(created) !== desiredParent) {
      if (desiredParent == null) {
        await this.writeClient.clearTaskParent(created.gid, signal);
      } else {
        await this.writeClient.setTaskParent(created.gid, desiredParent, signal);
      }
    }
    const readBack = parseTask(
      await this.readClient.getTask(created.gid, signal),
      created.gid,
    );
    if (!taskMatchesCreate(readBack, input, operation, expectedExternal, tags)) {
      return createResult(operation.operation_id, created.gid, "conflict", "read_back_mismatch");
    }
    return createResult(
      operation.operation_id,
      created.gid,
      "applied",
      "applied",
    );
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
    const task = parseTask(await this.readClient.getTask(taskGid, signal), taskGid);
    if (!taskHasProject(task, input.project_gid)) {
      return createResult(operation.operation_id, taskGid, "conflict", "baseline_changed");
    }
    const baselineExternalInput = input.baseline_external_data;
    if (baselineExternalInput == null) {
      throw new Error("create_task以外にはbaseline外部データが必要です。");
    }
    const baselineExternal = parseBaselineExternal(baselineExternalInput);
    let currentExternal: CurrentExternal | undefined;
    if (operationUsesExternalData(operation)) {
      const currentExternalResult = validateCurrentExternal(
        readCurrentExternal(task),
        baselineExternal,
      );
      if (currentExternalResult.kind === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          currentExternalResult.reason_code,
        );
      }
      currentExternal = currentExternalResult.value;
    }
    const classification = classifyOperation(
      operation,
      task,
      currentExternal?.data,
      input.project_gid,
      input.section_gids,
      mappings,
    );
    if (classification === "conflict") {
      return createResult(operation.operation_id, taskGid, "conflict", "baseline_changed");
    }
    if (classification === "after" && !operationUsesExternalData(operation)) {
      return createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
    }

    const externalOperations = externalOperationsForOperation(
      operation,
      baselineExternal.data,
      mappings,
      input.activity_date,
    );
    let mergeCurrent = currentExternal;
    let externalPlan: ExternalMergePlan = {
      kind: "none",
      expected: undefined,
      write: false,
    };
    if (externalOperations.length > 0) {
      if (mergeCurrent == null) {
        throw new Error("Custom external dataのcurrentがありません。");
      }
      externalPlan = mergeExternalPlan(
        baselineExternal,
        mergeCurrent,
        externalOperations,
        input.device_id,
      );
      if (externalPlan.kind === "conflict") {
        return externalConflictResult(
          operation.operation_id,
          taskGid,
          externalPlan.reason_code,
        );
      }
      if (externalPlan.kind === "none") {
        throw new Error("Custom external dataのマージ計画がありません。");
      }
    }
    const initialExternalPlanWrite = externalPlan.kind === "ready" && externalPlan.write;
    const tags = operation.operation === "set_importance" || operation.operation === "set_area"
      ? await fetchWorkspaceTags(this.readClient, input.workspace_gid, signal)
      : undefined;
    const asanaChanged = await applyNonCreateAsanaOperation(
      operation,
      task,
      input,
      mappings,
      tags,
      this.writeClient,
      signal,
    );
    let expectedExternal: ExpectedExternal | undefined;
    if (externalOperations.length > 0) {
      if (asanaChanged || initialExternalPlanWrite) {
        const latestTask = parseTask(
          await this.readClient.getTask(taskGid, signal),
          taskGid,
        );
        const latestExternalResult = validateCurrentExternal(
          readCurrentExternal(latestTask),
          baselineExternal,
        );
        if (latestExternalResult.kind === "conflict") {
          return externalConflictResult(
            operation.operation_id,
            taskGid,
            latestExternalResult.reason_code,
          );
        }
        mergeCurrent = latestExternalResult.value;
        externalPlan = mergeExternalPlan(
          baselineExternal,
          mergeCurrent,
          externalOperations,
          input.device_id,
        );
        if (externalPlan.kind === "conflict") {
          return externalConflictResult(
            operation.operation_id,
            taskGid,
            externalPlan.reason_code,
          );
        }
        if (externalPlan.kind === "none") {
          throw new Error("Custom external dataのマージ計画がありません。");
        }
      }
      if (mergeCurrent == null || externalPlan.kind !== "ready") {
        throw new Error("Custom external dataのマージ結果がありません。");
      }
      expectedExternal = {
        gid: mergeCurrent.response.gid,
        data: externalPlan.expected,
      };
      if (externalPlan.write) {
        await this.writeClient.updateTask(
          taskGid,
          {
            kind: "external",
            value: {
              gid: expectedExternal.gid,
              data: externalPlan.serialized,
            },
          },
          signal,
        );
      }
    }
    if (!asanaChanged && !externalPlan.write) {
      return createResult(operation.operation_id, taskGid, "already_applied", "already_applied");
    }
    const readBack = parseTask(
      await this.readClient.getTask(taskGid, signal),
      taskGid,
    );
    if (!verifyOperationAfter(readBack, operation, input, mappings, expectedExternal, tags)) {
      return createResult(operation.operation_id, taskGid, "conflict", "read_back_mismatch");
    }
    return createResult(operation.operation_id, taskGid, "applied", "applied");
  }
}
