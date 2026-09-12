import type { TaskHubApi } from "../../../shared/task-hub-api";
import {
  ipcAiApprovalInputSchema,
  ipcAiApprovalResponseSchema,
  ipcAiCloseSessionInputSchema,
  ipcAiCloseSessionResponseSchema,
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
  ipcAppStartupResponseSchema,
  ipcAppVersionSchema,
  ipcAsanaAuthenticationStateResponseSchema,
  ipcAsanaAuthenticationStateSchema,
  ipcAsanaBeginReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcAsanaCancelReauthenticationResponseSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcEmptyRequestSchema,
  ipcFailureSchema,
  ipcGuiEditInputSchema,
  ipcGuiEditResponseSchema,
  ipcExternalAgentApproveInputSchema,
  ipcExternalAgentApproveResponseSchema,
  ipcExternalAgentEditInputSchema,
  ipcExternalAgentEditResponseSchema,
  ipcExternalAgentGetStateInputSchema,
  ipcExternalAgentGetStateResponseSchema,
  ipcExternalAgentRejectInputSchema,
  ipcExternalAgentRejectResponseSchema,
  ipcExternalAgentSelectInputSchema,
  ipcExternalAgentSelectResponseSchema,
  ipcExternalAgentSetEnabledInputSchema,
  ipcExternalAgentSetEnabledResponseSchema,
  ipcExternalAgentStateEventSchema,
  ipcObsidianListVaultsInputSchema,
  ipcObsidianListVaultsResponseSchema,
  ipcObsidianListVaultMappingsInputSchema,
  ipcObsidianListVaultMappingsResponseSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianOpenNoteResponseSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianPathResponseSchema,
  ipcObsidianSaveVaultMappingInputSchema,
  ipcObsidianSaveVaultMappingResponseSchema,
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
  type IpcAiProposalInput,
  type IpcAiRejectInput,
  type IpcAiSelectionInput,
  type IpcAiStatus,
  type IpcAiTurnInput,
  type IpcAsanaAuthenticationState,
  type IpcAsanaReauthenticationCancelInput,
  type IpcAsanaReauthenticationCompleteInput,
  type IpcCodexDelta,
  type IpcFailure,
  type IpcGuiEditInput,
  type IpcObsidianVaultMapping,
  type IpcObsidianVaultMappings,
  type IpcExternalAgentGuiApproveInput,
  type IpcExternalAgentGuiEditInput,
  type IpcExternalAgentGuiRejectInput,
  type IpcExternalAgentGuiSelectInput,
  type IpcExternalAgentGuiSetEnabledInput,
  type IpcExternalAgentGuiState,
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
  createExternalReviewEvidenceLocator,
  proposalOperationSchema,
} from "../../../shared/ai";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowTurnResultSchema,
} from "../../../shared/ai-workflow";
import {
  externalAgentGuiStateSchema,
  externalAgentProposalSchema,
} from "../../../shared/external-agent";
import {
  durationSchema,
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
type MockAiSessionState = {
  readonly session_id: string;
  stream: string;
  proposal: IpcAiProposalView | undefined;
};
type RankedTaskRanking = Extract<ViewModelTaskDetail["ranking"], { kind: "ranked" }>;
type RankingTieBreak = RankedTaskRanking["tie_break"];

const PROJECT_GID = "mock-project";
const PRIMARY_TASK_GID = "mock-task-1";
const SYNC_AT = "2026-09-05T00:00:00.000Z";
const ACTIVITY_ANCHOR_ON = "2026-09-01";
const MOCK_VAULT_ID = "mock-vault";
const MOCK_VAULT_PATH = "/mock/taskhub-vault";
const MOCK_NOTE_PATH = "notes/focus.md";
const MOCK_VAULT_MAPPING: IpcObsidianVaultMapping = {
  vault_id: MOCK_VAULT_ID,
  absolute_path: MOCK_VAULT_PATH,
};
const AUTHORIZATION_ID = "a".repeat(43);
const AUTHORIZATION_EXPIRES_AT = "2026-12-31T23:59:59.000Z";
const SNAPSHOT_HASH = "0".repeat(64);
const GROUP_ID = "mock-group";
const OPERATION_ID = "mock-operation";
const COMPLETE_GROUP_ID = "mock-complete-group";
const COMPLETE_OPERATION_ID = "mock-complete-operation";
const SPLIT_GROUP_ID = "mock-split-group";
const SPLIT_OPERATION_ID = "mock-split-operation";
const DURATION_OPERATION_ID = "mock-duration-operation";
const PROPOSAL_ID = "mock-proposal";
const EXTERNAL_GROUP_ID = "mock-external-group";
const EXTERNAL_COMPLETE_GROUP_ID = "mock-external-complete-group";
const EXTERNAL_SPLIT_GROUP_ID = "mock-external-split-group";
const EXTERNAL_TITLE_OPERATION_ID = "mock-external-title-operation";
const EXTERNAL_DURATION_OPERATION_ID = "mock-external-duration-operation";
const EXTERNAL_COMPLETE_OPERATION_ID = "mock-external-complete-operation";
const EXTERNAL_SPLIT_OPERATION_ID = "mock-external-split-operation";
const EXTERNAL_PROPOSAL_ID = "mock-external-proposal";
const EXTERNAL_REQUEST_ID = "mock-external-request";
const EXTERNAL_PROPOSAL_CONTEXT_ID = "mock-external-proposal-context";
const TASK_GIDS = [
  PRIMARY_TASK_GID,
  "mock-task-2",
  "mock-task-3",
  "mock-task-4",
  "mock-task-5",
];
const AI_OPERATION_IDS = [
  OPERATION_ID,
  DURATION_OPERATION_ID,
  COMPLETE_OPERATION_ID,
  SPLIT_OPERATION_ID,
];

function ok<T>(value: T): MockResult<T> {
  return { kind: "ok", value };
}

function failure(code: IpcFailure["code"], message: string): IpcFailure {
  return ipcFailureSchema.parse({ kind: "error", code, message });
}

function advanceSyncAt(previousSyncAt: string): string {
  const previousTimestamp = Date.parse(previousSyncAt);
  if (!Number.isFinite(previousTimestamp)) {
    throw new Error("mockの同期日時が不正です。");
  }
  return new Date(previousTimestamp + 1).toISOString();
}

function advanceEditBaselineHash(previousHash: string): string {
  const suffix = Number.parseInt(previousHash.slice(-8), 16);
  if (!Number.isSafeInteger(suffix)) {
    throw new Error("mockの編集基準ハッシュが不正です。");
  }
  const nextSuffix = ((suffix + 1) >>> 0).toString(16).padStart(8, "0");
  return `${previousHash.slice(0, -8)}${nextSuffix}`;
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
  duration: NonNullable<ViewModelTaskDetail["duration"]>,
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
    edit_baseline_hash: SNAPSHOT_HASH,
    title,
    notes,
    status,
    importance,
    due,
    duration,
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
    { value: 15, unit: "minute" },
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
    { value: 2, unit: "hour" },
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
    { value: 3, unit: "day" },
    "開発",
    "mock-section-completed",
    3,
    [],
  );
  const fourth = createSampleDetail(
    "mock-task-4",
    "期限超過サンプル",
    "同日内の期限超過表示を確認するサンプルタスクです。",
    "in_progress",
    4,
    { kind: "at", value: "2026-09-09T15:00:00.000Z" },
    { value: 1, unit: "hour" },
    "開発",
    "mock-section-in-progress",
    4,
    [],
  );
  const fifth = createSampleDetail(
    "mock-task-5",
    "取り下げ済みサンプル",
    "取り下げ済みタスクの期限と重要度を確認するサンプルです。",
    "withdrawn",
    1,
    { kind: "on", value: "2026-09-01" },
    { value: 1, unit: "day" },
    "運用",
    "mock-section-withdrawn",
    5,
    [],
  );
  return new Map([
    [first.gid, first],
    [second.gid, second],
    [third.gid, third],
    [fourth.gid, fourth],
    [fifth.gid, fifth],
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
    duration: detail.duration,
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

function createOverview(
  details: ReadonlyMap<string, ViewModelTaskDetail>,
  lastSuccessfulSyncAt: string,
  lastFullSyncAt: string,
): ViewModelOverview {
  const tasks = Array.from(details.values(), (detail, index) => createRow(detail, index + 1));
  const areas = Array.from(new Set(Array.from(details.values(), (detail) => detail.area)));
  return viewModelOverviewSchema.parse({
    project_gid: PROJECT_GID,
    last_successful_sync_at: lastSuccessfulSyncAt,
    last_full_sync_at: lastFullSyncAt,
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

function removeDuration(detail: ViewModelTaskDetail): Omit<ViewModelTaskDetail, "duration"> {
  const { duration, ...withoutDuration } = detail;
  void duration;
  return withoutDuration;
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
    case "set_duration":
      return parseDetail({ ...detail, duration: operation.value });
    case "clear_duration":
      return parseDetail(removeDuration(detail));
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

function createSyncResult(mode: "full" | "delta", syncedAt: string): IpcSyncResult {
  return ipcSyncResultSchema.parse({
    requested_mode: mode,
    performed_mode: mode,
    synced_at: syncedAt,
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

function createProposalView(detail: ViewModelTaskDetail): IpcAiProposalView {
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
          evidence_refs: [{
            kind: "user_message",
            locator: "mock-title-request",
            excerpt: "今日の集中タスクのタイトルを整理してください。",
          }],
          target: { kind: "existing", gid: PRIMARY_TASK_GID },
          before: detail.title,
          after: "画面確認用に整理しました",
        }, {
          operation: "set_duration",
          operation_id: DURATION_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "作業内容からAIが推定した所要時間です。",
          basis: "inferred",
          confidence: 0.78,
          evidence_refs: [{ kind: "user_message", locator: "mock" }],
          target: { kind: "existing", gid: PRIMARY_TASK_GID },
          before: detail.duration ?? { kind: "absent" },
          after: { value: 1, unit: "week" },
        }],
      }, {
        group_id: COMPLETE_GROUP_ID,
        atomic: false,
        operations: [{
          operation: "complete",
          operation_id: COMPLETE_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "週次レビューの完了を明示しています。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{
            kind: "user_message",
            locator: "mock-complete-request",
            excerpt: "週次レビューが終わったので、完了にしてください。",
          }],
          target: { kind: "existing", gid: "mock-task-2" },
          before: "not_started",
          after: "completed",
          status_evidence: {
            kind: "user_explicit",
            reference: {
              kind: "user_message",
              locator: "mock-complete-request",
              excerpt: "週次レビューが終わったので、完了にしてください。",
            },
          },
        }],
      }, {
        group_id: SPLIT_GROUP_ID,
        atomic: false,
        operations: [{
          operation: "create_task",
          operation_id: SPLIT_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "集中タスクを調査用の子タスクへ分ける明示依頼です。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{
            kind: "user_message",
            locator: "mock-split-request",
            excerpt: "今日の集中タスクを調査用の子タスクに分けてください。",
          }],
          temporary_ref: "mock-split-child",
          creation: {
            kind: "split_child",
            parent: { kind: "existing", gid: PRIMARY_TASK_GID },
            instruction_reference: {
              kind: "user_message",
              locator: "mock-split-request",
              excerpt: "今日の集中タスクを調査用の子タスクに分けてください。",
            },
          },
          before: { kind: "absent" },
          after: {
            title: "集中タスクの調査",
            notes: "集中タスクを進めるための調査です。",
            status: "not_started",
            importance: 5,
            area: "開発",
            duration: { value: 1, unit: "hour" },
            parent: { kind: "existing", gid: PRIMARY_TASK_GID },
          },
        }],
      }],
    },
    basic_validation: {
      operations: [
        { kind: "valid", group_id: GROUP_ID, operation_id: OPERATION_ID },
        { kind: "valid", group_id: GROUP_ID, operation_id: DURATION_OPERATION_ID },
        { kind: "valid", group_id: COMPLETE_GROUP_ID, operation_id: COMPLETE_OPERATION_ID },
        { kind: "valid", group_id: SPLIT_GROUP_ID, operation_id: SPLIT_OPERATION_ID },
      ],
      groups: [
        {
          group_id: GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [OPERATION_ID, DURATION_OPERATION_ID],
        },
        {
          group_id: COMPLETE_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [COMPLETE_OPERATION_ID],
        },
        {
          group_id: SPLIT_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [SPLIT_OPERATION_ID],
        },
      ],
    },
    graph_validation: {
      operations: [
        { kind: "valid", group_id: GROUP_ID, operation_id: OPERATION_ID },
        { kind: "valid", group_id: GROUP_ID, operation_id: DURATION_OPERATION_ID },
        { kind: "valid", group_id: COMPLETE_GROUP_ID, operation_id: COMPLETE_OPERATION_ID },
        { kind: "valid", group_id: SPLIT_GROUP_ID, operation_id: SPLIT_OPERATION_ID },
      ],
      groups: [
        {
          group_id: GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [OPERATION_ID, DURATION_OPERATION_ID],
        },
        {
          group_id: COMPLETE_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [COMPLETE_OPERATION_ID],
        },
        {
          group_id: SPLIT_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [SPLIT_OPERATION_ID],
        },
      ],
    },
    selected_operation_ids: [OPERATION_ID, DURATION_OPERATION_ID],
    impact: {
      impacted_task_count: 2,
      impacted_task_gids: [PRIMARY_TASK_GID, "mock-task-2"],
      rank_changes: [{
        task_gid: PRIMARY_TASK_GID,
        before_state: "ranked",
        before_rank: 1,
        after_state: "ranked",
        after_rank: 1,
      }, {
        task_gid: "mock-task-2",
        before_state: "ranked",
        before_rank: 2,
        after_state: "excluded",
      }],
    },
  });
}

