import { z } from "zod";
import {
  areaSchema,
  identifierSchema,
  snapshotHashSchema,
  taskSchema,
  type Importance,
  type ObsidianLink,
  type ParentWorkMode,
  type Task,
  type TaskStatus,
} from "../../../shared/domain";
import {
  proposalSchema,
  type Proposal,
  type ProposalOperation,
} from "../../../shared/ai";

const unclassifiedArea = "未分類";

const nonBlankLocatorSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "根拠locatorを空にできません。",
});

const maximumManagedTasks = 10000;
const maximumExistingAreas = 256;
const maximumSplitRequestLocators = 256;

const managedTasksSchema = z
  .array(taskSchema)
  .max(maximumManagedTasks)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    tasks.forEach((task, index) => {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: `管理対象タスクGID ${task.gid} が重複しています。`,
        });
        return;
      }
      seen.add(task.gid);
    });
  });

const existingAreasSchema = z
  .array(areaSchema)
  .max(maximumExistingAreas)
  .superRefine((areas, context) => {
    const seen = new Set<string>();
    areas.forEach((area, index) => {
      if (seen.has(area)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `領域 ${area} が重複しています。`,
        });
        return;
      }
      seen.add(area);
    });
  });

const explicitSplitRequestLocatorsSchema = z
  .array(nonBlankLocatorSchema)
  .max(maximumSplitRequestLocators)
  .superRefine((locators, context) => {
    const seen = new Set<string>();
    locators.forEach((locator, index) => {
      if (seen.has(locator)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `分割依頼locator ${locator} が重複しています。`,
        });
        return;
      }
      seen.add(locator);
    });
  });

/** AI変更案の基本検証入力を検証するスキーマです。 */
export const proposalValidationInputSchema = z
  .object({
    proposal: proposalSchema,
    baseline_snapshot_hash: snapshotHashSchema,
    managed_tasks: managedTasksSchema,
    existing_areas: existingAreasSchema,
    explicit_split_request_locators: explicitSplitRequestLocatorsSchema,
  })
  .strict();

const proposalValidationErrorCodeSchema = z.enum([
  "baseline_snapshot_mismatch",
  "target_not_managed",
  "dependency_not_managed",
  "parent_not_managed",
  "area_not_found",
  "before_value_mismatch",
  "split_request_not_explicit",
  "status_evidence_invalid",
  "conflicting_field_update",
]);

const proposalValidationErrorSchema = z
  .object({
    code: proposalValidationErrorCodeSchema,
    message: z.string().refine((value) => value.trim().length > 0, {
      message: "検証エラーの説明を空にできません。",
    }),
  })
  .strict();

const validOperationResultSchema = z
  .object({
    kind: z.literal("valid"),
    group_id: identifierSchema,
    operation_id: identifierSchema,
  })
  .strict();

const invalidOperationResultSchema = z
  .object({
    kind: z.literal("invalid"),
    group_id: identifierSchema,
    operation_id: identifierSchema,
    errors: z.array(proposalValidationErrorSchema).min(1),
  })
  .strict();

const proposalValidationOperationResultSchema = z.discriminatedUnion("kind", [
  validOperationResultSchema,
  invalidOperationResultSchema,
]);

const proposalValidationGroupResultSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    applicable: z.boolean(),
    operation_ids: z.array(identifierSchema).min(1),
  })
  .strict();

