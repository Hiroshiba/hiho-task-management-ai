import { canonicalizeTaskWriteJson, customExternalDataSchema } from "../../domain/task-write-values";
import type { TaskWriteExecutionContext } from "../../application/common/ports/task-write-executor";
import type { TaskWriteReadBackPort } from "../../application/common/ports/task-write-read-back";
import type { ReadBackAsanaTag, ReadBackAsanaTask } from "./task-write-asana-response";

type AsanaStep = Parameters<TaskWriteReadBackPort["inspectAsanaStep"]>[0];
type OperationStep = Parameters<TaskWriteReadBackPort["inspectOperation"]>[0];
type TaskWriteTarget = Extract<AsanaStep, { readonly kind: "asana_update_task" }>["payload"]["target"];
type TaskWriteExternalBaseline = Extract<AsanaStep, { readonly kind: "asana_merge_external_data" }>["payload"]["baseline"];
type TaskWriteExternalChange = Extract<AsanaStep, { readonly kind: "asana_merge_external_data" }>["payload"]["changes"][number];

export type FieldState = "before" | "after" | "partial" | "conflict";
type ComponentState = FieldState | "neutral";
type ExternalData = Extract<TaskWriteExternalBaseline, { readonly kind: "stored" }>["data"];
type Dependency = ExternalData["dependencies"][number];

function same(left: unknown, right: unknown): boolean {
  return canonicalizeTaskWriteJson(left) === canonicalizeTaskWriteJson(right);
}

function compare(current: unknown, before: unknown, after: unknown): ComponentState {
  if (same(before, after)) return same(current, before) ? "neutral" : "conflict";
  if (same(current, after)) return "after";
  if (same(current, before)) return "before";
  return "conflict";
}

function combine(states: readonly ComponentState[]): FieldState {
  const effective = states.filter((state) => state !== "neutral");
  if (effective.some((state) => state === "conflict")) return "conflict";
  if (effective.every((state) => state === "after")) return "after";
  if (effective.every((state) => state === "before")) return "before";
  return "partial";
}

function targetGid(target: TaskWriteTarget, context: TaskWriteExecutionContext): string {
  if (target.kind === "existing") return target.gid;
  const gid = context.references.get(target.ref);
  if (gid == null) throw new Error("読戻し対象の一時参照を解決できません。");
  return gid;
}

function parentGid(value: { readonly kind: "absent" } | TaskWriteTarget, context: TaskWriteExecutionContext): string | null {
  return value.kind === "absent" ? null : targetGid(value, context);
}

function currentDue(task: ReadBackAsanaTask):
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string } {
  if (task.due_at != null) return { kind: "due_at", due_at: task.due_at };
  if (task.due_on != null) return { kind: "due_on", due_on: task.due_on };
  return { kind: "absent" };
}

function projectSection(task: ReadBackAsanaTask, projectGid: string): string | undefined {
  const memberships = task.memberships.filter((membership) => membership.project.gid === projectGid);
  if (memberships.length !== 1) return undefined;
  return memberships[0]?.section?.gid;
}

function statusState(
  task: ReadBackAsanaTask,
  projectGid: string,
  sectionGids: { readonly not_started: string; readonly in_progress: string; readonly completed: string; readonly withdrawn: string },
  before: "not_started" | "in_progress" | "completed" | "withdrawn",
  after: "not_started" | "in_progress" | "completed" | "withdrawn",
): FieldState {
  const section = projectSection(task, projectGid);
  if (section == null) return "conflict";
  const beforeCompleted = before === "completed" || before === "withdrawn";
  const afterCompleted = after === "completed" || after === "withdrawn";
  if (section === sectionGids[after] && task.completed === afterCompleted) return "after";
  if (section === sectionGids[before] && task.completed === beforeCompleted) return "before";
  if (section === sectionGids[after] && task.completed === beforeCompleted) return "partial";
  return "conflict";
}

/** タスクに付いたカテゴリタグをGID重複の検証後に抽出します。 */
export function categoryTags(task: ReadBackAsanaTask, prefix: string): readonly ReadBackAsanaTag[] {
  const seen = new Set<string>();
  for (const tag of task.tags) {
    if (seen.has(tag.gid)) throw new Error("対象タスクのタグGIDが重複しています。");
    seen.add(tag.gid);
  }
  return task.tags.filter((tag) => tag.name.startsWith(prefix));
}

/** ワークスペース内のタグ名を一意のタグへ解決します。 */
export function resolveWorkspaceTag(name: string, tags: readonly ReadBackAsanaTag[]): ReadBackAsanaTag {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length !== 1) throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
  const match = matches[0];
  if (match == null) throw new Error("対象タグをワークスペースタグへ解決できません。");
  return match;
}

