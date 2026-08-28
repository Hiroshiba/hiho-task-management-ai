<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  ipcFailureSchema,
  ipcGuiEditResultSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianSearchInputSchema,
  ipcObsidianValidateInputSchema,
  ipcGuiEditInputSchema,
  ipcSyncStateEventSchema,
  ipcSyncResultSchema,
  type IpcAiStatus,
  type IpcFailure,
  type IpcGuiEditResult,
  type IpcObsidianNoteSummary,
  type IpcObsidianSearchResult,
  type IpcSyncResult,
  type IpcSyncStateEvent,
} from "../../shared/ipc";
import {
  setupStateSchema,
  type SetupCredentialsInput,
  type SetupExternalToolChoiceInput,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowTurnRequestSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
} from "../../shared/ai-workflow";
import {
  viewModelOverviewSchema,
  viewModelTaskDetailSchema,
  type ViewModelOverview,
  type ViewModelTaskDetail,
} from "../../shared/view-model";
import AppHeader from "./AppHeader.vue";
import AiPanel from "./AiPanel.vue";
import SetupWizard from "./SetupWizard.vue";
import TaskDetail from "./TaskDetail.vue";
import TaskFilters from "./TaskFilters.vue";
import TaskList from "./TaskList.vue";
import {
  createErrorScreenState,
  filterTaskRows,
  rendererAiStateSchema,
  rendererCodexStateSchema,
  rendererConnectionStateSchema,
  rendererFailureSchema,
  rendererScreenStateSchema,
  rendererSyncStateSchema,
  type RendererAiState,
  type RendererCodexState,
  type RendererConnectionState,
  type RendererFailure,
  type RendererFilter,
  type RendererGuiEdit,
  type RendererScreenState,
  type RendererSyncState,
} from "./state";

type SetupAction =
  | { readonly kind: "start" }
  | { readonly kind: "complete_codex_authentication" }
  | { readonly kind: "authenticate_asana"; readonly input: SetupCredentialsInput }
  | { readonly kind: "list_workspaces" }
  | { readonly kind: "select_workspace"; readonly input: SetupWorkspaceSelectionInput }
  | { readonly kind: "select_project"; readonly input: SetupProjectSelectionInput }
  | { readonly kind: "retry_resources" }
  | { readonly kind: "run_capability" }
  | { readonly kind: "choose_vault"; readonly input: SetupVaultChoiceInput }
  | { readonly kind: "choose_external_tool"; readonly input: SetupExternalToolChoiceInput }
  | { readonly kind: "run_full_sync" }
  | { readonly kind: "run_codex_capability" };

type SetupResult =
  | { readonly kind: "ok"; readonly value: SetupState }
  | IpcFailure;

type ObsidianLinkStatus = "exists" | "missing" | "unavailable";

type TaskDataRefreshResult =
  | { readonly kind: "applied" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "superseded" }
  | { readonly kind: "failed" };

type ActiveSyncReload =
  | { readonly kind: "idle" }
  | {
      readonly kind: "loading";
      readonly sync_at: string;
      readonly generation: number;
      readonly completion: Promise<TaskDataRefreshResult>;
    };

type TaskDataRefreshRequest = {
  readonly generation: number;
  readonly completion: Promise<TaskDataRefreshResult>;
};

type TaskObsidianLink = ViewModelTaskDetail["obsidian_links"][number];

type PendingAiProposal = {
  readonly message: string;
  readonly proposal: AiWorkflowProposalView;
};

type SyncRuntimeErrorCode = Extract<
  IpcSyncStateEvent,
  { readonly kind: "error" }
>["error_code"];

type SyncNormalizationNotification =
  IpcSyncResult["normalization_notifications"][number];

type NormalizationNotificationDisplayState =
  | { readonly kind: "idle" }
  | { readonly kind: "displayed"; readonly synced_at: string };

type SyncStateReadResult =
  | { readonly kind: "received"; readonly value: IpcSyncStateEvent }
  | { readonly kind: "unavailable" };

type GuiEditCompletion =
  | { readonly kind: "settled"; readonly message: string }
  | { readonly kind: "recovery_required"; readonly message: string };

const screen = ref<RendererScreenState>(rendererScreenStateSchema.parse({ kind: "loading" }));
const setupState = ref<SetupState | undefined>();
const setupBusy = ref(false);
const asanaAuthenticationBusy = ref(false);
const overview = ref<ViewModelOverview | undefined>();
const selectedTask = ref<ViewModelTaskDetail | undefined>();
const selectedTaskGid = ref<string | undefined>();
const filter = ref<RendererFilter>({ kind: "normal" });
const connectionState = ref<RendererConnectionState>(rendererConnectionStateSchema.parse({
  kind: "checking",
  sync: { kind: "waiting" },
}));
const codexState = ref<RendererCodexState>({ kind: "connecting" });
const aiState = ref<RendererAiState>(rendererAiStateSchema.parse({ kind: "idle" }));
const appVersion = ref("取得中");
const currentAsOf = ref(new Date().toISOString());
const feedback = ref("");
const aiBusy = ref(false);
const obsidianNotes = ref<readonly IpcObsidianNoteSummary[]>([]);
const obsidianSearchResults = ref<readonly IpcObsidianSearchResult[]>([]);
const obsidianStatuses = ref<ReadonlyMap<string, ObsidianLinkStatus>>(new Map());
const obsidianBusy = ref(false);
const registeredVaultIds = ref<readonly string[]>([]);
const activeSyncMode = ref<"idle" | "delta" | "full">("idle");
let removeSyncSubscription: (() => void) | undefined;
let removeAiSubscription: (() => void) | undefined;
let removeAiStatusSubscription: (() => void) | undefined;
let clockTimer: number | undefined;
let taskDataGeneration = 0;
let taskDetailGeneration = 0;
let obsidianStatusGeneration = 0;
let guiEditGeneration = 0;
let lastLoadedSuccessfulSyncAt: string | undefined;
let activeSyncReload: ActiveSyncReload = { kind: "idle" };
let normalizationNotificationDisplayState: NormalizationNotificationDisplayState = {
  kind: "idle",
};

const syncState = computed(() => connectionState.value.sync);
const configured = computed(() => setupState.value?.kind === "ready");
const canManualSync = computed(() => configured.value
  && activeSyncMode.value === "idle"
  && !asanaAuthenticationBusy.value
  && connectionState.value.kind === "online"
  && syncState.value.kind !== "syncing"
  && syncState.value.kind !== "authentication_required"
  && syncState.value.kind !== "recovery_pending");
const canWrite = computed(() => connectionState.value.kind === "online"
  && syncState.value.kind === "synced");
