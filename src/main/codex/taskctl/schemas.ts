import { isAbsolute } from "node:path";
import { z } from "zod";
import { gidSchema } from "../../../shared/domain";
import {
  maxSnapshotTasks,
  taskctlQuerySchema,
  taskctlResponseSchema,
  taskctlSearchQuerySchema,
  taskctlSnapshotSchema,
  taskctlSyncStateSchema,
  type TaskctlQuery,
  type TaskctlRankingCache,
  type TaskctlRankingState,
  type TaskctlResponse,
  type TaskctlSnapshot,
  type TaskctlSyncState,
  type TaskctlTask,
} from "../../../shared/taskctl";

const maxPathLength = 4_096;
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
      socketDirectoryPath: absolutePathSchema,
    })
    .strict(),
]);

const socketPathSchema = process.platform === "win32"
  ? windowsPipeSocketPathSchema
  : absolutePathSchema;

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
    query: taskctlSearchQuerySchema,
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

export type TaskctlDiagnostic = z.infer<typeof taskctlDiagnosticSchema>;
export type TaskctlConnectionInfo = z.infer<typeof taskctlConnectionInfoSchema>;
export type TaskctlBrokerOptions = z.infer<typeof taskctlBrokerOptionsSchema>;
export type TaskctlBrokerStartResult = z.infer<
  typeof taskctlBrokerStartResultSchema
>;
export type TaskctlRequest = z.infer<typeof taskctlRequestSchema>;
export type TaskctlSnapshotProvider = () =>
  | TaskctlSnapshot
  | PromiseLike<TaskctlSnapshot>;

export {
  maxConnections,
  maxDiagnostics,
  maxExecutionMilliseconds,
  maxJsonDepth,
  maxRequestBytes,
  maxResponseBytes,
  maxSnapshotTasks,
  taskctlQuerySchema,
  taskctlResponseSchema,
  taskctlSnapshotSchema,
  taskctlSyncStateSchema,
  taskctlProtocolVersion,
};

export type {
  TaskctlQuery,
  TaskctlRankingCache,
  TaskctlRankingState,
  TaskctlResponse,
  TaskctlSnapshot,
  TaskctlSyncState,
  TaskctlTask,
};

/** taskctl要求が正しい読み取り専用要求か判定します。 */
export function isTaskctlRequest(value: unknown): value is TaskctlRequest {
  return taskctlRequestSchema.safeParse(value).success;
}

/** taskctl応答が正しい構造化応答か判定します。 */
export function isTaskctlResponse(value: unknown): value is TaskctlResponse {
  return taskctlResponseSchema.safeParse(value).success;
}
