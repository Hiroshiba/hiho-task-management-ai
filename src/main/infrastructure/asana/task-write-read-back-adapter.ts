import { createHash } from "node:crypto";
import type { TaskWriteExecutionContext } from "../../application/common/ports/task-write-executor";
import type {
  TaskWriteAsanaObservation,
  TaskWriteOperationObservation,
  TaskWriteReadBackHint,
  TaskWriteReadBackPort,
} from "../../application/common/ports/task-write-read-back";
import { canonicalizeTaskWriteJson } from "../../domain/task-write-values";
import {
  parseReadBackAsanaTags,
  parseReadBackAsanaTask,
  parseReadBackAsanaTasks,
  type ReadBackAsanaTag,
  type ReadBackAsanaTask,
} from "./task-write-asana-response";
import {
  categoryTags,
  classifyExternalChanges,
  classifyOperationCore,
  combineOperationStates,
  initialExternalData,
  observedTaskState,
  optionalWorkspaceTag,
  readExternalData,
  resolveWorkspaceTag,
  type FieldState,
} from "./task-write-reconciliation";

type AsanaStep = Parameters<TaskWriteReadBackPort["inspectAsanaStep"]>[0];
type OperationStep = Parameters<TaskWriteReadBackPort["inspectOperation"]>[0];
type TaskWriteTarget = Extract<AsanaStep, { readonly kind: "asana_update_task" }>["payload"]["target"];
type TaskWriteExternalBaseline = Extract<AsanaStep, { readonly kind: "asana_merge_external_data" }>["payload"]["baseline"];
type ReadClient = {
  getTask(taskGid: string, signal: AbortSignal): Promise<unknown>;
  listProjectTasks(projectGid: string, signal: AbortSignal): Promise<unknown>;
  listWorkspaceTags(workspaceGid: string, signal: AbortSignal): Promise<unknown>;
};
type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

const createReadBackDelays = [200, 500, 1000] as const;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalizeTaskWriteJson(value)).digest("hex");
}

function resolveTarget(target: TaskWriteTarget, context: TaskWriteExecutionContext): string {
  if (target.kind === "existing") return target.gid;
  const gid = context.references.get(target.ref);
  if (gid == null) throw new Error("読戻し対象の一時参照にGIDがありません。");
  return gid;
}

function projectSection(task: ReadBackAsanaTask, projectGid: string): string | undefined {
  const memberships = task.memberships.filter((membership) => membership.project.gid === projectGid);
  if (memberships.length !== 1) return undefined;
  return memberships[0]?.section?.gid;
}

function projectGid(step: AsanaStep, context: TaskWriteExecutionContext): string {
  if (step.kind === "asana_create_task") return step.payload.project_gid;
  if (step.scope.kind !== "operation") throw new Error("Asana stepの操作IDがありません。");
  const gid = context.operation_project_gids.get(step.scope.operation_id);
  if (gid == null) throw new Error("Asana stepの対象プロジェクトがありません。");
  return gid;
}

function stepTarget(step: Exclude<AsanaStep, { readonly kind: "asana_create_task" }>): TaskWriteTarget {
  if (step.kind === "asana_add_tag" || step.kind === "asana_remove_tag") return step.payload.tag.target;
  return step.payload.target;
}

function externalBaseline(
  baseline: TaskWriteExternalBaseline,
  context: TaskWriteExecutionContext,
): { readonly gid: string; readonly data: Extract<TaskWriteExternalBaseline, { readonly kind: "stored" }>["data"] } {
  if (baseline.kind === "stored") return { gid: baseline.external_gid, data: baseline.data };
  const create = context.plan.steps.find((step) => step.kind === "asana_create_task"
    && step.scope.kind === "operation"
    && step.scope.operation_id === baseline.create_operation_id
    && step.payload.target.ref === baseline.temporary_ref);
  if (create?.kind !== "asana_create_task") throw new Error("作成時external基準の作成stepがありません。");
  return {
    gid: `TaskHub:v1:task:${create.payload.create_uuid}`,
    data: initialExternalData(create, context),
  };
}

function classifyExternal(
  task: ReadBackAsanaTask,
  baseline: TaskWriteExternalBaseline,
  changes: Extract<AsanaStep, { readonly kind: "asana_merge_external_data" }>["payload"]["changes"],
  context: TaskWriteExecutionContext,
): FieldState {
  const expected = externalBaseline(baseline, context);
  const current = readExternalData(task);
  if (current.kind !== "valid" || current.gid !== expected.gid) return "conflict";
  return changes.length === 0
    ? "after"
    : classifyExternalChanges(changes, current.data, expected.data, context);
}

function updateState(
  step: Extract<AsanaStep, { readonly kind: "asana_update_task" }>,
  task: ReadBackAsanaTask,
): FieldState {
  const update = step.payload.update;
  switch (update.kind) {
    case "title": return compare(task.name, update.before, update.after);
    case "notes": return compare(task.notes, update.before, update.after);
    case "completed": return compare(task.completed, update.before, update.after);
    case "due_on": return compare(due(task), update.before, { kind: "due_on", due_on: update.after });
    case "due_at": return compare(due(task), update.before, { kind: "due_at", due_at: update.after });
    case "clear_due": return compare(due(task), update.before, { kind: "absent" });
  }
}