const canReadLocal = computed(() => setupState.value?.kind === "ready");
const canReanalyzeObsidianNotes = computed(() => canWrite.value
  && codexState.value.kind === "ready"
  && !aiBusy.value
  && registeredVaultIds.value.length > 0);
const lastSyncAt = computed(() => {
  const currentOverview = overview.value;
  if (currentOverview != null) {
    return currentOverview.last_successful_sync_at;
  }
  if (syncState.value.kind === "synced") {
    return syncState.value.synced_at;
  }
  return undefined;
});
const cleanupCount = computed(() => overview.value?.cleanup_count ?? 0);
const visibleRows = computed(() => {
  const currentOverview = overview.value;
  if (currentOverview == null) {
    return [];
  }
  return filterTaskRows(currentOverview, filter.value, currentAsOf.value);
});

function isFailure(value: unknown): value is IpcFailure {
  const parsed = ipcFailureSchema.safeParse(value);
  if (parsed.success) {
    return true;
  }
  if (typeof value === "object" && value != null && "kind" in value && value.kind === "error") {
    throw new Error("IPC失敗応答の形式が不正です。");
  }
  return false;
}

function failureText(code: RendererFailure["code"]): string {
  switch (code) {
    case "invalid_request":
      return "入力を確認してください。";
    case "invalid_response":
      return "応答を確認できませんでした。";
    case "sender_untrusted":
      return "安全な送信元を確認できませんでした。";
    case "not_configured":
      return "この機能はまだ設定されていません。";
    case "operation_failed":
      return "操作に失敗しました。";
    case "aborted":
      return "操作を中断しました。";
    case "conflict":
      return "最新状態と競合しました。再同期してください。";
    case "not_found":
      return "対象が見つかりません。";
    case "authentication_required":
      return "認証が必要です。";
    case "unavailable":
      return "この機能は現在利用できません。";
  }
}

function displayFailure(value: IpcFailure): RendererFailure {
  return rendererFailureSchema.parse({
    kind: "error",
    code: value.code,
    message: failureText(value.code),
  });
}

function syncFailureStateFromIpc(value: IpcFailure): RendererSyncState {
  if (value.code === "authentication_required") {
    return rendererSyncStateSchema.parse({ kind: "authentication_required" });
  }
  if (value.code === "aborted") {
    return rendererSyncStateSchema.parse({ kind: "error", error_code: "request_aborted" });
  }
  return rendererSyncStateSchema.parse({ kind: "error", error_code: "unexpected_error" });
}

function showFailure(value: IpcFailure): void {
  feedback.value = displayFailure(value).message;
}

function showUnexpectedFailure(): void {
  feedback.value = "予期しないエラーが発生しました。もう一度お試しください。";
}

function writeUnavailableText(operation: "編集" | "AI利用" | "変更案の適用"): string {
  if (connectionState.value.kind === "offline") {
    return `${operation}はオフライン中に利用できません。`;
  }
  if (connectionState.value.kind === "checking") {
    return `${operation}はネットワーク状態の確認後に利用できます。`;
  }
  switch (syncState.value.kind) {
    case "authentication_required":
      return `${operation}はAsana認証を更新するまで利用できません。`;
    case "recovery_pending":
      return `${operation}は復旧が完了するまで利用できません。`;
    case "waiting":
    case "syncing":
      return `${operation}は同期が完了するまで利用できません。`;
    case "error":
      return `${operation}は同期失敗を解消するまで利用できません。`;
    case "synced":
      throw new Error("書き込み可能状態で利用不可メッセージを要求できません。");
  }
}

const normalizationStatusOrder: readonly SyncNormalizationNotification["status"][] = [
  "not_started",
  "in_progress",
  "completed",
  "withdrawn",
];

const normalizationStatusLabels: {
  readonly [status in SyncNormalizationNotification["status"]]: string;
} = {
  not_started: "未着手",
  in_progress: "進行中",
  completed: "完了",
  withdrawn: "取り下げ",
};

function createNormalizationNotificationFeedback(
  notifications: readonly SyncNormalizationNotification[],
): string | undefined {
  if (notifications.length === 0) {
    return undefined;
  }
  if (notifications.length === 1) {
    const notification = notifications.at(0);
    if (notification == null) {
      throw new Error("状態整合化通知を取得できません。");
    }
    return notification.message;
  }
  const summaries: string[] = [];
  for (const status of normalizationStatusOrder) {
    const count = notifications.filter(
      (notification) => notification.status === status,
    ).length;
    if (count > 0) {
      summaries.push(`${normalizationStatusLabels[status]} ${count}件`);
    }
  }
  if (summaries.length === 0) {
    throw new Error("状態整合化通知の内訳を作成できません。");
  }
  return `タスク状態を整合化しました。対象 ${notifications.length}件。${summaries.join("、")}。`;
}

function includeNormalizationNotificationFeedback(
  message: string,
  notifications: readonly SyncNormalizationNotification[],
): string {
  const notificationFeedback = createNormalizationNotificationFeedback(
    notifications,
  );
  if (notificationFeedback == null) {
    return message;
  }
  return `${notificationFeedback} ${message}`;
}

function createSyncFeedback(result: IpcSyncResult): string {
  let appliedCount = 0;
  let alreadyAppliedCount = 0;
  let conflictCount = 0;
  for (const operation of result.application_result.operations) {
    switch (operation.outcome) {
      case "applied":
        appliedCount += 1;
        break;
      case "already_applied":
        alreadyAppliedCount += 1;
        break;
      case "conflict":
        conflictCount += 1;
        break;
    }
  }
  const remainingWriteCount = result.remaining_plan.status_write_task_gids.length
    + result.remaining_plan.external_write_task_gids.length
    + result.remaining_plan.tag_write_task_gids.length;
  const synchronizationSummary = [
    `同期しました。対象 ${result.application_result.affected_gids.length}件`,
    `反映 ${appliedCount}件`,
    `反映済み ${alreadyAppliedCount}件`,
    `競合 ${conflictCount}件`,
    `残り書き込み ${remainingWriteCount}件`,
    `重大エラー ${result.critical_errors.length}件。`,
  ].join("、");
  return includeNormalizationNotificationFeedback(
    synchronizationSummary,
    result.normalization_notifications,
  );
}

function recoveryRequiredFeedback(
  writeOutcome: Extract<IpcGuiEditResult, { readonly outcome: "recovery_required" }>["write_outcome"],
): string {
  switch (writeOutcome) {
    case "applied":
      return "Asanaへの書き込みは反映されました。ローカル状態の再同期が必要です。";
    case "already_applied":
      return "Asanaへの書き込みはすでに反映済みです。ローカル状態の再同期が必要です。";
    case "unknown":
      return "Asanaへの書き込み結果を確認できません。ローカル状態の再同期が必要です。";
  }
}

