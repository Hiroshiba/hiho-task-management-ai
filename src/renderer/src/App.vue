<script setup lang="ts">
import {
  computed,
  ref,
} from "vue";
import { DialogRoot } from "reka-ui";
import {
  ipcFailureSchema,
  ipcIntegrationStatusResponseSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianPathInputSchema,
  type IpcFailure,
  type IpcIntegrationStatus,
} from "../../shared/ipc";
import type { SetupState } from "../../shared/ipc-contracts/setup-schemas";
import {
  viewModelTaskDetailSchema,
  type ViewModelTaskDetail,
} from "../../shared/view-model";
import type { VaultMapping } from "../../shared/storage";
import { useAppScreen } from "../app/use-app-screen";
import { useAppStartup } from "../app/use-app-startup";
import { useSystemUpdate } from "../features/system";
import { VaultSettings } from "../features/obsidian-integration";
import { ProposalHistoryPanel, useProposals, useProposalWorkspace } from "../features/proposals";
import {
  TaskFilters,
  TaskList,
  TaskSort,
  cleanupKindLabel,
  cleanupScopeLabel,
  cleanupRelatedGids,
  useTasks,
  type TaskDetail as TaskDetailDto,
} from "../features/tasks";
import AppHeader from "./AppHeader.vue";
import { AsanaReauthenticationPanel, SettingsDialog, SetupWizard, useSettings } from "../features/settings";
import TaskDetail from "./TaskDetail.vue";
import ToastHost from "./ToastHost.vue";
import {
  rendererFailureSchema,
  rendererSyncStateSchema,
  type RendererFailure,
} from "./state";
import { useTaskHub } from "./task-hub";
import { useToast } from "./useToast";

const taskHub = useTaskHub();

type ObsidianLinkStatus = "exists" | "missing" | "unavailable";

type TaskObsidianLink = TaskDetailDto["obsidian_links"][number];

type FeedbackKind = "success" | "progress" | "warning" | "failure";

type Feedback = {
  readonly kind: FeedbackKind;
  readonly message: string;
};

const { screen, showSetup, showDashboard, showError } = useAppScreen();
const appUpdateState = useSystemUpdate();
const integrationStatus = ref<IpcIntegrationStatus | undefined>();
const integrationStatusLoading = ref(false);
const integrationStatusError = ref<string | undefined>();
const vaultMappings = ref<readonly VaultMapping[]>([]);
const vaultMappingsLoading = ref(false);
const vaultMappingBusy = ref(false);
const vaultMappingFeedback = ref<Feedback | undefined>();
const vaultSaveGeneration = ref(0);
const { addToast } = useToast();
const feedback = ref<Feedback | undefined>();
const proposals = useProposals();
const registeredVaultIds = ref<readonly string[]>([]);
let vaultMappingsLoadGeneration = 0;
function setFeedback(kind: FeedbackKind, message: string): void {
  feedback.value = { kind, message };
}

function clearFeedback(): void {
  feedback.value = undefined;
}

function feedbackClass(kind: FeedbackKind): string {
  switch (kind) {
    case "success":
      return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
    case "progress":
      return "bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-100";
    case "warning":
      return "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "failure":
      return "bg-rose-50 text-rose-900 dark:bg-rose-950 dark:text-rose-100";
  }
}

function feedbackRole(kind: FeedbackKind): "status" | "alert" {
  switch (kind) {
    case "success":
    case "progress":
      return "status";
    case "warning":
    case "failure":
      return "alert";
  }
}

function showGlobalResultFeedback(value: Feedback): void {
  if (value.kind === "success") {
    clearFeedback();
    addToast("success", value.message);
    return;
  }
  setFeedback(value.kind, value.message);
}

