import { z } from "zod";
import {
  canonicalizeJson,
  gidSchema,
  identifierSchema,
  type Duration,
  type Importance,
  type ObsidianLink,
  type ParentWorkMode,
  taskSchema,
  type Task,
  type TaskStatus,
} from "../../../shared/domain";
import {
  proposalSchema,
  type Proposal,
  type ProposalGroup,
  type ProposalOperation,
} from "../../../shared/ai";
import {
  graphValidationResultSchema,
  type GraphValidationResult,
} from "../proposal-validation";

import { createApprovalConflictSchemas } from "../../application/proposal-generate/approval-conflict-schemas";
import { createSelectedOperationContexts, createOperationResults, createGroupResults } from "../../application/proposal-generate/approval-results";
import {
  createApprovalComparison,
  type DueValue,
  type ParentIdentity,
  type TargetIdentity,
  type TemporaryResolution,
} from "../../application/proposal-generate/approval-comparison";

const {
  compareStrings,
  sortUniqueStrings,
  targetIdentityFromTask,
  taskDueValue,
  sameParentIdentity,
  sameDueValue,
  sameDurationValue,
  sameDependencies,
  sameObsidianLinks,
  findObsidianLink,
  resolveTargetIdentity,
  resolveParentIdentity,
  resolveDependencies,
  classifyObsidianOperation,
} = createApprovalComparison(canonicalizeJson);


const approvalSchemas = createApprovalConflictSchemas({
  gidSchema,
  identifierSchema,
  taskSchema,
  proposalSchema,
  graphValidationResultSchema,
});

const approvalInputSchema = approvalSchemas.approvalInputSchema;
const approvalResultSchema = approvalSchemas.approvalResultSchema;
type ConflictReasonCode = z.infer<typeof approvalSchemas.conflictReasonCodeSchema>;
const conflictReasonCodeOrder: readonly ConflictReasonCode[] = [
  "current_task_missing",
  "field_changed",
  "external_data_unwritable",
  "temporary_target_unresolved",
];
type JournalTaskMapping = z.infer<typeof approvalSchemas.journalTaskMappingSchema>;

export type ProposalApprovalInput = z.infer<typeof approvalInputSchema>;
export type ProposalApprovalResult = z.infer<typeof approvalResultSchema>;

/** AI変更案の承認競合入力を検証するスキーマです。 */
export const proposalApprovalInputSchema = approvalInputSchema;

/** AI変更案の承認競合結果を検証するスキーマです。 */
export const proposalApprovalResultSchema = approvalResultSchema;

type ProposalTarget = Extract<
  ProposalOperation,
  { readonly operation: "update_title" }
>["target"];

type ProposalDependency = Extract<
  ProposalOperation,
  { readonly operation: "set_dependencies" }
>["before"][number];

type ProposalCreateTaskOperation = Extract<
  ProposalOperation,
  { readonly operation: "create_task" }
>;

type NonCreateOperation = Exclude<
  ProposalOperation,
  { readonly operation: "create_task" }
>;

type ComparableDependency = {
  readonly target: TargetIdentity;
  readonly scope: ProposalDependency["scope"];
  readonly source: string;
};

type DurationValue = Duration | { readonly kind: "absent" };

type ComparableTask = {
  readonly title: string;
  readonly notes: string;
  readonly status: TaskStatus;
  readonly importance: Importance;
  readonly area: string;
  readonly due: DueValue;
  readonly duration: DurationValue;
  readonly parent: ParentIdentity;
  readonly parent_work_mode: ParentWorkMode;
  readonly dependencies: readonly ComparableDependency[];
  readonly obsidian_links: readonly ObsidianLink[];
};

type Classification =
  | {
      readonly kind: "applicable";
      readonly affected_task_gids: readonly string[];
    }
  | {
      readonly kind: "already_applied";
      readonly affected_task_gids: readonly string[];
    }
  | {
      readonly kind: "conflict";
      readonly reason_codes: readonly ConflictReasonCode[];
      readonly affected_task_gids: readonly string[];
    };

type ProposalOperationContext = {
  readonly group: ProposalGroup;
  readonly operation: ProposalOperation;
};

