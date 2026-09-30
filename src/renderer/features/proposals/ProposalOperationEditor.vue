<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { z } from "zod";
import { proposalOperationSchema } from "../../../shared/ipc-contracts/proposal-values";
import { proposalsContracts } from "../../../shared/ipc-contracts/proposals";
import { isoToJstDatetimeLocal, parseJstDatetimeLocal } from "../../shared/format/date-time";
import type { ProposalEditInput, ProposalOperation } from "./proposal-presentation";
import type { CreateTaskOperation, DependencyDraft, FormState, ObsidianDraft, ProposalDependency, ProposalDueValue, ProposalDurationValue, ProposalParentValue, ProposalTarget, TargetOption } from "./proposal-editor-form";
import CreateTaskFieldsEditor from "./CreateTaskFieldsEditor.vue";
import ProposalDependenciesEditor from "./ProposalDependenciesEditor.vue";
import {
  durationMinimum,
  durationUnitOptions,
  parseDurationInput,
} from "./proposal-presentation";

class FormInputError extends Error {}

const props = defineProps<{
  operation: ProposalOperation;
  proposalId: string;
  proposalRevision?: number | undefined;
  tasks: readonly { readonly gid: string; readonly title: string }[];
  creations: readonly CreateTaskOperation[];
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "save", input: ProposalEditInput): void;
  (event: "cancel"): void;
}>();

let nextDraftId = 0;

function draftId(): number {
  nextDraftId += 1;
  return nextDraftId;
}

function targetKey(target: ProposalTarget): string {
  if (target.kind === "existing") {
    return `existing:${target.gid}`;
  }
  return `temporary:${target.ref}`;
}

function targetFromKey(value: string): ProposalTarget {
  if (value.startsWith("existing:")) {
    const gid = value.slice("existing:".length);
    if (gid.length === 0) {
      throw new FormInputError("タスクを選択してください。");
    }
    return { kind: "existing", gid };
  }
  if (value.startsWith("temporary:")) {
    const ref = value.slice("temporary:".length);
    if (ref.length === 0) {
      throw new FormInputError("提案タスクを選択してください。");
    }
    return { kind: "temporary", ref };
  }
  throw new FormInputError("タスクを選択してください。");
}

function targetLabel(target: ProposalTarget): string {
  if (target.kind === "existing") {
    const task = props.tasks.find((candidate) => candidate.gid === target.gid);
    if (task == null) {
      return `既存タスク ${target.gid}`;
    }
    const duplicateTitle = props.tasks.filter((candidate) => candidate.title === task.title).length > 1;
    return duplicateTitle
      ? `既存タスク「${task.title}」 GID ${target.gid}`
      : `既存タスク「${task.title}」`;
  }
  const creation = props.creations.find((candidate) => candidate.temporary_ref === target.ref);
  if (creation == null) {
    return `提案タスク ${target.ref}`;
  }
  const duplicateTitle = props.creations.filter((candidate) =>
    candidate.after.title === creation.after.title).length > 1;
  return duplicateTitle
    ? `新規タスク「${creation.after.title}」 一時参照 ${target.ref}`
    : `新規タスク「${creation.after.title}」`;
}

function addOperationTargets(operation: ProposalOperation, add: (target: ProposalTarget) => void): void {
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") {
      add(operation.creation.parent);
    }
    if (operation.after.parent != null) {
      add(operation.after.parent);
    }
    for (const dependency of operation.after.dependencies ?? []) {
      add(dependency.target);
    }
    return;
  }
  add(operation.target);
  if (operation.operation === "set_dependencies") {
    for (const dependency of operation.before) {
      add(dependency.target);
    }
    for (const dependency of operation.after) {
      add(dependency.target);
    }
  }
  if (operation.operation === "set_parent") {
    if (operation.before.kind !== "absent") {
      add(operation.before);
    }
    if (operation.after.kind !== "absent") {
      add(operation.after);
    }
  }
}