/** AI変更案の基本検証結果を検証するスキーマです。 */
export const proposalValidationResultSchema = z
  .object({
    operations: z.array(proposalValidationOperationResultSchema).min(1),
    groups: z.array(proposalValidationGroupResultSchema).min(1),
  })
  .strict()
  .superRefine((result, context) => {
    const operationResults = new Map<
      string,
      { readonly group_id: string; readonly kind: "valid" | "invalid" }
    >();
    result.operations.forEach((operation, index) => {
      if (operationResults.has(operation.operation_id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operation_id"],
          message: "同じoperation_idを検証結果へ重複して指定できません。",
        });
        return;
      }
      operationResults.set(operation.operation_id, {
        group_id: operation.group_id,
        kind: operation.kind,
      });
    });

    const groupIds = new Set<string>();
    const operationMemberships = new Map<string, number>();
    result.groups.forEach((group, groupIndex) => {
      if (groupIds.has(group.group_id)) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "group_id"],
          message: "同じgroup_idを検証結果へ重複して指定できません。",
        });
      } else {
        groupIds.add(group.group_id);
      }

      const groupOperationIds = new Set<string>();
      let validOperationCount = 0;
      group.operation_ids.forEach((operationId, operationIndex) => {
        if (groupOperationIds.has(operationId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: "同じoperation_idをグループへ重複して指定できません。",
          });
        } else {
          groupOperationIds.add(operationId);
        }

        const membershipCount = operationMemberships.get(operationId);
        operationMemberships.set(operationId, (membershipCount ?? 0) + 1);
        const operationResult = operationResults.get(operationId);
        if (operationResult == null) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: `operation_id ${operationId} に対応する操作結果がありません。`,
          });
          return;
        }
        if (operationResult.group_id !== group.group_id) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: `operation_id ${operationId} の所属group_idが一致しません。`,
          });
        }
        if (operationResult.kind === "valid") {
          validOperationCount += 1;
        }
      });

      const expectedApplicable = group.atomic
        ? validOperationCount === group.operation_ids.length
        : validOperationCount > 0;
      if (group.applicable !== expectedApplicable) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "applicable"],
          message: "groupのapplicableが操作結果から導かれる値と一致しません。",
        });
      }
    });

    result.operations.forEach((operation, operationIndex) => {
      if (!groupIds.has(operation.group_id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationIndex, "group_id"],
          message: `group_id ${operation.group_id} に対応するグループがありません。`,
        });
      }
      const membershipCount = operationMemberships.get(operation.operation_id);
      if (membershipCount == null) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationIndex, "operation_id"],
          message: `operation_id ${operation.operation_id} がグループに所属していません。`,
        });
      } else if (membershipCount !== 1) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationIndex, "operation_id"],
          message: `operation_id ${operation.operation_id} は一つのグループにだけ所属できます。`,
        });
      }
    });
  });

export type ProposalValidationInput = z.infer<
  typeof proposalValidationInputSchema
>;
export type ProposalValidationErrorCode = z.infer<
  typeof proposalValidationErrorCodeSchema
>;
export type ProposalValidationError = z.infer<
  typeof proposalValidationErrorSchema
>;
export type ProposalValidationOperationResult = z.infer<
  typeof proposalValidationOperationResultSchema
>;
export type ProposalValidationGroupResult = z.infer<
  typeof proposalValidationGroupResultSchema
>;
export type ProposalValidationResult = z.infer<
  typeof proposalValidationResultSchema
>;

type ProposalTarget = Extract<
  ProposalOperation,
  { readonly operation: "update_title" }
>["target"];

type ProposalParentValue = Extract<
  ProposalOperation,
  { readonly operation: "set_parent" }
>["before"];

type ProposalDependency = Extract<
  ProposalOperation,
  { readonly operation: "set_dependencies" }
>["before"][number];

type TaskDueValue =
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };

type TaskState = {
  readonly title: string;
  readonly notes: string;
  readonly status: TaskStatus;
  readonly importance: Importance;
  readonly area: string;
  readonly due: TaskDueValue;
  readonly parent: ProposalParentValue;
  readonly parent_work_mode: ParentWorkMode;
  readonly dependencies: readonly ProposalDependency[];
  readonly obsidian_links: readonly ObsidianLink[];
  readonly child_gids: readonly string[];
};

type FieldUpdate = {
  readonly key: string;
  readonly group_id: string;
  readonly operation_id: string;
  readonly field: string;
};

type OperationContext = {
  readonly group_id: string;
  readonly operation: ProposalOperation;
};

function addError(
  errorsByOperation: Map<string, ProposalValidationError[]>,
  operationId: string,
  code: ProposalValidationErrorCode,
  message: string,
): void {
  const errors = errorsByOperation.get(operationId);
  if (errors == null) {
    throw new Error(`操作ID ${operationId} の検証領域がありません。`);
  }
  if (errors.some((error) => error.code === code && error.message === message)) {
    return;
  }
  errors.push({ code, message });
}

function getTargetKey(target: ProposalTarget): string {
  if (target.kind === "existing") {
    return `existing:${target.gid}`;
  }
  return `temporary:${target.ref}`;
}

