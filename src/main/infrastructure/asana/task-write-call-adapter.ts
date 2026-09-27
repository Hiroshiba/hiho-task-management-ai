import type {
  AsanaSingleAttemptWriteRequest,
  AsanaSingleAttemptWritePort,
  AsanaTaskWriteReadClientPort,
} from "../../application/common/ports/asana-task-write";
import type { TaskWriteExecutionContext, TaskWriteExecutorRegistry } from "../../application/common/ports/task-write-executor";
import {
  mergeTaskWriteExternalData,
  resolveTaskWriteTarget,
  serializeTaskWriteExternalData,
} from "./task-write-call-external";
import {
  clearDueBodySchema,
  clearParentBodySchema,
  createTaskBodySchema,
  emptyActionResponseSchema,
  parentTaskOptFields,
  parentTaskResponseSchema,
  sectionBodySchema,
  setParentBodySchema,
  tagBodySchema,
  taskGidResponseSchema,
  updateTaskBodySchema,
} from "./task-write-call-schema";
import { parseReadBackAsanaTags, parseReadBackAsanaTask } from "./task-write-asana-response";
import { initialExternalData } from "./task-write-reconciliation";

type JsonObject = AsanaSingleAttemptWriteRequest<unknown>["body"];
type AsanaStepKind = Exclude<keyof TaskWriteExecutorRegistry, "local_synchronize">;
type Step<Kind extends AsanaStepKind> = Parameters<TaskWriteExecutorRegistry[Kind][1]["execute"]>[0];
type AsanaExecutors = Pick<TaskWriteExecutorRegistry, AsanaStepKind>;
type Update = Step<"asana_update_task">["payload"]["update"];

function parseUpdateBody(data: JsonObject): JsonObject {
  const body: JsonObject = { data };
  updateTaskBodySchema.parse(body);
  return body;
}

function updateBody(update: Update): JsonObject {
  switch (update.kind) {
    case "title": return parseUpdateBody({ name: update.after });
    case "notes": return parseUpdateBody({ notes: update.after });
    case "completed": return parseUpdateBody({ completed: update.after });
    case "due_on": return parseUpdateBody({ due_on: update.after });
    case "due_at": return parseUpdateBody({ due_at: update.after });
    case "clear_due": {
      const body: JsonObject = { data: { due_on: null, due_at: null } };
      clearDueBodySchema.parse(body);
      return body;
    }
  }
}

/** 保存済みAsana write stepを単回のAsana書き込み要求へ変換します。 */
export class AsanaTaskWriteCallAdapter {
  public constructor(
    private readonly transport: AsanaSingleAttemptWritePort,
    private readonly readClient: AsanaTaskWriteReadClientPort,
  ) {}

  /** kindとexecutor versionに対応する8種のexecutorを公開します。 */
  public getExecutors(): AsanaExecutors {
    return {
      asana_create_task: { 1: { execute: (step, context, signal) => this.createTask(step, context, signal) } },
      asana_update_task: { 1: { execute: (step, context, signal) => this.updateTask(step, context, signal) } },
      asana_add_to_section: { 1: { execute: (step, context, signal) => this.addToSection(step, context, signal) } },
      asana_add_tag: { 1: { execute: (step, context, signal) => this.writeTag(step, context, "addTag", signal) } },
      asana_remove_tag: { 1: { execute: (step, context, signal) => this.writeTag(step, context, "removeTag", signal) } },
      asana_set_parent: { 1: { execute: (step, context, signal) => this.writeParent(step, context, signal) } },
      asana_clear_parent: { 1: { execute: (step, context, signal) => this.clearParent(step, context, signal) } },
      asana_merge_external_data: { 1: { execute: (step, context, signal) => this.mergeExternalData(step, context, signal) } },
    } satisfies AsanaExecutors;
  }

  private async createTask(
    step: Step<"asana_create_task">,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "created_task"; readonly task_gid: string }> {
    const payload = step.payload;
    const external = initialExternalData(step, context);
    const data: JsonObject = {
      name: payload.title,
      projects: [payload.project_gid],
      memberships: [{ project: payload.project_gid, section: payload.section_gid }],
      completed: false,
      external: {
        gid: `TaskHub:v1:task:${payload.create_uuid}`,
        data: serializeTaskWriteExternalData(external),
      },
      ...(payload.notes == null ? {} : { notes: payload.notes }),
      ...(payload.due?.kind === "due_on" ? { due_on: payload.due.due_on } : {}),
      ...(payload.due?.kind === "due_at" ? { due_at: payload.due.due_at } : {}),
    };
    const body: JsonObject = { data };
    createTaskBodySchema.parse(body);
    const response = await this.transport.requestSingleAttempt({
      method: "POST",
      path: ["tasks"],
      body,
      response_schema: taskGidResponseSchema,
    }, signal);
    return { kind: "created_task", task_gid: response.data.gid };
  }

