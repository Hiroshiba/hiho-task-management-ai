<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowTurnRequestSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
} from "../../shared/ai-workflow";
import type { ProposalOperation } from "../../shared/ai";
import type { RendererAiState } from "./state";

const props = defineProps<{
  state: RendererAiState;
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
}>();

const message = ref("");
const selectionMode = ref<"all" | "groups" | "operations">("all");
const selectedGroupIds = ref<string[]>([]);
const selectedOperationIds = ref<string[]>([]);
const editingOperationId = ref<string | undefined>();
const editValue = ref("");
const editEvidence = ref("");
const localError = ref("");

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

const proposalMessage = computed(() => {
  switch (props.state.kind) {
    case "proposal":
      return props.state.message;
    case "idle":
    case "streaming":
    case "questions":
    case "unavailable":
      return props.state.pending_proposal?.message;
    case "applied":
      return undefined;
  }
});

const responseQuestions = computed(() => {
  if (props.state.kind === "proposal" || props.state.kind === "questions") {
    return props.state.questions;
  }
  return [];
});

const questionResponseMessage = computed(() => {
  if (props.state.kind === "questions") {
    return props.state.message;
  }
  if (props.state.kind === "proposal" && props.state.questions.length > 0) {
    return props.state.message;
  }
  return undefined;
});

function requireProposal(): AiWorkflowProposalView {
  const current = proposal.value;
  if (current == null) {
    throw new Error("表示中の変更案がありません。");
  }
  return current;
}

function selectCurrentProposal(): void {
  selectProposal(requireProposal());
}

function approveCurrentProposal(): void {
  approveProposal(requireProposal());
}

function rejectCurrentProposal(): void {
  emit("reject", requireProposal().proposal_id);
}

function saveCurrentEdit(operation: ProposalOperation): void {
  saveEdit(requireProposal(), operation);
}

watch(
  () => proposal.value?.proposal_id,
  () => {
    selectionMode.value = "all";
    selectedGroupIds.value = [];
    selectedOperationIds.value = [];
    editingOperationId.value = undefined;
    editValue.value = "";
    editEvidence.value = "";
    localError.value = "";
  },
);

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

function toggleValue(values: string[], value: string): string[] {
  if (values.includes(value)) {
    return values.filter((candidate) => candidate !== value);
  }
  return [...values, value];
}

function selectProposal(proposal: AiWorkflowProposalView): void {
  let selection: AiWorkflowSelectionRequest["selection"];
  if (selectionMode.value === "all") {
    selection = { kind: "all" };
  } else if (selectionMode.value === "groups") {
    selection = { kind: "groups", group_ids: selectedGroupIds.value };
  } else {
    selection = { kind: "operations", operation_ids: selectedOperationIds.value };
  }
  try {
    emit("select", aiWorkflowSelectionRequestSchema.parse({
      proposal_id: proposal.proposal_id,
      selection,
    }));
  } catch {
    localError.value = "選択するグループまたは操作を指定してください。";
  }
}

function approveProposal(proposal: AiWorkflowProposalView): void {
  let selection: AiWorkflowApprovalRequest["selection"];
  if (selectionMode.value === "all") {
    selection = { kind: "all" };
  } else if (selectionMode.value === "groups") {
    selection = { kind: "groups", group_ids: selectedGroupIds.value };
  } else {
    selection = { kind: "operations", operation_ids: selectedOperationIds.value };
  }
  try {
    emit("approve", aiWorkflowApprovalRequestSchema.parse({
      proposal_id: proposal.proposal_id,
      selection,
    }));
  } catch {
    localError.value = "承認するグループまたは操作を指定してください。";
  }
}

