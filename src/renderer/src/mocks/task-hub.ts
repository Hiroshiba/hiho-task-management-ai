import type { TaskHubApi } from "../../../shared/task-hub-api";
import {
  ipcAiApprovalInputSchema,
  ipcAiApprovalResponseSchema,
  ipcAiDeltaEventSchema,
  ipcAiEditInputSchema,
  ipcAiEditResponseSchema,
  ipcAiGetStatusInputSchema,
  ipcAiGetStatusResponseSchema,
  ipcAiProposalInputSchema,
  ipcAiProposalResponseSchema,
  ipcAiRejectInputSchema,
  ipcAiRejectResponseSchema,
  ipcAiSelectionInputSchema,
  ipcAiSelectionResponseSchema,
  ipcAiStartNewSessionInputSchema,
  ipcAiStartNewSessionResponseSchema,
  ipcAiStatusEventSchema,
  ipcAiTurnInputSchema,
  ipcAiTurnResponseSchema,
  ipcAppVersionSchema,
  ipcAsanaAuthenticationStateResponseSchema,
  ipcAsanaAuthenticationStateSchema,
  ipcAsanaBeginReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationResponseSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationResponseSchema,
  ipcEmptyRequestSchema,
  ipcFailureSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResponseSchema,
  ipcObsidianListInputSchema,
  ipcObsidianListResponseSchema,
  ipcObsidianListVaultsInputSchema,
  ipcObsidianListVaultsResponseSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianOpenNoteResponseSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianPathResponseSchema,
  ipcObsidianSearchInputSchema,
  ipcObsidianSearchResponseSchema,
  ipcObsidianValidateInputSchema,
  ipcObsidianValidateResponseSchema,
  ipcReadModelOverviewInputSchema,
  ipcReadModelOverviewResponseSchema,
  ipcReadModelTaskDetailInputSchema,
  ipcReadModelTaskDetailResponseSchema,
  ipcSetupBeginAsanaAuthorizationInputSchema,
  ipcSetupCancelAsanaAuthorizationInputSchema,
  ipcSetupChooseExternalToolInputSchema,
  ipcSetupChooseVaultInputSchema,
  ipcSetupCompleteAsanaAuthorizationInputSchema,
  ipcSetupCompleteCodexAuthenticationInputSchema,
  ipcSetupListWorkspacesInputSchema,
  ipcSetupRetryResourcesInputSchema,
  ipcSetupRunCapabilityInputSchema,
  ipcSetupRunCodexCapabilityInputSchema,
  ipcSetupRunFullSyncInputSchema,
  ipcSetupSelectProjectInputSchema,
  ipcSetupSelectWorkspaceInputSchema,
  ipcSetupStartInputSchema,
  ipcSetupStateResponseSchema,
  ipcSetupStateSchema,
  ipcSyncGetStateInputSchema,
  ipcSyncGetStateResponseSchema,
  ipcSyncInputSchema,
  ipcSyncResponseSchema,
  ipcSyncResultSchema,
  ipcSyncStateEventSchema,
  type IpcAiApprovalInput,
  type IpcAiApprovalResult,
  type IpcAiEditInput,
  type IpcAiProposalView,
  type IpcAiSelectionInput,
  type IpcAiStatus,
  type IpcAiTurnInput,
  type IpcAsanaAuthenticationState,
  type IpcAsanaReauthenticationCancelInput,
  type IpcAsanaReauthenticationCompleteInput,
  type IpcCodexDelta,
  type IpcFailure,
  type IpcGuiEditInput,
  type IpcObsidianNoteSummary,
  type IpcObsidianSearchResult,
  type IpcSetupAsanaAuthorizationBeginInput,
  type IpcSetupAsanaAuthorizationCancelInput,
  type IpcSetupAsanaAuthorizationCompleteInput,
  type IpcSetupExternalToolChoiceInput,
  type IpcSetupProjectSelectionInput,
  type IpcSetupState,
  type IpcSetupVaultChoiceInput,
  type IpcSetupWorkspaceSelectionInput,
  type IpcSyncResult,
  type IpcSyncStateEvent,
} from "../../../shared/ipc";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowTurnResultSchema,
  type AiWorkflowOperationEdit,
} from "../../../shared/ai-workflow";
import {
  type Dependency,
} from "../../../shared/domain";
import {
  viewModelOverviewSchema,
  viewModelTaskDetailSchema,
  viewModelTaskRowSchema,
  type ViewModelDependencyReference,
  type ViewModelDue,
  type ViewModelOverview,
  type ViewModelTaskReference,
  type ViewModelTaskDetail,
  type ViewModelTaskRow,
} from "../../../shared/view-model";

type MockResult<T> = { readonly kind: "ok"; readonly value: T } | IpcFailure;
type RankedTaskRanking = Extract<ViewModelTaskDetail["ranking"], { kind: "ranked" }>;
type RankingTieBreak = RankedTaskRanking["tie_break"];

