import { z } from "zod";
import {
  canonicalizeJson,
  dateSchema,
  identifierSchema,
  isoDateTimeSchema,
  taskSchema,
  type Importance,
  type TaskStatus,
} from "../../../shared/domain";
import { DuplicateTaskGidError } from "../normalization/graph";

const dayMilliseconds = 24 * 60 * 60 * 1000;
const jstOffsetMilliseconds = 9 * 60 * 60 * 1000;
const jstEndOfDayMilliseconds =
  14 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000;
const criticalErrorsSchema = z
  .array(
    z.string().refine((value) => value.trim().length > 0, {
      message: "重大エラーの説明を空にできません。",
    }),
  )
  .optional();
const optionalBooleanSchema = z.boolean().optional();
const rankingTaskSchema = taskSchema.safeExtend({
  dependency_cycle: optionalBooleanSchema,
  parent_cycle: optionalBooleanSchema,
  completion_confirmation: optionalBooleanSchema,
  critical_errors: criticalErrorsSchema,
});
const rankingInputSchema = z
  .object({
    app_version: identifierSchema,
    as_of: isoDateTimeSchema,
    tasks: z.array(rankingTaskSchema),
  })
  .strict();

const importancePoints: { readonly [key in Importance]: number } = {
  1: 0,
  2: 25,
  3: 50,
  4: 75,
  5: 100,
};

export type RankingTask = z.infer<typeof rankingTaskSchema>;

export type RankingInput = z.infer<typeof rankingInputSchema>;

export type RankingScoreBreakdown = {
  readonly importance_points: number;
  readonly deadline_points: number;
  readonly release_points: number;
  readonly partial_block_penalty: number;
  readonly stagnation_penalty: number;
  readonly execution_points: number;
};

export type RankingExclusionReasonCode =
  | "inactive_status"
  | "full_block"
  | "dependency_cycle"
  | "parent_cycle"
  | "completion_confirmation"
  | "critical_error";

export type RankingExclusionReason = {
  readonly code: RankingExclusionReasonCode;
  readonly message: string;
};

export type RankingTieBreak = {
  readonly effective_due_at?: string;
  readonly importance: Importance;
  readonly release_points: number;
  readonly activity_anchor_on: string;
  readonly gid: string;
};

export type RankingDetail = {
  readonly input: RankingTask;
  readonly score_breakdown?: RankingScoreBreakdown;
  readonly exclusion_reasons: readonly RankingExclusionReason[];
  readonly tie_break: RankingTieBreak;
  readonly reason_chips: readonly string[];
  readonly text: string;
};

export type RankedTaskResult = {
  readonly kind: "ranked";
  readonly task: RankingTask;
  readonly gid: string;
  readonly rank: number;
  readonly score_breakdown: RankingScoreBreakdown;
  readonly release_target_gids: readonly string[];
  readonly reason_chips: readonly string[];
  readonly tie_break: RankingTieBreak;
  readonly detail: RankingDetail;
};

export type ExcludedTaskResult = {
  readonly kind: "excluded";
  readonly task: RankingTask;
  readonly gid: string;
  readonly exclusion_reasons: readonly RankingExclusionReason[];
  readonly score_breakdown?: RankingScoreBreakdown;
  readonly release_target_gids: readonly string[];
  readonly reason_chips: readonly string[];
  readonly tie_break: RankingTieBreak;
  readonly detail: RankingDetail;
};

export type RankingResult = {
  readonly app_version: string;
  readonly calculated_at: string;
  readonly ranked_tasks: readonly RankedTaskResult[];
  readonly excluded_tasks: readonly ExcludedTaskResult[];
};

type RankingTaskMetadata = {
  readonly dependency_cycle: boolean;
  readonly parent_cycle: boolean;
  readonly completion_confirmation: boolean;
  readonly critical_errors: readonly string[];
};

type IndexedTask = {
  readonly task: RankingTask;
  readonly metadata: RankingTaskMetadata;
};

type DueEvaluation = {
  readonly points: number;
  readonly days_until_due?: number;
  readonly effective_due_epoch?: number;
  readonly effective_due_at?: string;
  readonly chip: string;
};

