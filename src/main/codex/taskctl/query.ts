import {
  taskctlQuerySchema,
  taskctlResponseSchema,
  taskctlSnapshotSchema,
  type TaskctlQuery,
  type TaskctlResponse,
  type TaskctlSnapshot,
} from "./schemas";

type TaskctlErrorCode = Extract<
  TaskctlResponse,
  { readonly ok: false }
>["error"]["code"];

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedTasks(snapshot: TaskctlSnapshot): TaskctlSnapshot["tasks"] {
  return [...snapshot.tasks].sort((left, right) => compareStrings(left.gid, right.gid));
}

function createError(
  code: TaskctlErrorCode,
  message: string,
  sync: TaskctlResponse["sync"],
): TaskctlResponse {
  return {
    ok: false,
    error: { code, message },
    sync,
  };
}

/** 固定済みtaskctlスナップショットへ読み取り要求を適用します。 */
export function executeTaskctlQuery(
  suppliedQuery: TaskctlQuery,
  suppliedSnapshot: TaskctlSnapshot,
): TaskctlResponse {
  const snapshot = taskctlSnapshotSchema.parse(suppliedSnapshot);
  const query = taskctlQuerySchema.parse(suppliedQuery);

  switch (query.command) {
    case "list": {
      const tasks = sortedTasks(snapshot);
      if (tasks.length > 1_000) {
        return createError("result_limit", "taskctl一覧の件数が上限を超えました。", snapshot.sync);
      }
      return taskctlResponseSchema.parse({
        ok: true,
        command: "list",
        sync: snapshot.sync,
        data: { tasks },
      });
    }
    case "get": {
      const task = snapshot.tasks.find((candidate) => candidate.gid === query.gid);
      if (task == null) {
        return createError("task_not_found", "指定したタスクが見つかりません。", snapshot.sync);
      }
      return taskctlResponseSchema.parse({
        ok: true,
        command: "get",
        sync: snapshot.sync,
        data: { task },
      });
    }
    case "rank":
      return taskctlResponseSchema.parse({
        ok: true,
        command: "rank",
        sync: snapshot.sync,
        data: { ranking: snapshot.ranking },
      });
    case "graph": {
      const tasks = sortedTasks(snapshot);
      if (tasks.length > 10_000) {
        return createError("result_limit", "taskctlグラフの件数が上限を超えました。", snapshot.sync);
      }
      const dependencies = tasks.map((task) => ({
        task_gid: task.gid,
        dependencies: [...task.dependencies].sort((left, right) => {
          const taskResult = compareStrings(left.task_gid, right.task_gid);
          if (taskResult !== 0) {
            return taskResult;
          }
          const scopeResult = compareStrings(left.scope, right.scope);
          if (scopeResult !== 0) {
            return scopeResult;
          }
          return compareStrings(left.source, right.source);
        }),
      }));
      const relationMap = new Map<string, { readonly parent_gid: string; readonly child_gid: string }>();
      for (const task of tasks) {
        if (task.parent_gid != null) {
          relationMap.set(`${task.parent_gid}\u0000${task.gid}`, {
            parent_gid: task.parent_gid,
            child_gid: task.gid,
          });
        }
        for (const childGid of task.child_gids) {
          relationMap.set(`${task.gid}\u0000${childGid}`, {
            parent_gid: task.gid,
            child_gid: childGid,
          });
        }
      }
      const parentRelations = [...relationMap.values()].sort((left, right) => {
        const parentResult = compareStrings(left.parent_gid, right.parent_gid);
        if (parentResult !== 0) {
          return parentResult;
        }
        return compareStrings(left.child_gid, right.child_gid);
      });
      if (parentRelations.length > 20_000) {
        return createError("result_limit", "taskctlグラフの関係数が上限を超えました。", snapshot.sync);
      }
      return taskctlResponseSchema.parse({
        ok: true,
        command: "graph",
        sync: snapshot.sync,
        data: { tasks, dependencies, parent_relations: parentRelations },
      });
    }
    case "areas": {
      const areas = [...new Set(snapshot.tasks.map((task) => task.area))].sort(compareStrings);
      if (areas.length > 500) {
        return createError("result_limit", "taskctl領域の件数が上限を超えました。", snapshot.sync);
      }
      return taskctlResponseSchema.parse({
        ok: true,
        command: "areas",
        sync: snapshot.sync,
        data: { areas },
      });
    }
    case "search-local": {
      const normalizedQuery = query.query.toLowerCase();
      const tasks = sortedTasks(snapshot).filter((task) => (
        task.title.toLowerCase().includes(normalizedQuery)
        || task.notes.toLowerCase().includes(normalizedQuery)
        || task.area.toLowerCase().includes(normalizedQuery)
      ));
      if (tasks.length > 1_000) {
        return createError("result_limit", "taskctl検索結果の件数が上限を超えました。", snapshot.sync);
      }
      return taskctlResponseSchema.parse({
        ok: true,
        command: "search-local",
        sync: snapshot.sync,
        data: { query: query.query, tasks },
      });
    }
  }
}