function sortReasonCodes(
  reasonCodes: readonly ConflictReasonCode[],
): ConflictReasonCode[] {
  return [...new Set(reasonCodes)].sort(
    (left, right) => conflictReasonCodeOrder.indexOf(left)
      - conflictReasonCodeOrder.indexOf(right),
  );
}

function conflictClassification(
  affectedTaskGids: readonly string[],
  reasonCodes: readonly ConflictReasonCode[],
): Classification {
  const sortedReasonCodes = sortReasonCodes(reasonCodes);
  if (sortedReasonCodes.length === 0) {
    throw new Error("競合理由コードがありません。");
  }
  return {
    kind: "conflict",
    reason_codes: sortedReasonCodes,
    affected_task_gids: sortUniqueStrings(affectedTaskGids),
  };
}

function currentTaskState(task: Task): ComparableTask {
  return {
    title: task.title,
    notes: task.notes,
    status: task.status,
    importance: task.importance,
    area: task.area,
    due: taskDueValue(task),
    duration: task.duration == null ? { kind: "absent" } : task.duration,
    parent: targetIdentityFromTask(task),
    parent_work_mode: task.parent_work_mode,
    dependencies: task.dependencies.map((dependency) => ({
      target: { kind: "existing", gid: dependency.task_gid },
      scope: dependency.scope,
      source: dependency.source,
    })),
    obsidian_links: task.obsidian_links,
  };
}

function createTaskMatchesAfter(
  operation: ProposalCreateTaskOperation,
  task: ComparableTask,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): boolean {
  const after = operation.after;
  if (task.title !== after.title) {
    return false;
  }
  if (after.notes != null && task.notes !== after.notes) {
    return false;
  }
  if (after.status != null && task.status !== after.status) {
    return false;
  }
  if (after.importance != null && task.importance !== after.importance) {
    return false;
  }
  if (after.area != null && task.area !== after.area) {
    return false;
  }
  if (after.due != null && canonicalizeJson(task.due) !== canonicalizeJson(after.due)) {
    return false;
  }
  if (
    after.duration != null
    && !sameDurationValue(task.duration, after.duration)
  ) {
    return false;
  }
  if (
    after.parent != null
    && !sameParentIdentity(
      task.parent,
      resolveParentIdentity(after.parent, resolutions),
    )
  ) {
    return false;
  }
  if (
    after.parent_work_mode != null
    && task.parent_work_mode !== after.parent_work_mode
  ) {
    return false;
  }
  if (
    after.dependencies != null
    && !sameDependencies(
      task.dependencies,
      resolveDependencies(after.dependencies, resolutions),
    )
  ) {
    return false;
  }
  if (
    after.obsidian_links != null
    && !sameObsidianLinks(task.obsidian_links, after.obsidian_links)
  ) {
    return false;
  }
  return true;
}

function createTaskState(
  operation: ProposalCreateTaskOperation,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): ComparableTask {
  const after = operation.after;
  return {
    title: after.title,
    notes: after.notes ?? "",
    status: after.status ?? "not_started",
    importance: after.importance ?? 3,
    area: after.area ?? "未分類",
    due: after.due ?? { kind: "absent" },
    duration: after.duration ?? { kind: "absent" },
    parent: after.parent == null
      ? { kind: "absent" }
      : resolveParentIdentity(after.parent, resolutions),
    parent_work_mode: after.parent_work_mode ?? "unknown",
    dependencies: after.dependencies == null
      ? []
      : resolveDependencies(after.dependencies, resolutions),
    obsidian_links: after.obsidian_links ?? [],
  };
}

function createTaskMap(tasks: readonly Task[]): ReadonlyMap<string, Task> {
  const taskMap = new Map<string, Task>();
  for (const task of tasks) {
    if (taskMap.has(task.gid)) {
      throw new Error("正規化済みタスクGIDが重複しています。");
    }
    taskMap.set(task.gid, task);
  }
  return taskMap;
}

function createOperationContexts(
  proposal: Proposal,
): readonly ProposalOperationContext[] {
  const contexts: ProposalOperationContext[] = [];
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      contexts.push({ group, operation });
    }
  }
  return contexts;
}

