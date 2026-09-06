import { createHash } from "node:crypto";
import {
  asanaTaskResponseSchema,
  canonicalizeJson,
  snapshotHashSchema,
  type AsanaTaskResponse,
  type SnapshotHash,
} from "../../shared/domain";

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function hashInput(task: AsanaTaskResponse): Record<string, unknown> {
  return {
    gid: task.gid,
    name: task.name,
    notes: task.notes,
    completed: task.completed,
    due_on: task.due_on,
    due_at: task.due_at,
    parent: task.parent == null
      ? null
      : { gid: task.parent.gid },
    memberships: [...task.memberships]
      .map((membership) => ({
        project_gid: membership.project.gid,
        section_gid: membership.section == null ? null : membership.section.gid,
      }))
      .sort((left, right) => {
        const projectComparison = compareStrings(left.project_gid, right.project_gid);
        if (projectComparison !== 0) {
          return projectComparison;
        }
        return compareStrings(left.section_gid ?? "", right.section_gid ?? "");
      }),
    tags: [...task.tags]
      .map((tag) => ({ gid: tag.gid, name: tag.name }))
      .sort((left, right) => {
        const gidComparison = compareStrings(left.gid, right.gid);
        return gidComparison === 0 ? compareStrings(left.name, right.name) : gidComparison;
      }),
    external: task.external == null
      ? null
      : { gid: task.external.gid, data: task.external.data },
    num_subtasks: task.num_subtasks,
    projects: [...task.projects]
      .map((project) => ({ gid: project.gid }))
      .sort((left, right) => compareStrings(left.gid, right.gid)),
  };
}

/** GUI直接編集の対象タスク基準ハッシュを生成します。 */
export function hashGuiEditBaseline(task: AsanaTaskResponse): SnapshotHash {
  const validatedTask = asanaTaskResponseSchema.parse(task);
  const hash = createHash("sha256")
    .update(canonicalizeJson(hashInput(validatedTask)), "utf8")
    .digest("hex");
  return snapshotHashSchema.parse(hash);
}