type StagnationEvaluation = {
  readonly elapsed_days: number;
  readonly penalty: number;
  readonly chip?: string;
};

type ReleaseEvaluation = {
  readonly target_gids: readonly string[];
  readonly points: number;
  readonly has_urgent_target: boolean;
};

type EvaluatedTask = {
  readonly indexed_task: IndexedTask;
  readonly due: DueEvaluation;
  readonly stagnation: StagnationEvaluation;
  readonly release: ReleaseEvaluation;
  readonly score?: RankingScoreBreakdown;
  readonly exclusion_reasons: readonly RankingExclusionReason[];
  readonly reason_chips: readonly string[];
  readonly tie_break: RankingTieBreak;
};

type DayParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
};

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isActiveStatus(status: TaskStatus): boolean {
  return status === "not_started" || status === "in_progress";
}

function parseDayParts(value: string): DayParts {
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(5, 7), 10);
  const day = Number.parseInt(value.slice(8, 10), 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error("日付の分解に失敗しました。");
  }
  return { year, month, day };
}

function createUtcDay(parts: DayParts): number {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime();
}

function getDaySerial(value: string): number {
  return createUtcDay(parseDayParts(value));
}

function getJstDaySerial(epoch: number): number {
  const jstDate = new Date(epoch + jstOffsetMilliseconds);
  if (Number.isNaN(jstDate.getTime())) {
    throw new Error("JST日時の変換に失敗しました。");
  }
  return createUtcDay({
    year: jstDate.getUTCFullYear(),
    month: jstDate.getUTCMonth() + 1,
    day: jstDate.getUTCDate(),
  });
}

function parseInstant(value: string): number {
  const epoch = Date.parse(value);
  if (Number.isNaN(epoch)) {
    throw new Error("日時の変換に失敗しました。");
  }
  return epoch;
}

function getDaysUntilDue(
  effectiveDueEpoch: number,
  baseDaySerial: number,
): number {
  const dueDaySerial = getJstDaySerial(effectiveDueEpoch);
  return Math.round((dueDaySerial - baseDaySerial) / dayMilliseconds);
}

function getDeadlinePoints(daysUntilDue: number): number {
  if (daysUntilDue >= 31) {
    return 2;
  }
  if (daysUntilDue >= 15) {
    return 7;
  }
  if (daysUntilDue >= 8) {
    return 14;
  }
  if (daysUntilDue >= 4) {
    return 22;
  }
  if (daysUntilDue >= 2) {
    return 30;
  }
  if (daysUntilDue === 1) {
    return 38;
  }
  if (daysUntilDue === 0) {
    return 46;
  }
  if (daysUntilDue >= -2) {
    return 54;
  }
  if (daysUntilDue >= -7) {
    return 62;
  }
  return 68;
}

function createDeadlineChip(daysUntilDue: number, points: number): string {
  if (daysUntilDue > 1) {
    return `期限${daysUntilDue}日 +${points}`;
  }
  if (daysUntilDue === 1) {
    return `期限翌日 +${points}`;
  }
  if (daysUntilDue === 0) {
    return `期限当日 +${points}`;
  }
  return `期限${Math.abs(daysUntilDue)}日超過 +${points}`;
}

function evaluateDue(
  task: RankingTask,
  baseDaySerial: number,
): DueEvaluation {
  if (task.due_at != null && task.due_on != null) {
    throw new Error("due_onとdue_atを同時に指定できません。");
  }
  if (task.due_at == null && task.due_on == null) {
    return {
      points: 0,
      chip: "期限なし +0",
    };
  }

  let effectiveDueEpoch: number;
  if (task.due_at != null) {
    const dueAt = isoDateTimeSchema.parse(task.due_at);
    effectiveDueEpoch = parseInstant(dueAt);
  } else {
    if (task.due_on == null) {
      throw new Error("期限値が取得できません。");
    }
    const dueOn = dateSchema.parse(task.due_on);
    effectiveDueEpoch = getDaySerial(dueOn) + jstEndOfDayMilliseconds;
  }
  const daysUntilDue = getDaysUntilDue(effectiveDueEpoch, baseDaySerial);
  const points = getDeadlinePoints(daysUntilDue);
  return {
    points,
    days_until_due: daysUntilDue,
    effective_due_epoch: effectiveDueEpoch,
    effective_due_at: new Date(effectiveDueEpoch).toISOString(),
    chip: createDeadlineChip(daysUntilDue, points),
  };
}

