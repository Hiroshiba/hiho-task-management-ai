type ObsidianLink = { readonly vault_id: string; readonly path: string };

type RebindOperation =
  | { readonly operation: "unlink_obsidian"; readonly before: ObsidianLink }
  | { readonly operation:
      | "update_title" | "update_notes" | "set_status" | "complete" | "withdraw"
      | "set_importance" | "set_due" | "clear_due" | "set_duration" | "clear_duration"
      | "set_area" | "set_dependencies" | "set_parent" | "set_parent_work_mode"
      | "link_obsidian"; readonly before: unknown };

type RebindTask = {
  readonly title: string;
  readonly notes: string;
  readonly status: string;
  readonly importance: number;
  readonly due_on?: string | undefined;
  readonly due_at?: string | undefined;
  readonly duration?: { readonly value: number; readonly unit: string } | undefined;
  readonly area: string;
  readonly dependencies: readonly { readonly task_gid: string; readonly scope: string; readonly source: string }[];
  readonly parent_gid?: string | undefined;
  readonly parent_work_mode: string;
  readonly obsidian_links: readonly ObsidianLink[];
};

/** 前案の操作に対する現在の基準値を求めます。 */
export function rebindBeforeValue(operation: RebindOperation, task: RebindTask): unknown {
  let before: unknown = operation.before;
  switch (operation.operation) {
    case "update_title":
      before = task.title;
      break;
    case "update_notes":
      before = task.notes;
      break;
    case "set_status":
    case "complete":
    case "withdraw":
      if (operation.operation === "set_status"
        || task.status === "not_started" || task.status === "in_progress") {
        before = task.status;
      }
      break;
    case "set_importance":
      before = task.importance;
      break;
    case "set_due":
    case "clear_due":
      if (task.due_on != null) {
        before = { kind: "due_on", due_on: task.due_on };
      } else if (task.due_at != null) {
        before = { kind: "due_at", due_at: task.due_at };
      } else if (operation.operation === "set_due") {
        before = { kind: "absent" };
      }
      break;
    case "set_duration":
    case "clear_duration":
      if (task.duration != null) {
        before = task.duration;
      } else if (operation.operation === "set_duration") {
        before = { kind: "absent" };
      }
      break;
    case "set_area":
      before = task.area;
      break;
    case "set_dependencies":
      before = task.dependencies.map((dependency) => ({
        target: { kind: "existing", gid: dependency.task_gid },
        scope: dependency.scope,
        source: dependency.source,
      }));
      break;
    case "set_parent":
      before = task.parent_gid == null
        ? { kind: "absent" }
        : { kind: "existing", gid: task.parent_gid };
      break;
    case "set_parent_work_mode":
      before = task.parent_work_mode;
      break;
    case "link_obsidian":
      break;
    case "unlink_obsidian":
      before = task.obsidian_links.find((link) =>
        link.vault_id === operation.before.vault_id
        && link.path === operation.before.path) ?? operation.before;
      break;
  }
  return before;
}

/** 前案のタスクノート引用が現ターンでも有効なら現在の原文位置を返します。 */
function findReboundTaskNoteSource<TSource extends {
  readonly kind: string;
  readonly source_id: string;
  readonly task_gid?: string;
  readonly text: string;
}>(
  reference: { readonly locator: string; readonly excerpt?: string | undefined },
  operation: "complete" | "withdraw",
  taskGid: string,
  previousSourceMap: ReadonlyMap<string, TSource>,
  currentSourceMap: ReadonlyMap<string, TSource>,
  userMessageSourceId: string,
  dependencies: {
    readonly createStatusEvidenceLocator: (sourceId: string, operation: "complete" | "withdraw", taskGid: string) => string;
    readonly createTaskNotesSourceId: (turnId: string, taskGid: string) => string;
    readonly verifiedSourceExcerpt: (source: TSource, excerpt: string | undefined) => string | undefined;
  },
): string | undefined {
  const previousSource = [...previousSourceMap.values()].find((source) =>
    source.kind === "task_notes"
    && source.task_gid === taskGid
    && dependencies.createStatusEvidenceLocator(source.source_id, operation, taskGid)
      === reference.locator);
  const currentSource = currentSourceMap.get(
    dependencies.createTaskNotesSourceId(
      userMessageSourceId.slice("user-message:".length),
      taskGid,
    ),
  );
  if (
    previousSource?.kind === "task_notes"
    && currentSource?.kind === "task_notes"
    && dependencies.verifiedSourceExcerpt(previousSource, reference.excerpt) != null
    && dependencies.verifiedSourceExcerpt(currentSource, reference.excerpt) != null
  ) {
    return currentSource.source_id;
  }
  return undefined;
}

