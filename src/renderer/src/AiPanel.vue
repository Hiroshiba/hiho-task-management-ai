<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowTurnRequestSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
} from "../../shared/ai-workflow";
import type { ProposalOperation } from "../../shared/ai";
import {
  importanceLabel,
  parentWorkModeLabel,
  statusLabel,
  type RendererAiState,
} from "./state";
import ProposalOperationEditor from "./ProposalOperationEditor.vue";

type TaskTitleReference = {
  readonly gid: string;
  readonly title: string;
};

type CreateTaskOperation = Extract<ProposalOperation, { operation: "create_task" }>;
type ProposalTarget = Extract<ProposalOperation, { operation: "update_title" }>["target"];
type ProposalDueValue = Extract<ProposalOperation, { operation: "set_due" }>["before"];
type ProposalParentValue = Extract<ProposalOperation, { operation: "set_parent" }>["before"];
type ProposalDependency = Extract<ProposalOperation, { operation: "set_dependencies" }>["after"][number];
type CreateTaskFields = CreateTaskOperation["after"];
type ObsidianLink = Extract<ProposalOperation, { operation: "link_obsidian" }>["after"];
type RankChange = AiWorkflowProposalView["impact"]["rank_changes"][number];

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
}>();

const message = ref("");
const selectionMode = ref<"all" | "groups" | "operations">("all");
const selectedGroupIds = ref<string[]>([]);
const selectedOperationIds = ref<string[]>([]);
const editingOperationId = ref<string | undefined>();
const localError = ref("");

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

const creations = computed((): readonly CreateTaskOperation[] => {
  const currentProposal = proposal.value;
  if (currentProposal == null) {
    return [];
  }
  return currentProposal.proposal.groups
    .flatMap((group) => group.operations)
    .filter((operation): operation is CreateTaskOperation => operation.operation === "create_task");
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

function resetProposalState(): void {
  selectionMode.value = "all";
  selectedGroupIds.value = [];
  selectedOperationIds.value = [];
  editingOperationId.value = undefined;
  localError.value = "";
}

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

function taskLabel(gid: string): string {
  const task = props.tasks.find((candidate) => candidate.gid === gid);
  if (task == null) {
    return `タスク名未取得・ID ${gid}`;
  }
  return `タスク「${task.title}」`;
}

function createTaskOperationForRef(
  proposal: AiWorkflowProposalView,
  temporaryRef: string,
): CreateTaskOperation {
  const operation = proposal.proposal.groups
    .flatMap((group) => group.operations)
    .find((candidate): candidate is CreateTaskOperation =>
      candidate.operation === "create_task" && candidate.temporary_ref === temporaryRef);
  if (operation == null) {
    throw new Error("一時参照に対応するタスク作成操作がありません。");
  }
  return operation;
}

function targetReferenceLabel(
  proposal: AiWorkflowProposalView,
  target: ProposalTarget,
): string {
  if (target.kind === "existing") {
    return taskLabel(target.gid);
  }
  const createOperation = createTaskOperationForRef(proposal, target.ref);
  return `新規タスク「${createOperation.after.title}」`;
}

function targetLabel(
  proposal: AiWorkflowProposalView,
  operation: ProposalOperation,
): string {
  if (operation.operation === "create_task") {
    return `新規タスク「${operation.after.title}」`;
  }
  return targetReferenceLabel(proposal, operation.target);
}

function targetDetailLabel(
  proposal: AiWorkflowProposalView,
  operation: ProposalOperation,
): string {
  if (operation.operation === "create_task") {
    return `${targetLabel(proposal, operation)}・一時参照 ${operation.temporary_ref}`;
  }
  if (operation.target.kind === "existing") {
    return `${targetLabel(proposal, operation)}・ID ${operation.target.gid}`;
  }
  return `${targetLabel(proposal, operation)}・一時参照 ${operation.target.ref}`;
}

function rankTaskLabel(proposal: AiWorkflowProposalView, gid: string): string {
  const temporaryPrefix = "temporary:";
  if (!gid.startsWith(temporaryPrefix)) {
    return taskLabel(gid);
  }
  const temporaryRef = gid.slice(temporaryPrefix.length);
  if (temporaryRef.length === 0) {
    throw new Error("順位影響の一時参照が空です。");
  }
  const createOperation = createTaskOperationForRef(proposal, temporaryRef);
  return `新規タスク「${createOperation.after.title}」`;
}

function notesValueLabel(value: string): string {
  return value.trim().length === 0 ? "なし" : value;
}

function dueAtLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("期限日時を表示できません。");
  }
  const formatted = new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
  return `日時 ${formatted} JST`;
}

