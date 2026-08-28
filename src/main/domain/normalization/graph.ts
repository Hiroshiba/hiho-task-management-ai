import {
  canonicalizeJson,
  cleanupItemSchema,
  dependenciesSchema,
  gidSchema,
  parentWorkModeSchema,
  taskStatusSchema,
  type BlockState,
  type CleanupItem,
  type Dependency,
  type DependencyScope,
  type ParentWorkMode,
  type TaskStatus,
} from "../../../shared/domain";

export type NormalizationTask = {
  readonly gid: string;
  readonly status: TaskStatus;
  readonly dependencies?: readonly Dependency[];
  readonly parent_gid?: string;
  readonly child_gids?: readonly string[];
  readonly parent_work_mode?: ParentWorkMode;
};

export type GraphNormalizationInput = {
  readonly tasks: readonly NormalizationTask[];
  readonly inaccessible_gids?: readonly string[];
};

export type DependencyBlockReason = {
  readonly kind: "dependency";
  readonly dependency_gid: string;
  readonly scope: DependencyScope;
  readonly cause: "unfinished" | "withdrawn" | "missing" | "inaccessible";
};

export type ParentBlockReason = {
  readonly kind: "parent";
  readonly parent_gid: string;
  readonly child_gid: string;
  readonly cause: "unfinished" | "withdrawn" | "missing" | "inaccessible";
};

export type CycleBlockReason = {
  readonly kind: "dependency_cycle" | "parent_cycle";
  readonly task_gids: readonly string[];
};

export type BlockReason =
  | DependencyBlockReason
  | ParentBlockReason
  | CycleBlockReason;

export type BlockStateResult = {
  readonly gid: string;
  readonly block_state: BlockState;
  readonly reasons: readonly BlockReason[];
  readonly dependency_reasons: readonly DependencyBlockReason[];
  readonly parent_reasons: readonly ParentBlockReason[];
  readonly dependency_cycle: boolean;
  readonly parent_cycle: boolean;
  readonly completion_confirmation: boolean;
};

export type GraphNormalizationResult = {
  readonly tasks: readonly BlockStateResult[];
  readonly cleanup_items: readonly CleanupItem[];
  readonly dependency_cycles: readonly (readonly string[])[];
  readonly parent_cycles: readonly (readonly string[])[];
};

type Adjacency = Map<string, string[]>;

type TaskIndex = Map<string, NormalizationTask>;

type Availability = "present" | "missing" | "inaccessible";

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 重複したタスクGIDを表すエラーです。 */
export class DuplicateTaskGidError extends Error {
  public constructor(taskGid: string) {
    super(`タスクGID ${taskGid} が重複しています。`);
    this.name = "DuplicateTaskGidError";
  }
}

/** 管理対象外のタスク参照を表すエラーです。 */
export class GraphTaskReferenceError extends Error {
  public constructor(taskGid: string) {
    super(`管理対象タスクGID ${taskGid} を参照できません。`);
    this.name = "GraphTaskReferenceError";
  }
}

/** 依存または親子関係の循環を表す専用エラーです。 */
export class RelationshipCycleError extends Error {
  public readonly relation: "dependency" | "parent";
  public readonly task_gids: readonly string[];

  public constructor(
    relation: "dependency" | "parent",
    taskGids: readonly string[],
  ) {
    const relationName = relation === "dependency" ? "依存関係" : "親子関係";
    super(`${relationName}の循環を作る変更は許可されません。`);
    this.name = "RelationshipCycleError";
    this.relation = relation;
    this.task_gids = taskGids;
  }
}

function validateTask(task: NormalizationTask): void {
  gidSchema.parse(task.gid);
  taskStatusSchema.parse(task.status);
  if (task.parent_gid != null) {
    gidSchema.parse(task.parent_gid);
  }
  if (task.child_gids != null) {
    const childGids = new Set<string>();
    for (const childGid of task.child_gids) {
      gidSchema.parse(childGid);
      if (childGids.has(childGid)) {
        throw new Error(`子タスクGID ${childGid} が重複しています。`);
      }
      childGids.add(childGid);
    }
  }
  if (task.parent_work_mode != null) {
    parentWorkModeSchema.parse(task.parent_work_mode);
  }
  if (task.dependencies != null) {
    dependenciesSchema.parse(task.dependencies);
  }
}

