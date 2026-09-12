import { z } from "zod";
import {
  areaSchema,
  dependencyGraphSchema,
  gidSchema,
  isoDateTimeSchema,
  parentChildRelationSchema,
  taskSchema,
  type Task,
} from "../domain";
import { rankingCacheSchema, type RankingCache } from "../storage";

export const maxSnapshotTasks = 10_000;
export const maxListResults = 1_000;
export const maxGraphTasks = 10_000;
export const maxGraphRelations = 20_000;
export const maxAreas = 500;
export const maxSearchCharacters = 200;

const syncedStateSchema = z
  .object({
    kind: z.literal("synced"),
    synced_at: isoDateTimeSchema,
  })
  .strict();

const unavailableStateSchema = z
  .object({
    kind: z.literal("unavailable"),
  })
  .strict();

/** taskctlが参照する同期状態を検証するスキーマです。 */
export const taskctlSyncStateSchema = z.discriminatedUnion("kind", [
  syncedStateSchema,
  unavailableStateSchema,
]);

const availableRankingSchema = z
  .object({
    kind: z.literal("available"),
    cache: rankingCacheSchema,
  })
  .strict();

const unavailableRankingSchema = z
  .object({
    kind: z.literal("unavailable"),
  })
  .strict();

const taskListSchema = z
  .array(taskSchema)
  .max(maxSnapshotTasks)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (const [index, task] of tasks.entries()) {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "同じタスクGIDをスナップショットへ重複して指定できません。",
        });
        continue;
      }
      seen.add(task.gid);
    }
  });

/** taskctlが参照する読み取り専用スナップショットを検証するスキーマです。 */
export const taskctlSnapshotSchema = z
  .object({
    sync: taskctlSyncStateSchema,
    tasks: taskListSchema,
    ranking: z.discriminatedUnion("kind", [
      availableRankingSchema,
      unavailableRankingSchema,
    ]),
  })
  .strict();

export const taskctlSearchQuerySchema = z
  .string()
  .min(1, "検索文字列を空にできません。")
  .max(maxSearchCharacters)
  .refine(
    (value) => [...value].length <= maxSearchCharacters,
    "検索文字数が上限を超えています。",
  );

const listQuerySchema = z
  .object({
    command: z.literal("list"),
  })
  .strict();

const getQuerySchema = z
  .object({
    command: z.literal("get"),
    gid: gidSchema,
  })
  .strict();

const rankQuerySchema = z
  .object({
    command: z.literal("rank"),
  })
  .strict();

const graphQuerySchema = z
  .object({
    command: z.literal("graph"),
  })
  .strict();

const areasQuerySchema = z
  .object({
    command: z.literal("areas"),
  })
  .strict();

const searchQueryRequestSchema = z
  .object({
    command: z.literal("search-local"),
    query: taskctlSearchQuerySchema,
  })
  .strict();

/** taskctl読み取り要求を検証するスキーマです。 */
export const taskctlQuerySchema = z.discriminatedUnion("command", [
  listQuerySchema,
  getQuerySchema,
  rankQuerySchema,
  graphQuerySchema,
  areasQuerySchema,
  searchQueryRequestSchema,
]);

const taskctlErrorCodeSchema = z.enum([
  "client_error",
  "invalid_request",
  "capability_invalid",
  "connection_limit",
  "broker_stopped",
  "snapshot_unavailable",
  "snapshot_invalid",
  "task_not_found",
  "result_limit",
  "response_too_large",
  "execution_timeout",
  "protocol_error",
]);

const taskctlErrorSchema = z
  .object({
    code: taskctlErrorCodeSchema,
    message: z.string().min(1).max(200),
  })
  .strict();

const listResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("list"),
    sync: taskctlSyncStateSchema,
    data: z
      .object({
        tasks: z.array(taskSchema).max(maxListResults),
      })
      .strict(),
  })
  .strict();

const getResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("get"),
    sync: taskctlSyncStateSchema,
    data: z
      .object({
        task: taskSchema,
      })
      .strict(),
  })
  .strict();

const rankResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("rank"),
    sync: taskctlSyncStateSchema,
    data: z
      .object({
        ranking: z.discriminatedUnion("kind", [
          availableRankingSchema,
          unavailableRankingSchema,
        ]),
      })
      .strict(),
  })
  .strict();

const graphResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("graph"),
    sync: taskctlSyncStateSchema,
    data: z
      .object({
        tasks: z.array(taskSchema).max(maxGraphTasks),
        dependencies: dependencyGraphSchema.max(maxGraphTasks),
        parent_relations: z
          .array(parentChildRelationSchema)
          .max(maxGraphRelations),
      })
      .strict(),
  })
  .strict();

const areasResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("areas"),
    sync: taskctlSyncStateSchema,
    data: z
      .object({
        areas: z.array(areaSchema).max(maxAreas),
      })
      .strict(),
  })
  .strict();

const searchResponseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("search-local"),
    sync: taskctlSyncStateSchema,
    data: z
      .object({
        query: taskctlSearchQuerySchema,
        tasks: z.array(taskSchema).max(maxListResults),
      })
      .strict(),
  })
  .strict();

const errorResponseSchema = z
  .object({
    ok: z.literal(false),
    error: taskctlErrorSchema,
    sync: taskctlSyncStateSchema,
  })
  .strict();

/** taskctlの全応答を検証するスキーマです。 */
export const taskctlResponseSchema = z.union([
  listResponseSchema,
  getResponseSchema,
  rankResponseSchema,
  graphResponseSchema,
  areasResponseSchema,
  searchResponseSchema,
  errorResponseSchema,
]);

export type TaskctlSyncState = z.infer<typeof taskctlSyncStateSchema>;
export type TaskctlRankingState = z.infer<
  typeof availableRankingSchema | typeof unavailableRankingSchema
>;
export type TaskctlSnapshot = z.infer<typeof taskctlSnapshotSchema>;
export type TaskctlQuery = z.infer<typeof taskctlQuerySchema>;
export type TaskctlResponse = z.infer<typeof taskctlResponseSchema>;
export type TaskctlTask = Task;
export type TaskctlRankingCache = RankingCache;