function dueValueLabel(value: ProposalDueValue): string {
  switch (value.kind) {
    case "absent":
      return "期限なし";
    case "due_on":
      return `日付 ${value.due_on}`;
    case "due_at":
      return dueAtLabel(value.due_at);
  }
}

function dependencyScopeLabel(scope: ProposalDependency["scope"]): string {
  return scope === "full" ? "完全依存" : "一部依存";
}

function dependencyLines(
  proposal: AiWorkflowProposalView,
  dependencies: readonly ProposalDependency[],
): readonly string[] {
  if (dependencies.length === 0) {
    return ["依存先: なし"];
  }
  return dependencies.map((dependency, index) =>
    `依存先${index + 1}: ${targetReferenceLabel(proposal, dependency.target)}・${dependencyScopeLabel(dependency.scope)}・根拠 ${dependency.source}`);
}

function parentValueLabel(
  proposal: AiWorkflowProposalView,
  value: ProposalParentValue,
): string {
  if (value.kind === "absent") {
    return "親タスクなし";
  }
  return `親 ${targetReferenceLabel(proposal, value)}`;
}

function obsidianLinkLabel(link: ObsidianLink): string {
  return `${link.title}・Vault ${link.vault_id}・パス ${link.path}・信頼度 ${Math.round(link.confidence * 100)}%`;
}

function createTaskFieldsLines(
  proposal: AiWorkflowProposalView,
  fields: CreateTaskFields,
): readonly string[] {
  const lines = [`タイトル: ${fields.title}`];
  if (fields.notes != null) {
    lines.push(`説明: ${notesValueLabel(fields.notes)}`);
  }
  if (fields.status != null) {
    lines.push(`状態: ${statusLabel(fields.status)}`);
  }
  if (fields.importance != null) {
    lines.push(`重要度: ${importanceLabel(fields.importance)}`);
  }
  if (fields.area != null) {
    lines.push(`領域: ${fields.area}`);
  }
  if (fields.due != null) {
    lines.push(`期限: ${dueValueLabel(fields.due)}`);
  }
  if (fields.parent != null) {
    lines.push(`親タスク: ${targetReferenceLabel(proposal, fields.parent)}`);
  }
  if (fields.parent_work_mode != null) {
    lines.push(`親作業モード: ${parentWorkModeLabel(fields.parent_work_mode)}`);
  }
  if (fields.dependencies != null) {
    lines.push(...dependencyLines(proposal, fields.dependencies));
  }
  if (fields.obsidian_links != null) {
    if (fields.obsidian_links.length === 0) {
      lines.push("Obsidianリンク: なし");
    } else {
      fields.obsidian_links.forEach((link, index) => {
        lines.push(`Obsidianリンク${index + 1}: ${obsidianLinkLabel(link)}`);
      });
    }
  }
  return lines;
}

function operationValueLines(
  proposal: AiWorkflowProposalView,
  operation: ProposalOperation,
  side: "before" | "after",
): readonly string[] {
  switch (operation.operation) {
    case "create_task":
      return side === "before" ? ["未作成"] : createTaskFieldsLines(proposal, operation.after);
    case "update_title":
      return [side === "before" ? operation.before : operation.after];
    case "update_notes":
      return [notesValueLabel(side === "before" ? operation.before : operation.after)];
    case "set_status":
      return [statusLabel(side === "before" ? operation.before : operation.after)];
    case "set_importance":
      return [importanceLabel(side === "before" ? operation.before : operation.after)];
    case "set_due":
      return [dueValueLabel(side === "before" ? operation.before : operation.after)];
    case "clear_due":
      return [dueValueLabel(side === "before" ? operation.before : operation.after)];
    case "set_area":
      return [side === "before" ? operation.before : operation.after];
    case "set_dependencies":
      return dependencyLines(
        proposal,
        side === "before" ? operation.before : operation.after,
      );
    case "set_parent":
      return [parentValueLabel(proposal, side === "before" ? operation.before : operation.after)];
    case "set_parent_work_mode":
      return [parentWorkModeLabel(side === "before" ? operation.before : operation.after)];
    case "link_obsidian":
      return side === "before"
        ? ["Obsidianリンクなし"]
        : [obsidianLinkLabel(operation.after)];
    case "unlink_obsidian":
      return side === "before"
        ? [obsidianLinkLabel(operation.before)]
        : ["Obsidianリンクなし"];
    case "complete":
      return [statusLabel(side === "before" ? operation.before : operation.after)];
    case "withdraw":
      return [statusLabel(side === "before" ? operation.before : operation.after)];
  }
}

