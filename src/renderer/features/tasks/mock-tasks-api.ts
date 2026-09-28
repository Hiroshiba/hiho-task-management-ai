import { z } from "zod";
import { detailSchema, overviewSchema } from "../../../shared/ipc-contracts/task-view";
import { syncResultSchema, syncStateSchema, tasksContracts, type TasksApi } from "../../../shared/ipc-contracts/tasks";

type TaskDetail = z.infer<typeof detailSchema>;
type TaskOverview = z.infer<typeof overviewSchema>;
type SyncState = z.infer<typeof syncStateSchema>;
const projectGid = "mock-project";
const syncAt = "2026-09-05T00:00:00.000Z";
const baselineHash = "0".repeat(64);

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
export function createMockTasksApi(): TasksApi {
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
  const listeners = new Set<(value: SyncState) => void>();

  function publish(value: SyncState): void {
    state = syncStateSchema.parse(value);
    for (const listener of listeners) listener(state);
  }

  return {
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
    applyEdit: () => Promise.reject(new Error("GUI直接編集のmockはタスク編集機能で実装します。")),
    getExecution: () => Promise.reject(new Error("GUI編集実行のmockはタスク編集機能で実装します。")),
    retryExecution: () => Promise.reject(new Error("GUI編集再試行のmockはタスク編集機能で実装します。")),
    onSyncState: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    onExecution: () => { throw new Error("GUI編集実行のmockはタスク編集機能で実装します。"); },
  };
}
