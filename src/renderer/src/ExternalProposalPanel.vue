<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  externalAgentGuiApproveInputSchema,
  externalAgentGuiEditInputSchema,
  externalAgentGuiRejectInputSchema,
  externalAgentGuiSelectInputSchema,
  type ExternalAgentGuiApproveInput,
  type ExternalAgentGuiEditInput,
  type ExternalAgentGuiRejectInput,
  type ExternalAgentGuiSelectInput,
  type ExternalAgentGuiState,
  type ExternalAgentProposal,
  type ExternalAgentProposalStatus,
} from "../../shared/external-agent";
import {
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowSelectionRequest,
} from "../../shared/ai-workflow";
import type { RendererExternalAgentEditResult } from "./state";
import ProposalReviewPanel from "./ProposalReviewPanel.vue";

type TaskTitleReference = {
  readonly gid: string;
  readonly title: string;
};

const props = defineProps<{
  state: ExternalAgentGuiState;
  busy: boolean;
  tasks: readonly TaskTitleReference[];
  editResult?: RendererExternalAgentEditResult | undefined;
}>();

const emit = defineEmits<{
  (event: "select", input: ExternalAgentGuiSelectInput): void;
  (event: "edit", input: ExternalAgentGuiEditInput): void;
  (event: "approve", input: ExternalAgentGuiApproveInput): void;
  (event: "reject", input: ExternalAgentGuiRejectInput): void;
  (event: "select-task", taskGid: string): void;
}>();

const selectedProposalId = ref<string | undefined>();

const selectedProposal = computed(() => {
  const selectedId = selectedProposalId.value;
  if (selectedId != null) {
    const selected = props.state.proposals.find((proposal) => proposal.proposal_id === selectedId);
    if (selected != null) {
      return selected;
    }
  }
  return props.state.proposals[0];
});

watch(
  () => props.state.proposals.map((proposal) => proposal.proposal_id),
  (proposalIds) => {
    const currentId = selectedProposalId.value;
    if (currentId != null && proposalIds.includes(currentId)) {
      return;
    }
    selectedProposalId.value = proposalIds[0];
  },
  { immediate: true },
);

watch(
  () => props.state.review_target?.request_id,
  (requestId) => {
    if (requestId == null) {
      return;
    }
    const target = props.state.review_target;
    if (target == null) {
      throw new Error("外部提案の確認対象がありません。");
    }
    selectedProposalId.value = target.proposal_id;
  },
  { immediate: true },
);

function proposalTitle(proposal: ExternalAgentProposal): string {
  return proposal.view.proposal.title;
}

function proposalStatusLabel(status: ExternalAgentProposalStatus): string {
  switch (status.kind) {
    case "pending_approval":
      return "承認待ち";
    case "approving":
      return "反映中";
    case "finished":
      return `完了・${applicationOutcomeLabel(status.result.application.outcome)}`;
    case "rejected":
      return "却下済み";
    case "expired":
      return `期限切れ・${expiredReasonLabel(status.reason_code)}`;
    case "failed":
      return `失敗・${status.message}`;
    case "unknown":
      return `結果不明・${status.message}`;
  }
}

function proposalStatusClass(status: ExternalAgentProposalStatus): string {
  switch (status.kind) {
    case "pending_approval":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "approving":
      return "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100";
    case "finished":
      return applicationOutcomeClass(status.result.application.outcome);
    case "rejected":
    case "expired":
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
    case "failed":
    case "unknown":
      return "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100";
  }
}

function expiredReasonLabel(reason: "context_changed" | "instance_restarted" | "superseded"): string {
  switch (reason) {
    case "context_changed":
      return "状態が変わりました";
    case "instance_restarted":
      return "連携が再起動しました";
    case "superseded":
      return "外部連携が無効になりました";
  }
}

function applicationOutcomeLabel(
  outcome: "applied" | "already_applied" | "not_applied" | "partially_applied" | "unknown",
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
      return "反映結果不明";
  }
}

function applicationOutcomeClass(
  outcome: "applied" | "already_applied" | "not_applied" | "partially_applied" | "unknown",
): string {
  switch (outcome) {
    case "applied":
    case "already_applied":
      return "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
    case "not_applied":
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
    case "partially_applied":
    case "unknown":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
  }
}

function requireSelectedProposal(): ExternalAgentProposal {
  const proposal = selectedProposal.value;
  if (proposal == null) {
    throw new Error("表示する外部提案がありません。");
  }
  return proposal;
}

function requirePendingProposal(): ExternalAgentProposal {
  const proposal = requireSelectedProposal();
  if (proposal.state.kind !== "pending_approval") {
    throw new Error("承認待ちではない外部提案を操作できません。");
  }
  return proposal;
}

function selectListedProposal(proposalId: string): void {
  selectedProposalId.value = proposalId;
}

function selectTask(taskGid: string): void {
  emit("select-task", taskGid);
}

function select(input: AiWorkflowSelectionRequest): void {
  const proposal = requirePendingProposal();
  const parsedInput = externalAgentGuiSelectInputSchema.parse({
    proposal_id: input.proposal_id,
    revision: proposal.revision,
    selection: input.selection,
  });
  emit("select", parsedInput);
}

