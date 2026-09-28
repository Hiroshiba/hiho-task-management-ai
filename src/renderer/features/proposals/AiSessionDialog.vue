<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";
import AiPanel from "./AiPanel.vue";
import ExternalProposalPanel from "./ExternalProposalPanel.vue";
import ExecutionResultPanel from "./ExecutionResultPanel.vue";
import type { IpcFailure } from "./proposal-state";
import type {
  AiSessionView,
  AiSessionStatus,
  Feedback,
  ExternalEditResult,
  ExternalProposalViewState,
  ExternalEditInput,
  ExternalRejectInput,
  ExternalSelectionInput,
  ProposalEditInput,
  ProposalSelectionInput,
  ExternalApprovalResult,
} from "./proposal-presentation";

type TurnInput = Pick<Parameters<ProposalsApi["startTurn"]>[0], "message">;

type AiPanelApi = {
  readonly focusMessageInput: () => "focused" | "unavailable";
};

type AiTaskReference = {
  readonly gid: string;
  readonly title: string;
};

const props = defineProps<{
  open: boolean;
  canStartNewSession: boolean;
  creatingSession: boolean;
  feedback?: Feedback | undefined;
  sessions: readonly AiSessionView[];
  tasks: readonly AiTaskReference[];
  selectedSessionId?: string | undefined;
  externalAgentState: ExternalProposalViewState;
  externalAgentBusy: boolean;
  externalAgentEditResult?: ExternalEditResult | undefined;
  externalReviewRequestId?: string | undefined;
  externalApprovalResults: Readonly<Record<string, ExternalApprovalResult>>;
  executions: readonly ExecutionDto[];
  executionFor: (executionId: string) => ExecutionDto | undefined;
  executionFailures: Readonly<Record<string, IpcFailure>>;
  executionListBusy: boolean;
  executionListFailure?: IpcFailure | undefined;
  executionRequestIds: readonly string[];
  retryingExecutionIds: readonly string[];
}>();

const emit = defineEmits<{
  (event: "close"): void;
  (event: "new-session"): void;
  (event: "select-session", sessionId: string): void;
  (event: "start", sessionId: string, input: TurnInput): void;
  (event: "select", sessionId: string, input: ProposalSelectionInput): void;
  (event: "edit", sessionId: string, input: ProposalEditInput): void;
  (event: "approve", sessionId: string, input: ProposalSelectionInput): void;
  (event: "reject", sessionId: string, proposalId: string): void;
  (event: "complete", sessionId: string): void;
  (event: "cancel", sessionId: string): void;
  (event: "select-task", sessionId: string, taskGid: string): void;
  (event: "external-edit", input: ExternalEditInput): void;
  (event: "external-approve", input: ExternalSelectionInput): void;
  (event: "external-reject", input: ExternalRejectInput): void;
  (event: "external-select", input: ExternalSelectionInput): void;
  (event: "external-select-task", taskGid: string): void;
  (event: "refresh-executions"): void;
  (event: "refresh-execution", executionId: string): void;
  (event: "retry-execution", executionId: string): void;
}>();

const dialogElement = ref<HTMLElement | null>(null);
const closeButton = ref<HTMLButtonElement | null>(null);
const mobileDetailVisible = ref(false);
const panelRefs = new Map<string, AiPanelApi>();
const activeTab = ref<"internal" | "external" | "executions">("internal");
const selectedHistoryExecutionId = ref<string>();
const pendingExternalReviewRequestId = ref<string | undefined>();

const selectedSession = computed(() => {
  if (props.selectedSessionId == null) {
    return undefined;
  }
  return props.sessions.find((session) => session.session_id === props.selectedSessionId);
});
const selectedHistoryExecution = computed(() => props.executions.find((execution) =>
  execution.execution_id === selectedHistoryExecutionId.value) ?? props.executions[0]);

function executionForSession(session: AiSessionView): ExecutionDto | undefined {
  if (session.state.kind !== "approved" || session.state.result.kind !== "execution") return undefined;
  return props.executionFor(session.state.result.execution.execution_id) ?? session.state.result.execution;
}

function executionBusy(executionId: string): boolean {
  return props.executionRequestIds.includes(executionId) || props.retryingExecutionIds.includes(executionId);
}

