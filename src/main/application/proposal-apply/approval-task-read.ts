import type { z } from "zod";

type ApprovalTask = {
  readonly gid: string;
  readonly modified_at: string;
  readonly num_subtasks: number;
  readonly parent?: { readonly gid: string } | null;
};

interface ApprovalTaskReadOptions<TTask extends ApprovalTask> {
  readonly gidSchema: z.ZodType<string>;
  readonly taskSchema: z.ZodType<TTask>;
  readonly source: {
    listProjectTasks(projectGid: string, signal: AbortSignal): Promise<readonly TTask[]>;
    listSubtasks(taskGid: string, signal: AbortSignal): Promise<readonly TTask[]>;
  };
  readonly canonicalizeJson: (value: unknown) => string;
}

const maximumApprovalTaskCount = 10_000;

function mergeApprovalTaskResponse<TTask extends ApprovalTask>(
  tasks: Map<string, TTask>,
  value: TTask,
  options: ApprovalTaskReadOptions<TTask>,
): boolean {
  const candidate = options.taskSchema.parse(value);
  const current = tasks.get(candidate.gid);
  if (current == null) {
    tasks.set(candidate.gid, candidate);
    return true;
  }
  const currentModifiedAt = Date.parse(current.modified_at);
  const candidateModifiedAt = Date.parse(candidate.modified_at);
  if (!Number.isFinite(currentModifiedAt) || !Number.isFinite(candidateModifiedAt)) {
    throw new Error("承認前再取得タスクの更新時刻を比較できません。");
  }
  if (currentModifiedAt === candidateModifiedAt) {
    if (options.canonicalizeJson(current) !== options.canonicalizeJson(candidate)) {
      throw new Error("同じ更新時刻の承認前再取得タスクが一致しません。");
    }
    return false;
  }
  if (candidateModifiedAt > currentModifiedAt) {
    tasks.set(candidate.gid, candidate);
    return true;
  }
  return false;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 承認直前にプロジェクトと子タスクを再取得します。 */
export async function collectApprovalProjectTasks<TTask extends ApprovalTask>(
  projectGid: string,
  signal: AbortSignal,
  options: ApprovalTaskReadOptions<TTask>,
): Promise<readonly TTask[]> {
  const validatedProjectGid = options.gidSchema.parse(projectGid);
  const projectTasks = await options.source.listProjectTasks(validatedProjectGid, signal);
  const tasks = new Map<string, TTask>();
  const pendingTaskGids: string[] = [];
  const queuedTaskGids = new Set<string>();
  const expandedTaskGids = new Set<string>();
  for (const task of projectTasks) {
    mergeApprovalTaskResponse(tasks, task, options);
    if (!queuedTaskGids.has(task.gid)) {
      queuedTaskGids.add(task.gid);
      pendingTaskGids.push(task.gid);
    }
  }
  while (pendingTaskGids.length > 0) {
    signal.throwIfAborted();
    const taskGid = pendingTaskGids.shift();
    if (taskGid == null) {
      throw new Error("承認前再取得の探索キューを進行できません。");
    }
    if (expandedTaskGids.has(taskGid)) {
      continue;
    }
    const task = tasks.get(taskGid);
    if (task == null) {
      throw new Error("承認前再取得の探索対象タスクがありません。");
    }
    expandedTaskGids.add(taskGid);
    if (expandedTaskGids.size > maximumApprovalTaskCount) {
      throw new Error("承認前再取得のタスク件数が上限を超えました。");
    }
    if (task.num_subtasks === 0) {
      continue;
    }
    const subtasks = await options.source.listSubtasks(task.gid, signal);
    if (subtasks.length !== task.num_subtasks) {
      throw new Error("承認前再取得のサブタスク件数がAsana応答と一致しません。");
    }
    const childGids = new Set<string>();
    for (const subtask of subtasks) {
      const validatedSubtask = options.taskSchema.parse(subtask);
      if (childGids.has(validatedSubtask.gid)) {
        throw new Error("承認前再取得のサブタスクGIDが重複しています。");
      }
      childGids.add(validatedSubtask.gid);
      if (validatedSubtask.parent?.gid !== task.gid) {
        throw new Error("承認前再取得のサブタスク親参照が一致しません。");
      }
      const selectedCandidate = mergeApprovalTaskResponse(tasks, validatedSubtask, options);
      if (
        selectedCandidate
        && validatedSubtask.num_subtasks > 0
        && expandedTaskGids.delete(validatedSubtask.gid)
      ) {
        pendingTaskGids.push(validatedSubtask.gid);
      }
      if (
        !queuedTaskGids.has(validatedSubtask.gid)
        && !expandedTaskGids.has(validatedSubtask.gid)
      ) {
        queuedTaskGids.add(validatedSubtask.gid);
        pendingTaskGids.push(validatedSubtask.gid);
      }
    }
    if (tasks.size > maximumApprovalTaskCount) {
      throw new Error("承認前再取得のタスク件数が上限を超えました。");
    }
  }
  return [...tasks.values()].sort((left, right) => compareStrings(left.gid, right.gid));
}
