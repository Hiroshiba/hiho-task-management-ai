import { z } from "zod";
import {
  asanaTaskResponseSchema,
  gidSchema,
  type AsanaTaskResponse,
} from "../../../shared/domain";
import { AsanaReadClient, type AsanaEventsResult } from "../client/client";
import { AsanaHttpError } from "../transport";

const maximumAffectedTaskCount = 10_000;

const deltaSyncInputSchema = z
  .object({
    project_gid: gidSchema,
    sync_token: gidSchema.optional(),
  })
  .strict();

function addSortedUniqueGidIssues(
  gids: readonly string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  let previousGid: string | undefined;
  gids.forEach((gid, index) => {
    if (seen.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "GIDを重複して指定できません。",
      });
    }
    seen.add(gid);
    if (previousGid != null && previousGid >= gid) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "GID順に並べて指定してください。",
      });
    }
    previousGid = gid;
  });
}

const deltaSyncResultSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("delta"),
        sync_token: gidSchema,
        upsert: z.array(asanaTaskResponseSchema).max(maximumAffectedTaskCount),
        missing_gids: z.array(gidSchema).max(maximumAffectedTaskCount),
      })
      .strict(),
    z
      .object({
        kind: z.literal("full_sync_required"),
        sync_token: gidSchema,
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (result.kind !== "delta") {
      return;
    }
    const upsertGids = result.upsert.map((task) => task.gid);
    addSortedUniqueGidIssues(upsertGids, ["upsert"], context);
    addSortedUniqueGidIssues(
      result.missing_gids,
      ["missing_gids"],
      context,
    );
    if (
      upsertGids.length + result.missing_gids.length
      > maximumAffectedTaskCount
    ) {
      context.addIssue({
        code: "custom",
        message: "差分同期の影響件数が上限を超えています。",
      });
    }
    const upsertSet = new Set(upsertGids);
    result.missing_gids.forEach((gid, index) => {
      if (upsertSet.has(gid)) {
        context.addIssue({
          code: "custom",
          path: ["missing_gids", index],
          message: "upsertとmissing_gidsに同じGIDを指定できません。",
        });
      }
    });
  });

export type AsanaDeltaSyncInput = z.infer<typeof deltaSyncInputSchema>;
export type AsanaDeltaSyncResult = z.infer<typeof deltaSyncResultSchema>;

/** Asana差分同期の入力を検証するスキーマです。 */
export const asanaDeltaSyncInputSchema = deltaSyncInputSchema;

/** Asana差分同期の結果を検証するスキーマです。 */
export const asanaDeltaSyncResultSchema = deltaSyncResultSchema;

function compareGids(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

type AsanaEvents = Extract<AsanaEventsResult, { kind: "events" }>;

function collectAffectedTaskGids(
  events: AsanaEvents["data"],
): readonly string[] {
  const gids = new Set<string>();
  const addTaskGid = (gid: string): void => {
    if (gids.has(gid)) {
      return;
    }
    gids.add(gid);
    if (gids.size > maximumAffectedTaskCount) {
      throw new Error("差分同期の影響件数が上限を超えています。");
    }
  };

  for (const event of events) {
    if (event.resource.resource_type === "task") {
      addTaskGid(event.resource.gid);
    }
    if (
      event.parent != null
      && event.parent.resource_type === "task"
    ) {
      addTaskGid(event.parent.gid);
    }
  }
  return [...gids].sort(compareGids);
}

function hasProject(
  task: AsanaTaskResponse,
  projectGid: string,
): boolean {
  return task.projects.some((project) => project.gid === projectGid);
}

type FetchedTasks = {
  readonly upsert: readonly AsanaTaskResponse[];
  readonly missing_gids: readonly string[];
};

async function fetchAffectedTasks(
  readClient: AsanaReadClient,
  taskGids: readonly string[],
  projectGid: string,
  signal: AbortSignal,
): Promise<FetchedTasks> {
  const upsert = new Map<string, AsanaTaskResponse>();
  const missingGids = new Set<string>();
  for (const taskGid of taskGids) {
    let task: AsanaTaskResponse;
    try {
      task = await readClient.getTask(taskGid, signal);
    } catch (error) {
      if (error instanceof AsanaHttpError && error.status === 404) {
        missingGids.add(taskGid);
        continue;
      }
      throw error;
    }
    if (task.gid !== taskGid) {
      throw new Error("Asanaタスクの取得GIDが要求と一致しません。");
    }
    if (hasProject(task, projectGid)) {
      upsert.set(task.gid, task);
    } else {
      missingGids.add(taskGid);
    }
  }
  return {
    upsert: [...upsert.values()].sort((left, right) =>
      compareGids(left.gid, right.gid)),
    missing_gids: [...missingGids].sort(compareGids),
  };
}

/** AsanaのEvents APIから差分同期用のタスク状態を収集します。 */
export class AsanaDeltaSyncSource {
  private readonly readClient: AsanaReadClient;

  public constructor(readClient: AsanaReadClient) {
    this.readClient = readClient;
  }

  /** 保存済み同期トークンからAsanaの差分を収集します。 */
  public async collect(
    input: AsanaDeltaSyncInput,
    signal: AbortSignal,
  ): Promise<AsanaDeltaSyncResult> {
    const validatedInput = deltaSyncInputSchema.parse(input);
    const events = await this.readClient.getEvents(
      validatedInput.project_gid,
      validatedInput.sync_token,
      signal,
    );
    if (events.kind === "sync_reset") {
      return deltaSyncResultSchema.parse({
        kind: "full_sync_required",
        sync_token: events.sync,
      });
    }
    const affectedTaskGids = collectAffectedTaskGids(events.data);
    const fetchedTasks = await fetchAffectedTasks(
      this.readClient,
      affectedTaskGids,
      validatedInput.project_gid,
      signal,
    );
    return deltaSyncResultSchema.parse({
      kind: "delta",
      sync_token: events.sync,
      upsert: fetchedTasks.upsert,
      missing_gids: fetchedTasks.missing_gids,
    });
  }
}
