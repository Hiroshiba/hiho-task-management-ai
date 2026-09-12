<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  aiWorkflowTurnRequestSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
} from "../../shared/ai-workflow";
import {
  type RendererAiConversationEntry,
  type RendererAiState,
} from "./state";
import ProposalReviewPanel from "./ProposalReviewPanel.vue";

type TaskTitleReference = {
  readonly gid: string;
  readonly title: string;
};
type ApplicationOutcome = Extract<RendererAiState, { kind: "applied" }>["result"]["application"]["outcome"];

type ApplicationOutcomePresentation = {
  readonly backgroundClass: string;
  readonly borderClass: string;
  readonly detailTextClass: string;
  readonly focusClass: string;
  readonly role: "status" | "alert";
  readonly textClass: string;
};
const props = defineProps<{
  state: RendererAiState;
  conversationHistory: readonly RendererAiConversationEntry[];
  tasks: readonly TaskTitleReference[];
  canWrite: boolean;
  canSendAi: boolean;
  aiSendDisabledReason: string;
}>();

const emit = defineEmits<{
  (event: "start", input: AiWorkflowTurnRequest): void;
  (event: "select", input: AiWorkflowSelectionRequest): void;
  (event: "edit", input: AiWorkflowOperationEdit): void;
  (event: "approve", input: AiWorkflowApprovalRequest): void;
  (event: "reject", proposalId: string): void;
  (event: "select-task", taskGid: string): void;
}>();

const message = ref("");
const messageInput = ref<HTMLTextAreaElement | null>(null);
const localError = ref("");

function focusMessageInput(): "focused" | "unavailable" {
  const input = messageInput.value;
  if (input == null) {
    return "unavailable";
  }
  input.focus();
  return "focused";
}

defineExpose({ focusMessageInput });

function applicationOutcomePresentation(outcome: ApplicationOutcome): ApplicationOutcomePresentation {
  switch (outcome) {
    case "applied":
    case "already_applied":
      return {
        backgroundClass: "bg-emerald-50 dark:bg-emerald-950",
        borderClass: "border-emerald-200 dark:border-emerald-800",
        detailTextClass: "text-emerald-950 dark:text-emerald-100",
        focusClass: "focus:ring-emerald-600 dark:focus:ring-emerald-400",
        role: "status",
        textClass: "text-emerald-900 dark:text-emerald-100",
      };
    case "partially_applied":
    case "unknown":
      return {
        backgroundClass: "bg-amber-50 dark:bg-amber-950",
        borderClass: "border-amber-200 dark:border-amber-800",
        detailTextClass: "text-amber-950 dark:text-amber-100",
        focusClass: "focus:ring-amber-600 dark:focus:ring-amber-400",
        role: "alert",
        textClass: "text-amber-900 dark:text-amber-100",
      };
    case "not_applied":
      return {
        backgroundClass: "bg-rose-50 dark:bg-rose-950",
        borderClass: "border-rose-200 dark:border-rose-800",
        detailTextClass: "text-rose-950 dark:text-rose-100",
        focusClass: "focus:ring-rose-600 dark:focus:ring-rose-400",
        role: "alert",
        textClass: "text-rose-900 dark:text-rose-100",
      };
  }
}

const proposal = computed(() => {
  switch (props.state.kind) {
    case "proposal":
      return props.state.proposal;
    case "idle":
    case "streaming":
    case "questions":
    case "unavailable":
      return props.state.pending_proposal?.proposal;
    case "applied":
      return undefined;
  }
});

watch(
  () => proposal.value?.proposal_id,
  (proposalId, previousProposalId) => {
    if (proposalId !== previousProposalId) {
      localError.value = "";
    }
  },
);

const responseQuestions = computed(() => {
  if (props.state.kind === "proposal" || props.state.kind === "questions") {
    return props.state.questions;
  }
  return [];
});

type AiConversationQuestions = Extract<
  RendererAiConversationEntry,
  { readonly kind: "response" }
>["questions"];

const hasResponseOptions = computed(() =>
  responseQuestions.value.some((question) => question.options != null),
);