function indexTasks(tasks: readonly NormalizationTask[]): TaskIndex {
  const index = new Map<string, NormalizationTask>();
  for (const task of tasks) {
    validateTask(task);
    if (index.has(task.gid)) {
      throw new DuplicateTaskGidError(task.gid);
    }
    index.set(task.gid, task);
  }
  return index;
}

function createAdjacency(nodes: readonly string[]): Adjacency {
  const adjacency: Adjacency = new Map();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  return adjacency;
}

function addEdge(adjacency: Adjacency, from: string, to: string): void {
  const edges = adjacency.get(from);
  if (edges == null) {
    throw new GraphTaskReferenceError(from);
  }
  if (!edges.includes(to)) {
    edges.push(to);
  }
}

function dependencyAdjacency(index: TaskIndex): Adjacency {
  const nodes = [...index.keys()];
  const adjacency = createAdjacency(nodes);
  for (const task of index.values()) {
    for (const dependency of task.dependencies ?? []) {
      if (index.has(dependency.task_gid)) {
        addEdge(adjacency, task.gid, dependency.task_gid);
      }
    }
  }
  return adjacency;
}

function parentAdjacency(index: TaskIndex): Adjacency {
  const nodes = [...index.keys()];
  const adjacency = createAdjacency(nodes);
  for (const task of index.values()) {
    if (task.parent_gid != null && index.has(task.parent_gid)) {
      addEdge(adjacency, task.parent_gid, task.gid);
    }
    for (const childGid of task.child_gids ?? []) {
      if (index.has(childGid)) {
        addEdge(adjacency, task.gid, childGid);
      }
    }
  }
  return adjacency;
}

function findPath(
  adjacency: ReadonlyMap<string, readonly string[]>,
  start: string,
  target: string,
): readonly string[] | undefined {
  if (!adjacency.has(start) || !adjacency.has(target)) {
    return undefined;
  }

  const queue: string[][] = [[start]];
  const visited = new Set<string>([start]);
  while (queue.length > 0) {
    const path = queue.shift();
    if (path == null) {
      throw new Error("循環検出の探索キューが不正です。");
    }
    const current = path[path.length - 1];
    if (current == null) {
      throw new Error("循環検出の経路が空です。");
    }
    if (current === target) {
      return path;
    }
    const neighbors = adjacency.get(current);
    if (neighbors == null) {
      throw new GraphTaskReferenceError(current);
    }
    for (const neighbor of [...neighbors].sort(compareStrings)) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([...path, neighbor]);
      }
    }
  }
  return undefined;
}

function findStronglyConnectedComponents(
  adjacency: ReadonlyMap<string, readonly string[]>,
): readonly (readonly string[])[] {
  const indexByNode = new Map<string, number>();
  const lowLinkByNode = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string): void => {
    indexByNode.set(node, nextIndex);
    lowLinkByNode.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    const neighbors = adjacency.get(node);
    if (neighbors == null) {
      throw new GraphTaskReferenceError(node);
    }
    for (const neighbor of [...neighbors].sort(compareStrings)) {
      if (!indexByNode.has(neighbor)) {
        visit(neighbor);
        const currentLowLink = lowLinkByNode.get(node);
        const neighborLowLink = lowLinkByNode.get(neighbor);
        if (currentLowLink == null || neighborLowLink == null) {
          throw new Error("強連結成分の順位情報がありません。");
        }
        lowLinkByNode.set(node, Math.min(currentLowLink, neighborLowLink));
      } else if (onStack.has(neighbor)) {
        const currentLowLink = lowLinkByNode.get(node);
        const neighborIndex = indexByNode.get(neighbor);
        if (currentLowLink == null || neighborIndex == null) {
          throw new Error("強連結成分の探索情報がありません。");
        }
        lowLinkByNode.set(node, Math.min(currentLowLink, neighborIndex));
      }
    }

    const nodeIndex = indexByNode.get(node);
    const nodeLowLink = lowLinkByNode.get(node);
    if (nodeIndex == null || nodeLowLink == null) {
      throw new Error("強連結成分の結果情報がありません。");
    }
    if (nodeLowLink === nodeIndex) {
      const component: string[] = [];
      let member = stack.pop();
      while (member != null) {
        onStack.delete(member);
        component.push(member);
        if (member === node) {
          break;
        }
        member = stack.pop();
      }
      components.push(component.sort(compareStrings));
    }
  };

  for (const node of [...adjacency.keys()].sort(compareStrings)) {
    if (!indexByNode.has(node)) {
      visit(node);
    }
  }

  return components.sort((left, right) => {
    const leftFirst = left[0];
    const rightFirst = right[0];
    if (leftFirst == null || rightFirst == null) {
      throw new Error("空の強連結成分は許可されません。");
    }
    return compareStrings(leftFirst, rightFirst);
  });
}

