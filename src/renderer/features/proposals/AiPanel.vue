<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { proposalsContracts, type ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import type { AiProposalState } from "./proposal-state";
import type { AiConversationEntry, ProposalEditInput, ProposalSelectionInput } from "./proposal-presentation";
import ApprovalResultPanel from "./ApprovalResultPanel.vue";
import ProposalReviewPanel from "./ProposalReviewPanel.vue";

type TurnInput = Pick<Parameters<ProposalsApi["startTurn"]>[0], "message">;

type TaskTitleReference = {
  readonly gid: string;
  readonly title: string;
};
const props = defineProps<{
  state: AiProposalState;
  conversationHistory: readonly AiConversationEntry[];
  tasks: readonly TaskTitleReference[];
  canWrite: boolean;
  canSendAi: boolean;
  aiSendDisabledReason: string;
}>();

const emit = defineEmits<{
  (event: "start", input: TurnInput): void;
  (event: "select", input: ProposalSelectionInput): void;
  (event: "edit", input: ProposalEditInput): void;
  (event: "approve", input: ProposalSelectionInput): void;
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

const proposal = computed(() => {
  switch (props.state.kind) {
    case "proposal":
      return props.state.proposal;
    case "idle":
    case "turning":
    case "questions":
    case "failed":
      return props.state.pending_proposal;
    case "approved":
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
  AiConversationEntry,
  { readonly kind: "response" }
>["questions"];

const hasResponseOptions = computed(() =>
  responseQuestions.value.some((question) => question.options != null),
);

const conversationIsStreaming = computed(() => {
  const latestEntry = props.conversationHistory.at(-1);
  return latestEntry?.kind === "pending";
});

const failureIsInHistory = computed(() => {
  if (props.state.kind !== "failed") {
    return false;
  }
  const latestEntry = props.conversationHistory.at(-1);
  return latestEntry?.kind === "failure"
    && latestEntry.failure.code === props.state.failure.code
    && latestEntry.failure.message === props.state.failure.message;
});

function historyQuestions(
  entry: AiConversationEntry,
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
    case "approved":
      return "反映結果";
    case "failed":
      return "AIアシスタント";
    case "proposal":
      return "変更案を確認";
    case "idle":
    case "questions":
    case "turning":
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
  const request = proposalsContracts.startTurn.request.safeParse({ session_id: "ui-turn", message: value });
  if (!request.success) {
    localError.value = "依頼文を確認してください。";
    return;
  }
  const input: TurnInput = { message: request.data.message };
  localError.value = "";
  emit("start", input);
  message.value = "";
}

</script>
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
            <template v-else-if="entry.kind === 'response'">
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                AIの応答
              </p>
              <p class="whitespace-pre-wrap break-words">
                {{ entry.message }}
              </p>
              <pre
                v-if="entry.text.length > 0"
                class="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-white p-3 text-sm leading-6 text-slate-800 dark:bg-slate-900 dark:text-slate-100"
              >{{ entry.text }}</pre>
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

      <ApprovalResultPanel
        v-if="props.state.kind === 'approved'"
        :result="props.state.result"
      />
      <div
        v-if="props.state.kind === 'failed'"
        class="rounded-md bg-amber-50 p-4 dark:bg-amber-950"
        role="alert"
      >
        <p class="font-medium text-amber-900 dark:text-amber-100">
          AIの応答を確認できませんでした。
        </p><p
          v-if="failureIsInHistory"
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