function createExternalProposal(): IpcExternalAgentGuiState["proposals"][number] {
  const view = aiWorkflowProposalViewSchema.parse({
    proposal_id: EXTERNAL_PROPOSAL_ID,
    baseline_snapshot_hash: SNAPSHOT_HASH,
    proposal: {
      title: "外部エージェントからの複数操作提案",
      groups: [{
        group_id: EXTERNAL_GROUP_ID,
        atomic: false,
        operations: [{
          operation: "update_title",
          operation_id: EXTERNAL_TITLE_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "外部エージェントが既存タスクのタイトル変更を明示しました。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{
            kind: "external_review",
            locator: createExternalReviewEvidenceLocator(
              EXTERNAL_PROPOSAL_CONTEXT_ID,
              EXTERNAL_TITLE_OPERATION_ID,
            ),
            excerpt: "今日の集中タスクのタイトルを整理してください。",
          }],
          target: { kind: "existing", gid: PRIMARY_TASK_GID },
          before: "今日の集中タスク",
          after: "外部確認用に整理したタスク",
        }, {
          operation: "set_duration",
          operation_id: EXTERNAL_DURATION_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "外部エージェントが作業時間の見積もりを明示しました。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{
            kind: "external_review",
            locator: createExternalReviewEvidenceLocator(
              EXTERNAL_PROPOSAL_CONTEXT_ID,
              EXTERNAL_DURATION_OPERATION_ID,
            ),
            excerpt: "集中タスクの作業時間を一週間として見積もってください。",
          }],
          target: { kind: "existing", gid: PRIMARY_TASK_GID },
          before: { value: 15, unit: "minute" },
          after: { value: 1, unit: "week" },
        }],
      }, {
        group_id: EXTERNAL_COMPLETE_GROUP_ID,
        atomic: false,
        operations: [{
          operation: "complete",
          operation_id: EXTERNAL_COMPLETE_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "外部エージェントが週次レビューの完了を明示しました。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{
            kind: "external_review",
            locator: createExternalReviewEvidenceLocator(
              EXTERNAL_PROPOSAL_CONTEXT_ID,
              EXTERNAL_COMPLETE_OPERATION_ID,
            ),
            excerpt: "週次レビューが終わったので完了にしてください。",
          }],
          target: { kind: "existing", gid: "mock-task-2" },
          before: "not_started",
          after: "completed",
          status_evidence: {
            kind: "external_review_explicit",
            reference: {
              kind: "external_review",
              locator: createExternalReviewEvidenceLocator(
                EXTERNAL_PROPOSAL_CONTEXT_ID,
                EXTERNAL_COMPLETE_OPERATION_ID,
              ),
              excerpt: "週次レビューが終わったので完了にしてください。",
            },
          },
        }],
      }, {
        group_id: EXTERNAL_SPLIT_GROUP_ID,
        atomic: false,
        operations: [{
          operation: "create_task",
          operation_id: EXTERNAL_SPLIT_OPERATION_ID,
          baseline_snapshot_hash: SNAPSHOT_HASH,
          reason: "外部エージェントが集中タスクの分割を明示しました。",
          basis: "explicit",
          confidence: 1,
          evidence_refs: [{
            kind: "external_review",
            locator: createExternalReviewEvidenceLocator(
              EXTERNAL_PROPOSAL_CONTEXT_ID,
              EXTERNAL_SPLIT_OPERATION_ID,
            ),
            excerpt: "今日の集中タスクを調査用の子タスクに分けてください。",
          }],
          temporary_ref: "mock-external-split-child",
          creation: {
            kind: "split_child",
            parent: { kind: "existing", gid: PRIMARY_TASK_GID },
            instruction_reference: {
              kind: "external_review",
              locator: createExternalReviewEvidenceLocator(
                EXTERNAL_PROPOSAL_CONTEXT_ID,
                EXTERNAL_SPLIT_OPERATION_ID,
              ),
              excerpt: "今日の集中タスクを調査用の子タスクに分けてください。",
            },
          },
          before: { kind: "absent" },
          after: {
            title: "集中タスクの外部調査",
            notes: "集中タスクを進めるための外部調査です。",
            status: "not_started",
            importance: 5,
            area: "開発",
            duration: { value: 1, unit: "hour" },
            parent: { kind: "existing", gid: PRIMARY_TASK_GID },
          },
        }],
      }],
    },
    basic_validation: {
      operations: [
        { kind: "valid", group_id: EXTERNAL_GROUP_ID, operation_id: EXTERNAL_TITLE_OPERATION_ID },
        { kind: "valid", group_id: EXTERNAL_GROUP_ID, operation_id: EXTERNAL_DURATION_OPERATION_ID },
        { kind: "valid", group_id: EXTERNAL_COMPLETE_GROUP_ID, operation_id: EXTERNAL_COMPLETE_OPERATION_ID },
        { kind: "valid", group_id: EXTERNAL_SPLIT_GROUP_ID, operation_id: EXTERNAL_SPLIT_OPERATION_ID },
      ],
      groups: [
        {
          group_id: EXTERNAL_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [EXTERNAL_TITLE_OPERATION_ID, EXTERNAL_DURATION_OPERATION_ID],
        },
        {
          group_id: EXTERNAL_COMPLETE_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [EXTERNAL_COMPLETE_OPERATION_ID],
        },
        {
          group_id: EXTERNAL_SPLIT_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [EXTERNAL_SPLIT_OPERATION_ID],
        },
      ],
    },
    graph_validation: {
      operations: [
        { kind: "valid", group_id: EXTERNAL_GROUP_ID, operation_id: EXTERNAL_TITLE_OPERATION_ID },
        { kind: "valid", group_id: EXTERNAL_GROUP_ID, operation_id: EXTERNAL_DURATION_OPERATION_ID },
        { kind: "valid", group_id: EXTERNAL_COMPLETE_GROUP_ID, operation_id: EXTERNAL_COMPLETE_OPERATION_ID },
        { kind: "valid", group_id: EXTERNAL_SPLIT_GROUP_ID, operation_id: EXTERNAL_SPLIT_OPERATION_ID },
      ],
      groups: [
        {
          group_id: EXTERNAL_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [EXTERNAL_TITLE_OPERATION_ID, EXTERNAL_DURATION_OPERATION_ID],
        },
        {
          group_id: EXTERNAL_COMPLETE_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [EXTERNAL_COMPLETE_OPERATION_ID],
        },
        {
          group_id: EXTERNAL_SPLIT_GROUP_ID,
          atomic: false,
          applicable: true,
          operation_ids: [EXTERNAL_SPLIT_OPERATION_ID],
        },
      ],
    },
    selected_operation_ids: [
      EXTERNAL_TITLE_OPERATION_ID,
      EXTERNAL_DURATION_OPERATION_ID,
      EXTERNAL_COMPLETE_OPERATION_ID,
      EXTERNAL_SPLIT_OPERATION_ID,
    ],
    impact: {
      impacted_task_count: 2,
      impacted_task_gids: [PRIMARY_TASK_GID, "mock-task-2"],
      rank_changes: [{
        task_gid: PRIMARY_TASK_GID,
        before_state: "ranked",
        before_rank: 1,
        after_state: "ranked",
        after_rank: 1,
      }, {
        task_gid: "mock-task-2",
        before_state: "ranked",
        before_rank: 2,
        after_state: "excluded",
      }],
    },
  });
  return externalAgentProposalSchema.parse({
    proposal_id: EXTERNAL_PROPOSAL_ID,
    proposal_context_id: EXTERNAL_PROPOSAL_CONTEXT_ID,
    operation_ids: [
      EXTERNAL_TITLE_OPERATION_ID,
      EXTERNAL_DURATION_OPERATION_ID,
      EXTERNAL_COMPLETE_OPERATION_ID,
      EXTERNAL_SPLIT_OPERATION_ID,
    ],
    request_id: EXTERNAL_REQUEST_ID,
    instance_id: "mock-external-instance",
    context_id: "mock-external-context",
    revision: 1,
    source: "external_tool",
    state: { kind: "pending_approval" },
    view,
  });
}

