<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { z } from "zod";
import { dateSchema } from "../../../shared/ipc-contracts/common";
import { applyEditRequestSchema } from "../../../shared/ipc-contracts/tasks";
import { taskStatusSchema } from "../../../shared/ipc-contracts/task-values";
import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";
import type { GuiEditOperation } from "../../../shared/ipc-contracts/task-values";
import RekaSelect from "../../shared/components/RekaSelect.vue";
import { isoToJstDatetimeLocal, jstDatetimeLocalToIso, parseJstDatetimeLocal } from "../../shared/format/date-time";
import { deadlineTone, deadlineToneClass, dueRelativeLabel, importanceToneClass } from "./task-presentation";
import { parseDependencyInput } from "./task-input";
import { durationMinimum, durationUnitOptions, parseDurationInput, type DurationUnit } from "./task-duration";
import { applySavedOperation, draftDiffersFromTask, staleDraftDetails } from "./task-detail-draft";
import type { TaskDetail } from "./use-task-read";
import type { TaskDraft, TaskDraftStore, TaskEditMarker } from "./use-task-drafts";
import TaskRankingDetails from "./TaskRankingDetails.vue";
import TaskRelations from "./TaskRelations.vue";

type ObsidianLink = TaskDetail["obsidian_links"][number];
const importanceSchema = z.literal([1, 2, 3, 4, 5]);
const parentWorkModeSchema = z.enum(["children_only", "has_own_work", "unknown"]);

const props = defineProps<{
  task: TaskDetail | undefined;
  asOf: string;
  areas: readonly string[];
  canWrite: boolean;
  savingState: "idle" | "waiting_sync" | "saving";
  execution: ExecutionDto | undefined;
  executionFeedback: { readonly kind: "success" | "progress" | "warning" | "failure"; readonly text: string } | undefined;
  draftStore: TaskDraftStore;
  taskEditMarkers: ReadonlyMap<string, TaskEditMarker>;
}>();

const emit = defineEmits<{
  (event: "edit", input: ReturnType<typeof applyEditRequestSchema.parse>): void;
  (event: "check-execution", executionId: string): void;
  (event: "retry-execution", executionId: string): void;
}>();

defineSlots<{
  "related-notes"(slotProps: { readonly task: TaskDetail; readonly canWrite: boolean; readonly unlink: (link: ObsidianLink) => void }): unknown;
}>();

const title = ref("");
const notes = ref("");
const status = ref<"not_started" | "in_progress" | "completed" | "withdrawn">("not_started");
const importance = ref<1 | 2 | 3 | 4 | 5>(3);
const dueKind = ref<"none" | "due_on" | "due_at">("none");
const dueValue = ref("");
const durationUnit = ref<"none" | DurationUnit>("none");
const durationValue = ref("");
const durationInput = computed<{ readonly minimum: number } | undefined>(() => {
  if (durationUnit.value === "none") {
    return undefined;
  }
  return { minimum: durationMinimum(durationUnit.value) };
});
const area = ref("");
const dependencyText = ref("");
const parentGid = ref("");
const parentWorkMode = ref<"children_only" | "has_own_work" | "unknown">("unknown");
const localError = ref("");

function previewDue(): TaskDetail["due"] | undefined {
  switch (dueKind.value) {
    case "none":
      return { kind: "none" };
    case "due_on": {
      const parsed = dateSchema.safeParse(dueValue.value);
      return parsed.success ? { kind: "on", value: parsed.data } : undefined;
    }
    case "due_at": {
      const parsed = parseJstDatetimeLocal(dueValue.value);
      return parsed.kind === "valid" ? { kind: "at", value: parsed.value } : undefined;
    }
  }
}

const detailDeadlinePreview = computed(() => {
  const due = previewDue();
  if (due == null || due.kind === "none") {
    return undefined;
  }
  return {
    tone: deadlineTone(due, status.value, props.asOf),
    label: dueRelativeLabel(due, props.asOf),
  };
});