function guiEditResultFeedback(result: IpcGuiEditResult): string {
  switch (result.outcome) {
    case "applied":
      return "変更を反映しました。";
    case "already_applied":
      return "変更はすでに反映済みです。";
    case "conflict":
      if (result.side_effect === "possible") {
        return "最新状態と競合しました。Asana側へ変更された可能性があります。";
      }
      return "最新状態と競合したため変更しませんでした。";
    case "rejected":
      return "オフラインのため変更できませんでした。";
    case "recovery_required":
      return recoveryRequiredFeedback(result.write_outcome);
  }
}

function cleanupKindLabel(kind: ViewModelOverview["cleanup_items"][number]["kind"]): string {
  switch (kind) {
    case "importance_tag_conflict":
      return "重要度タグの競合";
    case "area_tag_conflict":
      return "領域タグの競合";
    case "unknown_status_section":
      return "不明な状態セクション";
    case "missing_required_section":
      return "必須セクション不足";
    case "dependency_cycle":
      return "依存関係の循環";
    case "missing_dependency":
      return "依存先の欠落";
    case "parent_cycle":
      return "親子関係の循環";
    case "parent_relation_conflict":
      return "親子関係の矛盾";
    case "children_only_completion_confirmation":
      return "子タスク完了確認";
    case "missing_task":
      return "タスクの欠落";
    case "custom_external_data_broken":
      return "外部データ破損";
    case "oauth_app_mismatch":
      return "OAuthアプリ不一致";
    case "proposal_conflict":
      return "変更案の競合";
    case "broken_vault_link":
      return "Vaultリンク破損";
  }
}

function cleanupScopeLabel(item: ViewModelOverview["cleanup_items"][number]): string {
  if (item.scope.scope === "task") {
    return `タスク ${item.scope.task_gid}`;
  }
  return "全体";
}

function cleanupRelatedGids(item: ViewModelOverview["cleanup_items"][number]): string {
  const gids = item.scope.related_task_gids;
  if (gids == null || gids.length === 0) {
    return "";
  }
  return `関連: ${gids.join("、")}`;
}

function setScreenError(value: IpcFailure): void {
  screen.value = createErrorScreenState(value.code, failureText(value.code));
}

function setConnectionState(kind: RendererConnectionState["kind"], sync: RendererSyncState): void {
  connectionState.value = rendererConnectionStateSchema.parse({ kind, sync });
}

function setSyncState(sync: RendererSyncState): void {
  setConnectionState(connectionState.value.kind, sync);
}

function chromiumConnectionState(): RendererConnectionState["kind"] {
  if (window.navigator.onLine) {
    return "online";
  }
  return "offline";
}

function connectionStateForSyncFailure(
  errorCode: SyncRuntimeErrorCode,
): RendererConnectionState["kind"] {
  const current = chromiumConnectionState();
  if (errorCode === "transport_error" && current === "online") {
    return "checking";
  }
  return current;
}

function syncFailureState(errorCode: SyncRuntimeErrorCode): RendererSyncState {
  if (errorCode === "authentication_required") {
    return rendererSyncStateSchema.parse({ kind: "authentication_required" });
  }
  if (errorCode === "events_reset") {
    return rendererSyncStateSchema.parse({ kind: "recovery_pending" });
  }
  return rendererSyncStateSchema.parse({ kind: "error", error_code: errorCode });
}

function settledSyncState(
  value: Extract<IpcSyncStateEvent, { readonly kind: "online" | "offline" }>,
): RendererSyncState {
  if (value.last_error_code != null) {
    return syncFailureState(value.last_error_code);
  }
  if (value.last_successful_sync_at != null) {
    return rendererSyncStateSchema.parse({
      kind: "synced",
      synced_at: value.last_successful_sync_at,
    });
  }
  return rendererSyncStateSchema.parse({ kind: "waiting" });
}

function applySyncStateDisplay(value: IpcSyncStateEvent): void {
  if (value.kind === "syncing") {
    setConnectionState(
      chromiumConnectionState(),
      rendererSyncStateSchema.parse({ kind: "syncing" }),
    );
    return;
  }
  if (value.kind === "offline") {
    const current = chromiumConnectionState();
    if (value.last_error_code != null) {
      setConnectionState(
        connectionStateForSyncFailure(value.last_error_code),
        settledSyncState(value),
      );
      return;
    }
    if (current === "online") {
      setConnectionState("online", rendererSyncStateSchema.parse({ kind: "recovery_pending" }));
      return;
    }
    setConnectionState("offline", settledSyncState(value));
    return;
  }
  if (value.kind === "authentication_required") {
    setConnectionState(
      chromiumConnectionState(),
      rendererSyncStateSchema.parse({ kind: "authentication_required" }),
    );
    return;
  }
  if (value.kind === "error") {
    setConnectionState(
      connectionStateForSyncFailure(value.error_code),
      syncFailureState(value.error_code),
    );
    return;
  }
  if (value.last_error_code != null) {
    setConnectionState(
      connectionStateForSyncFailure(value.last_error_code),
      settledSyncState(value),
    );
    return;
  }
  setConnectionState(chromiumConnectionState(), settledSyncState(value));
}

function showNormalizationNotifications(
  value: Extract<IpcSyncStateEvent, { readonly kind: "online" }>,
): void {
  const notifications = value.normalization_notifications;
  if (notifications == null || notifications.length === 0) {
    return;
  }
  const syncedAt = value.last_successful_sync_at;
  if (syncedAt == null) {
    throw new Error("状態整合化通知に同期日時がありません。");
  }
  if (
    normalizationNotificationDisplayState.kind === "displayed"
    && normalizationNotificationDisplayState.synced_at === syncedAt
  ) {
    return;
  }
  const notificationFeedback = createNormalizationNotificationFeedback(
    notifications,
  );
  if (notificationFeedback == null) {
    throw new Error("状態整合化通知を表示できません。");
  }
  normalizationNotificationDisplayState = {
    kind: "displayed",
    synced_at: syncedAt,
  };
  feedback.value = notificationFeedback;
}

function handleSyncState(value: IpcSyncStateEvent): void {
  if (value.last_successful_sync_at != null && configured.value) {
    void reloadTaskDataAfterSuccessfulSync(value.last_successful_sync_at);
  }
  applySyncStateDisplay(value);
  if (value.kind === "online") {
    showNormalizationNotifications(value);
  }
}

async function readCurrentSyncState(): Promise<SyncStateReadResult> {
  try {
    const result = await window.taskHub.sync.getState();
    if (isFailure(result)) {
      return { kind: "unavailable" };
    }
    return {
      kind: "received",
      value: ipcSyncStateEventSchema.parse(result.value),
    };
  } catch {
    return { kind: "unavailable" };
  }
}