function executionBusyForSession(session: AiSessionView): boolean {
  const execution = executionForSession(session);
  return execution != null && executionBusy(execution.execution_id);
}

function executionFailureForSession(session: AiSessionView): IpcFailure | undefined {
  const execution = executionForSession(session);
  return execution == null ? undefined : props.executionFailures[execution.execution_id];
}

function executionStateLabel(state: ExecutionDto["state"]): string {
  switch (state) {
    case "planned": return "実行待ち";
    case "running": return "実行中";
    case "succeeded": return "実行完了";
    case "failed": return "実行失敗";
    case "confirmation_required": return "実状態の確認が必要";
  }
}

function successorExecutionId(executionId: string): string | undefined {
  const successors = props.executions.filter((execution) => execution.retry_of_execution_id === executionId);
  if (successors.length > 1) throw new Error("実行履歴の再試行先が重複しています。");
  return successors[0]?.execution_id;
}

function isAiPanelApi(value: unknown): value is AiPanelApi {
  if (typeof value !== "object" || value == null || !("focusMessageInput" in value)) {
    return false;
  }
  return typeof value.focusMessageInput === "function";
}

function registerPanel(sessionId: string, value: unknown): void {
  if (value == null) {
    panelRefs.delete(sessionId);
    return;
  }
  if (!isAiPanelApi(value)) {
    throw new Error("AIパネルのフォーカス操作が不正です。");
  }
  panelRefs.set(sessionId, value);
}

function focusSessionInput(sessionId: string): "focused" | "unavailable" {
  const panel = panelRefs.get(sessionId);
  if (panel == null) {
    return "unavailable";
  }
  return panel.focusMessageInput();
}

defineExpose({ focusSessionInput });

function sessionStatusLabel(status: AiSessionStatus): string {
  switch (status) {
    case "waiting_answer":
      return "回答待ち";
    case "waiting_approval":
      return "承認待ち";
    case "running":
      return "実行中";
    case "error":
      return "エラー";
    case "completed":
      return "完了";
    case "idle":
      return "入力待ち";
  }
}

function sessionStatusClass(status: AiSessionStatus): string {
  switch (status) {
    case "waiting_answer":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "waiting_approval":
      return "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-100";
    case "running":
      return "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100";
    case "error":
      return "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100";
    case "completed":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
    case "idle":
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
  }
}