function createOperationMap(
  contexts: readonly ProposalOperationContext[],
): ReadonlyMap<string, ProposalOperationContext> {
  const operationMap = new Map<string, ProposalOperationContext>();
  for (const context of contexts) {
    if (operationMap.has(context.operation.operation_id)) {
      throw new Error("proposalのoperation_idが重複しています。");
    }
    operationMap.set(context.operation.operation_id, context);
  }
  return operationMap;
}

function createCreateOperationMap(
  contexts: readonly ProposalOperationContext[],
): ReadonlyMap<string, ProposalCreateTaskOperation> {
  const createOperations = new Map<string, ProposalCreateTaskOperation>();
  for (const context of contexts) {
    if (context.operation.operation !== "create_task") {
      continue;
    }
    if (createOperations.has(context.operation.temporary_ref)) {
      throw new Error("proposalのtemporary_refが重複しています。");
    }
    createOperations.set(context.operation.temporary_ref, context.operation);
  }
  return createOperations;
}

function createJournalMappingMap(
  mappings: readonly JournalTaskMapping[],
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): ReadonlyMap<string, JournalTaskMapping> {
  const mappingMap = new Map<string, JournalTaskMapping>();
  for (const mapping of mappings) {
    if (!createOperations.has(mapping.temporary_ref)) {
      throw new Error("journal mappingのtemporary_refがcreate_taskへ対応していません。");
    }
    if (mappingMap.has(mapping.temporary_ref)) {
      throw new Error("journal mappingのtemporary_refが重複しています。");
    }
    mappingMap.set(mapping.temporary_ref, mapping);
  }
  return mappingMap;
}

function createTemporaryResolutions(
  contexts: readonly ProposalOperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  journalMappings: ReadonlyMap<string, JournalTaskMapping>,
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): ReadonlyMap<string, TemporaryResolution> {
  const resolutions = new Map<string, TemporaryResolution>();
  for (const [temporaryRef, mapping] of journalMappings) {
    resolutions.set(temporaryRef, { kind: "journal", gid: mapping.task_gid });
  }
  for (const context of contexts) {
    if (
      context.operation.operation === "create_task"
      && selectedOperationIds.has(context.operation.operation_id)
      && !resolutions.has(context.operation.temporary_ref)
    ) {
      resolutions.set(context.operation.temporary_ref, { kind: "selected_create" });
    }
  }
  if (resolutions.size > createOperations.size) {
    throw new Error("temporary_refの解決数がcreate_task数を超えています。");
  }
  return resolutions;
}

function collectTargets(operation: ProposalOperation): readonly ProposalTarget[] {
  const targets: ProposalTarget[] = [];
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") {
      targets.push(operation.creation.parent);
    }
    if (operation.after.parent != null) {
      targets.push(operation.after.parent);
    }
    if (operation.after.dependencies != null) {
      for (const dependency of operation.after.dependencies) {
        targets.push(dependency.target);
      }
    }
    return targets;
  }
  targets.push(operation.target);
  if (operation.operation === "set_dependencies") {
    for (const dependency of operation.before) {
      targets.push(dependency.target);
    }
    for (const dependency of operation.after) {
      targets.push(dependency.target);
    }
  }
  if (operation.operation === "set_parent") {
    if (operation.before.kind !== "absent") {
      targets.push(operation.before);
    }
    if (operation.after.kind !== "absent") {
      targets.push(operation.after);
    }
  }
  return targets;
}

function validateSelectedBaselineTargets(
  contexts: readonly ProposalOperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  baselineTasks: ReadonlyMap<string, Task>,
): void {
  for (const context of contexts) {
    if (!selectedOperationIds.has(context.operation.operation_id)) {
      continue;
    }
    for (const target of collectTargets(context.operation)) {
      if (target.kind === "existing" && !baselineTasks.has(target.gid)) {
        throw new Error("選択操作が参照する基準タスクを取得できません。");
      }
    }
  }
}

function baselineTaskForOperation(
  operation: NonCreateOperation,
  baselineTasks: ReadonlyMap<string, Task>,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): ComparableTask | undefined {
  const target = operationTarget(operation);
  if (target.kind === "temporary") {
    const createOperation = createOperations.get(target.ref);
    if (createOperation == null) {
      throw new Error("選択済みcreate_taskがtemporary_refへ対応していません。");
    }
    if (unresolvedTemporaryRefs(createOperation, resolutions).length > 0) {
      return undefined;
    }
    return createTaskState(createOperation, resolutions);
  }
  if (unresolvedTemporaryRefs(operation, resolutions).length > 0) {
    return undefined;
  }
  const baselineTask = baselineTasks.get(target.gid);
  if (baselineTask == null) {
    throw new Error("操作対象タスクがbaselineにありません。");
  }
  return currentTaskState(baselineTask);
}