function selectedOperationIds(selection: IpcAiSelectionInput["selection"]): string[] {
  switch (selection.kind) {
    case "all":
      return [...AI_OPERATION_IDS];
    case "groups":
      return selection.group_ids.flatMap((groupId) => {
        switch (groupId) {
          case GROUP_ID:
            return [OPERATION_ID, DURATION_OPERATION_ID];
          case COMPLETE_GROUP_ID:
            return [COMPLETE_OPERATION_ID];
          case SPLIT_GROUP_ID:
            return [SPLIT_OPERATION_ID];
          default:
            return [];
        }
      });
    case "operations":
      return selection.operation_ids.filter((operationId) => AI_OPERATION_IDS.includes(operationId));
  }
}

type ExternalProposal = IpcExternalAgentGuiState["proposals"][number];
type ExternalProposalOperation =
  ExternalProposal["view"]["proposal"]["groups"][number]["operations"][number];
type ExternalSelectionResolution =
  | { readonly kind: "ok"; readonly operation_ids: readonly string[] }
  | { readonly kind: "invalid"; readonly message: string };

function externalOperationIds(proposal: ExternalProposal): readonly string[] {
  return proposal.view.proposal.groups.flatMap((group) =>
    group.operations.map((operation) => operation.operation_id));
}

function externalOperationGroupId(proposal: ExternalProposal, operationId: string): string {
  const group = proposal.view.proposal.groups.find((candidate) =>
    candidate.operations.some((operation) => operation.operation_id === operationId));
  if (group == null) {
    throw new Error("外部提案操作のグループがmockにありません。");
  }
  return group.group_id;
}