function getOperationTarget(
  operation: Exclude<ProposalOperation, { readonly operation: "create_task" }>,
): ProposalTarget {
  return operation.target;
}

function isSameTarget(left: ProposalTarget, right: ProposalTarget): boolean {
  if (left.kind === "existing" && right.kind === "existing") {
    return left.gid === right.gid;
  }
  if (left.kind === "temporary" && right.kind === "temporary") {
    return left.ref === right.ref;
  }
  return false;
}

function hasTask(
  target: ProposalTarget,
  managedTasks: ReadonlyMap<string, Task>,
  createdTemporaryRefs: ReadonlySet<string>,
): boolean {
  if (target.kind === "existing") {
    return managedTasks.has(target.gid);
  }
  return createdTemporaryRefs.has(target.ref);
}

function addTargetError(
  target: ProposalTarget,
  operationId: string,
  errorsByOperation: Map<string, ProposalValidationError[]>,
  managedTasks: ReadonlyMap<string, Task>,
  createdTemporaryRefs: ReadonlySet<string>,
  code: ProposalValidationErrorCode,
  referenceName: string,
): void {
  if (hasTask(target, managedTasks, createdTemporaryRefs)) {
    return;
  }
  const targetText = target.kind === "existing" ? target.gid : target.ref;
  addError(
    errorsByOperation,
    operationId,
    code,
    `${referenceName} ${targetText} は管理対象タスクとして存在しません。`,
  );
}

function addParentReferenceError(
  value: ProposalParentValue,
  operationId: string,
  errorsByOperation: Map<string, ProposalValidationError[]>,
  managedTasks: ReadonlyMap<string, Task>,
  createdTemporaryRefs: ReadonlySet<string>,
): void {
  if (value.kind === "absent") {
    return;
  }
  addTargetError(
    value,
    operationId,
    errorsByOperation,
    managedTasks,
    createdTemporaryRefs,
    "parent_not_managed",
    "親タスク",
  );
}

function addDependencyReferenceErrors(
  dependencies: readonly ProposalDependency[],
  operationId: string,
  errorsByOperation: Map<string, ProposalValidationError[]>,
  managedTasks: ReadonlyMap<string, Task>,
  createdTemporaryRefs: ReadonlySet<string>,
): void {
  for (const dependency of dependencies) {
    addTargetError(
      dependency.target,
      operationId,
      errorsByOperation,
      managedTasks,
      createdTemporaryRefs,
      "dependency_not_managed",
      "依存先タスク",
    );
  }
}

function sameDueValue(left: TaskDueValue, right: TaskDueValue): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "absent" && right.kind === "absent") {
    return true;
  }
  if (left.kind === "due_on" && right.kind === "due_on") {
    return left.due_on === right.due_on;
  }
  if (left.kind === "due_at" && right.kind === "due_at") {
    return left.due_at === right.due_at;
  }
  return false;
}

function sameParentValue(left: ProposalParentValue, right: ProposalParentValue): boolean {
  if (left.kind === "absent" && right.kind === "absent") {
    return true;
  }
  if (left.kind === "absent" || right.kind === "absent") {
    return false;
  }
  return isSameTarget(left, right);
}

function sameDependency(
  proposalDependency: ProposalDependency,
  currentDependency: ProposalDependency,
): boolean {
  return isSameTarget(proposalDependency.target, currentDependency.target)
    && proposalDependency.scope === currentDependency.scope
    && proposalDependency.source === currentDependency.source;
}

function sameDependencies(
  proposalDependencies: readonly ProposalDependency[],
  currentDependencies: readonly ProposalDependency[],
): boolean {
  if (proposalDependencies.length !== currentDependencies.length) {
    return false;
  }
  const usedCurrentIndexes = new Set<number>();
  for (const proposalDependency of proposalDependencies) {
    const currentIndex = currentDependencies.findIndex(
      (currentDependency, index) =>
        !usedCurrentIndexes.has(index)
        && sameDependency(proposalDependency, currentDependency),
    );
    if (currentIndex < 0) {
      return false;
    }
    usedCurrentIndexes.add(currentIndex);
  }
  return true;
}