type FormDraft = TaskDraft;

const staleFormDrafts = props.draftStore.staleDrafts;
const activeTaskGid = ref<string | undefined>();
const draftDirty = ref(false);
const conflictAcknowledgedGenerations = props.draftStore.acknowledgedConflicts;
const staleDraftForCurrentTask = computed(() => {
  const taskGid = props.task?.gid;
  return taskGid == null ? undefined : staleFormDrafts.value.get(taskGid);
});
const staleDraftEntries = computed(() => [...staleFormDrafts.value.entries()]);
const currentConflictMarker = computed(() => {
  const taskGid = props.task?.gid;
  if (taskGid == null) {
    return undefined;
  }
  const marker = props.taskEditMarkers.get(taskGid);
  return marker?.kind === "conflict" ? marker : undefined;
});
const conflictNeedsAcknowledgement = computed(() => {
  const taskGid = props.task?.gid;
  const marker = currentConflictMarker.value;
  if (taskGid == null || marker == null) {
    return false;
  }
  return conflictAcknowledgedGenerations.value.get(taskGid) !== marker.generation;
});
const sharedStaleDraftEntries = computed(() => {
  const currentTaskGid = props.task?.gid;
  const currentConflict = currentConflictMarker.value;
  return staleDraftEntries.value.filter(([taskGid]) => {
    return currentTaskGid == null
      || currentConflict == null
      || taskGid !== currentTaskGid;
  });
});
let restoringForm = false;

const statusOptions = [
  { value: "not_started", label: "未着手" },
  { value: "in_progress", label: "進行中" },
  { value: "completed", label: "完了" },
  { value: "withdrawn", label: "取り下げ" },
];

const importanceOptions = [
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
];

const dueKindOptions = [
  { value: "none", label: "期限なし" },
  { value: "due_on", label: "日付" },
  { value: "due_at", label: "日時" },
];

const durationUnitSelectOptions = [
  { value: "none", label: "未設定" },
  ...durationUnitOptions,
];

const areaOptions = computed(() => props.areas.map((candidate) => ({
  value: candidate,
  label: candidate,
})));

function captureFormDraft(editBaselineHash: string): FormDraft {
  return {
    editBaselineHash,
    title: title.value,
    notes: notes.value,
    status: status.value,
    importance: importance.value,
    dueKind: dueKind.value,
    dueValue: dueValue.value,
    durationUnit: durationUnit.value,
    durationValue: durationValue.value,
    area: area.value,
    dependencyText: dependencyText.value,
    parentGid: parentGid.value,
    parentWorkMode: parentWorkMode.value,
  };
}

function storeActiveDraft(): void {
  const taskGid = activeTaskGid.value;
  if (taskGid == null || !draftDirty.value) {
    return;
  }
  const existingDraft = props.draftStore.get(taskGid);
  const editBaselineHash = existingDraft?.editBaselineHash
    ?? (props.task?.gid === taskGid ? props.task.edit_baseline_hash : undefined);
  if (editBaselineHash == null) {
    throw new Error("編集基準ハッシュがありません。");
  }
  props.draftStore.set(taskGid, captureFormDraft(editBaselineHash));
}

function applyTaskValues(task: TaskDetail): void {
  title.value = task.title;
  notes.value = task.notes;
  status.value = task.status;
  importance.value = task.importance;
  area.value = task.area;
  parentWorkMode.value = task.parent_work_mode;
  if (task.duration == null) {
    durationUnit.value = "none";
    durationValue.value = "";
  } else {
    durationUnit.value = task.duration.unit;
    durationValue.value = String(task.duration.value);
  }
  dependencyText.value = task.dependencies.map((dependency) => `${dependency.gid}:${dependency.scope}`).join(", ");
  parentGid.value = task.parent?.gid ?? "";
  if (task.due.kind === "none") {
    dueKind.value = "none";
    dueValue.value = "";
  } else if (task.due.kind === "on") {
    dueKind.value = "due_on";
    dueValue.value = task.due.value;
  } else {
    dueKind.value = "due_at";
    dueValue.value = isoToJstDatetimeLocal(task.due.value);
  }
}