function baselineOperationMatches(
  operation: NonCreateOperation,
  task: ComparableTask,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): boolean {
  if (operation.operation === "link_obsidian") {
    return findObsidianLink(task.obsidian_links, operation.after) == null;
  }
  if (operation.operation === "unlink_obsidian") {
    const existing = findObsidianLink(task.obsidian_links, operation.before);
    return existing != null
      && canonicalizeJson(existing) === canonicalizeJson(operation.before);
  }
  return operationBeforeMatches(operation, task, resolutions);
}

function validateSelectedBaselineFields(
  contexts: readonly ProposalOperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  baselineTasks: ReadonlyMap<string, Task>,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): void {
  for (const context of contexts) {
    if (!selectedOperationIds.has(context.operation.operation_id)) {
      continue;
    }
    if (context.operation.operation === "create_task") {
      continue;
    }
    const baselineTask = baselineTaskForOperation(
      context.operation,
      baselineTasks,
      resolutions,
      createOperations,
    );
    if (
      baselineTask != null
      && !baselineOperationMatches(context.operation, baselineTask, resolutions)
    ) {
      throw new Error("操作対象タスクのbaselineがbeforeと一致しません。");
    }
  }
}

function validateGraphCorrespondence(
  proposal: Proposal,
  graphResult: GraphValidationResult,
  contexts: readonly ProposalOperationContext[],
): ReadonlyMap<string, GraphValidationResult["operations"][number]> {
  const operationMap = createOperationMap(contexts);
  const graphOperations = new Map<
    string,
    GraphValidationResult["operations"][number]
  >();
  if (graphResult.operations.length !== contexts.length) {
    throw new Error("graph validationの操作数がproposalと一致しません。");
  }
  for (const operation of graphResult.operations) {
    const context = operationMap.get(operation.operation_id);
    if (context == null || context.group.group_id !== operation.group_id) {
      throw new Error("graph validationの操作対応がproposalと一致しません。");
    }
    if (graphOperations.has(operation.operation_id)) {
      throw new Error("graph validationのoperation_idが重複しています。");
    }
    graphOperations.set(operation.operation_id, operation);
  }
  if (graphOperations.size !== contexts.length) {
    throw new Error("graph validationの操作対応が不足しています。");
  }

  if (graphResult.groups.length !== proposal.groups.length) {
    throw new Error("graph validationのグループ数がproposalと一致しません。");
  }
  const graphGroups = new Map<string, GraphValidationResult["groups"][number]>();
  for (const group of graphResult.groups) {
    const proposalGroup = proposal.groups.find(
      (candidate) => candidate.group_id === group.group_id,
    );
    if (proposalGroup == null || graphGroups.has(group.group_id)) {
      throw new Error("graph validationのグループ対応がproposalと一致しません。");
    }
    if (proposalGroup.atomic !== group.atomic) {
      throw new Error("graph validationのatomic指定がproposalと一致しません。");
    }
    if (proposalGroup.operations.length !== group.operation_ids.length) {
      throw new Error("graph validationのグループ操作数がproposalと一致しません。");
    }
    proposalGroup.operations.forEach((operation, index) => {
      if (group.operation_ids[index] !== operation.operation_id) {
        throw new Error("graph validationのグループ操作順がproposalと一致しません。");
      }
    });
    graphGroups.set(group.group_id, group);
  }
  if (graphGroups.size !== proposal.groups.length) {
    throw new Error("graph validationのグループ対応が不足しています。");
  }
  return graphOperations;
}

function unresolvedTemporaryRefs(
  operation: ProposalOperation,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): readonly string[] {
  const unresolved = new Set<string>();
  for (const target of collectTargets(operation)) {
    if (target.kind === "temporary" && !resolutions.has(target.ref)) {
      unresolved.add(target.ref);
    }
  }
  if (
    operation.operation === "create_task"
    && !resolutions.has(operation.temporary_ref)
  ) {
    unresolved.add(operation.temporary_ref);
  }
  return [...unresolved].sort(compareStrings);
}

