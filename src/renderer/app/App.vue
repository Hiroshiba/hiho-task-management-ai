<script setup lang="ts">
import { proxyRefs } from "vue";
import { DialogRoot } from "reka-ui";
import { TaskObsidianLinks, VaultSettings } from "../features/obsidian-integration";
import { ProposalHeaderActions, ProposalHeaderStatus, ProposalHistoryPanel } from "../features/proposals";
import {
  TaskFilters,
  TaskDetail,
  TaskHeaderStatus,
  TaskList,
  TaskSort,
  TaskSyncControls,
  TaskWriteStatus,
  cleanupKindLabel,
  cleanupScopeLabel,
  cleanupRelatedGids,
} from "../features/tasks";
import { AsanaReauthenticationAction, AsanaReauthenticationPanel, SettingsDialog, SettingsTrigger, SetupWizard } from "../features/settings";
import { SystemUpdateStatus } from "../features/system";
import AppHeader from "./AppHeader.vue";
import ToastHost from "../shared/components/ToastHost.vue";
import { useAppComposition } from "./use-app-composition";

const composition = useAppComposition();
const shell = proxyRefs(composition);
const { proposalDialogRef } = composition;
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100 lg:flex lg:h-dvh lg:flex-col">
    <DialogRoot v-model:open="shell.settingsDialogVisible">
      <AppHeader>
        <template #status>
          <TaskHeaderStatus :connection-state="shell.connectionState" />
          <ProposalHeaderStatus :codex-state="shell.codexState" />
          <SystemUpdateStatus :state="shell.appUpdateState" />
          <TaskWriteStatus :can-write="shell.canAcceptWrite" />
        </template>
        <template #actions>
          <div
            class="flex min-w-0 max-w-full flex-wrap items-center gap-3"
            role="group"
            aria-label="Asanaと同期の操作"
          >
            <AsanaReauthenticationAction
              :configured="shell.configured"
              :authentication-required="shell.connectionState.sync.kind === 'authentication_required'"
              :state="shell.asanaAuthenticationState"
              :busy="shell.asanaAuthenticationBusy"
              :loaded="shell.asanaAuthenticationStateLoaded"
              :needs-recheck="shell.asanaAuthenticationStateNeedsRecheck"
              :request-busy="shell.asanaAuthenticationStateRequestBusy"
              @begin-reauthentication="shell.authentication.begin"
              @recheck-authentication-state="shell.authentication.recheck"
            />
            <TaskSyncControls
              :configured="shell.configured"
              :can-manual-sync="shell.canManualSync"
              :can-full-sync="shell.canManualSync"
              :full-sync-running="shell.activeSyncMode === 'full'"
              @sync="shell.manualSync"
              @full-sync="shell.fullSync"
            />
          </div>
          <SettingsTrigger :configured="shell.configured" />
          <ProposalHeaderActions
            :configured="shell.configured"
            :can-open-ai-assistant="shell.configured"
            :ai-waiting-count="shell.proposalWaitingCount"
            :ai-running-count="shell.proposalRunningCount"
            :codex-state="shell.codexState"
            :codex-authentication-busy="shell.setupBusy"
            @open-ai-assistant="shell.openProposalAssistant"
            @complete-codex-authentication="shell.setup.act({ kind: 'complete_codex_authentication' })"
          />
        </template>
      </AppHeader>
      <SettingsDialog
        :state="shell.proposalExternalState"
        :busy="shell.proposalExternalBusy"
        :restore-focus="!shell.proposalDialogVisible"
        :feedback="shell.settingsDialogFeedback"
        :vault-busy="shell.vaultMappingBusy"
        @set-enabled="shell.setProposalExternalEnabled"
      >
        <template #vault>
          <VaultSettings
            :open="shell.settingsDialogVisible"
            :vault-mappings="shell.vaultMappings"
            :vault-mappings-loading="shell.vaultMappingsLoading"
            :busy="shell.proposalExternalBusy"
            :vault-busy="shell.vaultMappingBusy"
            :vault-feedback="shell.vaultMappingFeedback"
            :vault-save-generation="shell.vaultSaveGeneration"
            @save-vault-mapping="shell.obsidian.saveVaultMapping"
          />
        </template>
      </SettingsDialog>
    </DialogRoot>
    <component
      :is="shell.proposalDialogComponent"
      v-if="shell.proposalDialogComponent != null"
      ref="proposalDialogRef"
      :open="shell.proposalDialogVisible"
      :can-start-new-session="shell.canStartNewProposalSession"
      :creating-session="shell.proposalSessionCreating"
      :feedback="shell.proposalDialogFeedback"
      :sessions="shell.proposalSessionViews"
      :tasks="shell.taskReferences"
      :selected-session-id="shell.proposalSelectedSessionId"
      :external-agent-state="shell.proposalExternalState"
      :external-agent-busy="shell.proposalExternalBusy"
      :external-agent-edit-result="shell.proposalExternalEditResult"
      :external-approval-results="shell.proposalExternalApprovalResults"
      :executions="shell.proposalExecutions"
      :execution-for="shell.proposalExecutionFor"
      :execution-failures="shell.proposalExecutionFailures"
      :execution-list-busy="shell.proposalExecutionListBusy"
      :execution-list-failure="shell.proposalExecutionListFailure"
      :execution-request-ids="shell.proposalExecutionRequestIds"
      :retrying-execution-ids="shell.proposalRetryingExecutionIds"
      :external-review-request-id="shell.proposalExternalReviewRequestId"
      @close="shell.closeProposalAssistant"
      @new-session="shell.startProposalSession"
      @select-session="shell.selectProposalSession"
      @start="shell.startProposalTurn"
      @select="shell.selectProposal"
      @edit="shell.editProposalOperation"
      @approve="shell.approveProposal"
      @reject="shell.rejectProposal"
      @complete="shell.closeProposalSession"
      @cancel="shell.closeProposalSession"
      @select-task="(_sessionId, taskGid) => shell.selectProposalTask(taskGid)"
      @external-edit="shell.editExternalProposal"
      @external-select="shell.selectExternalProposal"
      @external-approve="shell.approveExternalProposal"
      @refresh-executions="shell.refreshProposalExecutions"
      @refresh-execution="shell.refreshProposalExecution"
      @retry-execution="shell.retryProposalExecution"
      @external-reject="shell.rejectExternalProposal"
      @external-select-task="shell.selectProposalTask"
    />
    <main class="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-5 lg:flex-1 lg:min-h-0 lg:px-6">
      <p
        v-if="shell.feedback != null"
        class="rounded-md px-4 py-3 text-sm"
        :class="shell.feedbackClass(shell.feedback.kind)"
        :role="shell.feedbackRole(shell.feedback.kind)"
      >
        {{ shell.feedback.message }}
      </p>
      <div
        v-if="shell.screen.kind === 'loading'"
        class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
        role="status"
      >
        読み込み中です。
      </div>
      <SetupWizard
        v-else-if="shell.screen.kind === 'setup'"
        :state="shell.setupState"
        :busy="shell.setupBusy"
        @action="shell.setup.act"
      />
      <div
        v-else-if="shell.screen.kind === 'error'"
        class="rounded-xl border border-rose-200 bg-white p-8 dark:border-rose-800 dark:bg-slate-900"
        role="alert"
      >
        <h2 class="text-xl font-semibold text-rose-900 dark:text-rose-100">
          画面を読み込めません
        </h2><p class="mt-2 text-sm text-rose-800 dark:text-rose-200">
          {{ shell.screen.message }}
        </p>
      </div>
      <template v-else>
        <ProposalHistoryPanel
          :history="shell.proposalWorkspace.history"
          @synchronized="shell.completeHistorySync"
        />
        <AsanaReauthenticationPanel
          :state="shell.asanaAuthenticationState"
          :busy="shell.asanaAuthenticationBusy"
          :needs-recheck="shell.asanaAuthenticationStateNeedsRecheck"
          :request-busy="shell.asanaAuthenticationStateRequestBusy"
          @complete="shell.authentication.complete"
          @cancel="shell.authentication.cancel"
        />
        <section
          v-if="shell.overview != null"
          class="space-y-5 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col"
          aria-label="タスク管理画面"
        >
          <details
            v-if="shell.overview.cleanup_items.length > 0"
            :open="shell.filter.kind === 'cleanup'"
            class="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950 lg:max-h-[30dvh] lg:overflow-y-auto"
            aria-labelledby="cleanup-title"
          >
            <summary
              id="cleanup-title"
              class="cursor-pointer px-4 py-4 text-lg font-semibold text-amber-950 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-inset dark:text-amber-100 dark:focus:ring-amber-400"
            >
              要整理 {{ shell.overview.cleanup_items.length }}件
            </summary>
            <ul class="grid gap-2 border-t border-amber-200 p-4 text-sm text-amber-950 lg:grid-cols-2 dark:border-amber-800 dark:text-amber-100">
              <li
                v-for="item in shell.overview.cleanup_items"
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
              :rows="shell.visibleRows"
              :selected-task-gid="shell.selectedTaskGid"
              :as-of="shell.currentAsOf"
              @select="shell.selectTask"
              @clear-selection="shell.deselectTask"
            >
              <template #controls>
                <div class="grid min-w-0 gap-3 sm:grid-cols-2">
                  <TaskFilters
                    v-model="shell.filter"
                    :areas="shell.overview.areas"
                    :disabled="false"
                  />
                  <TaskSort
                    v-model="shell.taskSort"
                    :disabled="false"
                  />
                </div>
              </template>
            </TaskList>
            <div class="min-w-0 space-y-3 lg:min-h-0 lg:overflow-y-auto">
              <p
                v-if="shell.taskFeedback != null"
                class="sticky top-3 rounded-md px-4 py-3 text-sm"
                :class="shell.feedbackClass(shell.taskFeedback.kind)"
                :role="shell.feedbackRole(shell.taskFeedback.kind)"
              >
                {{ shell.taskFeedback.message }}
              </p>
              <TaskDetail
                :task="shell.selectedTask"
                :as-of="shell.currentAsOf"
                :areas="shell.overview.areas"
                :can-write="shell.canWriteSelectedTask"
                :saving-state="shell.selectedEditState"
                :execution="shell.selectedExecution"
                :execution-feedback="shell.selectedExecutionFeedback"
                :draft-store="shell.drafts"
                :task-edit-markers="shell.taskEditMarkers"
                @edit="shell.applyEdit"
                @check-execution="shell.refreshExecution"
                @retry-execution="shell.retryExecution"
              >
                <template #related-notes="{ task, canWrite, unlink }">
                  <TaskObsidianLinks
                    :task-gid="task.gid"
                    :links="task.obsidian_links"
                    :vault-ids="shell.registeredVaultIds"
                    :statuses="shell.obsidianStatuses"
                    :read-available="shell.configured"
                    :can-write="canWrite"
                    :can-reanalyze="shell.canReanalyzeObsidianNotes"
                    @check="shell.obsidian.checkNote"
                    @open="shell.obsidian.openNote"
                    @unlink="unlink"
                    @reanalyze="shell.requestTaskNoteAnalysis"
                  />
                </template>
              </TaskDetail>
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