function feedbackClass(kind: Feedback["kind"]): string {
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

function feedbackRole(kind: Feedback["kind"]): "status" | "alert" {
  switch (kind) {
    case "success":
    case "progress":
      return "status";
    case "warning":
    case "failure":
      return "alert";
  }
}

function selectSession(sessionId: string): void {
  mobileDetailVisible.value = true;
  emit("select-session", sessionId);
}

function startNewSession(): void {
  activeTab.value = "internal";
  emit("new-session");
}

function showSessionList(): void {
  mobileDetailVisible.value = false;
}

function completeSession(): void {
  const session = selectedSession.value;
  if (session == null || session.status !== "completed" || session.operation === "close") {
    return;
  }
  emit("complete", session.session_id);
}

function cancelSession(): void {
  const session = selectedSession.value;
  if (session == null
    || session.status === "completed"
    || session.state.kind === "approved"
    || session.operation === "approve"
    || session.operation === "close") {
    return;
  }
  emit("cancel", session.session_id);
}

function selectTask(): void {
  const session = selectedSession.value;
  if (session == null || session.task_gid == null) {
    return;
  }
  emit("select-task", session.session_id, session.task_gid);
}

function focusableElements(): HTMLElement[] {
  const element = dialogElement.value;
  if (element == null) {
    return [];
  }
  return [...element.querySelectorAll<HTMLElement>(
    "button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )].filter((candidate) => candidate.offsetParent != null);
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key !== "Tab") {
    return;
  }
  const elements = focusableElements();
  if (elements.length === 0) {
    event.preventDefault();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (first == null || last == null) {
    throw new Error("ダイアログのフォーカス対象が不正です。");
  }
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(() => props.open, async (open) => {
  if (!open) {
    return;
  }
  if (pendingExternalReviewRequestId.value != null) {
    activeTab.value = "external";
    pendingExternalReviewRequestId.value = undefined;
  }
  mobileDetailVisible.value = props.selectedSessionId != null;
  await nextTick();
  closeButton.value?.focus();
}, { immediate: true });

watch(() => props.externalReviewRequestId, (requestId) => {
  if (requestId == null) {
    return;
  }
  if (props.open) {
    activeTab.value = "external";
    return;
  }
  pendingExternalReviewRequestId.value = requestId;
}, { immediate: true });

watch(() => props.selectedSessionId, (sessionId) => {
  if (props.open && sessionId != null) {
    mobileDetailVisible.value = true;
  }
});
</script>

<template>
  <div
    v-show="props.open"
    class="fixed inset-0 flex items-center justify-center bg-slate-950/40 p-3 dark:bg-slate-950/70 sm:p-6"
    role="presentation"
    @mousedown.self="emit('close')"
  >
    <section
      ref="dialogElement"
      class="flex max-h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 sm:max-h-[calc(100vh-3rem)]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-session-dialog-title"
      @keydown="handleKeydown"
    >
      <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 dark:border-slate-700 sm:px-6">
        <div>
          <h2
            id="ai-session-dialog-title"
            class="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            AIアシスタント
          </h2>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
            依頼を選んで、回答や承認を続けられます。
          </p>
          <p
            v-if="props.feedback != null"
            class="mt-3 rounded-md px-3 py-2 text-sm"
            :class="feedbackClass(props.feedback.kind)"
            :role="feedbackRole(props.feedback.kind)"
          >
            {{ props.feedback.message }}
          </p>
        </div>
        <button
          ref="closeButton"
          type="button"
          class="secondary-button shrink-0"
          aria-label="AIアシスタントを閉じる"
          @click="emit('close')"
        >
          閉じる
        </button>
      </header>
      <nav
        class="flex shrink-0 border-b border-slate-200 px-4 dark:border-slate-700 sm:px-6"
        role="tablist"
        aria-label="AIアシスタントの表示"
      >
        <button
          type="button"
          role="tab"
          class="border-b-2 px-1 py-3 text-sm font-medium"
          :class="activeTab === 'internal'
            ? 'border-sky-600 text-sky-700 dark:border-sky-400 dark:text-sky-300'
            : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'"
          :aria-selected="activeTab === 'internal'"
          @click="activeTab = 'internal'"
        >
          内部の依頼
        </button>
        <button
          type="button"
          role="tab"
          class="ml-5 border-b-2 px-1 py-3 text-sm font-medium"
          :class="activeTab === 'external'
            ? 'border-sky-600 text-sky-700 dark:border-sky-400 dark:text-sky-300'
            : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'"
          :aria-selected="activeTab === 'external'"
          @click="activeTab = 'external'"
        >
          外部からの提案
        </button>
        <button
          type="button"
          role="tab"
          class="ml-5 border-b-2 px-1 py-3 text-sm font-medium"
          :class="activeTab === 'executions'
            ? 'border-sky-600 text-sky-700 dark:border-sky-400 dark:text-sky-300'
            : 'border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'"
          :aria-selected="activeTab === 'executions'"
          @click="activeTab = 'executions'"
        >
          実行履歴
        </button>
      </nav>
      <div
        v-show="activeTab === 'internal'"
        class="min-h-0 flex flex-1 flex-col md:grid md:grid-cols-[minmax(15rem,22rem)_minmax(0,1fr)]"
      >
        <aside
          class="min-h-0 flex-1 overflow-y-auto border-b border-slate-200 dark:border-slate-700 md:block md:border-b-0 md:border-r"
          :class="mobileDetailVisible ? 'hidden' : 'block'"
          aria-label="AI依頼一覧"
        >
          <div class="flex items-center justify-between gap-3 px-4 py-3 sm:px-5">
            <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
              依頼一覧
            </h3>
            <button
              type="button"
              class="primary-button"
              :disabled="!props.canStartNewSession || props.creatingSession"
              @click="startNewSession"
            >
              {{ props.creatingSession ? "開始中" : "新しい依頼" }}
            </button>
          </div>
          <p
            v-if="props.sessions.length === 0"
            class="px-4 pb-5 text-sm text-slate-600 dark:text-slate-400 sm:px-5"
          >
            依頼はありません。
          </p>
          <ul
            v-else
            class="space-y-2 px-3 pb-4 sm:px-4"
          >
            <li
              v-for="session in props.sessions"
              :key="session.session_id"
            >
              <button
                type="button"
                class="w-full rounded-lg border px-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-900"
                :class="session.session_id === props.selectedSessionId
                  ? 'border-sky-500 bg-sky-50 dark:border-sky-400 dark:bg-sky-950'
                  : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'"
                :aria-current="session.session_id === props.selectedSessionId ? 'true' : undefined"
                @click="selectSession(session.session_id)"
              >
                <span class="flex items-start justify-between gap-2">
                  <span class="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {{ session.title }}
                  </span>
                  <span
                    class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                    :class="sessionStatusClass(session.status)"
                  >
                    {{ sessionStatusLabel(session.status) }}
                  </span>
                </span>
                <span
                  v-if="session.task_title != null"
                  class="mt-1 block truncate text-xs text-slate-600 dark:text-slate-400"
                >
                  対象: {{ session.task_title }}
                </span>
                <span
                  v-if="session.feedback != null"
                  class="mt-1 block truncate text-xs text-slate-600 dark:text-slate-400"
                >
                  {{ session.feedback.message }}
                </span>
              </button>
            </li>
          </ul>
        </aside>
        <main
          class="min-h-0 flex-1 overflow-y-auto"
          :class="mobileDetailVisible ? 'block' : 'hidden md:block'"
          aria-label="AI依頼の詳細"
        >
          <div
            v-if="selectedSession == null"
            class="flex h-full min-h-60 items-center justify-center p-6 text-center"
          >
            <div>
              <p class="font-medium text-slate-900 dark:text-slate-100">
                依頼を選択してください。
              </p>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                左の一覧から確認する依頼を選べます。
              </p>
            </div>
          </div>
          <template v-else>
            <div class="flex items-start gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-700 sm:px-6">
              <button
                type="button"
                class="secondary-button md:hidden"
                @click="showSessionList"
              >
                一覧へ戻る
              </button>
              <div class="min-w-0 flex-1">
                <h3 class="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
                  {{ selectedSession.title }}
                </h3>
                <p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
                  <span
                    class="mr-2 inline-block rounded-full px-2 py-0.5"
                    :class="sessionStatusClass(selectedSession.status)"
                  >
                    {{ sessionStatusLabel(selectedSession.status) }}
                  </span>
                  <span v-if="selectedSession.task_title != null">
                    対象: {{ selectedSession.task_title }}
                  </span>
                </p>
              </div>
            </div>
            <div class="space-y-4 p-4 sm:p-6">
              <p
                v-if="selectedSession.feedback != null"
                class="rounded-md px-4 py-3 text-sm"
                :class="feedbackClass(selectedSession.feedback.kind)"
                :role="feedbackRole(selectedSession.feedback.kind)"
              >
                {{ selectedSession.feedback.message }}
              </p>
              <button
                v-if="selectedSession.task_gid != null"
                type="button"
                class="text-button"
                @click="selectTask"
              >
                対象タスクを表示
              </button>
              <div
                v-for="session in props.sessions"
                v-show="session.session_id === props.selectedSessionId"
                :key="`panel-${session.session_id}`"
                class="min-w-0"
              >
                <AiPanel
                  :ref="(value) => registerPanel(session.session_id, value)"
                  :state="session.state"
                  :conversation-history="session.conversation_history"
                  :tasks="props.tasks"
                  :can-write="session.can_write && session.operation === 'idle'"
                  :can-send-ai="session.can_send_ai"
                  :ai-send-disabled-reason="session.ai_send_disabled_reason"
                  :execution="executionForSession(session)"
                  :execution-busy="executionBusyForSession(session)"
                  :execution-failure="executionFailureForSession(session)"
                  @start="(input) => emit('start', session.session_id, input)"
                  @select="(input) => emit('select', session.session_id, input)"
                  @edit="(input) => emit('edit', session.session_id, input)"
                  @approve="(input) => emit('approve', session.session_id, input)"
                  @reject="(proposalId) => emit('reject', session.session_id, proposalId)"
                  @select-task="(taskGid) => emit('select-task', session.session_id, taskGid)"
                  @refresh-execution="emit('refresh-execution', $event)"
                  @retry-execution="emit('retry-execution', $event)"
                />
              </div>
              <div class="flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
                <button
                  v-if="selectedSession.status === 'completed'"
                  type="button"
                  class="primary-button"
                  :disabled="selectedSession.operation === 'close'"
                  @click="completeSession"
                >
                  確認して閉じる
                </button>
                <button
                  v-else-if="selectedSession.state.kind !== 'approved'"
                  type="button"
                  class="secondary-button"
                  :disabled="selectedSession.operation === 'approve' || selectedSession.operation === 'close'"
                  @click="cancelSession"
                >
                  依頼を中止
                </button>
              </div>
            </div>
          </template>
        </main>
      </div>
      <div
        v-show="activeTab === 'external'"
        class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
        role="tabpanel"
        aria-label="外部からの提案"
      >
        <template v-if="props.externalAgentState.kind === 'ready'">
          <ExternalProposalPanel
            :state="props.externalAgentState.value"
            :busy="props.externalAgentBusy"
            :tasks="props.tasks"
            :edit-result="props.externalAgentEditResult"
            :approval-results="props.externalApprovalResults"
            :execution-for="props.executionFor"
            :execution-failures="props.executionFailures"
            :execution-request-ids="props.executionRequestIds"
            :retrying-execution-ids="props.retryingExecutionIds"
            @edit="(input) => emit('external-edit', input)"
            @approve="(input) => emit('external-approve', input)"
            @reject="(input) => emit('external-reject', input)"
            @select="(input) => emit('external-select', input)"
            @select-task="(taskGid) => emit('external-select-task', taskGid)"
            @refresh-execution="emit('refresh-execution', $event)"
            @retry-execution="emit('retry-execution', $event)"
          />
        </template>
        <p
          v-else-if="props.externalAgentState.kind === 'loading'"
          class="rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200"
          role="status"
        >
          外部連携の状態を読み込んでいます。
        </p>
        <p
          v-else
          class="rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-100"
          role="alert"
        >
          {{ props.externalAgentState.message }}
        </p>
      </div>
      <div
        v-show="activeTab === 'executions'"
        class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6"
        role="tabpanel"
        aria-label="保存済み実行履歴"
      >
        <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
            保存済み実行履歴
          </h3>
          <button
            type="button"
            class="secondary-button"
            :disabled="props.executionListBusy"
            @click="emit('refresh-executions')"
          >
            {{ props.executionListBusy ? '読み込み中' : '一覧を更新' }}
          </button>
        </div>
        <p
          v-if="props.executionListFailure != null"
          class="mb-4 text-sm text-rose-800 dark:text-rose-100"
          role="alert"
        >
          {{ props.executionListFailure.message }}<span v-if="props.executionListFailure.error_id != null"> エラーID: {{ props.executionListFailure.error_id }}</span>
        </p>
        <p
          v-if="props.executions.length === 0"
          class="text-sm text-slate-600 dark:text-slate-400"
        >
          {{ props.executionListBusy ? '実行履歴を読み込んでいます。' : '保存済みの実行はありません。' }}
        </p>
        <div
          v-else
          class="grid min-w-0 gap-4 lg:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)]"
        >
          <ul class="max-h-96 space-y-2 overflow-y-auto rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <li
              v-for="execution in props.executions"
              :key="execution.execution_id"
            >
              <button
                type="button"
                class="w-full rounded-md border border-slate-200 px-3 py-2 text-left text-sm dark:border-slate-700"
                :aria-current="selectedHistoryExecution?.execution_id === execution.execution_id ? 'true' : undefined"
                @click="selectedHistoryExecutionId = execution.execution_id"
              >
                <span class="block break-all font-medium">{{ execution.execution_id }}</span>
                <span class="mt-1 block">{{ executionStateLabel(execution.state) }}</span>
              </button>
            </li>
          </ul>
          <ExecutionResultPanel
            v-if="selectedHistoryExecution != null"
            :execution="selectedHistoryExecution"
            :busy="executionBusy(selectedHistoryExecution.execution_id)"
            :failure="props.executionFailures[selectedHistoryExecution.execution_id]"
            :successor-execution-id="successorExecutionId(selectedHistoryExecution.execution_id)"
            @refresh="emit('refresh-execution', $event)"
            @retry="emit('retry-execution', $event)"
          />
        </div>
      </div>
    </section>
  </div>
</template>