function operationLabel(operation: ProposalOperation): string {
  switch (operation.operation) {
    case "create_task":
      return "タスク作成";
    case "update_title":
      return "タイトル変更";
    case "update_notes":
      return "説明変更";
    case "set_status":
      return "状態変更";
    case "set_importance":
      return "重要度変更";
    case "set_due":
      return "期限設定";
    case "clear_due":
      return "期限解除";
    case "set_area":
      return "領域変更";
    case "set_dependencies":
      return "依存関係変更";
    case "set_parent":
      return "親子関係変更";
    case "set_parent_work_mode":
      return "親作業モード変更";
    case "link_obsidian":
      return "Obsidianリンク追加";
    case "unlink_obsidian":
      return "Obsidianリンク解除";
    case "complete":
      return "完了";
    case "withdraw":
      return "取り下げ";
  }
}

function targetLabel(operation: ProposalOperation): string {
  if (operation.operation === "create_task") {
    return `新規 ${operation.temporary_ref}`;
  }
  if (operation.target.kind === "existing") {
    return operation.target.gid;
  }
  return `一時参照 ${operation.target.ref}`;
}

function valueLabel(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized == null) {
    return "値を表示できません";
  }
  return serialized;
}

function startEditing(operation: ProposalOperation): void {
  editingOperationId.value = operation.operation_id;
  editValue.value = valueLabel(operation.after);
  editEvidence.value = "user_message";
  localError.value = "";
}

function saveEdit(proposal: AiWorkflowProposalView, operation: ProposalOperation): void {
  let parsedValue: unknown = editValue.value;
  try {
    parsedValue = JSON.parse(editValue.value);
  } catch {
    parsedValue = editValue.value;
  }
  try {
    const edit = aiWorkflowOperationEditSchema.parse({
      proposal_id: proposal.proposal_id,
      operation_id: operation.operation_id,
      after: parsedValue,
      evidence_locator: editEvidence.value,
    });
    emit("edit", edit);
    editingOperationId.value = undefined;
  } catch {
    localError.value = "操作後の値と根拠locatorを確認してください。";
  }
}

function operationValidation(proposal: AiWorkflowProposalView, operationId: string): string {
  const basic = proposal.basic_validation.operations.find((item) => item.operation_id === operationId);
  const graph = proposal.graph_validation.operations.find((item) => item.operation_id === operationId);
  if (basic?.kind === "invalid" || graph?.kind === "invalid") {
    return "適用不可";
  }
  return "適用候補";
}

function selectedGroup(groupId: string): boolean {
  return selectedGroupIds.value.includes(groupId);
}

function selectedOperation(operationId: string): boolean {
  return selectedOperationIds.value.includes(operationId);
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
      return "確認不能";
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
}
</script>

