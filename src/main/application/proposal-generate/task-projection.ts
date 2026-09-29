type ProposalTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

type ProposalParentValue = ProposalTarget | { readonly kind: "absent" };
type ProposalDueValue =
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };

type ProjectionDependency = { readonly task_gid: string; readonly scope: string; readonly source: string };
type ProjectionLink = { readonly vault_id: string; readonly path: string; readonly title: string; readonly confidence: number };

type ProjectionTask = {
  readonly gid: string;
  readonly title: string;
  readonly notes: string;
  readonly status: string;
  readonly importance: number;
  readonly area: string;
  readonly parent_work_mode: string;
  readonly completed: boolean;
  readonly child_gids: readonly string[];
  readonly dependencies: readonly ProjectionDependency[];
  readonly obsidian_links: readonly ProjectionLink[];
  readonly parent_gid?: string | undefined;
  readonly due_on?: string | undefined;
  readonly due_at?: string | undefined;
  readonly duration?: { readonly value: number; readonly unit: string } | undefined;
};

type ProjectedDependencyInput = { readonly target: ProposalTarget; readonly scope: string; readonly source: string };
type ProjectedOperation<TTask extends ProjectionTask> =
  | { readonly operation: "create_task"; readonly operation_id: string; readonly temporary_ref: string; readonly after: {
      readonly title: string; readonly notes?: string | undefined; readonly status?: string | undefined;
      readonly importance?: number | undefined; readonly area?: string | undefined;
      readonly parent_work_mode?: string | undefined; readonly dependencies?: readonly ProjectedDependencyInput[] | undefined;
      readonly obsidian_links?: readonly ProjectionLink[] | undefined; readonly due?: ProposalDueValue | undefined;
      readonly duration?: TTask["duration"]; readonly parent?: ProposalTarget | undefined;
    } }
  | ({ readonly operation: "update_title"; readonly after: string } & TargetedOperation)
  | ({ readonly operation: "update_notes"; readonly after: string } & TargetedOperation)
  | ({ readonly operation: "set_status"; readonly after: string } & TargetedOperation)
  | ({ readonly operation: "set_importance"; readonly after: number } & TargetedOperation)
  | ({ readonly operation: "set_due"; readonly after: ProposalDueValue } & TargetedOperation)
  | ({ readonly operation: "clear_due" } & TargetedOperation)
  | ({ readonly operation: "set_duration"; readonly after: NonNullable<TTask["duration"]> } & TargetedOperation)
  | ({ readonly operation: "clear_duration" } & TargetedOperation)
  | ({ readonly operation: "set_area"; readonly after: string } & TargetedOperation)
  | ({ readonly operation: "set_dependencies"; readonly after: readonly ProjectedDependencyInput[] } & TargetedOperation)
  | ({ readonly operation: "set_parent"; readonly after: ProposalParentValue } & TargetedOperation)
  | ({ readonly operation: "set_parent_work_mode"; readonly after: string } & TargetedOperation)
  | ({ readonly operation: "link_obsidian"; readonly after: ProjectionLink } & TargetedOperation)
  | ({ readonly operation: "unlink_obsidian"; readonly before: ProjectionLink } & TargetedOperation)
  | ({ readonly operation: "complete" } & TargetedOperation)
  | ({ readonly operation: "withdraw" } & TargetedOperation);

type TargetedOperation = { readonly operation_id: string; readonly target: ProposalTarget };

type ProjectionDependencies<TTask extends ProjectionTask> = {
  readonly parseTask: (value: unknown) => TTask;
  readonly parseDependencies: (value: unknown) => TTask["dependencies"];
  readonly parseObsidianLinks: (value: unknown) => TTask["obsidian_links"];
  readonly WorkflowError: new (message: string) => Error;
};

export function projectedTemporaryGid(ref: string): string {
  return `temporary:${ref}`;
}

export function projectedTargetGid(target: ProposalTarget): string {
  if (target.kind === "existing") {
    return target.gid;
  }
  return projectedTemporaryGid(target.ref);
}

function projectedParentGid(value: ProposalParentValue): string | undefined {
  if (value.kind === "absent") {
    return undefined;
  }
  return projectedTargetGid(value);
}

