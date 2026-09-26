type TaskStatusValue = "not_started" | "in_progress" | "completed" | "withdrawn";

type SectionGids = {
  readonly not_started: string;
  readonly in_progress: string;
  readonly completed: string;
  readonly withdrawn: string;
};

export type StatusDefinition = {
  readonly status: TaskStatusValue;
  readonly section_gid: string;
  readonly completed: boolean;
};

type StatusTask = {
  readonly completed: boolean;
  readonly memberships: readonly {
    readonly project: { readonly gid: string };
    readonly section: { readonly gid: string } | null;
  }[];
};

type FieldClassification = "before" | "partial" | "after" | "conflict";

type StatusOperation =
  | { readonly operation: "set_status"; readonly before: TaskStatusValue; readonly after: TaskStatusValue }
  | { readonly operation: "complete" | "withdraw"; readonly before: TaskStatusValue };

type StatusWriteResult<TReason extends string> =
  | { readonly kind: "completed"; readonly changed: boolean }
  | {
      readonly kind: "conflict";
      readonly side_effect: "none" | "possible";
      readonly reason_code?: TReason;
    };

/** 状態操作後の状態とセクションを求めます。 */
export function expectedStatus(
  status: TaskStatusValue,
  sectionGids: SectionGids,
): StatusDefinition {
  switch (status) {
    case "not_started":
      return { status, section_gid: sectionGids.not_started, completed: false };
    case "in_progress":
      return { status, section_gid: sectionGids.in_progress, completed: false };
    case "completed":
      return { status, section_gid: sectionGids.completed, completed: true };
    case "withdrawn":
      return { status, section_gid: sectionGids.withdrawn, completed: true };
  }
}

function statusForOperation(operation: StatusOperation): TaskStatusValue {
  switch (operation.operation) {
    case "set_status":
      return operation.after;
    case "complete":
      return "completed";
    case "withdraw":
      return "withdrawn";
  }
}

/** 状態操作のセクションと完了状態を適用前後で判定します。 */
export function classifyStatusOperation(
  operation: StatusOperation,
  task: StatusTask,
  projectGid: string,
  sectionGids: SectionGids,
): FieldClassification {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    return "conflict";
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    return "conflict";
  }
  const before = expectedStatus(operation.before, sectionGids);
  const after = expectedStatus(statusForOperation(operation), sectionGids);
  const sectionGid = membership.section.gid;
  if (sectionGid === after.section_gid && task.completed === after.completed) {
    return "after";
  }
  if (sectionGid === before.section_gid && task.completed === before.completed) {
    return "before";
  }
  if (
    sectionGid === after.section_gid
    && task.completed === before.completed
    && before.completed !== after.completed
  ) {
    return "partial";
  }
  return "conflict";
}

function taskProjectMembership<TTask extends StatusTask>(
  task: TTask,
  projectGid: string,
): TTask["memberships"][number] | undefined {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length > 1) {
    throw new Error("対象タスクの専用プロジェクト所属が重複しています。");
  }
  return memberships[0];
}

function classifyStatusTransition(
  task: StatusTask,
  projectGid: string,
  before: StatusDefinition,
  after: StatusDefinition,
): FieldClassification {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    return "conflict";
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    return "conflict";
  }
  const sectionGid = membership.section.gid;
  if (sectionGid === after.section_gid && task.completed === after.completed) {
    return "after";
  }
  if (sectionGid === before.section_gid && task.completed === before.completed) {
    return "before";
  }
  if (
    sectionGid === after.section_gid
    && task.completed === before.completed
    && before.completed !== after.completed
  ) {
    return "partial";
  }
  return "conflict";
}

/** セクションと完了状態を読戻しを挟んで順に適用します。 */
export async function applyStatus<TTask extends StatusTask, TReason extends string>(
  projectGid: string,
  before: StatusDefinition,
  after: StatusDefinition,
  readTask: () => Promise<TTask>,
  addTaskToSection: (sectionGid: string) => Promise<unknown>,
  updateCompleted: (completed: boolean) => Promise<unknown>,
  beforeWrite: (task: TTask) => TReason | undefined,
  onWriteAttempt: (action: "add_task_to_section" | "update_task") => void,
): Promise<StatusWriteResult<TReason>> {
  let changed = false;
  let task = await readTask();
  let state = classifyStatusTransition(task, projectGid, before, after);
  if (state === "conflict") {
    return { kind: "conflict", side_effect: "none" };
  }
  if (state === "after") {
    return { kind: "completed", changed };
  }
  const membership = taskProjectMembership(task, projectGid);
  if (membership == null || membership.section == null) {
    return { kind: "conflict", side_effect: changed ? "possible" : "none" };
  }
  if (membership.section.gid !== after.section_gid) {
    const guardReason = beforeWrite(task);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    onWriteAttempt("add_task_to_section");
    await addTaskToSection(after.section_gid);
    changed = true;
    task = await readTask();
    state = classifyStatusTransition(task, projectGid, before, after);
    if (state !== "partial" && state !== "after") {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  task = await readTask();
  state = classifyStatusTransition(task, projectGid, before, after);
  if (state === "after") {
    return { kind: "completed", changed };
  }
  if (state === "conflict" || (state === "before" && before.section_gid !== after.section_gid)) {
    return { kind: "conflict", side_effect: changed ? "possible" : "none" };
  }
  if (task.completed !== after.completed) {
    const guardReason = beforeWrite(task);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    onWriteAttempt("update_task");
    await updateCompleted(after.completed);
    changed = true;
    task = await readTask();
    state = classifyStatusTransition(task, projectGid, before, after);
    if (state !== "after") {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  return { kind: "completed", changed };
}