  private async updateTask(
    step: Step<"asana_update_task">,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "written" }> {
    const taskGid = resolveTaskWriteTarget(step.payload.target, context);
    const response = await this.transport.requestSingleAttempt({
      method: "PUT",
      path: ["tasks", taskGid],
      body: updateBody(step.payload.update),
      response_schema: taskGidResponseSchema,
    }, signal);
    if (response.data.gid !== taskGid) throw new Error("更新応答のタスクGIDが対象と一致しません。");
    return { kind: "written" };
  }

  private async addToSection(
    step: Step<"asana_add_to_section">,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "written" }> {
    const taskGid = resolveTaskWriteTarget(step.payload.target, context);
    await this.transport.requestSingleAttempt({
      method: "POST",
      path: ["sections", step.payload.after_section_gid, "addTask"],
      body: sectionBodySchema.parse({ data: { task: taskGid } }),
      response_schema: emptyActionResponseSchema,
    }, signal);
    return { kind: "written" };
  }

  private async writeTag(
    step: Step<"asana_add_tag"> | Step<"asana_remove_tag">,
    context: TaskWriteExecutionContext,
    action: "addTag" | "removeTag",
    signal: AbortSignal,
  ): Promise<{ readonly kind: "written" }> {
    const taskGid = resolveTaskWriteTarget(step.payload.tag.target, context);
    const tags = parseReadBackAsanaTags(await this.readClient.listWorkspaceTags(step.payload.tag.workspace_gid, signal));
    const matches = tags.filter((tag) => tag.name === step.payload.tag.tag_name);
    if (matches.length !== 1) throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
    const tag = matches[0];
    if (tag == null) throw new Error("対象タグをワークスペースタグへ解決できません。");
    await this.transport.requestSingleAttempt({
      method: "POST",
      path: ["tasks", taskGid, action],
      body: tagBodySchema.parse({ data: { tag: tag.gid } }),
      response_schema: emptyActionResponseSchema,
    }, signal);
    return { kind: "written" };
  }

  private async writeParent(
    step: Step<"asana_set_parent">,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "written" }> {
    const taskGid = resolveTaskWriteTarget(step.payload.target, context);
    const parentGid = resolveTaskWriteTarget(step.payload.parent, context);
    const response = await this.transport.requestSingleAttempt({
      method: "POST",
      path: ["tasks", taskGid, "setParent"],
      query: { opt_fields: parentTaskOptFields },
      body: setParentBodySchema.parse({ data: { parent: parentGid } }),
      response_schema: parentTaskResponseSchema,
    }, signal);
    if (response.data.gid !== taskGid) throw new Error("親設定応答のタスクGIDが対象と一致しません。");
    return { kind: "written" };
  }

  private async clearParent(
    step: Step<"asana_clear_parent">,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "written" }> {
    const taskGid = resolveTaskWriteTarget(step.payload.target, context);
    const response = await this.transport.requestSingleAttempt({
      method: "POST",
      path: ["tasks", taskGid, "setParent"],
      query: { opt_fields: parentTaskOptFields },
      body: clearParentBodySchema.parse({ data: { parent: null } }),
      response_schema: parentTaskResponseSchema,
    }, signal);
    if (response.data.gid !== taskGid) throw new Error("親解除応答のタスクGIDが対象と一致しません。");
    return { kind: "written" };
  }

  private async mergeExternalData(
    step: Step<"asana_merge_external_data">,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<{ readonly kind: "written" }> {
    const taskGid = resolveTaskWriteTarget(step.payload.target, context);
    const task = parseReadBackAsanaTask(await this.readClient.getTask(taskGid, signal));
    if (task.gid !== taskGid) throw new Error("Custom external dataのGET応答GIDが対象と一致しません。");
    const merged = mergeTaskWriteExternalData(step, context, task);
    if (merged.kind === "already_applied") return { kind: "written" };
    const body: JsonObject = { data: { external: merged.external } };
    updateTaskBodySchema.parse(body);
    const response = await this.transport.requestSingleAttempt({
      method: "PUT",
      path: ["tasks", taskGid],
      body,
      response_schema: taskGidResponseSchema,
    }, signal);
    if (response.data.gid !== taskGid) throw new Error("外部データ更新応答のタスクGIDが対象と一致しません。");
    return { kind: "written" };
  }
}
