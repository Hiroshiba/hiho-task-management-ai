<script setup lang="ts">
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import { DialogRoot } from "reka-ui";
import {
  ipcAsanaAuthenticationStateSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcFailureSchema,
  ipcIntegrationStatusResponseSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianPathInputSchema,
  ipcSyncResultSchema,
  type IpcAsanaAuthenticationState,
  type IpcFailure,
  type IpcIntegrationStatus,
} from "../../shared/ipc";
import {
  setupStateSchema,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import {
  viewModelTaskDetailSchema,
  type ViewModelTaskDetail,
} from "../../shared/view-model";
import type { VaultMapping } from "../../shared/storage";
import { useAppScreen } from "../app/use-app-screen";
import { useAppStartup } from "../app/use-app-startup";
import { useSystemUpdate } from "../features/system";
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
import SettingsDialog from "./SettingsDialog.vue";
import TaskDetail from "./TaskDetail.vue";
import ToastHost from "./ToastHost.vue";
import {
  rendererFailureSchema,
  rendererSyncStateSchema,
  type RendererFailure,
  type RendererSyncState,
} from "./state";
import { useTaskHub } from "./task-hub";
import { useToast } from "./useToast";

const taskHub = useTaskHub();

const SetupWizard = defineAsyncComponent(() => import("./SetupWizard.vue"));

type SetupAction =
  | { readonly kind: "start" }
  | { readonly kind: "complete_codex_authentication" }
  | {
      readonly kind: "begin_asana_authorization";
      readonly request: Promise<SetupResult>;
    }
  | {
      readonly kind: "complete_asana_authorization";
      readonly request: Promise<SetupResult>;
    }
  | {
      readonly kind: "cancel_asana_authorization";
      readonly request: Promise<SetupResult>;
    }
  | { readonly kind: "list_workspaces" }
  | { readonly kind: "select_workspace"; readonly input: SetupWorkspaceSelectionInput }
  | { readonly kind: "select_project"; readonly input: SetupProjectSelectionInput }
  | { readonly kind: "retry_resources" }
  | { readonly kind: "run_capability" }
  | { readonly kind: "choose_vault"; readonly input: SetupVaultChoiceInput }
  | { readonly kind: "choose_external_tool"; readonly request: Promise<SetupResult> }
  | { readonly kind: "run_full_sync" }
  | { readonly kind: "run_codex_capability" };

type SetupResult =
  | { readonly kind: "ok"; readonly value: SetupState }
  | IpcFailure;

type ObsidianLinkStatus = "exists" | "missing" | "unavailable";

type TaskObsidianLink = TaskDetailDto["obsidian_links"][number];

type FeedbackKind = "success" | "progress" | "warning" | "failure";

type Feedback = {
  readonly kind: FeedbackKind;
  readonly message: string;
};

const asanaAuthenticationStatePollIntervalMilliseconds = 500;
const asanaAuthenticationStateMaximumRetryCount = 3;

const { screen, showSetup, showDashboard, showError } = useAppScreen();
const setupState = ref<SetupState | undefined>();
const setupBusy = ref(false);
const asanaAuthenticationBusy = ref(false);
const asanaAuthenticationStateLoaded = ref(false);
const asanaAuthenticationStateNeedsRecheck = ref(true);
const asanaAuthenticationStateRequestBusy = ref(false);
const asanaAuthenticationState = ref<IpcAsanaAuthenticationState>(
  ipcAsanaAuthenticationStateSchema.parse({ kind: "idle" }),
);
const asanaAuthorizationCodeInput = ref<HTMLInputElement | null>(null);
const appUpdateState = useSystemUpdate();
const settingsDialogVisible = ref(false);
const settingsDialogFeedback = ref<Feedback | undefined>();
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
let asanaAuthenticationStateTimer: number | undefined;
let asanaAuthenticationStateGeneration = 0;
let asanaAuthenticationStateLoadInProgress = false;
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

const configured = computed(() => setupState.value?.kind === "ready");
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
  normalizationNotificationMessage,
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
  closeSettings: () => { settingsDialogVisible.value = false; },
  selectTask,
  onToast: (kind, message) => addToast(kind, message),
  onSettingsFeedback: (value) => { settingsDialogFeedback.value = value; },
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

function applySetupState(value: unknown): void {
  const wasConfigured = configured.value;
  const wasLoading = screen.value.kind === "loading";
  const parsed = setupStateSchema.parse(value);
  setupState.value = parsed;
  setCodexFromSetup(parsed);
  if (parsed.kind === "ready") {
    showDashboard();
    void startInitialTaskDataRefresh();
    if (!wasConfigured && !wasLoading && !asanaAuthenticationStateLoaded.value) {
      void loadAsanaAuthenticationState();
    }
    return;
  }
  if (wasConfigured) {
    asanaAuthenticationStateLoaded.value = false;
    asanaAuthenticationStateNeedsRecheck.value = true;
    advanceAsanaAuthenticationStateGeneration();
  }
  showSetup();
}

async function resynchronizeSetupState(): Promise<void> {
  try {
    const result = await taskHub.setup.getState();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    applySetupState(result.value);
  } catch {
    showUnexpectedFailure();
  }
}

async function runSetupRequest(request: Promise<SetupResult>): Promise<void> {
  setupBusy.value = true;
  clearFeedback();
  try {
    const result = await request;
    if (isFailure(result)) {
      showFailure(result);
      await resynchronizeSetupState();
      return;
    }
    if (result.value.kind === "external_tool_configured") {
      addToast("success", "Discord読取連携を登録しました。");
    }
    applySetupState(result.value);
  } catch {
    showUnexpectedFailure();
    await resynchronizeSetupState();
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
  clearFeedback();
  try {
    const result = await taskHub.setup.completeCodexAuthentication();
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
      await proposalWorkspace.refreshCodexStatus();
    }
  } catch {
    showUnexpectedFailure();
  } finally {
    setupBusy.value = false;
  }
}

function clearAsanaAuthorizationCode(): void {
  const input = asanaAuthorizationCodeInput.value;
  if (input != null) {
    input.value = "";
  }
}

function clearAsanaAuthenticationStateTimer(): void {
  if (asanaAuthenticationStateTimer != null) {
    window.clearTimeout(asanaAuthenticationStateTimer);
    asanaAuthenticationStateTimer = undefined;
  }
}

function advanceAsanaAuthenticationStateGeneration(): number {
  asanaAuthenticationStateGeneration += 1;
  asanaAuthenticationStateRequestBusy.value = false;
  clearAsanaAuthenticationStateTimer();
  return asanaAuthenticationStateGeneration;
}

function scheduleAsanaAuthenticationStatePolling(
  state: IpcAsanaAuthenticationState,
  generation: number,
): void {
  clearAsanaAuthenticationStateTimer();
  if (generation !== asanaAuthenticationStateGeneration) {
    return;
  }
  let delayMilliseconds: number;
  switch (state.kind) {
    case "idle":
      return;
    case "opening":
    case "completing":
    case "synchronizing":
      delayMilliseconds = asanaAuthenticationStatePollIntervalMilliseconds;
      break;
    case "authorization_pending": {
      const expiresAt = Date.parse(state.expires_at);
      if (!Number.isFinite(expiresAt)) {
        throw new Error("Asana認証の有効期限を確認できません。");
      }
      delayMilliseconds = Math.max(0, expiresAt - Date.now());
      break;
    }
  }
  asanaAuthenticationStateTimer = window.setTimeout(() => {
    asanaAuthenticationStateTimer = undefined;
    if (generation !== asanaAuthenticationStateGeneration) {
      return;
    }
    const pollingGeneration = advanceAsanaAuthenticationStateGeneration();
    void requestAsanaAuthenticationState(pollingGeneration, 0);
  }, delayMilliseconds);
}

function scheduleAsanaAuthenticationOpeningPolling(generation: number): void {
  clearAsanaAuthenticationStateTimer();
  if (generation !== asanaAuthenticationStateGeneration) {
    return;
  }
  asanaAuthenticationStateTimer = window.setTimeout(() => {
    asanaAuthenticationStateTimer = undefined;
    if (generation !== asanaAuthenticationStateGeneration) {
      return;
    }
    const pollingGeneration = advanceAsanaAuthenticationStateGeneration();
    void requestAsanaAuthenticationState(pollingGeneration, 0);
  }, asanaAuthenticationStatePollIntervalMilliseconds);
}

function scheduleAsanaAuthenticationStateRetry(
  generation: number,
  retryCount: number,
): void {
  clearAsanaAuthenticationStateTimer();
  if (
    generation !== asanaAuthenticationStateGeneration
    || retryCount >= asanaAuthenticationStateMaximumRetryCount
  ) {
    return;
  }
  asanaAuthenticationStateTimer = window.setTimeout(() => {
    asanaAuthenticationStateTimer = undefined;
    if (generation !== asanaAuthenticationStateGeneration) {
      return;
    }
    const retryGeneration = advanceAsanaAuthenticationStateGeneration();
    void requestAsanaAuthenticationState(retryGeneration, retryCount + 1);
  }, asanaAuthenticationStatePollIntervalMilliseconds);
}

function applyAsanaAuthenticationState(
  value: unknown,
  generation: number,
  reconcileSyncStateOnIdleTransition: boolean,
): IpcAsanaAuthenticationState | undefined {
  if (generation !== asanaAuthenticationStateGeneration) {
    return undefined;
  }
  const parsed = ipcAsanaAuthenticationStateSchema.parse(value);
  const previous = asanaAuthenticationState.value;
  asanaAuthenticationState.value = parsed;
  asanaAuthenticationStateNeedsRecheck.value = false;
  scheduleAsanaAuthenticationStatePolling(parsed, generation);
  if (
    reconcileSyncStateOnIdleTransition
    && previous.kind !== "idle"
    && parsed.kind === "idle"
  ) {
    clearAsanaAuthorizationCode();
    void loadInitialSyncState();
  }
  return parsed;
}

async function loadAsanaAuthenticationState(): Promise<void> {
  if (asanaAuthenticationStateLoadInProgress || asanaAuthenticationBusy.value) {
    return;
  }
  asanaAuthenticationStateLoadInProgress = true;
  asanaAuthenticationStateLoaded.value = false;
  asanaAuthenticationStateNeedsRecheck.value = true;
  const generation = advanceAsanaAuthenticationStateGeneration();
  try {
    asanaAuthenticationBusy.value = true;
    await requestAsanaAuthenticationState(generation, 0);
  } finally {
    asanaAuthenticationBusy.value = false;
    asanaAuthenticationStateLoadInProgress = false;
  }
}

async function requestAsanaAuthenticationState(
  generation: number,
  retryCount: number,
): Promise<boolean> {
  asanaAuthenticationStateRequestBusy.value = true;
  try {
    const result = await taskHub.asana.getAuthenticationState();
    if (generation !== asanaAuthenticationStateGeneration) {
      return false;
    }
    if (isFailure(result)) {
      showFailure(result);
      asanaAuthenticationStateNeedsRecheck.value = true;
      scheduleAsanaAuthenticationStateRetry(generation, retryCount);
      return false;
    }
    const state = applyAsanaAuthenticationState(
      result.value,
      generation,
      true,
    );
    if (state == null) {
      return false;
    }
    if (state.kind === "opening" || state.kind === "authorization_pending") {
      setSyncState(rendererSyncStateSchema.parse({ kind: "authentication_required" }));
    }
    asanaAuthenticationStateLoaded.value = true;
    return true;
  } catch {
    if (generation !== asanaAuthenticationStateGeneration) {
      return false;
    }
    showUnexpectedFailure();
    asanaAuthenticationStateNeedsRecheck.value = true;
    scheduleAsanaAuthenticationStateRetry(generation, retryCount);
    return false;
  } finally {
    if (generation === asanaAuthenticationStateGeneration) {
      asanaAuthenticationStateRequestBusy.value = false;
    }
  }
}

async function resynchronizeAsanaAuthenticationState(): Promise<boolean> {
  const generation = advanceAsanaAuthenticationStateGeneration();
  return requestAsanaAuthenticationState(generation, 0);
}

async function recheckAsanaAuthenticationState(): Promise<void> {
  if (
    asanaAuthenticationBusy.value
    || asanaAuthenticationStateRequestBusy.value
    || !configured.value
  ) {
    return;
  }
  const generation = advanceAsanaAuthenticationStateGeneration();
  asanaAuthenticationBusy.value = true;
  clearFeedback();
  clearAsanaAuthorizationCode();
  try {
    await requestAsanaAuthenticationState(generation, 0);
  } finally {
    clearAsanaAuthorizationCode();
    asanaAuthenticationBusy.value = false;
  }
}

async function reconcileAsanaAuthenticationFailure(
  fallback: RendererSyncState,
  failureMessage: string,
): Promise<void> {
  asanaAuthenticationStateNeedsRecheck.value = true;
  const authenticationStateReconciled = await resynchronizeAsanaAuthenticationState();
  await reconcileSyncStateAfterFailure(fallback);
  if (authenticationStateReconciled) {
    setFeedback("failure", failureMessage);
  }
}

async function beginAsanaReauthentication(): Promise<void> {
  if (asanaAuthenticationBusy.value
    || !configured.value
    || syncState.value.kind !== "authentication_required"
    || !asanaAuthenticationStateLoaded.value
    || asanaAuthenticationState.value.kind !== "idle") {
    return;
  }
  const generation = advanceAsanaAuthenticationStateGeneration();
  asanaAuthenticationBusy.value = true;
  clearFeedback();
  clearAsanaAuthorizationCode();
  scheduleAsanaAuthenticationOpeningPolling(generation);
  const authenticationRequired = rendererSyncStateSchema.parse({
    kind: "authentication_required",
  });
  try {
    const result = await taskHub.asana.beginReauthentication();
    if (generation !== asanaAuthenticationStateGeneration) {
      if (asanaAuthenticationBusy.value && isFailure(result)) {
        asanaAuthenticationStateNeedsRecheck.value = true;
        clearAsanaAuthorizationCode();
        showFailure(result);
        await reconcileAsanaAuthenticationFailure(
          authenticationRequired,
          displayFailure(result).message,
        );
      }
      return;
    }
    clearAsanaAuthorizationCode();
    if (isFailure(result)) {
      const failureMessage = displayFailure(result).message;
      showFailure(result);
      await reconcileAsanaAuthenticationFailure(authenticationRequired, failureMessage);
      return;
    }
    const state = applyAsanaAuthenticationState(result.value, generation, false);
    if (state == null) {
      return;
    }
    if (state.kind === "idle") {
      throw new Error("Asana再認証の開始結果が不正です。");
    }
  } catch {
    if (generation !== asanaAuthenticationStateGeneration) {
      if (asanaAuthenticationBusy.value) {
        showUnexpectedFailure();
        await reconcileAsanaAuthenticationFailure(
          authenticationRequired,
          "Asana再認証の開始に失敗しました。",
        );
      }
      return;
    }
    clearAsanaAuthorizationCode();
    const failureMessage = "Asana再認証の開始に失敗しました。";
    showUnexpectedFailure();
    await reconcileAsanaAuthenticationFailure(authenticationRequired, failureMessage);
  } finally {
    clearAsanaAuthorizationCode();
    asanaAuthenticationBusy.value = false;
  }
}

async function completeAsanaReauthentication(): Promise<void> {
  if (asanaAuthenticationBusy.value
    || !configured.value
    || asanaAuthenticationStateNeedsRecheck.value
    || asanaAuthenticationStateRequestBusy.value
    || asanaAuthenticationState.value.kind !== "authorization_pending") {
    return;
  }
  const generation = advanceAsanaAuthenticationStateGeneration();
  const input = asanaAuthorizationCodeInput.value;
  if (input == null) {
    throw new Error("Asana認可コード入力欄がありません。");
  }
  const state = asanaAuthenticationState.value;
  const parsedInput = ipcAsanaCompleteReauthenticationInputSchema.safeParse({
    authorization_id: state.authorization_id,
    authorization_code: input.value.trim(),
  });
  clearAsanaAuthorizationCode();
  if (!parsedInput.success) {
    scheduleAsanaAuthenticationStatePolling(state, generation);
    setFeedback("warning", "Asana認可コードを確認してください。");
    return;
  }
  asanaAuthenticationBusy.value = true;
  clearFeedback();
  applyAsanaAuthenticationState({
    kind: "completing",
    authorization_id: state.authorization_id,
  }, generation, false);
  const authenticationRequired = rendererSyncStateSchema.parse({
    kind: "authentication_required",
  });
  try {
    const result = await taskHub.asana.completeReauthentication(parsedInput.data);
    clearAsanaAuthorizationCode();
    if (isFailure(result)) {
      const failureMessage = displayFailure(result).message;
      showFailure(result);
      if (asanaAuthenticationBusy.value) {
        await reconcileAsanaAuthenticationFailure(authenticationRequired, failureMessage);
      }
      return;
    }
    const synchronized = ipcSyncResultSchema.parse(result.value);
    const completionGeneration = advanceAsanaAuthenticationStateGeneration();
    applyAsanaAuthenticationState({ kind: "idle" }, completionGeneration, false);
    setConnectionState("online", rendererSyncStateSchema.parse({
      kind: "synced",
      synced_at: synchronized.synced_at,
    }));
    const refreshResult = await reloadTaskDataAfterSuccessfulSync(synchronized.synced_at);
    if (refreshResult.kind === "failed") {
      const notificationMessage = normalizationNotificationMessage(synchronized.normalization_notifications);
      setFeedback("warning", notificationMessage == null
        ? "Asanaの再認証と同期は完了しました。タスク表示を更新できませんでした。"
        : `${notificationMessage} Asanaの再認証と同期は完了しました。タスク表示を更新できませんでした。`);
      return;
    }
    showNormalizationNotificationToast(
      synchronized.synced_at,
      synchronized.normalization_notifications,
    );
    showGlobalResultFeedback({
      kind: synchronized.application_result.operations.some((operation) => operation.outcome === "conflict")
        || synchronized.remaining_plan.status_write_task_gids.length
          + synchronized.remaining_plan.external_write_task_gids.length
          + synchronized.remaining_plan.tag_write_task_gids.length > 0
        || synchronized.critical_errors.length > 0 ? "warning" : "success",
      message: "Asanaを再認証し、タスク表示を更新しました。",
    });
  } catch {
    clearAsanaAuthorizationCode();
    const failureMessage = "Asanaの再認証に失敗しました。保存済みのタスクを表示しています。";
    showUnexpectedFailure();
    if (asanaAuthenticationBusy.value) {
      await reconcileAsanaAuthenticationFailure(authenticationRequired, failureMessage);
    }
  } finally {
    clearAsanaAuthorizationCode();
    asanaAuthenticationBusy.value = false;
  }
}

async function cancelAsanaReauthentication(): Promise<void> {
  if (asanaAuthenticationBusy.value
    || !configured.value
    || asanaAuthenticationStateNeedsRecheck.value
    || asanaAuthenticationStateRequestBusy.value
    || asanaAuthenticationState.value.kind !== "authorization_pending") {
    return;
  }
  const generation = advanceAsanaAuthenticationStateGeneration();
  const state = asanaAuthenticationState.value;
  const input = ipcAsanaCancelReauthenticationInputSchema.parse({
    authorization_id: state.authorization_id,
  });
  asanaAuthenticationBusy.value = true;
  clearFeedback();
  clearAsanaAuthorizationCode();
  scheduleAsanaAuthenticationStatePolling(state, generation);
  const authenticationRequired = rendererSyncStateSchema.parse({
    kind: "authentication_required",
  });
  try {
    const result = await taskHub.asana.cancelReauthentication(input);
    if (generation !== asanaAuthenticationStateGeneration) {
      if (asanaAuthenticationBusy.value && isFailure(result)) {
        asanaAuthenticationStateNeedsRecheck.value = true;
        clearAsanaAuthorizationCode();
        showFailure(result);
        await reconcileAsanaAuthenticationFailure(
          authenticationRequired,
          displayFailure(result).message,
        );
      }
      return;
    }
    clearAsanaAuthorizationCode();
    if (isFailure(result)) {
      const failureMessage = displayFailure(result).message;
      showFailure(result);
      await reconcileAsanaAuthenticationFailure(authenticationRequired, failureMessage);
      return;
    }
    const nextState = applyAsanaAuthenticationState(result.value, generation, false);
    if (nextState == null) {
      return;
    }
    if (nextState.kind !== "idle") {
      throw new Error("Asana再認証の取消結果が不正です。");
    }
    setSyncState(authenticationRequired);
    addToast("warning", "Asana再認証をキャンセルしました。");
  } catch {
    if (generation !== asanaAuthenticationStateGeneration) {
      if (asanaAuthenticationBusy.value) {
        showUnexpectedFailure();
        await reconcileAsanaAuthenticationFailure(
          authenticationRequired,
          "Asana再認証のキャンセルに失敗しました。",
        );
      }
      return;
    }
    clearAsanaAuthorizationCode();
    const failureMessage = "Asana再認証のキャンセルに失敗しました。";
    showUnexpectedFailure();
    await reconcileAsanaAuthenticationFailure(authenticationRequired, failureMessage);
  } finally {
    clearAsanaAuthorizationCode();
    asanaAuthenticationBusy.value = false;
  }
}

function handleSetupAction(action: SetupAction): void {
  switch (action.kind) {
    case "start":
      void runSetupRequest(taskHub.setup.start());
      return;
    case "complete_codex_authentication":
      void runSetupRequest(taskHub.setup.completeCodexAuthentication());
      return;
    case "begin_asana_authorization":
    case "complete_asana_authorization":
    case "cancel_asana_authorization":
      void runSetupRequest(action.request);
      return;
    case "list_workspaces":
      void runSetupRequest(taskHub.setup.listWorkspaces());
      return;
    case "select_workspace":
      void runSetupRequest(taskHub.setup.selectWorkspace(action.input));
      return;
    case "select_project":
      void runSetupRequest(taskHub.setup.selectProject(action.input));
      return;
    case "retry_resources":
      void runSetupRequest(taskHub.setup.retryResources());
      return;
    case "run_capability":
      void runSetupRequest(taskHub.setup.runCapability());
      return;
    case "choose_vault":
      void runSetupRequest(taskHub.setup.chooseVault(action.input));
      return;
    case "choose_external_tool":
      void runSetupRequest(action.request);
      return;
    case "run_full_sync":
      void runSetupRequest(taskHub.setup.runFullSync());
      return;
    case "run_codex_capability":
      void runSetupRequest(taskHub.setup.runCodexCapability());
      return;
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

watch(settingsDialogVisible, (open) => {
  if (open) {
    closeProposalAssistant();
    void loadVaultMappings();
    void loadIntegrationStatus();
  }
});

async function initialize(): Promise<void> {
  subscribeSyncState();
  await proposalWorkspace.initialize();
  try {
    const result = await taskHub.setup.getState();
    if (isFailure(result)) {
      setScreenError(result);
    } else {
      applySetupState(result.value);
    }
  } catch {
    showError(failureText("operation_failed"));
  }
  if (setupState.value?.kind === "ready") {
    await loadObsidianVaults();
  }
  await loadInitialSyncState();
  if (setupState.value?.kind === "ready") {
    await loadAsanaAuthenticationState();
  }
}

useAppStartup(initialize, setScreenError, () => {
  showError(failureText("operation_failed"));
});

onBeforeUnmount(() => {
  clearAsanaAuthorizationCode();
  asanaAuthenticationBusy.value = false;
  asanaAuthenticationStateRequestBusy.value = false;
  advanceAsanaAuthenticationStateGeneration();
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
        @complete-codex-authentication="completeCodexAuthenticationFromHeader"
        @begin-reauthentication="beginAsanaReauthentication"
        @recheck-authentication-state="recheckAsanaAuthenticationState"
      />
      <SettingsDialog
        :open="settingsDialogVisible"
        :integration-status="integrationStatus"
        :integration-status-loading="integrationStatusLoading"
        :integration-status-error="integrationStatusError"
        :state="proposalExternalState"
        :busy="proposalExternalBusy"
        :restore-focus="!proposalDialogVisible"
        :feedback="settingsDialogFeedback"
        :vault-mappings="vaultMappings"
        :vault-mappings-loading="vaultMappingsLoading"
        :vault-busy="vaultMappingBusy"
        :vault-feedback="vaultMappingFeedback"
        :vault-save-generation="vaultSaveGeneration"
        @set-enabled="setProposalExternalEnabled"
        @save-vault-mapping="saveVaultMapping"
      />
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
        @action="handleSetupAction"
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
        <section
          v-if="asanaAuthenticationState.kind === 'opening'
            || asanaAuthenticationState.kind === 'completing'
            || asanaAuthenticationState.kind === 'synchronizing'"
          class="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
          role="status"
          aria-live="polite"
        >
          <p v-if="asanaAuthenticationState.kind === 'opening'">
            認証ページを開いています
          </p>
          <p v-else-if="asanaAuthenticationState.kind === 'completing'">
            認可コードを確認しています
          </p>
          <p v-else>
            Asana同期を再開しています
          </p>
        </section>
        <section
          v-if="asanaAuthenticationState.kind === 'authorization_pending'"
          class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
          aria-labelledby="asana-reauthentication-title"
        >
          <h2
            id="asana-reauthentication-title"
            class="text-lg font-semibold text-amber-950 dark:text-amber-100"
          >
            Asana認証コードを入力してください
          </h2>
          <p class="mt-2 text-sm text-amber-950 dark:text-amber-100">
            Asanaの認証後に表示された認可コードを貼り付けてください。
          </p>
          <form
            class="mt-3 flex flex-wrap items-end gap-2"
            @submit.prevent="completeAsanaReauthentication"
          >
            <label class="w-full min-w-0 max-w-xl flex-1 text-sm font-medium text-amber-950 dark:text-amber-100">
              認可コード
              <input
                ref="asanaAuthorizationCodeInput"
                type="text"
                autocomplete="off"
                class="mt-1 block w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600 dark:border-amber-800 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-400 dark:focus:border-sky-400 dark:focus:ring-sky-400"
              >
            </label>
            <button
              type="submit"
              class="rounded-md bg-amber-700 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-800 dark:text-amber-100 dark:hover:bg-amber-700 dark:focus:ring-amber-400 dark:focus:ring-offset-slate-950 dark:disabled:bg-slate-700 dark:disabled:text-slate-400"
              :disabled="asanaAuthenticationBusy || asanaAuthenticationStateNeedsRecheck || asanaAuthenticationStateRequestBusy"
            >
              {{ asanaAuthenticationBusy ? "確認中" : "認証を確定" }}
            </button>
            <button
              type="button"
              class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950 dark:disabled:border-slate-700 dark:disabled:bg-slate-900 dark:disabled:text-slate-400"
              :disabled="asanaAuthenticationBusy || asanaAuthenticationStateNeedsRecheck || asanaAuthenticationStateRequestBusy"
              @click="cancelAsanaReauthentication"
            >
              キャンセル
            </button>
          </form>
        </section>
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
