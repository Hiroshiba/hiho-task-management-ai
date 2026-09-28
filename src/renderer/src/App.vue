<script setup lang="ts">
import {
  computed,
  ref,
} from "vue";
import { DialogRoot } from "reka-ui";
import type { IpcResult } from "../../shared/ipc-contracts/common";
import type { SetupState } from "../../shared/ipc-contracts/setup-schemas";
import { viewModelTaskDetailSchema } from "../../shared/view-model";
import { useAppScreen } from "../app/use-app-screen";
import { useAppStartup } from "../app/use-app-startup";
import { useSystemUpdate } from "../features/system";
import { VaultSettings, useObsidianIntegration } from "../features/obsidian-integration";
import { GithubStatus, useGithubIntegration } from "../features/github-integration";
import { ProposalHistoryPanel, useProposals, useProposalWorkspace } from "../features/proposals";
import {
  TaskFilters,
  TaskList,
  TaskSort,
  cleanupKindLabel,
  cleanupScopeLabel,
  cleanupRelatedGids,
  useTasks,
} from "../features/tasks";
import AppHeader from "./AppHeader.vue";
import { AsanaReauthenticationPanel, SettingsDialog, SetupWizard, useSettings } from "../features/settings";
import TaskDetail from "./TaskDetail.vue";
import ToastHost from "./ToastHost.vue";
import {
  rendererSyncStateSchema,
  type RendererFailure,
} from "./state";
import { useToast } from "./useToast";

type FeedbackKind = "success" | "progress" | "warning" | "failure";
type IpcFailure = Extract<IpcResult<unknown>, { readonly kind: "error" }>;

type Feedback = {
  readonly kind: FeedbackKind;
  readonly message: string;
};

const { screen, showSetup, showDashboard, showError } = useAppScreen();
const appUpdateState = useSystemUpdate();
const github = useGithubIntegration();
const { addToast } = useToast();
const feedback = ref<Feedback | undefined>();
const proposals = useProposals();
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
    void obsidian.loadVaultMappings();
    void github.loadStatus();
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
  visibleRows,
  connectionState,
  syncState,
  activeSyncMode,
  canManualSync,
  canAcceptWrite,
  setTaskFeedback,
  clearTaskFeedback,
  selectTask,
  deselectTask,
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
const obsidian = useObsidianIntegration({
  selectedTask,
  saveBlocked: proposalExternalBusy,
  onToast: (kind, message) => addToast(kind, message),
  onFeedback: setFeedback,
  onTaskFeedback: setTaskFeedback,
  clearTaskFeedback,
});
const {
  vaultMappings,
  vaultMappingsLoading,
  vaultMappingBusy,
  vaultMappingFeedback,
  vaultSaveGeneration,
  registeredVaultIds,
  noteStatuses: obsidianStatuses,
} = obsidian;
const canReadLocal = computed(() => setupState.value?.kind === "ready");
const canReanalyzeObsidianNotes = computed(() => {
  return canAcceptWrite.value
    && codexState.value.kind === "ready"
    && registeredVaultIds.value.length > 0;
});
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

async function initialize(): Promise<void> {
  subscribeSyncState();
  await proposalWorkspace.initialize();
  const state = await setup.load();
  if (state == null) {
    showError("初回設定の状態を読み込めませんでした。");
    return;
  }
  if (state.kind === "ready") {
    await obsidian.loadVaults();
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
        :state="proposalExternalState"
        :busy="proposalExternalBusy"
        :restore-focus="!proposalDialogVisible"
        :feedback="settingsDialogFeedback"
        :vault-busy="vaultMappingBusy"
        @set-enabled="setProposalExternalEnabled"
      >
        <template #github>
          <GithubStatus :state="github.state.value" />
        </template>
        <template #vault>
          <VaultSettings
            :open="settingsDialogVisible"
            :vault-mappings="vaultMappings"
            :vault-mappings-loading="vaultMappingsLoading"
            :busy="proposalExternalBusy"
            :vault-busy="vaultMappingBusy"
            :vault-feedback="vaultMappingFeedback"
            :vault-save-generation="vaultSaveGeneration"
            @save-vault-mapping="obsidian.saveVaultMapping"
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
                @check-obsidian="obsidian.checkNote"
                @open-obsidian="obsidian.openNote"
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
