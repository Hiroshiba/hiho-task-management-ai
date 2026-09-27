type TaskStatus = "not_started" | "in_progress" | "completed" | "withdrawn";

type ProposalDependencyInput = {
  readonly task_gid: string;
  readonly scope: string;
  readonly source: string;
};

type ProposalTask = {
  readonly name: string;
  readonly notes: string;
  readonly completed: boolean;
  readonly due_on: string | null;
  readonly due_at: string | null;
  readonly parent: { readonly gid: string } | null;
  readonly memberships: readonly {
    readonly project: { readonly gid: string };
    readonly section: { readonly gid: string } | null;
  }[];
  readonly tags: readonly { readonly name: string }[];
};

type ProposalExternalData = {
  readonly duration?: { readonly value: number; readonly unit: string } | undefined;
  readonly dependencies: readonly ProposalDependencyInput[];
  readonly parent_work_mode: string;
};

type ProposalInput = {
  readonly task_gid: string;
  readonly project_gid: string;
  readonly section_gids: Readonly<Record<TaskStatus, string>>;
  readonly baseline_task: ProposalTask;
};

type ProposalGuiOperation =
  | { readonly kind: "set_status" | "restore"; readonly value: TaskStatus }
  | { readonly kind: "set_dependencies"; readonly value: readonly ProposalDependencyInput[] }
  | {
      readonly kind:
        | "update_title"
        | "update_notes"
        | "set_importance"
        | "set_due"
        | "set_duration"
        | "set_area"
        | "set_parent"
        | "set_parent_work_mode"
        | "link_obsidian"
        | "unlink_obsidian";
      readonly value: unknown;
    }
  | { readonly kind: "complete" | "withdraw" | "clear_due" | "clear_duration" };

type ProposalDependency = {
  readonly target: { readonly kind: "existing"; readonly gid: string };
  readonly scope: string;
  readonly source: string;
};
type ProposalParent =
  | { readonly kind: "absent" }
  | { readonly kind: "existing"; readonly gid: string };
type ProposalDue =
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type ProposalDuration =
  | { readonly kind: "absent" }
  | { readonly value: number; readonly unit: string };
type ProposalOperationParser<T> = (value: Record<string, unknown>) => T;

const operationSnapshotHash = "0000000000000000000000000000000000000000000000000000000000000000";
const operationReason = "GUIによる直接編集";
const operationEvidenceLocator = "gui-edit";
const importanceTagPrefix = "TaskHub/重要度/";
const areaTagPrefix = "TaskHub/領域/";
const unclassifiedArea = "未分類";

function statusFromTask(
  task: ProposalTask,
  projectGid: string,
  sectionGids: Readonly<Record<TaskStatus, string>>,
): TaskStatus {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    throw new Error("対象タスクの専用プロジェクト所属を一意に確認できません。");
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    throw new Error("対象タスクの状態セクションを確認できません。");
  }
  const statuses: readonly [TaskStatus, string, boolean][] = [
    ["not_started", sectionGids.not_started, false],
    ["in_progress", sectionGids.in_progress, false],
    ["completed", sectionGids.completed, true],
    ["withdrawn", sectionGids.withdrawn, true],
  ];
  const matched = statuses.find(
    (status) => status[1] === membership.section?.gid,
  );
  if (matched == null) {
    throw new Error("対象タスクの状態セクションが不正です。");
  }
  if (matched[2] !== task.completed) {
    throw new Error("対象タスクの状態セクションと完了フラグが一致しません。");
  }
  return matched[0];
}

function importanceFromTask(task: ProposalTask): number {
  const tags = task.tags.filter((tag) => tag.name.startsWith(importanceTagPrefix));
  if (tags.length === 0) {
    return 3;
  }
  const values = tags.map((tag) => {
    const value = Number(tag.name.slice(importanceTagPrefix.length));
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error("重要度タグ名が不正です。");
    }
    return value;
  });
  return Math.max(...values);
}

function areaFromTask(task: ProposalTask): string {
  const tags = task.tags.filter((tag) => tag.name.startsWith(areaTagPrefix));
  if (tags.length !== 1) {
    return unclassifiedArea;
  }
  const tag = tags[0];
  if (tag == null) {
    throw new Error("領域タグを取得できません。");
  }
  const area = tag.name.slice(areaTagPrefix.length);
  if (area.trim().length === 0) {
    throw new Error("領域タグ名が不正です。");
  }
  return area;
}

function dueFromTask(
  task: ProposalTask,
): ProposalDue {
  if (task.due_on != null && task.due_at != null) {
    throw new Error("対象タスクの期限形式が不正です。");
  }
  if (task.due_on != null) {
    return { kind: "due_on", due_on: task.due_on };
  }
  if (task.due_at != null) {
    return { kind: "due_at", due_at: task.due_at };
  }
  return { kind: "absent" };
}

function proposalDependencies(
  dependencies: readonly ProposalDependencyInput[],
): ProposalDependency[] {
  return dependencies.map((dependency) => ({
    target: { kind: "existing", gid: dependency.task_gid },
    scope: dependency.scope,
    source: dependency.source,
  }));
}

