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
import { guiEditOperationSchema, taskStatusSchema } from "./task-values";
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

const syncErrorCodeSchema = z.enum([
  "authentication_required",
  "payment_required",
  "rate_limited",
  "http_error",
  "transport_error",
  "response_error",
  "events_reset",
  "request_aborted",
  "sync_in_progress",
  "unexpected_error",
]);
const normalizationNotificationSchema = z.object({
  kind: z.literal("status_reconciled"),
  task_gid: gidSchema,
  status: taskStatusSchema,
  message: displayTextSchema,
}).strict();
const syncStateBaseShape = {
  last_successful_sync_at: dateTimeSchema.optional(),
  last_error_code: syncErrorCodeSchema.optional(),
};

export const syncStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("online"),
      normalization_notifications: z.array(normalizationNotificationSchema).max(10_000).optional(),
      ...syncStateBaseShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("offline"),
      ...syncStateBaseShape,
    })
    .strict(),
  z
    .object({
      kind: z.literal("syncing"),
      requested_mode: z.enum(["full", "delta"]),
      ...syncStateBaseShape,
    })
    .strict(),
  z.object({ kind: z.literal("authentication_required"), error_code: z.literal("authentication_required"),
    last_successful_sync_at: dateTimeSchema.optional() }).strict(),
  z
    .object({
      kind: z.literal("error"),
      error_code: syncErrorCodeSchema,
      last_successful_sync_at: dateTimeSchema.optional(),
    })
    .strict(),
]);

export const syncResultSchema = z
  .object({
    requested_mode: z.enum(["full", "delta"]),
    performed_mode: z.enum(["full", "delta"]),
    synced_at: dateTimeSchema,
    fallback_reason: displayTextSchema.optional(),
    affected_count: z.number().int().nonnegative(),
    applied_count: z.number().int().nonnegative(),
    already_applied_count: z.number().int().nonnegative(),
    conflict_count: z.number().int().nonnegative(),
    remaining_write_count: z.number().int().nonnegative(),
    critical_error_count: z.number().int().nonnegative(),
    cleanup_count: z.number().int().nonnegative(),
    normalization_notifications: z.array(normalizationNotificationSchema).max(10_000),
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
          "task_missing",
          "context_changed",
          "synchronization_failed",
        ]),
      })
      .strict(),
  ])
  .refine(
    (result) => result.kind !== "not_started" || (result.outcome === "conflict") === [
      "baseline_changed",
      "relationship_cycle",
      "external_unreadable",
      "external_identity_mismatch",
    ].includes(result.reason_code),
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