function createTaskState(task: Task): TaskState {
  const dependencies = task.dependencies.map((dependency): ProposalDependency => ({
    target: { kind: "existing", gid: dependency.task_gid },
    scope: dependency.scope,
    source: dependency.source,
  }));
  const parent: ProposalParentValue = task.parent_gid == null
    ? { kind: "absent" }
    : { kind: "existing", gid: task.parent_gid };
  const due = createTaskDueValue(task);
  return {
    title: task.title,
    notes: task.notes,
    status: task.status,
    importance: task.importance,
    area: task.area,
    due,
    parent,
    parent_work_mode: task.parent_work_mode,
    dependencies,
    obsidian_links: task.obsidian_links,
    child_gids: task.child_gids,
  };
}

function createTaskDueValue(task: Task): TaskDueValue {
  if (task.due_on != null) {
    return { kind: "due_on", due_on: task.due_on };
  }
  if (task.due_at != null) {
    return { kind: "due_at", due_at: task.due_at };
  }
  return { kind: "absent" };
}

function createTemporaryTaskState(
  operation: Extract<ProposalOperation, { readonly operation: "create_task" }>,
): TaskState {
  const after = operation.after;
  return {
    title: after.title,
    notes: after.notes ?? "",
    status: after.status ?? "not_started",
    importance: after.importance ?? 3,
    area: after.area ?? unclassifiedArea,
    due: after.due ?? { kind: "absent" },
    parent: after.parent ?? { kind: "absent" },
    parent_work_mode: after.parent_work_mode ?? "unknown",
    dependencies: after.dependencies ?? [],
    obsidian_links: after.obsidian_links ?? [],
    child_gids: [],
  };
}

function collectTemporaryTaskStates(
  proposal: Proposal,
): ReadonlyMap<string, TaskState> {
  const states = new Map<string, TaskState>();
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (operation.operation === "create_task") {
        states.set(operation.temporary_ref, createTemporaryTaskState(operation));
      }
    }
  }
  return states;
}

function sameObsidianLink(left: ObsidianLink, right: ObsidianLink): boolean {
  return left.vault_id === right.vault_id
    && left.path === right.path
    && left.title === right.title
    && left.confidence === right.confidence;
}

function hasObsidianLink(task: TaskState, link: ObsidianLink): boolean {
  return task.obsidian_links.some((candidate) => sameObsidianLink(candidate, link));
}

function addBeforeMismatch(
  operationId: string,
  field: string,
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  addError(
    errorsByOperation,
    operationId,
    "before_value_mismatch",
    `変更前の${field}が基準タスクの値と一致しません。`,
  );
}

function validateBeforeValue(
  operation: Exclude<ProposalOperation, { readonly operation: "create_task" }>,
  task: TaskState,
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  switch (operation.operation) {
    case "update_title":
      if (task.title !== operation.before) {
        addBeforeMismatch(operation.operation_id, "タイトル", errorsByOperation);
      }
      return;
    case "update_notes":
      if (task.notes !== operation.before) {
        addBeforeMismatch(operation.operation_id, "本文", errorsByOperation);
      }
      return;
    case "set_status":
    case "complete":
    case "withdraw":
      if (task.status !== operation.before) {
        addBeforeMismatch(operation.operation_id, "状態", errorsByOperation);
      }
      return;
    case "set_importance":
      if (task.importance !== operation.before) {
        addBeforeMismatch(operation.operation_id, "重要度", errorsByOperation);
      }
      return;
    case "set_due":
    case "clear_due":
      if (!sameDueValue(task.due, operation.before)) {
        addBeforeMismatch(operation.operation_id, "期限", errorsByOperation);
      }
      return;
    case "set_area":
      if (task.area !== operation.before) {
        addBeforeMismatch(operation.operation_id, "領域", errorsByOperation);
      }
      return;
    case "set_dependencies":
      if (!sameDependencies(operation.before, task.dependencies)) {
        addBeforeMismatch(operation.operation_id, "依存関係", errorsByOperation);
      }
      return;
    case "set_parent":
      if (!sameParentValue(task.parent, operation.before)) {
        addBeforeMismatch(operation.operation_id, "親タスク", errorsByOperation);
      }
      return;
    case "set_parent_work_mode":
      if (task.parent_work_mode !== operation.before) {
        addBeforeMismatch(operation.operation_id, "親子作業モード", errorsByOperation);
      }
      return;
    case "link_obsidian":
      if (hasObsidianLink(task, operation.after)) {
        addBeforeMismatch(operation.operation_id, "Obsidianリンク", errorsByOperation);
      }
      return;
    case "unlink_obsidian":
      if (!hasObsidianLink(task, operation.before)) {
        addBeforeMismatch(operation.operation_id, "Obsidianリンク", errorsByOperation);
      }
      return;
  }
}