const PROJECT_GID = "mock-project";
const PRIMARY_TASK_GID = "mock-task-1";
const SYNC_AT = "2026-09-05T00:00:00.000Z";
const ACTIVITY_ANCHOR_ON = "2026-09-01";
const MOCK_VAULT_ID = "mock-vault";
const MOCK_NOTE_PATH = "notes/focus.md";
const AUTHORIZATION_ID = "a".repeat(43);
const AUTHORIZATION_EXPIRES_AT = "2026-12-31T23:59:59.000Z";
const SNAPSHOT_HASH = "0".repeat(64);
const GROUP_ID = "mock-group";
const OPERATION_ID = "mock-operation";
const PROPOSAL_ID = "mock-proposal";
const TASK_GIDS = [PRIMARY_TASK_GID, "mock-task-2", "mock-task-3"];

function ok<T>(value: T): MockResult<T> {
  return { kind: "ok", value };
}

function failure(code: IpcFailure["code"], message: string): IpcFailure {
  return ipcFailureSchema.parse({ kind: "error", code, message });
}

function parseDetail(value: unknown): ViewModelTaskDetail {
  return viewModelTaskDetailSchema.parse(value);
}

function createSampleDetail(
  gid: string,
  title: string,
  notes: string,
  status: ViewModelTaskDetail["status"],
  importance: ViewModelTaskDetail["importance"],
  due: ViewModelDue,
  area: string,
  sectionGid: string,
  rank: number,
  obsidianLinks: ViewModelTaskDetail["obsidian_links"],
): ViewModelTaskDetail {
  const tieBreak: RankingTieBreak = {
    importance,
    release_points: 0,
    activity_anchor_on: ACTIVITY_ANCHOR_ON,
    gid,
  };
  if (due.kind === "at") {
    tieBreak.effective_due_at = due.value;
  }
  return parseDetail({
    project_gid: PROJECT_GID,
    gid,
    title,
    notes,
    status,
    importance,
    due,
    area,
    block_state: "none",
    section_gid: sectionGid,
    parent_work_mode: "has_own_work",
    activity_anchor_on: ACTIVITY_ANCHOR_ON,
    ranking: {
      kind: "ranked",
      rank,
      calculated_at: SYNC_AT,
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
      tie_break: tieBreak,
      exclusion_reasons: [],
    },
    dependencies: [],
    dependents: [],
    children: [],
    child_progress: { completed_count: 0, total_count: 0 },
    has_dependencies: false,
    has_children: false,
    obsidian_links: obsidianLinks,
    asana_url: `https://app.asana.com/0/${PROJECT_GID}/${gid}`,
    cleanup_warnings: [],
  });
}

function createInitialDetails(): Map<string, ViewModelTaskDetail> {
  const first = createSampleDetail(
    PRIMARY_TASK_GID,
    "今日の集中タスク",
    "画面確認用のサンプルタスクです。",
    "in_progress",
    5,
    { kind: "on", value: "2026-09-10" },
    "開発",
    "mock-section-in-progress",
    1,
    [{
      vault_id: MOCK_VAULT_ID,
      path: MOCK_NOTE_PATH,
      title: "集中タスク",
      confidence: 1,
    }],
  );
  const second = createSampleDetail(
    "mock-task-2",
    "週次レビュー",
    "週次レビューのサンプルタスクです。",
    "not_started",
    3,
    { kind: "none" },
    "運用",
    "mock-section-not-started",
    2,
    [],
  );
  const third = createSampleDetail(
    "mock-task-3",
    "完了済みサンプル",
    "完了済みタスクの表示確認用です。",
    "completed",
    2,
    { kind: "at", value: "2026-09-04T15:00:00.000Z" },
    "開発",
    "mock-section-completed",
    3,
    [],
  );
  return new Map([
    [first.gid, first],
    [second.gid, second],
    [third.gid, third],
  ]);
}

function createRow(detail: ViewModelTaskDetail, rank: number): ViewModelTaskRow {
  if (detail.ranking.kind !== "ranked") {
    throw new Error("mockの順位情報が不正です。");
  }
  return viewModelTaskRowSchema.parse({
    gid: detail.gid,
    title: detail.title,
    status: detail.status,
    importance: detail.importance,
    due: detail.due,
    block_state: detail.block_state,
    ...(detail.block_reason == null ? {} : { block_reason: detail.block_reason }),
    area: detail.area,
    reason_chips: detail.ranking.reason_chips,
    child_progress: detail.child_progress,
    has_dependencies: detail.has_dependencies,
    has_children: detail.has_children,
    warning_count: detail.cleanup_warnings.length,
    kind: "ranked",
    rank,
  });
}

