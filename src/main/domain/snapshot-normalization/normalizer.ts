import {
  asanaTaskResponseSchema,
  canonicalizeJson,
  cleanupItemSchema,
  taskSchema,
  type AsanaTaskResponse,
  type CleanupItem,
  type CustomExternalData,
  type Dependency,
  type ObsidianLink,
  type ParentWorkMode,
  type Task,
  type TaskStatus,
  type TaskTag,
} from "../../../shared/domain";
import {
  ingestAsanaExternalData,
  type ExternalDataIngestionResult,
} from "../external-data-ingestion";
import {
  normalizeTaskGraph,
  normalizeTaskTags,
  reconcileTaskStatus,
  type ActiveTaskStatus,
  type GraphNormalizationResult,
  type PreviousStatusSnapshot,
  type StatusObservation,
  type StatusReconciliationResult,
  type StatusSectionConfiguration,
} from "../normalization";
import {
  asanaSnapshotNormalizationInputSchema,
  asanaSnapshotNormalizationResultSchema,
  type SnapshotCriticalError,
  type SnapshotExternalDataInitializationRequest,
  type SnapshotNormalizationInput,
  type SnapshotNormalizationResult,
  type SnapshotExternalDataWritePlan,
  type SnapshotStatusPlan,
  type SnapshotTagPlan,
} from "./schemas";

type ExternalProjection = {
  readonly parent_work_mode: ParentWorkMode;
  readonly dependencies: readonly Dependency[];
  readonly obsidian_links: readonly ObsidianLink[];
  readonly activity_anchor_on: string;
  readonly graph_parent_work_mode: ParentWorkMode;
  readonly graph_dependencies: readonly Dependency[];
  readonly critical_code?: SnapshotCriticalError["code"];
  readonly cleanup_item?: CleanupItem;
};

type StatusProjection = {
  readonly plan: SnapshotStatusPlan;
  readonly status: TaskStatus;
  readonly section_gid: string;
  readonly completed: boolean;
  readonly last_active_status_update:
    | { readonly kind: "set"; readonly value: ActiveTaskStatus }
    | undefined;
};

type MembershipState = "valid" | "missing" | "multiple";

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function previousStatusSnapshot(
  task: Task | undefined,
): PreviousStatusSnapshot | undefined {
  if (task == null) {
    return undefined;
  }
  const snapshot = {
    status: task.status,
    completed: task.completed,
    section_gid: task.section_gid,
  } satisfies PreviousStatusSnapshot;
  return snapshot;
}

function previousLastActiveStatus(
  task: Task | undefined,
): ActiveTaskStatus | undefined {
  if (task?.status === "not_started" || task?.status === "in_progress") {
    return task.status;
  }
  return undefined;
}

function statusFromRawTask(task: AsanaTaskResponse): TaskStatus {
  return task.completed ? "completed" : "not_started";
}

function createObservation(
  task: AsanaTaskResponse,
  projectGid: string,
): StatusObservation {
  const membership = task.memberships.find(
    (candidate) => candidate.project.gid === projectGid,
  );
  if (membership == null) {
    throw new Error("専用プロジェクト所属の状態を取得できません。");
  }
  if (membership.section == null) {
    return { completed: task.completed };
  }
  return {
    section_gid: membership.section.gid,
    section_name: membership.section.name,
    completed: task.completed,
  };
}

function createReconciledStatusPlan(
  result: Extract<StatusReconciliationResult, { kind: "reconciled" }>,
): SnapshotStatusPlan {
  const plan: SnapshotStatusPlan = {
    kind: "reconciled",
    task_gid: result.task_gid,
    status: result.status,
    section_gid: result.section_gid,
    completed: result.completed,
    writes: [...result.writes],
    warnings: [...result.warnings],
  };
  if (result.notification != null) {
    return { ...plan, notification: result.notification };
  }
  return plan;
}

