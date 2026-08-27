import { z } from "zod";
import {
  asanaProjectResponseSchema,
  asanaSectionResponseSchema,
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  type AsanaTaskResponse,
} from "../../../shared/domain";
import {
  AsanaEventsResetError,
  AsanaTransport,
} from "../transport";

const listLimit = "100";
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
  "subtasks.gid",
  "subtasks.name",
  "projects.gid",
  "projects.name",
].join(",");
const projectOptFields = "gid,name,workspace.gid,workspace.name";
const sectionOptFields = "gid,name";
const tagOptFields = "gid,name";

const nextPageSchema = z
  .object({
    offset: identifierSchema,
    path: z.string(),
    uri: z.string(),
  })
  .strip();

const taskPageResponseSchema = z
  .object({
    data: z.array(asanaTaskResponseSchema),
    next_page: nextPageSchema.nullable(),
  })
  .strip();

const sectionPageResponseSchema = z
  .object({
    data: z.array(asanaSectionResponseSchema),
    next_page: nextPageSchema.nullable(),
  })
  .strip();

const tagPageResponseSchema = z
  .object({
    data: z.array(asanaTagResponseSchema),
    next_page: nextPageSchema.nullable(),
  })
  .strip();

const taskResponseSchema = z
  .object({
    data: asanaTaskResponseSchema,
  })
  .strip();

const projectResponseSchema = z
  .object({
    data: asanaProjectResponseSchema,
  })
  .strip();

const eventResourceSchema = z
  .object({
    gid: gidSchema,
    resource_type: identifierSchema,
  })
  .strip();

const eventChangeSchema = z
  .object({
    field: identifierSchema,
    new_value: z.unknown().optional(),
  })
  .strip();

const eventSchema = z
  .object({
    action: z.enum(["changed", "added", "removed", "deleted", "undeleted"]),
    resource: eventResourceSchema,
    parent: eventResourceSchema.nullable(),
    user: eventResourceSchema.nullable(),
    created_at: isoDateTimeSchema,
    change: eventChangeSchema.nullable(),
  })
  .strip();

const eventSyncSchema = identifierSchema;

const eventsResponseSchema = z
  .object({
    data: z.array(eventSchema),
    sync: eventSyncSchema,
    has_more: z.boolean(),
  })
  .strip();

const eventsResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("events"),
      data: z.array(eventSchema),
      sync: eventSyncSchema,
      has_more: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sync_reset"),
      sync: eventSyncSchema,
    })
    .strict(),
]);

type NextPage = z.infer<typeof nextPageSchema>;

type PageResponse<T> = {
  readonly data: T[];
  readonly next_page: NextPage | null;
};

type AsanaProjectResponse = z.infer<
  typeof asanaProjectResponseSchema
>;
type AsanaSectionResponse = z.infer<
  typeof asanaSectionResponseSchema
>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
type AsanaEvent = z.infer<typeof eventSchema>;

export type AsanaEventsResult = z.infer<typeof eventsResultSchema>;

function validateGid(value: string): string {
  return gidSchema.parse(value);
}

function validateSyncToken(value: string | undefined): string | undefined {
  if (value == null) {
    return undefined;
  }
  return eventSyncSchema.parse(value);
}

/** Asanaの読み取りAPIを提供します。 */
export class AsanaReadClient {
  private readonly transport: AsanaTransport;

  public constructor(transport: AsanaTransport) {
    this.transport = transport;
  }