function externalCreatedTaskGid(operation: ExternalProposalOperation): string {
  if (operation.operation !== "create_task") {
    throw new Error("外部提案の作成操作ではありません。");
  }
  return `mock-external-created-${operation.temporary_ref}`;
}

function externalOperationTaskGid(
  proposal: ExternalProposal,
  operation: ExternalProposalOperation,
): string {
  if (operation.operation === "create_task") {
    return externalCreatedTaskGid(operation);
  }
  const target = operation.target;
  if (target.kind === "existing") {
    return target.gid;
  }
  const createOperation = proposal.view.proposal.groups
    .flatMap((group) => group.operations)
    .find((candidate) =>
      candidate.operation === "create_task"
      && candidate.temporary_ref === target.ref);
  if (createOperation == null) {
    throw new Error("外部提案の一時対象に対応する作成操作がありません。");
  }
  return externalCreatedTaskGid(createOperation);
}

function resolveExternalSelection(
  proposal: ExternalProposal,
  selection: IpcExternalAgentGuiSelectInput["selection"],
): ExternalSelectionResolution {
  const operationIds = externalOperationIds(proposal);
  const operationIdSet = new Set(operationIds);
  const selectedOperationIdSet = new Set<string>();
  if (selection.kind === "all") {
    return { kind: "ok", operation_ids: operationIds };
  }
  if (selection.kind === "groups") {
    const selectedGroupIds = new Set(selection.group_ids);
    for (const groupId of selectedGroupIds) {
      const group = proposal.view.proposal.groups.find((candidate) => candidate.group_id === groupId);
      if (group == null) {
        return { kind: "invalid", message: `指定した外部提案グループ ${groupId} がmockにありません。` };
      }
      group.operations.forEach((operation) => selectedOperationIdSet.add(operation.operation_id));
    }
  } else {
    for (const operationId of selection.operation_ids) {
      if (!operationIdSet.has(operationId)) {
        return { kind: "invalid", message: `指定した外部提案操作 ${operationId} がmockにありません。` };
      }
      const group = proposal.view.proposal.groups.find((candidate) =>
        candidate.operations.some((operation) => operation.operation_id === operationId));
      if (group == null) {
        throw new Error("外部提案操作のグループがmockにありません。");
      }
      if (group.atomic) {
        group.operations.forEach((operation) => selectedOperationIdSet.add(operation.operation_id));
      } else {
        selectedOperationIdSet.add(operationId);
      }
    }
  }
  const selectedOperationIds = operationIds.filter((operationId) =>
    selectedOperationIdSet.has(operationId));
  if (selectedOperationIds.length === 0) {
    return { kind: "invalid", message: "適用する外部提案操作を選択してください。" };
  }
  return { kind: "ok", operation_ids: selectedOperationIds };
}

function notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    listener(value);
  }
}

function findMockAiSession(
  sessions: ReadonlyMap<string, MockAiSessionState>,
  sessionId: string,
): MockAiSessionState | undefined {
  return sessions.get(sessionId);
}

/** 画面確認用の全TaskHub API mockを作成します。 */
export function createMockTaskHubApi(): TaskHubApi {
  const details = createInitialDetails();
  let overview = createOverview(details, SYNC_AT, SYNC_AT);
  let externalAgentState: IpcExternalAgentGuiState = externalAgentGuiStateSchema.parse({
    enabled: false,
    bridge: { kind: "running" },
    registration: {
      command: "taskhub external-agent register --transport windows-pipe",
      allow_execution_command: "taskhub external-agent register --transport windows-pipe --allow-execution",
      instructions: "外部Codexで登録commandを一度実行し、固定ランチャーだけを実行許可へ追加してから外部Codexを再起動してください。",
    },
    proposals: [createExternalProposal()],
  });
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
  let nextAiSessionNumber = 1;
  let operationQueue: Promise<void> = Promise.resolve();
  let obsidianVaultMappings: IpcObsidianVaultMappings = [MOCK_VAULT_MAPPING];
  const aiSessions = new Map<string, MockAiSessionState>();
  const syncListeners = new Set<(value: IpcSyncStateEvent) => void>();
  const aiDeltaListeners = new Set<(value: IpcCodexDelta) => void>();
  const aiStatusListeners = new Set<(value: IpcAiStatus) => void>();
  const externalAgentListeners = new Set<(value: IpcExternalAgentGuiState) => void>();
  const aiStatus = ipcAiStatusEventSchema.parse({ kind: "ready", model: "mock-model" });
  function setupResult(): MockResult<IpcSetupState> {
    return ipcSetupStateResponseSchema.parse(ok(setupState));
  }

  function syncResultState(value: IpcSyncStateEvent): void {
    syncState = ipcSyncStateEventSchema.parse(value);
    notify(syncListeners, syncState);
  }

  function updateExternalAgentState(value: IpcExternalAgentGuiState): IpcExternalAgentGuiState {
    externalAgentState = externalAgentGuiStateSchema.parse(value);
    notify(externalAgentListeners, ipcExternalAgentStateEventSchema.parse(externalAgentState));
    return externalAgentState;
  }

  function findExternalProposal(proposalId: string): IpcExternalAgentGuiState["proposals"][number] | undefined {
    return externalAgentState.proposals.find((proposal) => proposal.proposal_id === proposalId);
  }

  function replaceExternalProposal(
    proposal: IpcExternalAgentGuiState["proposals"][number],
  ): IpcExternalAgentGuiState {
    const replaced = externalAgentState.proposals.map((candidate) =>
      candidate.proposal_id === proposal.proposal_id ? proposal : candidate);
    return updateExternalAgentState({ ...externalAgentState, proposals: replaced });
  }

  function externalAgentEdit(
    input: IpcExternalAgentGuiEditInput,
  ): MockResult<IpcExternalAgentGuiState> {
    const parsedInput = ipcExternalAgentEditInputSchema.parse(input);
    const proposal = findExternalProposal(parsedInput.proposal_id);
    if (proposal == null) {
      return failure("not_found", "指定した外部提案がmockにありません。");
    }
    if (proposal.revision !== parsedInput.revision) {
      return failure("conflict", "外部提案の版がmockの状態と一致しません。");
    }
    if (proposal.state.kind !== "pending_approval") {
      return failure("conflict", "承認待ちの外部提案だけ編集できます。");
    }
    const operations = proposal.view.proposal.groups.flatMap((group) => group.operations);
    const operation = operations.find((candidate) => candidate.operation_id === parsedInput.operation_id);
    if (operation == null) {
      return failure("not_found", "指定した外部提案操作がmockにありません。");
    }
    const editedOperation = proposalOperationSchema.parse({
      ...operation,
      after: parsedInput.after,
      basis: "explicit",
      confidence: 1,
      evidence_refs: [
        ...operation.evidence_refs,
        { kind: "external_review", locator: parsedInput.evidence_locator },
      ],
    });
    const groups = proposal.view.proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map((candidate) => {
        if (candidate.operation_id !== parsedInput.operation_id) {
          return candidate;
        }
        return editedOperation;
      }),
    }));
    const nextProposal = externalAgentProposalSchema.parse({
      ...proposal,
      revision: proposal.revision + 1,
      view: aiWorkflowProposalViewSchema.parse({
        ...proposal.view,
        proposal: { ...proposal.view.proposal, groups },
      }),
    });
    return ipcExternalAgentEditResponseSchema.parse(ok(replaceExternalProposal(nextProposal)));
  }

  function externalAgentSelect(
    input: IpcExternalAgentGuiSelectInput,
  ): MockResult<IpcExternalAgentGuiState> {
    const parsedInput = ipcExternalAgentSelectInputSchema.parse(input);
    const proposal = findExternalProposal(parsedInput.proposal_id);
    if (proposal == null) {
      return failure("not_found", "指定した外部提案がmockにありません。");
    }
    if (proposal.revision !== parsedInput.revision) {
      return failure("conflict", "外部提案の版がmockの状態と一致しません。");
    }
    if (proposal.state.kind !== "pending_approval") {
      return failure("conflict", "承認待ちの外部提案だけ選択を変更できます。");
    }
    const resolvedSelection = resolveExternalSelection(proposal, parsedInput.selection);
    if (resolvedSelection.kind === "invalid") {
      return failure("invalid_request", resolvedSelection.message);
    }
    const nextProposal = externalAgentProposalSchema.parse({
      ...proposal,
      revision: proposal.revision + 1,
      view: aiWorkflowProposalViewSchema.parse({
        ...proposal.view,
        selected_operation_ids: resolvedSelection.operation_ids,
      }),
    });
    return ipcExternalAgentSelectResponseSchema.parse(ok(replaceExternalProposal(nextProposal)));
  }

  function externalAgentApprove(
    input: IpcExternalAgentGuiApproveInput,
  ): MockResult<IpcExternalAgentGuiState> {
    const parsedInput = ipcExternalAgentApproveInputSchema.parse(input);
    const proposal = findExternalProposal(parsedInput.proposal_id);
    if (proposal == null) {
      return failure("not_found", "指定した外部提案がmockにありません。");
    }
    if (proposal.revision !== parsedInput.revision) {
      return failure("conflict", "外部提案の版がmockの状態と一致しません。");
    }
    if (proposal.state.kind !== "pending_approval") {
      return failure("conflict", "承認待ちの外部提案だけ承認できます。");
    }
    const resolvedSelection = resolveExternalSelection(proposal, parsedInput.selection);
    if (resolvedSelection.kind === "invalid") {
      return failure("invalid_request", resolvedSelection.message);
    }
    const selectedOperationIdSet = new Set(resolvedSelection.operation_ids);
    const selectedOperations = proposal.view.proposal.groups.flatMap((group) =>
      group.operations.filter((operation) => selectedOperationIdSet.has(operation.operation_id)));
    const result = aiWorkflowApprovalResultSchema.parse({
      proposal_id: proposal.proposal_id,
      application: {
        outcome: "applied",
        operations: selectedOperations.map((operation) => ({
          group_id: externalOperationGroupId(proposal, operation.operation_id),
          operation_id: operation.operation_id,
          task_gid: externalOperationTaskGid(proposal, operation),
          outcome: "applied",
          reason_code: "applied",
        })),
        groups: proposal.view.proposal.groups
          .map((group) => ({
            group_id: group.group_id,
            atomic: group.atomic,
            outcome: "applied",
            operation_ids: group.operations
              .filter((operation) => selectedOperationIdSet.has(operation.operation_id))
              .map((operation) => operation.operation_id),
          }))
          .filter((group) => group.operation_ids.length > 0),
      },
    });
    const nextProposal = externalAgentProposalSchema.parse({
      ...proposal,
      revision: proposal.revision + 1,
      view: aiWorkflowProposalViewSchema.parse({
        ...proposal.view,
        selected_operation_ids: resolvedSelection.operation_ids,
      }),
      state: { kind: "finished", result },
    });
    return ipcExternalAgentApproveResponseSchema.parse(ok(replaceExternalProposal(nextProposal)));
  }

  function externalAgentReject(
    input: IpcExternalAgentGuiRejectInput,
  ): MockResult<IpcExternalAgentGuiState> {
    const parsedInput = ipcExternalAgentRejectInputSchema.parse(input);
    const proposal = findExternalProposal(parsedInput.proposal_id);
    if (proposal == null) {
      return failure("not_found", "指定した外部提案がmockにありません。");
    }
    if (proposal.revision !== parsedInput.revision) {
      return failure("conflict", "外部提案の版がmockの状態と一致しません。");
    }
    if (proposal.state.kind !== "pending_approval") {
      return failure("conflict", "承認待ちの外部提案だけ却下できます。");
    }
    const nextProposal = externalAgentProposalSchema.parse({
      ...proposal,
      state: { kind: "rejected" },
    });
    return ipcExternalAgentRejectResponseSchema.parse(ok(replaceExternalProposal(nextProposal)));
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function runSync(input: { readonly mode: "full" | "delta" }): Promise<MockResult<IpcSyncResult>> {
    return enqueue(() => Promise.resolve().then(() => {
      const parsedInput = ipcSyncInputSchema.parse(input);
      const previousFullSyncAt = overview.last_full_sync_at;
      if (previousFullSyncAt == null) {
        throw new Error("mockの完全同期日時がありません。");
      }
      const syncedAt = advanceSyncAt(overview.last_successful_sync_at);
      const nextFullSyncAt = parsedInput.mode === "full" ? syncedAt : previousFullSyncAt;
      overview = createOverview(details, syncedAt, nextFullSyncAt);
      syncResultState({
        kind: "syncing",
        requested_mode: parsedInput.mode,
        last_successful_sync_at: syncedAt,
      });
      syncResultState({
        kind: "online",
        last_successful_sync_at: syncedAt,
      });
      return ipcSyncResponseSchema.parse(ok(createSyncResult(parsedInput.mode, syncedAt)));
    }));
  }

  const api: TaskHubApi = {
    app: {
      getVersion: () => Promise.resolve().then(() => ipcAppVersionSchema.parse("0.1.0-mock")),
      waitForStartup: () => Promise.resolve().then(() =>
        ipcAppStartupResponseSchema.parse(ok({ completed: true }))),
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
          return runSync({ mode: "full" });
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
      apply: (input: IpcGuiEditInput) => enqueue(() => Promise.resolve().then(() => {
        const parsedInput = ipcGuiEditInputSchema.parse(input);
        const operationId = `mock-${parsedInput.task_gid}-${parsedInput.operation.kind}`;
        const detail = details.get(parsedInput.task_gid);
        if (detail == null) {
          return ipcGuiEditResponseSchema.parse(ok({
            operation_id: operationId,
            task_gid: parsedInput.task_gid,
            outcome: "rejected",
            reason_code: "task_missing",
          }));
        }
        if (parsedInput.expected_task_hash !== detail.edit_baseline_hash) {
          return ipcGuiEditResponseSchema.parse(ok({
            operation_id: operationId,
            task_gid: parsedInput.task_gid,
            outcome: "rejected",
            reason_code: "baseline_changed",
          }));
        }
        const nextDetail = parseDetail({
          ...applyGuiOperation(detail, parsedInput.operation, details),
          edit_baseline_hash: advanceEditBaselineHash(detail.edit_baseline_hash),
        });
        details.set(nextDetail.gid, nextDetail);
        const currentFullSyncAt = overview.last_full_sync_at;
        if (currentFullSyncAt == null) {
          throw new Error("mockの完全同期日時がありません。");
        }
        overview = createOverview(
          details,
          overview.last_successful_sync_at,
          currentFullSyncAt,
        );
        return ipcGuiEditResponseSchema.parse(ok({
          operation_id: operationId,
          task_gid: parsedInput.task_gid,
          outcome: "applied",
          reason_code: "applied",
        }));
      })),
    },
    externalAgent: {
      getState: () => Promise.resolve().then(() => {
        ipcExternalAgentGetStateInputSchema.parse({});
        return ipcExternalAgentGetStateResponseSchema.parse(ok(externalAgentState));
      }),
      setEnabled: (input: IpcExternalAgentGuiSetEnabledInput) => Promise.resolve().then(() => {
        const parsedInput = ipcExternalAgentSetEnabledInputSchema.parse(input);
        return ipcExternalAgentSetEnabledResponseSchema.parse(ok(
          updateExternalAgentState({ ...externalAgentState, enabled: parsedInput.enabled }),
        ));
      }),
      edit: (input: IpcExternalAgentGuiEditInput) => Promise.resolve().then(() => externalAgentEdit(input)),
      select: (input: IpcExternalAgentGuiSelectInput) => Promise.resolve().then(() => externalAgentSelect(input)),
      approve: (input: IpcExternalAgentGuiApproveInput) => Promise.resolve().then(() => externalAgentApprove(input)),
      reject: (input: IpcExternalAgentGuiRejectInput) => Promise.resolve().then(() => externalAgentReject(input)),
      onChanged: (listener) => {
        if (typeof listener !== "function") {
          throw new TypeError("外部連携状態リスナーには関数を指定してください。");
        }
        externalAgentListeners.add(listener);
        notify(externalAgentListeners, ipcExternalAgentStateEventSchema.parse(externalAgentState));
        return () => {
          externalAgentListeners.delete(listener);
        };
      },
    },
    ai: {
      getStatus: () => Promise.resolve().then(() => {
        ipcAiGetStatusInputSchema.parse(undefined);
        return ipcAiGetStatusResponseSchema.parse(ok(aiStatus));
      }),
      startNewSession: () => Promise.resolve().then(() => {
        ipcAiStartNewSessionInputSchema.parse(undefined);
        const sessionId = `mock-session-${nextAiSessionNumber}`;
        nextAiSessionNumber += 1;
        aiSessions.set(sessionId, {
          session_id: sessionId,
          stream: "",
          proposal: undefined,
        });
        return ipcAiStartNewSessionResponseSchema.parse(ok(
          { kind: "started", session_id: sessionId },
        ));
      }),
      startTurn: (input: IpcAiTurnInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiTurnInputSchema.parse(input);
        const session = findMockAiSession(aiSessions, parsedInput.session_id);
        if (session == null) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        const detail = details.get(PRIMARY_TASK_GID);
        if (detail == null) {
          throw new Error("mockの提案対象タスクがありません。");
        }
        const delta = ipcAiDeltaEventSchema.parse({
          session_id: session.session_id,
          thread_id: "mock-thread",
          turn_id: "mock-turn",
          item_id: "mock-item",
          delta: "画面確認用の変更案を作成しました。",
        });
        session.stream += delta.delta;
        notify(aiDeltaListeners, delta);
        session.proposal = createProposalView(detail);
        return ipcAiTurnResponseSchema.parse(ok(
          aiWorkflowTurnResultSchema.parse({
            kind: "proposal",
            message: "画面確認用の固定提案です。",
            questions: [],
            proposal: session.proposal,
            retry_count: 0,
          }),
        ));
      }),
      getProposal: (input: IpcAiProposalInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiProposalInputSchema.parse(input);
        const session = findMockAiSession(aiSessions, parsedInput.session_id);
        if (session == null) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        if (session.proposal == null || session.proposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        return ipcAiProposalResponseSchema.parse(ok(session.proposal));
      }),
      select: (input: IpcAiSelectionInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiSelectionInputSchema.parse(input);
        const session = findMockAiSession(aiSessions, parsedInput.session_id);
        if (session == null) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        if (session.proposal == null || session.proposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        session.proposal = aiWorkflowProposalViewSchema.parse({
          ...session.proposal,
          selected_operation_ids: selectedOperationIds(parsedInput.selection),
        });
        return ipcAiSelectionResponseSchema.parse(ok(session.proposal));
      }),
      editOperation: (input: IpcAiEditInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiEditInputSchema.parse(input);
        const session = findMockAiSession(aiSessions, parsedInput.session_id);
        if (session == null) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        if (session.proposal == null || session.proposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        let operationFound = false;
        const groups = session.proposal.proposal.groups.map((group) => ({
          ...group,
          operations: group.operations.map((operation) => {
            if (operation.operation_id !== parsedInput.operation_id) {
              return operation;
            }
            operationFound = true;
            const evidenceRefs = operation.evidence_refs.map((reference, index) =>
              index === 0 ? { ...reference, locator: parsedInput.evidence_locator } : reference);
            if (operation.operation === "update_title") {
              if (typeof parsedInput.after !== "string" || parsedInput.after.trim().length === 0) {
                throw new Error("mockではタスク名を文字列で指定してください。");
              }
              return {
                ...operation,
                after: parsedInput.after,
                evidence_refs: evidenceRefs,
              };
            }
            if (operation.operation === "set_duration") {
              const durationResult = durationSchema.safeParse(parsedInput.after);
              if (!durationResult.success) {
                throw new Error("mockでは所要時間を指定してください。");
              }
              return { ...operation, after: durationResult.data, evidence_refs: evidenceRefs };
            }
            throw new Error("mockの編集対象操作が不正です。");
          }),
        }));
        if (!operationFound) {
          return failure("not_found", "指定したAI操作がmockにありません。");
        }
        session.proposal = aiWorkflowProposalViewSchema.parse({
          ...session.proposal,
          proposal: { ...session.proposal.proposal, groups },
        });
        return ipcAiEditResponseSchema.parse(ok(session.proposal));
      }),
      reject: (input: IpcAiRejectInput) => Promise.resolve().then(() => {
        const parsedInput = ipcAiRejectInputSchema.parse(input);
        const session = findMockAiSession(aiSessions, parsedInput.session_id);
        if (session == null) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        if (session.proposal == null || session.proposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        session.proposal = undefined;
        return ipcAiRejectResponseSchema.parse(ok({ completed: true }));
      }),
      approve: (input: IpcAiApprovalInput) => enqueue(() => Promise.resolve().then(() => {
        const parsedInput = ipcAiApprovalInputSchema.parse(input);
        const session = findMockAiSession(aiSessions, parsedInput.session_id);
        if (session == null) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        if (session.proposal == null || session.proposal.proposal_id !== parsedInput.proposal_id) {
          return failure("not_found", "指定したAI変更案がmockにありません。");
        }
        const selectedIds = selectedOperationIds(parsedInput.selection);
        if (selectedIds.length === 0) {
          return failure("invalid_request", "適用するAI操作を1件以上選択してください。");
        }
        const proposalGroups = session.proposal.proposal.groups;
        const selectedOperations = selectedIds.map((operationId) => {
          const group = proposalGroups.find((candidate) =>
            candidate.operations.some((operation) => operation.operation_id === operationId));
          if (group == null) {
            throw new Error("mockの承認対象操作グループが見つかりません。");
          }
          const operation = group.operations.find((candidate) => candidate.operation_id === operationId);
          if (operation == null) {
            throw new Error("mockの承認対象操作が見つかりません。");
          }
          return { group, operation };
        });
        const applicationOperations: Array<{
          readonly group_id: string;
          readonly operation_id: string;
          readonly task_gid: string;
          readonly outcome: "applied";
          readonly reason_code: "applied";
        }> = [];
        const applicationGroups: Array<{
          readonly group_id: string;
          readonly atomic: boolean;
          readonly outcome: "applied";
          readonly operation_ids: string[];
        }> = [];
        for (const selectedOperation of selectedOperations) {
          const { group, operation } = selectedOperation;
          let taskGid: string;
          switch (operation.operation) {
            case "update_title": {
              if (operation.target.kind !== "existing") {
                throw new Error("mockのタイトル変更対象が不正です。");
              }
              const detail = details.get(operation.target.gid);
              if (detail == null) {
                return failure("not_found", "承認対象タスクがmockにありません。");
              }
              const nextDetail = parseDetail({
                ...detail,
                title: operation.after,
                edit_baseline_hash: advanceEditBaselineHash(detail.edit_baseline_hash),
              });
              details.set(nextDetail.gid, nextDetail);
              taskGid = nextDetail.gid;
              break;
            }
            case "set_duration": {
              if (operation.target.kind !== "existing") {
                throw new Error("mockの所要時間変更対象が不正です。");
              }
              const detail = details.get(operation.target.gid);
              if (detail == null) {
                return failure("not_found", "承認対象タスクがmockにありません。");
              }
              const nextDetail = parseDetail({
                ...detail,
                duration: operation.after,
                edit_baseline_hash: advanceEditBaselineHash(detail.edit_baseline_hash),
              });
              details.set(nextDetail.gid, nextDetail);
              taskGid = nextDetail.gid;
              break;
            }
            case "complete": {
              if (operation.target.kind !== "existing") {
                throw new Error("mockの完了対象が不正です。");
              }
              const detail = details.get(operation.target.gid);
              if (detail == null) {
                return failure("not_found", "承認対象タスクがmockにありません。");
              }
              const nextDetail = parseDetail({
                ...detail,
                status: "completed",
                section_gid: sectionForStatus("completed"),
                edit_baseline_hash: advanceEditBaselineHash(detail.edit_baseline_hash),
              });
              details.set(nextDetail.gid, nextDetail);
              taskGid = nextDetail.gid;
              break;
            }
            case "create_task": {
              if (
                operation.creation.kind !== "split_child"
                || operation.creation.parent.kind !== "existing"
              ) {
                throw new Error("mockの作成操作が不正です。");
              }
              const parent = details.get(operation.creation.parent.gid);
              if (parent == null) {
                return failure("not_found", "分割元タスクがmockにありません。");
              }
              const createdGid = `mock-created-${operation.temporary_ref}`;
              if (details.has(createdGid)) {
                throw new Error("mockの分割先タスクが既に存在します。");
              }
              const duration = operation.after.duration;
              if (duration == null) {
                throw new Error("mockの分割子に所要時間がありません。");
              }
              const child = createSampleDetail(
                createdGid,
                operation.after.title,
                operation.after.notes ?? "",
                operation.after.status ?? "not_started",
                operation.after.importance ?? 3,
                { kind: "none" },
                duration,
                operation.after.area ?? parent.area,
                sectionForStatus(operation.after.status ?? "not_started"),
                details.size + 1,
                [],
              );
              details.set(child.gid, parseDetail({
                ...child,
                parent: parentReference(parent.gid, details),
              }));
              taskGid = child.gid;
              break;
            }
            default:
              throw new Error("mockの承認対象操作が不正です。");
          }
          applicationOperations.push({
            group_id: group.group_id,
            operation_id: operation.operation_id,
            task_gid: taskGid,
            outcome: "applied",
            reason_code: "applied",
          });
          const applicationGroup = applicationGroups.find(
            (candidate) => candidate.group_id === group.group_id,
          );
          if (applicationGroup == null) {
            applicationGroups.push({
              group_id: group.group_id,
              atomic: group.atomic,
              outcome: "applied",
              operation_ids: [operation.operation_id],
            });
          } else {
            applicationGroup.operation_ids.push(operation.operation_id);
          }
        }
        const currentFullSyncAt = overview.last_full_sync_at;
        if (currentFullSyncAt == null) {
          throw new Error("mockの完全同期日時がありません。");
        }
        overview = createOverview(
          details,
          overview.last_successful_sync_at,
          currentFullSyncAt,
        );
        session.proposal = undefined;
        const result: IpcAiApprovalResult = aiWorkflowApprovalResultSchema.parse({
          proposal_id: parsedInput.proposal_id,
          application: {
            outcome: "applied",
            operations: applicationOperations,
            groups: applicationGroups,
          },
        });
        return ipcAiApprovalResponseSchema.parse(ok(result));
      })),
      closeSession: (sessionId: string) => Promise.resolve().then(() => {
        const parsedSessionId = ipcAiCloseSessionInputSchema.parse(sessionId);
        if (!aiSessions.delete(parsedSessionId)) {
          return failure("not_found", "指定したAIセッションがmockにありません。");
        }
        return ipcAiCloseSessionResponseSchema.parse(ok({ completed: true }));
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
          { vault_ids: obsidianVaultMappings.map((mapping) => mapping.vault_id) },
        ));
      }),
      listVaultMappings: () => Promise.resolve().then(() => {
        ipcObsidianListVaultMappingsInputSchema.parse(undefined);
        return ipcObsidianListVaultMappingsResponseSchema.parse(ok(
          [...obsidianVaultMappings],
        ));
      }),
      saveVaultMapping: (input: IpcObsidianVaultMapping) => Promise.resolve().then(() => {
        const parsedInput = ipcObsidianSaveVaultMappingInputSchema.parse(input);
        const existing = obsidianVaultMappings.some(
          (mapping) => mapping.vault_id === parsedInput.vault_id,
        );
        obsidianVaultMappings = existing
          ? obsidianVaultMappings.map((mapping) =>
            mapping.vault_id === parsedInput.vault_id ? parsedInput : mapping)
          : [...obsidianVaultMappings, parsedInput];
        return ipcObsidianSaveVaultMappingResponseSchema.parse(ok(
          [...obsidianVaultMappings],
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