function isCycleComponent(
  component: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
): boolean {
  if (component.length > 1) {
    return true;
  }
  const node = component[0];
  if (node == null) {
    throw new Error("空の循環成分は許可されません。");
  }
  return adjacency.get(node)?.includes(node) ?? false;
}

function cycleComponents(adjacency: Adjacency): readonly (readonly string[])[] {
  return findStronglyConnectedComponents(adjacency).filter((component) =>
    isCycleComponent(component, adjacency),
  );
}

function getAvailability(
  index: TaskIndex,
  inaccessibleGids: ReadonlySet<string>,
  taskGid: string,
): Availability {
  if (index.has(taskGid)) {
    return "present";
  }
  if (inaccessibleGids.has(taskGid)) {
    return "inaccessible";
  }
  return "missing";
}

function createDependencyCleanup(
  taskGid: string,
  dependencyGid: string,
  cause: "withdrawn" | "missing" | "inaccessible",
): CleanupItem {
  const causeMessage = {
    withdrawn: "取り下げられた",
    missing: "消失した",
    inaccessible: "アクセスできない",
  }[cause];
  const item: CleanupItem = {
    kind: "missing_dependency",
    task_gid: taskGid,
    related_task_gids: [dependencyGid],
    message: `依存先GID ${dependencyGid} は${causeMessage}ため、依存関係を要確認です。`,
  };
  return cleanupItemSchema.parse(item);
}

function createMissingChildCleanup(
  parentGid: string,
  childGid: string,
  cause: "withdrawn" | "missing" | "inaccessible",
): CleanupItem {
  const causeMessage = {
    withdrawn: "取り下げられた",
    missing: "消失した",
    inaccessible: "アクセスできない",
  }[cause];
  const item: CleanupItem = {
    kind: "missing_task",
    task_gid: parentGid,
    related_task_gids: [childGid],
    message: `子タスクGID ${childGid} は${causeMessage}ため、親子関係を要確認です。`,
  };
  return cleanupItemSchema.parse(item);
}

function createMissingParentCleanup(
  childGid: string,
  parentGid: string,
  cause: "withdrawn" | "missing" | "inaccessible",
): CleanupItem {
  const causeMessage = {
    withdrawn: "取り下げられた",
    missing: "消失した",
    inaccessible: "アクセスできない",
  }[cause];
  const item: CleanupItem = {
    kind: "missing_task",
    task_gid: childGid,
    related_task_gids: [parentGid],
    message: `親タスクGID ${parentGid} は${causeMessage}ため、親子関係を要確認です。`,
  };
  return cleanupItemSchema.parse(item);
}

function createCycleCleanup(
  kind: "dependency_cycle" | "parent_cycle",
  taskGids: readonly string[],
): CleanupItem {
  const message =
    kind === "dependency_cycle"
      ? "依存関係の循環を要確認です。"
      : "親子関係の循環を要確認です。";
  const item: CleanupItem = {
    kind,
    related_task_gids: [...taskGids],
    message,
  };
  return cleanupItemSchema.parse(item);
}

function createChildrenOnlyCompletionConfirmationCleanup(
  taskGid: string,
): CleanupItem {
  const item: CleanupItem = {
    kind: "children_only_completion_confirmation",
    task_gid: taskGid,
    message: `親タスクGID ${taskGid} はすべての子タスクが完了しているため、親タスクの完了を確認してください。`,
  };
  return cleanupItemSchema.parse(item);
}

function addParent(
  childrenByParent: Map<string, Set<string>>,
  parentGid: string,
  childGid: string,
): void {
  const children = childrenByParent.get(parentGid);
  if (children == null) {
    childrenByParent.set(parentGid, new Set([childGid]));
    return;
  }
  children.add(childGid);
}