function edit(input: AiWorkflowOperationEdit): void {
  const proposal = requirePendingProposal();
  const parsedInput = externalAgentGuiEditInputSchema.parse({
    proposal_id: input.proposal_id,
    operation_id: input.operation_id,
    revision: proposal.revision,
    after: input.after,
    evidence_locator: input.evidence_locator,
  });
  emit("edit", parsedInput);
}

function approve(input: AiWorkflowApprovalRequest): void {
  const proposal = requirePendingProposal();
  const parsedInput = externalAgentGuiApproveInputSchema.parse({
    proposal_id: input.proposal_id,
    revision: proposal.revision,
    selection: input.selection,
  });
  emit("approve", parsedInput);
}

function reject(): void {
  const proposal = requirePendingProposal();
  emit("reject", externalAgentGuiRejectInputSchema.parse({
    proposal_id: proposal.proposal_id,
    revision: proposal.revision,
  }));
}

function finishedOutcomeLabel(proposal: ExternalAgentProposal): string {
  if (proposal.state.kind !== "finished") {
    throw new Error("完了していない外部提案の結果を表示できません。");
  }
  return applicationOutcomeLabel(proposal.state.result.application.outcome);
}

function finishedOutcomeClass(proposal: ExternalAgentProposal): string {
  if (proposal.state.kind !== "finished") {
    throw new Error("完了していない外部提案の結果を表示できません。");
  }
  return applicationOutcomeClass(proposal.state.result.application.outcome);
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <section class="grid min-w-0 gap-4 lg:grid-cols-[minmax(13rem,18rem)_minmax(0,1fr)]">
      <div class="min-w-0 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
        <div class="flex items-center justify-between gap-2 px-1 pb-3">
          <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
            外部提案一覧
          </h3>
          <span class="text-xs text-slate-600 dark:text-slate-400">{{ props.state.proposals.length }}件</span>
        </div>
        <p
          v-if="props.state.proposals.length === 0"
          class="px-1 pb-2 text-sm text-slate-600 dark:text-slate-400"
        >
          外部からの提案はありません。
        </p>
        <ul
          v-else
          class="space-y-2"
        >
          <li
            v-for="proposal in props.state.proposals"
            :key="proposal.proposal_id"
          >
            <button
              type="button"
              class="w-full min-w-0 rounded-md border px-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-900"
              :class="proposal.proposal_id === selectedProposal?.proposal_id
                ? 'border-sky-500 bg-sky-50 dark:border-sky-400 dark:bg-sky-950'
                : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800'"
              @click="selectListedProposal(proposal.proposal_id)"
            >
              <span class="block truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                {{ proposalTitle(proposal) }}
              </span>
              <span
                class="mt-2 inline-block rounded-full px-2 py-0.5 text-xs"
                :class="proposalStatusClass(proposal.state)"
              >
                {{ proposalStatusLabel(proposal.state) }}
              </span>
            </button>
          </li>
        </ul>
      </div>

      <div class="min-w-0 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
        <div
          v-if="selectedProposal == null"
          class="flex min-h-48 items-center justify-center text-center text-sm text-slate-600 dark:text-slate-400"
        >
          確認する提案を選択してください。
        </div>
        <template v-else>
          <div class="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-700">
            <div class="min-w-0">
              <h3 class="break-words text-base font-semibold text-slate-900 dark:text-slate-100">
                {{ proposalTitle(requireSelectedProposal()) }}
              </h3>
              <p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
                外部エージェントから届いた提案
              </p>
            </div>
            <span
              class="shrink-0 rounded-full px-2 py-1 text-xs"
              :class="proposalStatusClass(requireSelectedProposal().state)"
            >
              {{ proposalStatusLabel(requireSelectedProposal().state) }}
            </span>
          </div>

          <ProposalReviewPanel
            class="mt-4"
            :proposal="requireSelectedProposal().view"
            :tasks="props.tasks"
            :can-write="requireSelectedProposal().state.kind === 'pending_approval' && !props.busy"
            :review-mode="requireSelectedProposal().state.kind === 'pending_approval' ? 'interactive' : 'read-only'"
            :defer-edit-close="true"
            :edit-result="props.editResult"
            @select="select"
            @edit="edit"
            @approve="approve"
            @reject="reject"
            @select-task="selectTask"
          />

          <div
            v-if="requireSelectedProposal().state.kind === 'finished'"
            class="mt-4 rounded-md p-3 text-sm"
            :class="finishedOutcomeClass(requireSelectedProposal())"
            role="status"
          >
            反映結果: {{ finishedOutcomeLabel(requireSelectedProposal()) }}
          </div>
          <div
            v-else-if="requireSelectedProposal().state.kind === 'expired' || requireSelectedProposal().state.kind === 'failed' || requireSelectedProposal().state.kind === 'unknown'"
            class="mt-4 rounded-md bg-rose-50 p-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-100"
            role="alert"
          >
            {{ proposalStatusLabel(requireSelectedProposal().state) }}
          </div>
        </template>
      </div>
    </section>
  </div>
</template>