type RebindTarget =
  | { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };

type RebindInitialOperation =
  | { readonly operation: "create_task"; readonly baseline_snapshot_hash: string }
  | (RebindOperation & {
      readonly target: RebindTarget;
      readonly baseline_snapshot_hash: string;
      readonly status_evidence?: {
        readonly kind: string;
        readonly reference: { readonly kind: string; readonly locator: string; readonly excerpt?: string | undefined };
      };
    });

type RebindSource = {
  readonly kind: string;
  readonly source_id: string;
  readonly task_gid?: string;
  readonly text: string;
};

/** 前案の操作基準値と引用位置を現ターンへ結び直します。 */
export function rebindInitialOperation<
  TOperation extends RebindInitialOperation,
  TTask extends RebindTask & { readonly gid: string },
  TSource extends RebindSource,
>(
  operation: TOperation,
  prepared: {
    readonly baseline_snapshot_hash: string;
    readonly snapshot: { readonly tasks: readonly TTask[] };
    readonly source_map: ReadonlyMap<string, TSource>;
    readonly user_message_source_id: string;
  },
  previous: { readonly source_map: ReadonlyMap<string, TSource> } | undefined,
  dependencies: {
    readonly resolveCreate: (operation: TOperation) => TOperation;
    readonly resolveStatus: (operation: TOperation) => TOperation;
    readonly parseOperation: (value: unknown) => TOperation;
    readonly createStatusEvidenceLocator: (sourceId: string, operation: "complete" | "withdraw", taskGid: string) => string;
    readonly createTaskNotesSourceId: (turnId: string, taskGid: string) => string;
    readonly verifiedSourceExcerpt: (source: TSource, excerpt: string | undefined) => string | undefined;
  },
): TOperation {
  const baseline_snapshot_hash = prepared.baseline_snapshot_hash;
  if (operation.operation === "create_task") {
    return dependencies.resolveCreate(operation);
  }
  const reboundEvidence = operation.operation === "complete" || operation.operation === "withdraw"
    ? dependencies.resolveStatus(operation)
    : operation;
  if (reboundEvidence.operation === "create_task") {
    throw new Error("根拠継承後の操作種別が変わりました。");
  }
  if (reboundEvidence.target.kind !== "existing") {
    return dependencies.parseOperation({ ...reboundEvidence, baseline_snapshot_hash });
  }
  const targetGid = reboundEvidence.target.gid;
  const task = prepared.snapshot.tasks.find((candidate) =>
    candidate.gid === targetGid);
  if (task == null) {
    return dependencies.parseOperation({ ...reboundEvidence, baseline_snapshot_hash });
  }
  const before = rebindBeforeValue(reboundEvidence, task);
  let rebound = dependencies.parseOperation({
    ...reboundEvidence,
    baseline_snapshot_hash,
    before,
  });
  if (
    previous != null
    && (rebound.operation === "complete" || rebound.operation === "withdraw")
    && rebound.status_evidence?.kind === "task_or_note_explicit"
    && rebound.status_evidence.reference.kind === "task"
  ) {
    const reference = rebound.status_evidence.reference;
    const currentSourceId = findReboundTaskNoteSource(
      reference,
      rebound.operation,
      task.gid,
      previous.source_map,
      prepared.source_map,
      prepared.user_message_source_id,
      dependencies,
    );
    if (currentSourceId != null) {
      rebound = dependencies.parseOperation({
        ...rebound,
        status_evidence: {
          ...rebound.status_evidence,
          reference: { ...reference, locator: currentSourceId },
        },
      });
    }
  }
  return rebound;
}

/** 前案全体の操作基準値を現ターンへ結び直します。 */
export function rebindInitialProposal<
  TOperation extends RebindInitialOperation,
  TProposal extends { readonly groups: readonly { readonly operations: readonly TOperation[] }[] },
>(
  proposal: TProposal | undefined,
  rebindOperation: (operation: TOperation) => TOperation,
  parseProposal: (value: unknown) => TProposal,
): TProposal | undefined {
  if (proposal == null) {
    return undefined;
  }
  return parseProposal({
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map(rebindOperation),
    })),
  });
}