const settings = useSettings({
  onSetupState: (state) => {
    setCodexFromSetup(state);
    if (state.kind === "ready") {
      showDashboard();
      void startInitialTaskDataRefresh();
    } else {
      showSetup();
    }
  },
  onFeedback: setFeedback,
  onToast: (kind, message) => addToast(kind, message),
  onCodexAuthentication: () => proposalWorkspace.refreshCodexStatus(),
  onDialogOpen: () => {
    closeProposalAssistant();
    void loadVaultMappings();
    void loadIntegrationStatus();
  },
  authenticationRequired: () => syncState.value.kind === "authentication_required",
  onAuthenticationRequired: () => setSyncState(rendererSyncStateSchema.parse({ kind: "authentication_required" })),
  onAuthenticationIdle: () => loadInitialSyncState(),
  onAuthenticationFailure: () => reconcileSyncStateAfterFailure(rendererSyncStateSchema.parse({ kind: "authentication_required" })),
  onSynchronized: async (result) => {
    setConnectionState("online", rendererSyncStateSchema.parse({ kind: "synced", synced_at: result.synced_at }));
    const refresh = await reloadTaskDataAfterSuccessfulSync(result.synced_at);
    return refresh.kind !== "failed";
  },
  onNormalizationNotifications: (result) => showNormalizationNotificationToast(
    result.synced_at, result.normalization_notifications,
  ),
});
const { setup, authentication, dialogVisible: settingsDialogVisible,
  dialogFeedback: settingsDialogFeedback } = settings;
const { state: setupState, busy: setupBusy, configured } = setup;
const { state: asanaAuthenticationState, busy: asanaAuthenticationBusy,
  loaded: asanaAuthenticationStateLoaded, needsRecheck: asanaAuthenticationStateNeedsRecheck,
  requestBusy: asanaAuthenticationStateRequestBusy } = authentication;