function evaluateStagnation(
  task: RankingTask,
  baseDaySerial: number,
): StagnationEvaluation {
  const activityAnchor = dateSchema.parse(task.activity_anchor_on);
  const activityDaySerial = getDaySerial(activityAnchor);
  if (activityDaySerial > baseDaySerial) {
    throw new Error("activity_anchor_onに未来の日付は指定できません。");
  }
  const elapsedDays = Math.round(
    (baseDaySerial - activityDaySerial) / dayMilliseconds,
  );
  const penalty =
    elapsedDays <= 60
      ? 0
      : Math.min(12, Math.floor((elapsedDays - 31) / 30) * 2);
  if (penalty === 0) {
    return { elapsed_days: elapsedDays, penalty };
  }
  const elapsedMonths = Math.floor(elapsedDays / 30);
  return {
    elapsed_days: elapsedDays,
    penalty,
    chip: `停滞${elapsedMonths}か月 -${penalty}`,
  };
}

function createEmptyImpactIndex(
  tasks: readonly IndexedTask[],
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const indexedTask of tasks) {
    index.set(indexedTask.task.gid, new Set<string>());
  }
  return index;
}

function addImpact(
  impactIndex: Map<string, Set<string>>,
  affectedTaskGid: string,
  impactingTaskGid: string,
): void {
  const impactingTasks = impactIndex.get(affectedTaskGid);
  if (impactingTasks == null) {
    return;
  }
  impactingTasks.add(impactingTaskGid);
}

function buildReleaseImpactIndex(
  tasks: readonly IndexedTask[],
  taskIndex: ReadonlyMap<string, IndexedTask>,
): Map<string, Set<string>> {
  const impactIndex = createEmptyImpactIndex(tasks);
  for (const indexedTask of tasks) {
    const task = indexedTask.task;
    if (!isActiveStatus(task.status)) {
      continue;
    }

    for (const dependency of task.dependencies) {
      const dependencyTask = taskIndex.get(dependency.task_gid);
      if (dependencyTask == null || dependencyTask.task.status === "completed") {
        continue;
      }
      addImpact(impactIndex, dependency.task_gid, task.gid);
    }

    if (task.parent_work_mode === "children_only") {
      for (const childGid of task.child_gids) {
        const child = taskIndex.get(childGid);
        if (child != null && child.task.status !== "completed") {
          addImpact(impactIndex, childGid, task.gid);
        }
      }
    }

    if (task.parent_gid != null) {
      const parent = taskIndex.get(task.parent_gid);
      if (
        parent != null &&
        isActiveStatus(parent.task.status) &&
        parent.task.parent_work_mode === "children_only" &&
        task.status !== "completed"
      ) {
        addImpact(impactIndex, task.gid, parent.task.gid);
      }
    }
  }
  return impactIndex;
}

function evaluateRelease(
  taskGid: string,
  impactIndex: ReadonlyMap<string, ReadonlySet<string>>,
  dueByGid: ReadonlyMap<string, DueEvaluation>,
): ReleaseEvaluation {
  const targetGids = [...(impactIndex.get(taskGid) ?? new Set<string>())].sort(
    compareStrings,
  );
  let points = 0;
  if (targetGids.length === 1) {
    points = 4;
  } else if (targetGids.length === 2) {
    points = 7;
  } else if (targetGids.length >= 3) {
    points = 10;
  }
  const hasUrgentTarget = targetGids.some((targetGid) => {
    const due = dueByGid.get(targetGid);
    return due != null && due.days_until_due != null && due.days_until_due <= 7;
  });
  if (hasUrgentTarget) {
    points = Math.min(12, points + 2);
  }
  return {
    target_gids: targetGids,
    points,
    has_urgent_target: hasUrgentTarget,
  };
}