/** ワークスペース内に旧タグがあれば一意に解決します。 */
export function optionalWorkspaceTag(name: string, tags: readonly ReadBackAsanaTag[]): ReadBackAsanaTag | undefined {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length > 1) throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
  return matches[0];
}

function categoryState(
  task: ReadBackAsanaTask,
  prefix: string,
  beforeName: string,
  afterName: string,
  defaultBefore: boolean,
  sameValue: boolean,
  workspaceTags: readonly ReadBackAsanaTag[],
): FieldState {
  const category = categoryTags(task, prefix);
  const before = optionalWorkspaceTag(beforeName, workspaceTags);
  const after = resolveWorkspaceTag(afterName, workspaceTags);
  const beforeIsDefault = defaultBefore && category.length === 0;
  const beforeTagIsExact = before != null && category.length === 1
    && category[0]?.gid === before.gid && category[0].name === before.name;
  const beforeExact = beforeIsDefault || beforeTagIsExact;
  const afterExact = category.length === 1
    && category[0]?.gid === after.gid && category[0].name === after.name;
  if (sameValue && beforeExact) return "after";
  if (afterExact) return "after";
  if (beforeExact) return "before";
  if (before != null && category.length === 2
    && category.some((tag) => tag.gid === before.gid && tag.name === before.name)
    && category.some((tag) => tag.gid === after.gid && tag.name === after.name)) return "partial";
  return "conflict";
}

/** 承認済み操作のAsana core値を変更前後と部分適用へ分類します。 */
export function classifyOperationCore(
  operation: OperationStep["payload"]["operation"],
  task: ReadBackAsanaTask,
  context: TaskWriteExecutionContext,
  projectGid: string,
  sectionGids: { readonly not_started: string; readonly in_progress: string; readonly completed: string; readonly withdrawn: string },
  workspaceTags: readonly ReadBackAsanaTag[],
): ComponentState {
  if (projectSection(task, projectGid) == null) return "conflict";
  switch (operation.operation) {
    case "update_title": return compare(task.name, operation.before, operation.after);
    case "update_notes": return compare(task.notes, operation.before, operation.after);
    case "set_status": return statusState(task, projectGid, sectionGids, operation.before, operation.after);
    case "set_importance": return categoryState(task, "TaskHub/重要度/",
      `TaskHub/重要度/${operation.before}`, `TaskHub/重要度/${operation.after}`,
      operation.before === 3, operation.before === operation.after, workspaceTags);
    case "set_due": return compare(currentDue(task), operation.before, operation.after);
    case "clear_due": return compare(currentDue(task), operation.before, operation.after);
    case "set_duration":
    case "clear_duration":
    case "set_dependencies":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian": return "after";
    case "set_area": return categoryState(task, "TaskHub/領域/",
      `TaskHub/領域/${operation.before}`, `TaskHub/領域/${operation.after}`,
      operation.before === "未分類", operation.before === operation.after, workspaceTags);
    case "set_parent": return compare(task.parent?.gid ?? null,
      parentGid(operation.before, context), parentGid(operation.after, context));
    case "complete": return statusState(task, projectGid, sectionGids, operation.before, "completed");
    case "withdraw": return statusState(task, projectGid, sectionGids, operation.before, "withdrawn");
  }
}

/** AsanaのCustom external dataをID付きで検証して読み出します。 */
export function readExternalData(task: ReadBackAsanaTask):
  | { readonly kind: "valid"; readonly gid: string; readonly data: ExternalData }
  | { readonly kind: "unknown" } {
  if (task.external == null) return { kind: "unknown" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(task.external.data);
  } catch {
    return { kind: "unknown" };
  }
  const data = customExternalDataSchema.safeParse(decoded);
  if (!data.success || task.external.gid !== `TaskHub:v1:task:${data.data.id}`) {
    return { kind: "unknown" };
  }
  return { kind: "valid", gid: task.external.gid, data: data.data };
}

function dependencyValues(
  dependencies: readonly { readonly target: TaskWriteTarget; readonly scope: Dependency["scope"]; readonly source: string }[],
  context: TaskWriteExecutionContext,
): readonly Dependency[] {
  return dependencies.map((dependency) => ({
    task_gid: targetGid(dependency.target, context),
    scope: dependency.scope,
    source: dependency.source,
  })).sort((left, right) => left.task_gid.localeCompare(right.task_gid));
}

function dependencyMap(values: readonly Dependency[]): ReadonlyMap<string, Dependency> {
  const result = new Map<string, Dependency>();
  for (const value of values) {
    if (result.has(value.task_gid)) throw new Error("依存関係のタスクGIDが重複しています。");
    result.set(value.task_gid, value);
  }
  return result;
}