function validateArea(
  area: string | undefined,
  existingAreas: ReadonlySet<string>,
  operationId: string,
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  if (area == null || area === unclassifiedArea || existingAreas.has(area)) {
    return;
  }
  addError(
    errorsByOperation,
    operationId,
    "area_not_found",
    `領域 ${area} は現在存在する領域または未分類ではありません。`,
  );
}

function validateStatusEvidence(
  operation: Extract<ProposalOperation, { readonly operation: "complete" | "withdraw" }>,
  task: TaskState,
  managedTasks: ReadonlyMap<string, Task>,
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  const evidence = operation.status_evidence;
  if (evidence.kind === "external_structured_status") {
    const validStatus = operation.operation === "complete"
      ? evidence.status === "closed" || evidence.status === "completed"
      : evidence.status === "cancelled";
    if (!validStatus) {
      addError(
        errorsByOperation,
        operation.operation_id,
        "status_evidence_invalid",
        `${operation.operation === "complete" ? "完了" : "取り下げ"}操作に外部状態 ${evidence.status} は指定できません。`,
      );
    }
    return;
  }
  if (evidence.kind === "children_only_all_completed") {
    if (operation.operation !== "complete") {
      addError(
        errorsByOperation,
        operation.operation_id,
        "status_evidence_invalid",
        "children_onlyの全子タスク完了根拠は完了操作だけに指定できます。",
      );
      return;
    }
    if (task.parent_work_mode !== "children_only" || task.child_gids.length === 0) {
      addError(
        errorsByOperation,
        operation.operation_id,
        "status_evidence_invalid",
        "対象タスクはchildren_onlyで、完了済みの子タスクを1件以上持つ必要があります。",
      );
      return;
    }
    for (const childGid of task.child_gids) {
      const child = managedTasks.get(childGid);
      if (child == null || child.status !== "completed") {
        addError(
          errorsByOperation,
          operation.operation_id,
          "status_evidence_invalid",
          `子タスクGID ${childGid} が完了済みとして確認できません。`,
        );
      }
    }
  }
}

function validateReferences(
  context: OperationContext,
  managedTasks: ReadonlyMap<string, Task>,
  createdTemporaryRefs: ReadonlySet<string>,
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  const operation = context.operation;
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") {
      addTargetError(
        operation.creation.parent,
        operation.operation_id,
        errorsByOperation,
        managedTasks,
        createdTemporaryRefs,
        "parent_not_managed",
        "親タスク",
      );
    }
    if (operation.after.parent != null) {
      addTargetError(
        operation.after.parent,
        operation.operation_id,
        errorsByOperation,
        managedTasks,
        createdTemporaryRefs,
        "parent_not_managed",
        "親タスク",
      );
    }
    if (operation.after.dependencies != null) {
      addDependencyReferenceErrors(
        operation.after.dependencies,
        operation.operation_id,
        errorsByOperation,
        managedTasks,
        createdTemporaryRefs,
      );
    }
    return;
  }

  addTargetError(
    getOperationTarget(operation),
    operation.operation_id,
    errorsByOperation,
    managedTasks,
    createdTemporaryRefs,
    "target_not_managed",
    "対象タスク",
  );
  if (operation.operation === "set_dependencies") {
    addDependencyReferenceErrors(
      operation.after,
      operation.operation_id,
      errorsByOperation,
      managedTasks,
      createdTemporaryRefs,
    );
    return;
  }
  if (operation.operation === "set_parent") {
    addParentReferenceError(
      operation.after,
      operation.operation_id,
      errorsByOperation,
      managedTasks,
      createdTemporaryRefs,
    );
  }
}

