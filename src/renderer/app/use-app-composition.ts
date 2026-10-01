import { onBeforeUnmount, provide, ref } from "vue";
import { useAppBootstrap } from "./use-app-bootstrap";
import { useSystemUpdate } from "../features/system";
import { useObsidianIntegration } from "../features/obsidian-integration";
import { useProposals, useProposalWorkspace } from "../features/proposals";
import { useTasks } from "../features/tasks";
import { useSettings } from "../features/settings";
import { createToastStore, toastStoreInjectionKey } from "../shared/components/useToast";

/** 各機能の画面状態と操作をアプリ画面へ接続します。 */
export function useAppComposition() {
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
  const toastStore = createToastStore();
  provide(toastStoreInjectionKey, toastStore);
  onBeforeUnmount(toastStore.clearToasts);
  const { addToast, addPersistentToast } = toastStore;
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
    onSubscriptionFailureToast: (message) => addPersistentToast("warning", message),
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
    onSubscriptionFailureToast: (message) => addPersistentToast("warning", message),
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

  return {
    screen,
    appUpdateState,
    feedback,
    feedbackClass,
    feedbackRole,
    setup,
    authentication,
    settingsDialogVisible,
    settingsDialogFeedback,
    setupState,
    setupBusy,
    configured,
    asanaAuthenticationState,
    asanaAuthenticationBusy,
    asanaAuthenticationStateLoaded,
    asanaAuthenticationStateNeedsRecheck,
    asanaAuthenticationStateRequestBusy,
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
    selectTask,
    deselectTask,
    taskReferences,
    completeHistorySync,
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
    proposalWorkspace,
    codexState,
    proposalExternalState,
    proposalExternalReviewRequestId,
    proposalExternalBusy,
    proposalExternalEditResult,
    proposalExternalApprovalResults,
    proposalExecutions,
    proposalExecutionFailures,
    proposalExecutionListBusy,
    proposalExecutionListFailure,
    proposalExecutionRequestIds,
    proposalRetryingExecutionIds,
    proposalExecutionFor,
    proposalDialogVisible,
    proposalDialogComponent,
    proposalDialogRef,
    proposalDialogFeedback,
    proposalSessionCreating,
    proposalSessionViews,
    proposalSelectedSessionId,
    canStartNewProposalSession,
    proposalWaitingCount,
    proposalRunningCount,
    canReanalyzeObsidianNotes,
    openProposalAssistant,
    closeProposalAssistant,
    startProposalSession,
    startProposalTurn,
    requestTaskNoteAnalysis,
    selectProposal,
    editProposalOperation,
    approveProposal,
    rejectProposal,
    closeProposalSession,
    selectProposalSession,
    selectProposalTask,
    setProposalExternalEnabled,
    editExternalProposal,
    selectExternalProposal,
    approveExternalProposal,
    rejectExternalProposal,
    refreshProposalExecution,
    refreshProposalExecutions,
    retryProposalExecution,
    obsidian,
    vaultMappings,
    vaultMappingsLoading,
    vaultMappingBusy,
    vaultMappingFeedback,
    vaultSaveGeneration,
    registeredVaultIds,
    obsidianStatuses,
  };
}