const targetOptions = computed<readonly TargetOption[]>(() => {
  const options: TargetOption[] = [];
  const seen = new Set<string>();
  const add = (target: ProposalTarget): void => {
    const key = targetKey(target);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    options.push({ key, label: targetLabel(target) });
  };
  for (const task of props.tasks) {
    add({ kind: "existing", gid: task.gid });
  }
  for (const creation of props.creations) {
    add({ kind: "temporary", ref: creation.temporary_ref });
  }
  addOperationTargets(props.operation, add);
  return options;
});

function initialState(): FormState {
  const operation = props.operation;
  const firstEvidence = operation.evidence_refs[0];
  if (firstEvidence == null) {
    throw new Error("操作の根拠がありません。");
  }
  const state: FormState = {
    title: "",
    notes: "",
    notesSpecified: false,
    status: "not_started",
    statusSpecified: false,
    importance: 3,
    importanceSpecified: false,
    area: "",
    areaSpecified: false,
    dueKind: "due_on",
    dueValue: "",
    originalDueAt: undefined,
    dueSpecified: false,
    durationUnit: "minute",
    durationValue: "",
    durationSpecified: false,
    parentKey: "",
    parentSpecified: false,
    parentWorkMode: "unknown",
    parentWorkModeSpecified: false,
    dependencies: [],
    dependenciesSpecified: false,
    obsidianLinks: [],
    obsidianLinksSpecified: false,
    evidenceLocator: firstEvidence.locator,
    error: "",
  };
  switch (operation.operation) {
    case "create_task":
      state.title = operation.after.title;
      if (operation.after.notes != null) {
        state.notes = operation.after.notes;
        state.notesSpecified = true;
      }
      if (operation.after.status != null) {
        state.status = operation.after.status;
        state.statusSpecified = true;
      }
      if (operation.after.importance != null) {
        state.importance = operation.after.importance;
        state.importanceSpecified = true;
      }
      if (operation.after.area != null) {
        state.area = operation.after.area;
        state.areaSpecified = true;
      }
      if (operation.after.due != null) {
        applyDue(state, operation.after.due);
        state.dueSpecified = true;
      }
      if (operation.after.duration != null) {
        applyDuration(state, operation.after.duration);
        state.durationSpecified = true;
      }
      if (operation.after.parent != null) {
        state.parentKey = targetKey(operation.after.parent);
        state.parentSpecified = true;
      }
      if (operation.after.parent_work_mode != null) {
        state.parentWorkMode = operation.after.parent_work_mode;
        state.parentWorkModeSpecified = true;
      }
      if (operation.after.dependencies != null) {
        state.dependencies = operation.after.dependencies.map(createDependencyDraft);
        state.dependenciesSpecified = true;
      }
      if (operation.after.obsidian_links != null) {
        state.obsidianLinks = operation.after.obsidian_links.map(createObsidianDraft);
        state.obsidianLinksSpecified = true;
      }
      if (operation.creation.kind === "split_child") {
        state.parentKey = targetKey(operation.creation.parent);
        state.parentSpecified = true;
      }
      return state;
    case "update_title":
      state.title = operation.after;
      return state;
    case "update_notes":
      state.notes = operation.after;
      state.notesSpecified = true;
      return state;
    case "set_status":
      state.status = operation.after;
      return state;
    case "set_importance":
      state.importance = operation.after;
      return state;
    case "set_due":
      applyDue(state, operation.after);
      return state;
    case "clear_due":
      return state;
    case "set_duration":
      applyDuration(state, operation.after);
      return state;
    case "clear_duration":
      return state;
    case "set_area":
      state.area = operation.after;
      return state;
    case "set_dependencies":
      state.dependencies = operation.after.map(createDependencyDraft);
      state.dependenciesSpecified = true;
      return state;
    case "set_parent":
      state.parentKey = operation.after.kind === "absent" ? "absent" : targetKey(operation.after);
      state.parentSpecified = true;
      return state;
    case "set_parent_work_mode":
      state.parentWorkMode = operation.after;
      return state;
    case "link_obsidian":
      state.obsidianLinks = [createObsidianDraft(operation.after)];
      state.obsidianLinksSpecified = true;
      return state;
    case "unlink_obsidian":
    case "complete":
    case "withdraw":
      return state;
  }
}