function createStatusProjection(
  task: AsanaTaskResponse,
  sections: StatusSectionConfiguration,
  previous: Task | undefined,
  lastActiveStatus: ActiveTaskStatus | undefined,
  membershipState: MembershipState,
  observation: StatusObservation,
): StatusProjection {
  if (membershipState === "missing" || membershipState === "multiple") {
    const status = previous?.status ?? statusFromRawTask(task);
    const plan: SnapshotStatusPlan = {
      kind: "invalid_membership",
      task_gid: task.gid,
      status,
      section_gid: sections.not_started,
      completed: task.completed,
      writes: [],
      warnings: [],
      membership: membershipState,
    };
    return {
      plan,
      status,
      section_gid: sections.not_started,
      completed: task.completed,
      last_active_status_update: undefined,
    };
  }

  const previousSnapshot = previousStatusSnapshot(previous);
  const reconciliationInput: {
    readonly task_gid: string;
    readonly sections: StatusSectionConfiguration;
    readonly current: StatusObservation;
    readonly previous?: PreviousStatusSnapshot;
    readonly last_active_status?: ActiveTaskStatus;
  } = {
    task_gid: task.gid,
    sections,
    current: observation,
    ...(previousSnapshot == null ? {} : { previous: previousSnapshot }),
    ...(lastActiveStatus == null ? {} : { last_active_status: lastActiveStatus }),
  };
  const result = reconcileTaskStatus(reconciliationInput);
  if (result.kind === "reconciled") {
    return {
      plan: createReconciledStatusPlan(result),
      status: result.status,
      section_gid: result.section_gid,
      completed: result.completed,
      last_active_status_update:
        result.last_active_status.kind === "set"
          ? { kind: "set", value: result.last_active_status.value }
          : undefined,
    };
  }

  const status = previous?.status ?? statusFromRawTask(task);
  const plan: SnapshotStatusPlan = {
    kind: "requires_cleanup",
    task_gid: result.task_gid,
    section_gid: result.section_gid,
    completed: result.completed,
    writes: [],
    warnings: [],
    cleanup_item: result.cleanup_item,
  };
  return {
    plan,
    status,
    section_gid: result.section_gid,
    completed: result.completed,
    last_active_status_update: undefined,
  };
}

