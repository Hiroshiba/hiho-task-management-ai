import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  areaSchema,
  dependencyGraphSchema,
  gidSchema,
  isoDateTimeSchema,
  parentChildRelationSchema,
  taskSchema,
  type Task,
} from "../../../shared/domain";
import {
  rankingCacheSchema,
  type RankingCache,
} from "../../../shared/storage";

const maxPathLength = 4_096;
const maxSnapshotTasks = 10_000;
const maxListResults = 1_000;
const maxGraphTasks = 10_000;
const maxGraphRelations = 20_000;
const maxAreas = 500;
const maxSearchCharacters = 200;
const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 512 * 1024;
const maxJsonDepth = 24;
const maxConnections = 8;
const maxExecutionMilliseconds = 5_000;
const taskctlProtocolVersion = 1;
const maxDiagnostics = 64;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(maxPathLength)
  .refine(isAbsolute, "パスは絶対パスで指定してください。")
  .refine((value) => !value.includes("\0"), "パスに使用できない文字が含まれています。")
  .refine(
    (value) => !value.toLowerCase().startsWith("\\\\.\\pipe\\"),
    "名前付きパイプは専用形式で指定してください。",
  );

const windowsPipeSocketPathSchema = z
  .string()
  .min(1)
  .max(maxPathLength)
  .regex(/^\\\\\.\\pipe\\taskhub-taskctl-[0-9a-f]{24}$/u, "名前付きパイプが不正です。");

const localIpcBoundarySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("windows_named_pipe"),
      access: z.literal("current_user"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unix_socket"),
      access: z.literal("owner_only"),
    })
    .strict(),
]);

const socketPathSchema = process.platform === "win32"
  ? windowsPipeSocketPathSchema
  : absolutePathSchema;

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

const capabilitySchema = z.string().regex(/^[0-9a-f]{64}$/u, {
  message: "taskctlの起動単位能力値が不正です。",
});

/** taskctl接続情報ファイルを検証するスキーマです。 */
export const taskctlConnectionInfoSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    socketPath: socketPathSchema,
    capability: capabilitySchema,
  })
  .strict();

/** taskctlブローカーの起動設定を検証するスキーマです。 */
export const taskctlBrokerOptionsSchema = z
  .object({
    tmpDirectoryPath: absolutePathSchema,
    snapshotProvider: z.custom<TaskctlSnapshotProvider>(
      (value) => typeof value === "function",
      "スナップショット供給関数が必要です。",
    ),
  })
  .strict();

/** taskctlブローカーの起動結果を検証するスキーマです。 */
export const taskctlBrokerStartResultSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    socketPath: socketPathSchema,
    connectionInfoPath: absolutePathSchema,
    localIpcBoundary: localIpcBoundarySchema,
  })
  .strict()
  .superRefine((result, context) => {
    const expectedBoundaryKind = process.platform === "win32"
      ? "windows_named_pipe"
      : "unix_socket";
    if (result.localIpcBoundary.kind !== expectedBoundaryKind) {
      context.addIssue({
        code: "custom",
        path: ["localIpcBoundary"],
        message: "taskctlのローカルIPC境界が実行環境と一致しません。",
      });
    }
  });

const searchQuerySchema = z
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
    query: searchQuerySchema,
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

const listRequestSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    capability: capabilitySchema,
    command: z.literal("list"),
    format: z.literal("json"),
  })
  .strict();

const getRequestSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    capability: capabilitySchema,
    command: z.literal("get"),
    gid: gidSchema,
    format: z.literal("json"),
  })
  .strict();

const rankRequestSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    capability: capabilitySchema,
    command: z.literal("rank"),
    format: z.literal("json"),
  })
  .strict();

const graphRequestSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    capability: capabilitySchema,
    command: z.literal("graph"),
    format: z.literal("json"),
  })
  .strict();

const areasRequestSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    capability: capabilitySchema,
    command: z.literal("areas"),
    format: z.literal("json"),
  })
  .strict();

const searchRequestSchema = z
  .object({
    version: z.literal(taskctlProtocolVersion),
    capability: capabilitySchema,
    command: z.literal("search-local"),
    query: searchQuerySchema,
    format: z.literal("json"),
  })
  .strict();

/** taskctlが受け付ける読み取り専用要求を検証するスキーマです。 */
export const taskctlRequestSchema = z.discriminatedUnion("command", [
  listRequestSchema,
  getRequestSchema,
  rankRequestSchema,
  graphRequestSchema,
  areasRequestSchema,
  searchRequestSchema,
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

const taskctlDiagnosticCodeSchema = z.enum([
  "startup_error",
  "server_error",
  "socket_error",
  "snapshot_provider_error",
  "snapshot_invalid",
  "process_error",
  "response_error",
  "stop_error",
]);

/** taskctl内部診断の安全な公開形式を検証するスキーマです。 */
export const taskctlDiagnosticSchema = z
  .object({
    code: taskctlDiagnosticCodeSchema,
    cause_present: z.boolean(),
  })
  .strict();

/** taskctl内部診断の配列を検証するスキーマです。 */
export const taskctlDiagnosticsSchema = z
  .array(taskctlDiagnosticSchema)
  .max(maxDiagnostics);

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
        query: searchQuerySchema,
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
export type TaskctlDiagnostic = z.infer<typeof taskctlDiagnosticSchema>;
export type TaskctlRankingState = z.infer<
  typeof availableRankingSchema | typeof unavailableRankingSchema
>;
export type TaskctlSnapshot = z.infer<typeof taskctlSnapshotSchema>;
export type TaskctlConnectionInfo = z.infer<typeof taskctlConnectionInfoSchema>;
export type TaskctlBrokerOptions = z.infer<typeof taskctlBrokerOptionsSchema>;
export type TaskctlBrokerStartResult = z.infer<
  typeof taskctlBrokerStartResultSchema
>;
export type TaskctlQuery = z.infer<typeof taskctlQuerySchema>;
export type TaskctlRequest = z.infer<typeof taskctlRequestSchema>;
export type TaskctlResponse = z.infer<typeof taskctlResponseSchema>;
export type TaskctlSnapshotProvider = () =>
  | TaskctlSnapshot
  | PromiseLike<TaskctlSnapshot>;
export type TaskctlTask = Task;
export type TaskctlRankingCache = RankingCache;

export {
  maxConnections,
  maxDiagnostics,
  maxExecutionMilliseconds,
  maxJsonDepth,
  maxRequestBytes,
  maxResponseBytes,
  maxSnapshotTasks,
  taskctlProtocolVersion,
};

/** taskctl要求が正しい読み取り専用要求か判定します。 */
export function isTaskctlRequest(value: unknown): value is TaskctlRequest {
  return taskctlRequestSchema.safeParse(value).success;
}

/** taskctl応答が正しい構造化応答か判定します。 */
export function isTaskctlResponse(value: unknown): value is TaskctlResponse {
  return taskctlResponseSchema.safeParse(value).success;
}