<template>
  <section
    class="rounded-xl border border-slate-200 bg-white shadow-sm"
    aria-labelledby="ai-panel-title"
  >
    <div class="border-b border-slate-200 px-5 py-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p class="text-sm font-semibold text-violet-700">
            AIアシスタント
          </p><h2
            id="ai-panel-title"
            class="mt-1 text-xl font-semibold text-slate-900"
          >
            変更案を安全に確認
          </h2>
        </div>
        <span class="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">未承認案はメモリ上だけに保持</span>
      </div>
    </div>

    <div class="space-y-5 p-5">
      <p
        v-if="localError.length > 0"
        class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800"
        role="alert"
      >
        {{ localError }}
      </p>
      <div
        v-if="props.state.kind === 'idle' || props.state.kind === 'questions' || props.state.kind === 'proposal'"
        class="space-y-3"
      >
        <form @submit.prevent="sendMessage">
          <label
            class="field-label"
            for="ai-message"
          >質問や依頼<textarea
            id="ai-message"
            v-model="message"
            class="text-input min-h-24"
            :disabled="!props.canSendAi"
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
          class="text-sm text-amber-800"
          role="status"
          aria-live="polite"
        >
          {{ props.aiSendDisabledReason }}
        </p>
        <p
          v-if="proposal != null"
          class="text-xs text-slate-600"
        >
          表示中の変更案を保持したまま追質問や再提案を依頼できます。
        </p>
      </div>

      <div
        v-if="props.state.kind === 'streaming'"
        class="space-y-3"
        aria-live="polite"
        aria-busy="true"
      >
        <div
          v-if="props.state.text.length === 0"
          class="flex items-center gap-3 rounded-md bg-slate-50 p-4"
          role="status"
        >
          <span
            class="inline-block size-4 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600"
            aria-hidden="true"
          /><p class="text-sm font-medium text-slate-800">
            AIが回答を準備しています
          </p>
        </div>
        <template v-else>
          <p class="text-sm font-medium text-slate-800">
            Codexの応答
          </p><pre class="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-4 text-sm leading-6 text-slate-800">{{ props.state.text }}</pre>
        </template>
      </div>

      <div
        v-if="questionResponseMessage != null"
        class="space-y-3"
        aria-live="polite"
      >
        <p class="text-sm text-slate-700">
          {{ questionResponseMessage }}
        </p><ul class="space-y-3">
          <li
            v-for="question in responseQuestions"
            :key="question.question_id"
            class="rounded-md border border-slate-200 p-3"
          >
            <p class="font-medium text-slate-900">
              {{ question.text }}
            </p><div
              v-if="question.options != null"
              class="mt-2 flex flex-wrap gap-2"
            >
              <button
                v-for="option in question.options"
                :key="option"
                type="button"
                class="choice-button"
                :disabled="!props.canSendAi"
                @click="message = option"
              >
                {{ option }}
              </button>
            </div>
          </li>
        </ul>
      </div>

      <template v-if="proposal != null">
        <div class="rounded-md bg-slate-50 p-4">
          <p class="text-sm font-medium text-slate-900">
            {{ proposalMessage }}
          </p><p class="mt-1 text-xs text-slate-600">
            基準スナップショット: {{ requireProposal().baseline_snapshot_hash }}
          </p><p class="mt-1 text-xs text-slate-600">
            影響タスク: {{ requireProposal().impact.impacted_task_count }}件
          </p>
        </div>
        <div class="space-y-3">
          <h3 class="section-heading">
            変更案
          </h3><div
            v-for="group in requireProposal().proposal.groups"
            :key="group.group_id"
            class="rounded-md border border-slate-200 p-4"
          >
            <div class="flex flex-wrap items-center gap-3">
              <input
                v-if="selectionMode === 'groups'"
                :checked="selectedGroup(group.group_id)"
                type="checkbox"
                :aria-label="`${group.group_id}を選択`"
                @change="selectedGroupIds = toggleValue(selectedGroupIds, group.group_id)"
              ><span class="font-medium text-slate-900">{{ group.group_id }}</span><span class="text-xs text-slate-600">{{ group.atomic ? '一括適用' : '個別適用' }}</span><span
                v-if="selectionMode === 'operations' && group.atomic"
                class="text-xs text-slate-600"
              >一括選択で適用</span>
            </div><div class="mt-3 space-y-3">
              <article
                v-for="operation in group.operations"
                :key="operation.operation_id"
                class="rounded-md bg-slate-50 p-3"
              >
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p class="font-medium text-slate-900">
                      {{ operationLabel(operation) }} <span class="text-xs font-normal text-slate-600">{{ targetLabel(operation) }}</span>
                    </p><p class="mt-1 text-xs text-slate-600">
                      {{ operationValidation(requireProposal(), operation.operation_id) }}・{{ operation.basis === 'explicit' ? '明示' : '推測' }}・信頼度 {{ operation.confidence }}
                    </p>
                  </div><label
                    v-if="selectionMode === 'operations' && !group.atomic"
                    class="inline-flex items-center gap-2 text-xs text-slate-700"
                  ><input
                    :checked="selectedOperation(operation.operation_id)"
                    type="checkbox"
                    :aria-label="`${operation.operation_id}を選択`"
                    @change="selectedOperationIds = toggleValue(selectedOperationIds, operation.operation_id)"
                  >操作を選択</label>
                </div><dl class="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <dt class="text-slate-600">
                    変更前
                  </dt><dd class="break-words text-slate-800">
                    {{ valueLabel(operation.before) }}
                  </dd><dt class="text-slate-600">
                    変更後
                  </dt><dd class="break-words text-slate-800">
                    {{ valueLabel(operation.after) }}
                  </dd><dt class="text-slate-600">
                    理由
                  </dt><dd class="break-words text-slate-800">
                    {{ operation.reason }}
                  </dd><dt class="text-slate-600">
                    根拠
                  </dt><dd class="break-words text-slate-800">
                    <span
                      v-for="evidence in operation.evidence_refs"
                      :key="`${evidence.kind}-${evidence.locator}`"
                      class="mr-2 inline-block"
                    >{{ evidence.kind }}: {{ evidence.locator }}</span>
                  </dd>
                </dl><button
                  type="button"
                  class="text-button mt-3"
                  :disabled="!props.canWrite"
                  @click="startEditing(operation)"
                >
                  変更後を編集
                </button><form
                  v-if="editingOperationId === operation.operation_id"
                  class="mt-3 grid gap-2 border-t border-slate-200 pt-3"
                  @submit.prevent="saveCurrentEdit(operation)"
                >
                  <label
                    class="field-label"
                    :for="`edit-${operation.operation_id}`"
                  >変更後の値<textarea
                    :id="`edit-${operation.operation_id}`"
                    v-model="editValue"
                    class="text-input min-h-20"
                    :disabled="!props.canWrite"
                  /></label><label
                    class="field-label"
                    :for="`evidence-${operation.operation_id}`"
                  >ユーザー編集の根拠locator<input
                    :id="`evidence-${operation.operation_id}`"
                    v-model="editEvidence"
                    class="text-input"
                    :disabled="!props.canWrite"
                  ></label><button
                    type="submit"
                    class="secondary-button self-start"
                    :disabled="!props.canWrite"
                  >
                    編集を再検証
                  </button>
                </form>
              </article>
            </div>
          </div>
        </div>
        <div class="flex flex-wrap gap-2">
          <label class="inline-flex items-center gap-2 text-sm text-slate-700"><input
            v-model="selectionMode"
            type="radio"
            value="all"
          >全体</label><label class="inline-flex items-center gap-2 text-sm text-slate-700"><input
            v-model="selectionMode"
            type="radio"
            value="groups"
          >グループ単位</label><label class="inline-flex items-center gap-2 text-sm text-slate-700"><input
            v-model="selectionMode"
            type="radio"
            value="operations"
          >非一括操作単位</label><button
            type="button"
            class="primary-button"
            :disabled="!props.canWrite"
            @click="selectCurrentProposal"
          >
            選択を反映
          </button><button
            type="button"
            class="primary-button"
            :disabled="!props.canWrite"
            @click="approveCurrentProposal"
          >
            選択した変更案を承認
          </button><button
            type="button"
            class="secondary-button"
            :disabled="!props.canWrite"
            @click="rejectCurrentProposal"
          >
            変更案を却下
          </button>
        </div>
        <div>
          <h3 class="section-heading">
            順位への予測影響
          </h3><ul class="mt-2 space-y-1 text-sm text-slate-700">
            <li
              v-for="change in requireProposal().impact.rank_changes"
              :key="change.task_gid"
            >
              {{ change.task_gid }}: {{ change.before_rank == null ? '順位なし' : `順位${change.before_rank}` }} → {{ change.after_rank == null ? '順位なし' : `順位${change.after_rank}` }}
            </li>
          </ul>
        </div>
      </template>

      <div
        v-if="props.state.kind === 'applied'"
        class="rounded-md bg-emerald-50 p-4"
        role="status"
      >
        <p class="font-medium text-emerald-900">
          {{ props.state.message }}
        </p><p class="mt-2 text-sm text-emerald-900">
          結果: {{ applicationOutcomeLabel(props.state.result.application.outcome) }}
        </p><div class="mt-3 grid gap-3 text-sm text-emerald-950 sm:grid-cols-2">
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
      </div>
      <div
        v-if="props.state.kind === 'unavailable'"
        class="rounded-md bg-amber-50 p-4"
        role="alert"
      >
        <p class="font-medium text-amber-900">
          AIは利用できません。
        </p><p class="mt-1 text-sm text-amber-900">
          {{ props.state.failure.message }}
        </p>
      </div>
    </div>
  </section>
</template>