const conversationIsStreaming = computed(() => {
  const latestEntry = props.conversationHistory.at(-1);
  return latestEntry?.kind === "pending" || latestEntry?.kind === "streaming";
});

const unavailableFailureIsInHistory = computed(() => {
  if (props.state.kind !== "unavailable") {
    return false;
  }
  const latestEntry = props.conversationHistory.at(-1);
  return latestEntry?.kind === "failure"
    && latestEntry.failure.code === props.state.failure.code
    && latestEntry.failure.message === props.state.failure.message;
});

function historyQuestions(
  entry: RendererAiConversationEntry,
  entryIndex: number,
): AiConversationQuestions {
  if (entry.kind !== "response") {
    return [];
  }
  if (entryIndex === props.conversationHistory.length - 1 && responseQuestions.value.length > 0) {
    return [];
  }
  return entry.questions;
}

const panelTitle = computed(() => {
  switch (props.state.kind) {
    case "applied":
      return "反映結果";
    case "unavailable":
      return "AIアシスタント";
    case "proposal":
      return "変更案を確認";
    case "idle":
    case "questions":
    case "streaming":
      return proposal.value != null ? "変更案を確認" : "タスクについて相談";
  }
});

function sendMessage(): void {
  if (!props.canSendAi) {
    return;
  }
  const value = message.value.trim();
  if (value.length === 0) {
    localError.value = "質問や依頼を入力してください。";
    return;
  }
  try {
    const input = aiWorkflowTurnRequestSchema.parse({
      message: value,
    });
    localError.value = "";
    emit("start", input);
    message.value = "";
  } catch {
    localError.value = "依頼文を確認してください。";
  }
}

function applicationOutcomeLabel(
  outcome: ApplicationOutcome,
): string {
  switch (outcome) {
    case "applied":
      return "反映済み";
    case "already_applied":
      return "既に反映済み";
    case "not_applied":
      return "未反映";
    case "partially_applied":
      return "一部反映";
    case "unknown":
      return "確認不能";
  }
}

function applicationDetailsShouldOpen(
  outcome: ApplicationOutcome,
): boolean {
  switch (outcome) {
    case "applied":
    case "already_applied":
      return false;
    case "not_applied":
    case "partially_applied":
    case "unknown":
      return true;
  }
}

