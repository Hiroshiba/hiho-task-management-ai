import { z } from "zod";
import {
  asanaTaskResponseSchema,
  createUtf8ByteLimitedStringSchema,
  customExternalDataMaxBytes,
  dateSchema,
  externalTaskGidSchema,
  gidSchema,
  isoDateTimeSchema,
  type AsanaTaskResponse,
  type JsonObject,
} from "../../../shared/domain";
import type { AsanaTransportRequestPort } from "../transport";

const taskOptFields = [
  "gid",
  "name",
  "notes",
  "completed",
  "due_on",
  "due_at",
  "created_at",
  "modified_at",
  "completed_at",
  "permalink_url",
  "external.gid",
  "external.data",
  "memberships.project.gid",
  "memberships.project.name",
  "memberships.section.gid",
  "memberships.section.name",
  "tags.gid",
  "tags.name",
  "parent.gid",
  "parent.name",
  "num_subtasks",
  "projects.gid",
  "projects.name",
].join(",");

const taskResponseSchema = z
  .object({
    data: asanaTaskResponseSchema,
  })
  .strip();

const emptyActionResponseSchema = z
  .object({
    data: z.object({}).strict(),
  })
  .strict();

const taskTitleSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "タスク名を空にできません。",
});

const externalDataInputSchema = z
  .object({
    gid: externalTaskGidSchema,
    data: createUtf8ByteLimitedStringSchema(customExternalDataMaxBytes),
  })
  .strict();

const taskCreationInputSchema = z
  .object({
    project_gid: gidSchema,
    title: taskTitleSchema,
    notes: z.string().optional(),
    completed: z.boolean().optional(),
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    external: externalDataInputSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.due_on != null && input.due_at != null) {
      context.addIssue({
        code: "custom",
        path: ["due_at"],
        message: "due_onとdue_atを同時に指定できません。",
      });
    }
  });

const taskUpdateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("title"),
      value: taskTitleSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("notes"),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("completed"),
      value: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_on"),
      value: dateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_at"),
      value: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("clear_due"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("external"),
      value: externalDataInputSchema,
    })
    .strict(),
]);

const taskInsertionPositionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("none"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("after"),
      task_gid: gidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("before"),
      task_gid: gidSchema,
    })
    .strict(),
]);

const createTaskBodySchema = z
  .object({
    data: z
      .object({
        name: taskTitleSchema,
        projects: z.array(gidSchema).length(1),
        notes: z.string().optional(),
        completed: z.boolean().optional(),
        due_on: dateSchema.optional(),
        due_at: isoDateTimeSchema.optional(),
        external: externalDataInputSchema,
      })
      .strict(),
  })
  .strict();

const taskUpdateBodySchema = z
  .object({
    data: z
      .object({
        name: taskTitleSchema.optional(),
        notes: z.string().optional(),
        completed: z.boolean().optional(),
        due_on: dateSchema.optional(),
        due_at: isoDateTimeSchema.optional(),
        external: externalDataInputSchema.optional(),
      })
      .strict(),
  })
  .strict();

const clearDueBodySchema = z
  .object({
    data: z
      .object({
        due_on: z.null(),
        due_at: z.null(),
      })
      .strict(),
  })
  .strict();

const addTagBodySchema = z
  .object({
    data: z
      .object({
        tag: gidSchema,
      })
      .strict(),
  })
  .strict();

const addProjectBodySchema = z
  .object({
    data: z
      .object({
        project: gidSchema,
        section: gidSchema,
        insert_after: gidSchema.optional(),
        insert_before: gidSchema.optional(),
      })
      .strict(),
  })
  .strict();

const addSectionBodySchema = z
  .object({
    data: z
      .object({
        task: gidSchema,
        insert_after: gidSchema.optional(),
        insert_before: gidSchema.optional(),
      })
      .strict(),
  })
  .strict();

const setParentBodySchema = z
  .object({
    data: z
      .object({
        parent: gidSchema,
      })
      .strict(),
  })
  .strict();