function createOverview(details: ReadonlyMap<string, ViewModelTaskDetail>): ViewModelOverview {
  const tasks = Array.from(details.values(), (detail, index) => createRow(detail, index + 1));
  const areas = Array.from(new Set(Array.from(details.values(), (detail) => detail.area)));
  return viewModelOverviewSchema.parse({
    project_gid: PROJECT_GID,
    last_successful_sync_at: SYNC_AT,
    last_full_sync_at: SYNC_AT,
    ranking: {
      kind: "available",
      calculated_at: SYNC_AT,
      app_version: "mock",
    },
    default_filter: "ranked",
    tasks,
    areas,
    cleanup_items: [],
    cleanup_count: 0,
  });
}

function sectionForStatus(status: ViewModelTaskDetail["status"]): string {
  switch (status) {
    case "not_started":
      return "mock-section-not-started";
    case "in_progress":
      return "mock-section-in-progress";
    case "completed":
      return "mock-section-completed";
    case "withdrawn":
      return "mock-section-withdrawn";
  }
}

function removeEffectiveDueAt(tieBreak: RankingTieBreak): Omit<RankingTieBreak, "effective_due_at"> {
  const { effective_due_at, ...withoutEffectiveDueAt } = tieBreak;
  void effective_due_at;
  return withoutEffectiveDueAt;
}

function removeParent(detail: ViewModelTaskDetail): Omit<ViewModelTaskDetail, "parent"> {
  const copy = { ...detail };
  delete copy.parent;
  return copy;
}

function dependencyReference(
  dependency: Dependency,
  details: ReadonlyMap<string, ViewModelTaskDetail>,
): ViewModelDependencyReference {
  const target = details.get(dependency.task_gid);
  if (target == null) {
    return {
      kind: "missing",
      gid: dependency.task_gid,
      scope: dependency.scope,
      source: dependency.source,
    };
  }
  return {
    kind: "found",
    gid: target.gid,
    title: target.title,
    status: target.status,
    scope: dependency.scope,
    source: dependency.source,
  };
}

function parentReference(
  gid: string,
  details: ReadonlyMap<string, ViewModelTaskDetail>,
): ViewModelTaskReference {
  const target = details.get(gid);
  if (target == null) {
    return { kind: "missing", gid };
  }
  return {
    kind: "found",
    gid: target.gid,
    title: target.title,
    status: target.status,
  };
}

function applyGuiOperation(
  detail: ViewModelTaskDetail,
  operation: IpcGuiEditInput["operation"],
  details: ReadonlyMap<string, ViewModelTaskDetail>,
): ViewModelTaskDetail {
  switch (operation.kind) {
    case "update_title":
      return parseDetail({ ...detail, title: operation.value });
    case "update_notes":
      return parseDetail({ ...detail, notes: operation.value });
    case "set_status":
      return parseDetail({
        ...detail,
        status: operation.value,
        section_gid: sectionForStatus(operation.value),
      });
    case "complete":
      return parseDetail({
        ...detail,
        status: "completed",
        section_gid: sectionForStatus("completed"),
      });
    case "withdraw":
      return parseDetail({
        ...detail,
        status: "withdrawn",
        section_gid: sectionForStatus("withdrawn"),
      });
    case "restore":
      return parseDetail({
        ...detail,
        status: operation.value,
        section_gid: sectionForStatus(operation.value),
      });
    case "mark_activity": {
      if (detail.ranking.kind !== "ranked") {
        throw new Error("mockの順位情報が不正です。");
      }
      return parseDetail({
        ...detail,
        activity_anchor_on: SYNC_AT.slice(0, 10),
        ranking: {
          ...detail.ranking,
          tie_break: {
            ...detail.ranking.tie_break,
            activity_anchor_on: SYNC_AT.slice(0, 10),
          },
        },
      });
    }
    case "set_importance": {
      if (detail.ranking.kind !== "ranked") {
        throw new Error("mockの順位情報が不正です。");
      }
      return parseDetail({
        ...detail,
        importance: operation.value,
        ranking: {
          ...detail.ranking,
          score_breakdown: {
            ...detail.ranking.score_breakdown,
            importance_points: operation.value * 10,
          },
          tie_break: {
            ...detail.ranking.tie_break,
            importance: operation.value,
          },
        },
      });
    }
    case "set_due": {
      if (detail.ranking.kind !== "ranked") {
        throw new Error("mockの順位情報が不正です。");
      }
      if (operation.value.kind === "due_on") {
        return parseDetail({
          ...detail,
          due: { kind: "on", value: operation.value.due_on },
          ranking: {
            ...detail.ranking,
            tie_break: removeEffectiveDueAt(detail.ranking.tie_break),
          },
        });
      }
      return parseDetail({
        ...detail,
        due: { kind: "at", value: operation.value.due_at },
        ranking: {
          ...detail.ranking,
          tie_break: {
            ...detail.ranking.tie_break,
            effective_due_at: operation.value.due_at,
          },
        },
      });
    }
    case "clear_due": {
      if (detail.ranking.kind !== "ranked") {
        throw new Error("mockの順位情報が不正です。");
      }
      return parseDetail({
        ...detail,
        due: { kind: "none" },
        ranking: {
          ...detail.ranking,
          tie_break: removeEffectiveDueAt(detail.ranking.tie_break),
        },
      });
    }
    case "set_area":
      return parseDetail({ ...detail, area: operation.value });
    case "set_dependencies": {
      const dependencies = operation.value.map((dependency) =>
        dependencyReference(dependency, details));
      return parseDetail({
        ...detail,
        dependencies,
        has_dependencies: dependencies.length > 0,
      });
    }
    case "set_parent":
      if (operation.value.kind === "absent") {
        return parseDetail(removeParent(detail));
      }
      return parseDetail({
        ...detail,
        parent: parentReference(operation.value.gid, details),
      });
    case "set_parent_work_mode":
      return parseDetail({ ...detail, parent_work_mode: operation.value });
    case "link_obsidian": {
      const links = detail.obsidian_links.some((link) =>
        link.vault_id === operation.value.vault_id && link.path === operation.value.path)
        ? detail.obsidian_links.map((link) =>
          link.vault_id === operation.value.vault_id && link.path === operation.value.path
            ? operation.value
            : link)
        : [...detail.obsidian_links, operation.value];
      return parseDetail({ ...detail, obsidian_links: links });
    }
    case "unlink_obsidian":
      return parseDetail({
        ...detail,
        obsidian_links: detail.obsidian_links.filter((link) =>
          link.vault_id !== operation.value.vault_id || link.path !== operation.value.path),
      });
  }
  throw new Error("mockのGUI操作が不正です。");
}

