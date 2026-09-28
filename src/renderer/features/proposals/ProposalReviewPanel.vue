<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { proposalSelectionSchema, type ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import type { ProposalEditInput, ProposalEditResult, ProposalOperation, ProposalSelectionInput } from "./proposal-presentation";
import {
  CheckboxIndicator,
  CheckboxRoot,
  RadioGroupIndicator,
  RadioGroupItem,
  RadioGroupRoot,
} from "reka-ui";
import ProposalOperationEditor from "./ProposalOperationEditor.vue";
import { useProposalReviewPresentation } from "./use-proposal-review-presentation";
import { evidenceKindLabel, statusEvidenceDetails, operationEvidenceExcerpts } from "./proposal-evidence-presentation";

type TaskTitleReference = {
  readonly gid: string;
  readonly title: string;
};
type CreateTaskOperation = Extract<ProposalOperation, { operation: "create_task" }>;

const props = defineProps<{
  proposal: ProposalViewDto;
  tasks: readonly TaskTitleReference[];
  canWrite: boolean;
  reviewMode: "interactive" | "read-only";
  editResult?: ProposalEditResult | undefined;
}>();

const emit = defineEmits<{
  (event: "select", input: ProposalSelectionInput): void;
  (event: "edit", input: ProposalEditInput): void;
  (event: "approve", input: ProposalSelectionInput): void;
  (event: "reject", proposalId: string): void;
  (event: "select-task", taskGid: string): void;
}>();

const {
  createTaskOperations,
  targetLabel,
  targetDetailLabel,
  rankTaskLabel,
  operationValueLines,
  rankPositionLabel,
  targetGid,
  selectExistingTask,
  relatedTaskGids,
} = useProposalReviewPresentation(() => props.tasks, (gid) => emit("select-task", gid));
const creations = computed((): readonly CreateTaskOperation[] => createTaskOperations(props.proposal));
const proposal = computed(() => props.proposal);
const selectionMode = ref<"all" | "groups" | "operations">("all");
const selectedGroupIds = ref<string[]>([]);
const selectedOperationIds = ref<string[]>([]);
const editingOperationId = ref<string | undefined>();
const pendingEdit = ref<{ readonly proposal_id: string; readonly operation_id: string; readonly revision: number | undefined }>();
const localError = ref("");

function requireProposal(): ProposalViewDto {
  return props.proposal;
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

function resetProposalState(): void {
  selectionMode.value = "all";
  selectedGroupIds.value = [];
  selectedOperationIds.value = [];
  editingOperationId.value = undefined;
  pendingEdit.value = undefined;
  localError.value = "";
}

watch(
  () => props.editResult,
  (result) => {
    const pending = pendingEdit.value;
    if (pending == null || result == null) {
      return;
    }
    if (result.proposal_id !== pending.proposal_id
      || result.operation_id !== pending.operation_id
      || result.revision !== pending.revision) {
      return;
    }
    pendingEdit.value = undefined;
    if (result.kind === "saved") {
      editingOperationId.value = undefined;
      localError.value = "";
      return;
    }
    localError.value = "変更案を保存できませんでした。入力内容を確認して再試行してください。";
  },
);

watch(
  () => props.reviewMode,
  (mode) => {
    if (mode === "read-only") {
      pendingEdit.value = undefined;
      editingOperationId.value = undefined;
    }
  },
);

function updateSelection(values: string[], value: string, checked: boolean): string[] {
  const selected = values.includes(value);
  if (checked === selected) {
    return values;
  }
  if (checked) {
    return [...values, value];
  }
  return values.filter((candidate) => candidate !== value);
}

function updateGroupSelection(groupId: string, value: boolean | "indeterminate"): void {
  if (value === "indeterminate") {
    throw new TypeError("変更グループ選択値の形式が不正です。");
  }
  selectedGroupIds.value = updateSelection(selectedGroupIds.value, groupId, value);
}

function updateOperationSelection(operationId: string, value: boolean | "indeterminate"): void {
  if (value === "indeterminate") {
    throw new TypeError("変更操作選択値の形式が不正です。");
  }
  selectedOperationIds.value = updateSelection(selectedOperationIds.value, operationId, value);
}

function updateSelectionMode(value: unknown): void {
  if (value !== "all" && value !== "groups" && value !== "operations") {
    throw new TypeError("適用範囲の形式が不正です。");
  }
  selectionMode.value = value;
}

function selectProposal(proposal: ProposalViewDto): void {
  let selection: ProposalSelectionInput["selection"];
  if (selectionMode.value === "all") {
    selection = { kind: "all" };
  } else if (selectionMode.value === "groups") {
    selection = { kind: "groups", group_ids: selectedGroupIds.value };
  } else {
    selection = { kind: "operations", operation_ids: selectedOperationIds.value };
  }
  const parsed = proposalSelectionSchema.safeParse(selection);
  if (!parsed.success) {
    localError.value = "選択するグループまたは操作を指定してください。";
    return;
  }
  emit("select", { proposal_id: proposal.proposal_id, selection: parsed.data });
}

function approveProposal(proposal: ProposalViewDto): void {
  let selection: ProposalSelectionInput["selection"];
  if (selectionMode.value === "all") {
    selection = { kind: "all" };
  } else if (selectionMode.value === "groups") {
    selection = { kind: "groups", group_ids: selectedGroupIds.value };
  } else {
    selection = { kind: "operations", operation_ids: selectedOperationIds.value };
  }
  const parsed = proposalSelectionSchema.safeParse(selection);
  if (!parsed.success) {
    localError.value = "承認するグループまたは操作を指定してください。";
    return;
  }
  emit("approve", { proposal_id: proposal.proposal_id, selection: parsed.data });
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
    case "set_duration":
      return "所要時間設定";
    case "clear_duration":
      return "所要時間解除";
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

function startEditing(operation: ProposalOperation): void {
  editingOperationId.value = operation.operation_id;
  pendingEdit.value = undefined;
  localError.value = "";
}

function saveEditedOperation(input: ProposalEditInput): void {
  if (pendingEdit.value != null) return;
  pendingEdit.value = { proposal_id: input.proposal_id, operation_id: input.operation_id, revision: props.proposal.revision };
  emit("edit", input);
}

function cancelEditing(): void {
  pendingEdit.value = undefined;
  editingOperationId.value = undefined;
}

function operationIsApplicable(proposal: ProposalViewDto, operationId: string): boolean {
  const basic = proposal.basic_validation.operations.find((item) => item.operation_id === operationId);
  if (basic == null) {
    throw new Error("basic validationに操作の検証結果がありません。");
  }
  const graph = proposal.graph_validation.operations.find((item) => item.operation_id === operationId);
  if (graph == null) {
    throw new Error("graph validationに操作の検証結果がありません。");
  }
  return basic.kind === "valid" && graph.kind === "valid";
}

function operationIsSelectableInOperationsMode(
  proposal: ProposalViewDto,
  operationId: string,
): boolean {
  const group = proposal.groups.find((candidate) =>
    candidate.operations.some((operation) => operation.operation_id === operationId));
  if (group == null || group.atomic) {
    return false;
  }
  return operationIsApplicable(proposal, operationId);
}

function synchronizeProposalSelections(proposal: ProposalViewDto): void {
  const selectedOperationIdsFromServer = new Set(proposal.selected_operation_ids);
  selectedGroupIds.value = proposal.groups
    .filter((group) =>
      groupIsApplicable(proposal, group.group_id)
      && group.operations.every((operation) => selectedOperationIdsFromServer.has(operation.operation_id)))
    .map((group) => group.group_id);
  selectedOperationIds.value = proposal.selected_operation_ids.filter((operationId) => {
    const group = proposal.groups.find((candidate) =>
      candidate.operations.some((operation) => operation.operation_id === operationId));
    if (group == null || !operationIsApplicable(proposal, operationId)) {
      return false;
    }
    return selectionMode.value !== "operations" || !group.atomic;
  });
}

watch(
  () => proposal.value,
  (currentProposal, previousProposal) => {
    if (
      currentProposal == null
      || previousProposal == null
      || previousProposal.proposal_id !== currentProposal.proposal_id
    ) {
      resetProposalState();
      return;
    }
    synchronizeProposalSelections(currentProposal);
  },
);

watch(selectionMode, (mode) => {
  if (mode !== "operations") {
    return;
  }
  const currentProposal = proposal.value;
  if (currentProposal == null) {
    return;
  }
  selectedOperationIds.value = selectedOperationIds.value.filter((operationId) =>
    operationIsSelectableInOperationsMode(currentProposal, operationId));
});

function operationValidation(proposal: ProposalViewDto, operationId: string): string {
  return operationIsApplicable(proposal, operationId) ? "適用候補" : "適用不可";
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function groupIsApplicable(proposal: ProposalViewDto, groupId: string): boolean {
  const group = proposal.groups.find((candidate) => candidate.group_id === groupId);
  if (group == null) {
    throw new Error("変更グループが変更案にありません。");
  }
  return group.operations.every((operation) => operationIsApplicable(proposal, operation.operation_id));
}

function proposalHasInapplicableOperation(proposal: ProposalViewDto): boolean {
  return proposal.groups.some((group) =>
    group.operations.some((operation) => !operationIsApplicable(proposal, operation.operation_id)));
}

function selectedGroup(groupId: string): boolean {
  return selectedGroupIds.value.includes(groupId);
}

function selectedOperation(operationId: string): boolean {
  return selectedOperationIds.value.includes(operationId);
}

const hasInapplicableOperation = computed(() => {
  const currentProposal = proposal.value;
  return currentProposal != null && proposalHasInapplicableOperation(currentProposal);
});

const selectionCanBeSubmitted = computed(() => {
  const currentProposal = proposal.value;
  if (currentProposal == null) {
    return false;
  }
  switch (selectionMode.value) {
    case "all":
      return !hasInapplicableOperation.value;
    case "groups":
      return selectedGroupIds.value.length > 0
        && selectedGroupIds.value.every((groupId) => groupIsApplicable(currentProposal, groupId));
    case "operations":
      return selectedOperationIds.value.length > 0
        && selectedOperationIds.value.every((operationId) =>
          operationIsSelectableInOperationsMode(currentProposal, operationId));
  }
});

</script>

<template>
  <div class="space-y-5">
    <p
      v-if="localError.length > 0"
      class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
      role="alert"
    >
      {{ localError }}
    </p>
    <template v-if="proposal != null">
      <div
        v-if="props.reviewMode === 'interactive'"
        class="rounded-md bg-slate-50 p-4 dark:bg-slate-800"
      >
        <p class="text-sm text-slate-700 dark:text-slate-300">
          承認するまでAsanaには反映されません。
        </p><p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
          影響を受けるタスク: {{ requireProposal().impact.impacted_task_count }}件
        </p>
      </div>
      <div class="space-y-3">
        <h3 class="section-heading">
          変更案
        </h3><div
          v-for="(group, groupIndex) in requireProposal().groups"
          :key="group.group_id"
          class="rounded-md border border-slate-200 p-4 dark:border-slate-700"
        >
          <div class="flex flex-wrap items-center gap-3">
            <CheckboxRoot
              v-if="props.reviewMode === 'interactive' && selectionMode === 'groups'"
              :model-value="selectedGroup(group.group_id)"
              :disabled="!groupIsApplicable(requireProposal(), group.group_id)"
              :aria-label="`変更グループ ${groupIndex + 1}を選択`"
              class="inline-flex size-4 shrink-0 items-center justify-center rounded border border-slate-400 bg-white text-xs text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 data-[state=checked]:border-sky-600 data-[state=checked]:bg-sky-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 dark:border-slate-500 dark:bg-slate-800 dark:text-sky-300 dark:data-[state=checked]:border-sky-400 dark:data-[state=checked]:bg-sky-950 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
              @update:model-value="(value: boolean | 'indeterminate') => updateGroupSelection(group.group_id, value)"
            >
              <CheckboxIndicator aria-hidden="true">
                ✓
              </CheckboxIndicator>
            </CheckboxRoot><span class="font-medium text-slate-900 dark:text-slate-100">変更グループ {{ groupIndex + 1 }}</span><span class="text-xs text-slate-600 dark:text-slate-400">{{ group.atomic ? '一括適用' : '個別適用' }}</span><span
              v-if="selectionMode === 'operations' && group.atomic"
              class="text-xs text-slate-600 dark:text-slate-400"
            >一括選択で適用</span>
          </div><div class="mt-3 space-y-3">
            <article
              v-for="operation in group.operations"
              :key="operation.operation_id"
              class="rounded-md p-3"
              :class="operationIsApplicable(requireProposal(), operation.operation_id) ? 'bg-slate-50 dark:bg-slate-800' : 'border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950'"
            >
              <div class="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p class="font-medium text-slate-900 dark:text-slate-100">
                    {{ operationLabel(operation) }}
                    <button
                      v-if="targetGid(operation) != null"
                      type="button"
                      class="text-button text-xs font-normal text-slate-600 dark:text-slate-400"
                      @click="selectExistingTask(operation)"
                    >
                      {{ targetLabel(requireProposal(), operation) }}
                    </button><span
                      v-else
                      class="text-xs font-normal text-slate-600 dark:text-slate-400"
                    >{{ targetLabel(requireProposal(), operation) }}</span>
                  </p><p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
                    {{ operationValidation(requireProposal(), operation.operation_id) }}・{{ operation.basis === 'explicit' ? '明示' : '推測' }}・信頼度 {{ confidenceLabel(operation.confidence) }}
                  </p>
                  <p
                    v-if="relatedTaskGids(operation).length > 0"
                    class="mt-2 text-xs text-slate-600 dark:text-slate-400"
                  >
                    関連タスク:
                    <button
                      v-for="taskGid in relatedTaskGids(operation)"
                      :key="taskGid"
                      type="button"
                      class="text-button ml-1"
                      :aria-label="`関連タスク ${taskGid}を表示`"
                      @click="emit('select-task', taskGid)"
                    >
                      {{ taskGid }}
                    </button>
                  </p>
                </div><label
                  v-if="props.reviewMode === 'interactive' && selectionMode === 'operations' && !group.atomic"
                  class="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"
                ><CheckboxRoot
                  :model-value="selectedOperation(operation.operation_id)"
                  :disabled="!operationIsApplicable(requireProposal(), operation.operation_id)"
                  :aria-label="`${operationLabel(operation)}を選択`"
                  class="inline-flex size-4 shrink-0 items-center justify-center rounded border border-slate-400 bg-white text-xs text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 data-[state=checked]:border-sky-600 data-[state=checked]:bg-sky-100 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 dark:border-slate-500 dark:bg-slate-800 dark:text-sky-300 dark:data-[state=checked]:border-sky-400 dark:data-[state=checked]:bg-sky-950 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
                  @update:model-value="(value: boolean | 'indeterminate') => updateOperationSelection(operation.operation_id, value)"
                ><CheckboxIndicator aria-hidden="true">✓</CheckboxIndicator></CheckboxRoot>操作を選択</label>
              </div><dl class="mt-3 grid min-w-0 grid-cols-1 gap-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-4">
                <dt class="text-slate-600 dark:text-slate-400">
                  変更前
                </dt><dd class="min-w-0 whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
                  <ul class="space-y-1">
                    <li
                      v-for="line in operationValueLines(requireProposal(), operation, 'before')"
                      :key="line"
                    >
                      {{ line }}
                    </li>
                  </ul>
                </dd><dt class="text-slate-600 dark:text-slate-400">
                  変更後
                </dt><dd class="min-w-0 whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
                  <ul class="space-y-1">
                    <li
                      v-for="line in operationValueLines(requireProposal(), operation, 'after')"
                      :key="line"
                    >
                      {{ line }}
                    </li>
                  </ul>
                </dd><dt class="text-slate-600 dark:text-slate-400">
                  理由
                </dt><dd class="break-words text-slate-800 dark:text-slate-100">
                  {{ operation.reason }}
                </dd><dt class="text-slate-600 dark:text-slate-400">
                  根拠
                </dt><dd class="break-words text-slate-800 dark:text-slate-100">
                  <span
                    v-for="evidence in operation.evidence_refs"
                    :key="`${evidence.kind}-${evidence.locator}`"
                    class="mr-2 inline-block"
                  >{{ evidenceKindLabel(evidence.kind) }}</span>
                  <span
                    v-for="detail in statusEvidenceDetails(operation)"
                    :key="detail"
                    class="mr-2 inline-block"
                  >{{ detail }}</span>
                </dd><template v-if="operationEvidenceExcerpts(operation).length > 0">
                  <dt class="text-slate-600 dark:text-slate-400">
                    根拠原文
                  </dt><dd class="min-w-0 whitespace-pre-wrap break-words text-slate-800 dark:text-slate-100">
                    <ul class="space-y-1">
                      <li
                        v-for="excerpt in operationEvidenceExcerpts(operation)"
                        :key="excerpt"
                      >
                        「{{ excerpt }}」
                      </li>
                    </ul>
                  </dd>
                </template>
              </dl><button
                v-if="props.reviewMode === 'interactive'"
                type="button"
                class="text-button mt-3"
                :disabled="!props.canWrite"
                @click="startEditing(operation)"
              >
                変更後を編集
              </button><ProposalOperationEditor
                v-if="props.reviewMode === 'interactive' && editingOperationId === operation.operation_id"
                :key="operation.operation_id"
                class="mt-3"
                :operation="operation"
                :proposal-id="requireProposal().proposal_id"
                :proposal-revision="requireProposal().revision"
                :tasks="props.tasks"
                :creations="creations"
                :disabled="!props.canWrite || pendingEdit != null"
                @save="saveEditedOperation"
                @cancel="cancelEditing"
              />
            </article>
          </div>
        </div>
      </div>
      <details class="rounded-md border border-slate-200 p-4 dark:border-slate-700">
        <summary class="cursor-pointer rounded-md px-3 py-2 text-sm font-medium text-slate-800 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950">
          変更案の詳細
        </summary>
        <div class="mt-3 space-y-4 text-xs text-slate-600 dark:text-slate-400">
          <dl class="grid gap-1 sm:grid-cols-2">
            <dt>変更案ID</dt><dd class="break-words text-slate-800 dark:text-slate-100">
              {{ requireProposal().proposal_id }}
            </dd><dt>基準データの識別子</dt><dd class="break-words text-slate-800 dark:text-slate-100">
              {{ requireProposal().baseline_snapshot_hash }}
            </dd>
          </dl>
          <div
            v-for="group in requireProposal().groups"
            :key="`detail-${group.group_id}`"
            class="space-y-2 rounded-md bg-slate-50 p-3 dark:bg-slate-800"
          >
            <p class="font-medium text-slate-800 dark:text-slate-100">
              グループID: {{ group.group_id }}
            </p>
            <div
              v-for="operation in group.operations"
              :key="`detail-${operation.operation_id}`"
              class="space-y-1 border-t border-slate-200 pt-2 dark:border-slate-700"
            >
              <p class="font-medium text-slate-800 dark:text-slate-100">
                操作ID: {{ operation.operation_id }}
              </p>
              <p>
                対象:
                <button
                  v-if="targetGid(operation) != null"
                  type="button"
                  class="text-button"
                  @click="selectExistingTask(operation)"
                >
                  {{ targetDetailLabel(requireProposal(), operation) }}
                </button><span v-else>{{ targetDetailLabel(requireProposal(), operation) }}</span>
              </p>
              <p>
                基準データの識別子: {{ operation.baseline_snapshot_hash }}
              </p>
              <p>
                根拠の場所:
                <span
                  v-for="evidence in operation.evidence_refs"
                  :key="`detail-${evidence.kind}-${evidence.locator}`"
                  class="mr-2 inline-block break-words text-slate-800 dark:text-slate-100"
                >{{ evidenceKindLabel(evidence.kind) }}: {{ evidence.locator }}</span>
                <span
                  v-for="detail in statusEvidenceDetails(operation)"
                  :key="`detail-${detail}`"
                  class="mr-2 inline-block break-words text-slate-800 dark:text-slate-100"
                >{{ detail }}</span>
              </p>
            </div>
          </div>
        </div>
      </details>
      <p
        v-if="props.reviewMode === 'interactive' && selectionMode === 'all' && hasInapplicableOperation"
        class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
        role="alert"
      >
        適用できない変更があります。適用範囲を選び直すか、変更案を修正してください。
      </p>
      <div
        v-if="props.reviewMode === 'interactive'"
        class="flex flex-wrap items-center gap-2"
      >
        <RadioGroupRoot
          :model-value="selectionMode"
          class="contents"
          aria-label="適用範囲"
          @update:model-value="updateSelectionMode"
        >
          <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><RadioGroupItem
            value="all"
            aria-label="全体"
            class="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-slate-400 bg-white text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 data-[state=checked]:border-sky-600 dark:border-slate-500 dark:bg-slate-800 dark:text-sky-300 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
          ><RadioGroupIndicator
            aria-hidden="true"
            class="size-2 rounded-full bg-current"
          /></RadioGroupItem>全体</label><label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><RadioGroupItem
            value="groups"
            aria-label="グループ単位"
            class="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-slate-400 bg-white text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 data-[state=checked]:border-sky-600 dark:border-slate-500 dark:bg-slate-800 dark:text-sky-300 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
          ><RadioGroupIndicator
            aria-hidden="true"
            class="size-2 rounded-full bg-current"
          /></RadioGroupItem>グループ単位</label><label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><RadioGroupItem
            value="operations"
            aria-label="非一括操作単位"
            class="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-slate-400 bg-white text-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 data-[state=checked]:border-sky-600 dark:border-slate-500 dark:bg-slate-800 dark:text-sky-300 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
          ><RadioGroupIndicator
            aria-hidden="true"
            class="size-2 rounded-full bg-current"
          /></RadioGroupItem>非一括操作単位</label>
        </RadioGroupRoot><button
          type="button"
          class="secondary-button"
          :disabled="!props.canWrite || !selectionCanBeSubmitted"
          @click="selectCurrentProposal"
        >
          選択範囲を更新
        </button><button
          type="button"
          class="primary-button"
          :disabled="!props.canWrite || !selectionCanBeSubmitted"
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
        </h3><ul
          v-if="requireProposal().impact.rank_changes.length > 0"
          class="mt-2 space-y-1 text-sm text-slate-700 dark:text-slate-300"
        >
          <li
            v-for="change in requireProposal().impact.rank_changes"
            :key="change.task_gid"
          >
            {{ rankTaskLabel(requireProposal(), change.task_gid) }}: {{ rankPositionLabel(change.before_state, change.before_rank) }} → {{ rankPositionLabel(change.after_state, change.after_rank) }}
          </li>
        </ul><p
          v-else
          class="mt-2 text-sm text-slate-700 dark:text-slate-300"
        >
          順位への影響はありません。
        </p>
      </div>
    </template>
  </div>
</template>