function applyDue(state: FormState, due: ProposalDueValue): void {
  state.dueKind = due.kind;
  if (due.kind === "due_on") {
    state.dueValue = due.due_on;
    state.originalDueAt = undefined;
    return;
  }
  state.dueValue = isoToJstDatetimeLocal(due.due_at);
  state.originalDueAt = due.due_at;
}

function applyDuration(state: FormState, duration: ProposalDurationValue): void {
  state.durationUnit = duration.unit;
  state.durationValue = String(duration.value);
}

function createDependencyDraft(dependency: ProposalDependency): DependencyDraft {
  return {
    id: draftId(),
    targetKey: targetKey(dependency.target),
    scope: dependency.scope,
    source: dependency.source,
  };
}

function createObsidianDraft(link: Extract<ProposalOperation, { operation: "link_obsidian" }>["after"]): ObsidianDraft {
  return {
    id: draftId(),
    vaultId: link.vault_id,
    path: link.path,
    title: link.title,
    confidence: link.confidence,
  };
}

const form = ref<FormState>(initialState());

watch(
  [() => props.proposalId, () => props.proposalRevision, () => props.operation.operation_id],
  () => {
    form.value = initialState();
  },
);

function operationHasCreateParent(operation: ProposalOperation): boolean {
  return operation.operation === "create_task" && operation.creation.kind === "split_child";
}

function dueAfter(): ProposalDueValue {
  if (form.value.dueKind === "due_on") {
    return { kind: "due_on", due_on: form.value.dueValue };
  }
  const dueAt = form.value.originalDueAt != null
    && form.value.dueValue === isoToJstDatetimeLocal(form.value.originalDueAt)
    ? form.value.originalDueAt
    : datetimeLocalToIso(form.value.dueValue);
  return { kind: "due_at", due_at: dueAt };
}

function durationAfter(): ProposalDurationValue {
  try {
    return parseDurationInput(form.value.durationUnit, form.value.durationValue);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new FormInputError("所要時間を確認してください。", { cause: error });
    }
    throw error;
  }
}

function createTaskAfter(operation: CreateTaskOperation): unknown {
  const state = form.value;
  return {
    title: state.title,
    ...(state.notesSpecified ? { notes: state.notes } : {}),
    ...(state.statusSpecified ? { status: state.status } : {}),
    ...(state.importanceSpecified ? { importance: state.importance } : {}),
    ...(state.areaSpecified ? { area: state.area } : {}),
    ...(state.dueSpecified ? { due: dueAfter() } : {}),
    ...(state.durationSpecified ? { duration: durationAfter() } : {}),
    ...(state.parentSpecified || operationHasCreateParent(operation)
      ? { parent: targetFromKey(state.parentKey) }
      : {}),
    ...(state.parentWorkModeSpecified ? { parent_work_mode: state.parentWorkMode } : {}),
    ...(state.dependenciesSpecified
      ? { dependencies: dependenciesAfter() }
      : {}),
    ...(state.obsidianLinksSpecified
      ? { obsidian_links: obsidianLinksAfter() }
      : {}),
  };
}

function dependenciesAfter(): readonly ProposalDependency[] {
  return form.value.dependencies.map((dependency) => ({
    target: targetFromKey(dependency.targetKey),
    scope: dependency.scope,
    source: dependency.source,
  }));
}

function obsidianLinksAfter(): readonly Extract<ProposalOperation, { operation: "link_obsidian" }>["after"][] {
  return form.value.obsidianLinks.map((link) => ({
    vault_id: link.vaultId,
    path: link.path,
    title: link.title,
    confidence: confidenceValue(link.confidence),
  }));
}

function confidenceValue(value: number | string): number {
  if (typeof value === "string" && value.trim().length === 0) {
    throw new FormInputError("信頼度を入力してください。");
  }
  const confidence = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(confidence)) {
    throw new FormInputError("信頼度は数値で入力してください。");
  }
  if (confidence < 0 || confidence > 1) {
    throw new FormInputError("信頼度は0から1の範囲で入力してください。");
  }
  return confidence;
}