function createSyncResult(mode: "full" | "delta"): IpcSyncResult {
  return ipcSyncResultSchema.parse({
    requested_mode: mode,
    performed_mode: mode,
    synced_at: SYNC_AT,
    application_result: {
      affected_gids: TASK_GIDS,
      operations: [],
    },
    normalization_notifications: [],
    remaining_plan: {
      status_write_task_gids: [],
      external_write_task_gids: [],
      tag_write_task_gids: [],
    },
    critical_errors: [],
    cleanup_items: [],
  });
}

function createProposalView(title: string): IpcAiProposalView {
  return aiWorkflowProposalViewSchema.parse({
    proposal_id: PROPOSAL_ID,
    baseline_snapshot_hash: SNAPSHOT_HASH,
    proposal: {
      title: "サンプルタスクの変更案",
      groups: [{
        group_id: GROUP_ID,
        atomic: false,
        operations: [{
          operation: "update_title",
          operation_id: OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "画面確認用の固定提案です。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{ kind: "user_message", locator: "mock" }],
            target: { kind: "existing", gid: PRIMARY_TASK_GID },
          before: title,
          after: "画面確認用に整理しました",
        }],
      }],
    },
    basic_validation: {
      operations: [{ kind: "valid", group_id: GROUP_ID, operation_id: OPERATION_ID }],
      groups: [{
        group_id: GROUP_ID,
        atomic: false,
        applicable: true,
        operation_ids: [OPERATION_ID],
      }],
    },
    graph_validation: {
      operations: [{ kind: "valid", group_id: GROUP_ID, operation_id: OPERATION_ID }],
      groups: [{
        group_id: GROUP_ID,
        atomic: false,
        applicable: true,
        operation_ids: [OPERATION_ID],
      }],
    },
    selected_operation_ids: [OPERATION_ID],
    impact: {
      impacted_task_count: 1,
      impacted_task_gids: [PRIMARY_TASK_GID],
      rank_changes: [{
        task_gid: PRIMARY_TASK_GID,
        before_state: "ranked",
        before_rank: 1,
        after_state: "ranked",
        after_rank: 1,
      }],
    },
  });
}

function selectedOperationIds(selection: IpcAiSelectionInput["selection"]): string[] {
  switch (selection.kind) {
    case "all":
      return [OPERATION_ID];
    case "groups":
      return selection.group_ids.includes(GROUP_ID) ? [OPERATION_ID] : [];
    case "operations":
      return selection.operation_ids.includes(OPERATION_ID) ? [OPERATION_ID] : [];
  }
}

function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    listener(value);
  }
}

