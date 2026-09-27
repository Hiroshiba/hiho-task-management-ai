type ExternalTask = {
  readonly gid: string;
  readonly external: { readonly gid: string } | null;
};

/** タスク一覧をGIDで重複検査して索引化します。 */
export function uniqueTaskMap<TTask extends { readonly gid: string }>(
  tasks: readonly TTask[],
  parseTask: (value: unknown) => TTask,
): ReadonlyMap<string, TTask> {
  const result = new Map<string, TTask>();
  for (const task of tasks) {
    const parsedTask = parseTask(task);
    if (result.has(parsedTask.gid)) {
      throw new Error("Asanaタスク一覧のGIDが重複しています。");
    }
    result.set(parsedTask.gid, parsedTask);
  }
  return result;
}

/** 作成UUIDと外部識別子が一致するタスクを返します。 */
export function matchingExternalTasks<TTask extends ExternalTask>(
  tasks: ReadonlyMap<string, TTask>,
  uuid: string,
  expectedExternalGid: (uuid: string) => string,
): readonly TTask[] {
  return [...tasks.values()].filter((task) =>
    task.external != null && task.external.gid === expectedExternalGid(uuid));
}

type RecoveryTaskReadPorts<TTask extends { readonly gid: string }, TNotFound> = {
  readonly listProjectTasks: (projectGid: string, signal: AbortSignal) => Promise<readonly TTask[]>;
  readonly getTask: (taskGid: string, signal: AbortSignal) => Promise<TTask>;
  readonly parseTask: (value: unknown) => TTask;
  readonly isNotFound: (error: unknown) => error is TNotFound;
};

/** 復旧時のプロジェクト一覧を共有し、単一タスクの404を区別します。 */
export function createRecoveryTaskReads<TTask extends { readonly gid: string }, TNotFound>(
  ports: RecoveryTaskReadPorts<TTask, TNotFound>,
  signal: AbortSignal,
): {
  readonly loadProjectTasks: (projectGid: string) => Promise<ReadonlyMap<string, TTask>>;
  readonly readTask: (taskGid: string) => Promise<{ readonly kind: "found"; readonly task: TTask } | { readonly kind: "missing"; readonly error: TNotFound }>;
} {
  const taskLists = new Map<string, Promise<ReadonlyMap<string, TTask>>>();
  const loadProjectTasks = (projectGid: string): Promise<ReadonlyMap<string, TTask>> => {
    const cached = taskLists.get(projectGid);
    if (cached != null) {
      return cached;
    }
    const promise = ports.listProjectTasks(projectGid, signal)
      .then((tasks) => uniqueTaskMap(tasks, ports.parseTask));
    taskLists.set(projectGid, promise);
    return promise;
  };
  const readTask = async (taskGid: string): Promise<
    { readonly kind: "found"; readonly task: TTask }
    | { readonly kind: "missing"; readonly error: TNotFound }
  > => {
    try {
      return { kind: "found", task: ports.parseTask(await ports.getTask(taskGid, signal)) };
    } catch (error) {
      if (ports.isNotFound(error)) {
        return { kind: "missing", error };
      }
      throw error;
    }
  };
  return { loadProjectTasks, readTask };
}