function applyDraft(draft: FormDraft): void {
  title.value = draft.title;
  notes.value = draft.notes;
  status.value = draft.status;
  importance.value = draft.importance;
  dueKind.value = draft.dueKind;
  dueValue.value = draft.dueValue;
  durationUnit.value = draft.durationUnit;
  durationValue.value = draft.durationValue;
  area.value = draft.area;
  dependencyText.value = draft.dependencyText;
  parentGid.value = draft.parentGid;
  parentWorkMode.value = draft.parentWorkMode;
}

function moveDraftToStale(taskGid: string): void {
  const draft = props.draftStore.get(taskGid);
  if (draft != null) {
    props.draftStore.moveToStale(taskGid);
  }
  if (activeTaskGid.value === taskGid) {
    draftDirty.value = false;
  }
}

function processTaskEditMarker(
  taskGid: string,
  task: TaskDetail | undefined,
): void {
  const marker = props.taskEditMarkers.get(taskGid);
  if (marker == null) {
    return;
  }
  if (marker.kind === "saved" && marker.detail == null) {
    return;
  }
  if (!props.draftStore.markProcessed(taskGid, marker.generation)) return;
  if (marker.kind === "conflict" || marker.kind === "missing") {
    moveDraftToStale(taskGid);
    if (activeTaskGid.value === taskGid && task?.gid === taskGid) {
      restoringForm = true;
      applyTaskValues(task);
      restoringForm = false;
    }
    return;
  }
  const draft = props.draftStore.get(taskGid);
  if (draft == null) {
    return;
  }
  if (marker.detail == null) {
    return;
  }
  const savedTask = marker.detail;
  const nextDraft = applySavedOperation(draft, savedTask, marker.operation);
  if (draftDiffersFromTask(nextDraft, savedTask)) {
    props.draftStore.set(taskGid, nextDraft);
    if (activeTaskGid.value === taskGid) {
      restoringForm = true;
      applyDraft(nextDraft);
      restoringForm = false;
    }
    return;
  }
  props.draftStore.remove(taskGid);
  if (activeTaskGid.value === taskGid) {
    restoringForm = true;
    applyTaskValues(savedTask);
    restoringForm = false;
    draftDirty.value = false;
  }
}

function resetForm(task: TaskDetail | undefined): void {
  if (activeTaskGid.value != null && activeTaskGid.value !== task?.gid) {
    storeActiveDraft();
  }
  if (task != null) {
    processTaskEditMarker(task.gid, task);
  }
  localError.value = "";
  restoringForm = true;
  if (task == null) {
    activeTaskGid.value = undefined;
    draftDirty.value = false;
    title.value = "";
    notes.value = "";
    durationUnit.value = "none";
    durationValue.value = "";
    dependencyText.value = "";
    parentGid.value = "";
    restoringForm = false;
    return;
  }
  activeTaskGid.value = task.gid;
  const draft = props.draftStore.get(task.gid);
  if (draft == null) {
    applyTaskValues(task);
    draftDirty.value = false;
  } else {
    applyDraft(draft);
    draftDirty.value = true;
  }
  restoringForm = false;
}

watch(() => props.task, resetForm, { immediate: true });

watch(
  [title, notes, status, importance, dueKind, dueValue, durationUnit, durationValue, area, dependencyText, parentGid, parentWorkMode],
  () => {
    if (restoringForm || activeTaskGid.value == null) {
      return;
    }
    draftDirty.value = true;
    storeActiveDraft();
  },
  { flush: "sync" },
);

watch(() => props.taskEditMarkers, (markers) => {
  for (const taskGid of markers.keys()) {
    processTaskEditMarker(taskGid, props.task?.gid === taskGid ? props.task : undefined);
  }
}, { immediate: true });