function getExclusionReasons(
  indexedTask: IndexedTask,
): readonly RankingExclusionReason[] {
  const reasons: RankingExclusionReason[] = [];
  const { task, metadata } = indexedTask;
  if (!isActiveStatus(task.status)) {
    reasons.push({
      code: "inactive_status",
      message: "未着手または進行中ではありません。",
    });
  }
  if (task.block_state === "full") {
    reasons.push({
      code: "full_block",
      message: "完全ブロックされています。",
    });
  }
  if (metadata.dependency_cycle) {
    reasons.push({
      code: "dependency_cycle",
      message: "依存関係の循環に含まれています。",
    });
  }
  if (metadata.parent_cycle) {
    reasons.push({
      code: "parent_cycle",
      message: "親子関係の循環に含まれています。",
    });
  }
  if (metadata.completion_confirmation) {
    reasons.push({
      code: "completion_confirmation",
      message: "子タスク完了後の完了確認待ちです。",
    });
  }
  if (metadata.critical_errors.length > 0) {
    reasons.push({
      code: "critical_error",
      message: "正規化不能な重大エラーがあります。",
    });
  }
  return reasons;
}

function createReasonChips(
  task: RankingTask,
  due: DueEvaluation,
  release: ReleaseEvaluation,
  stagnation: StagnationEvaluation,
): readonly string[] {
  const chips: string[] = [
    `重要度${task.importance} +${importancePoints[task.importance]}`,
    due.chip,
  ];
  if (release.target_gids.length > 0) {
    chips.push(`${release.target_gids.length}件を解放 +${release.points}`);
  }
  if (task.block_state === "partial") {
    chips.push("一部ブロック -16");
  }
  if (stagnation.chip != null) {
    chips.push(stagnation.chip);
  }
  return chips;
}

function createTieBreak(
  task: RankingTask,
  due: DueEvaluation,
  release: ReleaseEvaluation,
): RankingTieBreak {
  const tieBreak: RankingTieBreak = {
    importance: task.importance,
    release_points: release.points,
    activity_anchor_on: task.activity_anchor_on,
    gid: task.gid,
  };
  if (due.effective_due_at != null) {
    return { ...tieBreak, effective_due_at: due.effective_due_at };
  }
  return tieBreak;
}

function createScore(
  task: RankingTask,
  due: DueEvaluation,
  release: ReleaseEvaluation,
  stagnation: StagnationEvaluation,
): RankingScoreBreakdown | undefined {
  if (task.block_state === "full") {
    return undefined;
  }
  const partialBlockPenalty = task.block_state === "partial" ? 16 : 0;
  const executionPoints =
    importancePoints[task.importance] +
    due.points +
    release.points -
    partialBlockPenalty -
    stagnation.penalty;
  return {
    importance_points: importancePoints[task.importance],
    deadline_points: due.points,
    release_points: release.points,
    partial_block_penalty: partialBlockPenalty,
    stagnation_penalty: stagnation.penalty,
    execution_points: executionPoints,
  };
}

