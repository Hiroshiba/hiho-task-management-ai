import type { z } from "zod";
import type { GuiEditExecution } from "../../application/gui-edit";
import { executionDtoSchema, type ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { detailSchema, overviewSchema } from "../../../shared/ipc-contracts/task-view";
import { tasksContracts } from "../../../shared/ipc-contracts/tasks";
import { createContractHandler, type ContractHandler, type IpcSuccessValue } from "./contract-handler";
import { toExecutionStepsDto } from "./execution-dto";

type MaybePromise<Value> = Value | PromiseLike<Value>;
type Request<Contract extends { readonly request: z.ZodType }> = z.output<Contract["request"]>;
type SyncStateDto = IpcSuccessValue<typeof tasksContracts.getSyncState.response>;
type SyncResultDto = IpcSuccessValue<typeof tasksContracts.runSync.response>;
type TaskEditResultDto = IpcSuccessValue<typeof tasksContracts.applyEdit.response>;
type NotStartedSource = {
  readonly kind: "not_started";
  readonly result: {
    readonly operation_id: string;
    readonly task_gid: string;
    readonly outcome: "conflict" | "rejected";
    readonly reason_code: string;
  };
};
type TaskInvokeName = "getOverview" | "getDetail" | "getSyncState" | "runSync" | "applyEdit" | "getExecution" | "retryExecution";

export type TasksHandlers = {
  readonly [Name in TaskInvokeName]: ContractHandler<(typeof tasksContracts)[Name]>;
};

/** タスクの公開workflowをIPC handlerへ接続します。 */
export interface TasksHandlerWorkflows {
  readonly taskRead: {
    getOverview(): MaybePromise<unknown>;
    getTaskDetail(taskGid: string): MaybePromise<unknown>;
    getState(): MaybePromise<SyncStateDto>;
    run(input: Request<typeof tasksContracts.runSync>, signal: AbortSignal): MaybePromise<{
      readonly requested_mode: SyncResultDto["requested_mode"];
      readonly performed_mode: SyncResultDto["performed_mode"];
      readonly synced_at: SyncResultDto["synced_at"];
      readonly fallback_reason?: string | undefined;
      readonly critical_errors: readonly unknown[];
      readonly cleanup_items: readonly unknown[];
      readonly application_result: {
        readonly affected_gids: readonly string[];
        readonly operations: readonly { readonly outcome: "applied" | "already_applied" | "conflict" }[];
      };
      readonly remaining_plan: {
        readonly status_write_task_gids: readonly string[];
        readonly external_write_task_gids: readonly string[];
        readonly tag_write_task_gids: readonly string[];
      };
      readonly normalization_notifications: SyncResultDto["normalization_notifications"];
    }>;
  };
  readonly guiEdit: {
    applyGuiEdit(
      input: Request<typeof tasksContracts.applyEdit>,
      signal: AbortSignal,
    ): MaybePromise<NotStartedSource | { readonly kind: "execution"; readonly execution: GuiEditExecution }>;
  };
  readonly taskWriteExecution: {
    getExecution(executionId: string): MaybePromise<GuiEditExecution>;
    retryExecution(executionId: string, signal: AbortSignal): MaybePromise<GuiEditExecution>;
  };
}

function toSyncStateDto(state: SyncStateDto): SyncStateDto {
  switch (state.kind) {
    case "online":
      return { kind: state.kind,
        ...(state.last_successful_sync_at == null ? {} : { last_successful_sync_at: state.last_successful_sync_at }),
        ...(state.last_error_code == null ? {} : { last_error_code: state.last_error_code }),
        ...(state.normalization_notifications == null ? {} : { normalization_notifications: state.normalization_notifications }) };
    case "offline":
      return { kind: state.kind,
        ...(state.last_successful_sync_at == null ? {} : { last_successful_sync_at: state.last_successful_sync_at }),
        ...(state.last_error_code == null ? {} : { last_error_code: state.last_error_code }) };
    case "syncing":
      return { kind: state.kind, requested_mode: state.requested_mode,
        ...(state.last_successful_sync_at == null ? {} : { last_successful_sync_at: state.last_successful_sync_at }),
        ...(state.last_error_code == null ? {} : { last_error_code: state.last_error_code }) };
    case "authentication_required":
      return { kind: state.kind, error_code: state.error_code,
        ...(state.last_successful_sync_at == null ? {} : { last_successful_sync_at: state.last_successful_sync_at }) };
    case "error":
      return { kind: state.kind, error_code: state.error_code,
        ...(state.last_successful_sync_at == null ? {} : { last_successful_sync_at: state.last_successful_sync_at }) };
  }
}

function toTaskEditResult(result: NotStartedSource | { readonly kind: "execution"; readonly execution: GuiEditExecution }): TaskEditResultDto {
  if (result.kind === "execution") {
    return { kind: "execution", execution: toGuiExecutionDto(result.execution) };
  }
  const { operation_id, task_gid, outcome, reason_code } = result.result;
  if (reason_code === "baseline_changed") {
    return { kind: "not_started", operation_id, task_gid, outcome: "conflict", reason_code };
  }
  if (outcome === "conflict") {
    switch (reason_code) {
      case "relationship_cycle":
      case "external_unreadable":
      case "external_identity_mismatch":
        return { kind: "not_started", operation_id, task_gid, outcome, reason_code };
    }
  } else {
    switch (reason_code) {
      case "offline":
      case "task_missing":
      case "context_changed":
      case "synchronization_failed":
        return { kind: "not_started", operation_id, task_gid, outcome, reason_code };
    }
  }
  throw new Error("GUI編集の開始前結果が公開契約と一致しません。");
}

function toGuiOperationResult(execution: GuiEditExecution): ExecutionDto["operation_results"][number] {
  const context = execution.plan.gui_context;
  if (execution.plan.origin !== "gui-edit" || context == null) {
    throw new Error("GUI編集executionの保存文脈がありません。");
  }
  if (execution.state === "succeeded") {
    if (execution.result.kind !== "gui-edit"
      || execution.result.operation_id !== context.operation_id
      || execution.result.task_gid !== context.task_gid) {
      throw new Error("GUI編集の保存済み結果がplanと一致しません。");
    }
    return { operation_id: context.operation_id, task_gid: context.task_gid,
      outcome: execution.result.outcome, reason_code: execution.result.outcome };
  }
  if (execution.state === "planned" || execution.state === "running") {
    return { operation_id: context.operation_id, task_gid: context.task_gid, outcome: "pending" };
  }
  const stopped = execution.steps.find((step) => step.state === "failed" || step.state === "confirmation_required");
  if (stopped == null || (stopped.state !== "failed" && stopped.state !== "confirmation_required")) {
    throw new Error("停止したGUI編集executionに停止stepがありません。");
  }
  if (stopped.state === "failed" && stopped.descriptor.kind === "proposal_operation_check") {
    return { operation_id: context.operation_id, task_gid: context.task_gid,
      outcome: "not_applied", reason_code: "baseline_changed" };
  }
  if (stopped.state === "failed" && !execution.steps.some((step) => step.state === "succeeded"
    && (step.receipt.kind === "asana_write" || step.receipt.kind === "created_task"))) {
    return { operation_id: context.operation_id, task_gid: context.task_gid,
      outcome: "not_applied", reason_code: "write_failed" };
  }
  return { operation_id: context.operation_id, task_gid: context.task_gid,
    outcome: "unknown",
    reason_code: stopped.sync_error_code == null ? "write_unconfirmed" : "local_resync_required" };
}

/** 保存済みGUI編集executionを共通の表示DTOへ変換します。 */
export function toGuiExecutionDto(execution: GuiEditExecution): ExecutionDto {
  const context = execution.plan.gui_context;
  if (execution.plan.origin !== "gui-edit" || context == null) {
    throw new Error("GUI編集executionの保存文脈がありません。");
  }
  return executionDtoSchema.parse({
    origin: "gui-edit",
    execution_id: execution.execution_id,
    ...(execution.retry_of_execution_id == null ? {} : { retry_of_execution_id: execution.retry_of_execution_id }),
    task_gid: context.task_gid,
    state: execution.state,
    ...(execution.error_id == null ? {} : { error_id: execution.error_id }),
    created_at: execution.created_at,
    updated_at: execution.updated_at,
    steps: toExecutionStepsDto(execution.steps),
    operation_results: [toGuiOperationResult(execution)],
    group_results: [],
  });
}

/** タスクの各use caseに対応するIPC handlerを作成します。 */
export function createTasksHandlers(workflows: TasksHandlerWorkflows): TasksHandlers {
  const { taskRead, guiEdit, taskWriteExecution } = workflows;
  const getExecution = createContractHandler(tasksContracts.getExecution, async (request) =>
    toGuiExecutionDto(await taskWriteExecution.getExecution(request.execution_id)));
  const retryExecution = createContractHandler(tasksContracts.retryExecution, async (request, signal) =>
    toGuiExecutionDto(await taskWriteExecution.retryExecution(request.retry_of_execution_id, signal)));
  return {
    getOverview: createContractHandler(tasksContracts.getOverview, async () =>
      overviewSchema.parse(await taskRead.getOverview())),
    getDetail: createContractHandler(tasksContracts.getDetail, async (request) =>
      detailSchema.parse(await taskRead.getTaskDetail(request.task_gid))),
    getSyncState: createContractHandler(tasksContracts.getSyncState, async () =>
      toSyncStateDto(await taskRead.getState())),
    runSync: createContractHandler(tasksContracts.runSync, async (request, signal) => {
      const result = await taskRead.run(request, signal);
      const operations = result.application_result.operations;
      return {
        requested_mode: result.requested_mode,
        performed_mode: result.performed_mode,
        synced_at: result.synced_at,
        ...(result.fallback_reason == null ? {} : { fallback_reason: result.fallback_reason }),
        affected_count: result.application_result.affected_gids.length,
        applied_count: operations.filter((operation) => operation.outcome === "applied").length,
        already_applied_count: operations.filter((operation) => operation.outcome === "already_applied").length,
        conflict_count: operations.filter((operation) => operation.outcome === "conflict").length,
        remaining_write_count: result.remaining_plan.status_write_task_gids.length
          + result.remaining_plan.external_write_task_gids.length
          + result.remaining_plan.tag_write_task_gids.length,
        critical_error_count: result.critical_errors.length,
        cleanup_count: result.cleanup_items.length,
        normalization_notifications: result.normalization_notifications,
      };
    }),
    applyEdit: createContractHandler(tasksContracts.applyEdit, async (request, signal) =>
      toTaskEditResult(await guiEdit.applyGuiEdit(request, signal))),
    getExecution,
    retryExecution,
  };
}

/** 同期状態の購読要求を検証します。 */
export function parseTasksSyncStateSubscriptionRequest(payload: unknown): Request<typeof tasksContracts.subscribeSyncState> {
  return tasksContracts.subscribeSyncState.request.parse(payload);
}

/** 同期状態の購読解除要求を検証します。 */
export function parseTasksSyncStateUnsubscriptionRequest(payload: unknown): Request<typeof tasksContracts.unsubscribeSyncState> {
  return tasksContracts.unsubscribeSyncState.request.parse(payload);
}

/** 同期状態を購読イベントへ直列化します。 */
export function serializeTasksSyncStateEvent(subscriptionId: string, state: SyncStateDto): z.output<typeof tasksContracts.syncState.event> {
  return tasksContracts.syncState.event.parse({ subscription_id: subscriptionId, value: toSyncStateDto(state) });
}

/** GUI編集executionの購読要求を検証します。 */
export function parseTasksExecutionSubscriptionRequest(payload: unknown): Request<typeof tasksContracts.subscribeExecution> {
  return tasksContracts.subscribeExecution.request.parse(payload);
}

/** GUI編集executionの購読解除要求を検証します。 */
export function parseTasksExecutionUnsubscriptionRequest(payload: unknown): Request<typeof tasksContracts.unsubscribeExecution> {
  return tasksContracts.unsubscribeExecution.request.parse(payload);
}

/** GUI編集executionを購読イベントへ直列化します。 */
export function serializeTasksExecutionEvent(subscriptionId: string, execution: GuiEditExecution): z.output<typeof tasksContracts.execution.event> {
  return tasksContracts.execution.event.parse({ subscription_id: subscriptionId, value: toGuiExecutionDto(execution) });
}