const clearParentBodySchema = z
  .object({
    data: z
      .object({
        parent: z.null(),
      })
      .strict(),
  })
  .strict();

type TaskCreationInput = z.infer<typeof taskCreationInputSchema>;
type TaskUpdate = z.infer<typeof taskUpdateSchema>;
type TaskInsertionPosition = z.infer<typeof taskInsertionPositionSchema>;

export type AsanaTaskCreationInput = TaskCreationInput;
export type AsanaTaskUpdate = TaskUpdate;
export type AsanaTaskInsertionPosition = TaskInsertionPosition;

function validateGid(value: string): string {
  return gidSchema.parse(value);
}

function parseTaskUpdateBody(data: JsonObject): JsonObject {
  const body: JsonObject = { data };
  taskUpdateBodySchema.parse(body);
  return body;
}

function buildTaskUpdateBody(update: TaskUpdate): JsonObject {
  switch (update.kind) {
    case "title":
      return parseTaskUpdateBody({ name: update.value });
    case "notes":
      return parseTaskUpdateBody({ notes: update.value });
    case "completed":
      return parseTaskUpdateBody({ completed: update.value });
    case "due_on":
      return parseTaskUpdateBody({ due_on: update.value });
    case "due_at":
      return parseTaskUpdateBody({ due_at: update.value });
    case "clear_due": {
      const body: JsonObject = {
        data: {
          due_on: null,
          due_at: null,
        },
      };
      clearDueBodySchema.parse(body);
      return body;
    }
    case "external":
      return parseTaskUpdateBody({ external: update.value });
  }
}

/** Asanaタスクの作成と許可された書き込み操作を提供します。 */
export class AsanaTaskWriteClient {
  private readonly transport: AsanaTransportRequestPort;

  public constructor(transport: AsanaTransportRequestPort) {
    this.transport = transport;
  }