function sameDependency(left: Dependency | undefined, right: Dependency | undefined): boolean {
  if (left == null || right == null) return left == null && right == null;
  return same(left, right);
}

function dependenciesState(
  change: Extract<TaskWriteExternalChange, { readonly kind: "dependencies" }>,
  current: ExternalData["dependencies"],
  context: TaskWriteExecutionContext,
): ComponentState {
  const before = dependencyMap(dependencyValues(change.before, context));
  const after = dependencyMap(dependencyValues(change.after, context));
  const observed = dependencyMap(current);
  const changedGids = new Set([...before.keys(), ...after.keys()]);
  const states: FieldState[] = [];
  for (const gid of changedGids) {
    const beforeValue = before.get(gid);
    const afterValue = after.get(gid);
    if (sameDependency(beforeValue, afterValue)) continue;
    const currentValue = observed.get(gid);
    if (sameDependency(currentValue, afterValue)) {
      states.push("after");
    } else if (sameDependency(currentValue, beforeValue)) {
      states.push("before");
    } else {
      return "conflict";
    }
  }
  return states.length === 0 ? "neutral" : combine(states);
}

function activityAnchorState(current: string, baseline: string, after: string): ComponentState {
  const expectedAfter = baseline < after ? after : baseline;
  if (current > expectedAfter) return "neutral";
  if (current === expectedAfter) return expectedAfter === baseline ? "neutral" : "after";
  return current === baseline ? "before" : "conflict";
}

function changeState(
  change: TaskWriteExternalChange,
  current: ExternalData,
  baseline: ExternalData,
  context: TaskWriteExecutionContext,
): ComponentState {
  switch (change.kind) {
    case "duration": return compare(current.duration ?? { kind: "absent" }, change.before, change.after);
    case "dependencies": return dependenciesState(change, current.dependencies, context);
    case "parent_work_mode": return compare(current.parent_work_mode, change.before, change.after);
    case "obsidian_links": {
      const key = `${change.link.vault_id}\u0000${change.link.path}`;
      const currentLink = current.obsidian_links.find((link) => `${link.vault_id}\u0000${link.path}` === key);
      const baselineLink = baseline.obsidian_links.find((link) => `${link.vault_id}\u0000${link.path}` === key);
      const afterLink = change.action === "add" ? change.link : undefined;
      return compare(currentLink ?? null, baselineLink ?? null, afterLink ?? null);
    }
    case "last_active_status": return compare(current.last_active_status, baseline.last_active_status, change.after);
    case "activity_anchor_on": return activityAnchorState(
      current.activity_anchor_on, baseline.activity_anchor_on, change.after);
  }
}

/** 対象external項目を承認時基準と変更後へ分類します。 */
export function classifyExternalChanges(
  changes: readonly TaskWriteExternalChange[],
  current: ExternalData,
  baseline: ExternalData,
  context: TaskWriteExecutionContext,
): FieldState {
  return combine(changes.map((change) => changeState(change, current, baseline, context)));
}

/** 操作のcoreとexternal分類を一つの適用状態へまとめます。 */
export function combineOperationStates(core: ComponentState, external: FieldState): FieldState {
  return combine([core, external]);
}

/** 作成stepの初期Custom external dataを再構成します。 */
export function initialExternalData(
  step: Extract<AsanaStep, { readonly kind: "asana_create_task" }>,
  context: TaskWriteExecutionContext,
): ExternalData {
  return customExternalDataSchema.parse({
    schema: 1,
    id: step.payload.create_uuid,
    rev: 1,
    last_active_status: step.payload.initial_external.last_active_status,
    activity_anchor_on: step.payload.initial_external.activity_date,
    ...(step.payload.initial_external.duration == null
      ? {}
      : { duration: step.payload.initial_external.duration }),
    parent_work_mode: step.payload.initial_external.parent_work_mode,
    dependencies: dependencyValues(step.payload.initial_external.dependencies, context),
    obsidian_links: step.payload.initial_external.obsidian_links,
    provenance: {
      created_via: step.payload.initial_external.created_via,
      last_writer: step.payload.initial_external.device_id,
    },
  });
}

/** 対象タスクの読戻し値をreceipt用の安定したJSONへ抽出します。 */
export function observedTaskState(task: ReadBackAsanaTask): object {
  return {
    gid: task.gid,
    name: task.name,
    notes: task.notes,
    completed: task.completed,
    due_on: task.due_on,
    due_at: task.due_at,
    external: task.external,
    memberships: task.memberships.map((membership) => ({
      project_gid: membership.project.gid,
      section_gid: membership.section?.gid ?? null,
    })),
    tags: task.tags.map((tag) => ({ gid: tag.gid, name: tag.name })).sort((left, right) => left.gid.localeCompare(right.gid)),
    parent_gid: task.parent?.gid ?? null,
  };
}
