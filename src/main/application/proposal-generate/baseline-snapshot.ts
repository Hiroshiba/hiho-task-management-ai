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