async function reconcileSyncStateAfterFailure(fallback: RendererSyncState): Promise<void> {
  setSyncState(fallback);
  const result = await readCurrentSyncState();
  if (result.kind === "received") {
    handleSyncState(result.value);
  }
}

function setCodexFromSetup(state: SetupState): void {
  if (state.kind === "codex_authentication_required") {
    codexState.value = { kind: "authentication_required" };
    return;
  }
  if ("codex" in state && state.codex.kind === "unavailable") {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      reason_code: state.codex.reason_code,
    });
    return;
  }
  if ("context" in state && state.context.codex.kind === "unavailable") {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      reason_code: state.context.codex.reason_code,
    });
  }
}

function handleCodexStatus(value: IpcAiStatus): void {
  if (value.kind === "ready") {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "ready",
      version: value.codex_version,
    });
    return;
  }
  if (value.kind === "authentication_required") {
    codexState.value = rendererCodexStateSchema.parse({ kind: "authentication_required" });
    return;
  }
  if (value.kind === "starting") {
    codexState.value = rendererCodexStateSchema.parse({ kind: "connecting" });
    return;
  }
  codexState.value = rendererCodexStateSchema.parse({
    kind: "unavailable",
    reason_code: value.reason_code,
  });
}

function clearTaskSelection(): void {
  taskDetailGeneration += 1;
  obsidianStatusGeneration += 1;
  selectedTaskGid.value = undefined;
  selectedTask.value = undefined;
  obsidianStatuses.value = new Map();
}

function commitOverview(value: ViewModelOverview): void {
  overview.value = value;
  lastLoadedSuccessfulSyncAt = value.last_successful_sync_at;
}

async function collectObsidianStatuses(
  links: readonly TaskObsidianLink[],
  vaultIds: readonly string[],
): Promise<ReadonlyMap<string, ObsidianLinkStatus>> {
  const statuses = new Map<string, ObsidianLinkStatus>();
  for (const link of links) {
    const key = `${link.vault_id}\0${link.path}`;
    if (!vaultIds.includes(link.vault_id)) {
      statuses.set(key, "unavailable");
      continue;
    }
    try {
      const input = ipcObsidianPathInputSchema.parse({
        vault_id: link.vault_id,
        relative_path: link.path,
      });
      const result = await window.taskHub.obsidian.noteExists(input);
      if (isFailure(result)) {
        statuses.set(key, "unavailable");
        continue;
      }
      statuses.set(key, result.value.kind === "resolved" ? "exists" : "missing");
    } catch {
      statuses.set(key, "unavailable");
    }
  }
  return statuses;
}

async function executeTaskDataRefresh(
  generation: number,
  detailGeneration: number,
  statusGeneration: number,
  taskGid: string | undefined,
): Promise<TaskDataRefreshResult> {
  try {
    const result = await window.taskHub.readModel.getOverview();
    if (isFailure(result)) {
      if (generation === taskDataGeneration) {
        showFailure(result);
      }
      return { kind: "failed" };
    }
    const nextOverview = viewModelOverviewSchema.parse(result.value);
    if (taskGid == null) {
      if (generation !== taskDataGeneration) {
        return { kind: "superseded" };
      }
      commitOverview(nextOverview);
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value == null) {
        selectedTask.value = undefined;
        if (statusGeneration === obsidianStatusGeneration) {
          obsidianStatuses.value = new Map();
        }
      }
      return { kind: "applied" };
    }
    if (!nextOverview.tasks.some((task) => task.gid === taskGid)) {
      if (generation !== taskDataGeneration) {
        return { kind: "superseded" };
      }
      commitOverview(nextOverview);
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        clearTaskSelection();
      }
      return { kind: "applied" };
    }
    const detailResult = await window.taskHub.readModel.getTaskDetail(taskGid);
    if (isFailure(detailResult)) {
      if (detailResult.code === "not_found") {
        if (generation !== taskDataGeneration) {
          return { kind: "superseded" };
        }
        commitOverview(nextOverview);
        if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
          clearTaskSelection();
        }
        return { kind: "applied" };
      }
      if (generation === taskDataGeneration) {
        showFailure(detailResult);
      }
      return { kind: "failed" };
    }
    const nextTask = viewModelTaskDetailSchema.parse(detailResult.value);
    const nextStatuses = await collectObsidianStatuses(nextTask.obsidian_links, registeredVaultIds.value);
    if (generation !== taskDataGeneration) {
      return { kind: "superseded" };
    }
    commitOverview(nextOverview);
    if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
      selectedTask.value = nextTask;
      if (statusGeneration === obsidianStatusGeneration) {
        obsidianStatuses.value = nextStatuses;
      }
    }
    return { kind: "applied" };
  } catch {
    if (generation === taskDataGeneration) {
      showUnexpectedFailure();
    }
    return { kind: "failed" };
  }
}

function startTaskDataRefresh(): TaskDataRefreshRequest {
  taskDataGeneration += 1;
  taskDetailGeneration += 1;
  obsidianStatusGeneration += 1;
  const generation = taskDataGeneration;
  return {
    generation,
    completion: executeTaskDataRefresh(
      generation,
      taskDetailGeneration,
      obsidianStatusGeneration,
      selectedTaskGid.value,
    ),
  };
}

async function reloadTaskData(): Promise<TaskDataRefreshResult> {
  return startTaskDataRefresh().completion;
}

function syncTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("同期日時を比較できません。");
  }
  return timestamp;
}

function loadedAtOrAfter(syncAt: string): boolean {
  if (lastLoadedSuccessfulSyncAt == null) {
    return false;
  }
  return syncTimestamp(lastLoadedSuccessfulSyncAt) >= syncTimestamp(syncAt);
}

async function finalizeSyncReload(generation: number, completion: Promise<TaskDataRefreshResult>): Promise<void> {
  try {
    await completion;
  } catch {
    if (activeSyncReload.kind === "loading" && activeSyncReload.generation === generation) {
      showUnexpectedFailure();
    }
  } finally {
    if (activeSyncReload.kind === "loading" && activeSyncReload.generation === generation) {
      activeSyncReload = { kind: "idle" };
    }
  }
}

function reloadTaskDataAfterSuccessfulSync(syncAt: string): Promise<TaskDataRefreshResult> {
  if (loadedAtOrAfter(syncAt)) {
    return Promise.resolve({ kind: "unchanged" });
  }
  if (activeSyncReload.kind === "loading"
    && syncTimestamp(activeSyncReload.sync_at) >= syncTimestamp(syncAt)) {
    return activeSyncReload.completion;
  }
  const request = startTaskDataRefresh();
  activeSyncReload = {
    kind: "loading",
    sync_at: syncAt,
    generation: request.generation,
    completion: request.completion,
  };
  void finalizeSyncReload(request.generation, request.completion);
  return request.completion;
}