function rankPositionLabel(state: RankChange["before_state"], rank: number | undefined): string {
  if (state === "ranked") {
    if (rank == null) {
      throw new Error("順位付き変更に順位がありません。");
    }
    return `順位${rank}`;
  }
  if (rank != null) {
    throw new Error("順位なしの変更に順位が指定されています。");
  }
  switch (state) {
    case "excluded":
      return "順位対象外";
    case "not_present":
      return "一覧対象外";
  }
}

function evidenceKindLabel(
  kind: "user_message" | "task" | "obsidian" | "external_tool",
): string {
  switch (kind) {
    case "user_message":
      return "ユーザーの依頼";
    case "task":
      return "タスク";
    case "obsidian":
      return "Obsidian";
    case "external_tool":
      return "外部ツール";
  }
}

function startEditing(operation: ProposalOperation): void {
  editingOperationId.value = operation.operation_id;
  localError.value = "";
}

function saveEditedOperation(input: AiWorkflowOperationEdit): void {
  emit("edit", input);
  editingOperationId.value = undefined;
}

function cancelEditing(): void {
  editingOperationId.value = undefined;
}

function operationIsApplicable(proposal: AiWorkflowProposalView, operationId: string): boolean {
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
  proposal: AiWorkflowProposalView,
  operationId: string,
): boolean {
  const group = proposal.proposal.groups.find((candidate) =>
    candidate.operations.some((operation) => operation.operation_id === operationId));
  if (group == null || group.atomic) {
    return false;
  }
  return operationIsApplicable(proposal, operationId);
}

