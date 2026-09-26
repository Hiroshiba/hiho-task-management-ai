import { z } from "zod";

type RankResult = {
  readonly ranked_tasks: readonly { readonly gid: string; readonly rank: number }[];
  readonly excluded_tasks: readonly { readonly gid: string }[];
};

type ImpactDependencies<TSnapshot extends { readonly tasks: readonly unknown[] }, TProposal, TRankingTask, TImpact> = {
  readonly snapshotSchema: z.ZodType<TSnapshot>;
  readonly proposalSchema: z.ZodType<TProposal>;
  readonly identifierSchema: z.ZodType<string>;
  readonly parseImpact: (value: unknown) => TImpact;
  readonly operationMap: (proposal: TProposal) => ReadonlyMap<string, unknown>;
  readonly normalizeTasksForRanking: (tasks: TSnapshot["tasks"]) => TRankingTask[];
  readonly projectTasks: (snapshot: TSnapshot, proposal: TProposal, ids: ReadonlySet<string>) => TRankingTask[];
  readonly calculateTaskRanking: (input: { readonly app_version: string; readonly as_of: string; readonly tasks: TRankingTask[] }) => RankResult;
  readonly collectDirectTargetGids: (proposal: TProposal, ids: ReadonlySet<string>) => ReadonlySet<string>;
  readonly SelectionError: new (message: string) => Error;
};

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 選択済み操作の順位影響を計算する関数を組み立てます。 */
export function createImpactCalculator<
  TSnapshot extends { readonly app_version: string; readonly as_of: string; readonly tasks: readonly unknown[] },
  TProposal,
  TRankingTask,
  TImpact,
>(dependencies: ImpactDependencies<TSnapshot, TProposal, TRankingTask, TImpact>): (
  snapshot: TSnapshot,
  proposal: TProposal,
  selectedOperationIds: readonly string[],
) => TImpact {
function createRankMap(result: RankResult): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const task of result.ranked_tasks) {
    if (ranks.has(task.gid)) {
      throw new dependencies.SelectionError(`順位結果のGID ${task.gid} が重複しています。`);
    }
    ranks.set(task.gid, task.rank);
  }
  return ranks;
}

type RankPresence = "ranked" | "excluded" | "not_present";

function createRankPresenceMap(result: RankResult): Map<string, RankPresence> {
  const states = new Map<string, RankPresence>();
  for (const task of result.ranked_tasks) {
    states.set(task.gid, "ranked");
  }
  for (const task of result.excluded_tasks) {
    if (states.has(task.gid)) {
      throw new dependencies.SelectionError(`順位結果のGID ${task.gid} が重複しています。`);
    }
    states.set(task.gid, "excluded");
  }
  return states;
}

function createRankChange(
  gid: string,
  before: number | undefined,
  after: number | undefined,
  beforeState: RankPresence,
  afterState: RankPresence,
): {
  readonly task_gid: string;
  readonly before_state: RankPresence;
  readonly before_rank?: number;
  readonly after_state: RankPresence;
  readonly after_rank?: number;
} {
  const base = { task_gid: gid, before_state: beforeState, after_state: afterState };
  const withBefore = before == null ? base : { ...base, before_rank: before };
  return after == null ? withBefore : { ...withBefore, after_rank: after };
}