function applySetupState(value: unknown): void {
  const parsed = setupStateSchema.parse(value);
  setupState.value = parsed;
  setCodexFromSetup(parsed);
  if (parsed.kind === "ready") {
    screen.value = rendererScreenStateSchema.parse({ kind: "dashboard" });
    void reloadTaskData();
    return;
  }
  screen.value = rendererScreenStateSchema.parse({ kind: "setup", setup: parsed });
}

async function runSetupRequest(request: Promise<SetupResult>): Promise<void> {
  setupBusy.value = true;
  feedback.value = "";
  try {
    const result = await request;
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    applySetupState(result.value);
  } catch {
    showUnexpectedFailure();
  } finally {
    setupBusy.value = false;
  }
}

async function completeCodexAuthenticationFromHeader(): Promise<void> {
  if (setupBusy.value) {
    return;
  }
  const keepDashboard = screen.value.kind === "dashboard";
  setupBusy.value = true;
  feedback.value = "";
  try {
    const result = await window.taskHub.setup.completeCodexAuthentication();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    const state = setupStateSchema.parse(result.value);
    if (keepDashboard && state.kind !== "ready") {
      throw new Error("設定済み状態のCodex認証結果が不正です。");
    }
    applySetupState(state);
    if (keepDashboard) {
      await loadInitialCodexStatus();
    }
  } catch {
    showUnexpectedFailure();
  } finally {
    setupBusy.value = false;
  }
}

async function reauthenticateAsana(): Promise<void> {
  if (asanaAuthenticationBusy.value
    || !configured.value
    || syncState.value.kind !== "authentication_required") {
    return;
  }
  asanaAuthenticationBusy.value = true;
  feedback.value = "";
  const authenticationRequired = rendererSyncStateSchema.parse({
    kind: "authentication_required",
  });
  try {
    const result = await window.taskHub.asana.reauthenticateOAuth();
    if (isFailure(result)) {
      await reconcileSyncStateAfterFailure(authenticationRequired);
      feedback.value = "Asanaの再認証に失敗しました。保存済みのタスクを表示しています。";
      return;
    }
    const synchronized = ipcSyncResultSchema.parse(result.value);
    setConnectionState("online", rendererSyncStateSchema.parse({
      kind: "synced",
      synced_at: synchronized.synced_at,
    }));
    const refreshResult = await reloadTaskDataAfterSuccessfulSync(synchronized.synced_at);
    if (refreshResult.kind === "failed") {
      feedback.value = includeNormalizationNotificationFeedback(
        "Asanaの再認証と同期は完了しました。タスク表示を更新できませんでした。",
        synchronized.normalization_notifications,
      );
      return;
    }
    feedback.value = includeNormalizationNotificationFeedback(
      "Asanaを再認証し、タスク表示を更新しました。",
      synchronized.normalization_notifications,
    );
  } catch {
    await reconcileSyncStateAfterFailure(authenticationRequired);
    feedback.value = "Asanaの再認証に失敗しました。保存済みのタスクを表示しています。";
  } finally {
    asanaAuthenticationBusy.value = false;
  }
}

function handleSetupAction(action: SetupAction): void {
  switch (action.kind) {
    case "start":
      void runSetupRequest(window.taskHub.setup.start());
      return;
    case "complete_codex_authentication":
      void runSetupRequest(window.taskHub.setup.completeCodexAuthentication());
      return;
    case "authenticate_asana":
      void runSetupRequest(window.taskHub.setup.authenticateAsana(action.input));
      return;
    case "list_workspaces":
      void runSetupRequest(window.taskHub.setup.listWorkspaces());
      return;
    case "select_workspace":
      void runSetupRequest(window.taskHub.setup.selectWorkspace(action.input));
      return;
    case "select_project":
      void runSetupRequest(window.taskHub.setup.selectProject(action.input));
      return;
    case "retry_resources":
      void runSetupRequest(window.taskHub.setup.retryResources());
      return;
    case "run_capability":
      void runSetupRequest(window.taskHub.setup.runCapability());
      return;
    case "choose_vault":
      void runSetupRequest(window.taskHub.setup.chooseVault(action.input));
      return;
    case "choose_external_tool":
      void runSetupRequest(window.taskHub.setup.chooseExternalTool(action.input));
      return;
    case "run_full_sync":
      void runSetupRequest(window.taskHub.setup.runFullSync());
      return;
    case "run_codex_capability":
      void runSetupRequest(window.taskHub.setup.runCodexCapability());
      return;
  }
}

async function runSynchronization(mode: "delta" | "full"): Promise<void> {
  if (!canManualSync.value) {
    return;
  }
  activeSyncMode.value = mode;
  setSyncState(rendererSyncStateSchema.parse({ kind: "syncing" }));
  try {
    const result = await window.taskHub.sync.run({ mode });
    if (isFailure(result)) {
      showFailure(result);
      await reconcileSyncStateAfterFailure(syncFailureStateFromIpc(result));
      return;
    }
    setConnectionState(chromiumConnectionState(), rendererSyncStateSchema.parse({
      kind: "synced",
      synced_at: result.value.synced_at,
    }));
    const syncFeedback = createSyncFeedback(result.value);
    const refreshResult = await reloadTaskDataAfterSuccessfulSync(result.value.synced_at);
    if (refreshResult.kind === "applied" || refreshResult.kind === "unchanged") {
      feedback.value = syncFeedback;
    }
  } catch {
    showUnexpectedFailure();
    await reconcileSyncStateAfterFailure(rendererSyncStateSchema.parse({
      kind: "error",
      error_code: "unexpected_error",
    }));
  } finally {
    activeSyncMode.value = "idle";
  }
}

async function manualSync(): Promise<void> {
  await runSynchronization("delta");
}

async function fullSync(): Promise<void> {
  await runSynchronization("full");
}

async function selectTask(taskGid: string): Promise<void> {
  taskDetailGeneration += 1;
  obsidianStatusGeneration += 1;
  const detailGeneration = taskDetailGeneration;
  const statusGeneration = obsidianStatusGeneration;
  selectedTaskGid.value = taskGid;
  selectedTask.value = undefined;
  obsidianStatuses.value = new Map();
  try {
    const result = await window.taskHub.readModel.getTaskDetail(taskGid);
    if (isFailure(result)) {
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        showFailure(result);
        if (result.code === "not_found") {
          clearTaskSelection();
        }
      }
      return;
    }
    const nextTask = viewModelTaskDetailSchema.parse(result.value);
    const nextStatuses = await collectObsidianStatuses(nextTask.obsidian_links, registeredVaultIds.value);
    if (detailGeneration !== taskDetailGeneration || selectedTaskGid.value !== taskGid) {
      return;
    }
    selectedTask.value = nextTask;
    if (statusGeneration === obsidianStatusGeneration) {
      obsidianStatuses.value = nextStatuses;
    }
  } catch {
    if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
      showUnexpectedFailure();
    }
  }
}