function parentAfter(): ProposalParentValue {
  if (form.value.parentKey === "absent") {
    return { kind: "absent" };
  }
  return targetFromKey(form.value.parentKey);
}

function editedAfter(operation: ProposalOperation): unknown {
  switch (operation.operation) {
    case "create_task":
      return createTaskAfter(operation);
    case "update_title":
      return form.value.title;
    case "update_notes":
      return form.value.notes;
    case "set_status":
      return form.value.status;
    case "set_importance":
      return form.value.importance;
    case "set_due":
      return dueAfter();
    case "clear_due":
      return { kind: "absent" };
    case "set_duration":
      return durationAfter();
    case "clear_duration":
      return { kind: "absent" };
    case "set_area":
      return form.value.area;
    case "set_dependencies":
      return dependenciesAfter();
    case "set_parent":
      return parentAfter();
    case "set_parent_work_mode":
      return form.value.parentWorkMode;
    case "link_obsidian": {
      const first = form.value.obsidianLinks[0];
      if (first == null) {
        throw new FormInputError("Obsidianリンクを入力してください。");
      }
      return {
        vault_id: first.vaultId,
        path: first.path,
        title: first.title,
        confidence: confidenceValue(first.confidence),
      };
    }
    case "unlink_obsidian":
      return { kind: "absent" };
    case "complete":
      return "completed";
    case "withdraw":
      return "withdrawn";
  }
}

function save(): void {
  const operation = props.operation;
  let editedValue: unknown;
  try {
    editedValue = editedAfter(operation);
  } catch (error) {
    if (error instanceof FormInputError) {
      form.value.error = error.message;
      return;
    }
    throw error;
  }
  const operationResult = proposalOperationSchema.safeParse({
    ...operation,
    after: editedValue,
  });
  if (!operationResult.success) {
    form.value.error = "操作後の値を確認してください。";
    return;
  }
  const editResult = proposalsContracts.editOperation.request.safeParse({
    session_id: "ui-edit",
    proposal_id: props.proposalId,
    operation_id: operation.operation_id,
    operation: operation.operation,
    after: operationResult.data.after,
    evidence_locator: form.value.evidenceLocator,
  });
  if (!editResult.success) {
    form.value.error = "操作後の値と根拠の場所を確認してください。";
    return;
  }
  form.value.error = "";
  const { session_id, ...input } = editResult.data;
  if (session_id !== "ui-edit") {
    throw new Error("編集要求の検証IDが一致しません。");
  }
  emit("save", input);
}

function addDependency(): void {
  form.value.dependencies.push({
    id: draftId(),
    targetKey: "",
    scope: "full",
    source: "",
  });
}

function removeDependency(id: number): void {
  form.value.dependencies = form.value.dependencies.filter((dependency) => dependency.id !== id);
}

function addObsidianLink(): void {
  form.value.obsidianLinks.push({
    id: draftId(),
    vaultId: "",
    path: "",
    title: "",
    confidence: "",
  });
}

function removeObsidianLink(id: number): void {
  form.value.obsidianLinks = form.value.obsidianLinks.filter((link) => link.id !== id);
}

function changeDueKind(): void {
  if (form.value.dueKind === "due_on") {
    const datePart = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}$/u.exec(form.value.dueValue)?.[1];
    if (datePart != null) {
      form.value.dueValue = datePart;
      return;
    }
    if (form.value.originalDueAt != null) {
      form.value.dueValue = isoToJstDatetimeLocal(form.value.originalDueAt).slice(0, 10);
    }
    return;
  }
  if (form.value.originalDueAt != null) {
    const originalLocal = isoToJstDatetimeLocal(form.value.originalDueAt);
    if (form.value.dueValue === originalLocal.slice(0, 10)) {
      form.value.dueValue = originalLocal;
      return;
    }
  }
  const dateValue = /^\d{4}-\d{2}-\d{2}$/u.test(form.value.dueValue);
  if (dateValue) {
    form.value.dueValue = `${form.value.dueValue}T00:00`;
    return;
  }
}