/** 選択した操作を検証済みタスクへ投影する関数を組み立てます。 */
export function createTaskProjector<TTask extends ProjectionTask>(
  dependencies: ProjectionDependencies<TTask>,
): (
  snapshot: { readonly tasks: readonly TTask[]; readonly as_of: string },
  proposal: { readonly groups: readonly { readonly operations: readonly ProjectedOperation<TTask>[] }[] },
  selectedOperationIds: ReadonlySet<string>,
) => TTask[] {
function withoutTaskFields(
  task: TTask,
  fields: readonly string[],
): Record<string, unknown> {
  const value: Record<string, unknown> = { ...task };
  for (const field of fields) {
    delete value[field];
  }
  return value;
}

function replaceProjectedTask(
  tasks: Map<string, TTask>,
  gid: string,
  update: (task: TTask) => unknown,
): void {
  const current = tasks.get(gid);
  if (current == null) {
    throw new dependencies.WorkflowError(`投影対象タスク ${gid} が存在しません。`);
  }
  tasks.set(gid, dependencies.parseTask(update(current)));
}

function createProjectedDependency(
  dependency: ProjectedDependencyInput,
): ProjectionDependency {
  return {
    task_gid: projectedTargetGid(dependency.target),
    scope: dependency.scope,
    source: dependency.source,
  };
}

function createProjectedTask(
  operation: Extract<ProjectedOperation<TTask>, { readonly operation: "create_task" }>,
  snapshot: { readonly as_of: string },
): TTask {
  const after = operation.after;
  const base = {
    gid: projectedTemporaryGid(operation.temporary_ref),
    title: after.title,
    notes: after.notes ?? "",
    status: after.status ?? "not_started",
    importance: after.importance ?? 3,
    area: after.area ?? "未分類",
    block_state: "none",
    parent_work_mode: after.parent_work_mode ?? "unknown",
    section_gid: "temporary-section",
    completed: false,
    tags: [],
    child_gids: [],
    dependencies: (after.dependencies ?? []).map((dependency) => createProjectedDependency(dependency)),
    obsidian_links: after.obsidian_links ?? [],
    activity_anchor_on: snapshot.as_of.slice(0, 10),
  };
  const withDue = after.due == null
    ? base
    : after.due.kind === "due_on"
      ? { ...base, due_on: after.due.due_on }
      : { ...base, due_at: after.due.due_at };
  const withDuration = after.duration == null
    ? withDue
    : { ...withDue, duration: after.duration };
  const withParent = after.parent == null
    ? withDuration
    : { ...withDuration, parent_gid: projectedTargetGid(after.parent) };
  return dependencies.parseTask(withParent);
}

function appendChild(tasks: Map<string, TTask>, parentGid: string, childGid: string): void {
  replaceProjectedTask(tasks, parentGid, (parent) => {
    if (parent.child_gids.includes(childGid)) {
      return parent;
    }
    return { ...parent, child_gids: [...parent.child_gids, childGid] };
  });
}

function removeChild(tasks: Map<string, TTask>, parentGid: string, childGid: string): void {
  replaceProjectedTask(tasks, parentGid, (parent) => ({
    ...parent,
    child_gids: parent.child_gids.filter((gid) => gid !== childGid),
  }));
}

function applyCreateRelations(
  tasks: Map<string, TTask>,
  operation: Extract<ProjectedOperation<TTask>, { readonly operation: "create_task" }>,
): void {
  const childGid = projectedTemporaryGid(operation.temporary_ref);
  if (operation.after.parent != null) {
    appendChild(tasks, projectedTargetGid(operation.after.parent), childGid);
  }
}

function setProjectedDue(task: TTask, due: ProposalDueValue): TTask {
  const withoutDue = withoutTaskFields(task, ["due_on", "due_at"]);
  if (due.kind === "due_on") {
    return dependencies.parseTask({ ...withoutDue, due_on: due.due_on });
  }
  return dependencies.parseTask({ ...withoutDue, due_at: due.due_at });
}

function clearProjectedDue(task: TTask): TTask {
  return dependencies.parseTask(withoutTaskFields(task, ["due_on", "due_at"]));
}

function setProjectedDuration(task: TTask, duration: NonNullable<TTask["duration"]>): TTask {
  return dependencies.parseTask({ ...task, duration });
}

function clearProjectedDuration(task: TTask): TTask {
  return dependencies.parseTask(withoutTaskFields(task, ["duration"]));
}

function sameObsidianLink(left: ProjectionLink, right: ProjectionLink): boolean {
  return left.vault_id === right.vault_id
    && left.path === right.path
    && left.title === right.title
    && left.confidence === right.confidence;
}

function applyProjectedOperation(
  tasks: Map<string, TTask>,
  operation: Exclude<ProjectedOperation<TTask>, { readonly operation: "create_task" }>,
): void {
  const targetGid = projectedTargetGid(operation.target);
  switch (operation.operation) {
    case "update_title":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, title: operation.after }));
      return;
    case "update_notes":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, notes: operation.after }));
      return;
    case "set_status":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        status: operation.after,
        completed: false,
      }));
      return;
    case "set_importance":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, importance: operation.after }));
      return;
    case "set_due":
      replaceProjectedTask(tasks, targetGid, (task) => setProjectedDue(task, operation.after));
      return;
    case "clear_due":
      replaceProjectedTask(tasks, targetGid, clearProjectedDue);
      return;
    case "set_duration":
      replaceProjectedTask(tasks, targetGid, (task) =>
        setProjectedDuration(task, operation.after));
      return;
    case "clear_duration":
      replaceProjectedTask(tasks, targetGid, clearProjectedDuration);
      return;
    case "set_area":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, area: operation.after }));
      return;
    case "set_dependencies":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        dependencies: dependencies.parseDependencies(
          operation.after.map((dependency) => createProjectedDependency(dependency)),
        ),
      }));
      return;
    case "set_parent": {
      const current = tasks.get(targetGid);
      if (current == null) {
        throw new dependencies.WorkflowError(`投影対象タスク ${targetGid} が存在しません。`);
      }
      if (current.parent_gid != null) {
        if (tasks.has(current.parent_gid)) {
          removeChild(tasks, current.parent_gid, targetGid);
        }
      }
      const newParentGid = projectedParentGid(operation.after);
      replaceProjectedTask(tasks, targetGid, (task) => {
        if (newParentGid == null) {
          return dependencies.parseTask(withoutTaskFields(task, ["parent_gid"]));
        }
        return { ...task, parent_gid: newParentGid };
      });
      if (newParentGid != null) {
        appendChild(tasks, newParentGid, targetGid);
      }
      return;
    }
    case "set_parent_work_mode":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        parent_work_mode: operation.after,
      }));
      return;
    case "link_obsidian":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        obsidian_links: dependencies.parseObsidianLinks([...task.obsidian_links, operation.after]),
      }));
      return;
    case "unlink_obsidian":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        obsidian_links: task.obsidian_links.filter(
          (link) => !sameObsidianLink(link, operation.before),
        ),
      }));
      return;
    case "complete":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        status: "completed",
        completed: true,
      }));
      return;
    case "withdraw":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        status: "withdrawn",
        completed: true,
      }));
      return;
  }
}