async function checkObsidianLinks(links: readonly ViewModelTaskDetail["obsidian_links"][number][]): Promise<void> {
  obsidianStatusGeneration += 1;
  const generation = obsidianStatusGeneration;
  const statuses = await collectObsidianStatuses(links, registeredVaultIds.value);
  if (generation === obsidianStatusGeneration) {
    obsidianStatuses.value = statuses;
  }
}

async function loadObsidianVaults(): Promise<void> {
  try {
    const result = await window.taskHub.obsidian.listVaults();
    if (isFailure(result)) {
      showFailure(result);
      registeredVaultIds.value = [];
      if (selectedTask.value != null) {
        await checkObsidianLinks(selectedTask.value.obsidian_links);
      }
      return;
    }
    registeredVaultIds.value = result.value.vault_ids;
    if (selectedTask.value != null) {
      await checkObsidianLinks(selectedTask.value.obsidian_links);
    }
  } catch {
    showUnexpectedFailure();
    registeredVaultIds.value = [];
    if (selectedTask.value != null) {
      await checkObsidianLinks(selectedTask.value.obsidian_links);
    }
  }
}

async function listObsidian(vaultId: string): Promise<void> {
  const trimmedVaultId = vaultId.trim();
  if (!registeredVaultIds.value.includes(trimmedVaultId)) {
    feedback.value = "登録済みのVaultだけを指定してください。";
    return;
  }
  obsidianBusy.value = true;
  try {
    const input = ipcObsidianValidateInputSchema.parse({ vault_id: trimmedVaultId });
    const result = await window.taskHub.obsidian.listNotes(input.vault_id);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    obsidianNotes.value = result.value;
    obsidianSearchResults.value = [];
  } catch {
    showUnexpectedFailure();
  } finally {
    obsidianBusy.value = false;
  }
}

async function searchObsidian(input: { readonly vaultId: string; readonly query: string }): Promise<void> {
  const trimmedVaultId = input.vaultId.trim();
  if (!registeredVaultIds.value.includes(trimmedVaultId)) {
    feedback.value = "登録済みのVaultだけを指定してください。";
    return;
  }
  obsidianBusy.value = true;
  try {
    const validated = ipcObsidianSearchInputSchema.parse({
      vault_id: trimmedVaultId,
      query: input.query,
    });
    const result = await window.taskHub.obsidian.search(validated);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    obsidianSearchResults.value = result.value;
    obsidianNotes.value = [];
  } catch {
    showUnexpectedFailure();
  } finally {
    obsidianBusy.value = false;
  }
}

async function checkObsidianLink(link: ViewModelTaskDetail["obsidian_links"][number]): Promise<void> {
  const generation = obsidianStatusGeneration;
  if (!registeredVaultIds.value.includes(link.vault_id)) {
    if (generation !== obsidianStatusGeneration) {
      return;
    }
    const statuses = new Map(obsidianStatuses.value);
    statuses.set(`${link.vault_id}\0${link.path}`, "unavailable");
    obsidianStatuses.value = statuses;
    return;
  }
  try {
    const input = ipcObsidianPathInputSchema.parse({ vault_id: link.vault_id, relative_path: link.path });
    const result = await window.taskHub.obsidian.noteExists(input);
    if (generation !== obsidianStatusGeneration) {
      return;
    }
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    const statuses = new Map(obsidianStatuses.value);
    statuses.set(`${link.vault_id}\0${link.path}`, result.value.kind === "resolved" ? "exists" : "missing");
    obsidianStatuses.value = statuses;
  } catch {
    if (generation === obsidianStatusGeneration) {
      showUnexpectedFailure();
    }
  }
}

async function openObsidianLink(link: ViewModelTaskDetail["obsidian_links"][number]): Promise<void> {
  if (!registeredVaultIds.value.includes(link.vault_id)) {
    feedback.value = "このVaultは登録されていません。";
    return;
  }
  try {
    const input = ipcObsidianOpenNoteInputSchema.parse({ vault_id: link.vault_id, relative_path: link.path });
    const result = await window.taskHub.obsidian.openNote(input);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    feedback.value = "Obsidianでノートを開きました。";
  } catch {
    showUnexpectedFailure();
  }
}

async function reloadTaskDataAfterGuiEdit(message: string, generation: number): Promise<void> {
  if (generation === guiEditGeneration) {
    feedback.value = message;
  }
  try {
    await reloadTaskData();
  } finally {
    if (generation === guiEditGeneration) {
      feedback.value = message;
    }
  }
}

async function reconcileSyncStateAfterGuiRecovery(
  message: string,
  generation: number,
): Promise<void> {
  try {
    const result = await readCurrentSyncState();
    if (result.kind === "received") {
      applySyncStateDisplay(result.value);
    }
  } finally {
    if (generation === guiEditGeneration) {
      feedback.value = message;
    }
  }
}

async function applyGuiEdit(input: RendererGuiEdit): Promise<void> {
  const currentOverview = overview.value;
  if (currentOverview == null) {
    feedback.value = "タスク状態を読み込むまで編集できません。";
    return;
  }
  if (!canWrite.value) {
    feedback.value = writeUnavailableText("編集");
    return;
  }
  guiEditGeneration += 1;
  const generation = guiEditGeneration;
  let completion: GuiEditCompletion;
  try {
    const validatedInput = ipcGuiEditInputSchema.parse({
      task_gid: input.task_gid,
      expected_sync_at: currentOverview.last_successful_sync_at,
      operation: input.operation,
    });
    const result = await window.taskHub.gui.apply(validatedInput);
    if (isFailure(result)) {
      completion = {
        kind: "settled",
        message: displayFailure(result).message,
      };
    } else {
      const validatedResult = ipcGuiEditResultSchema.parse(result.value);
      completion = {
        kind: validatedResult.outcome === "recovery_required"
          ? "recovery_required"
          : "settled",
        message: guiEditResultFeedback(validatedResult),
      };
    }
  } catch {
    completion = {
      kind: "settled",
      message: "予期しないエラーが発生しました。もう一度お試しください。",
    };
  }
  if (completion.kind === "recovery_required") {
    try {
      await reloadTaskDataAfterGuiEdit(completion.message, generation);
    } finally {
      await reconcileSyncStateAfterGuiRecovery(completion.message, generation);
    }
    return;
  }
  await reloadTaskDataAfterGuiEdit(completion.message, generation);
}