function buildChildrenByParent(index: TaskIndex): Map<string, Set<string>> {
  const childrenByParent = new Map<string, Set<string>>();
  for (const task of index.values()) {
    if (task.parent_gid != null) {
      addParent(childrenByParent, task.parent_gid, task.gid);
    }
    for (const childGid of task.child_gids ?? []) {
      addParent(childrenByParent, task.gid, childGid);
    }
  }
  return childrenByParent;
}

function createParentRelationConflictCleanup(
  listedParentGid: string,
  child: NormalizationTask,
  declaredParentGid: string,
): CleanupItem {
  const item: CleanupItem = {
    kind: "parent_relation_conflict",
    task_gid: child.gid,
    related_task_gids: [listedParentGid, declaredParentGid],
    message: `親タスクGID ${listedParentGid} のchild_gidsと子タスクGID ${child.gid}のparent_gid ${declaredParentGid}が矛盾しています。`,
  };
  return cleanupItemSchema.parse(item);
}

function addParentRelationConflicts(
  index: TaskIndex,
  cleanupItems: CleanupItem[],
): void {
  for (const parent of index.values()) {
    for (const childGid of parent.child_gids ?? []) {
      const child = index.get(childGid);
      if (child == null || child.parent_gid == null || child.parent_gid === parent.gid) {
        continue;
      }
      cleanupItems.push(
        createParentRelationConflictCleanup(parent.gid, child, child.parent_gid),
      );
    }
  }
}

function compareDependencyReasons(
  left: DependencyBlockReason,
  right: DependencyBlockReason,
): number {
  const gidOrder = compareStrings(left.dependency_gid, right.dependency_gid);
  if (gidOrder !== 0) {
    return gidOrder;
  }
  return compareStrings(left.scope, right.scope);
}

function compareParentReasons(
  left: ParentBlockReason,
  right: ParentBlockReason,
): number {
  const parentOrder = compareStrings(left.parent_gid, right.parent_gid);
  if (parentOrder !== 0) {
    return parentOrder;
  }
  return compareStrings(left.child_gid, right.child_gid);
}

function strongerBlockState(
  dependencyState: BlockState,
  parentState: BlockState,
): BlockState {
  if (dependencyState === "full" || parentState === "full") {
    return "full";
  }
  if (dependencyState === "partial" || parentState === "partial") {
    return "partial";
  }
  return "none";
}

function getDependencyBlockState(
  reasons: readonly DependencyBlockReason[],
  hasCycle: boolean,
): BlockState {
  if (hasCycle || reasons.some((reason) => reason.scope === "full")) {
    return "full";
  }
  if (reasons.length > 0) {
    return "partial";
  }
  return "none";
}

function getParentBlockState(
  reasons: readonly ParentBlockReason[],
  parentWorkMode: ParentWorkMode,
  hasCycle: boolean,
): BlockState {
  if (hasCycle || (reasons.length > 0 && parentWorkMode === "children_only")) {
    return "full";
  }
  if (reasons.length > 0) {
    return "partial";
  }
  return "none";
}

function normalizeInaccessibleGids(
  inaccessibleGids: readonly string[] | undefined,
): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const gid of inaccessibleGids ?? []) {
    gidSchema.parse(gid);
    normalized.add(gid);
  }
  return normalized;
}

function addDependencyReasons(
  task: NormalizationTask,
  index: TaskIndex,
  inaccessibleGids: ReadonlySet<string>,
  cleanupItems: CleanupItem[],
): DependencyBlockReason[] {
  const reasons: DependencyBlockReason[] = [];
  const dependencies = [...(task.dependencies ?? [])].sort((left, right) => {
    const gidOrder = compareStrings(left.task_gid, right.task_gid);
    if (gidOrder !== 0) {
      return gidOrder;
    }
    return compareStrings(left.scope, right.scope);
  });
  for (const dependency of dependencies) {
    const availability = getAvailability(index, inaccessibleGids, dependency.task_gid);
    if (availability === "present") {
      const dependencyTask = index.get(dependency.task_gid);
      if (dependencyTask == null) {
        throw new GraphTaskReferenceError(dependency.task_gid);
      }
      if (dependencyTask.status === "completed") {
        continue;
      }
      const cause = dependencyTask.status === "withdrawn" ? "withdrawn" : "unfinished";
      reasons.push({
        kind: "dependency",
        dependency_gid: dependency.task_gid,
        scope: dependency.scope,
        cause,
      });
      if (cause === "withdrawn") {
        cleanupItems.push(createDependencyCleanup(task.gid, dependency.task_gid, cause));
      }
      continue;
    }

    const cause = availability;
    reasons.push({
      kind: "dependency",
      dependency_gid: dependency.task_gid,
      scope: dependency.scope,
      cause,
    });
    cleanupItems.push(createDependencyCleanup(task.gid, dependency.task_gid, cause));
  }
  return reasons.sort(compareDependencyReasons);
}