function due(task: ReadBackAsanaTask): object {
  if (task.due_at != null) return { kind: "due_at", due_at: task.due_at };
  if (task.due_on != null) return { kind: "due_on", due_on: task.due_on };
  return { kind: "absent" };
}

function compare(current: unknown, before: unknown, after: unknown): FieldState {
  const serialized = canonicalizeTaskWriteJson(current);
  if (serialized === canonicalizeTaskWriteJson(after)) return "after";
  if (serialized === canonicalizeTaskWriteJson(before)) return "before";
  return "conflict";
}

function classifyStep(
  step: Exclude<AsanaStep, { readonly kind: "asana_create_task" }>,
  task: ReadBackAsanaTask,
  context: TaskWriteExecutionContext,
  workspaceTags: readonly ReadBackAsanaTag[],
): FieldState {
  switch (step.kind) {
    case "asana_update_task": return updateState(step, task);
    case "asana_add_to_project": {
      const memberships = task.memberships.filter((membership) => membership.project.gid === step.payload.project_gid);
      if (memberships.length === 0) return "before";
      if (memberships.length !== 1) return "conflict";
      return memberships[0]?.section?.gid === step.payload.section_gid ? "after" : "conflict";
    }
    case "asana_add_to_section": {
      const memberships = task.memberships.filter((membership) => membership.project.gid === projectGid(step, context));
      if (memberships.length !== 1) return "conflict";
      const section = memberships[0]?.section?.gid ?? null;
      return compare(section,
        step.payload.before_section_gid, step.payload.after_section_gid);
    }
    case "asana_add_tag": {
      const desired = resolveWorkspaceTag(step.payload.tag.tag_name, workspaceTags);
      const before = step.payload.expected_before;
      const categoryPrefix = step.payload.tag.category === "importance" ? "TaskHub/重要度/" : "TaskHub/領域/";
      const current = categoryTags(task, categoryPrefix);
      const old = before.kind === "absent" ? undefined : optionalWorkspaceTag(before.tag_name, workspaceTags);
      const hasDesired = current.some((tag) => tag.gid === desired.gid && tag.name === desired.name);
      const hasOld = old != null && current.some((tag) => tag.gid === old.gid && tag.name === old.name);
      if ((current.length === 1 && hasDesired) || (current.length === 2 && hasDesired && hasOld)) return "after";
      if ((current.length === 0 && before.kind !== "named") || (current.length === 1 && hasOld)) return "before";
      return "conflict";
    }
    case "asana_remove_tag": {
      const old = optionalWorkspaceTag(step.payload.tag.tag_name, workspaceTags);
      const replacement = resolveWorkspaceTag(step.payload.replacement.tag_name, workspaceTags);
      const prefix = step.payload.tag.category === "importance" ? "TaskHub/重要度/" : "TaskHub/領域/";
      const current = categoryTags(task, prefix);
      if (current.length === 1
        && current[0]?.gid === replacement.gid && current[0].name === replacement.name) return "after";
      return old != null && current.length === 2
        && current.some((tag) => tag.gid === old.gid && tag.name === old.name)
        && current.some((tag) => tag.gid === replacement.gid && tag.name === replacement.name)
        ? "before"
        : "conflict";
    }
    case "asana_set_parent": return compare(task.parent?.gid ?? null,
      step.payload.expected_before.kind === "absent" ? null : resolveTarget(step.payload.expected_before, context),
      resolveTarget(step.payload.parent, context));
    case "asana_clear_parent": return compare(task.parent?.gid ?? null,
      step.payload.expected_before.kind === "absent" ? null : resolveTarget(step.payload.expected_before, context), null);
    case "asana_merge_external_data": return classifyExternal(task, step.payload.baseline,
      step.payload.changes, context);
  }
}

function createState(
  step: Extract<AsanaStep, { readonly kind: "asana_create_task" }>,
  task: ReadBackAsanaTask,
  context: TaskWriteExecutionContext,
): "applied" | "projection" | "unknown" {
  const payload = step.payload;
  if (task.name !== payload.title
    || task.notes !== (payload.notes ?? "")
    || task.completed
    || canonicalizeTaskWriteJson(due(task)) !== canonicalizeTaskWriteJson(payload.due ?? { kind: "absent" })) {
    return "unknown";
  }
  const section = projectSection(task, payload.project_gid);
  if (section == null) return "projection";
  if (section !== payload.section_gid) return "unknown";
  const external = readExternalData(task);
  if (external.kind !== "valid") return task.external == null ? "projection" : "unknown";
  if (external.gid !== `TaskHub:v1:task:${payload.create_uuid}`
    || canonicalizeTaskWriteJson(external.data) !== canonicalizeTaskWriteJson(initialExternalData(step, context))) {
    return "unknown";
  }
  return "applied";
}

/** Asana GETとUUID探索から保存済みstepの適用有無を判定します。 */
export class AsanaTaskWriteReadBackAdapter implements TaskWriteReadBackPort {
  public constructor(
    private readonly readClient: ReadClient,
    private readonly isNotFound: (error: unknown) => boolean,
    private readonly wait: Wait,
  ) {}