async function startAiSession(): Promise<void> {
  if (aiBusy.value) {
    return;
  }
  const pendingProposal = pendingAiProposal(aiState.value);
  aiBusy.value = true;
  try {
    const result = await window.taskHub.ai.startNewSession();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    aiState.value = rendererAiStateSchema.parse({
      kind: "idle",
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    });
    feedback.value = "新しいAIセッションを開始しました。";
  } catch {
    showUnexpectedFailure();
  } finally {
    aiBusy.value = false;
  }
}

function pendingAiProposal(state: RendererAiState): PendingAiProposal | undefined {
  switch (state.kind) {
    case "proposal":
      return { message: state.message, proposal: state.proposal };
    case "idle":
    case "streaming":
    case "questions":
    case "unavailable":
      return state.pending_proposal;
    case "applied":
      return undefined;
  }
}

function appendDelta(delta: { readonly delta: string }): void {
  if (aiState.value.kind !== "streaming") {
    return;
  }
  try {
    aiState.value = rendererAiStateSchema.parse({
      kind: "streaming",
      text: `${aiState.value.text}${delta.delta}`,
      ...(aiState.value.pending_proposal == null
        ? {}
        : { pending_proposal: aiState.value.pending_proposal }),
    });
  } catch {
    const pendingProposal = pendingAiProposal(aiState.value);
    aiState.value = rendererAiStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "invalid_response",
        message: failureText("invalid_response"),
      }),
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    });
  }
}

async function startAiTurn(input: AiWorkflowTurnRequest): Promise<void> {
  if (aiBusy.value) {
    return;
  }
  if (!canWrite.value) {
    feedback.value = writeUnavailableText("AI利用");
    return;
  }
  const pendingProposal = pendingAiProposal(aiState.value);
  aiBusy.value = true;
  try {
    const request = aiWorkflowTurnRequestSchema.parse(input);
    aiState.value = rendererAiStateSchema.parse({
      kind: "streaming",
      text: "",
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    });
    const result = await window.taskHub.ai.startTurn(request);
    if (isFailure(result)) {
      showFailure(result);
      aiState.value = rendererAiStateSchema.parse({
        kind: "unavailable",
        failure: displayFailure(result),
        ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
      });
      return;
    }
    if (result.value.kind === "proposal") {
      const proposal = aiWorkflowProposalViewSchema.parse(result.value.proposal);
      aiState.value = rendererAiStateSchema.parse({
        kind: "proposal",
        message: result.value.message,
        questions: result.value.questions,
        proposal,
      });
      return;
    }
    aiState.value = rendererAiStateSchema.parse({
      kind: "questions",
      message: result.value.message,
      questions: result.value.questions,
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    });
  } catch {
    aiState.value = rendererAiStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "invalid_response",
        message: failureText("invalid_response"),
      }),
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    });
  } finally {
    aiBusy.value = false;
  }
}

async function reanalyzeObsidianNotes(taskGid: string): Promise<void> {
  if (!canReanalyzeObsidianNotes.value) {
    feedback.value = "関連ノートの再解析は現在利用できません。";
    return;
  }
  const request = aiWorkflowTurnRequestSchema.parse({
    message: `タスクGID ${taskGid} について、登録済みVaultを検索して関連ノートを再解析してください。明確に関連すると判断できる候補だけを、Obsidianリンクの追加または修正の変更案として提示してください。変更を自動適用せず、必ず承認待ちの変更案にしてください。`,
    explicit_split_request_locators: [],
  });
  await startAiTurn(request);
}

function proposalState(proposal: AiWorkflowProposalView): void {
  const currentState = aiState.value;
  if (currentState.kind === "proposal") {
    aiState.value = rendererAiStateSchema.parse({
      kind: "proposal",
      message: currentState.message,
      questions: currentState.questions,
      proposal,
    });
    return;
  }
  const pendingProposal = pendingAiProposal(currentState);
  const message = pendingProposal?.message ?? "変更案を更新しました。";
  if (currentState.kind === "questions") {
    aiState.value = rendererAiStateSchema.parse({
      kind: "questions",
      message: currentState.message,
      questions: currentState.questions,
      pending_proposal: { message, proposal },
    });
    return;
  }
  aiState.value = rendererAiStateSchema.parse({ kind: "proposal", message, questions: [], proposal });
}

async function selectAiProposal(input: AiWorkflowSelectionRequest): Promise<void> {
  if (aiBusy.value) {
    return;
  }
  aiBusy.value = true;
  try {
    const request = aiWorkflowSelectionRequestSchema.parse(input);
    const result = await window.taskHub.ai.select(request);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    proposalState(aiWorkflowProposalViewSchema.parse(result.value));
  } catch {
    showUnexpectedFailure();
  } finally {
    aiBusy.value = false;
  }
}

async function editAiOperation(input: AiWorkflowOperationEdit): Promise<void> {
  if (aiBusy.value) {
    return;
  }
  aiBusy.value = true;
  try {
    const request = aiWorkflowOperationEditSchema.parse(input);
    const result = await window.taskHub.ai.editOperation(request);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    proposalState(aiWorkflowProposalViewSchema.parse(result.value));
  } catch {
    showUnexpectedFailure();
  } finally {
    aiBusy.value = false;
  }
}

async function approveAiProposal(input: AiWorkflowApprovalRequest): Promise<void> {
  if (aiBusy.value) {
    return;
  }
  if (!canWrite.value) {
    feedback.value = writeUnavailableText("変更案の適用");
    return;
  }
  aiBusy.value = true;
  try {
    const request = aiWorkflowApprovalRequestSchema.parse(input);
    const result = await window.taskHub.ai.approve(request);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    aiState.value = rendererAiStateSchema.parse({
      kind: "applied",
      message: "適用結果を確認してください。",
      result: result.value,
    });
    await manualSync();
  } catch {
    showUnexpectedFailure();
  } finally {
    aiBusy.value = false;
  }
}

async function rejectAiProposal(proposalId: string): Promise<void> {
  if (aiBusy.value) {
    return;
  }
  aiBusy.value = true;
  try {
    const result = await window.taskHub.ai.reject(proposalId);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    aiState.value = rendererAiStateSchema.parse({ kind: "idle" });
    feedback.value = "変更案を却下しました。";
  } catch {
    showUnexpectedFailure();
  } finally {
    aiBusy.value = false;
  }
}

async function loadInitialSyncState(): Promise<void> {
  try {
    const result = await window.taskHub.sync.getState();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    handleSyncState(result.value);
  } catch {
    feedback.value = "同期状態を取得できませんでした。";
  }
}

async function loadInitialCodexStatus(): Promise<void> {
  try {
    const result = await window.taskHub.ai.getStatus();
    if (isFailure(result)) {
      codexState.value = rendererCodexStateSchema.parse({
        kind: "unavailable",
        reason_code: "startup_failed",
      });
      return;
    }
    handleCodexStatus(result.value);
  } catch {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      reason_code: "startup_failed",
    });
  }
}

