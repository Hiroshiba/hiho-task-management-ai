<script setup lang="ts">
import { ref } from "vue";
import { DialogRoot } from "reka-ui";
import { viewModelTaskDetailSchema } from "../../shared/view-model";
import { useAppBootstrap } from "../app/use-app-bootstrap";
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
import { useToast } from "./useToast";

type FeedbackKind = "success" | "progress" | "warning" | "failure";
type Feedback = {
  readonly kind: FeedbackKind;
  readonly message: string;
};

const { screen, handleSetupState } = useAppBootstrap({
  subscribeSyncState: () => subscribeSyncState(),
  initializeProposals: () => proposalWorkspace.initialize(),
  loadSetup: () => setup.load(),
  loadVaults: () => obsidian.loadVaults(),
  loadSyncState: () => loadInitialSyncState(),
  loadAuthentication: () => authentication.load(),
  onSetupReady: () => { void startInitialTaskDataRefresh(); },
});
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
    proposalWorkspace.applySetupState(state);
    handleSetupState(state);
  },
  onFeedback: setFeedback,
  onToast: (kind, message) => addToast(kind, message),
  onCodexAuthentication: () => proposalWorkspace.refreshCodexStatus(),
  onDialogOpen: () => {
    closeProposalAssistant();
    void obsidian.loadVaultMappings();
    void github.loadStatus();
  },
  authenticationRequired: () => authenticationRequired.value,
  onAuthenticationRequired: () => markAuthenticationRequired(),
  onAuthenticationIdle: () => loadInitialSyncState(),
  onAuthenticationFailure: () => reconcileAuthenticationFailure(),
  onSynchronized: (result) => completeAuthenticationSync(result.synced_at),
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
  activeSyncMode,
  canManualSync,
  canAcceptWrite,
  canWriteSelectedTask,
  authenticationRequired,
  setTaskFeedback,
  clearTaskFeedback,
  selectTask,
  deselectTask,
  startInitialTaskDataRefresh,
  taskReferences,
  completeAuthenticationSync,
  completeHistorySync,
  markAuthenticationRequired,
  subscribeSyncState,
  reconcileAuthenticationFailure,
  showNormalizationNotificationToast,
  loadInitialSyncState,
  manualSync,
  fullSync,
  applyEdit,
  refreshExecution,
  retryExecution,
  selectedEditState,
  selectedExecution,
  selectedExecutionFeedback,
  taskEditMarkers,
  drafts,
} = useTasks({
  configured,
  historyClear: proposals.history.clear,
  authenticationBusy: asanaAuthenticationBusy,
  onFailure: (message) => setFeedback("failure", message),
  onFeedback: (kind, message) => showGlobalResultFeedback({ kind, message }),
  onToast: (kind, message) => addToast(kind, message),
  onSyncingChange: (isSyncing) => proposalWorkspace.handleSyncState(isSyncing),
});
const proposalWorkspace = useProposalWorkspace({
  proposals,
  canWrite: canAcceptWrite,
  hasRegisteredVaults: () => registeredVaultIds.value.length > 0,
  tasks: taskReferences,
  selectedTaskGid,
  closeSettings: settings.closeDialog,
  selectTask,
  onToast: (kind, message) => addToast(kind, message),
  onSettingsFeedback: settings.setDialogFeedback,
});
const {
  codexState,
  externalState: proposalExternalState,
  externalReviewRequestId: proposalExternalReviewRequestId,
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
  canReanalyzeObsidianNotes,
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
      :tasks="taskReferences"
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
      :external-review-request-id="proposalExternalReviewRequestId"
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
          @synchronized="completeHistorySync"
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
                :can-write="canWriteSelectedTask"
                :saving-state="selectedEditState"
                :execution="selectedExecution"
                :execution-feedback="selectedExecutionFeedback"
                :draft-store="drafts"
                :task-edit-markers="taskEditMarkers"
                :read-available="configured"
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