function addParentReasons(
  task: NormalizationTask,
  childrenByParent: ReadonlyMap<string, ReadonlySet<string>>,
  index: TaskIndex,
  inaccessibleGids: ReadonlySet<string>,
  cleanupItems: CleanupItem[],
): {
  readonly reasons: ParentBlockReason[];
  readonly hasChildren: boolean;
  readonly allChildrenCompleted: boolean;
} {
  const childGids = [...(childrenByParent.get(task.gid) ?? new Set<string>())].sort(
    compareStrings,
  );
  const reasons: ParentBlockReason[] = [];
  let allChildrenCompleted = childGids.length > 0;
  for (const childGid of childGids) {
    const availability = getAvailability(index, inaccessibleGids, childGid);
    if (availability === "present") {
      const childTask = index.get(childGid);
      if (childTask == null) {
        throw new GraphTaskReferenceError(childGid);
      }
      if (childTask.status === "completed") {
        continue;
      }
      allChildrenCompleted = false;
      const cause = childTask.status === "withdrawn" ? "withdrawn" : "unfinished";
      reasons.push({
        kind: "parent",
        parent_gid: task.gid,
        child_gid: childGid,
        cause,
      });
      if (cause === "withdrawn") {
        cleanupItems.push(createMissingChildCleanup(task.gid, childGid, cause));
      }
      continue;
    }

    allChildrenCompleted = false;
    const cause = availability;
    reasons.push({
      kind: "parent",
      parent_gid: task.gid,
      child_gid: childGid,
      cause,
    });
    cleanupItems.push(createMissingChildCleanup(task.gid, childGid, cause));
  }
  return {
    reasons: reasons.sort(compareParentReasons),
    hasChildren: childGids.length > 0,
    allChildrenCompleted,
  };
}

function addMissingParentReferences(
  index: TaskIndex,
  inaccessibleGids: ReadonlySet<string>,
  cleanupItems: CleanupItem[],
): void {
  for (const task of index.values()) {
    if (task.parent_gid == null) {
      continue;
    }
    const availability = getAvailability(index, inaccessibleGids, task.parent_gid);
    if (availability === "present") {
      continue;
    }
    cleanupItems.push(createMissingParentCleanup(task.gid, task.parent_gid, availability));
  }
}

function uniqueCleanupItems(items: readonly CleanupItem[]): readonly CleanupItem[] {
  const serialized = new Set<string>();
  const unique: CleanupItem[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!serialized.has(key)) {
      serialized.add(key);
      unique.push(item);
    }
  }
  return unique.sort((left, right) =>
    compareStrings(canonicalizeJson(left), canonicalizeJson(right)),
  );
}