function dateInJst(isoDateTime: string): string {
  const epoch = Date.parse(isoDateTime);
  if (Number.isNaN(epoch)) {
    throw new Error("Asana作成日時を日付へ変換できません。");
  }
  const jstDate = new Date(epoch + 9 * 60 * 60 * 1000);
  const year = String(jstDate.getUTCFullYear()).padStart(4, "0");
  const month = String(jstDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(jstDate.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sortDependencies(
  dependencies: readonly Dependency[],
): Dependency[] {
  return [...dependencies].sort((left, right) => {
    const taskOrder = compareStrings(left.task_gid, right.task_gid);
    if (taskOrder !== 0) {
      return taskOrder;
    }
    const scopeOrder = compareStrings(left.scope, right.scope);
    if (scopeOrder !== 0) {
      return scopeOrder;
    }
    return compareStrings(left.source, right.source);
  });
}

function sortObsidianLinks(
  links: readonly ObsidianLink[],
): ObsidianLink[] {
  return [...links].sort((left, right) => {
    const vaultOrder = compareStrings(left.vault_id, right.vault_id);
    if (vaultOrder !== 0) {
      return vaultOrder;
    }
    const pathOrder = compareStrings(left.path, right.path);
    if (pathOrder !== 0) {
      return pathOrder;
    }
    const titleOrder = compareStrings(left.title, right.title);
    if (titleOrder !== 0) {
      return titleOrder;
    }
    return left.confidence - right.confidence;
  });
}

function cloneExternalMetadata(data: CustomExternalData): ExternalProjection {
  return {
    parent_work_mode: data.parent_work_mode,
    dependencies: sortDependencies(data.dependencies),
    obsidian_links: sortObsidianLinks(data.obsidian_links),
    activity_anchor_on: data.activity_anchor_on,
    graph_parent_work_mode: data.parent_work_mode,
    graph_dependencies: sortDependencies(data.dependencies),
  };
}

function defaultExternalMetadata(
  task: AsanaTaskResponse,
): ExternalProjection {
  return {
    parent_work_mode: "unknown",
    dependencies: [],
    obsidian_links: [],
    activity_anchor_on: dateInJst(task.created_at),
    graph_parent_work_mode: "unknown",
    graph_dependencies: [],
  };
}

function previousExternalMetadata(
  task: AsanaTaskResponse,
  previous: Task | undefined,
): ExternalProjection {
  if (previous == null) {
    return defaultExternalMetadata(task);
  }
  return {
    parent_work_mode: previous.parent_work_mode,
    dependencies: sortDependencies(previous.dependencies),
    obsidian_links: sortObsidianLinks(previous.obsidian_links),
    activity_anchor_on: previous.activity_anchor_on,
    graph_parent_work_mode: "unknown",
    graph_dependencies: [],
  };
}

function externalCriticalCode(
  ingestion: Exclude<ExternalDataIngestionResult, { kind: "valid" | "missing" }>,
): SnapshotCriticalError["code"] {
  switch (ingestion.kind) {
    case "broken":
      return "custom_external_data_broken";
    case "unknown_version":
      return "custom_external_data_unknown_schema";
    case "identity_mismatch":
      return "custom_external_data_identity_mismatch";
  }
}

function createExternalCleanupItem(
  taskGid: string,
  ingestion: Exclude<ExternalDataIngestionResult, { kind: "valid" | "missing" }>,
): CleanupItem {
  const item: CleanupItem =
    ingestion.kind === "identity_mismatch"
      ? {
          kind: "oauth_app_mismatch",
          task_gid: taskGid,
          message: "同一のAsana OAuthアプリ設定を確認してください。",
        }
      : {
          kind: "custom_external_data_broken",
          task_gid: taskGid,
          message: "Custom external dataを読み取れないため、要確認です。",
        };
  return cleanupItemSchema.parse(item);
}

function projectExternalData(
  task: AsanaTaskResponse,
  ingestion: ExternalDataIngestionResult,
  previous: Task | undefined,
): ExternalProjection {
  switch (ingestion.kind) {
    case "valid":
      return cloneExternalMetadata(ingestion.data);
    case "missing":
      return defaultExternalMetadata(task);
    case "broken":
    case "unknown_version":
    case "identity_mismatch":
      return {
        ...previousExternalMetadata(task, previous),
        critical_code: externalCriticalCode(ingestion),
        cleanup_item: createExternalCleanupItem(task.gid, ingestion),
      };
  }
}

function createBaseTask(
  task: AsanaTaskResponse,
  status: StatusProjection,
  external: ExternalProjection,
  childGids: readonly string[],
): Task {
  const optionalValues: {
    readonly due_on?: string;
    readonly due_at?: string;
    readonly parent_gid?: string;
  } = {
    ...(task.due_on == null ? {} : { due_on: task.due_on }),
    ...(task.due_at == null ? {} : { due_at: task.due_at }),
    ...(task.parent == null ? {} : { parent_gid: task.parent.gid }),
  };
  const base = {
    gid: task.gid,
    title: task.name,
    notes: task.notes,
    status: status.status,
    importance: 3,
    area: "未分類",
    block_state: "none",
    parent_work_mode: external.parent_work_mode,
    section_gid: status.section_gid,
    completed: status.completed,
    tags: task.tags.map(
      (tag): TaskTag => ({ gid: tag.gid, name: tag.name }),
    ),
    child_gids: [...childGids],
    dependencies: [...external.dependencies],
    obsidian_links: [...external.obsidian_links],
    activity_anchor_on: external.activity_anchor_on,
    created_at: task.created_at,
    modified_at: task.modified_at,
    ...optionalValues,
  };
  return taskSchema.parse(base);
}

function createChildGidsByParent(
  tasks: readonly AsanaTaskResponse[],
): ReadonlyMap<string, readonly string[]> {
  const childGidsByParent = new Map<string, string[]>();
  for (const task of tasks) {
    childGidsByParent.set(task.gid, []);
  }
  for (const task of tasks) {
    if (task.parent == null) {
      continue;
    }
    const childGids = childGidsByParent.get(task.parent.gid);
    if (childGids == null) {
      continue;
    }
    childGids.push(task.gid);
  }
  for (const childGids of childGidsByParent.values()) {
    childGids.sort(compareStrings);
  }
  return childGidsByParent;
}

function findGraphTask(
  graph: GraphNormalizationResult,
  taskGid: string,
): GraphNormalizationResult["tasks"][number] {
  const result = graph.tasks.find((candidate) => candidate.gid === taskGid);
  if (result == null) {
    throw new Error("グラフ正規化結果からタスクを取得できません。");
  }
  return result;
}

function normalizeTags(
  task: Task,
  blockState: GraphNormalizationResult["tasks"][number]["block_state"],
): {
  readonly task: Task;
  readonly plan: SnapshotTagPlan;
  readonly cleanup: readonly SnapshotNormalizationResult["cleanup_items"][number][];
} {
  const result = normalizeTaskTags({
    task_gid: task.gid,
    tags: task.tags,
    block_state: blockState,
  });
  const normalizedTags = [...result.retained_tags].sort((left, right) =>
    compareStrings(left.gid, right.gid),
  );
  const normalizedTask = taskSchema.parse({
    ...task,
    importance: result.importance,
    area: result.area,
    block_state: result.block_state,
    tags: normalizedTags,
  });
  const plan: SnapshotTagPlan = {
    task_gid: task.gid,
    added_tag_names: [...result.added_tag_names].sort(compareStrings),
    removed_tag_gids: sortedUnique(result.removed_tag_gids),
  };
  return {
    task: normalizedTask,
    plan,
    cleanup: result.cleanup_items,
  };
}

function uniqueCleanupItems(
  items: readonly SnapshotNormalizationResult["cleanup_items"][number][],
): SnapshotNormalizationResult["cleanup_items"] {
  const byValue = new Map<string, SnapshotNormalizationResult["cleanup_items"][number]>();
  for (const item of items) {
    byValue.set(canonicalizeJson(item), item);
  }
  return [...byValue.values()].sort((left, right) =>
    compareStrings(canonicalizeJson(left), canonicalizeJson(right)),
  );
}

function uniqueCriticalErrors(
  errors: readonly SnapshotCriticalError[],
): SnapshotCriticalError[] {
  const byKey = new Map<string, SnapshotCriticalError>();
  for (const error of errors) {
    byKey.set(`${error.task_gid}\u0000${error.code}`, error);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftKey = `${left.task_gid}\u0000${left.code}`;
    const rightKey = `${right.task_gid}\u0000${right.code}`;
    return compareStrings(leftKey, rightKey);
  });
}

function membershipState(
  task: AsanaTaskResponse,
  projectGid: string,
): MembershipState {
  const directMemberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (directMemberships.length === 1) {
    return "valid";
  }
  if (directMemberships.length === 0) {
    return "missing";
  }
  return "multiple";
}

function createMembershipStatusProjection(
  task: AsanaTaskResponse,
  projectGid: string,
  sections: StatusSectionConfiguration,
  previous: Task | undefined,
  ingestion: ExternalDataIngestionResult,
): StatusProjection {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  let state: MembershipState = "multiple";
  if (memberships.length === 0) {
    state = "missing";
  } else if (memberships.length === 1) {
    state = "valid";
  }
  if (state !== "valid") {
    return createStatusProjection(
      task,
      sections,
      previous,
      previousLastActiveStatus(previous),
      state,
      { completed: task.completed },
    );
  }
  const lastActiveStatus =
    ingestion.kind === "valid"
      ? ingestion.data.last_active_status
      : previousLastActiveStatus(previous);
  return createStatusProjection(
    task,
    sections,
    previous,
    lastActiveStatus,
    state,
    createObservation(task, projectGid),
  );
}

function addGraphCriticalErrors(
  graph: GraphNormalizationResult,
  errors: SnapshotCriticalError[],
): void {
  for (const graphTask of graph.tasks) {
    if (graphTask.dependency_cycle) {
      errors.push({ task_gid: graphTask.gid, code: "dependency_cycle" });
    }
    if (graphTask.parent_cycle) {
      errors.push({ task_gid: graphTask.gid, code: "parent_cycle" });
    }
  }
}

function createInitializationRequest(
  task: AsanaTaskResponse,
  status: StatusProjection,
  external: ExternalProjection,
  ingestion: ExternalDataIngestionResult,
  membership: MembershipState,
): SnapshotExternalDataInitializationRequest | undefined {
  if (
    ingestion.kind !== "missing" ||
    membership !== "valid" ||
    status.plan.kind !== "reconciled"
  ) {
    return undefined;
  }
  const lastActiveStatus: ActiveTaskStatus =
    status.status === "not_started" || status.status === "in_progress"
      ? status.status
      : "not_started";
  return {
    task_gid: task.gid,
    last_active_status: lastActiveStatus,
    activity_anchor_on: external.activity_anchor_on,
    created_via: "asana",
  };
}

function createCriticalMembershipError(
  taskGid: string,
  membership: MembershipState,
): SnapshotCriticalError | undefined {
  if (membership === "valid") {
    return undefined;
  }
  return {
    task_gid: taskGid,
    code:
      membership === "missing"
        ? "project_membership_missing"
        : "project_membership_multiple",
  };
}

/** 同期済みAsanaタスクを純粋な正規化計画へ変換します。 */
export function normalizeAsanaSnapshot(
  input: SnapshotNormalizationInput,
): SnapshotNormalizationResult {
  const validatedInput = asanaSnapshotNormalizationInputSchema.parse(input);
  const previousByGid = new Map(
    validatedInput.previous_tasks.map((task) => [task.gid, task]),
  );
  const sortedTasks = [...validatedInput.tasks].sort((left, right) =>
    compareStrings(left.gid, right.gid),
  );
  const childGidsByParent = createChildGidsByParent(sortedTasks);
  const statusPlans: SnapshotStatusPlan[] = [];
  const lastActiveStatusUpdates: SnapshotExternalDataWritePlan["last_active_status_updates"] = [];
  const initializationRequests: SnapshotExternalDataInitializationRequest[] = [];
  const tagPlans: SnapshotTagPlan[] = [];
  const normalizedTasks: Task[] = [];
  const cleanupItems: SnapshotNormalizationResult["cleanup_items"] = [];
  const criticalErrors: SnapshotCriticalError[] = [];
  const graphInputs: {
    readonly gid: string;
    readonly status: TaskStatus;
    readonly dependencies: readonly Dependency[];
    readonly parent_gid?: string;
    readonly child_gids: readonly string[];
    readonly parent_work_mode: ParentWorkMode;
  }[] = [];
  const baseTasksByGid = new Map<string, Task>();

  for (const task of sortedTasks) {
    const parsedTask = asanaTaskResponseSchema.parse(task);
    const previous = previousByGid.get(parsedTask.gid);
    const ingestion = ingestAsanaExternalData(parsedTask);
    const external = projectExternalData(parsedTask, ingestion, previous);
    const status = createMembershipStatusProjection(
      parsedTask,
      validatedInput.project_gid,
      validatedInput.section_gids,
      previous,
      ingestion,
    );
    const membership = membershipState(parsedTask, validatedInput.project_gid);
    const childGids = childGidsByParent.get(parsedTask.gid);
    if (childGids == null) {
      throw new Error("Asanaタスクの子タスクGIDを構築できません。");
    }
    const baseTask = createBaseTask(parsedTask, status, external, childGids);
    baseTasksByGid.set(baseTask.gid, baseTask);
    graphInputs.push({
      gid: baseTask.gid,
      status: baseTask.status,
      dependencies: external.graph_dependencies,
      ...(baseTask.parent_gid == null ? {} : { parent_gid: baseTask.parent_gid }),
      child_gids: baseTask.child_gids,
      parent_work_mode: external.graph_parent_work_mode,
    });
    statusPlans.push(status.plan);
    if (ingestion.kind === "valid" && status.plan.kind === "reconciled") {
      if (status.last_active_status_update != null) {
        lastActiveStatusUpdates.push({
          task_gid: parsedTask.gid,
          update: status.last_active_status_update,
        });
      }
    } else if (status.plan.kind === "requires_cleanup") {
      cleanupItems.push(status.plan.cleanup_item);
      criticalErrors.push({
        task_gid: parsedTask.gid,
        code: "unknown_status_section",
      });
    }
    const membershipError = createCriticalMembershipError(
      parsedTask.gid,
      membership,
    );
    if (membershipError != null) {
      criticalErrors.push(membershipError);
    }
    if (external.critical_code != null) {
      criticalErrors.push({
        task_gid: parsedTask.gid,
        code: external.critical_code,
      });
      if (external.cleanup_item != null) {
        cleanupItems.push(external.cleanup_item);
      }
    }
    const initialization = createInitializationRequest(
      parsedTask,
      status,
      external,
      ingestion,
      membership,
    );
    if (initialization != null) {
      initializationRequests.push(initialization);
    }
  }

  const graph = normalizeTaskGraph({
    tasks: graphInputs,
    inaccessible_gids: validatedInput.inaccessible_gids,
  });
  addGraphCriticalErrors(graph, criticalErrors);
  cleanupItems.push(...graph.cleanup_items);

  for (const task of sortedTasks) {
    const baseTask = baseTasksByGid.get(task.gid);
    if (baseTask == null) {
      throw new Error("タスク正規化の基礎値を取得できません。");
    }
    const graphTask = findGraphTask(graph, task.gid);
    const tagged = normalizeTags(baseTask, graphTask.block_state);
    normalizedTasks.push(tagged.task);
    tagPlans.push(tagged.plan);
    cleanupItems.push(...tagged.cleanup);
  }

  const result = {
    tasks: normalizedTasks,
    status_plans: statusPlans,
    external_data_writes: {
      initialization_requests: initializationRequests,
      last_active_status_updates: lastActiveStatusUpdates,
    },
    tag_plans: tagPlans,
    graph,
    cleanup_items: uniqueCleanupItems(cleanupItems),
    critical_errors: uniqueCriticalErrors(criticalErrors),
  };
  return asanaSnapshotNormalizationResultSchema.parse(result);
}