/** 画面確認用の全TaskHub API mockを作成します。 */
export function createMockTaskHubApi(): TaskHubApi {
  const details = createInitialDetails();
  let overview = createOverview(details);
  const setupState: IpcSetupState = ipcSetupStateSchema.parse({
    kind: "ready",
    step: "ready",
    context: {
      device_id: "mock-device",
      client_id: "mock-client",
      workspace_gid: "mock-workspace",
      workspace_name: "画面確認用ワークスペース",
      project_gid: PROJECT_GID,
      project_name: "画面確認用プロジェクト",
      section_gids: {
        not_started: "mock-section-not-started",
        in_progress: "mock-section-in-progress",
        completed: "mock-section-completed",
        withdrawn: "mock-section-withdrawn",
      },
      tag_gids: {
        importance_1: "mock-tag-importance-1",
        importance_2: "mock-tag-importance-2",
        importance_3: "mock-tag-importance-3",
        importance_4: "mock-tag-importance-4",
        importance_5: "mock-tag-importance-5",
        area_unclassified: "mock-tag-area-unclassified",
        block_none: "mock-tag-block-none",
        block_partial: "mock-tag-block-partial",
        block_full: "mock-tag-block-full",
      },
      codex: { kind: "available" },
      test_task_gid: PRIMARY_TASK_GID,
    },
    external_tool: { kind: "skipped" },
  });
  let asanaAuthenticationState: IpcAsanaAuthenticationState =
    ipcAsanaAuthenticationStateSchema.parse({ kind: "idle" });
  let syncState: IpcSyncStateEvent = ipcSyncStateEventSchema.parse({
    kind: "online",
    last_successful_sync_at: SYNC_AT,
  });
  let currentProposal: IpcAiProposalView | undefined;
  const syncListeners = new Set<(value: IpcSyncStateEvent) => void>();
  const aiDeltaListeners = new Set<(value: IpcCodexDelta) => void>();
  const aiStatusListeners = new Set<(value: IpcAiStatus) => void>();
  const aiStatus = ipcAiStatusEventSchema.parse({ kind: "ready", model: "mock-model" });
  const notes: readonly IpcObsidianNoteSummary[] = [{
    relative_path: MOCK_NOTE_PATH,
    title: "集中タスク",
    headings: ["今日の予定", "次の一歩"],
  }];

  function setupResult(): MockResult<IpcSetupState> {
    return ipcSetupStateResponseSchema.parse(ok(setupState));
  }

  function syncResultState(value: IpcSyncStateEvent): void {
    syncState = ipcSyncStateEventSchema.parse(value);
    notify(syncListeners, syncState);
  }

  function runSync(input: { readonly mode: "full" | "delta" }): Promise<MockResult<IpcSyncResult>> {
    return Promise.resolve().then(() => {
      const parsedInput = ipcSyncInputSchema.parse(input);
      syncResultState({
        kind: "syncing",
        requested_mode: parsedInput.mode,
        last_successful_sync_at: SYNC_AT,
      });
      syncResultState({
        kind: "online",
        last_successful_sync_at: SYNC_AT,
      });
      return ipcSyncResponseSchema.parse(ok(createSyncResult(parsedInput.mode)));
    });
  }

  const api: TaskHubApi = {
    app: {
      getVersion: () => Promise.resolve().then(() => ipcAppVersionSchema.parse("0.1.0-mock")),
    },
    asana: {
      getAuthenticationState: () => Promise.resolve().then(() => {
        ipcEmptyRequestSchema.parse(undefined);
        return ipcAsanaAuthenticationStateResponseSchema.parse(ok(asanaAuthenticationState));
      }),
      beginReauthentication: () => Promise.resolve().then(() => {
        ipcAsanaBeginReauthenticationInputSchema.parse(undefined);
        asanaAuthenticationState = ipcAsanaAuthenticationStateSchema.parse({
          kind: "authorization_pending",
          authorization_id: AUTHORIZATION_ID,
          expires_at: AUTHORIZATION_EXPIRES_AT,
        });
        return ipcAsanaAuthenticationStateResponseSchema.parse(ok(asanaAuthenticationState));
      }),
      completeReauthentication: (input: IpcAsanaReauthenticationCompleteInput) =>
        Promise.resolve().then(() => {
          const parsedInput = ipcAsanaCompleteReauthenticationInputSchema.parse(input);
          if (parsedInput.authorization_id !== AUTHORIZATION_ID) {
            return failure("invalid_request", "mockのOAuth認可IDと一致しません。");
          }
          asanaAuthenticationState = ipcAsanaAuthenticationStateSchema.parse({ kind: "idle" });
          return ipcAsanaCompleteReauthenticationResponseSchema.parse(ok(createSyncResult("full")));
        }),
      cancelReauthentication: (input: IpcAsanaReauthenticationCancelInput) =>
        Promise.resolve().then(() => {
          const parsedInput = ipcAsanaCancelReauthenticationInputSchema.parse(input);
          if (parsedInput.authorization_id !== AUTHORIZATION_ID) {
            return failure("invalid_request", "mockのOAuth認可IDと一致しません。");
          }
          asanaAuthenticationState = ipcAsanaAuthenticationStateSchema.parse({ kind: "idle" });
          return ipcAsanaCancelReauthenticationResponseSchema.parse(ok(asanaAuthenticationState));
        }),
    },
    readModel: {
      getOverview: () => Promise.resolve().then(() => {
        ipcReadModelOverviewInputSchema.parse(undefined);
        return ipcReadModelOverviewResponseSchema.parse(ok(overview));
      }),
      getTaskDetail: (taskGid: string) => Promise.resolve().then(() => {
        const parsedInput = ipcReadModelTaskDetailInputSchema.parse({ task_gid: taskGid });
        const detail = details.get(parsedInput.task_gid);
        if (detail == null) {
          return failure("not_found", "指定したタスクがmockにありません。");
        }
        return ipcReadModelTaskDetailResponseSchema.parse(ok(detail));
      }),
    },
    sync: {
      getState: () => Promise.resolve().then(() => {
        ipcSyncGetStateInputSchema.parse(undefined);
        return ipcSyncGetStateResponseSchema.parse(ok(syncState));
      }),
      run: runSync,
      onState: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("同期状態リスナーには関数を指定してください。");
        }
        syncListeners.add(listener);
        return () => {
          syncListeners.delete(listener);
        };
      },
    },
    setup: {
      getState: () => Promise.resolve().then(() => {
        ipcEmptyRequestSchema.parse(undefined);
        return setupResult();
      }),
      start: () => Promise.resolve().then(() => {
        ipcSetupStartInputSchema.parse(undefined);
        return setupResult();
      }),
      completeCodexAuthentication: () => Promise.resolve().then(() => {
        ipcSetupCompleteCodexAuthenticationInputSchema.parse(undefined);
        return setupResult();
      }),
      beginAsanaAuthorization: (input: IpcSetupAsanaAuthorizationBeginInput) =>
        Promise.resolve().then(() => {
        ipcSetupBeginAsanaAuthorizationInputSchema.parse(input);
        return setupResult();
        }),
      completeAsanaAuthorization: (input: IpcSetupAsanaAuthorizationCompleteInput) =>
        Promise.resolve().then(() => {
        ipcSetupCompleteAsanaAuthorizationInputSchema.parse(input);
        return setupResult();
        }),
      cancelAsanaAuthorization: (input: IpcSetupAsanaAuthorizationCancelInput) =>
        Promise.resolve().then(() => {
        ipcSetupCancelAsanaAuthorizationInputSchema.parse(input);
        return setupResult();
        }),
      listWorkspaces: () => Promise.resolve().then(() => {
        ipcSetupListWorkspacesInputSchema.parse(undefined);
        return setupResult();
      }),
      selectWorkspace: (input: IpcSetupWorkspaceSelectionInput) => Promise.resolve().then(() => {
        ipcSetupSelectWorkspaceInputSchema.parse(input);
        return setupResult();
      }),
      selectProject: (input: IpcSetupProjectSelectionInput) => Promise.resolve().then(() => {
        ipcSetupSelectProjectInputSchema.parse(input);
        return setupResult();
      }),
      retryResources: () => Promise.resolve().then(() => {
        ipcSetupRetryResourcesInputSchema.parse(undefined);
        return setupResult();
      }),
      runCapability: () => Promise.resolve().then(() => {
        ipcSetupRunCapabilityInputSchema.parse(undefined);
        return setupResult();
      }),
      chooseVault: (input: IpcSetupVaultChoiceInput) => Promise.resolve().then(() => {
        ipcSetupChooseVaultInputSchema.parse(input);
        return setupResult();
      }),
      chooseExternalTool: (input: IpcSetupExternalToolChoiceInput) =>
        Promise.resolve().then(() => {
        ipcSetupChooseExternalToolInputSchema.parse(input);
        return setupResult();
        }),
      runFullSync: () => Promise.resolve().then(() => {
        ipcSetupRunFullSyncInputSchema.parse(undefined);
        return setupResult();
      }),
      runCodexCapability: () => Promise.resolve().then(() => {
        ipcSetupRunCodexCapabilityInputSchema.parse(undefined);
        return setupResult();
      }),
    },
    gui: {
      apply: (input: IpcGuiEditInput) => Promise.resolve().then(() => {
        const parsedInput = ipcGuiEditInputSchema.parse(input);
        const detail = details.get(parsedInput.task_gid);
        if (detail == null) {
          return failure("not_found", "指定したタスクがmockにありません。");
        }
        const operationId = `mock-${parsedInput.task_gid}-${parsedInput.operation.kind}`;
        if (parsedInput.expected_sync_at !== SYNC_AT) {
          return ipcGuiEditResponseSchema.parse(ok({
            operation_id: operationId,
            task_gid: parsedInput.task_gid,
            outcome: "conflict",
            reason_code: "baseline_changed",
            side_effect: "none",
          }));
        }
        const nextDetail = applyGuiOperation(detail, parsedInput.operation, details);
        details.set(nextDetail.gid, nextDetail);
        overview = createOverview(details);
        return ipcGuiEditResponseSchema.parse(ok({
          operation_id: operationId,
          task_gid: parsedInput.task_gid,
          outcome: "applied",
          reason_code: "applied",
        }));
      }),
    },
    ai: {
      getStatus: () => Promise.resolve().then(() => {
        ipcAiGetStatusInputSchema.parse(undefined);
        return ipcAiGetStatusResponseSchema.parse(ok(aiStatus));
      }),
      startNewSession: () => Promise.resolve().then(() => {
        ipcAiStartNewSessionInputSchema.parse(undefined);
        currentProposal = undefined;
        return ipcAiStartNewSessionResponseSchema.parse(ok(
          { kind: "started" },
        ));
      }),
      startTurn: (input: IpcAiTurnInput) => Promise.resolve().then(() => {
        ipcAiTurnInputSchema.parse(input);
        const detail = details.get(PRIMARY_TASK_GID);
        if (detail == null) {
          throw new Error("mockの提案対象タスクがありません。");
        }
        const delta = ipcAiDeltaEventSchema.parse({
          thread_id: "mock-thread",
          turn_id: "mock-turn",
          item_id: "mock-item",
          delta: "画面確認用の変更案を作成しました。",
        });
        notify(aiDeltaListeners, delta);
        currentProposal = createProposalView(detail.title);
        return ipcAiTurnResponseSchema.parse(ok(
          aiWorkflowTurnResultSchema.parse({
            kind: "proposal",
            message: "画面確認用の固定提案です。",
            questions: [],
            proposal: currentProposal,
            retry_count: 0,
          }),
        ));
      }),
      getProposal: (proposalId: string) => Promise.resolve().then(() => {
        const parsedInput = ipcAiProposalInputSchema.parse({ proposal_id: proposalId });
        if (currentProposal == null || currentProposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        return ipcAiProposalResponseSchema.parse(ok(currentProposal));
      }),
      select: (input: IpcAiSelectionInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiSelectionInputSchema.parse(input);
        if (currentProposal == null || currentProposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        currentProposal = aiWorkflowProposalViewSchema.parse({
          ...currentProposal,
          selected_operation_ids: selectedOperationIds(parsedInput.selection),
        });
        return ipcAiSelectionResponseSchema.parse(ok(currentProposal));
      }),
      editOperation: (input: IpcAiEditInput) => Promise.resolve().then(() => {
        const parsedInput: AiWorkflowOperationEdit = ipcAiEditInputSchema.parse(input);
        if (currentProposal == null || currentProposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        if (typeof parsedInput.after !== "string" || parsedInput.after.trim().length === 0) {
          return failure("invalid_request", "mockではタスク名を文字列で指定してください。");
        }
        let operationFound = false;
        const groups = currentProposal.proposal.groups.map((group) => ({
          ...group,
          operations: group.operations.map((operation) => {
            if (operation.operation_id !== parsedInput.operation_id) {
              return operation;
            }
            operationFound = true;
            if (operation.operation !== "update_title") {
              throw new Error("mockの編集対象操作が不正です。");
            }
            return {
              ...operation,
              after: parsedInput.after,
              evidence_refs: operation.evidence_refs.map((reference, index) =>
                index === 0 ? { ...reference, locator: parsedInput.evidence_locator } : reference),
            };
          }),
        }));
        if (!operationFound) {
          return failure("not_found", "指定したAI操作がmockにありません。");
        }
        currentProposal = aiWorkflowProposalViewSchema.parse({
          ...currentProposal,
          proposal: { ...currentProposal.proposal, groups },
        });
        return ipcAiEditResponseSchema.parse(ok(currentProposal));
      }),
      reject: (proposalId: string) => Promise.resolve().then(() => {
        const parsedInput = ipcAiRejectInputSchema.parse({ proposal_id: proposalId });
        if (currentProposal == null || currentProposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        currentProposal = undefined;
        return ipcAiRejectResponseSchema.parse(ok({ completed: true }));
      }),
      approve: (input: IpcAiApprovalInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiApprovalInputSchema.parse(input);
        if (currentProposal == null || currentProposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        const selectedIds = selectedOperationIds(parsedInput.selection);
        if (selectedIds.length === 0) {
          return failure("invalid_request", "適用するAI操作を1件以上選択してください。");
        }
        const operation = currentProposal.proposal.groups
          .flatMap((group) => group.operations)
          .find((candidate) => candidate.operation_id === selectedIds[0]);
        if (operation == null) {
          throw new Error("mockの承認対象操作が見つかりません。");
        }
        if (operation.operation !== "update_title" || operation.target.kind !== "existing") {
          throw new Error("mockの承認対象操作が不正です。");
        }
        const detail = details.get(operation.target.gid);
        if (detail == null) {
          return failure("not_found", "承認対象タスクがmockにありません。");
        }
        const nextDetail = parseDetail({ ...detail, title: operation.after });
        details.set(nextDetail.gid, nextDetail);
        overview = createOverview(details);
        currentProposal = undefined;
        const result: IpcAiApprovalResult = aiWorkflowApprovalResultSchema.parse({
          proposal_id: parsedInput.proposal_id,
          application: {
            outcome: "applied",
            operations: [{
              group_id: GROUP_ID,
              operation_id: OPERATION_ID,
              task_gid: operation.target.gid,
              outcome: "applied",
              reason_code: "applied",
            }],
            groups: [{
              group_id: GROUP_ID,
              atomic: false,
              outcome: "applied",
              operation_ids: [OPERATION_ID],
            }],
          },
        });
        return ipcAiApprovalResponseSchema.parse(ok(result));
      }),
      onDelta: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("AI差分リスナーには関数を指定してください。");
        }
        aiDeltaListeners.add(listener);
        return () => {
          aiDeltaListeners.delete(listener);
        };
      },
      onStatus: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("AI状態リスナーには関数を指定してください。");
        }
        aiStatusListeners.add(listener);
        notify(aiStatusListeners, aiStatus);
        return () => {
          aiStatusListeners.delete(listener);
        };
      },
    },
    obsidian: {
      listVaults: () => Promise.resolve().then(() => {
        ipcObsidianListVaultsInputSchema.parse(undefined);
        return ipcObsidianListVaultsResponseSchema.parse(ok(
          { vault_ids: [MOCK_VAULT_ID] },
        ));
      }),
      validateVault: (vaultId: string) => Promise.resolve().then(() => {
        const parsedInput = ipcObsidianValidateInputSchema.parse({ vault_id: vaultId });
        if (parsedInput.vault_id !== MOCK_VAULT_ID) {
          return failure("not_found", "指定したVaultがmockにありません。");
        }
        return ipcObsidianValidateResponseSchema.parse(ok(
          { vault_id: parsedInput.vault_id, kind: "valid" },
        ));
      }),
      listNotes: (vaultId: string) => Promise.resolve().then(() => {
        const parsedInput = ipcObsidianListInputSchema.parse({ vault_id: vaultId });
        if (parsedInput.vault_id !== MOCK_VAULT_ID) {
          return failure("not_found", "指定したVaultがmockにありません。");
        }
        return ipcObsidianListResponseSchema.parse(ok(notes));
      }),
      resolvePath: (input: { readonly vault_id: string; readonly relative_path: string }) =>
        Promise.resolve().then(() => {
        const parsedInput = ipcObsidianPathInputSchema.parse(input);
        if (parsedInput.vault_id !== MOCK_VAULT_ID) {
          return failure("not_found", "指定したVaultがmockにありません。");
        }
        const kind = parsedInput.relative_path === MOCK_NOTE_PATH ? "resolved" : "missing";
        return ipcObsidianPathResponseSchema.parse(ok({
          kind,
          vault_id: parsedInput.vault_id,
          relative_path: parsedInput.relative_path,
        }));
        }),
      noteExists: (input: { readonly vault_id: string; readonly relative_path: string }) =>
        Promise.resolve().then(() => {
        const parsedInput = ipcObsidianPathInputSchema.parse(input);
        if (parsedInput.vault_id !== MOCK_VAULT_ID) {
          return failure("not_found", "指定したVaultがmockにありません。");
        }
        const kind = parsedInput.relative_path === MOCK_NOTE_PATH ? "resolved" : "missing";
        return ipcObsidianPathResponseSchema.parse(ok({
          kind,
          vault_id: parsedInput.vault_id,
          relative_path: parsedInput.relative_path,
        }));
        }),
      search: (input: { readonly vault_id: string; readonly query: string }) =>
        Promise.resolve().then(() => {
        const parsedInput = ipcObsidianSearchInputSchema.parse(input);
        if (parsedInput.vault_id !== MOCK_VAULT_ID) {
          return failure("not_found", "指定したVaultがmockにありません。");
        }
        const query = parsedInput.query.toLocaleLowerCase();
        const results: readonly IpcObsidianSearchResult[] = notes
          .filter((note) => [note.title, ...note.headings]
            .some((value) => value.toLocaleLowerCase().includes(query)))
          .map((note) => ({
            ...note,
            excerpt: "画面確認用の関連ノートです。",
          }));
        return ipcObsidianSearchResponseSchema.parse(ok(results));
        }),
      openNote: (input: { readonly vault_id: string; readonly relative_path: string }) =>
        Promise.resolve().then(() => {
        const parsedInput = ipcObsidianOpenNoteInputSchema.parse(input);
        if (parsedInput.vault_id !== MOCK_VAULT_ID || parsedInput.relative_path !== MOCK_NOTE_PATH) {
          return failure("not_found", "指定したmockノートがありません。");
        }
        return ipcObsidianOpenNoteResponseSchema.parse(ok({ completed: true }));
        }),
    },
  };
  return api;
}