  /** Custom external data付きのAsanaタスクを作成します。 */
  public async createTask(
    input: AsanaTaskCreationInput,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    const validatedInput = taskCreationInputSchema.parse(input);
    const data: JsonObject = {
      name: validatedInput.title,
      projects: [validatedInput.project_gid],
      external: validatedInput.external,
      ...(validatedInput.notes != null
        ? { notes: validatedInput.notes }
        : {}),
      ...(validatedInput.completed != null
        ? { completed: validatedInput.completed }
        : {}),
      ...(validatedInput.due_on != null
        ? { due_on: validatedInput.due_on }
        : {}),
      ...(validatedInput.due_at != null
        ? { due_at: validatedInput.due_at }
        : {}),
    };
    const body: JsonObject = { data };
    createTaskBodySchema.parse(body);
    const response = await this.transport.request(
      {
        method: "POST",
        path: ["tasks"],
        query: { opt_fields: taskOptFields },
        body,
        response_schema: taskResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  /** Asanaタスクの許可された項目を1つだけ更新します。 */
  public async updateTask(
    taskGid: string,
    update: AsanaTaskUpdate,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    const validatedTaskGid = validateGid(taskGid);
    const validatedUpdate = taskUpdateSchema.parse(update);
    const body = buildTaskUpdateBody(validatedUpdate);
    const response = await this.transport.request(
      {
        method: "PUT",
        path: ["tasks", validatedTaskGid],
        query: { opt_fields: taskOptFields },
        body,
        retry_safe: true,
        response_schema: taskResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  /** Asanaタスクへタグを付与します。 */
  public async addTaskTag(
    taskGid: string,
    tagGid: string,
    signal: AbortSignal,
  ): Promise<void> {
    const validatedTaskGid = validateGid(taskGid);
    const validatedTagGid = validateGid(tagGid);
    const body = addTagBodySchema.parse({
      data: { tag: validatedTagGid },
    });
    await this.postEmptyAction(
      ["tasks", validatedTaskGid, "addTag"],
      body,
      signal,
    );
  }

  /** Asanaタスクからタグを解除します。 */
  public async removeTaskTag(
    taskGid: string,
    tagGid: string,
    signal: AbortSignal,
  ): Promise<void> {
    const validatedTaskGid = validateGid(taskGid);
    const validatedTagGid = validateGid(tagGid);
    const body = addTagBodySchema.parse({
      data: { tag: validatedTagGid },
    });
    await this.postEmptyAction(
      ["tasks", validatedTaskGid, "removeTag"],
      body,
      signal,
    );
  }

  /** Asanaタスクをプロジェクトへ追加します。 */
  public async addTaskToProject(
    taskGid: string,
    projectGid: string,
    sectionGid: string,
    position: AsanaTaskInsertionPosition,
    signal: AbortSignal,
  ): Promise<void> {
    const validatedTaskGid = validateGid(taskGid);
    const validatedProjectGid = validateGid(projectGid);
    const validatedSectionGid = validateGid(sectionGid);
    const validatedPosition = taskInsertionPositionSchema.parse(position);
    const data: JsonObject = {
      project: validatedProjectGid,
      section: validatedSectionGid,
      ...(validatedPosition.kind === "after"
        ? { insert_after: validatedPosition.task_gid }
        : {}),
      ...(validatedPosition.kind === "before"
        ? { insert_before: validatedPosition.task_gid }
        : {}),
    };
    const body: JsonObject = { data };
    addProjectBodySchema.parse(body);
    await this.postEmptyAction(
      ["tasks", validatedTaskGid, "addProject"],
      body,
      signal,
    );
  }

  /** Asanaタスクをセクションへ追加し表示位置を指定します。 */
  public async addTaskToSection(
    taskGid: string,
    sectionGid: string,
    position: AsanaTaskInsertionPosition,
    signal: AbortSignal,
  ): Promise<void> {
    const validatedTaskGid = validateGid(taskGid);
    const validatedSectionGid = validateGid(sectionGid);
    const validatedPosition = taskInsertionPositionSchema.parse(position);
    const data: JsonObject = {
      task: validatedTaskGid,
      ...(validatedPosition.kind === "after"
        ? { insert_after: validatedPosition.task_gid }
        : {}),
      ...(validatedPosition.kind === "before"
        ? { insert_before: validatedPosition.task_gid }
        : {}),
    };
    const body: JsonObject = { data };
    addSectionBodySchema.parse(body);
    await this.postEmptyAction(
      ["sections", validatedSectionGid, "addTask"],
      body,
      signal,
    );
  }

  /** Asanaタスクに親タスクを設定します。 */
  public async setTaskParent(
    taskGid: string,
    parentGid: string,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    const validatedTaskGid = validateGid(taskGid);
    const validatedParentGid = validateGid(parentGid);
    const body = setParentBodySchema.parse({
      data: { parent: validatedParentGid },
    });
    return this.postParentAction(
      ["tasks", validatedTaskGid, "setParent"],
      body,
      signal,
    );
  }

  /** Asanaタスクの親タスクを解除します。 */
  public async clearTaskParent(
    taskGid: string,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    const validatedTaskGid = validateGid(taskGid);
    const body = clearParentBodySchema.parse({
      data: { parent: null },
    });
    return this.postParentAction(
      ["tasks", validatedTaskGid, "setParent"],
      body,
      signal,
    );
  }

  private async postEmptyAction(
    path: readonly string[],
    body: JsonObject,
    signal: AbortSignal,
  ): Promise<void> {
    await this.transport.request(
      {
        method: "POST",
        path,
        body,
        response_schema: emptyActionResponseSchema,
      },
      signal,
    );
  }

  private async postParentAction(
    path: readonly string[],
    body: JsonObject,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    const response = await this.transport.request(
      {
        method: "POST",
        path,
        query: { opt_fields: taskOptFields },
        body,
        response_schema: taskResponseSchema,
      },
      signal,
    );
    return response.data;
  }
}