function projectTaskValues(
  snapshot: { readonly tasks: readonly TTask[]; readonly as_of: string },
  proposal: { readonly groups: readonly { readonly operations: readonly ProjectedOperation<TTask>[] }[] },
  selectedOperationIds: ReadonlySet<string>,
): TTask[] {
  const tasks = new Map<string, TTask>();
  for (const task of snapshot.tasks) {
    if (tasks.has(task.gid)) {
      throw new dependencies.WorkflowError(`投影元タスク ${task.gid} が重複しています。`);
    }
    tasks.set(task.gid, task);
  }

  const selectedCreates = proposal.groups.flatMap((group) =>
    group.operations.filter(
      (operation): operation is Extract<ProjectedOperation<TTask>, { readonly operation: "create_task" }> =>
        operation.operation === "create_task"
        && selectedOperationIds.has(operation.operation_id),
    ));
  for (const operation of selectedCreates) {
    const gid = projectedTemporaryGid(operation.temporary_ref);
    if (tasks.has(gid)) {
      throw new dependencies.WorkflowError(`投影先GID ${gid} が重複しています。`);
    }
    tasks.set(gid, createProjectedTask(operation, snapshot));
  }
  for (const operation of selectedCreates) {
    applyCreateRelations(tasks, operation);
  }

  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (
        operation.operation !== "create_task"
        && selectedOperationIds.has(operation.operation_id)
      ) {
        applyProjectedOperation(tasks, operation);
      }
    }
  }
  return [...tasks.values()].sort((left, right) => left.gid < right.gid ? -1 : left.gid > right.gid ? 1 : 0);
}

  return projectTaskValues;
}