function acknowledgeConflict(): void {
  const taskGid = props.task?.gid;
  const marker = currentConflictMarker.value;
  if (taskGid == null || marker == null) {
    throw new Error("確認対象の競合がありません。");
  }
  props.draftStore.acknowledgeConflict(taskGid, marker.generation);
  localError.value = "";
}

function submitOperation(operation: GuiEditOperation): void {
  const task = props.task;
  if (task == null) {
    return;
  }
  localError.value = "";
  const draft = props.draftStore.get(task.gid);
  const input = applyEditRequestSchema.safeParse({
    task_gid: task.gid,
    expected_task_hash: draft?.editBaselineHash ?? task.edit_baseline_hash,
    operation,
  });
  if (!input.success) {
    localError.value = "入力値を確認してください。";
    return;
  }
  emit("edit", input.data);
}

function submitTitle(): void {
  submitOperation({ kind: "update_title", value: title.value });
}

function submitNotes(): void {
  submitOperation({ kind: "update_notes", value: notes.value });
}

function submitStatus(): void {
  submitOperation({ kind: "set_status", value: status.value });
}

function selectStatus(value: string | number): void {
  status.value = taskStatusSchema.parse(value);
  submitStatus();
}

function submitImportance(): void {
  try {
    submitOperation({ kind: "set_importance", value: importanceSchema.parse(importance.value) });
  } catch {
    localError.value = "重要度を確認してください。";
  }
}

function selectImportance(value: string | number): void {
  importance.value = importanceSchema.parse(value);
  submitImportance();
}

function submitDue(): void {
  try {
    if (dueKind.value === "none") {
      submitOperation({ kind: "clear_due" });
      return;
    }
    if (dueKind.value === "due_on") {
      submitOperation({ kind: "set_due", value: { kind: "on", value: dateSchema.parse(dueValue.value) } });
      return;
    }
    submitOperation({ kind: "set_due", value: { kind: "at", value: jstDatetimeLocalToIso(dueValue.value) } });
  } catch {
    localError.value = "期限を確認してください。";
  }
}

function submitDueKind(): void {
  if (dueKind.value === "none") {
    submitOperation({ kind: "clear_due" });
  }
}

function selectDueKind(value: string | number): void {
  if (value !== "none" && value !== "due_on" && value !== "due_at") {
    throw new TypeError("期限種別の形式が不正です。");
  }
  dueKind.value = value;
  submitDueKind();
}

function submitDuration(): void {
  if (durationUnit.value === "none") {
    submitOperation({ kind: "clear_duration" });
    return;
  }
  try {
    submitOperation({
      kind: "set_duration",
      value: parseDurationInput(durationUnit.value, durationValue.value),
    });
  } catch {
    localError.value = "所要時間を確認してください。";
  }
}

function selectDurationUnit(value: string | number): void {
  const previousUnit = durationUnit.value;
  if (value === "none") {
    durationUnit.value = "none";
    durationValue.value = "";
    submitDuration();
    return;
  }
  const selectedUnit = durationUnitOptions.find((option) => option.value === value);
  if (selectedUnit == null) {
    throw new TypeError("所要時間の単位の形式が不正です。");
  }
  durationUnit.value = selectedUnit.value;
  if (previousUnit !== selectedUnit.value && durationValue.value.trim().length > 0) {
    submitDuration();
  }
}

function submitArea(): void {
  submitOperation({ kind: "set_area", value: area.value });
}

function selectArea(value: string | number): void {
  area.value = z.string().parse(value);
  submitArea();
}

function currentDependencies(task: TaskDetail): Extract<GuiEditOperation, { kind: "set_dependencies" }>["value"] {
  return task.dependencies.map((dependency) => ({
    task_gid: dependency.gid,
    scope: dependency.scope,
    source: dependency.source,
  }));
}

function submitDependencies(): void {
  const task = props.task;
  if (task == null) {
    return;
  }
  try {
    const dependencies = parseDependencyInput(dependencyText.value, currentDependencies(task));
    submitOperation({ kind: "set_dependencies", value: dependencies });
  } catch {
    localError.value = "依存先のGIDを確認してください。";
  }
}

