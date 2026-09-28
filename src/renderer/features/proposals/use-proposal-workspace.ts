import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch, type Ref } from "vue";
import { gidSchema } from "../../../shared/ipc-contracts/common";
import { proposalsContracts, type ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { proposalFromState } from "./proposal-state";
import { useProposals } from "./use-proposals";
import type AiSessionDialog from "./AiSessionDialog.vue";
import type {
  AiConversationEntry,
  AiSessionStatus,
  AiSessionView,
  ExternalApprovalResult,
  ExternalEditInput,
  ExternalEditResult,
  ExternalRejectInput,
  ExternalSelectionInput,
  ExternalProposalViewState,
  Feedback,
  ProposalEditInput,
  ProposalSelectionInput,
} from "./proposal-presentation";

type TaskReference = { readonly gid: string; readonly title: string };
type SessionRecord = {
  readonly session_id: string;
  readonly title: string;
  readonly created_at: number;
  readonly task_gid?: string;
  readonly task_title?: string;
  readonly conversation_history: readonly AiConversationEntry[];
  readonly feedback?: Feedback | undefined;
};
type CodexState =
  | { readonly kind: "connecting" }
  | { readonly kind: "ready" }
  | { readonly kind: "authentication_required" }
  | { readonly kind: "unavailable"; readonly reason_code: "not_installed" | "incompatible" | "permission_denied" | "startup_failed" | "disabled" | "stopped" };
type Options = {
  readonly canWrite: Readonly<Ref<boolean>>;
  readonly tasks: Readonly<Ref<readonly TaskReference[]>>;
  readonly selectedTaskGid: Readonly<Ref<string | undefined>>;
  readonly closeSettings: () => void;
  readonly selectTask: (gid: string) => void | Promise<void>;
  readonly onToast: (kind: "success" | "warning", message: string) => void;
  readonly onSettingsFeedback: (feedback: Feedback | undefined) => void;
};
type DialogApi = { readonly focusSessionInput: (sessionId: string) => "focused" | "unavailable" };
type TurnInput = Pick<Parameters<ProposalsApi["startTurn"]>[0], "message">;

function sessionStatus(session: ReturnType<typeof useProposals>["sessions"]["value"][number], execution: ExecutionDto | undefined): AiSessionStatus {
  if (session.activity !== "idle" || session.state.kind === "turning") return "running";
  switch (session.state.kind) {
    case "proposal": return "waiting_approval";
    case "questions": return session.state.questions.length > 0 ? "waiting_answer"
      : session.state.pending_proposal == null ? "completed" : "waiting_approval";
    case "failed": return "error";
    case "approved": {
      if (session.state.result.kind === "not_started") return "completed";
      const state = execution?.state ?? session.state.result.execution.state;
      if (state === "planned" || state === "running") return "running";
      return state === "succeeded" ? "completed" : "error";
    }
    case "idle": return session.state.pending_proposal == null ? "idle" : "waiting_approval";
  }
}

function codexUnavailableReason(reason: Extract<CodexState, { kind: "unavailable" }>["reason_code"]): string {
  switch (reason) {
    case "not_installed": return "Codex CLIが見つかりません。";
    case "incompatible": return "対応していないCodex CLIです。";
    case "permission_denied": return "Codexの権限を確認できません。";
    case "startup_failed": return "Codexの起動に失敗しました。";
    case "disabled": return "Codexは安全確認により停止しています。";
    case "stopped": return "Codexは停止しています。";
  }
}

/** 提案画面の表示、操作、結果を単一の提案状態へ接続します。 */
export function useProposalWorkspace(options: Options) {
  const proposals = useProposals();
  const records = ref<readonly SessionRecord[]>([]);
  const selectedSessionId = ref<string>();
  const dialogVisible = ref(false);
  const dialogComponent = shallowRef<typeof AiSessionDialog>();
  const dialogRef = ref<DialogApi | null>(null);
  const dialogReturnFocus = ref<HTMLElement | null>(null);
  const dialogFeedback = ref<Feedback>();
  const sessionCreating = ref(false);
  const externalBusy = ref(false);
  const externalEditResult = ref<ExternalEditResult>();
  const externalApprovalResults = ref<Readonly<Record<string, ExternalApprovalResult>>>({});
  const codexHint = ref<CodexState>({ kind: "connecting" });
  const syncing = ref(false);
  let disposed = false;

  onBeforeUnmount(() => { disposed = true; });

  const codexState = computed<CodexState>(() => {
    const status = proposals.aiStatus.value;
    if (status == null) {
      if (proposals.aiStatusFailure.value != null) return { kind: "unavailable", reason_code: "startup_failed" };
      return codexHint.value;
    }
    switch (status.kind) {
      case "ready": return { kind: "ready" };
      case "authentication_required": return { kind: "authentication_required" };
      case "starting": return { kind: "connecting" };
      case "unavailable": return { kind: "unavailable", reason_code: status.reason_code };
    }
  });
  const externalState = computed<ExternalProposalViewState>(() => {
    if (proposals.externalState.value != null) return { kind: "ready", value: proposals.externalState.value };
    if (proposals.externalStateFailure.value != null) return { kind: "error", message: proposals.externalStateFailure.value.message };
    return { kind: "loading" };
  });
  const executions = computed(() => Object.values(proposals.executions.value).sort((left, right) =>
    right.created_at.localeCompare(left.created_at) || right.execution_id.localeCompare(left.execution_id)));
  const canStartNewSession = computed(() => options.canWrite.value && codexState.value.kind === "ready");
  const sessionViews = computed<readonly AiSessionView[]>(() => proposals.sessions.value.map((session) => {
    const record = records.value.find((candidate) => candidate.session_id === session.session_id);
    if (record == null) throw new Error("AI依頼の表示情報が見つかりません。");
    return {
      ...record,
      state: session.state,
      status: sessionStatus(session, session.state.kind === "approved" && session.state.result.kind === "execution"
        ? proposals.latestExecutionFor(session.state.result.execution.execution_id) : undefined),
      operation: session.activity,
      can_write: options.canWrite.value,
      can_send_ai: canStartNewSession.value && session.activity === "idle",
      ai_send_disabled_reason: aiSendDisabledReason(session.activity),
    };
  }).sort((left, right) => {
    const priority = (status: AiSessionStatus): number => {
      switch (status) {
        case "waiting_answer": return 0;
        case "waiting_approval": return 1;
        case "running": return 2;
        case "error": return 3;
        case "idle": return 4;
        case "completed": return 5;
      }
    };
    return priority(left.status) - priority(right.status) || right.created_at - left.created_at;
  }));
  const waitingCount = computed(() => sessionViews.value.filter((session) =>
    session.status === "waiting_answer" || session.status === "waiting_approval" || session.status === "error").length
    + (proposals.externalState.value?.proposals.filter((proposal) => proposal.state.kind === "pending_approval").length ?? 0));
  const runningCount = computed(() => sessionViews.value.filter((session) => session.status === "running").length
    + (proposals.externalState.value?.proposals.filter((proposal) => proposal.state.kind === "approving").length ?? 0));

  watch(() => proposals.externalState.value?.review_target?.request_id, (requestId) => {
    if (requestId != null) void openAssistant();
  });

  function aiSendDisabledReason(activity: AiSessionView["operation"]): string {
    switch (codexState.value.kind) {
      case "connecting": return "Codexの接続を確認しています。";
      case "authentication_required": return "CodexへログインするとAIを利用できます。";
      case "unavailable": return codexUnavailableReason(codexState.value.reason_code);
      case "ready": break;
    }
    if (!options.canWrite.value) return "同期が完了するとAIを利用できます。";
    if (activity !== "idle") return "AIが回答を準備しています。";
    return "";
  }

  function requireRecord(sessionId: string): SessionRecord {
    const record = records.value.find((candidate) => candidate.session_id === sessionId);
    if (record == null) throw new Error("AI依頼が見つかりません。");
    return record;
  }

  function updateRecord(sessionId: string, update: (record: SessionRecord) => SessionRecord): void {
    requireRecord(sessionId);
    records.value = records.value.map((record) => record.session_id === sessionId ? update(record) : record);
  }

  function setSessionFeedback(sessionId: string, kind: Feedback["kind"], message: string): void {
    updateRecord(sessionId, (record) => ({ ...record, feedback: { kind, message } }));
  }

  function clearSessionFeedback(sessionId: string): void {
    updateRecord(sessionId, (record) => ({ ...record, feedback: undefined }));
  }

  async function openAssistant(): Promise<void> {
    if (disposed) return;
    options.closeSettings();
    if (!dialogVisible.value) {
      const activeElement = document.activeElement;
      dialogReturnFocus.value = activeElement instanceof HTMLElement ? activeElement : null;
    }
    if (dialogComponent.value == null) {
      const module = await import("./AiSessionDialog.vue");
      if (disposed) return;
      dialogComponent.value = module.default;
    }
    dialogVisible.value = true;
  }

  function closeAssistant(): void {
    dialogVisible.value = false;
    const target = dialogReturnFocus.value;
    dialogReturnFocus.value = null;
    if (target != null && target.isConnected) {
      target.focus();
      return;
    }
    document.querySelector<HTMLElement>("[data-ai-assistant-trigger]")?.focus();
  }

  function setCodexHint(value: CodexState): void {
    codexHint.value = value;
  }

  async function initialize(): Promise<void> {
    await proposals.initialize();
  }

  async function refreshCodexStatus(): Promise<void> {
    await proposals.refreshAiStatus();
  }

  function handleSyncState(isSyncing: boolean): void {
    syncing.value = isSyncing;
    if (isSyncing) return;
    records.value = records.value.map((record) => record.feedback?.message === "同期の完了を待っています。"
      ? { ...record, feedback: undefined } : record);
  }

  function clearSyncWaitingFeedback(sessionId: string): void {
    const record = records.value.find((value) => value.session_id === sessionId);
    if (record?.feedback?.message === "同期の完了を待っています。") clearSessionFeedback(sessionId);
  }

  async function createSession(taskGid: string | undefined): Promise<string | undefined> {
    if (sessionCreating.value) return undefined;
    sessionCreating.value = true;
    dialogFeedback.value = { kind: "progress", message: "AI依頼を開始しています。" };
    try {
      const result = await proposals.startSession();
      if (disposed) return undefined;
      if (result.kind === "error") {
        dialogFeedback.value = { kind: "failure", message: result.message };
        return undefined;
      }
      if (result.value.kind === "authentication_required") {
        codexHint.value = { kind: "authentication_required" };
        dialogFeedback.value = { kind: "failure", message: "CodexへログインするとAIを利用できます。" };
        return undefined;
      }
      const taskTitle = taskGid == null ? undefined : options.tasks.value.find((task) => task.gid === taskGid)?.title;
      const title = taskTitle ?? "新しいAI依頼";
      records.value = [...records.value, {
        session_id: result.value.session_id,
        title,
        created_at: Date.now(),
        ...(taskGid == null ? {} : { task_gid: taskGid }),
        ...(taskTitle == null ? {} : { task_title: taskTitle }),
        conversation_history: [],
      }];
      selectedSessionId.value = result.value.session_id;
      dialogFeedback.value = undefined;
      options.onToast("success", `AI依頼「${title}」を開始しました。`);
      return result.value.session_id;
    } catch (error) {
      if (!disposed) dialogFeedback.value = { kind: "failure", message: "AI依頼を開始できませんでした。" };
      throw error;
    } finally {
      sessionCreating.value = false;
    }
  }

  async function startSession(): Promise<void> {
    await openAssistant();
    if (disposed) return;
    if (!canStartNewSession.value) {
      dialogFeedback.value = { kind: "warning", message: "新しいAI依頼は現在利用できません。" };
      return;
    }
    const sessionId = await createSession(options.selectedTaskGid.value);
    if (sessionId == null) return;
    await nextTick();
    if (disposed) return;
    const dialog = dialogRef.value;
    if (dialog == null) throw new Error("AIダイアログがマウントされていません。");
    if (dialog.focusSessionInput(sessionId) === "unavailable") {
      setSessionFeedback(sessionId, "warning", "新しいAIセッションを開始しましたが、入力欄へ移動できませんでした。");
    }
  }

  async function startTurn(sessionId: string, input: TurnInput): Promise<void> {
    const record = requireRecord(sessionId);
    if (record.conversation_history.at(-1)?.kind === "pending") throw new Error("AIターンは実行中です。");
    const currentSession = proposals.sessions.value.find((session) => session.session_id === sessionId);
    if (currentSession == null) throw new Error("AIセッションが見つかりません。");
    if (currentSession.activity !== "idle") return;
    if (!canStartNewSession.value) {
      setSessionFeedback(sessionId, "warning", aiSendDisabledReason(currentSession.activity));
      return;
    }
    const message = proposalsContracts.startTurn.request.shape.message.parse(input.message);
    const title = record.conversation_history.length === 0 ? [...message.replace(/\s+/gu, " ").trim()].slice(0, 40).join("") : record.title;
    updateRecord(sessionId, (value) => ({ ...value, title, feedback: undefined,
      conversation_history: [...value.conversation_history, { kind: "pending", request: message }] }));
    if (syncing.value) setSessionFeedback(sessionId, "progress", "同期の完了を待っています。");
    const baseProposal = proposalFromState(currentSession.state);
    const request = proposalsContracts.startTurn.request.parse({
      session_id: sessionId,
      message,
      ...(record.task_gid == null ? {} : { target_task_gid: record.task_gid }),
      ...(baseProposal == null ? {} : { base_proposal_id: baseProposal.proposal_id }),
    });
    try {
      const result = await proposals.startTurn(request);
      if (disposed) return;
      const latest = records.value.find((value) => value.session_id === sessionId);
      if (latest == null) return;
      if (result.kind === "error") {
        updateRecord(sessionId, (value) => ({ ...value,
          conversation_history: [...value.conversation_history.slice(0, -1), { kind: "failure", request: message, failure: result }] }));
        setSessionFeedback(sessionId, "failure", result.message);
        return;
      }
      const state = proposals.sessions.value.find((session) => session.session_id === sessionId)?.state;
      if (state == null || (state.kind !== "proposal" && state.kind !== "questions") || state.turn_id !== result.value.turn_id) {
        throw new Error("AIターンの表示状態が一致しません。");
      }
      updateRecord(sessionId, (value) => ({ ...value,
        conversation_history: [...value.conversation_history.slice(0, -1), {
          kind: "response", request: message, message: result.value.message,
          questions: result.value.questions, text: state.text,
        }] }));
    } catch (error) {
      if (!disposed && records.value.some((value) => value.session_id === sessionId)) {
        updateRecord(sessionId, (value) => ({ ...value,
          conversation_history: value.conversation_history.at(-1)?.kind === "pending"
            ? value.conversation_history.slice(0, -1) : value.conversation_history }));
        setSessionFeedback(sessionId, "failure", "AIの応答を確認できませんでした。");
      }
      throw error;
    } finally {
      if (!disposed) clearSyncWaitingFeedback(sessionId);
    }
  }

  async function requestTaskNoteAnalysis(taskGid: string): Promise<void> {
    const gid = gidSchema.parse(taskGid);
    await openAssistant();
    if (!canStartNewSession.value) {
      dialogFeedback.value = { kind: "warning", message: "関連ノートの再解析は現在利用できません。" };
      return;
    }
    const sessionId = await createSession(gid);
    if (sessionId == null) return;
    await startTurn(sessionId, { message: `タスクGID ${gid} について、登録済みVaultを検索して関連ノートを再解析してください。明確に関連すると判断できる候補だけを、Obsidianリンクの追加または修正の変更案として提示してください。変更を自動適用せず、必ず承認待ちの変更案にしてください。` });
  }

  async function select(sessionId: string, input: ProposalSelectionInput): Promise<void> {
    clearSessionFeedback(sessionId);
    try {
      const result = await proposals.select({ ...input, session_id: sessionId });
      if (disposed) return;
      if (result.kind === "error") setSessionFeedback(sessionId, "failure", result.message);
    } catch (error) {
      if (!disposed) setSessionFeedback(sessionId, "failure", "変更案の選択範囲を更新できませんでした。");
      throw error;
    }
  }

  async function edit(sessionId: string, input: ProposalEditInput): Promise<void> {
    clearSessionFeedback(sessionId);
    try {
      const result = await proposals.editOperation(proposalsContracts.editOperation.request.parse({ ...input, session_id: sessionId }));
      if (disposed) return;
      if (result.kind === "error") setSessionFeedback(sessionId, "failure", result.message);
    } catch (error) {
      if (!disposed) setSessionFeedback(sessionId, "failure", "変更案の操作を保存できませんでした。");
      throw error;
    }
  }

  async function approve(sessionId: string, input: ProposalSelectionInput): Promise<void> {
    const session = proposals.sessions.value.find((candidate) => candidate.session_id === sessionId);
    if (session == null) throw new Error("AIセッションが見つかりません。");
    if (session.activity !== "idle") return;
    clearSessionFeedback(sessionId);
    if (!options.canWrite.value) {
      setSessionFeedback(sessionId, "warning", "同期が完了すると変更案を承認できます。");
      return;
    }
    if (syncing.value) setSessionFeedback(sessionId, "progress", "同期の完了を待っています。");
    try {
      const result = await proposals.approve({ ...input, session_id: sessionId });
      if (disposed) return;
      if (result.kind === "error") setSessionFeedback(sessionId, "failure", result.message);
    } catch (error) {
      if (!disposed) setSessionFeedback(sessionId, "failure", "変更案を承認できませんでした。");
      throw error;
    } finally {
      if (!disposed) clearSyncWaitingFeedback(sessionId);
    }
  }

  async function reject(sessionId: string, proposalId: string): Promise<void> {
    clearSessionFeedback(sessionId);
    try {
      const result = await proposals.reject({ session_id: sessionId, proposal_id: proposalId });
      if (disposed) return;
      if (result.kind === "error") {
        setSessionFeedback(sessionId, "failure", result.message);
        return;
      }
      options.onToast("warning", `AI依頼「${requireRecord(sessionId).title}」の変更案を却下しました。`);
    } catch (error) {
      if (!disposed) setSessionFeedback(sessionId, "failure", "変更案を却下できませんでした。");
      throw error;
    }
  }

  async function closeSession(sessionId: string): Promise<void> {
    const session = proposals.sessions.value.find((value) => value.session_id === sessionId);
    if (session == null) return;
    if (session.activity !== "idle") return;
    try {
      const result = await proposals.closeSession(sessionId);
      if (disposed) return;
      if (result.kind === "error") {
        setSessionFeedback(sessionId, "failure", result.message);
        return;
      }
      records.value = records.value.filter((value) => value.session_id !== sessionId);
      if (selectedSessionId.value === sessionId) selectedSessionId.value = records.value[0]?.session_id;
    } catch (error) {
      if (!disposed) setSessionFeedback(sessionId, "failure", "AI依頼を閉じられませんでした。");
      throw error;
    }
  }

  function selectSession(sessionId: string): void {
    requireRecord(sessionId);
    selectedSessionId.value = sessionId;
  }

  function selectTask(taskGid: string): void {
    const gid = gidSchema.parse(taskGid);
    closeAssistant();
    void options.selectTask(gid);
  }

  async function setExternalEnabled(enabled: boolean): Promise<void> {
    if (externalBusy.value) return;
    externalBusy.value = true;
    options.onSettingsFeedback({ kind: "progress", message: "外部連携の設定を更新しています。" });
    try {
      const result = await proposals.setExternalEnabled(enabled);
      if (disposed) return;
      if (result.kind === "error") {
        options.onSettingsFeedback({ kind: "failure", message: result.message });
        return;
      }
      options.onSettingsFeedback(undefined);
      options.onToast("success", enabled ? "外部連携を有効にしました。" : "外部連携を停止しました。");
    } catch (error) {
      if (!disposed) options.onSettingsFeedback({ kind: "failure", message: "外部連携の設定を更新できませんでした。" });
      throw error;
    } finally {
      externalBusy.value = false;
    }
  }

  async function editExternal(input: ExternalEditInput): Promise<void> {
    if (externalBusy.value) return;
    externalBusy.value = true;
    externalEditResult.value = undefined;
    dialogFeedback.value = { kind: "progress", message: "外部提案を更新しています。" };
    try {
      const result = await proposals.editExternalOperation(input);
      if (disposed) return;
      externalEditResult.value = { kind: result.kind === "ok" ? "saved" : "failed", proposal_id: input.proposal_id, revision: input.revision };
      if (result.kind === "error") {
        dialogFeedback.value = { kind: "failure", message: result.message };
        return;
      }
      dialogFeedback.value = undefined;
      options.onToast("success", "外部提案を更新しました。");
    } catch (error) {
      if (!disposed) {
        externalEditResult.value = { kind: "failed", proposal_id: input.proposal_id, revision: input.revision };
        dialogFeedback.value = { kind: "failure", message: "外部提案を更新できませんでした。" };
      }
      throw error;
    } finally {
      externalBusy.value = false;
    }
  }

  async function selectExternal(input: ExternalSelectionInput): Promise<void> {
    if (externalBusy.value) return;
    externalBusy.value = true;
    dialogFeedback.value = { kind: "progress", message: "外部提案の選択範囲を更新しています。" };
    try {
      const result = await proposals.selectExternal(input);
      if (disposed) return;
      dialogFeedback.value = result.kind === "error" ? { kind: "failure", message: result.message } : undefined;
    } catch (error) {
      if (!disposed) dialogFeedback.value = { kind: "failure", message: "外部提案の選択範囲を更新できませんでした。" };
      throw error;
    } finally {
      externalBusy.value = false;
    }
  }

  async function approveExternal(input: ExternalSelectionInput): Promise<void> {
    if (externalBusy.value) return;
    externalBusy.value = true;
    dialogFeedback.value = { kind: "progress", message: "外部提案を承認しています。" };
    try {
      const result = await proposals.approveExternal(input);
      if (disposed) return;
      if (result.kind === "error") {
        dialogFeedback.value = { kind: "failure", message: result.message };
        return;
      }
      externalApprovalResults.value = { ...externalApprovalResults.value,
        [input.proposal_id]: result.value };
      dialogFeedback.value = undefined;
      options.onToast("success", "外部提案の承認を受け付けました。");
    } catch (error) {
      if (!disposed) dialogFeedback.value = { kind: "failure", message: "外部提案を承認できませんでした。" };
      throw error;
    } finally {
      externalBusy.value = false;
    }
  }

  async function refreshExecution(executionId: string): Promise<void> {
    if (proposals.executionRequestIds.value.includes(executionId)) return;
    await proposals.getExecution(executionId);
  }

  async function refreshExecutions(): Promise<void> {
    if (proposals.executionListBusy.value) return;
    await proposals.listExecutions();
  }

  async function retryExecution(executionId: string): Promise<void> {
    if (proposals.retryingExecutionIds.value.includes(executionId)) return;
    await proposals.retryExecution(executionId);
  }

  async function rejectExternal(input: ExternalRejectInput): Promise<void> {
    if (externalBusy.value) return;
    externalBusy.value = true;
    dialogFeedback.value = { kind: "progress", message: "外部提案を却下しています。" };
    try {
      const result = await proposals.rejectExternal(input);
      if (disposed) return;
      if (result.kind === "error") {
        dialogFeedback.value = { kind: "failure", message: result.message };
        return;
      }
      dialogFeedback.value = undefined;
      options.onToast("success", "外部提案を却下しました。");
    } catch (error) {
      if (!disposed) dialogFeedback.value = { kind: "failure", message: "外部提案を却下できませんでした。" };
      throw error;
    } finally {
      externalBusy.value = false;
    }
  }

  return {
    codexState,
    externalState,
    externalBusy,
    externalEditResult,
    externalApprovalResults,
    executions,
    executionFailures: proposals.executionFailures,
    executionListBusy: proposals.executionListBusy,
    executionListFailure: proposals.executionListFailure,
    executionRequestIds: proposals.executionRequestIds,
    retryingExecutionIds: proposals.retryingExecutionIds,
    latestExecutionFor: proposals.latestExecutionFor,
    dialogVisible,
    dialogComponent,
    dialogRef,
    dialogFeedback,
    sessionCreating,
    sessionViews,
    selectedSessionId,
    canStartNewSession,
    waitingCount,
    runningCount,
    initialize,
    refreshCodexStatus,
    handleSyncState,
    setCodexHint,
    openAssistant,
    closeAssistant,
    startSession,
    startTurn,
    requestTaskNoteAnalysis,
    select,
    edit,
    approve,
    reject,
    closeSession,
    selectSession,
    selectTask,
    setExternalEnabled,
    editExternal,
    selectExternal,
    approveExternal,
    refreshExecution,
    refreshExecutions,
    retryExecution,
    rejectExternal,
  };
}
