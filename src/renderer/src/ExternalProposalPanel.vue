<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  externalAgentGuiApproveInputSchema,
  externalAgentGuiEditInputSchema,
  externalAgentGuiRejectInputSchema,
  type ExternalAgentBridgeState,
  type ExternalAgentGuiApproveInput,
  type ExternalAgentGuiEditInput,
  type ExternalAgentGuiRejectInput,
  type ExternalAgentGuiState,
  type ExternalAgentProposal,
  type ExternalAgentProposalStatus,
} from "../../shared/external-agent";
import type { ProposalOperation } from "../../shared/ai";
import type { AiWorkflowProposalView } from "../../shared/ai-workflow";
import type { RendererExternalAgentEditResult } from "./state";
import ProposalOperationEditor from "./ProposalOperationEditor.vue";

type CreateTaskOperation = Extract<ProposalOperation, { operation: "create_task" }>;
type Validation = AiWorkflowProposalView["basic_validation"]["operations"][number];
type ExternalProposalEdit = {
  readonly proposal_id: string;
  readonly operation: CreateTaskOperation;
  readonly revision: number;
};

const props = defineProps<{
  state: ExternalAgentGuiState;
  busy: boolean;
  editResult?: RendererExternalAgentEditResult | undefined;
}>();

const emit = defineEmits<{
  (event: "set-enabled", enabled: boolean): void;
  (event: "edit", input: ExternalAgentGuiEditInput): void;
  (event: "approve", input: ExternalAgentGuiApproveInput): void;
  (event: "reject", input: ExternalAgentGuiRejectInput): void;
}>();

const selectedProposalId = ref<string | undefined>();
const editingProposal = ref<ExternalProposalEdit | undefined>();
const editingProposalId = computed(() => editingProposal.value?.proposal_id);

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

const createOperation = computed<CreateTaskOperation | undefined>(() => {
  const proposal = selectedProposal.value;
  if (proposal == null) {
    return undefined;
  }
  return proposal.view.proposal.groups
    .flatMap((group) => group.operations)
    .find((operation): operation is CreateTaskOperation => operation.operation === "create_task");
});

watch(
  () => props.state.proposals.map((proposal) => proposal.proposal_id),
  (proposalIds) => {
    const editing = editingProposal.value;
    if (editing != null && !proposalIds.includes(editing.proposal_id)) {
      editingProposal.value = undefined;
    }
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
    editingProposal.value = undefined;
  },
  { immediate: true },
);

watch(
  () => props.editResult,
  (result) => {
    if (result == null || result.kind !== "saved") {
      return;
    }
    const editing = editingProposal.value;
    if (editing == null
      || editing.proposal_id !== result.proposal_id
      || editing.revision !== result.revision) {
      return;
    }
    editingProposal.value = undefined;
  },
);

function bridgeLabel(bridge: ExternalAgentBridgeState): string {
  switch (bridge.kind) {
    case "stopped":
      return "停止中";
    case "running":
      return "稼働中";
    case "unavailable":
      return `利用不可・${bridge.message}`;
  }
}

function bridgeClass(bridge: ExternalAgentBridgeState): string {
  switch (bridge.kind) {
    case "stopped":
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
    case "running":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "unavailable":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
  }
}

function createOperationFor(proposal: ExternalAgentProposal): CreateTaskOperation | undefined {
  return proposal.view.proposal.groups
    .flatMap((group) => group.operations)
    .find((operation): operation is CreateTaskOperation => operation.operation === "create_task");
}

function requireCreateOperationFor(proposal: ExternalAgentProposal): CreateTaskOperation {
  const operation = createOperationFor(proposal);
  if (operation == null) {
    throw new Error("外部提案にタスク作成操作がありません。");
  }
  return operation;
}

