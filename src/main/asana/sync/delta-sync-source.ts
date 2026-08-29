import { z } from "zod";
import { gidSchema } from "../../../shared/domain";
import { AsanaReadClient, type AsanaEventsResult } from "../client/client";
import { asanaSyncTokenSchema } from "../sync-token";

const maximumAffectedTaskCount = 10_000;

const deltaSyncInputSchema = z
  .object({
    project_gid: gidSchema,
    sync_token: asanaSyncTokenSchema.optional(),
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
        sync_token: asanaSyncTokenSchema,
        affected_task_gids: z.array(gidSchema).max(maximumAffectedTaskCount),
      })
      .strict(),
    z
      .object({
        kind: z.literal("full_sync_required"),
        sync_token: asanaSyncTokenSchema,
        reason: z.enum(["events_reset", "unsafe_structure"]),
      })
      .strict(),
  ])
  .superRefine((result, context) => {
    if (result.kind !== "delta") {
      return;
    }
    addSortedUniqueGidIssues(
      result.affected_task_gids,
      ["affected_task_gids"],
      context,
    );
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

function requiresFullSync(events: AsanaEvents["data"]): boolean {
  return events.some((event) => {
    if (event.resource.resource_type !== "task") {
      return false;
    }
    if (event.action === "deleted" || event.action === "undeleted") {
      return true;
    }
    return event.action === "changed" && event.change?.field === "parent";
  });
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
        reason: "events_reset",
      });
    }
    if (requiresFullSync(events.data)) {
      return deltaSyncResultSchema.parse({
        kind: "full_sync_required",
        sync_token: events.sync,
        reason: "unsafe_structure",
      });
    }
    const affectedTaskGids = collectAffectedTaskGids(events.data);
    return deltaSyncResultSchema.parse({
      kind: "delta",
      sync_token: events.sync,
      affected_task_gids: affectedTaskGids,
    });
  }
}