function operationTarget(operation: ProposalOperation): ProposalTarget {
  if (operation.operation === "create_task") {
    return { kind: "temporary", ref: operation.temporary_ref };
  }
  return operation.target;
}

function targetGid(identity: TargetIdentity | undefined): string | undefined {
  if (identity == null || identity.kind !== "existing") {
    return undefined;
  }
  return identity.gid;
}

function affectedTaskGids(identity: TargetIdentity | undefined): readonly string[] {
  const gid = targetGid(identity);
  return gid == null ? [] : [gid];
}

function requiresExternalDataWrite(operation: ProposalOperation): boolean {
  switch (operation.operation) {
    case "update_title":
    case "update_notes":
    case "set_status":
    case "set_importance":
    case "set_due":
    case "clear_due":
    case "set_duration":
    case "clear_duration":
    case "set_area":
    case "set_dependencies":
    case "set_parent":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
      return true;
    case "create_task":
      return true;
    default:
      return false;
  }
}

function hasExternalDataWriteAccess(
  identity: TargetIdentity | undefined,
  writableExternalDataTaskGids: ReadonlySet<string>,
): boolean {
  if (identity?.kind === "temporary") {
    return true;
  }
  const gid = targetGid(identity);
  return gid != null && writableExternalDataTaskGids.has(gid);
}

function resolveComparableTask(
  operation: ProposalOperation,
  currentTasks: ReadonlyMap<string, Task>,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): ComparableTask | undefined {
  const target = operationTarget(operation);
  const identity = resolveTargetIdentity(target, resolutions);
  if (identity == null) {
    return undefined;
  }
  if (identity.kind === "temporary") {
    const createOperation = createOperations.get(identity.ref);
    if (createOperation == null) {
      throw new Error("選択済みcreate_taskがtemporary_refへ対応していません。");
    }
    return createTaskState(createOperation, resolutions);
  }
  const currentTask = currentTasks.get(identity.gid);
  return currentTask == null ? undefined : currentTaskState(currentTask);
}

function operationTargetIdentity(
  operation: ProposalOperation,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): TargetIdentity | undefined {
  return resolveTargetIdentity(operationTarget(operation), resolutions);
}

function operationBeforeMatches(
  operation: NonCreateOperation,
  task: ComparableTask,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): boolean {
  switch (operation.operation) {
    case "update_title":
      return task.title === operation.before;
    case "update_notes":
      return task.notes === operation.before;
    case "set_status":
    case "complete":
    case "withdraw":
      return task.status === operation.before;
    case "set_importance":
      return task.importance === operation.before;
    case "set_due":
    case "clear_due":
      return sameDueValue(task.due, operation.before);
    case "set_duration":
    case "clear_duration":
      return sameDurationValue(task.duration, operation.before);
    case "set_area":
      return task.area === operation.before;
    case "set_dependencies":
      return sameDependencies(
        task.dependencies,
        resolveDependencies(operation.before, resolutions),
      );
    case "set_parent":
      return sameParentIdentity(
        task.parent,
        resolveParentIdentity(operation.before, resolutions),
      );
    case "set_parent_work_mode":
      return task.parent_work_mode === operation.before;
    case "link_obsidian":
    case "unlink_obsidian":
      return false;
  }
}

function operationAfterMatches(
  operation: NonCreateOperation,
  task: ComparableTask,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): boolean {
  switch (operation.operation) {
    case "update_title":
      return task.title === operation.after;
    case "update_notes":
      return task.notes === operation.after;
    case "set_status":
    case "complete":
    case "withdraw":
      return task.status === operation.after;
    case "set_importance":
      return task.importance === operation.after;
    case "set_due":
    case "clear_due":
      return sameDueValue(task.due, operation.after);
    case "set_duration":
    case "clear_duration":
      return sameDurationValue(task.duration, operation.after);
    case "set_area":
      return task.area === operation.after;
    case "set_dependencies":
      return sameDependencies(
        task.dependencies,
        resolveDependencies(operation.after, resolutions),
      );
    case "set_parent":
      return sameParentIdentity(
        task.parent,
        resolveParentIdentity(operation.after, resolutions),
      );
    case "set_parent_work_mode":
      return task.parent_work_mode === operation.after;
    case "link_obsidian":
    case "unlink_obsidian":
      return false;
  }
}