function createFieldUpdates(context: OperationContext): readonly FieldUpdate[] {
  const operation = context.operation;
  if (operation.operation === "create_task") {
    const fields: string[] = ["title"];
    if (operation.after.notes != null) fields.push("notes");
    if (operation.after.status != null) fields.push("status");
    if (operation.after.importance != null) fields.push("importance");
    if (operation.after.area != null) fields.push("area");
    if (operation.after.due != null) fields.push("due");
    if (operation.after.parent != null) fields.push("parent");
    if (operation.after.parent_work_mode != null) fields.push("parent_work_mode");
    if (operation.after.dependencies != null) fields.push("dependencies");
    if (operation.after.obsidian_links != null) fields.push("obsidian_links");
    return fields.map((field) => ({
      key: `${getTargetKey({ kind: "temporary", ref: operation.temporary_ref })}:${field}`,
      group_id: context.group_id,
      operation_id: operation.operation_id,
      field,
    }));
  }
  const field = getOperationField(operation);
  return [{
    key: `${getTargetKey(operation.target)}:${field}`,
    group_id: context.group_id,
    operation_id: operation.operation_id,
    field,
  }];
}

function getOperationField(
  operation: Exclude<ProposalOperation, { readonly operation: "create_task" }>,
): string {
  switch (operation.operation) {
    case "update_title":
      return "title";
    case "update_notes":
      return "notes";
    case "set_status":
    case "complete":
    case "withdraw":
      return "status";
    case "set_importance":
      return "importance";
    case "set_due":
    case "clear_due":
      return "due";
    case "set_area":
      return "area";
    case "set_dependencies":
      return "dependencies";
    case "set_parent":
      return "parent";
    case "set_parent_work_mode":
      return "parent_work_mode";
    case "link_obsidian":
    case "unlink_obsidian":
      return "obsidian_links";
  }
}

function validateConflictingUpdates(
  contexts: readonly OperationContext[],
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  const updatesByKey = new Map<string, FieldUpdate[]>();
  for (const context of contexts) {
    for (const update of createFieldUpdates(context)) {
      const updates = updatesByKey.get(update.key);
      if (updates == null) {
        updatesByKey.set(update.key, [update]);
      } else {
        updates.push(update);
      }
    }
  }
  for (const updates of updatesByKey.values()) {
    if (updates.length < 2) {
      continue;
    }
    const first = updates[0];
    if (first == null) {
      throw new Error("競合更新の先頭操作がありません。");
    }
    for (const update of updates) {
      addError(
        errorsByOperation,
        update.operation_id,
        "conflicting_field_update",
        `タスクの${first.field}を複数操作で更新するため、変更案が競合しています。`,
      );
    }
  }
}

function collectCreatedTemporaryRefs(proposal: Proposal): ReadonlySet<string> {
  const refs = new Set<string>();
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (operation.operation === "create_task") {
        refs.add(operation.temporary_ref);
      }
    }
  }
  return refs;
}

function collectOperationContexts(proposal: Proposal): readonly OperationContext[] {
  const contexts: OperationContext[] = [];
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      contexts.push({ group_id: group.group_id, operation });
    }
  }
  return contexts;
}

function getCurrentTaskState(
  operation: Exclude<ProposalOperation, { readonly operation: "create_task" }>,
  managedTasks: ReadonlyMap<string, Task>,
  temporaryTaskStates: ReadonlyMap<string, TaskState>,
): TaskState | undefined {
  if (operation.target.kind === "temporary") {
    return temporaryTaskStates.get(operation.target.ref);
  }
  const task = managedTasks.get(operation.target.gid);
  return task == null ? undefined : createTaskState(task);
}