/** 選択済み変更案をアプリ側順位計算へ投影して影響を返します。 */
function calculateWorkflowImpact(
  snapshot: TSnapshot,
  proposal: TProposal,
  selectedOperationIds: readonly string[],
): TImpact {
  const validatedSnapshot = dependencies.snapshotSchema.parse(snapshot);
  const validatedProposal = dependencies.proposalSchema.parse(proposal);
  const validatedSelection = z
    .array(dependencies.identifierSchema)
    .max(256)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じ操作を重複指定できません。",
          });
        }
        seen.add(value);
      }
    })
    .parse(selectedOperationIds);
  const availableOperations = dependencies.operationMap(validatedProposal);
  for (const operationId of validatedSelection) {
    if (!availableOperations.has(operationId)) {
      throw new dependencies.SelectionError(`指定した操作 ${operationId} が存在しません。`);
    }
  }
  const selected = new Set(validatedSelection);
  const baselineRanking = dependencies.calculateTaskRanking({
    app_version: validatedSnapshot.app_version,
    as_of: validatedSnapshot.as_of,
    tasks: dependencies.normalizeTasksForRanking(validatedSnapshot.tasks),
  });
  const projectedRanking = dependencies.calculateTaskRanking({
    app_version: validatedSnapshot.app_version,
    as_of: validatedSnapshot.as_of,
    tasks: dependencies.projectTasks(validatedSnapshot, validatedProposal, selected),
  });
  const beforeRanks = createRankMap(baselineRanking);
  const afterRanks = createRankMap(projectedRanking);
  const beforeStates = createRankPresenceMap(baselineRanking);
  const afterStates = createRankPresenceMap(projectedRanking);
  const directTargetGids = dependencies.collectDirectTargetGids(validatedProposal, selected);
  const gids = new Set([
    ...beforeRanks.keys(),
    ...afterRanks.keys(),
    ...beforeStates.keys(),
    ...afterStates.keys(),
    ...directTargetGids,
  ]);
  const changes = [...gids]
    .sort(compareStrings)
    .flatMap((gid) => {
      const before = beforeRanks.get(gid);
      const after = afterRanks.get(gid);
      const beforeState = beforeStates.get(gid) ?? "not_present";
      const afterState = afterStates.get(gid) ?? "not_present";
      if (
        before === after
        && beforeState === afterState
        && !directTargetGids.has(gid)
      ) {
        return [];
      }
      if (
        before == null
        && after == null
        && beforeState === afterState
        && !directTargetGids.has(gid)
      ) {
        return [];
      }
      return [createRankChange(gid, before, after, beforeState, afterState)];
    });
  return dependencies.parseImpact({
    impacted_task_count: changes.length,
    impacted_task_gids: changes.map((change) => change.task_gid),
    rank_changes: changes,
  });
}

  return calculateWorkflowImpact;
}

type RankingTaskState = {
  readonly gid: string;
  readonly status: string;
  readonly dependencies: readonly unknown[];
  readonly child_gids: readonly string[];
  readonly parent_work_mode: string;
  readonly parent_gid?: string | undefined;
};

/** 順位計算に必要なグラフ状態をタスクへ補います。 */
export function normalizeTasksForRanking<
  TTask extends RankingTaskState,
  TState extends {
    readonly gid: string;
    readonly block_state: string;
    readonly dependency_cycle: boolean;
    readonly parent_cycle: boolean;
    readonly completion_confirmation: boolean;
  },
>(
  tasks: readonly TTask[],
  dependencies: {
    readonly normalizeTaskGraph: (input: { readonly tasks: readonly {
      readonly gid: string;
      readonly status: TTask["status"];
      readonly dependencies: TTask["dependencies"];
      readonly child_gids: TTask["child_gids"];
      readonly parent_work_mode: TTask["parent_work_mode"];
      readonly parent_gid?: string;
    }[] }) => { readonly tasks: readonly TState[] };
    readonly WorkflowError: new (message: string) => Error;
  },
): (TTask & Pick<TState, "block_state" | "dependency_cycle" | "parent_cycle" | "completion_confirmation">)[] {
  const normalizationTasks = tasks.map((task) => {
    const base = {
      gid: task.gid,
      status: task.status,
      dependencies: task.dependencies,
      child_gids: task.child_gids,
      parent_work_mode: task.parent_work_mode,
    };
    if (task.parent_gid == null) {
      return base;
    }
    return { ...base, parent_gid: task.parent_gid };
  });
  const normalized = dependencies.normalizeTaskGraph({ tasks: normalizationTasks });
  const normalizedByGid = new Map(normalized.tasks.map((task) => [task.gid, task]));
  return tasks.map((task) => {
    const state = normalizedByGid.get(task.gid);
    if (state == null) {
      throw new dependencies.WorkflowError(`順位計算用のタスク ${task.gid} を正規化できません。`);
    }
    return {
      ...task,
      block_state: state.block_state,
      dependency_cycle: state.dependency_cycle,
      parent_cycle: state.parent_cycle,
      completion_confirmation: state.completion_confirmation,
    };
  });
}
