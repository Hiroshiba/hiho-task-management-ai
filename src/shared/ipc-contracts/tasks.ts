import { z } from "zod";
import {
  dateTimeSchema,
  displayTextSchema,
  emptyRequestSchema,
  gidSchema,
  identifierSchema,
  responseSchema,
  subscriptionEventSchema,
  subscriptionRequestSchema,
  type IpcResult,
  type IpcSubscription,
} from "./common";
import { executionDtoSchema, type ExecutionDto } from "./execution";
import { guiEditOperationSchema } from "./task-values";
import { detailSchema, overviewSchema } from "./task-view";

export const tasksChannels = {
  getOverview: "tasks:get-overview",
  getDetail: "tasks:get-detail",
  getSyncState: "tasks:get-sync-state",
  runSync: "tasks:run-sync",
  applyEdit: "tasks:apply-edit",
  getExecution: "tasks:get-execution",
  retryExecution: "tasks:retry-execution",
  subscribeSyncState: "tasks:sync-state:subscribe",
  unsubscribeSyncState: "tasks:sync-state:unsubscribe",
  syncState: "tasks:sync-state",
  subscribeExecution: "tasks:execution:subscribe",
  unsubscribeExecution: "tasks:execution:unsubscribe",
  execution: "tasks:execution",
} satisfies Record<string, string>;

const syncStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("online"),
      last_successful_sync_at: dateTimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("offline"),
      last_successful_sync_at: dateTimeSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("syncing"),
      requested_mode: z.enum(["full", "delta"]),
      last_successful_sync_at: dateTimeSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("authentication_required") }).strict(),
  z
    .object({
      kind: z.literal("error"),
      error_code: displayTextSchema,
      last_successful_sync_at: dateTimeSchema.optional(),
    })
    .strict(),
]);

const syncResultSchema = z
  .object({
    requested_mode: z.enum(["full", "delta"]),
    performed_mode: z.enum(["full", "delta"]),
    synced_at: dateTimeSchema,
    fallback_reason: displayTextSchema.optional(),
    critical_error_count: z.number().int().nonnegative(),
    cleanup_count: z.number().int().nonnegative(),
  })
  .strict();

export const applyEditRequestSchema = z
  .object({
    task_gid: gidSchema,
    expected_task_hash: z.string().regex(/^[0-9a-f]{64}$/u),
    operation: guiEditOperationSchema,
  })
  .strict();

const guiExecutionSchema = executionDtoSchema.refine((execution) => execution.origin === "gui-edit");
const retryGuiExecutionSchema = guiExecutionSchema.refine((execution) => execution.retry_of_execution_id != null);
const taskEditResultSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("execution"), execution: guiExecutionSchema }).strict(),
    z
      .object({
        kind: z.literal("not_started"),
        operation_id: identifierSchema,
        task_gid: gidSchema,
        outcome: z.enum(["conflict", "rejected"]),
        reason_code: z.enum([
          "baseline_changed",
          "relationship_cycle",
          "external_unreadable",
          "external_identity_mismatch",
          "offline",
        ]),
      })
      .strict(),
  ])
  .refine(
    (result) => result.kind !== "not_started" || (result.outcome === "rejected") === (result.reason_code === "offline"),
    "開始前の結果と理由が一致しません。",
  );
const executionRequestSchema = z.object({ execution_id: identifierSchema }).strict();
const retryExecutionRequestSchema = z.object({ retry_of_execution_id: identifierSchema }).strict();

export const tasksContracts = {
  getOverview: {
    channel: tasksChannels.getOverview,
    request: emptyRequestSchema,
    response: responseSchema(overviewSchema),
  },
  getDetail: {
    channel: tasksChannels.getDetail,
    request: z.object({ task_gid: gidSchema }).strict(),
    response: responseSchema(detailSchema),
  },
  getSyncState: {
    channel: tasksChannels.getSyncState,
    request: emptyRequestSchema,
    response: responseSchema(syncStateSchema),
  },
  runSync: {
    channel: tasksChannels.runSync,
    request: z.object({ mode: z.enum(["full", "delta"]) }).strict(),
    response: responseSchema(syncResultSchema),
  },
  applyEdit: {
    channel: tasksChannels.applyEdit,
    request: applyEditRequestSchema,
    response: responseSchema(taskEditResultSchema),
  },
  getExecution: {
    channel: tasksChannels.getExecution,
    request: executionRequestSchema,
    response: responseSchema(guiExecutionSchema),
  },
  retryExecution: {
    channel: tasksChannels.retryExecution,
    request: retryExecutionRequestSchema,
    response: responseSchema(retryGuiExecutionSchema),
  },
  subscribeSyncState: {
    channel: tasksChannels.subscribeSyncState,
    request: subscriptionRequestSchema,
  },
  unsubscribeSyncState: {
    channel: tasksChannels.unsubscribeSyncState,
    request: subscriptionRequestSchema,
  },
  syncState: {
    channel: tasksChannels.syncState,
    event: subscriptionEventSchema(syncStateSchema),
  },
  subscribeExecution: { channel: tasksChannels.subscribeExecution, request: subscriptionRequestSchema },
  unsubscribeExecution: { channel: tasksChannels.unsubscribeExecution, request: subscriptionRequestSchema },
  execution: { channel: tasksChannels.execution, event: subscriptionEventSchema(guiExecutionSchema) },
};

export type TasksApi = {
  readonly getOverview: () => Promise<IpcResult<z.infer<typeof overviewSchema>>>;
  readonly getDetail: (taskGid: string) => Promise<IpcResult<z.infer<typeof detailSchema>>>;
  readonly getSyncState: () => Promise<IpcResult<z.infer<typeof syncStateSchema>>>;
  readonly runSync: (mode: "full" | "delta") => Promise<IpcResult<z.infer<typeof syncResultSchema>>>;
  readonly applyEdit: (
    input: z.infer<typeof applyEditRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof taskEditResultSchema>>>;
  readonly getExecution: (executionId: string) => Promise<IpcResult<ExecutionDto>>;
  readonly retryExecution: (retryOfExecutionId: string) => Promise<IpcResult<ExecutionDto>>;
  readonly onSyncState: IpcSubscription<z.infer<typeof syncStateSchema>>;
  readonly onExecution: IpcSubscription<ExecutionDto>;
};