function validateOperation(
  context: OperationContext,
  baselineSnapshotHash: string,
  managedTasks: ReadonlyMap<string, Task>,
  existingAreas: ReadonlySet<string>,
  explicitSplitRequestLocators: ReadonlySet<string>,
  createdTemporaryRefs: ReadonlySet<string>,
  temporaryTaskStates: ReadonlyMap<string, TaskState>,
  errorsByOperation: Map<string, ProposalValidationError[]>,
): void {
  const operation = context.operation;
  if (operation.baseline_snapshot_hash !== baselineSnapshotHash) {
    addError(
      errorsByOperation,
      operation.operation_id,
      "baseline_snapshot_mismatch",
      "操作の基準スナップショットハッシュが検証入力と一致しません。",
    );
  }
  validateReferences(
    context,
    managedTasks,
    createdTemporaryRefs,
    errorsByOperation,
  );
  if (operation.operation === "create_task") {
    validateArea(
      operation.after.area,
      existingAreas,
      operation.operation_id,
      errorsByOperation,
    );
    if (
      operation.creation.kind === "split_child"
      && !explicitSplitRequestLocators.has(operation.creation.instruction_reference.locator)
    ) {
      addError(
        errorsByOperation,
        operation.operation_id,
        "split_request_not_explicit",
        "分割作成の根拠locatorが利用者の明示的な分割依頼に含まれていません。",
      );
    }
    return;
  }
  const task = getCurrentTaskState(operation, managedTasks, temporaryTaskStates);
  if (task == null) {
    if (operation.target.kind === "temporary") {
      addError(
        errorsByOperation,
        operation.operation_id,
        "target_not_managed",
        "一時参照先の作成状態を取得できないため、変更前値を検証できません。",
      );
    }
    return;
  }
  validateBeforeValue(operation, task, errorsByOperation);
  if (operation.operation === "set_area") {
    validateArea(operation.after, existingAreas, operation.operation_id, errorsByOperation);
  }
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    validateStatusEvidence(operation, task, managedTasks, errorsByOperation);
  }
}

function createOperationResults(
  contexts: readonly OperationContext[],
  errorsByOperation: ReadonlyMap<string, readonly ProposalValidationError[]>,
): readonly ProposalValidationOperationResult[] {
  return contexts.map((context) => {
    const errors = errorsByOperation.get(context.operation.operation_id);
    if (errors == null) {
      throw new Error(`操作ID ${context.operation.operation_id} の検証結果がありません。`);
    }
    if (errors.length === 0) {
      return {
        kind: "valid",
        group_id: context.group_id,
        operation_id: context.operation.operation_id,
      };
    }
    return {
      kind: "invalid",
      group_id: context.group_id,
      operation_id: context.operation.operation_id,
      errors: [...errors],
    };
  });
}

function createGroupResults(
  proposal: Proposal,
  errorsByOperation: ReadonlyMap<string, readonly ProposalValidationError[]>,
): readonly ProposalValidationGroupResult[] {
  return proposal.groups.map((group) => {
    const operationIds = group.operations.map((operation) => operation.operation_id);
    const validCount = operationIds.filter((operationId) => {
      const errors = errorsByOperation.get(operationId);
      if (errors == null) {
        throw new Error(`操作ID ${operationId} の検証結果がありません。`);
      }
      return errors.length === 0;
    }).length;
    const applicable = group.atomic
      ? validCount === operationIds.length
      : validCount > 0;
    return {
      group_id: group.group_id,
      atomic: group.atomic,
      applicable,
      operation_ids: operationIds,
    };
  });
}

/** AI変更案を現在の管理対象と基準値へ照合して基本検証します。 */
export function validateProposal(
  input: ProposalValidationInput,
): ProposalValidationResult {
  const parsedInput = proposalValidationInputSchema.parse(input);
  const managedTasks = new Map<string, Task>();
  for (const task of parsedInput.managed_tasks) {
    managedTasks.set(task.gid, task);
  }
  const existingAreas = new Set(parsedInput.existing_areas);
  const explicitSplitRequestLocators = new Set(
    parsedInput.explicit_split_request_locators,
  );
  const contexts = collectOperationContexts(parsedInput.proposal);
  const createdTemporaryRefs = collectCreatedTemporaryRefs(parsedInput.proposal);
  const temporaryTaskStates = collectTemporaryTaskStates(parsedInput.proposal);
  const errorsByOperation = new Map<string, ProposalValidationError[]>();
  for (const context of contexts) {
    errorsByOperation.set(context.operation.operation_id, []);
  }
  for (const context of contexts) {
    validateOperation(
      context,
      parsedInput.baseline_snapshot_hash,
      managedTasks,
      existingAreas,
      explicitSplitRequestLocators,
      createdTemporaryRefs,
      temporaryTaskStates,
      errorsByOperation,
    );
  }
  validateConflictingUpdates(contexts, errorsByOperation);
  return proposalValidationResultSchema.parse({
    operations: createOperationResults(contexts, errorsByOperation),
    groups: createGroupResults(parsedInput.proposal, errorsByOperation),
  });
}