function synchronizeProposalSelections(proposal: AiWorkflowProposalView): void {
  const selectedOperationIdsFromServer = new Set(proposal.selected_operation_ids);
  selectedGroupIds.value = proposal.proposal.groups
    .filter((group) =>
      groupIsApplicable(proposal, group.group_id)
      && group.operations.every((operation) => selectedOperationIdsFromServer.has(operation.operation_id)))
    .map((group) => group.group_id);
  selectedOperationIds.value = proposal.selected_operation_ids.filter((operationId) => {
    const group = proposal.proposal.groups.find((candidate) =>
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

function operationValidation(proposal: AiWorkflowProposalView, operationId: string): string {
  return operationIsApplicable(proposal, operationId) ? "適用候補" : "適用不可";
}

function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function groupIsApplicable(proposal: AiWorkflowProposalView, groupId: string): boolean {
  const group = proposal.proposal.groups.find((candidate) => candidate.group_id === groupId);
  if (group == null) {
    throw new Error("変更グループが変更案にありません。");
  }
  return group.operations.every((operation) => operationIsApplicable(proposal, operation.operation_id));
}

function proposalHasInapplicableOperation(proposal: AiWorkflowProposalView): boolean {
  return proposal.proposal.groups.some((group) =>
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
      <p
        v-if="localError.length > 0"
        class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
        role="alert"
      >
        {{ localError }}
      </p>
      <div
        v-if="props.state.kind === 'idle' || props.state.kind === 'questions' || props.state.kind === 'proposal'"
        class="space-y-3"
      >
        <form
          class="space-y-3"
          @submit.prevent="sendMessage"
        >
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

      <div
        v-if="props.state.kind === 'streaming'"
        class="space-y-3"
        aria-live="polite"
        aria-busy="true"
      >
        <div
          v-if="props.state.text.length === 0"
          class="flex items-center gap-3 rounded-md bg-slate-50 p-4 dark:bg-slate-800"
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
            Codexの応答
          </p><pre class="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-slate-50 p-4 text-sm leading-6 text-slate-800 dark:bg-slate-800 dark:text-slate-100">{{ props.state.text }}</pre>
        </template>
      </div>

      <div
        v-if="questionResponseMessage != null"
        class="space-y-3"
        aria-live="polite"
      >
        <p class="text-sm text-slate-700 dark:text-slate-300">
          {{ questionResponseMessage }}
        </p><ul class="space-y-3">
          <li
            v-for="question in responseQuestions"
            :key="question.question_id"
            class="rounded-md border border-slate-200 p-3 dark:border-slate-700"
          >
            <p class="font-medium text-slate-900 dark:text-slate-100">
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
        <div class="rounded-md bg-slate-50 p-4 dark:bg-slate-800">
          <p class="text-sm font-medium text-slate-900 dark:text-slate-100">
            {{ proposalMessage }}
          </p><p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
            承認するまでAsanaには反映されません。
          </p><p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
            影響を受けるタスク: {{ requireProposal().impact.impacted_task_count }}件
          </p>
        </div>
        <div class="space-y-3">
          <h3 class="section-heading">
            変更案
          </h3><div
            v-for="(group, groupIndex) in requireProposal().proposal.groups"
            :key="group.group_id"
            class="rounded-md border border-slate-200 p-4 dark:border-slate-700"
          >
            <div class="flex flex-wrap items-center gap-3">
              <input
                v-if="selectionMode === 'groups'"
                :checked="selectedGroup(group.group_id)"
                :disabled="!groupIsApplicable(requireProposal(), group.group_id)"
                type="checkbox"
                :aria-label="`変更グループ ${groupIndex + 1}を選択`"
                @change="selectedGroupIds = toggleValue(selectedGroupIds, group.group_id)"
              ><span class="font-medium text-slate-900 dark:text-slate-100">変更グループ {{ groupIndex + 1 }}</span><span class="text-xs text-slate-600 dark:text-slate-400">{{ group.atomic ? '一括適用' : '個別適用' }}</span><span
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
                      {{ operationLabel(operation) }} <span class="text-xs font-normal text-slate-600 dark:text-slate-400">{{ targetLabel(requireProposal(), operation) }}</span>
                    </p><p class="mt-1 text-xs text-slate-600 dark:text-slate-400">
                      {{ operationValidation(requireProposal(), operation.operation_id) }}・{{ operation.basis === 'explicit' ? '明示' : '推測' }}・信頼度 {{ confidenceLabel(operation.confidence) }}
                    </p>
                  </div><label
                    v-if="selectionMode === 'operations' && !group.atomic"
                    class="inline-flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300"
                  ><input
                    :checked="selectedOperation(operation.operation_id)"
                    :disabled="!operationIsApplicable(requireProposal(), operation.operation_id)"
                    type="checkbox"
                    :aria-label="`${operationLabel(operation)}を選択`"
                    @change="selectedOperationIds = toggleValue(selectedOperationIds, operation.operation_id)"
                  >操作を選択</label>
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
                  </dd>
                </dl><button
                  type="button"
                  class="text-button mt-3"
                  :disabled="!props.canWrite"
                  @click="startEditing(operation)"
                >
                  変更後を編集
                </button><ProposalOperationEditor
                  v-if="editingOperationId === operation.operation_id"
                  :key="operation.operation_id"
                  class="mt-3"
                  :operation="operation"
                  :proposal-id="requireProposal().proposal_id"
                  :tasks="props.tasks"
                  :creations="creations"
                  :disabled="!props.canWrite"
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
              v-for="group in requireProposal().proposal.groups"
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
                  対象: {{ targetDetailLabel(requireProposal(), operation) }}
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
                  >{{ evidence.kind }}: {{ evidence.locator }}</span>
                </p>
              </div>
            </div>
          </div>
        </details>
        <p
          v-if="selectionMode === 'all' && hasInapplicableOperation"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
          role="alert"
        >
          適用できない変更があります。適用範囲を選び直すか、変更案を修正してください。
        </p>
        <div class="flex flex-wrap gap-2">
          <label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><input
            v-model="selectionMode"
            type="radio"
            value="all"
          >全体</label><label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><input
            v-model="selectionMode"
            type="radio"
            value="groups"
          >グループ単位</label><label class="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"><input
            v-model="selectionMode"
            type="radio"
            value="operations"
          >非一括操作単位</label><button
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
        </p><p class="mt-1 text-sm text-amber-900 dark:text-amber-100">
          {{ props.state.failure.message }}
        </p>
      </div>
    </div>
  </section>
</template>