function datetimeLocalToIso(value: string): string {
  const parsed = parseJstDatetimeLocal(value);
  if (parsed.kind === "valid") {
    return parsed.value;
  }
  switch (parsed.reason) {
    case "format":
      throw new FormInputError("期限日時を入力してください。");
    case "date":
      throw new FormInputError("期限日時の日付を確認してください。");
    case "time":
      throw new FormInputError("期限日時の時刻を確認してください。");
    case "timestamp":
      throw new FormInputError("期限日時を確認してください。");
  }
}

</script>

<template>
  <form
    class="proposal-operation-editor min-w-0 space-y-4"
    @submit.prevent="save"
  >
    <p
      v-if="form.error.length > 0"
      class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
      role="alert"
    >
      {{ form.error }}
    </p>

    <CreateTaskFieldsEditor
      v-if="operation.operation === 'create_task'"
      v-model:form="form"
      :operation="operation"
      :target-options="targetOptions"
      :disabled="props.disabled"
      :target-label="targetLabel"
      :change-due-kind="changeDueKind"
      :add-dependency="addDependency"
      :remove-dependency="removeDependency"
      :add-obsidian-link="addObsidianLink"
      :remove-obsidian-link="removeObsidianLink"
    />

    <div
      v-else-if="operation.operation === 'update_title'"
      class="field-group"
    >
      <label class="field-label">
        タイトル
        <input
          v-model="form.title"
          class="text-input"
          type="text"
          required
          :disabled="props.disabled"
        >
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'update_notes'"
      class="field-group"
    >
      <label class="field-label">
        説明
        <textarea
          v-model="form.notes"
          class="text-input min-h-32"
          :disabled="props.disabled"
        />
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'set_status'"
      class="field-group"
    >
      <label class="field-label">
        状態
        <select
          v-model="form.status"
          class="text-input"
          :disabled="props.disabled"
        >
          <option value="not_started">未着手</option>
          <option value="in_progress">進行中</option>
        </select>
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'set_importance'"
      class="field-group"
    >
      <label class="field-label">
        重要度
        <select
          v-model.number="form.importance"
          class="text-input"
          :disabled="props.disabled"
        >
          <option :value="1">1</option>
          <option :value="2">2</option>
          <option :value="3">3</option>
          <option :value="4">4</option>
          <option :value="5">5</option>
        </select>
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'set_due'"
      class="field-group"
    >
      <label class="field-label">
        期限の種類
        <select
          v-model="form.dueKind"
          class="text-input"
          aria-label="期限の種類"
          :disabled="props.disabled"
          @change="changeDueKind"
        >
          <option value="due_on">日付</option>
          <option value="due_at">日時</option>
        </select>
      </label>
      <label class="field-label">
        {{ form.dueKind === 'due_on' ? '期限日' : '期限日時 日本時間' }}
        <input
          v-model="form.dueValue"
          class="text-input"
          :type="form.dueKind === 'due_on' ? 'date' : 'datetime-local'"
          required
          :disabled="props.disabled"
        >
        <p
          v-if="form.dueKind === 'due_at'"
          class="text-xs text-slate-600 dark:text-slate-400"
        >
          日時は日本時間で入力します。
        </p>
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'clear_due'"
      class="rounded-md border border-slate-200 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
    >
      期限を解除します。
    </div>

    <div
      v-else-if="operation.operation === 'set_duration'"
      class="field-group"
    >
      <div class="grid min-w-0 gap-2 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)]">
        <label class="field-label">
          所要時間の単位
          <select
            v-model="form.durationUnit"
            class="text-input"
            :disabled="props.disabled"
          >
            <option
              v-for="option in durationUnitOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
        </label>
        <label class="field-label">
          所要時間の数値
          <input
            v-model="form.durationValue"
            class="text-input"
            type="number"
            inputmode="numeric"
            :min="durationMinimum(form.durationUnit)"
            step="1"
            required
            :disabled="props.disabled"
          >
        </label>
      </div>
    </div>

    <div
      v-else-if="operation.operation === 'clear_duration'"
      class="rounded-md border border-slate-200 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
    >
      所要時間を解除します。
    </div>

    <div
      v-else-if="operation.operation === 'set_area'"
      class="field-group"
    >
      <label class="field-label">
        領域
        <input
          v-model="form.area"
          class="text-input"
          type="text"
          required
          :disabled="props.disabled"
        >
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'set_dependencies'"
      class="field-group"
    >
      <span class="field-label">依存するタスク</span>
      <ProposalDependenciesEditor
        v-model:dependencies="form.dependencies"
        :target-options="targetOptions"
        :disabled="props.disabled"
        :add-dependency="addDependency"
        :remove-dependency="removeDependency"
      />
    </div>

    <div
      v-else-if="operation.operation === 'set_parent'"
      class="field-group"
    >
      <label class="field-label">
        親タスク
        <select
          v-model="form.parentKey"
          class="text-input"
          :disabled="props.disabled"
        >
          <option value="absent">親タスクなし</option>
          <option
            v-for="option in targetOptions"
            :key="option.key"
            :value="option.key"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'set_parent_work_mode'"
      class="field-group"
    >
      <label class="field-label">
        親タスクの作業範囲
        <select
          v-model="form.parentWorkMode"
          class="text-input"
          :disabled="props.disabled"
        >
          <option value="children_only">子タスクのみ</option>
          <option value="has_own_work">親自身の作業あり</option>
          <option value="unknown">不明</option>
        </select>
      </label>
    </div>

    <div
      v-else-if="operation.operation === 'link_obsidian'"
      class="grid min-w-0 gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2"
    >
      <template v-if="form.obsidianLinks[0] != null">
        <label class="field-label">
          Vault ID
          <input
            v-model="form.obsidianLinks[0].vaultId"
            class="text-input"
            type="text"
            required
            :disabled="props.disabled"
          >
        </label>
        <label class="field-label">
          パス
          <input
            v-model="form.obsidianLinks[0].path"
            class="text-input"
            type="text"
            required
            :disabled="props.disabled"
          >
        </label>
        <label class="field-label">
          ノートタイトル
          <input
            v-model="form.obsidianLinks[0].title"
            class="text-input"
            type="text"
            required
            :disabled="props.disabled"
          >
        </label>
        <label class="field-label">
          信頼度
          <input
            v-model="form.obsidianLinks[0].confidence"
            class="text-input"
            type="number"
            min="0"
            max="1"
            step="any"
            required
            :disabled="props.disabled"
          >
        </label>
      </template>
    </div>

    <div
      v-else-if="operation.operation === 'unlink_obsidian'"
      class="rounded-md border border-slate-200 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
    >
      Obsidianリンクを解除します。
    </div>

    <div
      v-else-if="operation.operation === 'complete'"
      class="rounded-md border border-slate-200 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
    >
      状態を完了に変更します。
    </div>

    <div
      v-else-if="operation.operation === 'withdraw'"
      class="rounded-md border border-slate-200 px-3 py-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300"
    >
      状態を取り下げに変更します。
    </div>

    <label class="field-label border-t border-slate-200 pt-4 dark:border-slate-700">
      根拠の場所
      <input
        v-model="form.evidenceLocator"
        class="text-input"
        type="text"
        required
        :disabled="props.disabled"
      >
    </label>
    <div class="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        class="secondary-button"
        :disabled="props.disabled"
        @click="emit('cancel')"
      >
        キャンセル
      </button>
      <button
        type="submit"
        class="primary-button"
        :disabled="props.disabled"
      >
        変更後を保存
      </button>
    </div>
  </form>
</template>

<style scoped>
.proposal-operation-editor,
.proposal-operation-editor .field-group,
.proposal-operation-editor fieldset,
.proposal-operation-editor .grid,
.proposal-operation-editor .field-label {
  min-width: 0;
}

.proposal-operation-editor .text-input {
  width: 100%;
  min-width: 0;
}
</style>