  /** Asanaタスクを取得します。 */
  public async getTask(
    taskGid: string,
    signal: AbortSignal,
  ): Promise<AsanaTaskResponse> {
    const validatedTaskGid = validateGid(taskGid);
    const response = await this.transport.request(
      {
        method: "GET",
        path: ["tasks", validatedTaskGid],
        query: { opt_fields: taskOptFields },
        response_schema: taskResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  /** Asanaプロジェクトを取得します。 */
  public async getProject(
    projectGid: string,
    signal: AbortSignal,
  ): Promise<AsanaProjectResponse> {
    const validatedProjectGid = validateGid(projectGid);
    const response = await this.transport.request(
      {
        method: "GET",
        path: ["projects", validatedProjectGid],
        query: { opt_fields: projectOptFields },
        response_schema: projectResponseSchema,
      },
      signal,
    );
    return response.data;
  }

  /** Asanaプロジェクトのタスクを取得します。 */
  public async listProjectTasks(
    projectGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaTaskResponse[]> {
    const validatedProjectGid = validateGid(projectGid);
    return this.listPages(
      ["projects", validatedProjectGid, "tasks"],
      taskOptFields,
      taskPageResponseSchema,
      signal,
    );
  }

  /** Asanaタスクのサブタスクを取得します。 */
  public async listSubtasks(
    taskGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaTaskResponse[]> {
    const validatedTaskGid = validateGid(taskGid);
    return this.listPages(
      ["tasks", validatedTaskGid, "subtasks"],
      taskOptFields,
      taskPageResponseSchema,
      signal,
    );
  }

  /** Asanaプロジェクトのセクションを取得します。 */
  public async listProjectSections(
    projectGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaSectionResponse[]> {
    const validatedProjectGid = validateGid(projectGid);
    return this.listPages(
      ["projects", validatedProjectGid, "sections"],
      sectionOptFields,
      sectionPageResponseSchema,
      signal,
    );
  }

  /** Asanaワークスペースのタグを取得します。 */
  public async listWorkspaceTags(
    workspaceGid: string,
    signal: AbortSignal,
  ): Promise<readonly AsanaTagResponse[]> {
    const validatedWorkspaceGid = validateGid(workspaceGid);
    return this.listPages(
      ["workspaces", validatedWorkspaceGid, "tags"],
      tagOptFields,
      tagPageResponseSchema,
      signal,
    );
  }

  /** Asanaイベントを同期トークンから取得します。 */
  public async getEvents(
    resourceGid: string,
    syncToken: string | undefined,
    signal: AbortSignal,
  ): Promise<AsanaEventsResult> {
    const validatedResourceGid = validateGid(resourceGid);
    let nextSyncToken = validateSyncToken(syncToken);
    const events: AsanaEvent[] = [];
    const seenSyncTokens = new Set<string>();
    if (nextSyncToken != null) {
      seenSyncTokens.add(nextSyncToken);
    }

    try {
      while (true) {
        const query: Record<string, string> = {
          resource: validatedResourceGid,
        };
        if (nextSyncToken != null) {
          query.sync = nextSyncToken;
        }
        const response = await this.transport.request(
          {
            method: "GET",
            path: ["events"],
            query,
            response_schema: eventsResponseSchema,
          },
          signal,
        );
        events.push(...response.data);
        if (!response.has_more) {
          const result = eventsResponseSchema.parse({
            data: events,
            sync: response.sync,
            has_more: false,
          });
          return eventsResultSchema.parse({ kind: "events", ...result });
        }
        if (seenSyncTokens.has(response.sync)) {
          throw new Error("Asanaイベントのsync tokenが進みません。");
        }
        seenSyncTokens.add(response.sync);
        nextSyncToken = response.sync;
      }
    } catch (error) {
      if (error instanceof AsanaEventsResetError) {
        return eventsResultSchema.parse({
          kind: "sync_reset",
          sync: eventSyncSchema.parse(error.syncToken),
        });
      }
      throw error;
    }
  }

  private async listPages<T>(
    path: readonly string[],
    optFields: string,
    responseSchema: z.ZodType<PageResponse<T>>,
    signal: AbortSignal,
  ): Promise<readonly T[]> {
    const items: T[] = [];
    let offset: string | undefined;
    const seenOffsets = new Set<string>();

    while (true) {
      const query: Record<string, string> = {
        limit: listLimit,
        opt_fields: optFields,
      };
      if (offset != null) {
        query.offset = offset;
      }
      const response = await this.transport.request(
        {
          method: "GET",
          path,
          query,
          response_schema: responseSchema,
        },
        signal,
      );
      items.push(...response.data);
      const nextPage = response.next_page;
      if (nextPage == null) {
        return items;
      }
      if (seenOffsets.has(nextPage.offset)) {
        throw new Error("Asana APIのページングoffsetが進みません。");
      }
      seenOffsets.add(nextPage.offset);
      offset = nextPage.offset;
    }
  }
}
