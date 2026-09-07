<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import {
  ipcAiApprovalInputSchema,
  ipcAiCloseSessionInputSchema,
  ipcAiEditInputSchema,
  ipcAiSelectionInputSchema,
  ipcAiTurnInputSchema,
  ipcAsanaAuthenticationStateSchema,
  ipcAsanaCancelReauthenticationInputSchema,
  ipcAsanaCompleteReauthenticationInputSchema,
  ipcFailureSchema,
  ipcGuiEditResultSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianPathInputSchema,
  ipcGuiEditInputSchema,
  ipcSyncStateEventSchema,
  ipcSyncResultSchema,
  type IpcAiStatus,
  type IpcAsanaAuthenticationState,
  type IpcFailure,
  type IpcGuiEditResult,
  type IpcSyncResult,
  type IpcSyncStateEvent,
} from "../../shared/ipc";
import {
  gidSchema,
} from "../../shared/domain";
import {
  setupStateSchema,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import {
  aiWorkflowProposalViewSchema,
  aiWorkflowTurnRequestSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
} from "../../shared/ai-workflow";
import {
  externalAgentGuiApproveInputSchema,
  externalAgentGuiEditInputSchema,
  externalAgentGuiRejectInputSchema,
  externalAgentGuiSetEnabledInputSchema,
  externalAgentGuiStateSchema,
  type ExternalAgentGuiApproveInput,
  type ExternalAgentGuiEditInput,
  type ExternalAgentGuiRejectInput,
  type ExternalAgentGuiState,
} from "../../shared/external-agent";
import {
  viewModelOverviewSchema,
  viewModelTaskDetailSchema,
  type ViewModelOverview,
  type ViewModelTaskDetail,
} from "../../shared/view-model";
import AppHeader from "./AppHeader.vue";
import AiSessionDialog from "./AiSessionDialog.vue";
import SetupWizard from "./SetupWizard.vue";
import TaskDetail from "./TaskDetail.vue";
import TaskFilters from "./TaskFilters.vue";
import TaskList from "./TaskList.vue";
import ToastHost from "./ToastHost.vue";
import {
  createErrorScreenState,
  filterTaskRows,
  rendererAiConversationEntrySchema,
  rendererAiStateSchema,
  rendererCodexStateSchema,
  rendererConnectionStateSchema,
  rendererFailureSchema,
  rendererScreenStateSchema,
  rendererSyncStateSchema,
  type RendererAiState,
  type RendererAiConversationEntry,
  type RendererCodexState,
  type RendererConnectionState,
  type RendererFailure,
  type RendererFilter,
  type RendererExternalAgentEditResult,
  type RendererExternalAgentState,
  type RendererGuiEdit,
  type RendererTaskEditMarker,
  type RendererTaskEditMarkerUpdate,
  type RendererScreenState,
  type RendererSyncState,
  type AiSessionOperation,
  type AiSessionView,
} from "./state";
import { useTaskHub } from "./task-hub";
import { useToast } from "./useToast";

const taskHub = useTaskHub();

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

type TaskDetailContext = {
  readonly generation: number;
  readonly taskGid: string;
};

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
  | {
      readonly kind: "settled";
      readonly feedbackKind: FeedbackKind;
      readonly message: string;
      readonly save: "succeeded" | "failed";
    }
  | {
      readonly kind: "recovery_required";
      readonly feedbackKind: FeedbackKind;
      readonly message: string;
      readonly save: "succeeded" | "unknown";
    };

type GuiEditTaskDetailReadResult =
  | { readonly kind: "available"; readonly detail: ViewModelTaskDetail }
  | { readonly kind: "missing" }
  | { readonly kind: "failed" };

type GuiEditRequestState = {
  readonly taskGid: string;
  readonly generation: number;
  readonly kind: "waiting_sync" | "saving";
};

type FeedbackKind = "success" | "progress" | "warning" | "failure";

type Feedback = {
  readonly kind: FeedbackKind;
  readonly message: string;
};

type AiSessionRecord = Omit<
  AiSessionView,
  "can_write" | "can_send_ai" | "ai_send_disabled_reason" | "feedback"
> & {
  readonly feedback: AiSessionView["feedback"];
  readonly created_at: number;
};

type AiSessionDialogApi = {
  readonly focusSessionInput: (sessionId: string) => "focused" | "unavailable";
};

const aiSynchronizationWaitingMessage = "同期の完了を待っています。";
const asanaAuthenticationStatePollIntervalMilliseconds = 500;
const asanaAuthenticationStateMaximumRetryCount = 3;

const screen = ref<RendererScreenState>(rendererScreenStateSchema.parse({ kind: "loading" }));
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
const overview = ref<ViewModelOverview | undefined>();
const selectedTask = ref<ViewModelTaskDetail | undefined>();
const selectedTaskGid = ref<string | undefined>();
const filter = ref<RendererFilter>({ kind: "normal" });
const connectionState = ref<RendererConnectionState>(rendererConnectionStateSchema.parse({
  kind: "checking",
  sync: { kind: "waiting" },
}));
const codexState = ref<RendererCodexState>({ kind: "connecting" });
const aiSessions = ref<AiSessionRecord[]>([]);
const aiDialogVisible = ref(false);
const aiSelectedSessionId = ref<string | undefined>();
const aiDialogRef = ref<AiSessionDialogApi | null>(null);
const aiDialogReturnFocus = ref<HTMLElement | null>(null);
const aiSessionCreating = ref(false);
const aiDialogFeedback = ref<Feedback | undefined>();
const externalAgentState = ref<RendererExternalAgentState>({ kind: "loading" });
const externalAgentBusy = ref(false);
const externalAgentEditResult = ref<RendererExternalAgentEditResult | undefined>();
const { addToast } = useToast();
const currentAsOf = ref(new Date().toISOString());
const feedback = ref<Feedback | undefined>();
const taskFeedback = ref<Feedback | undefined>();
const obsidianStatuses = ref<ReadonlyMap<string, ObsidianLinkStatus>>(new Map());
const registeredVaultIds = ref<readonly string[]>([]);
const activeSyncMode = ref<"idle" | "delta" | "full">("idle");
const guiEditStates = ref(new Map<string, GuiEditRequestState>());
const taskEditMarkers = ref(new Map<string, RendererTaskEditMarker>());
let removeSyncSubscription: (() => void) | undefined;
let removeAiSubscription: (() => void) | undefined;
let removeAiStatusSubscription: (() => void) | undefined;
let removeExternalAgentSubscription: (() => void) | undefined;
let clockTimer: number | undefined;
let asanaAuthenticationStateTimer: number | undefined;
let asanaAuthenticationStateGeneration = 0;
let asanaAuthenticationStateLoadInProgress = false;
let taskDataGeneration = 0;
let taskDetailGeneration = 0;
let obsidianStatusGeneration = 0;
let guiEditGeneration = 0;
let taskEditMarkerGeneration = 0;
let lastLoadedSuccessfulSyncAt: string | undefined;
let activeSyncReload: ActiveSyncReload = { kind: "idle" };
let normalizationNotificationDisplayState: NormalizationNotificationDisplayState = {
  kind: "idle",
};


function setFeedback(kind: FeedbackKind, message: string): void {
  feedback.value = { kind, message };
}

function clearFeedback(): void {
  feedback.value = undefined;
}

function setTaskFeedback(kind: FeedbackKind, message: string): void {
  taskFeedback.value = { kind, message };
}

function clearTaskFeedback(): void {
  taskFeedback.value = undefined;
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

function showTaskResultFeedback(kind: FeedbackKind, message: string): void {
  if (kind === "success") {
    clearTaskFeedback();
    addToast("success", message);
    return;
  }
  setTaskFeedback(kind, message);
}

const syncState = computed(() => connectionState.value.sync);
const configured = computed(() => setupState.value?.kind === "ready");
const canManualSync = computed(() => configured.value
  && activeSyncMode.value === "idle"
  && !asanaAuthenticationBusy.value
  && connectionState.value.kind === "online"
  && syncState.value.kind !== "syncing"
  && syncState.value.kind !== "authentication_required"
  && syncState.value.kind !== "recovery_pending");
const canAcceptWrite = computed(() => {
  const currentOverview = overview.value;
  const currentSyncState = syncState.value;
  if (connectionState.value.kind !== "online" || currentOverview == null) {
    return false;
  }
  if (currentSyncState.kind === "syncing") {
    return currentSyncState.can_accept_write;
  }
  if (currentSyncState.kind !== "synced") {
    return false;
  }
  return syncTimestamp(currentOverview.last_successful_sync_at)
    >= syncTimestamp(currentSyncState.synced_at);
});
const selectedGuiEditState = computed(() => {
  const taskGid = selectedTaskGid.value;
  return taskGid == null ? undefined : guiEditStates.value.get(taskGid);
});
const guiEditSaving = computed(() => selectedGuiEditState.value != null);
const aiTaskReferences = computed(() => overview.value?.tasks.map((task) => ({
  gid: task.gid,
  title: task.title,
})) ?? []);
const aiSessionViews = computed<readonly AiSessionView[]>(() => aiSessions.value
  .slice()
  .sort((left, right) => {
    const statusOrder = (status: AiSessionView["status"]): number => {
      switch (status) {
        case "waiting_answer":
          return 0;
        case "waiting_approval":
          return 1;
        case "running":
          return 2;
        case "error":
          return 3;
        case "idle":
          return 4;
        case "completed":
          return 5;
      }
    };
    return statusOrder(left.status) - statusOrder(right.status)
      || right.created_at - left.created_at;
  })
  .map((session) => ({
    ...session,
    can_write: canAcceptWrite.value,
    can_send_ai: aiSessionCanSend(session),
    ai_send_disabled_reason: aiSessionDisabledReason(session),
  })));
const externalAgentWaitingCount = computed(() => {
  if (externalAgentState.value.kind !== "ready") {
    return 0;
  }
  return externalAgentState.value.value.proposals.filter((proposal) =>
    proposal.state.kind === "pending_approval"
  ).length;
});
const externalAgentRunningCount = computed(() => {
  if (externalAgentState.value.kind !== "ready") {
    return 0;
  }
  return externalAgentState.value.value.proposals.filter((proposal) =>
    proposal.state.kind === "approving"
  ).length;
});
const aiWaitingCount = computed(() => aiSessions.value.filter((session) =>
  session.status === "waiting_answer"
    || session.status === "waiting_approval"
    || session.status === "error"
).length + externalAgentWaitingCount.value);
const aiRunningCount = computed(() => aiSessions.value.filter((session) =>
  session.status === "running"
).length + externalAgentRunningCount.value);
const canOpenAiAssistant = computed(() => configured.value);
const canStartNewAiSession = computed(() => canAcceptWrite.value
  && codexState.value.kind === "ready");
const canReadLocal = computed(() => setupState.value?.kind === "ready");
const canReanalyzeObsidianNotes = computed(() => {
  return canAcceptWrite.value
    && codexState.value.kind === "ready"
    && registeredVaultIds.value.length > 0;
});
const visibleRows = computed(() => {
  const currentOverview = overview.value;
  if (currentOverview == null) {
    return [];
  }
  return filterTaskRows(currentOverview, filter.value, currentAsOf.value);
});

function aiSessionStatus(
  state: RendererAiState,
  operation: AiSessionOperation,
): AiSessionView["status"] {
  if (operation !== "idle" || state.kind === "streaming") {
    return "running";
  }
  switch (state.kind) {
    case "questions":
      if (state.questions.length > 0) {
        return "waiting_answer";
      }
      return state.pending_proposal == null ? "completed" : "waiting_approval";
    case "proposal":
      return "waiting_approval";
    case "unavailable":
      return "error";
    case "applied":
      return "completed";
    case "idle":
      return "idle";
  }
}

function requireAiSession(sessionId: string): AiSessionRecord {
  const session = aiSessions.value.find((candidate) => candidate.session_id === sessionId);
  if (session == null) {
    throw new Error("AI依頼が見つかりません。");
  }
  return session;
}

function updateAiSession(
  sessionId: string,
  update: (session: AiSessionRecord) => AiSessionRecord,
): void {
  let found = false;
  const nextSessions = aiSessions.value.map((session) => {
    if (session.session_id !== sessionId) {
      return session;
    }
    found = true;
    return update(session);
  });
  if (!found) {
    throw new Error("AI依頼が見つかりません。");
  }
  aiSessions.value = nextSessions;
}

function aiTaskTitle(taskGid: string | undefined): string | undefined {
  if (taskGid == null) {
    return undefined;
  }
  if (selectedTask.value?.gid === taskGid) {
    return selectedTask.value.title;
  }
  const currentOverview = overview.value;
  if (currentOverview == null) {
    return undefined;
  }
  return currentOverview.tasks.find((task) => task.gid === taskGid)?.title;
}

function aiRequestTitle(message: string): string {
  const compactMessage = message.replace(/\s+/gu, " ").trim();
  if (compactMessage.length === 0) {
    throw new Error("AI依頼文が空です。");
  }
  const characters = [...compactMessage];
  return characters.length > 40
    ? `${characters.slice(0, 40).join("")}…`
    : compactMessage;
}

function rememberAiRequest(sessionId: string, message: string): void {
  const title = aiRequestTitle(message);
  const entry = rendererAiConversationEntrySchema.parse({
    kind: "pending",
    request: message,
  });
  updateAiSession(sessionId, (session) => ({
    ...session,
    title: session.conversation_history.length === 0 ? title : session.title,
    conversation_history: [...session.conversation_history, entry],
  }));
}

function aiSessionCanSend(session: AiSessionRecord): boolean {
  return codexState.value.kind === "ready"
    && canAcceptWrite.value
    && session.operation === "idle";
}

function aiSessionDisabledReason(session: AiSessionRecord): string {
  switch (codexState.value.kind) {
    case "connecting":
      return "Codexの接続を確認しています。";
    case "authentication_required":
      return "CodexへログインするとAIを利用できます。";
    case "unavailable":
      return codexUnavailableReason(codexState.value.reason_code);
    case "ready":
      break;
  }
  if (!canAcceptWrite.value) {
    return "同期が完了するとAIを利用できます。";
  }
  if (session.operation !== "idle") {
    return "AIが回答を準備しています。";
  }
  return "";
}

function setAiSessionFeedback(
  sessionId: string,
  kind: FeedbackKind,
  message: string,
): void {
  updateAiSession(sessionId, (session) => ({ ...session, feedback: { kind, message } }));
}

function clearAiSessionFeedback(sessionId: string): void {
  updateAiSession(sessionId, (session) => ({ ...session, feedback: undefined }));
}

function setAiSynchronizationWaitingFeedback(sessionId: string): void {
  if (syncState.value.kind !== "syncing") {
    return;
  }
  setAiSessionFeedback(sessionId, "progress", aiSynchronizationWaitingMessage);
}

function clearAiSynchronizationWaitingFeedback(): void {
  if (syncState.value.kind === "syncing") {
    return;
  }
  aiSessions.value = aiSessions.value.map((session) => {
    if (session.feedback?.message !== aiSynchronizationWaitingMessage) {
      return session;
    }
    return { ...session, feedback: undefined };
  });
}

function showAiSessionFailure(sessionId: string, value: IpcFailure): void {
  setAiSessionFeedback(sessionId, "failure", displayFailure(value).message);
}

function showAiSessionUnexpectedFailure(sessionId: string): void {
  setAiSessionFeedback(sessionId, "failure", "予期しないエラーが発生しました。もう一度お試しください。");
}

function showAiSessionFocusFailure(sessionId: string): void {
  setAiSessionFeedback(sessionId, "warning", "新しいAIセッションを開始しましたが、入力欄へ移動できませんでした。");
}

function setAiDialogFeedback(kind: FeedbackKind, message: string): void {
  aiDialogFeedback.value = { kind, message };
}

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

function applyExternalAgentState(value: ExternalAgentGuiState): void {
  externalAgentState.value = {
    kind: "ready",
    value: externalAgentGuiStateSchema.parse(value),
  };
}

function showExternalAgentUnexpectedFailure(): void {
  if (externalAgentState.value.kind === "loading") {
    externalAgentState.value = {
      kind: "error",
      message: "外部提案の状態を取得できませんでした。もう一度お試しください。",
    };
  }
  setAiDialogFeedback("failure", "外部提案の状態を更新できませんでした。もう一度お試しください。");
}

async function loadInitialExternalAgentState(): Promise<void> {
  try {
    const result = await taskHub.externalAgent.getState();
    if (isFailure(result)) {
      externalAgentState.value = { kind: "error", message: displayFailure(result).message };
      return;
    }
    applyExternalAgentState(result.value);
  } catch {
    showExternalAgentUnexpectedFailure();
  }
}

async function setExternalAgentEnabled(enabled: boolean): Promise<void> {
  if (externalAgentBusy.value) {
    return;
  }
  externalAgentBusy.value = true;
  setAiDialogFeedback("progress", "外部連携の設定を更新しています。");
  try {
    const result = await taskHub.externalAgent.setEnabled(
      externalAgentGuiSetEnabledInputSchema.parse({ enabled }),
    );
    if (isFailure(result)) {
      setAiDialogFeedback("failure", displayFailure(result).message);
      return;
    }
    applyExternalAgentState(result.value);
    setAiDialogFeedback("success", enabled ? "外部連携を有効にしました。" : "外部連携を停止しました。");
  } catch {
    showExternalAgentUnexpectedFailure();
  } finally {
    externalAgentBusy.value = false;
  }
}

async function editExternalAgentProposal(input: ExternalAgentGuiEditInput): Promise<void> {
  if (externalAgentBusy.value) {
    return;
  }
  externalAgentEditResult.value = undefined;
  externalAgentBusy.value = true;
  setAiDialogFeedback("progress", "外部提案を更新しています。");
  try {
    const result = await taskHub.externalAgent.edit(externalAgentGuiEditInputSchema.parse(input));
    if (isFailure(result)) {
      externalAgentEditResult.value = {
        kind: "failed",
        proposal_id: input.proposal_id,
        revision: input.revision,
      };
      setAiDialogFeedback("failure", displayFailure(result).message);
      return;
    }
    applyExternalAgentState(result.value);
    externalAgentEditResult.value = {
      kind: "saved",
      proposal_id: input.proposal_id,
      revision: input.revision,
    };
    setAiDialogFeedback("success", "外部提案を更新しました。");
  } catch {
    externalAgentEditResult.value = {
      kind: "failed",
      proposal_id: input.proposal_id,
      revision: input.revision,
    };
    setAiDialogFeedback("failure", "外部提案を更新できませんでした。入力内容を確認して再試行してください。");
  } finally {
    externalAgentBusy.value = false;
  }
}

async function approveExternalAgentProposal(input: ExternalAgentGuiApproveInput): Promise<void> {
  if (externalAgentBusy.value) {
    return;
  }
  externalAgentBusy.value = true;
  setAiDialogFeedback("progress", "外部提案を承認しています。");
  try {
    const result = await taskHub.externalAgent.approve(externalAgentGuiApproveInputSchema.parse(input));
    if (isFailure(result)) {
      setAiDialogFeedback("failure", displayFailure(result).message);
      return;
    }
    applyExternalAgentState(result.value);
    setAiDialogFeedback("success", "外部提案の承認を受け付けました。");
  } catch {
    showExternalAgentUnexpectedFailure();
  } finally {
    externalAgentBusy.value = false;
  }
}

async function rejectExternalAgentProposal(input: ExternalAgentGuiRejectInput): Promise<void> {
  if (externalAgentBusy.value) {
    return;
  }
  externalAgentBusy.value = true;
  setAiDialogFeedback("progress", "外部提案を却下しています。");
  try {
    const result = await taskHub.externalAgent.reject(externalAgentGuiRejectInputSchema.parse(input));
    if (isFailure(result)) {
      setAiDialogFeedback("failure", displayFailure(result).message);
      return;
    }
    applyExternalAgentState(result.value);
    setAiDialogFeedback("success", "外部提案を却下しました。");
  } catch {
    showExternalAgentUnexpectedFailure();
  } finally {
    externalAgentBusy.value = false;
  }
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

function codexUnavailableReason(
  reasonCode: Extract<RendererCodexState, { readonly kind: "unavailable" }>["reason_code"],
): string {
  switch (reasonCode) {
    case "not_installed":
      return "AIは利用できません。Codex CLIが見つかりません。";
    case "incompatible":
      return "AIは利用できません。対応していないCodex CLIです。";
    case "permission_denied":
      return "AIは利用できません。Codexの権限を確認できません。";
    case "startup_failed":
      return "AIは利用できません。Codexの起動に失敗しました。";
    case "disabled":
      return "AIは利用できません。Codexは安全確認により停止しています。";
    case "stopped":
      return "AIは利用できません。Codexは停止しています。";
  }
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

function unavailableFeedbackKind(): FeedbackKind {
  if (connectionState.value.kind === "checking" || syncState.value.kind === "syncing") {
    return "progress";
  }
  return "warning";
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

function syncFeedbackKind(result: IpcSyncResult): FeedbackKind {
  const hasConflict = result.application_result.operations.some(
    (operation) => operation.outcome === "conflict",
  );
  const remainingWriteCount = result.remaining_plan.status_write_task_gids.length
    + result.remaining_plan.external_write_task_gids.length
    + result.remaining_plan.tag_write_task_gids.length;
  if (hasConflict || remainingWriteCount > 0 || result.critical_errors.length > 0) {
    return "warning";
  }
  return "success";
}

function createSyncFeedback(result: IpcSyncResult): Feedback {
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
  return {
    kind: syncFeedbackKind(result),
    message: synchronizationSummary,
  };
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
      switch (result.reason_code) {
        case "offline":
          return "オフラインのため変更できませんでした。";
        case "baseline_changed":
          return "最新状態と競合しました。最新内容を確認して編集し直してください。";
        case "task_missing":
          return "対象タスクが見つからないため変更しませんでした。未保存の入力は再適用しません。";
        case "synchronization_failed":
          return "同期が完了しなかったため変更を送信しませんでした。未保存の入力を保持しています。";
        case "context_changed":
          return "接続先が変わったため変更を送信しませんでした。未保存の入力を保持しています。";
      }
      throw new Error("GUI編集拒否理由が不正です。");
    case "recovery_required":
      return recoveryRequiredFeedback(result.write_outcome);
  }
}

function guiEditFeedbackKind(result: IpcGuiEditResult): FeedbackKind {
  switch (result.outcome) {
    case "applied":
    case "already_applied":
      return "success";
    case "conflict":
    case "rejected":
    case "recovery_required":
      return "warning";
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

function updateGuiEditStatesForSync(sync: RendererSyncState): void {
  if (sync.kind === "syncing" || guiEditStates.value.size === 0) {
    return;
  }
  const nextStates = new Map(guiEditStates.value);
  let changed = false;
  for (const [taskGid, state] of nextStates) {
    if (state.kind !== "waiting_sync") {
      continue;
    }
    nextStates.set(taskGid, { ...state, kind: "saving" });
    changed = true;
  }
  if (changed) {
    guiEditStates.value = nextStates;
  }
}

function setConnectionState(kind: RendererConnectionState["kind"], sync: RendererSyncState): void {
  connectionState.value = rendererConnectionStateSchema.parse({ kind, sync });
  updateGuiEditStatesForSync(sync);
  clearAiSynchronizationWaitingFeedback();
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
      rendererSyncStateSchema.parse({
        kind: "syncing",
        can_accept_write: value.last_successful_sync_at != null && value.last_error_code == null,
      }),
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

function showNormalizationNotificationToast(
  syncedAt: string,
  notifications: readonly SyncNormalizationNotification[],
): void {
  if (notifications.length === 0) {
    return;
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
  addToast("success", notificationFeedback);
  normalizationNotificationDisplayState = {
    kind: "displayed",
    synced_at: syncedAt,
  };
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
  showNormalizationNotificationToast(syncedAt, notifications);
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
    const result = await taskHub.sync.getState();
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

function deselectTask(): void {
  clearTaskFeedback();
  clearTaskSelection();
}

function captureTaskDetailContext(): TaskDetailContext {
  const taskGid = selectedTaskGid.value;
  if (taskGid == null) {
    throw new Error("タスクが選択されていません。");
  }
  return {
    generation: taskDetailGeneration,
    taskGid,
  };
}

function isCurrentTaskDetailContext(context: TaskDetailContext): boolean {
  return context.generation === taskDetailGeneration
    && selectedTaskGid.value === context.taskGid;
}

function isTaskDataRefreshSuccessful(result: TaskDataRefreshResult): boolean {
  return result.kind === "applied" || result.kind === "unchanged";
}

function commitOverview(value: ViewModelOverview): void {
  const previousOverview = overview.value;
  if (previousOverview != null) {
    const nextTaskGids = new Set(value.tasks.map((task) => task.gid));
    for (const previousTask of previousOverview.tasks) {
      if (!nextTaskGids.has(previousTask.gid)) {
        setTaskEditMarker(previousTask.gid, { kind: "missing" });
      }
    }
  }
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

async function executeTaskDataRefresh(
  generation: number,
  detailGeneration: number,
  statusGeneration: number,
  taskGid: string | undefined,
): Promise<TaskDataRefreshResult> {
  try {
    const result = await taskHub.readModel.getOverview();
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
      setTaskEditMarker(taskGid, { kind: "missing" });
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        clearTaskFeedback();
        setTaskFeedback("warning", "対象タスクが同期で見つからなくなりました。未保存の入力は再適用しません。");
        clearTaskSelection();
      }
      return { kind: "applied" };
    }
    try {
      const detailResult = await taskHub.readModel.getTaskDetail(taskGid);
      if (isFailure(detailResult)) {
        if (detailResult.code === "not_found") {
          if (generation !== taskDataGeneration) {
            return { kind: "superseded" };
          }
          commitOverview(nextOverview);
          setTaskEditMarker(taskGid, { kind: "missing" });
          if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
            clearTaskFeedback();
            setTaskFeedback("warning", "対象タスクが同期で見つからなくなりました。未保存の入力は再適用しません。");
            clearTaskSelection();
          }
          return { kind: "applied" };
        }
        if (generation === taskDataGeneration
          && detailGeneration === taskDetailGeneration
          && selectedTaskGid.value === taskGid) {
          showTaskFailure(detailResult);
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
      if (generation === taskDataGeneration
        && detailGeneration === taskDetailGeneration
        && selectedTaskGid.value === taskGid) {
        showTaskUnexpectedFailure();
      }
      return { kind: "failed" };
    }
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
  const wasConfigured = configured.value;
  const wasLoading = screen.value.kind === "loading";
  const parsed = setupStateSchema.parse(value);
  setupState.value = parsed;
  setCodexFromSetup(parsed);
  if (parsed.kind === "ready") {
    screen.value = rendererScreenStateSchema.parse({ kind: "dashboard" });
    void reloadTaskData();
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
  screen.value = rendererScreenStateSchema.parse({ kind: "setup", setup: parsed });
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
      await loadInitialCodexStatus();
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
      setFeedback("warning", includeNormalizationNotificationFeedback(
        "Asanaの再認証と同期は完了しました。タスク表示を更新できませんでした。",
        synchronized.normalization_notifications,
      ));
      return;
    }
    showNormalizationNotificationToast(
      synchronized.synced_at,
      synchronized.normalization_notifications,
    );
    showGlobalResultFeedback({
      kind: syncFeedbackKind(synchronized),
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

async function runSynchronization(mode: "delta" | "full"): Promise<void> {
  if (!canManualSync.value) {
    return;
  }
  activeSyncMode.value = mode;
  setSyncState(rendererSyncStateSchema.parse({
    kind: "syncing",
    can_accept_write: canAcceptWrite.value,
  }));
  try {
    const result = await taskHub.sync.run({ mode });
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
      showNormalizationNotificationToast(
        result.value.synced_at,
        result.value.normalization_notifications,
      );
      showGlobalResultFeedback(syncFeedback);
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
  clearTaskFeedback();
  taskDetailGeneration += 1;
  obsidianStatusGeneration += 1;
  const detailGeneration = taskDetailGeneration;
  const statusGeneration = obsidianStatusGeneration;
  selectedTaskGid.value = taskGid;
  selectedTask.value = undefined;
  obsidianStatuses.value = new Map();
  try {
    const result = await taskHub.readModel.getTaskDetail(taskGid);
    if (isFailure(result)) {
      if (detailGeneration === taskDetailGeneration && selectedTaskGid.value === taskGid) {
        showTaskFailure(result);
        if (result.code === "not_found") {
          setTaskEditMarker(taskGid, { kind: "missing" });
          setTaskFeedback("warning", "対象タスクが見つかりません。未保存の入力は再適用しません。");
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
      showTaskUnexpectedFailure();
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
    const result = await taskHub.obsidian.noteExists(input);
    if (generation !== obsidianStatusGeneration) {
      return;
    }
    if (isFailure(result)) {
      showTaskFailure(result);
      return;
    }
    const statuses = new Map(obsidianStatuses.value);
    statuses.set(`${link.vault_id}\0${link.path}`, result.value.kind === "resolved" ? "exists" : "missing");
    obsidianStatuses.value = statuses;
  } catch {
    if (generation === obsidianStatusGeneration) {
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

async function readGuiEditTaskDetail(taskGid: string): Promise<GuiEditTaskDetailReadResult> {
  try {
    const result = await taskHub.readModel.getTaskDetail(taskGid);
    if (isFailure(result)) {
      return result.code === "not_found" ? { kind: "missing" } : { kind: "failed" };
    }
    return {
      kind: "available",
      detail: viewModelTaskDetailSchema.parse(result.value),
    };
  } catch {
    return { kind: "failed" };
  }
}

async function reloadTaskDataAfterGuiEdit(
  message: string,
  feedbackKind: FeedbackKind,
  taskGid: string,
  generation: number,
  saveSucceeded: boolean,
  operation: RendererGuiEdit["operation"],
): Promise<TaskDataRefreshResult> {
  const reloadPromise = reloadTaskData();
  let savedDetailResult: GuiEditTaskDetailReadResult | undefined;
  let readbackConfirmed = !saveSucceeded;
  if (saveSucceeded) {
    savedDetailResult = await readGuiEditTaskDetail(taskGid);
    if (isCurrentGuiEdit(taskGid, generation)) {
      if (savedDetailResult.kind === "available") {
        setTaskEditMarker(taskGid, {
          kind: "saved",
          operation,
          detail: savedDetailResult.detail,
        });
        readbackConfirmed = true;
      } else if (savedDetailResult.kind === "missing") {
        setTaskEditMarker(taskGid, { kind: "missing" });
      } else {
        setTaskEditMarker(taskGid, {
          kind: "saved",
          operation,
          detail: undefined,
        });
      }
    }
  }
  const result = await reloadPromise;
  if (!isCurrentGuiEdit(taskGid, generation)) {
    return result;
  }
  if (saveSucceeded && savedDetailResult?.kind === "failed") {
    const retryResult = await readGuiEditTaskDetail(taskGid);
    if (retryResult.kind === "available") {
      setTaskEditMarker(taskGid, {
        kind: "saved",
        operation,
        detail: retryResult.detail,
      });
      readbackConfirmed = true;
    } else if (retryResult.kind === "missing") {
      setTaskEditMarker(taskGid, { kind: "missing" });
    }
  }
  if (saveSucceeded && !readbackConfirmed) {
    showGuiEditResultFeedback(
      taskGid,
      "warning",
      savedDetailResult?.kind === "missing"
        ? "変更後の対象タスクを確認できません。未保存の入力は再適用しません。"
        : "変更は反映されましたが最新状態を確認できません。未保存の入力を保持しています。",
    );
  } else {
    showGuiEditResultFeedback(taskGid, feedbackKind, message);
  }
  return result;
}

async function reconcileSyncStateAfterGuiRecovery(
  taskGid: string,
  generation: number,
): Promise<void> {
  const result = await readCurrentSyncState();
  if (result.kind === "received" && isCurrentGuiEdit(taskGid, generation)) {
    applySyncStateDisplay(result.value);
  }
}

function isCurrentGuiEdit(taskGid: string, generation: number): boolean {
  return guiEditStates.value.get(taskGid)?.generation === generation;
}

function showGuiEditResultFeedback(
  taskGid: string,
  kind: FeedbackKind,
  message: string,
): void {
  if (selectedTaskGid.value === taskGid) {
    showTaskResultFeedback(kind, message);
    return;
  }
  addToast(kind === "success" ? "success" : "warning", message);
}

function setTaskEditMarker(
  taskGid: string,
  update: RendererTaskEditMarkerUpdate,
): void {
  taskEditMarkerGeneration += 1;
  const markers = new Map(taskEditMarkers.value);
  const marker: RendererTaskEditMarker = {
    generation: taskEditMarkerGeneration,
    ...update,
  };
  markers.set(taskGid, marker);
  taskEditMarkers.value = markers;
}

function finishGuiEdit(taskGid: string, generation: number): void {
  if (!isCurrentGuiEdit(taskGid, generation)) {
    return;
  }
  const nextStates = new Map(guiEditStates.value);
  nextStates.delete(taskGid);
  guiEditStates.value = nextStates;
}

async function applyGuiEdit(input: RendererGuiEdit): Promise<void> {
  if (guiEditStates.value.has(input.task_gid)) {
    if (selectedTaskGid.value === input.task_gid) {
      setTaskFeedback("progress", "このタスクの保存が完了するまで追加の編集を待っています。");
    }
    return;
  }
  if (!canAcceptWrite.value) {
    setTaskFeedback(unavailableFeedbackKind(), writeUnavailableText("編集"));
    return;
  }
  const currentOverview = overview.value;
  if (currentOverview == null) {
    setTaskFeedback("warning", "タスク状態を読み込むまで編集できません。");
    return;
  }
  guiEditGeneration += 1;
  const generation = guiEditGeneration;
  guiEditStates.value = new Map(guiEditStates.value).set(input.task_gid, {
    taskGid: input.task_gid,
    generation,
    kind: syncState.value.kind === "syncing" ? "waiting_sync" : "saving",
  });
  try {
    let completion: GuiEditCompletion;
    let validatedResult: IpcGuiEditResult | undefined;
    try {
      const validatedInput = ipcGuiEditInputSchema.parse({
        task_gid: input.task_gid,
        expected_task_hash: input.edit_baseline_hash,
        operation: input.operation,
      });
      const result = await taskHub.gui.apply(validatedInput);
      if (isFailure(result)) {
        completion = {
          kind: "settled",
          feedbackKind: "failure",
          message: displayFailure(result).message,
          save: "failed",
        };
      } else {
        validatedResult = ipcGuiEditResultSchema.parse(result.value);
        if (validatedResult.outcome === "recovery_required") {
          completion = {
            kind: "recovery_required",
            feedbackKind: guiEditFeedbackKind(validatedResult),
            message: guiEditResultFeedback(validatedResult),
            save: validatedResult.write_outcome === "unknown" ? "unknown" : "succeeded",
          };
        } else {
          completion = {
            kind: "settled",
            feedbackKind: guiEditFeedbackKind(validatedResult),
            message: guiEditResultFeedback(validatedResult),
            save: validatedResult.outcome === "applied" || validatedResult.outcome === "already_applied"
              ? "succeeded"
              : "failed",
          };
        }
      }
    } catch {
      completion = {
        kind: "settled",
        feedbackKind: "failure",
        message: "予期しないエラーが発生しました。もう一度お試しください。",
        save: "failed",
      };
    }
    if (validatedResult?.outcome === "conflict") {
      setTaskEditMarker(input.task_gid, { kind: "conflict" });
    }
    if (validatedResult?.outcome === "rejected") {
      if (validatedResult.reason_code === "baseline_changed") {
        setTaskEditMarker(input.task_gid, { kind: "conflict" });
      } else if (validatedResult.reason_code === "task_missing") {
        setTaskEditMarker(input.task_gid, { kind: "missing" });
      }
    }
    if (completion.kind === "recovery_required") {
      const reloadResult = await reloadTaskDataAfterGuiEdit(
        completion.message,
        completion.feedbackKind,
        input.task_gid,
        generation,
        false,
        input.operation,
      );
      if (isTaskDataRefreshSuccessful(reloadResult)) {
        await reconcileSyncStateAfterGuiRecovery(input.task_gid, generation);
      }
      return;
    }
    await reloadTaskDataAfterGuiEdit(
      completion.message,
      completion.feedbackKind,
      input.task_gid,
      generation,
      completion.save === "succeeded",
      input.operation,
    );
  } finally {
    finishGuiEdit(input.task_gid, generation);
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

function conversationEntryForState(
  entry: RendererAiConversationEntry,
  state: RendererAiState,
): RendererAiConversationEntry {
  switch (state.kind) {
    case "streaming":
      if (entry.kind !== "pending" && entry.kind !== "streaming") {
        throw new Error("AI会話の応答状態を更新できません。");
      }
      return rendererAiConversationEntrySchema.parse({
        kind: "streaming",
        request: entry.request,
        text: state.text,
      });
    case "questions":
    case "proposal":
      if (
        entry.kind !== "pending"
        && entry.kind !== "streaming"
        && entry.kind !== "failure"
      ) {
        throw new Error("AI会話の応答状態を完了できません。");
      }
      return rendererAiConversationEntrySchema.parse({
        kind: "response",
        request: entry.request,
        message: state.message,
        questions: state.questions,
      });
    case "unavailable":
      if (
        entry.kind !== "pending"
        && entry.kind !== "streaming"
        && entry.kind !== "failure"
      ) {
        throw new Error("AI会話の失敗状態を更新できません。");
      }
      return rendererAiConversationEntrySchema.parse({
        kind: "failure",
        request: entry.request,
        failure: state.failure,
      });
    case "idle":
    case "applied":
      throw new Error("AI会話履歴へ記録できないAI状態です。");
  }
}

function setAiSessionStateAndConversation(
  sessionId: string,
  state: RendererAiState,
): void {
  updateAiSession(sessionId, (session) => {
    const lastEntry = session.conversation_history.at(-1);
    if (lastEntry == null) {
      throw new Error("AI会話履歴が空です。");
    }
    const conversationHistory = [...session.conversation_history];
    conversationHistory[conversationHistory.length - 1] = conversationEntryForState(
      lastEntry,
      state,
    );
    return {
      ...session,
      state,
      status: aiSessionStatus(state, session.operation),
      conversation_history: conversationHistory,
    };
  });
}

function setAiSessionState(sessionId: string, state: RendererAiState): void {
  updateAiSession(sessionId, (session) => ({
    ...session,
    state,
    status: aiSessionStatus(state, session.operation),
  }));
}

function setAiSessionOperation(
  sessionId: string,
  operation: AiSessionOperation,
): void {
  updateAiSession(sessionId, (session) => ({
    ...session,
    operation,
    status: aiSessionStatus(session.state, operation),
  }));
}

function clearAiSessionOperation(
  sessionId: string,
  operation: Exclude<AiSessionOperation, "idle">,
): void {
  if (!hasAiSession(sessionId) || requireAiSession(sessionId).operation !== operation) {
    return;
  }
  if (requireAiSession(sessionId).feedback?.message === aiSynchronizationWaitingMessage) {
    clearAiSessionFeedback(sessionId);
  }
  setAiSessionOperation(sessionId, "idle");
}

function hasAiSession(sessionId: string): boolean {
  return aiSessions.value.some((session) => session.session_id === sessionId);
}

function appendDelta(delta: { readonly session_id: string; readonly delta: string }): void {
  if (!hasAiSession(delta.session_id)) {
    return;
  }
  const session = requireAiSession(delta.session_id);
  if (session.state.kind !== "streaming") {
    return;
  }
  try {
    const text = `${session.state.text}${delta.delta}`;
    setAiSessionStateAndConversation(delta.session_id, rendererAiStateSchema.parse({
      kind: "streaming",
      text,
      ...(session.state.pending_proposal == null
        ? {}
        : { pending_proposal: session.state.pending_proposal }),
    }));
  } catch {
    const pendingProposal = pendingAiProposal(session.state);
    const failure = rendererFailureSchema.parse({
      kind: "error",
      code: "invalid_response",
      message: failureText("invalid_response"),
    });
    setAiSessionStateAndConversation(delta.session_id, rendererAiStateSchema.parse({
      kind: "unavailable",
      failure,
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    }));
  }
}

function openAiAssistant(): void {
  if (!aiDialogVisible.value) {
    const activeElement = document.activeElement;
    aiDialogReturnFocus.value = activeElement instanceof HTMLElement ? activeElement : null;
  }
  aiDialogVisible.value = true;
}

watch(() => externalAgentState.value.kind === "ready"
  ? externalAgentState.value.value.review_target?.request_id
  : undefined, (requestId) => {
  if (requestId != null) {
    openAiAssistant();
  }
});

function closeAiAssistant(): void {
  aiDialogVisible.value = false;
  const target = aiDialogReturnFocus.value;
  aiDialogReturnFocus.value = null;
  if (target != null && target.isConnected) {
    target.focus();
    return;
  }
  const trigger = document.querySelector<HTMLElement>("[data-ai-assistant-trigger]");
  trigger?.focus();
}

function removeAiSession(sessionId: string): void {
  const remaining = aiSessions.value.filter((session) => session.session_id !== sessionId);
  if (remaining.length === aiSessions.value.length) {
    throw new Error("AI依頼が見つかりません。");
  }
  aiSessions.value = remaining;
  if (aiSelectedSessionId.value === sessionId) {
    aiSelectedSessionId.value = remaining[0]?.session_id;
  }
}

async function createAiSession(taskGid: string | undefined): Promise<string | undefined> {
  if (aiSessionCreating.value) {
    return undefined;
  }
  aiSessionCreating.value = true;
  setAiDialogFeedback("progress", "AI依頼を開始しています。");
  try {
    const result = await taskHub.ai.startNewSession();
    if (isFailure(result)) {
      setAiDialogFeedback("failure", displayFailure(result).message);
      return undefined;
    }
    if (result.value.kind === "authentication_required") {
      codexState.value = rendererCodexStateSchema.parse({ kind: "authentication_required" });
      setAiDialogFeedback("failure", "CodexへログインするとAIを利用できます。");
      return undefined;
    }
    const sessionId = result.value.session_id;
    if (sessionId.trim().length === 0) {
      throw new Error("AIセッションIDが空です。");
    }
    const state = rendererAiStateSchema.parse({ kind: "idle" });
    const taskTitle = aiTaskTitle(taskGid);
    const session: AiSessionRecord = {
      session_id: sessionId,
      title: taskTitle == null ? "新しいAI依頼" : taskTitle,
      ...(taskGid == null ? {} : { task_gid: taskGid }),
      ...(taskTitle == null ? {} : { task_title: taskTitle }),
      state,
      status: aiSessionStatus(state, "idle"),
      operation: "idle",
      feedback: undefined,
      conversation_history: [],
      created_at: Date.now(),
    };
    aiSessions.value = [...aiSessions.value, session];
    aiSelectedSessionId.value = sessionId;
    aiDialogFeedback.value = undefined;
    addToast("success", `AI依頼「${session.title}」を開始しました。`);
    return sessionId;
  } catch {
    setAiDialogFeedback("failure", "AIセッションを開始できませんでした。もう一度お試しください。");
    return undefined;
  } finally {
    aiSessionCreating.value = false;
  }
}

async function startAiSession(): Promise<void> {
  openAiAssistant();
  if (!canStartNewAiSession.value) {
    setAiDialogFeedback(unavailableFeedbackKind(), "新しいAI依頼は現在利用できません。");
    return;
  }
  const sessionId = await createAiSession(selectedTaskGid.value);
  if (sessionId == null) {
    return;
  }
  await nextTick();
  const dialog = aiDialogRef.value;
  if (dialog == null) {
    showAiSessionFocusFailure(sessionId);
    return;
  }
  switch (dialog.focusSessionInput(sessionId)) {
    case "focused":
      return;
    case "unavailable":
      showAiSessionFocusFailure(sessionId);
      return;
    default:
      throw new Error("AI入力欄のフォーカス結果が不正です。");
  }
}

async function startAiTurn(sessionId: string, input: AiWorkflowTurnRequest): Promise<void> {
  const session = requireAiSession(sessionId);
  if (session.operation !== "idle") {
    return;
  }
  clearAiSessionFeedback(sessionId);
  if (!aiSessionCanSend(session)) {
    setAiSessionFeedback(sessionId, unavailableFeedbackKind(), aiSessionDisabledReason(session));
    return;
  }
  const validatedInput = aiWorkflowTurnRequestSchema.parse(input);
  rememberAiRequest(sessionId, validatedInput.message);
  const pendingProposal = pendingAiProposal(session.state);
  setAiSessionOperation(sessionId, "turn");
  setAiSynchronizationWaitingFeedback(sessionId);
  try {
    const currentSession = requireAiSession(sessionId);
    const request = ipcAiTurnInputSchema.parse({
      session_id: sessionId,
      message: validatedInput.message,
      ...(currentSession.task_gid == null ? {} : { target_task_gid: currentSession.task_gid }),
    });
    setAiSessionStateAndConversation(sessionId, rendererAiStateSchema.parse({
      kind: "streaming",
      text: "",
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    }));
    const result = await taskHub.ai.startTurn(request);
    if (!hasAiSession(sessionId)) {
      return;
    }
    if (isFailure(result)) {
      const failure = displayFailure(result);
      setAiSessionStateAndConversation(sessionId, rendererAiStateSchema.parse({
        kind: "unavailable",
        failure,
        ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
      }));
      return;
    }
    if (result.value.kind === "proposal") {
      const proposal = aiWorkflowProposalViewSchema.parse(result.value.proposal);
      setAiSessionStateAndConversation(sessionId, rendererAiStateSchema.parse({
        kind: "proposal",
        message: result.value.message,
        questions: result.value.questions,
        proposal,
      }));
      return;
    }
    setAiSessionStateAndConversation(sessionId, rendererAiStateSchema.parse({
      kind: "questions",
      message: result.value.message,
      questions: result.value.questions,
      ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
    }));
  } catch {
    if (hasAiSession(sessionId)) {
      const currentEntry = requireAiSession(sessionId).conversation_history.at(-1);
      if (currentEntry == null) {
        throw new Error("AI会話履歴が空です。");
      }
      if (currentEntry.kind === "response") {
        return;
      }
      const failure = rendererFailureSchema.parse({
        kind: "error",
        code: "invalid_response",
        message: failureText("invalid_response"),
      });
      setAiSessionStateAndConversation(sessionId, rendererAiStateSchema.parse({
        kind: "unavailable",
        failure,
        ...(pendingProposal == null ? {} : { pending_proposal: pendingProposal }),
      }));
    }
  } finally {
    clearAiSessionOperation(sessionId, "turn");
  }
}

async function reanalyzeObsidianNotes(taskGid: string): Promise<void> {
  if (!canReanalyzeObsidianNotes.value) {
    setTaskFeedback("warning", "関連ノートの再解析は現在利用できません。");
    return;
  }
  const request = aiWorkflowTurnRequestSchema.parse({
    message: `タスクGID ${taskGid} について、登録済みVaultを検索して関連ノートを再解析してください。明確に関連すると判断できる候補だけを、Obsidianリンクの追加または修正の変更案として提示してください。変更を自動適用せず、必ず承認待ちの変更案にしてください。`,
  });
  openAiAssistant();
  const sessionId = await createAiSession(taskGid);
  if (sessionId == null) {
    return;
  }
  await startAiTurn(sessionId, request);
}

function proposalState(sessionId: string, proposal: AiWorkflowProposalView): void {
  const currentState = requireAiSession(sessionId).state;
  if (currentState.kind === "proposal") {
    setAiSessionState(sessionId, rendererAiStateSchema.parse({
      kind: "proposal",
      message: currentState.message,
      questions: currentState.questions,
      proposal,
    }));
    return;
  }
  const pendingProposal = pendingAiProposal(currentState);
  const message = pendingProposal?.message ?? "変更案を更新しました。";
  if (currentState.kind === "questions") {
    setAiSessionState(sessionId, rendererAiStateSchema.parse({
      kind: "questions",
      message: currentState.message,
      questions: currentState.questions,
      pending_proposal: { message, proposal },
    }));
    return;
  }
  setAiSessionState(sessionId, rendererAiStateSchema.parse({ kind: "proposal", message, questions: [], proposal }));
}

async function selectAiProposal(sessionId: string, input: AiWorkflowSelectionRequest): Promise<void> {
  const session = requireAiSession(sessionId);
  if (session.operation !== "idle") {
    return;
  }
  clearAiSessionFeedback(sessionId);
  setAiSessionOperation(sessionId, "select");
  try {
    const request = ipcAiSelectionInputSchema.parse({ ...input, session_id: sessionId });
    const result = await taskHub.ai.select(request);
    if (!hasAiSession(sessionId)) {
      return;
    }
    if (isFailure(result)) {
      showAiSessionFailure(sessionId, result);
      return;
    }
    proposalState(sessionId, aiWorkflowProposalViewSchema.parse(result.value));
  } catch {
    if (hasAiSession(sessionId)) {
      showAiSessionUnexpectedFailure(sessionId);
    }
  } finally {
    clearAiSessionOperation(sessionId, "select");
  }
}

async function editAiOperation(sessionId: string, input: AiWorkflowOperationEdit): Promise<void> {
  const session = requireAiSession(sessionId);
  if (session.operation !== "idle") {
    return;
  }
  clearAiSessionFeedback(sessionId);
  setAiSessionOperation(sessionId, "edit");
  try {
    const request = ipcAiEditInputSchema.parse({ ...input, session_id: sessionId });
    const result = await taskHub.ai.editOperation(request);
    if (!hasAiSession(sessionId)) {
      return;
    }
    if (isFailure(result)) {
      showAiSessionFailure(sessionId, result);
      return;
    }
    proposalState(sessionId, aiWorkflowProposalViewSchema.parse(result.value));
  } catch {
    if (hasAiSession(sessionId)) {
      showAiSessionUnexpectedFailure(sessionId);
    }
  } finally {
    clearAiSessionOperation(sessionId, "edit");
  }
}

async function approveAiProposal(sessionId: string, input: AiWorkflowApprovalRequest): Promise<void> {
  const session = requireAiSession(sessionId);
  if (session.operation !== "idle") {
    return;
  }
  clearAiSessionFeedback(sessionId);
  if (!canAcceptWrite.value) {
    setAiSessionFeedback(sessionId, unavailableFeedbackKind(), writeUnavailableText("変更案の適用"));
    return;
  }
  setAiSessionOperation(sessionId, "approve");
  setAiSynchronizationWaitingFeedback(sessionId);
  try {
    const request = ipcAiApprovalInputSchema.parse({ ...input, session_id: sessionId });
    const result = await taskHub.ai.approve(request);
    if (!hasAiSession(sessionId)) {
      return;
    }
    if (isFailure(result)) {
      showAiSessionFailure(sessionId, result);
      return;
    }
    setAiSessionState(sessionId, rendererAiStateSchema.parse({
      kind: "applied",
      message: "適用結果を確認してください。",
      result: result.value,
    }));
    await manualSync();
  } catch {
    if (hasAiSession(sessionId)) {
      showAiSessionUnexpectedFailure(sessionId);
    }
  } finally {
    clearAiSessionOperation(sessionId, "approve");
  }
}

async function rejectAiProposal(sessionId: string, proposalId: string): Promise<void> {
  const session = requireAiSession(sessionId);
  if (session.operation !== "idle") {
    return;
  }
  clearAiSessionFeedback(sessionId);
  setAiSessionOperation(sessionId, "reject");
  try {
    const result = await taskHub.ai.reject({ session_id: sessionId, proposal_id: proposalId });
    if (!hasAiSession(sessionId)) {
      return;
    }
    if (isFailure(result)) {
      showAiSessionFailure(sessionId, result);
      return;
    }
    setAiSessionState(sessionId, rendererAiStateSchema.parse({ kind: "idle" }));
    addToast("warning", `AI依頼「${session.title}」の変更案を却下しました。`);
  } catch {
    if (hasAiSession(sessionId)) {
      showAiSessionUnexpectedFailure(sessionId);
    }
  } finally {
    clearAiSessionOperation(sessionId, "reject");
  }
}

async function closeAiSession(sessionId: string): Promise<void> {
  if (!hasAiSession(sessionId)) {
    return;
  }
  const session = requireAiSession(sessionId);
  if (session.operation === "approve" || session.operation === "closing") {
    return;
  }
  setAiSessionOperation(sessionId, "closing");
  try {
    const result = await taskHub.ai.closeSession(ipcAiCloseSessionInputSchema.parse(sessionId));
    if (isFailure(result)) {
      showAiSessionFailure(sessionId, result);
      clearAiSessionOperation(sessionId, "closing");
      return;
    }
    removeAiSession(sessionId);
  } catch {
    if (hasAiSession(sessionId)) {
      showAiSessionUnexpectedFailure(sessionId);
      clearAiSessionOperation(sessionId, "closing");
    }
  }
}

function completeAiSession(sessionId: string): void {
  const session = requireAiSession(sessionId);
  if (session.status !== "completed" || session.operation === "approve" || session.operation === "closing") {
    return;
  }
  void closeAiSession(sessionId);
}

function cancelAiSession(sessionId: string): void {
  const session = requireAiSession(sessionId);
  if (session.status === "completed" || session.operation === "approve" || session.operation === "closing") {
    return;
  }
  void closeAiSession(sessionId);
}

function selectAiSession(sessionId: string): void {
  requireAiSession(sessionId);
  aiSelectedSessionId.value = sessionId;
}

function selectAiSessionTask(sessionId: string, taskGid: string): void {
  requireAiSession(sessionId);
  const validTaskGid = gidSchema.parse(taskGid);
  closeAiAssistant();
  void selectTask(validTaskGid);
}

async function loadInitialSyncState(): Promise<void> {
  try {
    const result = await taskHub.sync.getState();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    handleSyncState(result.value);
  } catch {
    setFeedback("failure", "同期状態を取得できませんでした。");
  }
}

async function loadInitialCodexStatus(): Promise<void> {
  try {
    const result = await taskHub.ai.getStatus();
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
    removeSyncSubscription = taskHub.sync.onState((value) => {
      try {
        handleSyncState(value);
      } catch {
        setFeedback("failure", "同期状態を確認できませんでした。");
      }
    });
  } catch {
    setSyncState(rendererSyncStateSchema.parse({ kind: "error", error_code: "unexpected_error" }));
  }
  try {
    removeAiSubscription = taskHub.ai.onDelta((delta) => {
      appendDelta(delta);
    });
  } catch {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      reason_code: "startup_failed",
    });
  }
  try {
    removeAiStatusSubscription = taskHub.ai.onStatus((value) => {
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
    setFeedback("failure", "Codex状態を購読できませんでした。");
  }
  try {
    removeExternalAgentSubscription = taskHub.externalAgent.onChanged((value) => {
      try {
        applyExternalAgentState(value);
      } catch {
        showExternalAgentUnexpectedFailure();
      }
    });
  } catch {
    showExternalAgentUnexpectedFailure();
  }
  try {
    const result = await taskHub.setup.getState();
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
  if (setupState.value?.kind === "ready") {
    await loadAsanaAuthenticationState();
  }
  await loadInitialCodexStatus();
  await loadInitialExternalAgentState();
}

onMounted(() => {
  clockTimer = window.setInterval(() => {
    currentAsOf.value = new Date().toISOString();
  }, 60_000);
  void initialize();
});

onBeforeUnmount(() => {
  clearAsanaAuthorizationCode();
  asanaAuthenticationBusy.value = false;
  asanaAuthenticationStateRequestBusy.value = false;
  advanceAsanaAuthenticationStateGeneration();
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
  if (removeExternalAgentSubscription != null) {
    removeExternalAgentSubscription();
  }
});
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100 lg:flex lg:h-dvh lg:flex-col">
    <AppHeader
      :connection-state="connectionState"
      :configured="configured"
      :can-manual-sync="canManualSync"
      :can-full-sync="canManualSync"
      :full-sync-running="activeSyncMode === 'full'"
      :can-write="canAcceptWrite"
      :can-open-ai-assistant="canOpenAiAssistant"
      :ai-waiting-count="aiWaitingCount"
      :ai-running-count="aiRunningCount"
      :codex-state="codexState"
      :codex-authentication-busy="setupBusy"
      :asana-authentication-busy="asanaAuthenticationBusy"
      :asana-authentication-state-loaded="asanaAuthenticationStateLoaded"
      :asana-authentication-state-needs-recheck="asanaAuthenticationStateNeedsRecheck"
      :asana-authentication-state-request-busy="asanaAuthenticationStateRequestBusy"
      :asana-authentication-state="asanaAuthenticationState"
      @sync="manualSync"
      @full-sync="fullSync"
      @open-ai-assistant="openAiAssistant"
      @complete-codex-authentication="completeCodexAuthenticationFromHeader"
      @begin-reauthentication="beginAsanaReauthentication"
      @recheck-authentication-state="recheckAsanaAuthenticationState"
    />
    <AiSessionDialog
      ref="aiDialogRef"
      :open="aiDialogVisible"
      :can-start-new-session="canStartNewAiSession"
      :creating-session="aiSessionCreating"
      :feedback="aiDialogFeedback"
      :sessions="aiSessionViews"
      :tasks="aiTaskReferences"
      :selected-session-id="aiSelectedSessionId"
      :external-agent-state="externalAgentState"
      :external-agent-busy="externalAgentBusy"
      :external-agent-edit-result="externalAgentEditResult"
      :external-review-request-id="externalAgentState.kind === 'ready'
        ? externalAgentState.value.review_target?.request_id
        : undefined"
      @close="closeAiAssistant"
      @new-session="startAiSession"
      @select-session="selectAiSession"
      @start="startAiTurn"
      @select="selectAiProposal"
      @edit="editAiOperation"
      @approve="approveAiProposal"
      @reject="rejectAiProposal"
      @complete="completeAiSession"
      @cancel="cancelAiSession"
      @select-task="selectAiSessionTask"
      @external-set-enabled="setExternalAgentEnabled"
      @external-edit="editExternalAgentProposal"
      @external-approve="approveExternalAgentProposal"
      @external-reject="rejectExternalAgentProposal"
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
          {{ screen.failure.message }}
        </p>
      </div>
      <template v-else>
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
              <template #filters>
                <TaskFilters
                  v-model="filter"
                  :areas="overview.areas"
                  :disabled="false"
                />
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
                :task="selectedTask"
                :areas="overview.areas"
                :can-write="canAcceptWrite && !guiEditSaving"
                :saving-state="selectedGuiEditState?.kind ?? 'idle'"
                :task-edit-markers="taskEditMarkers"
                :read-available="canReadLocal"
                :obsidian-vault-ids="registeredVaultIds"
                :obsidian-statuses="obsidianStatuses"
                :can-reanalyze-obsidian-notes="canReanalyzeObsidianNotes"
                @edit="applyGuiEdit"
                @check-obsidian="checkObsidianLink"
                @open-obsidian="openObsidianLink"
                @reanalyze-obsidian-notes="reanalyzeObsidianNotes"
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
