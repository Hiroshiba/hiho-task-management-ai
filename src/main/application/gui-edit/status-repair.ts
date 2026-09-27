import type { TaskWriteStepDraft } from "../common/task-write-step";

export type GuiStatus = "not_started" | "in_progress" | "completed" | "withdrawn";

export type GuiStatusTask = {
  readonly completed: boolean;
  readonly memberships: readonly {
    readonly project: { readonly gid: string };
    readonly section: { readonly gid: string } | null;
  }[];
};

type Membership =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly section_gid: string | null };

type Snapshot = { readonly completed: boolean; readonly membership: Membership };

function snapshot(task: GuiStatusTask, projectGid: string): Snapshot {
  const memberships = task.memberships.filter((membership) => membership.project.gid === projectGid);
  if (memberships.length > 1) throw new Error("対象タスクの専用プロジェクト所属が重複しています。");
  const membership = memberships[0];
  return {
    completed: task.completed,
    membership: membership == null
      ? { kind: "absent" }
      : { kind: "present", section_gid: membership.section?.gid ?? null },
  };
}

/** GUI編集の基準状態に修復が必要か判定します。 */
export function guiStatusNeedsRepair(
  task: GuiStatusTask,
  projectGid: string,
  sectionGids: Readonly<Record<GuiStatus, string>>,
): boolean {
  const state = snapshot(task, projectGid);
  if (state.membership.kind === "absent" || state.membership.section_gid == null) return true;
  if (!Object.values(sectionGids).includes(state.membership.section_gid)) return true;
  const completed = state.membership.section_gid === sectionGids.completed
    || state.membership.section_gid === sectionGids.withdrawn;
  return state.completed !== completed;
}

/** 状態修復前のプロジェクト所属と完了値を再取得値で照合します。 */
export function guiStatusBaselineMatches(
  baseline: GuiStatusTask,
  current: GuiStatusTask,
  projectGid: string,
): boolean {
  const before = snapshot(baseline, projectGid);
  const actual = snapshot(current, projectGid);
  return before.completed === actual.completed
    && before.membership.kind === actual.membership.kind
    && (before.membership.kind === "absent" || actual.membership.kind === "present"
      && before.membership.section_gid === actual.membership.section_gid);
}

/** 状態修復のAsana callを保存用stepへ分割します。 */
export function planGuiStatusRepair(
  task: GuiStatusTask,
  projectGid: string,
  sectionGids: Readonly<Record<GuiStatus, string>>,
  targetStatus: GuiStatus,
  taskGid: string,
  operationId: string,
): readonly TaskWriteStepDraft[] {
  const state = snapshot(task, projectGid);
  const sectionGid = sectionGids[targetStatus];
  const completed = targetStatus === "completed" || targetStatus === "withdrawn";
  const target = { kind: "existing", gid: taskGid } as const;
  const steps: TaskWriteStepDraft[] = [];
  if (state.membership.kind === "absent") {
    steps.push({
      kind: "asana_add_to_project",
      payload: { target, project_gid: projectGid, section_gid: sectionGid },
      step_id: `${operationId}:1`,
      scope: { kind: "operation", operation_id: operationId },
    });
  } else if (state.membership.section_gid !== sectionGid) {
    steps.push({
      kind: "asana_add_to_section",
      payload: { target, before_section_gid: state.membership.section_gid, after_section_gid: sectionGid },
      step_id: `${operationId}:1`,
      scope: { kind: "operation", operation_id: operationId },
    });
  }
  if (state.completed !== completed) {
    steps.push({
      kind: "asana_update_task",
      payload: { target, update: { kind: "completed", before: state.completed, after: completed } },
      step_id: `${operationId}:${steps.length + 1}`,
      scope: { kind: "operation", operation_id: operationId },
    });
  }
  return steps;
}