  /** 操作のcore、プロジェクト所属、external基準を照合します。 */
  public async inspectOperation(
    step: OperationStep,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<TaskWriteOperationObservation> {
    const operation = step.payload.operation;
    const gid = resolveTarget(operation.target, context);
    const task = parseReadBackAsanaTask(await this.readClient.getTask(gid, signal));
    if (task.gid !== gid || projectSection(task, step.payload.project_gid) == null) return { state: "conflict" };
    const workspaceTags = operation.operation === "set_importance" || operation.operation === "set_area"
      ? parseReadBackAsanaTags(await this.readClient.listWorkspaceTags(step.payload.workspace_gid, signal))
      : [];
    const core = classifyOperationCore(operation, task, context,
      step.payload.project_gid, step.payload.section_gids, workspaceTags);
    let external: FieldState = "after";
    if (step.payload.external_baseline != null) {
      const externalStep = context.plan.steps.find((candidate) =>
        candidate.kind === "asana_merge_external_data"
        && candidate.scope.kind === "operation"
        && candidate.scope.operation_id === operation.operation_id);
      external = classifyExternal(task, step.payload.external_baseline,
        externalStep?.kind === "asana_merge_external_data" ? externalStep.payload.changes : [], context);
    }
    const combined = combineOperationStates(core, external);
    if (combined === "conflict") return { state: "conflict" };
    return {
      state: combined === "after" ? "already_applied" : "needs_write",
      task_gid: gid,
      observed_state_fingerprint: fingerprint(observedTaskState(task)),
    };
  }

  /** 個々のAsana callの後状態をGETで確認します。 */
  public async inspectAsanaStep(
    step: AsanaStep,
    context: TaskWriteExecutionContext,
    hint: TaskWriteReadBackHint,
    signal: AbortSignal,
  ): Promise<TaskWriteAsanaObservation> {
    if (step.kind === "asana_create_task") return this.inspectCreate(step, context, hint, signal);
    const gid = resolveTarget(stepTarget(step), context);
    const task = parseReadBackAsanaTask(await this.readClient.getTask(gid, signal));
    if (task.gid !== gid || (step.kind !== "asana_add_to_project" && step.kind !== "asana_add_to_section"
      && projectSection(task, projectGid(step, context)) == null)) return { state: "unknown" };
    const workspaceGid = step.kind === "asana_add_tag" || step.kind === "asana_remove_tag"
      ? step.payload.tag.workspace_gid
      : undefined;
    const tags = workspaceGid == null
      ? []
      : parseReadBackAsanaTags(await this.readClient.listWorkspaceTags(workspaceGid, signal));
    const state = classifyStep(step, task, context, tags);
    if (state === "before") return { state: "not_applied" };
    if (state !== "after") return { state: "unknown" };
    return {
      state: "applied",
      task_gid: gid,
      observed_state_fingerprint: fingerprint(observedTaskState(task)),
    };
  }

  private async inspectCreate(
    step: Extract<AsanaStep, { readonly kind: "asana_create_task" }>,
    context: TaskWriteExecutionContext,
    hint: TaskWriteReadBackHint,
    signal: AbortSignal,
  ): Promise<TaskWriteAsanaObservation> {
    const externalGid = `TaskHub:v1:task:${step.payload.create_uuid}`;
    for (let index = 0; index <= createReadBackDelays.length; index += 1) {
      if (index > 0) {
        const delay = createReadBackDelays[index - 1];
        if (delay == null) throw new Error("作成stepの読戻し待機値がありません。");
        await this.wait(delay, signal);
      }
      const projectTasks = parseReadBackAsanaTasks(
        await this.readClient.listProjectTasks(step.payload.project_gid, signal));
      const matching = projectTasks.filter((task) => task.external?.gid === externalGid);
      if (matching.length > 1) return { state: "unknown" };
      const foundGid = matching[0]?.gid;
      if (hint.kind === "after_write" && hint.submitted_task_gid != null
        && foundGid != null && foundGid !== hint.submitted_task_gid) return { state: "unknown" };
      const gid = hint.kind === "after_write" && hint.submitted_task_gid != null
        ? hint.submitted_task_gid
        : foundGid;
      if (gid == null) {
        if (hint.kind !== "after_write") return { state: "not_applied" };
        continue;
      }
      let task: ReadBackAsanaTask;
      try {
        task = parseReadBackAsanaTask(await this.readClient.getTask(gid, signal));
      } catch (error) {
        if (!this.isNotFound(error)) throw error;
        if (hint.kind === "after_write") continue;
        return { state: "unknown" };
      }
      if (task.gid !== gid) return { state: "unknown" };
      const state = createState(step, task, context);
      if (state === "applied") {
        return { state: "applied", task_gid: gid,
          observed_state_fingerprint: fingerprint(observedTaskState(task)) };
      }
      if (state === "unknown" || hint.kind !== "after_write") return { state: "unknown" };
    }
    return { state: "unknown" };
  }
}