function applicationReasonLabel(reason: string): string {
  switch (reason) {
    case "applied":
      return "反映成功";
    case "already_applied":
      return "反映済み";
    case "approval_conflict":
      return "承認時競合";
    case "atomic_group_blocked":
      return "一括グループが適用不可";
    case "writer_conflict":
      return "最新状態との競合";
    case "recovery_required":
      return "復旧確認が必要";
    case "recovery_context_missing":
      return "復旧文脈がありません";
    case "task_not_found":
      return "対象タスクが見つかりません";
    case "duplicate_external_id":
      return "外部IDが重複しています";
    case "journal_target_mismatch":
      return "適用記録の対象が一致しません";
    default:
      throw new Error("未知の適用理由コードです。");
  }
}</script>
<template>
  <section
    class="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    aria-labelledby="ai-panel-title"
  >
    <div class="border-b border-slate-200 px-5 py-4 dark:border-slate-700">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold text-violet-700 dark:text-violet-400">
            AIアシスタント
          </p><h2
            id="ai-panel-title"
            class="mt-1 text-xl font-semibold text-slate-900 dark:text-slate-100"
          >
            {{ panelTitle }}
          </h2>
        </div>
      </div>
    </div>

    <div class="space-y-5 p-5">
      <section
        v-if="props.conversationHistory.length > 0"
        class="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"
        :aria-live="conversationIsStreaming ? 'polite' : undefined"
        :aria-busy="conversationIsStreaming ? 'true' : undefined"
        aria-label="AI会話履歴"
      >
        <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
          会話履歴
        </h3>
        <ol class="space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <li
            v-for="(entry, entryIndex) in props.conversationHistory"
            :key="entryIndex"
            class="space-y-2 rounded-md bg-slate-50 p-3 dark:bg-slate-800"
          >
            <div>
              <p class="text-xs text-slate-500 dark:text-slate-400">
                依頼{{ entryIndex + 1 }}
              </p>
              <p class="mt-1 whitespace-pre-wrap break-words">
                {{ entry.request }}
              </p>
            </div>
            <template v-if="entry.kind === 'pending'">
              <div
                class="flex items-center gap-3 rounded-md bg-white p-3 dark:bg-slate-900"
                role="status"
              >
                <span
                  class="inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600 dark:border-slate-600 dark:border-t-violet-400"
                  aria-hidden="true"
                /><p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                  AIが回答を準備しています
                </p>
              </div>
            </template>
            <template v-else-if="entry.kind === 'streaming'">
              <div
                v-if="entry.text.length === 0"
                class="flex items-center gap-3 rounded-md bg-white p-3 dark:bg-slate-900"
                role="status"
              >
                <span
                  class="inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600 dark:border-slate-600 dark:border-t-violet-400"
                  aria-hidden="true"
                /><p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                  AIが回答を準備しています
                </p>
              </div>
              <template v-else>
                <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                  AIの応答
                </p>
                <pre
                  class="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-white p-3 text-sm leading-6 text-slate-800 dark:bg-slate-900 dark:text-slate-100"
                >{{ entry.text }}</pre>
              </template>
            </template>
            <template v-else-if="entry.kind === 'response'">
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                AIの応答
              </p>
              <p class="whitespace-pre-wrap break-words">
                {{ entry.message }}
              </p>
              <ul
                v-if="historyQuestions(entry, entryIndex).length > 0"
                class="space-y-1 rounded-md border border-slate-200 p-3 dark:border-slate-700"
              >
                <li
                  v-for="question in historyQuestions(entry, entryIndex)"
                  :key="question.question_id"
                >
                  <p class="font-medium text-slate-900 dark:text-slate-100">
                    {{ question.text }}
                  </p>
                  <p
                    v-if="question.options != null"
                    class="mt-1 text-xs text-slate-600 dark:text-slate-400"
                  >
                    選択肢: {{ question.options.join(" / ") }}
                  </p>
                </li>
              </ul>
            </template>
            <template v-else>
              <p class="text-sm font-medium text-rose-800 dark:text-rose-100">
                AIの応答に失敗しました。
              </p>
              <p class="whitespace-pre-wrap break-words text-rose-800 dark:text-rose-100">
                {{ entry.failure.message }}
              </p>
            </template>
          </li>
        </ol>
      </section>

      <div
        v-if="responseQuestions.length > 0"
        class="space-y-3"
        aria-live="polite"
      >
        <p
          v-if="hasResponseOptions"
          class="text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          現在の質問への回答を選択してください。
        </p>
        <ul class="space-y-3">
          <li
            v-for="question in responseQuestions"
            :key="question.question_id"
            class="rounded-md border border-slate-200 p-3 dark:border-slate-700"
          >
            <p class="font-medium text-slate-900 dark:text-slate-100">
              {{ question.text }}
            </p>
            <div
              v-if="question.options != null"
              class="mt-2 flex flex-wrap gap-2"
            >
              <button
                v-for="option in question.options"
                :key="option"
                type="button"
                class="choice-button"
                @click="message = option"
              >
                {{ option }}
              </button>
            </div>
          </li>
        </ul>
      </div>

      <ProposalReviewPanel
        v-if="proposal != null"
        :proposal="proposal"
        :tasks="props.tasks"
        :can-write="props.canWrite"
        review-mode="interactive"
        :defer-edit-close="false"
        @select="emit('select', $event)"
        @edit="emit('edit', $event)"
        @approve="emit('approve', $event)"
        @reject="emit('reject', $event)"
        @select-task="emit('select-task', $event)"
      />

      <div
        v-if="props.state.kind === 'applied'"
        class="rounded-md p-4"
        :class="applicationOutcomePresentation(props.state.result.application.outcome).backgroundClass"
        :role="applicationOutcomePresentation(props.state.result.application.outcome).role"
      >
        <p
          class="font-medium"
          :class="applicationOutcomePresentation(props.state.result.application.outcome).textClass"
        >
          {{ props.state.message }}
        </p><p
          class="mt-2 text-sm"
          :class="applicationOutcomePresentation(props.state.result.application.outcome).textClass"
        >
          結果: {{ applicationOutcomeLabel(props.state.result.application.outcome) }}
        </p><p
          class="mt-1 text-sm"
          :class="applicationOutcomePresentation(props.state.result.application.outcome).textClass"
        >
          グループ {{ props.state.result.application.groups.length }}件・操作 {{ props.state.result.application.operations.length }}件
        </p><details
          :open="applicationDetailsShouldOpen(props.state.result.application.outcome)"
          class="mt-3 rounded-md border p-3"
          :class="applicationOutcomePresentation(props.state.result.application.outcome).borderClass"
        >
          <summary
            class="cursor-pointer rounded-md px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-slate-950"
            :class="[
              applicationOutcomePresentation(props.state.result.application.outcome).detailTextClass,
              applicationOutcomePresentation(props.state.result.application.outcome).focusClass,
            ]"
          >
            反映結果の詳細
          </summary>
          <div
            class="mt-3 grid gap-3 text-sm sm:grid-cols-2"
            :class="applicationOutcomePresentation(props.state.result.application.outcome).detailTextClass"
          >
            <div>
              <h3 class="font-medium">
                グループ別
              </h3><ul class="mt-1 space-y-1">
                <li
                  v-for="group in props.state.result.application.groups"
                  :key="group.group_id"
                >
                  {{ group.group_id }}: {{ applicationOutcomeLabel(group.outcome) }}・{{ group.operation_ids.length }}操作
                </li>
              </ul>
            </div><div>
              <h3 class="font-medium">
                操作別
              </h3><ul class="mt-1 space-y-1">
                <li
                  v-for="operation in props.state.result.application.operations"
                  :key="operation.operation_id"
                >
                  {{ operation.operation_id }}: {{ applicationOutcomeLabel(operation.outcome) }}・{{ applicationReasonLabel(operation.reason_code) }}
                </li>
              </ul>
            </div>
          </div>
        </details>
      </div>
      <div
        v-if="props.state.kind === 'unavailable'"
        class="rounded-md bg-amber-50 p-4 dark:bg-amber-950"
        role="alert"
      >
        <p class="font-medium text-amber-900 dark:text-amber-100">
          AIは利用できません。
        </p><p
          v-if="unavailableFailureIsInHistory"
          class="mt-1 text-sm text-amber-900 dark:text-amber-100"
        >
          詳細は会話履歴を確認してください。
        </p><p
          v-else
          class="mt-1 text-sm text-amber-900 dark:text-amber-100"
        >
          {{ props.state.failure.message }}
        </p>
      </div>

      <div
        v-if="props.state.kind === 'idle' || props.state.kind === 'questions' || props.state.kind === 'proposal'"
        class="space-y-3"
      >
        <p
          v-if="localError.length > 0"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
          role="alert"
        >
          {{ localError }}
        </p>
        <form
          class="space-y-3"
          @submit.prevent="sendMessage"
        >
          <label
            class="field-label"
            for="ai-message"
          >質問や依頼<textarea
            id="ai-message"
            ref="messageInput"
            v-model="message"
            class="text-input min-h-24"
            placeholder="例: 今週着手すべきタスクを教えてください"
          /></label><button
            type="submit"
            class="primary-button"
            :disabled="!props.canSendAi"
          >
            AIへ送信
          </button>
        </form>
        <p
          v-if="!props.canSendAi"
          class="text-sm text-amber-800 dark:text-amber-200"
          role="status"
          aria-live="polite"
        >
          {{ props.aiSendDisabledReason }}
        </p>
        <p
          v-if="proposal != null"
          class="text-xs text-slate-600 dark:text-slate-400"
        >
          表示中の変更案を保持したまま追質問や再提案を依頼できます。
        </p>
      </div>
    </div>
  </section>
</template>
