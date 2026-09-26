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
