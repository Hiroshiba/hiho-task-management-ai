import { applyCategoryTag } from "./category-tag-write";
import { type CreateTask } from "./create-read-back";
import { applyStatus, expectedStatus } from "./status-write";

type Tag = { readonly gid: string; readonly name: string };
type Target = { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };
type Parent = Target | { readonly kind: "absent" };
type Due = { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type PresentDue = Exclude<Due, { readonly kind: "absent" }>;
type TaskStatus = "not_started" | "in_progress" | "completed" | "withdrawn";
type SectionGids = {
  readonly not_started: string;
  readonly in_progress: string;
  readonly completed: string;
  readonly withdrawn: string;
};
type NativeOperation =
  | { readonly operation: "update_title" | "update_notes" | "set_area"; readonly before: string; readonly after: string }
  | { readonly operation: "set_importance"; readonly before: number; readonly after: number }
  | { readonly operation: "set_status" | "complete" | "withdraw"; readonly before: TaskStatus; readonly after: TaskStatus }
  | { readonly operation: "set_due"; readonly after: PresentDue }
  | { readonly operation: "clear_due" }
  | { readonly operation: "set_parent"; readonly after: Parent }
  | { readonly operation: "set_dependencies" | "set_parent_work_mode" | "link_obsidian" | "unlink_obsidian" | "set_duration" | "clear_duration" };
type NativeInput = { readonly project_gid: string; readonly section_gids: SectionGids };
type NativeTask<TTag extends Tag> = CreateTask<TTag> & { readonly gid: string };
type ConflictReason =
  | "baseline_changed" | "read_back_mismatch" | "external_unreadable"
  | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded";
type CoreWriteResult =
  | { readonly kind: "completed"; readonly changed: boolean }
  | { readonly kind: "conflict"; readonly side_effect: "none" | "possible"; readonly reason_code?: ConflictReason };
type NativeUpdate =
  | { readonly kind: "title" | "notes" | "due_on" | "due_at"; readonly value: string }
  | { readonly kind: "completed"; readonly value: boolean }
  | { readonly kind: "clear_due" };
type WriteAction =
  | "create_task" | "update_task" | "add_task_to_project" | "add_task_to_section"
  | "add_task_tag" | "remove_task_tag" | "set_task_parent" | "clear_task_parent";

type NativeWriteDependencies<TTask extends NativeTask<TTag>, TTag extends Tag> = {
  readonly readTask: (taskGid: string, signal: AbortSignal) => Promise<TTask>;
  readonly updateTask: (taskGid: string, update: NativeUpdate, signal: AbortSignal) => Promise<unknown>;
  readonly addTaskToSection: (taskGid: string, sectionGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly addTaskTag: (taskGid: string, tagGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly removeTaskTag: (taskGid: string, tagGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly clearTaskParent: (taskGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly setTaskParent: (taskGid: string, parentGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly taskDueValue: (task: TTask) => Due;
  readonly sameDueValue: (left: Due, right: Due) => boolean;
  readonly taskParentGid: (task: TTask) => string | null;
  readonly resolveParentGid: (parent: Parent, mappings: ReadonlyMap<string, string>) => string | null;
  readonly importanceTagPrefix: string;
  readonly areaTagPrefix: string;
  readonly unclassifiedArea: string;
  readonly importanceTagName: (value: number) => string;
  readonly areaTagName: (value: string) => string;
};

/** ワークスペースのタグ一覧を取得済みと確認します。 */
export function requireWorkspaceTags<TTag extends Tag>(tags: readonly TTag[] | undefined): readonly TTag[] {
  if (tags == null) throw new Error("ワークスペースタグが必要です。");
  return tags;
}

function createDueUpdate(due: PresentDue): NativeUpdate {
  switch (due.kind) {
    case "due_on": return { kind: "due_on", value: due.due_on };
    case "due_at": return { kind: "due_at", value: due.due_at };
  }
}

/** 17操作のAsana native field、タグ、親関係を従来の順で適用します。 */
export async function applyNativeOperation<TTask extends NativeTask<TTag>, TTag extends Tag>(
  operation: NativeOperation,
  task: TTask,
  input: NativeInput,
  mappings: ReadonlyMap<string, string>,
  tags: readonly TTag[] | undefined,
  beforeWrite: (task: TTask) => ConflictReason | undefined,
  onWriteAttempt: (action: WriteAction) => void,
  signal: AbortSignal,
  dependencies: NativeWriteDependencies<TTask, TTag>,
): Promise<CoreWriteResult> {
  switch (operation.operation) {
    case "update_title":
      if (task.name === operation.after) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      onWriteAttempt("update_task");
      await dependencies.updateTask(task.gid, { kind: "title", value: operation.after }, signal);
      return { kind: "completed", changed: true };
    case "update_notes":
      if (task.notes === operation.after) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      onWriteAttempt("update_task");
      await dependencies.updateTask(task.gid, { kind: "notes", value: operation.after }, signal);
      return { kind: "completed", changed: true };
    case "set_status":
    case "complete":
    case "withdraw": {
      const before = expectedStatus(
        operation.before,
        input.section_gids,
      );
      const after = expectedStatus(operation.after, input.section_gids);
      return applyStatus(
        input.project_gid,
        before,
        after,
        async () => await dependencies.readTask(task.gid, signal),
        (sectionGid) => dependencies.addTaskToSection(task.gid, sectionGid, signal),
        (completed) => dependencies.updateTask(
          task.gid,
          { kind: "completed", value: completed },
          signal,
        ),
        beforeWrite,
        onWriteAttempt,
      );
    }
    case "set_importance": {
      const workspaceTags = requireWorkspaceTags(tags);
      return applyCategoryTag(
        {
          kind: "operation",
          prefix: dependencies.importanceTagPrefix,
          before_name: dependencies.importanceTagName(operation.before),
          after_name: dependencies.importanceTagName(operation.after),
          default_before: 3,
          before_value: operation.before,
          after_value: operation.after,
        },
        workspaceTags,
        async () => await dependencies.readTask(task.gid, signal),
        (tagGid) => dependencies.addTaskTag(task.gid, tagGid, signal),
        (tagGid) => dependencies.removeTaskTag(task.gid, tagGid, signal),
        beforeWrite,
        onWriteAttempt,
      );
    }
    case "set_due": {
      const current = dependencies.taskDueValue(task);
      if (dependencies.sameDueValue(current, operation.after)) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      onWriteAttempt("update_task");
      await dependencies.updateTask(task.gid, createDueUpdate(operation.after), signal);
      return { kind: "completed", changed: true };
    }
    case "clear_due":
      if (dependencies.taskDueValue(task).kind === "absent") {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      onWriteAttempt("update_task");
      await dependencies.updateTask(task.gid, { kind: "clear_due" }, signal);
      return { kind: "completed", changed: true };
    case "set_area": {
      const workspaceTags = requireWorkspaceTags(tags);
      return applyCategoryTag(
        {
          kind: "operation",
          prefix: dependencies.areaTagPrefix,
          before_name: dependencies.areaTagName(operation.before),
          after_name: dependencies.areaTagName(operation.after),
          default_before: dependencies.unclassifiedArea,
          before_value: operation.before,
          after_value: operation.after,
        },
        workspaceTags,
        async () => await dependencies.readTask(task.gid, signal),
        (tagGid) => dependencies.addTaskTag(task.gid, tagGid, signal),
        (tagGid) => dependencies.removeTaskTag(task.gid, tagGid, signal),
        beforeWrite,
        onWriteAttempt,
      );
    }
    case "set_dependencies":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
    case "set_duration":
    case "clear_duration":
      return { kind: "completed", changed: false };
    case "set_parent": {
      const current = dependencies.taskParentGid(task);
      const desired = dependencies.resolveParentGid(operation.after, mappings);
      if (current === desired) {
        return { kind: "completed", changed: false };
      }
      {
        const guardReason = beforeWrite(task);
        if (guardReason != null) {
          return { kind: "conflict", side_effect: "none", reason_code: guardReason };
        }
      }
      if (desired == null) {
        onWriteAttempt("clear_task_parent");
        await dependencies.clearTaskParent(task.gid, signal);
      } else {
        onWriteAttempt("set_task_parent");
        await dependencies.setTaskParent(task.gid, desired, signal);
      }
      return { kind: "completed", changed: true };
    }
  }
  throw new Error("未対応のAsana操作です。");
}
