export type EvidenceSource<TStatus extends string> =
  | {
      readonly kind: "user_message";
      readonly source_id: string;
      readonly text: string;
    }
  | {
      readonly kind: "task_notes";
      readonly source_id: string;
      readonly task_gid: string;
      readonly text: string;
    }
  | {
      readonly kind: "withdraw_confirmation";
      readonly source_id: string;
      readonly text: string;
      readonly target_task_gid: string;
      readonly baseline_status: TStatus;
      readonly baseline_completed: boolean;
    };

export type UserMessageSourceSummary<TStatus extends string> =
  | Extract<EvidenceSource<TStatus>, { readonly kind: "user_message" }>
  | Extract<EvidenceSource<TStatus>, { readonly kind: "withdraw_confirmation" }>;

export type PendingWithdrawConfirmation<TStatus extends string> = {
  readonly target_task_gid: string;
  readonly baseline_status: TStatus;
  readonly baseline_completed: boolean;
};

type TaskState<TStatus extends string> = {
  readonly gid: string;
  readonly notes: string;
  readonly status: TStatus;
  readonly completed: boolean;
};

type TaskSnapshot<TStatus extends string> = {
  readonly tasks: readonly TaskState<TStatus>[];
};

function findTaskByGid<TStatus extends string>(
  snapshot: TaskSnapshot<TStatus>,
  taskGid: string,
): TaskState<TStatus> | undefined {
  return snapshot.tasks.find((task) => task.gid === taskGid);
}

/** 取り下げ確認が同期済み状態に対応するか判定します。 */
export function isPendingWithdrawConfirmationValid<TStatus extends string>(
  snapshot: TaskSnapshot<TStatus>,
  pending: PendingWithdrawConfirmation<TStatus>,
): boolean {
  return isWithdrawConfirmationTargetCurrent(
    snapshot,
    pending.target_task_gid,
    pending.baseline_status,
    pending.baseline_completed,
  );
}

/** 取り下げ確認の対象が現在の状態に対応するか判定します。 */
export function isWithdrawConfirmationTargetCurrent<TStatus extends string>(
  snapshot: TaskSnapshot<TStatus>,
  targetTaskGid: string,
  baselineStatus: TStatus,
  baselineCompleted: boolean,
): boolean {
  const task = findTaskByGid(snapshot, targetTaskGid);
  return task != null
    && task.status === baselineStatus
    && task.completed === baselineCompleted
    && (task.status === "not_started" || task.status === "in_progress")
    && task.completed === false;
}

/** 保存済みの取り下げ確認根拠が現在の状態に対応するか判定します。 */
export function isWithdrawConfirmationSourceCurrent<TStatus extends string>(
  source: Extract<EvidenceSource<TStatus>, { readonly kind: "withdraw_confirmation" }>,
  snapshot: TaskSnapshot<TStatus>,
): boolean {
  return isWithdrawConfirmationTargetCurrent(
    snapshot,
    source.target_task_gid,
    source.baseline_status,
    source.baseline_completed,
  );
}

/** ターンで参照できる会話とタスクの原文を組み立てます。 */
export function createEvidenceSourceMap<TStatus extends string>(
  turnId: string,
  message: string,
  snapshot: TaskSnapshot<TStatus>,
  completedEvidenceSources: ReadonlyMap<string, EvidenceSource<TStatus>>,
  pendingWithdrawConfirmation: PendingWithdrawConfirmation<TStatus> | undefined,
  createUserMessageSourceId: (turnId: string) => string,
  createTaskNotesSourceId: (turnId: string, taskGid: string) => string,
  createWithdrawConfirmationSourceId: (turnId: string) => string,
): {
  readonly user_message_source_id: string;
  readonly user_message_sources: readonly UserMessageSourceSummary<TStatus>[];
  readonly withdraw_confirmation_source_id: string | undefined;
  readonly source_map: ReadonlyMap<string, EvidenceSource<TStatus>>;
} {
  const userMessageSourceId = createUserMessageSourceId(turnId);
  const sources = new Map<string, EvidenceSource<TStatus>>();
  const userMessageSources: UserMessageSourceSummary<TStatus>[] = [];
  for (const source of completedEvidenceSources.values()) {
    if (source.kind === "user_message") {
      sources.set(source.source_id, source);
      userMessageSources.push({
        kind: "user_message",
        source_id: source.source_id,
        text: source.text,
      });
      continue;
    }
    if (
      source.kind === "withdraw_confirmation"
      && isWithdrawConfirmationSourceCurrent(source, snapshot)
    ) {
      sources.set(source.source_id, source);
      userMessageSources.push({
        kind: "withdraw_confirmation",
        source_id: source.source_id,
        text: source.text,
        target_task_gid: source.target_task_gid,
        baseline_status: source.baseline_status,
        baseline_completed: source.baseline_completed,
      });
    }
  }
  sources.set(userMessageSourceId, {
    kind: "user_message",
    source_id: userMessageSourceId,
    text: message,
  });
  userMessageSources.push({
    kind: "user_message",
    source_id: userMessageSourceId,
    text: message,
  });
  const withdrawConfirmationSourceId = pendingWithdrawConfirmation == null
    ? undefined
    : createWithdrawConfirmationSourceId(turnId);
  if (withdrawConfirmationSourceId != null && pendingWithdrawConfirmation != null) {
    sources.set(withdrawConfirmationSourceId, {
      kind: "withdraw_confirmation",
      source_id: withdrawConfirmationSourceId,
      text: message,
      target_task_gid: pendingWithdrawConfirmation.target_task_gid,
      baseline_status: pendingWithdrawConfirmation.baseline_status,
      baseline_completed: pendingWithdrawConfirmation.baseline_completed,
    });
    userMessageSources.push({
      kind: "withdraw_confirmation",
      source_id: withdrawConfirmationSourceId,
      text: message,
      target_task_gid: pendingWithdrawConfirmation.target_task_gid,
      baseline_status: pendingWithdrawConfirmation.baseline_status,
      baseline_completed: pendingWithdrawConfirmation.baseline_completed,
    });
  }
  for (const task of snapshot.tasks) {
    const sourceId = createTaskNotesSourceId(turnId, task.gid);
    sources.set(sourceId, {
      kind: "task_notes",
      source_id: sourceId,
      task_gid: task.gid,
      text: task.notes,
    });
  }
  return {
    user_message_source_id: userMessageSourceId,
    user_message_sources: userMessageSources,
    withdraw_confirmation_source_id: withdrawConfirmationSourceId,
    source_map: sources,
  };
}