function createDetail(evaluatedTask: EvaluatedTask): RankingDetail {
  const scoreText =
    evaluatedTask.score == null
      ? "点数: 完全ブロックのため算出しません。"
      : `点数: 重要度${evaluatedTask.score.importance_points}、期限${evaluatedTask.score.deadline_points}、解放${evaluatedTask.score.release_points}、一部ブロック減点${evaluatedTask.score.partial_block_penalty}、停滞減点${evaluatedTask.score.stagnation_penalty}、実行点${evaluatedTask.score.execution_points}`;
  const exclusionText =
    evaluatedTask.exclusion_reasons.length === 0
      ? "除外理由: なし"
      : `除外理由: ${evaluatedTask.exclusion_reasons
          .map((reason) => reason.message)
          .join("、")}`;
  const effectiveDueText =
    evaluatedTask.tie_break.effective_due_at == null
      ? "なし"
      : evaluatedTask.tie_break.effective_due_at;
  const tieBreakText = `タイブレーク: 実効期限${effectiveDueText}、重要度${evaluatedTask.tie_break.importance}、解放点${evaluatedTask.tie_break.release_points}、活動基準日${evaluatedTask.tie_break.activity_anchor_on}、GID${evaluatedTask.tie_break.gid}`;
  const text = [
    `入力: ${canonicalizeJson(evaluatedTask.indexed_task.task)}`,
    scoreText,
    exclusionText,
    `理由チップ: ${evaluatedTask.reason_chips.join("、")}`,
    tieBreakText,
  ].join("\n");
  const detailBase: RankingDetail = {
    input: evaluatedTask.indexed_task.task,
    exclusion_reasons: evaluatedTask.exclusion_reasons,
    tie_break: evaluatedTask.tie_break,
    reason_chips: evaluatedTask.reason_chips,
    text,
  };
  if (evaluatedTask.score == null) {
    return detailBase;
  }
  return { ...detailBase, score_breakdown: evaluatedTask.score };
}

function compareEvaluatedTasks(
  left: EvaluatedTask,
  right: EvaluatedTask,
): number {
  const leftScore = left.score;
  const rightScore = right.score;
  if (leftScore == null || rightScore == null) {
    throw new Error("順位対象に点数がないタスクがあります。");
  }
  if (leftScore.execution_points !== rightScore.execution_points) {
    return rightScore.execution_points - leftScore.execution_points;
  }
  const leftDue = left.due.effective_due_epoch;
  const rightDue = right.due.effective_due_epoch;
  if (leftDue == null && rightDue != null) {
    return 1;
  }
  if (leftDue != null && rightDue == null) {
    return -1;
  }
  if (leftDue != null && rightDue != null && leftDue !== rightDue) {
    return leftDue - rightDue;
  }
  if (left.indexed_task.task.importance !== right.indexed_task.task.importance) {
    return right.indexed_task.task.importance - left.indexed_task.task.importance;
  }
  if (left.release.points !== right.release.points) {
    return right.release.points - left.release.points;
  }
  const activityOrder = compareStrings(
    right.indexed_task.task.activity_anchor_on,
    left.indexed_task.task.activity_anchor_on,
  );
  if (activityOrder !== 0) {
    return activityOrder;
  }
  return compareStrings(left.indexed_task.task.gid, right.indexed_task.task.gid);
}

function compareExcludedTasks(left: EvaluatedTask, right: EvaluatedTask): number {
  return compareStrings(left.indexed_task.task.gid, right.indexed_task.task.gid);
}

function getRankingTaskMetadata(task: RankingTask): RankingTaskMetadata {
  return {
    dependency_cycle: task.dependency_cycle === true,
    parent_cycle: task.parent_cycle === true,
    completion_confirmation: task.completion_confirmation === true,
    critical_errors:
      task.critical_errors == null ? [] : [...task.critical_errors],
  };
}

function indexRankingTasks(
  tasks: readonly RankingTask[],
): readonly IndexedTask[] {
  const taskIndex = new Map<string, IndexedTask>();
  for (const task of tasks) {
    const metadata = getRankingTaskMetadata(task);
    if (taskIndex.has(task.gid)) {
      throw new DuplicateTaskGidError(task.gid);
    }
    taskIndex.set(task.gid, { task, metadata });
  }
  return [...taskIndex.values()];
}

