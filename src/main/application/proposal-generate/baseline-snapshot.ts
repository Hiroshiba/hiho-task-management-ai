type SnapshotTask = {
  readonly gid: string;
  readonly title: string;
  readonly notes: string;
  readonly status: string;
  readonly importance: number;
  readonly area: string;
  readonly block_state: string;
  readonly parent_work_mode: string;
  readonly section_gid: string;
  readonly completed: boolean;
  readonly tags: readonly { readonly gid: string; readonly name: string }[];
  readonly child_gids: readonly string[];
  readonly dependencies: readonly { readonly task_gid: string; readonly scope: string; readonly source: string }[];
  readonly obsidian_links: readonly { readonly vault_id: string; readonly path: string; readonly title: string; readonly confidence: number }[];
  readonly activity_anchor_on: string;
  readonly due_on?: string | undefined;
  readonly due_at?: string | undefined;
  readonly duration?: { readonly value: number; readonly unit: string } | undefined;
  readonly parent_gid?: string | undefined;
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function createTaskSnapshot(task: SnapshotTask): SnapshotTask {
  const base = {
    gid: task.gid,
    title: task.title,
    notes: task.notes,
    status: task.status,
    importance: task.importance,
    area: task.area,
    block_state: task.block_state,
    parent_work_mode: task.parent_work_mode,
    section_gid: task.section_gid,
    completed: task.completed,
    tags: task.tags,
    child_gids: task.child_gids,
    dependencies: task.dependencies,
    obsidian_links: task.obsidian_links,
    activity_anchor_on: task.activity_anchor_on,
  };
  const withDue = task.due_on != null
    ? { ...base, due_on: task.due_on }
    : task.due_at != null
      ? { ...base, due_at: task.due_at }
      : base;
  const withDuration = task.duration == null
    ? withDue
    : { ...withDue, duration: task.duration };
  if (task.parent_gid != null) {
    return { ...withDuration, parent_gid: task.parent_gid };
  }
  return withDuration;
}

/** タスクを基準比較用の順序付きsnapshotへ変換します。 */
export function createBaselineTaskSnapshots(tasks: readonly SnapshotTask[]): SnapshotTask[] {
  return tasks
    .map(createTaskSnapshot)
    .sort((left, right) => compareStrings(left.gid, right.gid));
}

/** 同期済みタスクをキー順の基準スナップショットへ変換します。 */
export function createBaselineSnapshot<
  TSnapshot extends {
    readonly app_version: string; readonly project_gid: string;
    readonly as_of: string; readonly tasks: readonly SnapshotTask[];
  },
  TBaseline,
>(
  snapshot: TSnapshot,
  dependencies: {
    readonly parseSnapshot: (value: TSnapshot) => TSnapshot;
    readonly parseBaseline: (value: unknown) => TBaseline;
  },
): TBaseline {
  const validated = dependencies.parseSnapshot(snapshot);
  return dependencies.parseBaseline({
    app_version: validated.app_version,
    project_gid: validated.project_gid,
    as_of: validated.as_of,
    tasks: createBaselineTaskSnapshots(validated.tasks),
  });
}

/** taskctlの固定状態が基準スナップショットと一致するか確認します。 */
export function assertTaskctlSnapshotMatchesBaseline(
  snapshot: {
    readonly app_version: string;
    readonly project_gid: string;
    readonly as_of: string;
    readonly synced_at: string;
  },
  baseline: { readonly tasks: unknown },
  taskctlSnapshot: {
    readonly sync: { readonly kind: string; readonly synced_at?: string };
    readonly tasks: readonly SnapshotTask[];
  },
  dependencies: {
    readonly parseBaselineSnapshot: (value: unknown) => { readonly tasks: unknown };
    readonly canonicalizeJson: (value: unknown) => string;
    readonly SyncError: new (cause: unknown) => Error;
  },
): void {
  if (
    taskctlSnapshot.sync.kind !== "synced"
    || taskctlSnapshot.sync.synced_at !== snapshot.synced_at
  ) {
    throw new dependencies.SyncError(new Error("taskctlの同期時点が基準スナップショットと一致しません。"));
  }
  const taskctlBaseline = dependencies.parseBaselineSnapshot({
    app_version: snapshot.app_version,
    project_gid: snapshot.project_gid,
    as_of: snapshot.as_of,
    tasks: createBaselineTaskSnapshots(taskctlSnapshot.tasks),
  });
  if (
    dependencies.canonicalizeJson(taskctlBaseline.tasks)
    !== dependencies.canonicalizeJson(baseline.tasks)
  ) {
    throw new dependencies.SyncError(new Error("taskctlのタスク状態が基準スナップショットと一致しません。"));
  }
}