function submitParent(): void {
  if (parentGid.value.trim().length === 0) {
    submitOperation({ kind: "set_parent", value: { kind: "absent" } });
    return;
  }
  submitOperation({ kind: "set_parent", value: { kind: "existing", gid: parentGid.value.trim() } });
}

function submitParentWorkMode(): void {
  submitOperation({ kind: "set_parent_work_mode", value: parentWorkMode.value });
}

function selectParentWorkMode(value: string | number): void {
  parentWorkMode.value = parentWorkModeSchema.parse(value);
  submitParentWorkMode();
}

function unlinkLink(link: ObsidianLink): void {
  submitOperation({ kind: "unlink_obsidian", value: link });
}

</script>

<template>
  <section
    class="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    aria-labelledby="task-detail-title"
  >
    <section
      v-if="sharedStaleDraftEntries.length > 0"
      class="mx-5 mt-5 rounded-md border border-amber-300 bg-amber-50 p-3 text-left text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      aria-label="未保存の入力"
    >
      <h3 class="text-sm font-semibold">
        未保存の入力を保持しています
      </h3>
      <p class="mt-1 text-xs">
        対象タスクが消えたか最新状態と競合したため、自動で再適用しません。内容を確認してから編集し直してください。
      </p>
      <details
        v-for="[taskGid, staleDraft] in sharedStaleDraftEntries"
        :key="taskGid"
        class="mt-2 rounded-md border border-amber-300 p-2 dark:border-amber-800"
      >
        <summary class="cursor-pointer text-xs font-medium">
          タスクGID {{ taskGid }}・{{ staleDraft.title }}
        </summary>
        <dl class="mt-2 grid gap-1 text-xs">
          <div
            v-for="entry in staleDraftDetails(staleDraft)"
            :key="entry.label"
          >
            <dt class="inline font-medium">
              {{ entry.label }}：
            </dt>
            <dd class="inline whitespace-pre-wrap break-words">
              {{ entry.value }}
            </dd>
          </div>
        </dl>
      </details>
    </section>
    <div
      v-if="props.task == null"
      class="px-5 py-10 text-center text-sm text-slate-600 dark:text-slate-400"
    >
      <h2
        id="task-detail-title"
        class="sr-only"
      >
        タスク詳細
      </h2>
      <p class="mt-2">
        一覧からタスクを選択してください。
      </p>
    </div>
    <template v-else>
      <div class="border-b border-slate-200 px-5 py-4 dark:border-slate-700">
        <div class="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <h2
              id="task-detail-title"
              class="break-words text-xl font-semibold text-slate-900 dark:text-slate-100"
            >
              {{ props.task.title }}
            </h2>
          </div>
          <a
            class="secondary-button inline-flex shrink-0"
            :href="props.task.asana_url"
            target="_blank"
            rel="noreferrer"
          >Asanaで開く</a>
        </div>
        <details
          v-if="props.task.cleanup_warnings.length > 0"
          class="mt-3 rounded-md border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
        >
          <summary
            class="cursor-pointer px-3 py-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-inset dark:text-amber-100 dark:focus:ring-amber-400"
          >
            要整理 {{ props.task.cleanup_warnings.length }}件
          </summary>
          <ul class="list-disc space-y-1 border-t border-amber-200 p-3 pl-8 text-xs text-amber-900 dark:border-amber-800 dark:text-amber-100">
            <li
              v-for="warning in props.task.cleanup_warnings"
              :key="`${warning.kind}-${warning.message}`"
            >
              {{ warning.message }}
            </li>
          </ul>
        </details>
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
          v-if="conflictNeedsAcknowledgement"
          class="rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
          role="alert"
        >
          <p>最新状態と競合しました。最新内容を確認してから編集し直してください。保存前の入力は自動で再送しません。</p>
          <details
            v-if="staleDraftForCurrentTask != null"
            class="mt-2 rounded-md border border-amber-300 p-2 dark:border-amber-800"
          >
            <summary class="cursor-pointer text-xs font-medium">
              保存前の入力を確認
            </summary>
            <dl class="mt-2 grid gap-1 text-xs">
              <div
                v-for="entry in staleDraftDetails(staleDraftForCurrentTask)"
                :key="entry.label"
              >
                <dt class="inline font-medium">
                  {{ entry.label }}：
                </dt>
                <dd class="inline whitespace-pre-wrap break-words">
                  {{ entry.value }}
                </dd>
              </div>
            </dl>
          </details>
          <button
            type="button"
            class="secondary-button mt-2"
            @click="acknowledgeConflict"
          >
            最新状態から編集を続ける
          </button>
        </div>
        <p
          v-if="props.savingState !== 'idle' || !props.canWrite"
          class="text-sm text-slate-600 dark:text-slate-300"
          role="status"
          aria-live="polite"
        >
          <span v-if="props.savingState === 'waiting_sync'">同期の完了を待っています</span>
          <span v-else-if="props.savingState === 'saving'">保存しています…</span>
          <span v-else>現在は編集できません。</span>
        </p>
        <div
          v-if="props.execution != null"
          class="flex flex-wrap items-center gap-3 text-sm text-slate-600 dark:text-slate-300"
          role="status"
        >
          <span>{{ props.executionFeedback?.text }}</span>
          <button
            v-if="props.execution.state === 'planned' || props.execution.state === 'running'
              || props.execution.state === 'succeeded' && props.executionFeedback?.kind === 'warning'"
            type="button"
            class="secondary-button"
            @click="emit('check-execution', props.execution.execution_id)"
          >
            実行状態を再確認
          </button>
          <button
            v-if="props.execution.state === 'failed' || props.execution.state === 'confirmation_required'"
            type="button"
            class="secondary-button"
            :disabled="props.savingState !== 'idle'"
            @click="emit('retry-execution', props.execution.execution_id)"
          >
            明示的に再試行
          </button>
        </div>
        <div
          class="grid gap-4"
          :aria-busy="props.savingState !== 'idle'"
        >
          <div class="field-group">
            <label
              class="field-label"
              for="detail-title-input"
            >タイトル<input
              id="detail-title-input"
              v-model="title"
              class="text-input"
              :disabled="!props.canWrite"
              @change="submitTitle"
            ></label>
          </div>
          <div class="grid gap-4 sm:grid-cols-3">
            <div class="field-group">
              <label
                class="field-label"
                for="detail-status"
              >状態<RekaSelect
                id="detail-status"
                :model-value="status"
                :options="statusOptions"
                :disabled="!props.canWrite"
                @update:model-value="selectStatus"
              /></label>
            </div>
            <div class="field-group">
              <label
                class="field-label"
                for="detail-importance"
              ><span
                class="self-start"
                :class="importanceToneClass(importance)"
              >重要度</span><RekaSelect
                id="detail-importance"
                :model-value="importance"
                :options="importanceOptions"
                :disabled="!props.canWrite"
                @update:model-value="selectImportance"
              /></label>
            </div>
            <div class="field-group">
              <label
                class="field-label"
                for="detail-area"
              >領域<RekaSelect
                id="detail-area"
                :model-value="area"
                :options="areaOptions"
                :disabled="!props.canWrite"
                @update:model-value="selectArea"
              /></label>
            </div>
          </div>
          <div class="field-group min-w-0">
            <label
              class="field-label"
              for="detail-due-kind"
            ><span class="flex flex-wrap items-center gap-2">
              <span>期限</span>
              <span
                v-if="detailDeadlinePreview != null"
                class="text-xs font-normal"
                :class="deadlineToneClass(detailDeadlinePreview.tone)"
                role="status"
              >{{ detailDeadlinePreview.label }}</span>
            </span></label>
            <div class="grid min-w-0 grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)] gap-2">
              <RekaSelect
                id="detail-due-kind"
                :model-value="dueKind"
                :options="dueKindOptions"
                :disabled="!props.canWrite"
                @update:model-value="selectDueKind"
              /><input
                v-if="dueKind === 'due_on'"
                v-model="dueValue"
                class="text-input min-w-0"
                type="date"
                aria-label="期限日"
                :disabled="!props.canWrite"
                @change="submitDue"
              ><input
                v-else-if="dueKind === 'due_at'"
                v-model="dueValue"
                class="text-input min-w-0"
                type="datetime-local"
                aria-label="期限日時"
                :disabled="!props.canWrite"
                @change="submitDue"
              >
            </div>
          </div>
          <div class="field-group min-w-0">
            <label
              class="field-label"
              for="detail-duration-unit"
            >所要時間</label>
            <div class="grid min-w-0 grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)] gap-2">
              <RekaSelect
                id="detail-duration-unit"
                :model-value="durationUnit"
                :options="durationUnitSelectOptions"
                :disabled="!props.canWrite"
                @update:model-value="selectDurationUnit"
              /><input
                v-if="durationInput != null"
                v-model="durationValue"
                class="text-input min-w-0"
                type="number"
                inputmode="numeric"
                :min="durationInput.minimum"
                step="1"
                aria-label="所要時間の数値"
                required
                :disabled="!props.canWrite"
                @change="submitDuration"
              >
            </div>
          </div>
          <div class="field-group">
            <label
              class="field-label"
              for="detail-notes"
            >説明<textarea
              id="detail-notes"
              v-model="notes"
              class="text-input min-h-48"
              :disabled="!props.canWrite"
              @change="submitNotes"
            /></label>
          </div>
        </div>

        <div class="field-group border-t border-slate-200 pt-5 dark:border-slate-700">
          <p class="field-label">
            状態操作
          </p>
          <div class="flex flex-wrap gap-2">
            <template v-if="props.task.status === 'not_started' || props.task.status === 'in_progress'">
              <button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'complete' })"
              >
                完了にする
              </button><button
                type="button"
                class="secondary-button border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100 focus:ring-amber-600 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900 dark:focus:ring-amber-400 dark:disabled:border-slate-700 dark:disabled:bg-slate-900 dark:disabled:text-slate-400"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'withdraw' })"
              >
                取り下げる
              </button>
            </template>
            <template v-else>
              <button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'restore', value: 'not_started' })"
              >
                未着手に戻す
              </button><button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'restore', value: 'in_progress' })"
              >
                進行中に戻す
              </button>
            </template>
          </div>
        </div>

        <div
          v-if="props.task.status === 'not_started' || props.task.status === 'in_progress'"
          class="field-group border-t border-slate-200 pt-5 dark:border-slate-700"
        >
          <p class="field-label">
            作業記録
          </p>
          <div class="flex flex-wrap gap-2">
            <p class="w-full text-xs text-slate-600 dark:text-slate-400">
              今日作業したことを記録し、長く作業していないことによる順位の減点をリセットします。タスクの状態は変わりません。
            </p>
            <button
              type="button"
              class="secondary-button"
              :disabled="!props.canWrite"
              @click="submitOperation({ kind: 'mark_activity' })"
            >
              今日の作業を記録
            </button>
          </div>
        </div>

        <slot
          name="related-notes"
          :task="props.task"
          :can-write="props.canWrite"
          :unlink="unlinkLink"
        />
        <TaskRelations
          v-model:dependency-text="dependencyText"
          v-model:parent-gid="parentGid"
          :task="props.task"
          :can-write="props.canWrite"
          :parent-work-mode="parentWorkMode"
          @submit-dependencies="submitDependencies"
          @submit-parent="submitParent"
          @select-parent-work-mode="selectParentWorkMode"
        />
        <TaskRankingDetails :task="props.task" />
      </div>
    </template>
  </section>
</template>