function proposalParent(
  task: ProposalTask,
): ProposalParent {
  return task.parent == null
    ? { kind: "absent" }
    : { kind: "existing", gid: task.parent.gid };
}

function proposalDuration(
  external: ProposalExternalData,
): ProposalDuration {
  return external.duration == null
    ? { kind: "absent" }
    : external.duration;
}

function proposalOperationInput(
  input: ProposalInput,
  operationId: string,
): Record<string, unknown> {
  return {
    operation_id: operationId,
    baseline_snapshot_hash: operationSnapshotHash,
    reason: operationReason,
    basis: "explicit",
    confidence: 1,
    evidence_refs: [{ kind: "user_message", locator: operationEvidenceLocator }],
    target: { kind: "existing", gid: input.task_gid },
  };
}

function statusOperation<T>(
  input: ProposalInput,
  operationId: string,
  before: TaskStatus,
  after: TaskStatus,
  parseProposalOperation: ProposalOperationParser<T>,
): T {
  const common = proposalOperationInput(input, operationId);
  if (after === "completed") {
    if (before !== "not_started" && before !== "in_progress") {
      throw new Error("完了操作の対象状態が不正です。");
    }
    return parseProposalOperation({
      ...common,
      operation: "complete",
      before,
      after: "completed",
      basis: "explicit",
      status_evidence: {
        kind: "user_explicit",
        reference: { kind: "user_message", locator: operationEvidenceLocator },
      },
    });
  }
  if (after === "withdrawn") {
    if (before !== "not_started" && before !== "in_progress") {
      throw new Error("取り下げ操作の対象状態が不正です。");
    }
    return parseProposalOperation({
      ...common,
      operation: "withdraw",
      before,
      after: "withdrawn",
      basis: "explicit",
      status_evidence: {
        kind: "user_explicit",
        reference: { kind: "user_message", locator: operationEvidenceLocator },
      },
    });
  }
  return parseProposalOperation({
    ...common,
    operation: "set_status",
    before,
    after,
  });
}

/** GUI直接編集を変更案の操作へ変換します。 */
export function buildProposalOperation<T>(
  input: ProposalInput,
  operationId: string,
  external: ProposalExternalData | undefined,
  operation: ProposalGuiOperation,
  parseProposalOperation: ProposalOperationParser<T>,
): T {
  const common = proposalOperationInput(input, operationId);
  const task = input.baseline_task;
  switch (operation.kind) {
    case "update_title":
      return parseProposalOperation({
        ...common,
        operation: "update_title",
        before: task.name,
        after: operation.value,
      });
    case "update_notes":
      return parseProposalOperation({
        ...common,
        operation: "update_notes",
        before: task.notes,
        after: operation.value,
      });
    case "set_status":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        operation.value,
        parseProposalOperation,
      );
    case "complete":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        "completed",
        parseProposalOperation,
      );
    case "withdraw":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        "withdrawn",
        parseProposalOperation,
      );
    case "restore":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        operation.value,
        parseProposalOperation,
      );
    case "set_importance":
      return parseProposalOperation({
        ...common,
        operation: "set_importance",
        before: importanceFromTask(task),
        after: operation.value,
      });
    case "set_due":
      return parseProposalOperation({
        ...common,
        operation: "set_due",
        before: dueFromTask(task),
        after: operation.value,
      });
    case "clear_due":
      return parseProposalOperation({
        ...common,
        operation: "clear_due",
        before: dueFromTask(task),
        after: { kind: "absent" },
      });
    case "set_duration":
      if (external == null) {
        throw new Error("所要時間操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "set_duration",
        before: proposalDuration(external),
        after: operation.value,
      });
    case "clear_duration":
      if (external == null) {
        throw new Error("所要時間操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "clear_duration",
        before: proposalDuration(external),
        after: { kind: "absent" },
      });
    case "set_area":
      return parseProposalOperation({
        ...common,
        operation: "set_area",
        before: areaFromTask(task),
        after: operation.value,
      });
    case "set_dependencies":
      if (external == null) {
        throw new Error("依存関係操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "set_dependencies",
        before: proposalDependencies(external.dependencies),
        after: proposalDependencies(operation.value),
      });
    case "set_parent":
      return parseProposalOperation({
        ...common,
        operation: "set_parent",
        before: proposalParent(task),
        after: operation.value,
      });
    case "set_parent_work_mode":
      if (external == null) {
        throw new Error("親作業モード操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "set_parent_work_mode",
        before: external.parent_work_mode,
        after: operation.value,
      });
    case "link_obsidian":
      if (external == null) {
        throw new Error("Obsidianリンク操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "link_obsidian",
        before: { kind: "absent" },
        after: operation.value,
      });
    case "unlink_obsidian":
      if (external == null) {
        throw new Error("Obsidianリンク操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "unlink_obsidian",
        before: operation.value,
        after: { kind: "absent" },
      });
  }
}