function classifyCreateTask(
  operation: ProposalCreateTaskOperation,
  currentTasks: ReadonlyMap<string, Task>,
  writableExternalDataTaskGids: ReadonlySet<string>,
  journalMappings: ReadonlyMap<string, JournalTaskMapping>,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
): Classification {
  const unresolved = unresolvedTemporaryRefs(operation, resolutions);
  const mapping = journalMappings.get(operation.temporary_ref);
  const mappingGid = mapping?.task_gid;
  const reasons: ConflictReasonCode[] = [];
  if (unresolved.length > 0) {
    reasons.push("temporary_target_unresolved");
  }
  if (mapping == null) {
    if (reasons.length > 0) {
      return conflictClassification([], reasons);
    }
    return {
      kind: "applicable",
      affected_task_gids: [],
    };
  }
  const currentTask = currentTasks.get(mapping.task_gid);
  if (currentTask == null) {
    reasons.push("current_task_missing");
  }
  if (!writableExternalDataTaskGids.has(mapping.task_gid)) {
    reasons.push("external_data_unwritable");
  }
  if (currentTask != null && unresolved.length === 0) {
    if (!createTaskMatchesAfter(operation, currentTaskState(currentTask), resolutions)) {
      reasons.push("field_changed");
    }
  }
  if (reasons.length > 0) {
    return conflictClassification(mappingGid == null ? [] : [mappingGid], reasons);
  }
  return {
    kind: "already_applied",
    affected_task_gids: mappingGid == null ? [] : [mappingGid],
  };
}

function classifyNonCreateOperation(
  operation: NonCreateOperation,
  baselineTasks: ReadonlyMap<string, Task>,
  currentTasks: ReadonlyMap<string, Task>,
  writableExternalDataTaskGids: ReadonlySet<string>,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): Classification {
  const identity = operationTargetIdentity(operation, resolutions);
  const affected = affectedTaskGids(identity);
  const reasons: ConflictReasonCode[] = [];
  if (unresolvedTemporaryRefs(operation, resolutions).length > 0) {
    reasons.push("temporary_target_unresolved");
  }
  if (identity?.kind === "temporary") {
    const createOperation = createOperations.get(identity.ref);
    if (createOperation == null) {
      throw new Error("選択済みcreate_taskがtemporary_refへ対応していません。");
    }
    if (unresolvedTemporaryRefs(createOperation, resolutions).length > 0) {
      reasons.push("temporary_target_unresolved");
    }
  }
  const resolvedGid = targetGid(identity);
  if (resolvedGid != null && !currentTasks.has(resolvedGid)) {
    reasons.push("current_task_missing");
  }
  if (
    requiresExternalDataWrite(operation)
    && !hasExternalDataWriteAccess(identity, writableExternalDataTaskGids)
  ) {
    reasons.push("external_data_unwritable");
  }
  if (reasons.length > 0) {
    return conflictClassification(affected, reasons);
  }
  const task = resolveComparableTask(
    operation,
    currentTasks,
    resolutions,
    createOperations,
  );
  if (task == null) {
    throw new Error("競合分類対象タスクを取得できません。");
  }
  if (operation.operation === "link_obsidian" || operation.operation === "unlink_obsidian") {
    const obsidianResult = classifyObsidianOperation(operation, task);
    if (obsidianResult === "applicable") {
      return { kind: "applicable", affected_task_gids: affected };
    }
    if (obsidianResult === "already_applied") {
      return { kind: "already_applied", affected_task_gids: affected };
    }
    return conflictClassification(affected, ["field_changed"]);
  }
  if (operationBeforeMatches(operation, task, resolutions)) {
    if (!taskNotesEvidenceMatchesBaseline(operation, baselineTasks, task)) {
      return conflictClassification(affected, ["field_changed"]);
    }
    return { kind: "applicable", affected_task_gids: affected };
  }
  if (operationAfterMatches(operation, task, resolutions)) {
    return { kind: "already_applied", affected_task_gids: affected };
  }
  return conflictClassification(affected, ["field_changed"]);
}