async function initialize(): Promise<void> {
  try {
    appVersion.value = await window.taskHub.app.getVersion();
  } catch {
    appVersion.value = "取得不可";
  }
  try {
    removeSyncSubscription = window.taskHub.sync.onState((value) => {
      try {
        handleSyncState(value);
      } catch {
        feedback.value = "同期状態を確認できませんでした。";
      }
    });
  } catch {
    setSyncState(rendererSyncStateSchema.parse({ kind: "error", error_code: "unexpected_error" }));
  }
  try {
    removeAiSubscription = window.taskHub.ai.onDelta((delta) => {
      appendDelta(delta);
    });
  } catch {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      reason_code: "startup_failed",
    });
  }
  try {
    removeAiStatusSubscription = window.taskHub.ai.onStatus((value) => {
      try {
        handleCodexStatus(value);
      } catch {
        codexState.value = rendererCodexStateSchema.parse({
          kind: "unavailable",
          reason_code: "startup_failed",
        });
      }
    });
  } catch {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      reason_code: "startup_failed",
    });
    feedback.value = "Codex状態を購読できませんでした。";
  }
  try {
    const result = await window.taskHub.setup.getState();
    if (isFailure(result)) {
      setScreenError(result);
    } else {
      applySetupState(result.value);
    }
  } catch {
    screen.value = createErrorScreenState("operation_failed", failureText("operation_failed"));
  }
  if (setupState.value?.kind === "ready") {
    await loadObsidianVaults();
  }
  await loadInitialSyncState();
  await loadInitialCodexStatus();
}

onMounted(() => {
  clockTimer = window.setInterval(() => {
    currentAsOf.value = new Date().toISOString();
  }, 60_000);
  void initialize();
});

onUnmounted(() => {
  if (clockTimer != null) {
    window.clearInterval(clockTimer);
  }
  if (removeSyncSubscription != null) {
    removeSyncSubscription();
  }
  if (removeAiSubscription != null) {
    removeAiSubscription();
  }
  if (removeAiStatusSubscription != null) {
    removeAiStatusSubscription();
  }
});
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-900">
    <AppHeader
      :connection-state="connectionState"
      :last-sync-at="lastSyncAt"
      :configured="configured"
      :can-manual-sync="canManualSync"
      :can-full-sync="canManualSync"
      :full-sync-running="activeSyncMode === 'full'"
      :can-write="canWrite"
      :codex-state="codexState"
      :codex-authentication-busy="setupBusy"
      :asana-authentication-busy="asanaAuthenticationBusy"
      :app-version="appVersion"
      :cleanup-count="cleanupCount"
      @sync="manualSync"
      @full-sync="fullSync"
      @new-ai-session="startAiSession"
      @complete-codex-authentication="completeCodexAuthenticationFromHeader"
      @reauthenticate-asana="reauthenticateAsana"
    />
    <main class="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-5 lg:px-6">
      <p
        v-if="feedback.length > 0"
        class="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900"
        role="status"
        aria-live="polite"
      >
        {{ feedback }}
      </p>
      <div
        v-if="screen.kind === 'loading'"
        class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
        role="status"
      >
        読み込み中です。
      </div>
      <SetupWizard
        v-else-if="screen.kind === 'setup'"
        :state="setupState"
        :busy="setupBusy"
        @action="handleSetupAction"
      />
      <div
        v-else-if="screen.kind === 'error'"
        class="rounded-xl border border-rose-200 bg-white p-8"
        role="alert"
      >
        <h2 class="text-xl font-semibold text-rose-900">
          画面を読み込めません
        </h2><p class="mt-2 text-sm text-rose-800">
          {{ screen.failure.message }}
        </p>
      </div>
      <template v-else>
        <section
          v-if="overview != null"
          class="space-y-5"
          aria-label="タスク管理画面"
        >
          <div class="flex flex-wrap items-end justify-between gap-4">
            <TaskFilters
              v-model="filter"
              :areas="overview.areas"
              :disabled="false"
            /><p class="text-sm text-slate-600">
              {{ visibleRows.length }}件を表示
            </p>
          </div>
          <section
            v-if="overview.cleanup_items.length > 0"
            class="rounded-xl border border-amber-200 bg-amber-50 p-4"
            aria-labelledby="cleanup-title"
          >
            <h2
              id="cleanup-title"
              class="text-lg font-semibold text-amber-950"
            >
              要整理項目
            </h2>
            <ul class="mt-3 grid gap-2 text-sm text-amber-950 lg:grid-cols-2">
              <li
                v-for="item in overview.cleanup_items"
                :key="`${item.kind}-${item.message}-${cleanupScopeLabel(item)}`"
                class="rounded-md border border-amber-200 bg-white p-3"
              >
                <p class="font-medium">
                  {{ cleanupKindLabel(item.kind) }}・{{ cleanupScopeLabel(item) }}
                </p>
                <p class="mt-1">
                  {{ item.message }}
                </p>
                <p
                  v-if="cleanupRelatedGids(item).length > 0"
                  class="mt-1 text-xs"
                >
                  {{ cleanupRelatedGids(item) }}
                </p>
              </li>
            </ul>
          </section>
          <div class="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(24rem,1fr)]">
            <TaskList
              :rows="visibleRows"
              :selected-task-gid="selectedTaskGid"
              :as-of="currentAsOf"
              @select="selectTask"
            /><TaskDetail
              :task="selectedTask"
              :areas="overview.areas"
              :can-write="canWrite"
              :read-available="canReadLocal"
              :obsidian-vault-ids="registeredVaultIds"
              :obsidian-notes="obsidianNotes"
              :obsidian-search-results="obsidianSearchResults"
              :obsidian-statuses="obsidianStatuses"
              :obsidian-busy="obsidianBusy"
              :can-reanalyze-obsidian-notes="canReanalyzeObsidianNotes"
              @edit="applyGuiEdit"
              @list-obsidian="listObsidian"
              @search-obsidian="searchObsidian"
              @check-obsidian="checkObsidianLink"
              @open-obsidian="openObsidianLink"
              @reanalyze-obsidian-notes="reanalyzeObsidianNotes"
            />
          </div>
          <AiPanel
            :state="aiState"
            :can-write="canWrite && !aiBusy"
            @start="startAiTurn"
            @select="selectAiProposal"
            @edit="editAiOperation"
            @approve="approveAiProposal"
            @reject="rejectAiProposal"
          />
        </section>
        <div
          v-else
          class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
          role="status"
        >
          タスク一覧を読み込んでいます。
        </div>
      </template>
    </main>
  </div>
</template>