const {
  overview,
  selectedTask,
  selectedTaskGid,
  filter,
  taskSort,
  currentAsOf,
  taskFeedback,
  obsidianStatuses,
  visibleRows,
  connectionState,
  syncState,
  activeSyncMode,
  canManualSync,
  canAcceptWrite,
  setTaskFeedback,
  clearTaskFeedback,
  captureTaskDetailContext,
  isCurrentTaskDetailContext,
  selectTask,
  deselectTask,
  checkObsidianLinks,
  captureObsidianStatusContext,
  isCurrentObsidianStatusContext,
  setObsidianStatus,
  startInitialTaskDataRefresh,
  reloadTaskDataAfterSuccessfulSync,
  setConnectionState,
  setSyncState,
  subscribeSyncState,
  reconcileSyncStateAfterFailure,
  showNormalizationNotificationToast,
  loadInitialSyncState,
  manualSync,
  fullSync,
  chromiumConnectionState,
  applyEdit,
  refreshExecution,
  retryExecution,
  canSubmitSelectedEdit,
  selectedEditState,
  selectedExecution,
  selectedExecutionFeedback,
  taskEditMarkers,
  markTaskMissing,
  drafts,
} = useTasks({
  configured,
  historyClear: proposals.history.clear,
  authenticationBusy: asanaAuthenticationBusy,
  checkLinks: (links) => collectObsidianStatuses(links, registeredVaultIds.value),
  onFailure: (message) => setFeedback("failure", message),
  onTaskFailure: (message) => setTaskFeedback("failure", message),
  onTaskMissing: (taskGid) => markTaskMissing(taskGid),
  onFeedback: (kind, message) => showGlobalResultFeedback({ kind, message }),
  onToast: (kind, message) => addToast(kind, message),
  onStateChange: (state) => proposalWorkspace.handleSyncState(state.kind === "syncing"),
});
const proposalTasks = computed(() => overview.value?.tasks.map((task) => ({ gid: task.gid, title: task.title })) ?? []);
const proposalWorkspace = useProposalWorkspace({
  proposals,
  canWrite: canAcceptWrite,
  tasks: proposalTasks,
  selectedTaskGid,
  closeSettings: settings.closeDialog,
  selectTask,
  onToast: (kind, message) => addToast(kind, message),
  onSettingsFeedback: settings.setDialogFeedback,
});
const {
  codexState,
  externalState: proposalExternalState,
  externalBusy: proposalExternalBusy,
  externalEditResult: proposalExternalEditResult,
  externalApprovalResults: proposalExternalApprovalResults,
  executions: proposalExecutions,
  executionFailures: proposalExecutionFailures,
  executionListBusy: proposalExecutionListBusy,
  executionListFailure: proposalExecutionListFailure,
  executionRequestIds: proposalExecutionRequestIds,
  retryingExecutionIds: proposalRetryingExecutionIds,
  latestExecutionFor: proposalExecutionFor,
  dialogVisible: proposalDialogVisible,
  dialogComponent: proposalDialogComponent,
  dialogRef: proposalDialogRef,
  dialogFeedback: proposalDialogFeedback,
  sessionCreating: proposalSessionCreating,
  sessionViews: proposalSessionViews,
  selectedSessionId: proposalSelectedSessionId,
  canStartNewSession: canStartNewProposalSession,
  waitingCount: proposalWaitingCount,
  runningCount: proposalRunningCount,
  openAssistant: openProposalAssistant,
  closeAssistant: closeProposalAssistant,
  startSession: startProposalSession,
  startTurn: startProposalTurn,
  requestTaskNoteAnalysis,
  select: selectProposal,
  edit: editProposalOperation,
  approve: approveProposal,
  reject: rejectProposal,
  closeSession: closeProposalSession,
  selectSession: selectProposalSession,
  selectTask: selectProposalTask,
  setExternalEnabled: setProposalExternalEnabled,
  editExternal: editExternalProposal,
  selectExternal: selectExternalProposal,
  approveExternal: approveExternalProposal,
  rejectExternal: rejectExternalProposal,
  refreshExecution: refreshProposalExecution,
  refreshExecutions: refreshProposalExecutions,
  retryExecution: retryProposalExecution,
} = proposalWorkspace;
const canReadLocal = computed(() => setupState.value?.kind === "ready");
const canReanalyzeObsidianNotes = computed(() => {
  return canAcceptWrite.value
    && codexState.value.kind === "ready"
    && registeredVaultIds.value.length > 0;
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
    case "oauth_invalid_client":
      return "Client ID、Client Secret、OAuthアプリ設定を確認して認証を最初からやり直してください。";
    case "oauth_invalid_grant":
      return "認可コードが期限切れ、使用済み、または別アプリの可能性があるため認証を最初からやり直してください。";
    case "oauth_token_endpoint_rejected":
      return "Asanaが認証要求を拒否したためOAuthアプリ設定を確認して最初からやり直してください。";
    case "oauth_network_error":
      return "Asanaとの通信に失敗しました。ネットワークを確認して最初からやり直してください。";
    case "oauth_http_rejected":
      return "Asanaが認証要求を拒否しました。Client ID、Client Secret、Redirect URLを確認し、新しいコードで再認証してください。";
    case "oauth_service_unavailable":
      return "Asana認証サービスを一時利用できません。待ってから最初からやり直してください。";
    case "oauth_response_invalid":
      return "Asanaの認証応答形式を確認できません。最初からやり直し、続く場合はこの表示文を共有してください。";
    case "secure_storage_unavailable":
      return "OS保護ストレージが使えず秘密情報を保存できません。Windows版またはキーチェーン対応環境で起動してください。";
    case "oauth_session_error":
      return "認証セッションを最初からやり直してください。";
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

function showFailure(value: IpcFailure): void {
  setFeedback("failure", displayFailure(value).message);
}

function showUnexpectedFailure(): void {
  setFeedback("failure", "予期しないエラーが発生しました。もう一度お試しください。");
}

function showTaskFailure(value: IpcFailure): void {
  setTaskFeedback("failure", displayFailure(value).message);
}

function showTaskUnexpectedFailure(): void {
  setTaskFeedback("failure", "予期しないエラーが発生しました。もう一度お試しください。");
}

function setScreenError(value: IpcFailure): void {
  showError(failureText(value.code));
}

function setCodexFromSetup(state: SetupState): void {
  if (state.kind === "codex_authentication_required") {
    proposalWorkspace.setCodexHint({ kind: "authentication_required" });
    return;
  }
  if ("codex" in state && state.codex.kind === "unavailable") {
    proposalWorkspace.setCodexHint({ kind: "unavailable", reason_code: state.codex.reason_code });
    return;
  }
  if ("context" in state && state.context.codex.kind === "unavailable") {
    proposalWorkspace.setCodexHint({ kind: "unavailable", reason_code: state.context.codex.reason_code });
  }
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
      const result = await taskHub.obsidian.noteExists(input);
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

async function handleHistorySynchronized(syncedAt: string): Promise<void> {
  setConnectionState(chromiumConnectionState(), rendererSyncStateSchema.parse({
    kind: "synced",
    synced_at: syncedAt,
  }));
  const refresh = await reloadTaskDataAfterSuccessfulSync(syncedAt);
  if (refresh.kind === "applied" || refresh.kind === "unchanged") {
    addToast("success", "旧適用履歴の読取同期が完了しました。書き込みを再開できます。");
  }
}

function applyVaultMappings(mappings: readonly VaultMapping[]): void {
  vaultMappings.value = mappings;
  registeredVaultIds.value = mappings.map((mapping) => mapping.vault_id);
}

async function loadVaultMappings(): Promise<void> {
  const generation = vaultMappingsLoadGeneration + 1;
  vaultMappingsLoadGeneration = generation;
  vaultMappingsLoading.value = true;
  vaultMappingFeedback.value = undefined;
  try {
    const result = await taskHub.obsidian.listVaultMappings();
    if (generation !== vaultMappingsLoadGeneration) {
      return;
    }
    if (isFailure(result)) {
      vaultMappingFeedback.value = {
        kind: "failure",
        message: displayFailure(result).message,
      };
      return;
    }
    applyVaultMappings(result.value);
    if (selectedTask.value != null) {
      await checkObsidianLinks(selectedTask.value.obsidian_links);
    }
  } catch {
    if (generation === vaultMappingsLoadGeneration) {
      vaultMappingFeedback.value = {
        kind: "failure",
        message: "Vault設定を読み込めませんでした。もう一度お試しください。",
      };
    }
  } finally {
    if (generation === vaultMappingsLoadGeneration) {
      vaultMappingsLoading.value = false;
    }
  }
}

function vaultMappingFailureMessage(value: IpcFailure): string {
  if (value.code === "conflict") {
    return "AI依頼が残っている場合は「確認して閉じる」または「依頼を中止」を行い、別の処理中なら完了を待ってからVault設定を変更してください。";
  }
  return displayFailure(value).message;
}

async function saveVaultMapping(mapping: VaultMapping): Promise<void> {
  if (vaultMappingBusy.value || proposalExternalBusy.value) {
    return;
  }
  const wasRegistered = vaultMappings.value.some((candidate) => candidate.vault_id === mapping.vault_id);
  vaultMappingBusy.value = true;
  vaultMappingFeedback.value = {
    kind: "progress",
    message: "Vault設定を保存しています。",
  };
  let savedMappings: readonly VaultMapping[];
  try {
    try {
      const result = await taskHub.obsidian.saveVaultMapping(mapping);
      if (isFailure(result)) {
        vaultMappingFeedback.value = {
          kind: "failure",
          message: vaultMappingFailureMessage(result),
        };
        return;
      }
      savedMappings = result.value;
    } catch {
      vaultMappingFeedback.value = {
        kind: "failure",
        message: "Vault設定を保存できませんでした。入力内容を確認して再試行してください。",
      };
      return;
    }
    applyVaultMappings(savedMappings);
    vaultSaveGeneration.value += 1;
    vaultMappingFeedback.value = undefined;
    addToast(
      "success",
      wasRegistered
        ? `Vault「${mapping.vault_id}」のパスを更新しました。`
        : `Vault「${mapping.vault_id}」を登録しました。`,
    );
    try {
      if (selectedTask.value != null) {
        await checkObsidianLinks(selectedTask.value.obsidian_links);
      }
    } catch {
      setFeedback("warning", "Vaultを保存しましたが、ノートの状態を更新できませんでした。");
    }
  } finally {
    vaultMappingBusy.value = false;
  }
}

async function loadObsidianVaults(): Promise<void> {
  try {
    const result = await taskHub.obsidian.listVaults();
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

async function checkObsidianLink(link: ViewModelTaskDetail["obsidian_links"][number]): Promise<void> {
  const generation = captureObsidianStatusContext();
  if (!registeredVaultIds.value.includes(link.vault_id)) {
    if (!isCurrentObsidianStatusContext(generation)) {
      return;
    }
    setObsidianStatus(link, "unavailable");
    return;
  }
  try {
    const input = ipcObsidianPathInputSchema.parse({ vault_id: link.vault_id, relative_path: link.path });
    const result = await taskHub.obsidian.noteExists(input);
    if (!isCurrentObsidianStatusContext(generation)) {
      return;
    }
    if (isFailure(result)) {
      showTaskFailure(result);
      return;
    }
    setObsidianStatus(link, result.value.kind === "resolved" ? "exists" : "missing");
  } catch {
    if (isCurrentObsidianStatusContext(generation)) {
      showTaskUnexpectedFailure();
    }
  }
}

async function openObsidianLink(link: ViewModelTaskDetail["obsidian_links"][number]): Promise<void> {
  const context = captureTaskDetailContext();
  if (!registeredVaultIds.value.includes(link.vault_id)) {
    if (isCurrentTaskDetailContext(context)) {
      setTaskFeedback("warning", "このVaultは登録されていません。");
    }
    return;
  }
  try {
    const input = ipcObsidianOpenNoteInputSchema.parse({ vault_id: link.vault_id, relative_path: link.path });
    const result = await taskHub.obsidian.openNote(input);
    if (!isCurrentTaskDetailContext(context)) {
      return;
    }
    if (isFailure(result)) {
      showTaskFailure(result);
      return;
    }
    clearTaskFeedback();
    addToast("success", "Obsidianへノートを開く要求を送信しました。");
  } catch {
    if (isCurrentTaskDetailContext(context)) {
      showTaskUnexpectedFailure();
    }
  }
}

async function loadIntegrationStatus(): Promise<void> {
  integrationStatusLoading.value = true;
  integrationStatusError.value = undefined;
  try {
    const result = ipcIntegrationStatusResponseSchema.parse(
      await taskHub.setup.getIntegrationStatus(),
    );
    if (isFailure(result)) {
      integrationStatusError.value = displayFailure(result).message;
      return;
    }
    integrationStatus.value = result.value;
  } catch (error) {
    integrationStatusError.value = "GitHub連携の状態を確認できませんでした。";
    throw error;
  } finally {
    integrationStatusLoading.value = false;
  }
}

async function initialize(): Promise<void> {
  subscribeSyncState();
  await proposalWorkspace.initialize();
  const state = await setup.load();
  if (state == null) {
    showError("初回設定の状態を読み込めませんでした。");
    return;
  }
  if (state.kind === "ready") {
    await loadObsidianVaults();
  }
  await loadInitialSyncState();
  if (state.kind === "ready") {
    await authentication.load();
  }
}

useAppStartup(initialize, setScreenError, () => {
  showError(failureText("operation_failed"));
});

</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100 lg:flex lg:h-dvh lg:flex-col">
    <DialogRoot v-model:open="settingsDialogVisible">
      <AppHeader
        :connection-state="connectionState"
        :configured="configured"
        :can-manual-sync="canManualSync"
        :can-full-sync="canManualSync"
        :full-sync-running="activeSyncMode === 'full'"
        :can-write="canAcceptWrite"
        :can-open-ai-assistant="configured"
        :ai-waiting-count="proposalWaitingCount"
        :ai-running-count="proposalRunningCount"
        :codex-state="codexState"
        :app-update-state="appUpdateState"
        :codex-authentication-busy="setupBusy"
        :asana-authentication-busy="asanaAuthenticationBusy"
        :asana-authentication-state-loaded="asanaAuthenticationStateLoaded"
        :asana-authentication-state-needs-recheck="asanaAuthenticationStateNeedsRecheck"
        :asana-authentication-state-request-busy="asanaAuthenticationStateRequestBusy"
        :asana-authentication-state="asanaAuthenticationState"
        @sync="manualSync"
        @full-sync="fullSync"
        @open-ai-assistant="openProposalAssistant"
        @complete-codex-authentication="setup.act({ kind: 'complete_codex_authentication' })"
        @begin-reauthentication="authentication.begin"
        @recheck-authentication-state="authentication.recheck"
      />
      <SettingsDialog
        :integration-status="integrationStatus"
        :integration-status-loading="integrationStatusLoading"
        :integration-status-error="integrationStatusError"
        :state="proposalExternalState"
        :busy="proposalExternalBusy"
        :restore-focus="!proposalDialogVisible"
        :feedback="settingsDialogFeedback"
        :vault-busy="vaultMappingBusy"
        @set-enabled="setProposalExternalEnabled"
      >
        <template #vault>
          <VaultSettings
            :open="settingsDialogVisible"
            :vault-mappings="vaultMappings"
            :vault-mappings-loading="vaultMappingsLoading"
            :busy="proposalExternalBusy"
            :vault-busy="vaultMappingBusy"
            :vault-feedback="vaultMappingFeedback"
            :vault-save-generation="vaultSaveGeneration"
            @save-vault-mapping="saveVaultMapping"
          />
        </template>
      </SettingsDialog>
    </DialogRoot>
    <component
      :is="proposalDialogComponent"
      v-if="proposalDialogComponent != null"
      ref="proposalDialogRef"
      :open="proposalDialogVisible"
      :can-start-new-session="canStartNewProposalSession"
      :creating-session="proposalSessionCreating"
      :feedback="proposalDialogFeedback"
      :sessions="proposalSessionViews"
      :tasks="proposalTasks"
      :selected-session-id="proposalSelectedSessionId"
      :external-agent-state="proposalExternalState"
      :external-agent-busy="proposalExternalBusy"
      :external-agent-edit-result="proposalExternalEditResult"
      :external-approval-results="proposalExternalApprovalResults"
      :executions="proposalExecutions"
      :execution-for="proposalExecutionFor"
      :execution-failures="proposalExecutionFailures"
      :execution-list-busy="proposalExecutionListBusy"
      :execution-list-failure="proposalExecutionListFailure"
      :execution-request-ids="proposalExecutionRequestIds"
      :retrying-execution-ids="proposalRetryingExecutionIds"
      :external-review-request-id="proposalExternalState.kind === 'ready'
        ? proposalExternalState.value.review_target?.request_id
        : undefined"
      @close="closeProposalAssistant"
      @new-session="startProposalSession"
      @select-session="selectProposalSession"
      @start="startProposalTurn"
      @select="selectProposal"
      @edit="editProposalOperation"
      @approve="approveProposal"
      @reject="rejectProposal"
      @complete="closeProposalSession"
      @cancel="closeProposalSession"
      @select-task="(_sessionId, taskGid) => selectProposalTask(taskGid)"
      @external-edit="editExternalProposal"
      @external-select="selectExternalProposal"
      @external-approve="approveExternalProposal"
      @refresh-executions="refreshProposalExecutions"
      @refresh-execution="refreshProposalExecution"
      @retry-execution="retryProposalExecution"
      @external-reject="rejectExternalProposal"
      @external-select-task="selectProposalTask"
    />
    <main class="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-5 lg:flex-1 lg:min-h-0 lg:px-6">
      <p
        v-if="feedback != null"
        class="rounded-md px-4 py-3 text-sm"
        :class="feedbackClass(feedback.kind)"
        :role="feedbackRole(feedback.kind)"
      >
        {{ feedback.message }}
      </p>
      <div
        v-if="screen.kind === 'loading'"
        class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
        role="status"
      >
        読み込み中です。
      </div>
      <SetupWizard
        v-else-if="screen.kind === 'setup'"
        :state="setupState"
        :busy="setupBusy"
        @action="setup.act"
      />
      <div
        v-else-if="screen.kind === 'error'"
        class="rounded-xl border border-rose-200 bg-white p-8 dark:border-rose-800 dark:bg-slate-900"
        role="alert"
      >
        <h2 class="text-xl font-semibold text-rose-900 dark:text-rose-100">
          画面を読み込めません
        </h2><p class="mt-2 text-sm text-rose-800 dark:text-rose-200">
          {{ screen.message }}
        </p>
      </div>
      <template v-else>
        <ProposalHistoryPanel
          :history="proposalWorkspace.history"
          @synchronized="handleHistorySynchronized"
        />
        <AsanaReauthenticationPanel
          :state="asanaAuthenticationState"
          :busy="asanaAuthenticationBusy"
          :needs-recheck="asanaAuthenticationStateNeedsRecheck"
          :request-busy="asanaAuthenticationStateRequestBusy"
          @complete="authentication.complete"
          @cancel="authentication.cancel"
        />
        <section
          v-if="overview != null"
          class="space-y-5 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
          aria-label="タスク管理画面"
        >
          <details
            v-if="overview.cleanup_items.length > 0"
            :open="filter.kind === 'cleanup'"
            class="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 lg:max-h-[30dvh] lg:overflow-y-auto"
            aria-labelledby="cleanup-title"
          >
            <summary
              id="cleanup-title"
              class="cursor-pointer px-4 py-4 text-lg font-semibold text-amber-950 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-inset dark:text-amber-100 dark:focus:ring-amber-400"
            >
              要整理 {{ overview.cleanup_items.length }}件
            </summary>
            <ul class="grid gap-2 border-t border-amber-200 p-4 text-sm text-amber-950 lg:grid-cols-2 dark:border-amber-800 dark:text-amber-100">
              <li
                v-for="item in overview.cleanup_items"
                :key="`${item.kind}-${item.message}-${cleanupScopeLabel(item)}`"
                class="rounded-md border border-amber-200 bg-white p-3 dark:border-amber-800 dark:bg-slate-900"
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
          </details>
          <div class="grid items-start gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(24rem,1fr)] lg:items-stretch">
            <TaskList
              class="lg:min-h-0 lg:overflow-y-auto"
              :rows="visibleRows"
              :selected-task-gid="selectedTaskGid"
              :as-of="currentAsOf"
              @select="selectTask"
              @clear-selection="deselectTask"
            >
              <template #controls>
                <div class="grid min-w-0 gap-3 sm:grid-cols-2">
                  <TaskFilters
                    v-model="filter"
                    :areas="overview.areas"
                    :disabled="false"
                  />
                  <TaskSort
                    v-model="taskSort"
                    :disabled="false"
                  />
                </div>
              </template>
            </TaskList>
            <div class="min-w-0 space-y-3 lg:min-h-0 lg:overflow-y-auto">
              <p
                v-if="taskFeedback != null"
                class="sticky top-3 rounded-md px-4 py-3 text-sm"
                :class="feedbackClass(taskFeedback.kind)"
                :role="feedbackRole(taskFeedback.kind)"
              >
                {{ taskFeedback.message }}
              </p>
              <TaskDetail
                :task="selectedTask == null ? undefined : viewModelTaskDetailSchema.parse(selectedTask)"
                :as-of="currentAsOf"
                :areas="overview.areas"
                :can-write="canAcceptWrite && canSubmitSelectedEdit"
                :saving-state="selectedEditState"
                :execution="selectedExecution"
                :execution-feedback="selectedExecutionFeedback"
                :draft-store="drafts"
                :task-edit-markers="taskEditMarkers"
                :read-available="canReadLocal"
                :obsidian-vault-ids="registeredVaultIds"
                :obsidian-statuses="obsidianStatuses"
                :can-reanalyze-obsidian-notes="canReanalyzeObsidianNotes"
                @edit="applyEdit"
                @check-execution="refreshExecution"
                @retry-execution="retryExecution"
                @check-obsidian="checkObsidianLink"
                @open-obsidian="openObsidianLink"
                @reanalyze-obsidian-notes="requestTaskNoteAnalysis"
              />
            </div>
          </div>
        </section>
        <div
          v-else
          class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
          role="status"
        >
          タスク一覧を読み込んでいます。
        </div>
      </template>
    </main>
    <ToastHost />
  </div>
</template>