function taskNotesEvidenceMatchesBaseline(
  operation: NonCreateOperation,
  baselineTasks: ReadonlyMap<string, Task>,
  currentTask: ComparableTask,
): boolean {
  if (
    (operation.operation !== "complete" && operation.operation !== "withdraw")
    || operation.status_evidence.kind !== "task_or_note_explicit"
    || operation.status_evidence.reference.kind !== "task"
    || operation.target.kind !== "existing"
  ) {
    return true;
  }
  const baselineTask = baselineTasks.get(operation.target.gid);
  return baselineTask != null && baselineTask.notes === currentTask.notes;
}

function classifyOperation(
  operation: ProposalOperation,
  baselineTasks: ReadonlyMap<string, Task>,
  currentTasks: ReadonlyMap<string, Task>,
  writableExternalDataTaskGids: ReadonlySet<string>,
  journalMappings: ReadonlyMap<string, JournalTaskMapping>,
  resolutions: ReadonlyMap<string, TemporaryResolution>,
  createOperations: ReadonlyMap<string, ProposalCreateTaskOperation>,
): Classification {
  if (operation.operation === "create_task") {
    return classifyCreateTask(
      operation,
      currentTasks,
      writableExternalDataTaskGids,
      journalMappings,
      resolutions,
    );
  }
  return classifyNonCreateOperation(
    operation,
    baselineTasks,
    currentTasks,
    writableExternalDataTaskGids,
    resolutions,
    createOperations,
  );
}

/** AI変更案を承認直前の現在値とフィールド単位で分類します。 */
export function classifyProposalConflicts(
  input: ProposalApprovalInput,
): ProposalApprovalResult {
  const validatedInput = approvalInputSchema.parse(input);
  const baselineTasks = createTaskMap(validatedInput.baseline_tasks);
  const currentTasks = createTaskMap(validatedInput.current_tasks);
  const contexts = createOperationContexts(validatedInput.proposal);
  const selectedOperationIds = new Set(validatedInput.selected_operation_ids);
  const operationMap = createOperationMap(contexts);
  for (const operationId of selectedOperationIds) {
    if (!operationMap.has(operationId)) {
      throw new Error("選択されたoperation_idがproposalにありません。");
    }
  }
  const graphOperations = validateGraphCorrespondence(
    validatedInput.proposal,
    validatedInput.graph_validation_result,
    contexts,
  );
  for (const operationId of selectedOperationIds) {
    const graphOperation = graphOperations.get(operationId);
    if (graphOperation == null) {
      throw new Error("選択操作のgraph validation結果がありません。");
    }
    if (graphOperation.kind === "invalid") {
      throw new Error("graph validationで無効な操作は選択できません。");
    }
  }
  validateSelectedBaselineTargets(contexts, selectedOperationIds, baselineTasks);
  const createOperations = createCreateOperationMap(contexts);
  const journalMappings = createJournalMappingMap(
    validatedInput.journal_task_mappings,
    createOperations,
  );
  const resolutions = createTemporaryResolutions(
    contexts,
    selectedOperationIds,
    journalMappings,
    createOperations,
  );
  validateSelectedBaselineFields(
    contexts,
    selectedOperationIds,
    baselineTasks,
    resolutions,
    createOperations,
  );
  const writableExternalDataTaskGids = new Set(
    validatedInput.writable_external_data_task_gids,
  );
  for (const gid of writableExternalDataTaskGids) {
    if (!currentTasks.has(gid)) {
      throw new Error("外部データ書き込み可能タスクGIDがcurrentにありません。");
    }
  }
  const selectedContexts = createSelectedOperationContexts(
    contexts,
    selectedOperationIds,
  );
  const classifications = new Map<string, Classification>();
  for (const context of selectedContexts) {
    classifications.set(
      context.operation.operation_id,
      classifyOperation(
        context.operation,
        baselineTasks,
        currentTasks,
        writableExternalDataTaskGids,
        journalMappings,
        resolutions,
        createOperations,
      ),
    );
  }
  const result = {
    operations: createOperationResults(selectedContexts, classifications),
    groups: createGroupResults(
      validatedInput.proposal,
      selectedOperationIds,
      classifications,
    ),
  };
  return approvalResultSchema.parse(result);
}
