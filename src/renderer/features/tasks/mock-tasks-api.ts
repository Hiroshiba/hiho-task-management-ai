import { z } from "zod";
import { detailSchema, overviewSchema } from "../../../shared/ipc-contracts/task-view";
import { syncResultSchema, syncStateSchema, tasksContracts, type TasksApi } from "../../../shared/ipc-contracts/tasks";
import { executionDtoSchema, type ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { proposalOperationSchema, type ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import type { GuiEditOperation } from "../../../shared/ipc-contracts/task-values";

type TaskDetail = z.infer<typeof detailSchema>;
type TaskOverview = z.infer<typeof overviewSchema>;
type SyncState = z.infer<typeof syncStateSchema>;
type ProposalOperation = ProposalViewDto["groups"][number]["operations"][number];
type MockTasksApi = TasksApi & {
  readonly completeExternalSync: (syncedAt: string) => void;
  readonly applyProposalOperations: (operations: readonly ProposalOperation[], syncedAt: string) => void;
};
const projectGid = "mock-project";
const syncAt = "2026-09-05T00:00:00.000Z";
const baselineHash = "0".repeat(64);

function notifyListener<Value>(listener: (value: Value) => void | Promise<void>, value: Value): void {
  const result = listener(value);
  if (result != null) result.catch((error: unknown) => {
    queueMicrotask(() => { throw error; });
  });
}

function proposalTaskGid(target: { readonly kind: "existing"; readonly gid: string } | { readonly kind: "temporary"; readonly ref: string }): string {
  return target.kind === "existing" ? target.gid : `mock-created-${target.ref}`;
}

function proposalDue(value: Extract<ProposalOperation, { readonly operation: "set_due" }>["after"]): TaskDetail["due"] {
  return value.kind === "due_on"
    ? { kind: "on", value: value.due_on }
    : { kind: "at", value: value.due_at };
}

function proposalGuiEdit(operation: Exclude<ProposalOperation, { readonly operation: "create_task" }>): GuiEditOperation {
  switch (operation.operation) {
    case "update_title": return { kind: "update_title", value: operation.after };
    case "update_notes": return { kind: "update_notes", value: operation.after };
    case "set_status": return { kind: "set_status", value: operation.after };
    case "set_importance": return { kind: "set_importance", value: operation.after };
    case "set_due": return { kind: "set_due", value: proposalDue(operation.after) };
    case "clear_due": return { kind: "clear_due" };
    case "set_duration": return { kind: "set_duration", value: operation.after };
    case "clear_duration": return { kind: "clear_duration" };
    case "set_area": return { kind: "set_area", value: operation.after };
    case "set_dependencies": return { kind: "set_dependencies", value: operation.after.map((dependency) => ({
      task_gid: proposalTaskGid(dependency.target), scope: dependency.scope, source: dependency.source,
    })) };
    case "set_parent": return { kind: "set_parent", value: operation.after.kind === "absent"
      ? { kind: "absent" } : { kind: "existing", gid: proposalTaskGid(operation.after) } };
    case "set_parent_work_mode": return { kind: "set_parent_work_mode", value: operation.after };
    case "link_obsidian": return { kind: "link_obsidian", value: operation.after };
    case "unlink_obsidian": return { kind: "unlink_obsidian", value: operation.before };
    case "complete": return { kind: "complete" };
    case "withdraw": return { kind: "withdraw" };
  }
}

function createDetail(
  gid: string,
  title: string,
  status: TaskDetail["status"],
  importance: TaskDetail["importance"],
  due: TaskDetail["due"],
  duration: TaskDetail["duration"],
  area: string,
  rank: number,
  links: TaskDetail["obsidian_links"],
): TaskDetail {
  return detailSchema.parse({
    project_gid: projectGid,
    gid,
    edit_baseline_hash: baselineHash,
    title,
    notes: "画面確認用のサンプルタスクです。",
    status,
    importance,
    ...(duration == null ? {} : { duration }),
    due,
    area,
    block_state: "none",
    section_gid: `mock-section-${status}`,
    parent_work_mode: "has_own_work",
    activity_anchor_on: "2026-09-01",
    ranking: {
      kind: "ranked",
      rank,
      calculated_at: syncAt,
      activity_elapsed_days: 4,
      detail_text: "画面確認用の順位情報です。",
      score_breakdown: {
        importance_points: importance * 10,
        deadline_points: due.kind === "none" ? 0 : 20,
        release_points: 0,
        partial_block_penalty: 0,
        stagnation_penalty: 0,
        execution_points: 10,
      },
      release_target_gids: [],
      reason_chips: ["画面確認用", "同期済み"],
      tie_break: { importance, release_points: 0, activity_anchor_on: "2026-09-01", gid },
      exclusion_reasons: [],
    },
    dependencies: [],
    dependents: [],
    children: [],
    child_progress: { completed_count: 0, total_count: 0 },
    has_dependencies: false,
    has_children: false,
    obsidian_links: links,
    asana_url: `https://app.asana.com/0/${projectGid}/${gid}`,
    cleanup_warnings: [],
  });
}

function createOverview(details: readonly TaskDetail[], lastSuccessfulSyncAt: string): TaskOverview {
  return overviewSchema.parse({
    project_gid: projectGid,
    last_successful_sync_at: lastSuccessfulSyncAt,
    last_full_sync_at: syncAt,
    ranking: { kind: "available", calculated_at: syncAt, app_version: "mock" },
    default_filter: "ranked",
    tasks: details.map((detail) => {
      const row = {
      gid: detail.gid,
      title: detail.title,
      status: detail.status,
      importance: detail.importance,
      duration: detail.duration,
      due: detail.due,
      area: detail.area,
      block_state: detail.block_state,
      reason_chips: detail.ranking.reason_chips ?? [],
      child_progress: detail.child_progress,
      has_dependencies: detail.has_dependencies,
      has_children: detail.has_children,
      warning_count: 0,
      };
      if (detail.gid === "mock-task-6") {
        return { ...row, kind: "excluded", block_state: "full",
          exclusion_reasons: [{ code: "dependency_cycle", message: "依存関係が循環しています。" }] };
      }
      if (detail.gid === "mock-task-7") {
        return { ...row, kind: "unavailable", block_state: "full",
          unavailable_reasons: ["ranking_unavailable"] };
      }
      return { ...row, kind: "ranked", rank: detail.ranking.kind === "ranked" ? detail.ranking.rank : 1 };
    }),
    areas: [...new Set(details.map((detail) => detail.area))],
    cleanup_items: [],
    cleanup_count: 0,
  });
}

/** 新IPCのタスク閲覧と同期に使うmockを作成します。 */
export function createMockTasksApi(): MockTasksApi {
  const details = [
    createDetail("mock-task-1", "今日の集中タスク", "in_progress", 5, { kind: "on", value: "2026-09-10" },
      { value: 15, unit: "minute" }, "開発", 1,
      [{ vault_id: "mock-vault", path: "notes/focus.md", title: "集中タスク", confidence: 1 }]),
    createDetail("mock-task-2", "週次レビュー", "not_started", 3, { kind: "none" },
      { value: 2, unit: "hour" }, "運用", 2, []),
    createDetail("mock-task-3", "完了済みサンプル", "completed", 2, { kind: "at", value: "2026-09-04T15:00:00.000Z" },
      { value: 3, unit: "day" }, "開発", 3, []),
    createDetail("mock-task-4", "期限超過サンプル", "in_progress", 4, { kind: "at", value: "2026-09-09T15:00:00.000Z" },
      { value: 1, unit: "hour" }, "開発", 4, []),
    createDetail("mock-task-5", "取り下げ済みサンプル", "withdrawn", 1, { kind: "on", value: "2026-09-01" },
      { value: 1, unit: "day" }, "運用", 5, []),
    createDetail("mock-task-6", "順位除外サンプル", "in_progress", 5, { kind: "on", value: "2026-09-10" },
      { value: 15, unit: "minute" }, "開発", 6, []),
    createDetail("mock-task-7", "利用不能サンプル", "in_progress", 3, { kind: "at", value: "2026-09-12T15:00:00.000Z" },
      { value: 1, unit: "month" }, "運用", 7, []),
    createDetail("mock-task-8", "所要時間未設定サンプル", "not_started", 2, { kind: "none" },
      undefined, "運用", 8, []),
    createDetail("mock-task-9", "週単位の所要時間サンプル", "not_started", 4, { kind: "none" },
      { value: 1, unit: "week" }, "運用", 9, []),
  ];
  let lastSuccessfulSyncAt = syncAt;
  let overview = createOverview(details, lastSuccessfulSyncAt);
  let state: SyncState = syncStateSchema.parse({ kind: "online", last_successful_sync_at: lastSuccessfulSyncAt });
  const listeners = new Set<Parameters<TasksApi["onSyncState"]>[0]>();
  const executionListeners = new Set<Parameters<TasksApi["onExecution"]>[0]>();
  const executions = new Map<string, ExecutionDto>();
  let editSequence = 0;

  function editedDetail(detail: TaskDetail, operation: GuiEditOperation): TaskDetail {
    const nextHash = editSequence.toString(16).padStart(64, "0");
    switch (operation.kind) {
      case "update_title":
        return detailSchema.parse({ ...detail, title: operation.value, edit_baseline_hash: nextHash });
      case "update_notes":
        return detailSchema.parse({ ...detail, notes: operation.value, edit_baseline_hash: nextHash });
      case "set_status":
        return detailSchema.parse({ ...detail, status: operation.value, edit_baseline_hash: nextHash });
      case "complete":
        return detailSchema.parse({ ...detail, status: "completed", edit_baseline_hash: nextHash });
      case "withdraw":
        return detailSchema.parse({ ...detail, status: "withdrawn", edit_baseline_hash: nextHash });
      case "restore":
        return detailSchema.parse({ ...detail, status: operation.value, edit_baseline_hash: nextHash });
      case "mark_activity":
        return detailSchema.parse({ ...detail, activity_anchor_on: new Date().toISOString().slice(0, 10), edit_baseline_hash: nextHash });
      case "set_importance":
        return detailSchema.parse({ ...detail, importance: operation.value, edit_baseline_hash: nextHash });
      case "set_due":
        return detailSchema.parse({ ...detail, due: operation.value, edit_baseline_hash: nextHash });
      case "clear_due":
        return detailSchema.parse({ ...detail, due: { kind: "none" }, edit_baseline_hash: nextHash });
      case "set_duration":
        return detailSchema.parse({ ...detail, duration: operation.value, edit_baseline_hash: nextHash });
      case "clear_duration": {
        const { duration: unusedDuration, ...remaining } = detail;
        void unusedDuration;
        return detailSchema.parse({ ...remaining, edit_baseline_hash: nextHash });
      }
      case "set_area":
        return detailSchema.parse({ ...detail, area: operation.value, edit_baseline_hash: nextHash });
      case "set_dependencies":
        return detailSchema.parse({ ...detail, edit_baseline_hash: nextHash,
          has_dependencies: operation.value.length > 0,
          dependencies: operation.value.map((dependency) => {
            const target = details.find((candidate) => candidate.gid === dependency.task_gid);
            return target == null
              ? { kind: "missing", gid: dependency.task_gid, scope: dependency.scope, source: dependency.source }
              : { kind: "found", gid: target.gid, title: target.title, status: target.status,
                scope: dependency.scope, source: dependency.source };
          }) });
      case "set_parent": {
        const parentValue = operation.value;
        const parent = parentValue.kind === "absent" ? undefined : details.find((candidate) => candidate.gid === parentValue.gid);
        return detailSchema.parse({ ...detail, edit_baseline_hash: nextHash,
          ...(parentValue.kind === "absent" ? { parent: undefined } : {
            parent: parent == null
              ? { kind: "missing", gid: parentValue.gid }
              : { kind: "found", gid: parent.gid, title: parent.title, status: parent.status },
          }) });
      }
      case "set_parent_work_mode":
        return detailSchema.parse({ ...detail, parent_work_mode: operation.value, edit_baseline_hash: nextHash });
      case "link_obsidian":
        return detailSchema.parse({ ...detail, obsidian_links: [...detail.obsidian_links, operation.value], edit_baseline_hash: nextHash });
      case "unlink_obsidian":
        return detailSchema.parse({ ...detail, obsidian_links: detail.obsidian_links.filter((link) =>
          link.vault_id !== operation.value.vault_id || link.path !== operation.value.path), edit_baseline_hash: nextHash });
    }
  }

  function rebuildRelations(): void {
    const rebuilt = details.map((detail) => {
      const dependencies = detail.dependencies.map((dependency) => {
        const target = details.find((candidate) => candidate.gid === dependency.gid);
        return target == null
          ? { kind: "missing", gid: dependency.gid, scope: dependency.scope, source: dependency.source }
          : { kind: "found", gid: target.gid, title: target.title, status: target.status,
            scope: dependency.scope, source: dependency.source };
      });
      const dependents = details.flatMap((candidate) => candidate.dependencies
        .filter((dependency) => dependency.gid === detail.gid)
        .map((dependency) => ({ kind: "found", gid: candidate.gid, title: candidate.title,
          status: candidate.status, scope: dependency.scope, source: dependency.source })));
      const children = details.filter((candidate) => candidate.parent?.gid === detail.gid)
        .map((candidate) => ({ kind: "found", gid: candidate.gid, title: candidate.title, status: candidate.status }));
      const parent = detail.parent == null ? undefined : details.find((candidate) => candidate.gid === detail.parent?.gid);
      return detailSchema.parse({ ...detail, dependencies, dependents, children,
        has_dependencies: dependencies.length > 0, has_children: children.length > 0,
        child_progress: { completed_count: children.filter((child) => child.status === "completed").length,
          total_count: children.length },
        ...(detail.parent == null ? {} : { parent: parent == null
          ? { kind: "missing", gid: detail.parent.gid }
          : { kind: "found", gid: parent.gid, title: parent.title, status: parent.status } }),
      });
    });
    details.splice(0, details.length, ...rebuilt);
  }

  function publish(value: SyncState): void {
    state = syncStateSchema.parse(value);
    for (const listener of listeners) notifyListener(listener, state);
  }

  function completeExternalSync(syncedAt: string): void {
    if (!Number.isFinite(Date.parse(syncedAt))) throw new Error("同期日時を確認できません。");
    if (Date.parse(syncedAt) > Date.parse(lastSuccessfulSyncAt)) lastSuccessfulSyncAt = syncedAt;
    overview = createOverview(details, lastSuccessfulSyncAt);
    publish({ kind: "online", last_successful_sync_at: lastSuccessfulSyncAt });
  }

  function applyProposalOperations(operations: readonly ProposalOperation[], syncedAt: string): void {
    const validated = operations.map((operation) => proposalOperationSchema.parse(operation));
    for (const operation of validated) {
      if (operation.operation === "create_task") {
        const gid = proposalTaskGid({ kind: "temporary", ref: operation.temporary_ref });
        if (details.some((detail) => detail.gid === gid)) throw new Error("作成対象のタスクがmockに既にあります。");
        const after = operation.after;
        const detail = createDetail(gid, after.title, after.status ?? "not_started", detailSchema.shape.importance.parse(after.importance ?? 3),
          after.due == null ? { kind: "none" } : proposalDue(after.due), after.duration,
          after.area ?? "未分類", details.length + 1, after.obsidian_links ?? []);
        details.push(detailSchema.parse({ ...detail, notes: after.notes ?? "",
          ...(after.parent == null ? {} : { parent: { kind: "missing", gid: proposalTaskGid(after.parent) } }),
          dependencies: (after.dependencies ?? []).map((dependency) => ({
            kind: "missing", gid: proposalTaskGid(dependency.target), scope: dependency.scope, source: dependency.source,
          })),
          parent_work_mode: after.parent_work_mode ?? detail.parent_work_mode,
        }));
      } else {
        const gid = proposalTaskGid(operation.target);
        const index = details.findIndex((detail) => detail.gid === gid);
        const current = details[index];
        if (current == null) throw new Error("適用対象のタスクがmockにありません。");
        editSequence += 1;
        details[index] = editedDetail(current, proposalGuiEdit(operation));
      }
      rebuildRelations();
    }
    completeExternalSync(syncedAt);
  }

  return {
    completeExternalSync,
    applyProposalOperations,
    getOverview: () => Promise.resolve(tasksContracts.getOverview.response.parse({ kind: "ok", value: overview })),
    getDetail: (taskGid) => Promise.resolve().then(() => {
      const request = tasksContracts.getDetail.request.parse({ task_gid: taskGid });
      const detail = details.find((candidate) => candidate.gid === request.task_gid);
      return tasksContracts.getDetail.response.parse(detail == null
        ? { kind: "error", code: "not_found", message: "指定したタスクがmockにありません。" }
        : { kind: "ok", value: detail });
    }),
    getSyncState: () => Promise.resolve(tasksContracts.getSyncState.response.parse({ kind: "ok", value: state })),
    runSync: (mode) => Promise.resolve().then(() => {
      const request = tasksContracts.runSync.request.parse({ mode });
      publish({ kind: "syncing", requested_mode: request.mode, last_successful_sync_at: lastSuccessfulSyncAt });
      lastSuccessfulSyncAt = new Date(Date.parse(lastSuccessfulSyncAt) + 1).toISOString();
      overview = createOverview(details, lastSuccessfulSyncAt);
      const notifications: z.infer<typeof syncResultSchema>["normalization_notifications"] = [
        { kind: "status_reconciled", task_gid: "mock-task-1", status: "in_progress", message: "タスク状態を進行中へ整合化しました。" },
      ];
      publish({ kind: "online", last_successful_sync_at: lastSuccessfulSyncAt, normalization_notifications: notifications });
      return tasksContracts.runSync.response.parse({ kind: "ok", value: syncResultSchema.parse({
        requested_mode: request.mode,
        performed_mode: request.mode,
        synced_at: lastSuccessfulSyncAt,
        affected_count: 1,
        applied_count: 1,
        already_applied_count: 0,
        conflict_count: 0,
        remaining_write_count: 0,
        critical_error_count: 0,
        cleanup_count: 0,
        normalization_notifications: notifications,
      }) });
    }),
    applyEdit: (input) => Promise.resolve().then(() => {
      const request = tasksContracts.applyEdit.request.parse(input);
      const index = details.findIndex((candidate) => candidate.gid === request.task_gid);
      const current = details[index];
      editSequence += 1;
      const operationId = `mock-operation-${editSequence}`;
      if (current == null) return tasksContracts.applyEdit.response.parse({ kind: "ok", value: {
        kind: "not_started", operation_id: operationId, task_gid: request.task_gid,
        outcome: "rejected", reason_code: "task_missing",
      } });
      if (current.edit_baseline_hash !== request.expected_task_hash) return tasksContracts.applyEdit.response.parse({ kind: "ok", value: {
        kind: "not_started", operation_id: operationId, task_gid: request.task_gid,
        outcome: "conflict", reason_code: "baseline_changed",
      } });
      details[index] = editedDetail(current, request.operation);
      rebuildRelations();
      lastSuccessfulSyncAt = new Date(Date.parse(lastSuccessfulSyncAt) + 1).toISOString();
      overview = createOverview(details, lastSuccessfulSyncAt);
      publish({ kind: "online", last_successful_sync_at: lastSuccessfulSyncAt });
      const stepKinds = {
        update_title: "asana_update_task",
        update_notes: "asana_update_task",
        set_status: "asana_add_to_section",
        complete: "asana_update_task",
        withdraw: "asana_update_task",
        restore: "asana_add_to_section",
        mark_activity: "asana_merge_external_data",
        set_importance: "asana_add_tag",
        set_due: "asana_update_task",
        clear_due: "asana_update_task",
        set_duration: "asana_merge_external_data",
        clear_duration: "asana_merge_external_data",
        set_area: "asana_add_tag",
        set_dependencies: "asana_merge_external_data",
        set_parent: "asana_set_parent",
        set_parent_work_mode: "asana_merge_external_data",
        link_obsidian: "asana_merge_external_data",
        unlink_obsidian: "asana_merge_external_data",
      } satisfies Record<GuiEditOperation["kind"], ExecutionDto["steps"][number]["kind"]>;
      const updatedAt = new Date().toISOString();
      const execution = executionDtoSchema.parse({
        origin: "gui-edit", execution_id: `mock-execution-${editSequence}`, task_gid: request.task_gid,
        created_at: updatedAt, updated_at: updatedAt, state: "succeeded",
        steps: [
          { step_id: `mock-step-${operationId}`, scope: { kind: "operation", operation_id: operationId },
            kind: stepKinds[request.operation.kind], state: "succeeded", attempt: 1, updated_at: updatedAt },
          { step_id: `mock-step-${operationId}-synchronize`, scope: { kind: "execution" },
            kind: "local_synchronize", state: "succeeded", attempt: 1, updated_at: updatedAt },
        ],
        operation_results: [{ operation_id: operationId, task_gid: request.task_gid,
          outcome: "applied", reason_code: "applied" }], group_results: [],
      });
      executions.set(execution.execution_id, execution);
      for (const listener of executionListeners) notifyListener(listener, execution);
      return tasksContracts.applyEdit.response.parse({ kind: "ok", value: { kind: "execution", execution } });
    }),
    getExecution: (executionId) => Promise.resolve().then(() => {
      const request = tasksContracts.getExecution.request.parse({ execution_id: executionId });
      const execution = executions.get(request.execution_id);
      return tasksContracts.getExecution.response.parse(execution == null
        ? { kind: "error", code: "not_found", message: "GUI編集の実行が見つかりません。" }
        : { kind: "ok", value: execution });
    }),
    retryExecution: (executionId) => Promise.resolve().then(() => {
      tasksContracts.retryExecution.request.parse({ retry_of_execution_id: executionId });
      return tasksContracts.retryExecution.response.parse({ kind: "error", code: "conflict", message: "この実行は再試行できません。" });
    }),
    onSyncState: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onExecution: (listener) => {
      executionListeners.add(listener);
      return () => { executionListeners.delete(listener); };
    },
  };
}
