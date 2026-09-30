import { asanaTaskResponseSchema, normalizeTaskGraph, taskSchema } from "../../domain";
import { throwIfAborted, validateAbortSignal } from "../common/abort-signal";
import type { TaskCacheRecord } from "../common/ports/task-read-repository";
import type { GuiEditDependencies } from "./apply";

type RelationRequest<TDependency> =
  | {
      readonly kind: "dependencies";
      readonly task_gid: string;
      readonly dependencies: readonly TDependency[];
    }
  | {
      readonly kind: "parent";
      readonly task_gid: string;
      readonly parent_gid: string | null;
    };

interface RelationTask<TStatus, TDependency, TParentWorkMode> {
  readonly gid: string;
  readonly status: TStatus;
  readonly dependencies: readonly TDependency[];
  readonly parent_work_mode: TParentWorkMode;
  readonly parent_gid?: string | null | undefined;
}

type ProjectedRelationTask<TStatus, TDependency, TParentWorkMode> = {
  readonly gid: string;
  readonly status: TStatus;
  readonly dependencies: readonly TDependency[];
  readonly parent_work_mode: TParentWorkMode;
  readonly parent_gid?: string;
};

/** GUI編集後の関係グラフに循環があるかを確認します。 */
export function validateRelationGraph<TStatus, TDependency, TParentWorkMode>(
  request: RelationRequest<TDependency>,
  tasks: readonly RelationTask<TStatus, TDependency, TParentWorkMode>[],
  normalize: (
    projected: readonly ProjectedRelationTask<TStatus, TDependency, TParentWorkMode>[],
  ) => { readonly dependency_cycles: readonly unknown[]; readonly parent_cycles: readonly unknown[] },
): { readonly kind: "valid" } | { readonly kind: "conflict"; readonly reason_code: "relationship_cycle" } {
  const projected = tasks.map((task) => {
    if (task.gid !== request.task_gid) {
      return {
        gid: task.gid,
        status: task.status,
        dependencies: task.dependencies,
        parent_work_mode: task.parent_work_mode,
        ...(task.parent_gid == null ? {} : { parent_gid: task.parent_gid }),
      };
    }
    if (request.kind === "dependencies") {
      return {
        gid: task.gid,
        status: task.status,
        dependencies: request.dependencies,
        parent_work_mode: task.parent_work_mode,
        ...(task.parent_gid == null ? {} : { parent_gid: task.parent_gid }),
      };
    }
    return {
      gid: task.gid,
      status: task.status,
      dependencies: task.dependencies,
      parent_work_mode: task.parent_work_mode,
      ...(request.parent_gid == null ? {} : { parent_gid: request.parent_gid }),
    };
  });
  if (!tasks.some((task) => task.gid === request.task_gid)) {
    throw new Error("関係グラフの編集対象タスクがありません。");
  }
  const result = normalize(projected);
  if (result.dependency_cycles.length > 0 || result.parent_cycles.length > 0) {
    return { kind: "conflict", reason_code: "relationship_cycle" };
  }
  return { kind: "valid" };
}

/** 保存済みタスクからGUI編集の関係グラフを検証します。 */
export function validateCachedRelationGraph(
  request: Parameters<GuiEditDependencies["validateRelation"]>[0],
  entries: readonly TaskCacheRecord[],
  signal: AbortSignal,
): Promise<Awaited<ReturnType<GuiEditDependencies["validateRelation"]>>> {
  validateAbortSignal(signal);
  throwIfAborted(signal);
  const tasks = entries.map((entry) => {
    asanaTaskResponseSchema.parse(entry.asana_response);
    return taskSchema.parse(entry.task);
  });
  const result = validateRelationGraph(request, tasks, (projected) =>
    normalizeTaskGraph({ tasks: projected, inaccessible_gids: [] }));
  return Promise.resolve(result);
}