function evaluateTaskSet(
  tasks: readonly IndexedTask[],
  asOf: string,
): readonly EvaluatedTask[] {
  const baseInstant = parseInstant(asOf);
  const baseDaySerial = getJstDaySerial(baseInstant);
  const taskIndex = new Map<string, IndexedTask>();
  for (const indexedTask of tasks) {
    taskIndex.set(indexedTask.task.gid, indexedTask);
  }

  const dueByGid = new Map<string, DueEvaluation>();
  const initialEvaluations: Array<{
    readonly indexed_task: IndexedTask;
    readonly due: DueEvaluation;
    readonly stagnation: StagnationEvaluation;
  }> = [];
  for (const indexedTask of tasks) {
    const due = evaluateDue(indexedTask.task, baseDaySerial);
    const stagnation = evaluateStagnation(indexedTask.task, baseDaySerial);
    dueByGid.set(indexedTask.task.gid, due);
    initialEvaluations.push({ indexed_task: indexedTask, due, stagnation });
  }

  const impactIndex = buildReleaseImpactIndex(tasks, taskIndex);
  return initialEvaluations.map((initialEvaluation) => {
    const release = evaluateRelease(
      initialEvaluation.indexed_task.task.gid,
      impactIndex,
      dueByGid,
    );
    const score = createScore(
      initialEvaluation.indexed_task.task,
      initialEvaluation.due,
      release,
      initialEvaluation.stagnation,
    );
    const exclusionReasons = getExclusionReasons(initialEvaluation.indexed_task);
    const evaluatedTaskBase = {
      indexed_task: initialEvaluation.indexed_task,
      due: initialEvaluation.due,
      stagnation: initialEvaluation.stagnation,
      release,
      exclusion_reasons: exclusionReasons,
      reason_chips: createReasonChips(
        initialEvaluation.indexed_task.task,
        initialEvaluation.due,
        release,
        initialEvaluation.stagnation,
      ),
      tie_break: createTieBreak(
        initialEvaluation.indexed_task.task,
        initialEvaluation.due,
        release,
      ),
    };
    if (score == null) {
      return evaluatedTaskBase;
    }
    return { ...evaluatedTaskBase, score };
  });
}

function createRankedResult(
  evaluatedTask: EvaluatedTask,
  rank: number,
): RankedTaskResult {
  if (evaluatedTask.score == null) {
    throw new Error("順位対象タスクの点数がありません。");
  }
  return {
    kind: "ranked",
    task: evaluatedTask.indexed_task.task,
    gid: evaluatedTask.indexed_task.task.gid,
    rank,
    score_breakdown: evaluatedTask.score,
    release_target_gids: evaluatedTask.release.target_gids,
    reason_chips: evaluatedTask.reason_chips,
    tie_break: evaluatedTask.tie_break,
    detail: createDetail(evaluatedTask),
  };
}

function createExcludedResult(evaluatedTask: EvaluatedTask): ExcludedTaskResult {
  const base: ExcludedTaskResult = {
    kind: "excluded",
    task: evaluatedTask.indexed_task.task,
    gid: evaluatedTask.indexed_task.task.gid,
    exclusion_reasons: evaluatedTask.exclusion_reasons,
    release_target_gids: evaluatedTask.release.target_gids,
    reason_chips: evaluatedTask.reason_chips,
    tie_break: evaluatedTask.tie_break,
    detail: createDetail(evaluatedTask),
  };
  if (evaluatedTask.score == null) {
    return base;
  }
  return { ...base, score_breakdown: evaluatedTask.score };
}

/** 正規化済みタスクからJST基準の決定論的な実行順位を計算します。 */
export function calculateTaskRanking(input: RankingInput): RankingResult {
  const parsedInput = rankingInputSchema.parse(input);
  const indexedTasks = indexRankingTasks(parsedInput.tasks);
  const evaluatedTasks = evaluateTaskSet(indexedTasks, parsedInput.as_of);
  const rankedTasks = evaluatedTasks
    .filter((evaluatedTask) => evaluatedTask.exclusion_reasons.length === 0)
    .sort(compareEvaluatedTasks)
    .map((evaluatedTask, index) => createRankedResult(evaluatedTask, index + 1));
  const excludedTasks = evaluatedTasks
    .filter((evaluatedTask) => evaluatedTask.exclusion_reasons.length > 0)
    .sort(compareExcludedTasks)
    .map(createExcludedResult);
  return {
    app_version: parsedInput.app_version,
    calculated_at: parsedInput.as_of,
    ranked_tasks: rankedTasks,
    excluded_tasks: excludedTasks,
  };
}