function proposalTitle(proposal: ExternalAgentProposal): string {
  return requireCreateOperationFor(proposal).after.title;
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
      return "登録済み";
    case "already_applied":
      return "既に登録済み";
    case "not_applied":
      return "未登録";
    case "partially_applied":
      return "一部登録";
    case "unknown":
      return "登録結果不明";
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

function requireEditingProposal(): ExternalProposalEdit {
  const editing = editingProposal.value;
  if (editing == null) {
    throw new Error("編集中の外部提案がありません。");
  }
  return editing;
}

function requireCreateOperation(): CreateTaskOperation {
  return requireCreateOperationFor(requireSelectedProposal());
}

function validationFor(
  proposal: ExternalAgentProposal,
  kind: "basic" | "graph",
): Validation {
  const validation = kind === "basic"
    ? proposal.view.basic_validation
    : proposal.view.graph_validation;
  const operation = validation.operations.find((candidate) =>
    candidate.operation_id === proposal.operation_id);
  if (operation == null) {
    throw new Error(`${kind}検証に外部提案の操作結果がありません。`);
  }
  return operation;
}

function validationLabel(validation: Validation): string {
  return validation.kind === "valid" ? "有効" : "要確認";
}

function validationDetail(validation: Validation): string {
  if (validation.kind === "valid") {
    return "検証済み";
  }
  return validation.errors.map((error) => error.message).join("、");
}

function statusLabel(status: "not_started" | "in_progress"): string {
  return status === "not_started" ? "未着手" : "進行中";
}

function operationStatusLabel(operation: CreateTaskOperation): string {
  return operation.after.status == null ? "指定なし" : statusLabel(operation.after.status);
}

function notesLabel(operation: CreateTaskOperation): string {
  const notes = operation.after.notes;
  return notes == null || notes.length === 0 ? "なし" : notes;
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

function dueLabel(due: CreateTaskOperation["after"]["due"]): string {
  if (due == null) {
    return "指定なし";
  }
  return due.kind === "due_on" ? due.due_on : `${due.due_at} UTC`;
}

function selectProposal(proposalId: string): void {
  selectedProposalId.value = proposalId;
  editingProposal.value = undefined;
}

function startEditing(): void {
  const proposal = requireSelectedProposal();
  const operation = createOperation.value;
  if (proposal.state.kind !== "pending_approval" || operation == null) {
    return;
  }
  editingProposal.value = {
    proposal_id: proposal.proposal_id,
    operation,
    revision: proposal.revision,
  };
}

function cancelEditing(): void {
  editingProposal.value = undefined;
}

function setEnabled(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("外部連携の有効化入力が不正です。");
  }
  emit("set-enabled", input.checked);
}

function edit(input: ExternalAgentGuiEditInput): void {
  const parsedInput = externalAgentGuiEditInputSchema.parse(input);
  emit("edit", parsedInput);
}

function approve(): void {
  const proposal = requireSelectedProposal();
  emit("approve", externalAgentGuiApproveInputSchema.parse({
    proposal_id: proposal.proposal_id,
    revision: proposal.revision,
  }));
}

function reject(): void {
  const proposal = requireSelectedProposal();
  emit("reject", externalAgentGuiRejectInputSchema.parse({
    proposal_id: proposal.proposal_id,
    revision: proposal.revision,
  }));
}
</script>

<template>
  <div class="min-w-0 space-y-5">
    <section class="rounded-lg border border-slate-200 p-4 dark:border-slate-700">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h3 class="text-base font-semibold text-slate-900 dark:text-slate-100">
            外部連携
          </h3>
          <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
            外部エージェントから届いた提案を確認します。
          </p>
        </div>
        <span
          class="shrink-0 rounded-full px-2 py-1 text-xs"
          :class="bridgeClass(props.state.bridge)"
        >
          連携: {{ bridgeLabel(props.state.bridge) }}
        </span>
      </div>
      <label class="mt-4 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          class="mt-0.5 size-4 shrink-0"
          :checked="props.state.enabled"
          :disabled="props.busy"
          @change="setEnabled"
        >
        <span>
          外部連携を有効にする
          <span class="mt-1 block text-xs text-slate-600 dark:text-slate-400">
            外部からの一覧参照と新規タスク提案を受け付けます。
          </span>
        </span>
      </label>
      <details class="mt-4 rounded-md border border-slate-200 p-3 dark:border-slate-700">
        <summary class="cursor-pointer text-sm font-medium text-slate-800 dark:text-slate-100">
          連携登録の案内
        </summary>
        <div class="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
          <p class="whitespace-pre-wrap break-words">
            {{ props.state.registration.instructions }}
          </p>
          <p>Codexを使うWSLまたはMacのターミナルで、次のコマンドを実行してください。</p>
          <div class="min-w-0">
            <p class="text-xs text-slate-600 dark:text-slate-400">
              登録コマンド
            </p>
            <code class="mt-1 block overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{{ props.state.registration.command }}</code>
          </div>
          <div class="min-w-0">
            <p class="text-xs text-slate-600 dark:text-slate-400">
              実行許可を設定するコマンド
            </p>
            <code class="mt-1 block overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{{ props.state.registration.allow_execution_command }}</code>
          </div>
          <p class="text-xs text-slate-600 dark:text-slate-400">
            固定ランチャーだけを許可し、登録後は外部Codexを再起動してください。
          </p>
        </div>
      </details>
    </section>

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
              @click="selectProposal(proposal.proposal_id)"
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

          <div
            v-if="createOperation == null"
            class="mt-4 rounded-md bg-rose-50 p-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
            role="alert"
          >
            新規タスク作成の提案を表示できません。
          </div>
          <template v-else>
            <dl class="mt-4 grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-4">
              <dt class="text-slate-600 dark:text-slate-400">
                作成内容
              </dt>
              <dd class="min-w-0 break-words text-slate-800 dark:text-slate-100">
                <ul class="space-y-1">
                  <li>タイトル: {{ requireCreateOperation().after.title }}</li>
                  <li v-if="requireCreateOperation().after.notes != null">
                    説明: {{ notesLabel(requireCreateOperation()) }}
                  </li>
                  <li>状態: {{ operationStatusLabel(requireCreateOperation()) }}</li>
                  <li v-if="requireCreateOperation().after.importance != null">
                    重要度: {{ requireCreateOperation().after.importance }}
                  </li>
                  <li v-if="requireCreateOperation().after.area != null">
                    領域: {{ requireCreateOperation().after.area }}
                  </li>
                  <li v-if="requireCreateOperation().after.due != null">
                    期限: {{ dueLabel(requireCreateOperation().after.due) }}
                  </li>
                </ul>
              </dd>
              <dt class="text-slate-600 dark:text-slate-400">
                理由
              </dt>
              <dd class="min-w-0 break-words text-slate-800 dark:text-slate-100">
                {{ requireCreateOperation().reason }}
              </dd>
              <dt class="text-slate-600 dark:text-slate-400">
                確信度
              </dt>
              <dd class="text-slate-800 dark:text-slate-100">
                {{ Math.round(requireCreateOperation().confidence * 100) }}%
              </dd>
              <dt class="text-slate-600 dark:text-slate-400">
                検証結果
              </dt>
              <dd class="min-w-0 break-words text-slate-800 dark:text-slate-100">
                基本: {{ validationLabel(validationFor(requireSelectedProposal(), 'basic')) }}・グラフ: {{ validationLabel(validationFor(requireSelectedProposal(), 'graph')) }}
                <span class="mt-1 block text-xs text-slate-600 dark:text-slate-400">基本: {{ validationDetail(validationFor(requireSelectedProposal(), 'basic')) }} / グラフ: {{ validationDetail(validationFor(requireSelectedProposal(), 'graph')) }}</span>
              </dd>
            </dl>

            <ProposalOperationEditor
              v-if="editingProposalId === requireSelectedProposal().proposal_id"
              class="mt-4 border-t border-slate-200 pt-4 dark:border-slate-700"
              :operation="requireEditingProposal().operation"
              :proposal-id="requireEditingProposal().proposal_id"
              :tasks="[]"
              :creations="[]"
              :disabled="props.busy"
              :mode="{ kind: 'external-create', revision: requireEditingProposal().revision }"
              @external-save="edit"
              @cancel="cancelEditing"
            />

            <div class="mt-4 flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-700">
              <button
                v-if="requireSelectedProposal().state.kind === 'pending_approval' && editingProposalId !== requireSelectedProposal().proposal_id"
                type="button"
                class="secondary-button"
                :disabled="props.busy"
                @click="startEditing"
              >
                作成内容を編集
              </button>
              <button
                v-if="requireSelectedProposal().state.kind === 'pending_approval'"
                type="button"
                class="primary-button"
                :disabled="props.busy || editingProposalId === requireSelectedProposal().proposal_id"
                @click="approve"
              >
                {{ props.busy ? '処理中' : '承認して登録' }}
              </button>
              <button
                v-if="requireSelectedProposal().state.kind === 'pending_approval'"
                type="button"
                class="secondary-button"
                :disabled="props.busy || editingProposalId === requireSelectedProposal().proposal_id"
                @click="reject"
              >
                却下
              </button>
            </div>
          </template>

          <div
            v-if="requireSelectedProposal().state.kind === 'finished'"
            class="mt-4 rounded-md p-3 text-sm"
            :class="finishedOutcomeClass(requireSelectedProposal())"
            role="status"
          >
            登録結果: {{ finishedOutcomeLabel(requireSelectedProposal()) }}
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