/** 依存と親子関係から各タスクのブロック状態を正規化します。 */
export function normalizeTaskGraph(
  input: GraphNormalizationInput,
): GraphNormalizationResult {
  const index = indexTasks(input.tasks);
  const inaccessibleGids = normalizeInaccessibleGids(input.inaccessible_gids);
  const dependencyAdjacencyMap = dependencyAdjacency(index);
  const parentAdjacencyMap = parentAdjacency(index);
  const dependencyCycles = cycleComponents(dependencyAdjacencyMap);
  const parentCycles = cycleComponents(parentAdjacencyMap);
  const dependencyCycleGids = new Set(dependencyCycles.flat());
  const parentCycleGids = new Set(parentCycles.flat());
  const childrenByParent = buildChildrenByParent(index);
  const cleanupItems: CleanupItem[] = [];

  for (const cycle of dependencyCycles) {
    cleanupItems.push(createCycleCleanup("dependency_cycle", cycle));
  }
  for (const cycle of parentCycles) {
    cleanupItems.push(createCycleCleanup("parent_cycle", cycle));
  }
  addParentRelationConflicts(index, cleanupItems);
  addMissingParentReferences(index, inaccessibleGids, cleanupItems);

  const results: BlockStateResult[] = [];
  for (const task of [...index.values()].sort((left, right) =>
    compareStrings(left.gid, right.gid),
  )) {
    const dependencyReasons = addDependencyReasons(
      task,
      index,
      inaccessibleGids,
      cleanupItems,
    );
    const parentReasonResult = addParentReasons(
      task,
      childrenByParent,
      index,
      inaccessibleGids,
      cleanupItems,
    );
    const dependencyCycle = dependencyCycleGids.has(task.gid);
    const parentCycle = parentCycleGids.has(task.gid);
    const parentWorkMode = task.parent_work_mode ?? "unknown";
    const dependencyState = getDependencyBlockState(
      dependencyReasons,
      dependencyCycle,
    );
    const parentState = getParentBlockState(
      parentReasonResult.reasons,
      parentWorkMode,
      parentCycle,
    );
    const parentIsActive =
      task.status === "not_started" || task.status === "in_progress";
    const completionConfirmation =
      parentIsActive &&
      parentWorkMode === "children_only" &&
      parentReasonResult.hasChildren &&
      parentReasonResult.allChildrenCompleted &&
      !parentCycle;
    if (completionConfirmation) {
      cleanupItems.push(
        createChildrenOnlyCompletionConfirmationCleanup(task.gid),
      );
    }
    const reasons: BlockReason[] = [
      ...dependencyReasons,
      ...parentReasonResult.reasons,
    ];
    if (dependencyCycle) {
      const cycle = dependencyCycles.find((candidate) => candidate.includes(task.gid));
      if (cycle == null) {
        throw new Error("依存循環のタスクGIDが取得できません。");
      }
      reasons.push({ kind: "dependency_cycle", task_gids: cycle });
    }
    if (parentCycle) {
      const cycle = parentCycles.find((candidate) => candidate.includes(task.gid));
      if (cycle == null) {
        throw new Error("親子循環のタスクGIDが取得できません。");
      }
      reasons.push({ kind: "parent_cycle", task_gids: cycle });
    }
    results.push({
      gid: task.gid,
      block_state: strongerBlockState(dependencyState, parentState),
      reasons,
      dependency_reasons: dependencyReasons,
      parent_reasons: parentReasonResult.reasons,
      dependency_cycle: dependencyCycle,
      parent_cycle: parentCycle,
      completion_confirmation: completionConfirmation,
    });
  }

  return {
    tasks: results,
    cleanup_items: uniqueCleanupItems(cleanupItems),
    dependency_cycles: dependencyCycles,
    parent_cycles: parentCycles,
  };
}

/** 仮追加する依存辺が循環を作らないことを検証します。 */
export function assertNoDependencyCycle(
  tasks: readonly NormalizationTask[],
  dependentGid: string,
  dependencyGid: string,
): void {
  const index = indexTasks(tasks);
  gidSchema.parse(dependentGid);
  gidSchema.parse(dependencyGid);
  if (!index.has(dependentGid)) {
    throw new GraphTaskReferenceError(dependentGid);
  }
  if (!index.has(dependencyGid)) {
    throw new GraphTaskReferenceError(dependencyGid);
  }
  const adjacency = dependencyAdjacency(index);
  addEdge(adjacency, dependentGid, dependencyGid);
  const path = findPath(adjacency, dependencyGid, dependentGid);
  if (path != null) {
    throw new RelationshipCycleError("dependency", path);
  }
}

/** 仮追加する親子辺が循環を作らないことを検証します。 */
export function assertNoParentCycle(
  tasks: readonly NormalizationTask[],
  parentGid: string,
  childGid: string,
): void {
  const index = indexTasks(tasks);
  gidSchema.parse(parentGid);
  gidSchema.parse(childGid);
  if (!index.has(parentGid)) {
    throw new GraphTaskReferenceError(parentGid);
  }
  if (!index.has(childGid)) {
    throw new GraphTaskReferenceError(childGid);
  }
  const adjacency = parentAdjacency(index);
  addEdge(adjacency, parentGid, childGid);
  const path = findPath(adjacency, childGid, parentGid);
  if (path != null) {
    throw new RelationshipCycleError("parent", path);
  }
}
