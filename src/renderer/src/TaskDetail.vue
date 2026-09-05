<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  areaSchema,
  dateSchema,
  importanceSchema,
  isoDateTimeSchema,
  parentWorkModeSchema,
  taskStatusSchema,
  type Dependency,
  type ObsidianLink,
} from "../../shared/domain";
import type { IpcObsidianNoteSummary, IpcObsidianSearchResult } from "../../shared/ipc";
import type {
  ViewModelDependencyReference,
  ViewModelTaskDetail,
  ViewModelTaskReference,
  ViewModelUnavailableReasonCode,
} from "../../shared/view-model";
import {
  parentWorkModeLabel,
  parseDependencyInput,
  parseObsidianLink,
  blockLabel,
  rendererGuiEditSchema,
  statusLabel,
  type RendererGuiEdit,
} from "./state";
import RekaSelect from "./RekaSelect.vue";

const props = defineProps<{
  task: ViewModelTaskDetail | undefined;
  areas: readonly string[];
  canWrite: boolean;
  saving: boolean;
  readAvailable: boolean;
  obsidianVaultIds: readonly string[];
  obsidianNotes: readonly IpcObsidianNoteSummary[];
  obsidianSearchResults: readonly IpcObsidianSearchResult[];
  obsidianStatuses: ReadonlyMap<string, "exists" | "missing" | "unavailable">;
  obsidianBusy: boolean;
  canReanalyzeObsidianNotes: boolean;
}>();

const emit = defineEmits<{
  (event: "edit", input: RendererGuiEdit): void;
  (event: "list-obsidian", vaultId: string): void;
  (event: "search-obsidian", input: { readonly vaultId: string; readonly query: string }): void;
  (event: "check-obsidian", link: ObsidianLink): void;
  (event: "open-obsidian", link: ObsidianLink): void;
  (event: "reanalyze-obsidian-notes", taskGid: string): void;
}>();

const title = ref("");
const notes = ref("");
const status = ref<"not_started" | "in_progress" | "completed" | "withdrawn">("not_started");
const importance = ref<1 | 2 | 3 | 4 | 5>(3);
const dueKind = ref<"none" | "due_on" | "due_at">("none");
const dueValue = ref("");
const area = ref("");
const dependencyText = ref("");
const parentGid = ref("");
const parentWorkMode = ref<"children_only" | "has_own_work" | "unknown">("unknown");
const obsidianVaultId = ref("");
const obsidianQuery = ref("");
const localError = ref("");

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

const parentWorkModeOptions = [
  { value: "children_only", label: "子タスクのみ" },
  { value: "has_own_work", label: "親自身の作業あり" },
  { value: "unknown", label: "不明" },
];

const areaOptions = computed(() => props.areas.map((candidate) => ({
  value: candidate,
  label: candidate,
})));

const obsidianVaultOptions = computed(() => props.obsidianVaultIds.map((candidate) => ({
  value: candidate,
  label: candidate,
})));

function resetForm(task: ViewModelTaskDetail | undefined): void {
  localError.value = "";
  if (task == null) {
    title.value = "";
    notes.value = "";
    dependencyText.value = "";
    parentGid.value = "";
    return;
  }
  title.value = task.title;
  notes.value = task.notes;
  status.value = task.status;
  importance.value = task.importance;
  area.value = task.area;
  parentWorkMode.value = task.parent_work_mode;
  dependencyText.value = task.dependencies.map((dependency) => `${dependency.gid}:${dependency.scope}`).join(", ");
  parentGid.value = task.parent?.gid ?? "";
  const linkedVaultId = task.obsidian_links.find((link) => props.obsidianVaultIds.includes(link.vault_id))?.vault_id;
  obsidianVaultId.value = linkedVaultId ?? props.obsidianVaultIds[0] ?? "";
  if (task.due.kind === "none") {
    dueKind.value = "none";
    dueValue.value = "";
  } else if (task.due.kind === "on") {
    dueKind.value = "due_on";
    dueValue.value = task.due.value;
  } else {
    dueKind.value = "due_at";
    dueValue.value = isoToDatetimeLocal(task.due.value);
  }
}

watch(() => props.task, resetForm, { immediate: true });

function ensureSelectedVault(): void {
  if (obsidianVaultId.value.length > 0 && props.obsidianVaultIds.includes(obsidianVaultId.value)) {
    return;
  }
  obsidianVaultId.value = props.obsidianVaultIds[0] ?? "";
}

watch(() => props.obsidianVaultIds, ensureSelectedVault, { immediate: true });

function submitOperation(operation: RendererGuiEdit["operation"]): void {
  const task = props.task;
  if (task == null) {
    return;
  }
  localError.value = "";
  try {
    emit("edit", rendererGuiEditSchema.parse({ task_gid: task.gid, operation }));
  } catch {
    localError.value = "入力値を確認してください。";
  }
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
      submitOperation({ kind: "set_due", value: { kind: "due_on", due_on: dateSchema.parse(dueValue.value) } });
      return;
    }
    submitOperation({ kind: "set_due", value: { kind: "due_at", due_at: datetimeLocalToIso(dueValue.value) } });
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

function datetimeLocalToIso(value: string): string {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (matched == null) {
    throw new Error("日時入力の形式が不正です。");
  }
  const datePart = matched[1];
  const hourPart = matched[2];
  const minutePart = matched[3];
  if (datePart == null || hourPart == null || minutePart == null) {
    throw new Error("日時入力を取得できません。");
  }
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("日時入力の時刻が不正です。");
  }
  dateSchema.parse(datePart);
  const timestamp = Date.parse(`${datePart}T${hourPart}:${minutePart}:00+09:00`);
  if (!Number.isFinite(timestamp)) {
    throw new Error("日時入力を変換できません。");
  }
  return isoDateTimeSchema.parse(new Date(timestamp).toISOString());
}

function isoToDatetimeLocal(value: string): string {
  const validated = isoDateTimeSchema.parse(value);
  const timestamp = Date.parse(validated);
  if (!Number.isFinite(timestamp)) {
    throw new Error("日時を表示用へ変換できません。");
  }
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Tokyo",
      year: "numeric",
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  if (year == null || month == null || day == null || hour == null || minute == null) {
    throw new Error("JSTの表示日時を取得できません。");
  }
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function jstDateTimeLabel(value: string): string {
  const validated = isoDateTimeSchema.parse(value);
  const timestamp = Date.parse(validated);
  if (!Number.isFinite(timestamp)) {
    throw new Error("順位計算日時を表示できません。");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}

function submitArea(): void {
  try {
    submitOperation({ kind: "set_area", value: areaSchema.parse(area.value) });
  } catch {
    localError.value = "領域を確認してください。";
  }
}

function selectArea(value: string | number): void {
  area.value = areaSchema.parse(value);
  submitArea();
}

function currentDependencies(task: ViewModelTaskDetail): Dependency[] {
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

function selectObsidianVault(value: string | number): void {
  if (typeof value !== "string") {
    throw new TypeError("ObsidianのVault選択値の形式が不正です。");
  }
  if (!props.obsidianVaultIds.includes(value)) {
    throw new Error("ObsidianのVault選択値が登録済みVaultにありません。");
  }
  obsidianVaultId.value = value;
}

function unlinkLink(link: ObsidianLink): void {
  try {
    submitOperation({ kind: "unlink_obsidian", value: parseObsidianLink(link) });
  } catch {
    localError.value = "Obsidianリンクを確認してください。";
  }
}

function checkLink(link: ObsidianLink): void {
  if (!props.obsidianVaultIds.includes(link.vault_id)) {
    return;
  }
  emit("check-obsidian", parseObsidianLink(link));
}

function openLink(link: ObsidianLink): void {
  if (!props.obsidianVaultIds.includes(link.vault_id)) {
    return;
  }
  emit("open-obsidian", parseObsidianLink(link));
}

function noteLink(note: IpcObsidianNoteSummary, vaultId: string): ObsidianLink {
  return parseObsidianLink({
    vault_id: vaultId,
    path: note.relative_path,
    title: note.title,
    confidence: 1,
  });
}

function addNote(note: IpcObsidianNoteSummary): void {
  try {
    const vaultId = obsidianVaultId.value.trim();
    if (vaultId.length === 0) {
      throw new Error("Vault IDがありません。");
    }
    submitOperation({ kind: "link_obsidian", value: noteLink(note, vaultId) });
  } catch {
    localError.value = "Vaultとノートを確認してください。";
  }
}

function addSearchResult(note: IpcObsidianSearchResult): void {
  addNote(note);
}

function statusForLink(link: ObsidianLink): string {
  const status = props.obsidianStatuses.get(`${link.vault_id}\0${link.path}`);
  if (status === "exists") {
    return "確認済み";
  }
  if (status === "missing") {
    return "見つかりません";
  }
  if (status === "unavailable") {
    return "この端末では利用できません";
  }
  return "未確認";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) {
    return "高信頼";
  }
  if (confidence >= 0.6) {
    return "中信頼";
  }
  return "低信頼";
}

function confidenceReason(confidence: number): string {
  return `保存された信頼度 ${confidence.toFixed(2)} に基づく関連付け`;
}

function isRegisteredVault(link: ObsidianLink): boolean {
  return props.obsidianVaultIds.includes(link.vault_id);
}

function dependencyScopeLabel(scope: "full" | "partial"): string {
  return scope === "full" ? "完全依存" : "一部依存";
}

function relationLabel(reference: ViewModelTaskReference | ViewModelDependencyReference): string {
  if (reference.kind === "missing") {
    return `${reference.gid} 見つかりません`;
  }
  return `${reference.title} ${statusLabel(reference.status)}`;
}

function scoreEntries(task: ViewModelTaskDetail): readonly { label: string; value: string }[] {
  const breakdown = task.ranking.score_breakdown;
  const entries = [{ label: "活動基準日", value: task.activity_anchor_on }];
  if (task.ranking.activity_elapsed_days != null) {
    entries.push({
      label: "活動基準日からの日数",
      value: `${task.ranking.activity_elapsed_days}日`,
    });
  }
  if (breakdown == null) {
    return entries;
  }
  return [
    ...entries,
    { label: "重要度点", value: `+${breakdown.importance_points}` },
    { label: "期限点", value: `+${breakdown.deadline_points}` },
    { label: "解放点", value: `+${breakdown.release_points}` },
    { label: "一部ブロック減点", value: `-${breakdown.partial_block_penalty}` },
    { label: "停滞減点", value: `-${breakdown.stagnation_penalty}` },
    { label: "実行点", value: String(breakdown.execution_points) },
  ];
}

function rankingReasons(task: ViewModelTaskDetail): readonly string[] {
  return task.ranking.reason_chips ?? [];
}

function rankingReasonSummary(task: ViewModelTaskDetail): {
  readonly visible: readonly string[];
  readonly remaining: number;
} {
  const reasons = rankingReasons(task);
  const visible = reasons.slice(0, 3);
  return {
    visible,
    remaining: reasons.length - visible.length,
  };
}

function releaseTargetGids(task: ViewModelTaskDetail): readonly string[] {
  return task.ranking.release_target_gids ?? [];
}

function tieBreakEntries(task: ViewModelTaskDetail): readonly { label: string; value: string }[] {
  const tieBreak = task.ranking.tie_break;
  if (tieBreak == null) {
    return [];
  }
  return [
    {
      label: "実効期限",
      value: tieBreak.effective_due_at == null ? "期限なし" : jstDateTimeLabel(tieBreak.effective_due_at),
    },
    { label: "重要度", value: String(tieBreak.importance) },
    { label: "解放点", value: String(tieBreak.release_points) },
    { label: "活動基準日", value: tieBreak.activity_anchor_on },
    { label: "タスクGID", value: tieBreak.gid },
  ];
}

function unavailableReasonLabel(reason: ViewModelUnavailableReasonCode): string {
  const labels: Readonly<Record<ViewModelUnavailableReasonCode, string>> = {
    ranking_unavailable: "順位キャッシュがありません。",
    critical_error: "正規化不能な重大エラーがあります。",
    custom_external_data_broken: "Custom external dataが壊れています。",
    custom_external_data_unknown_schema: "Custom external dataの形式を解釈できません。",
    custom_external_data_identity_mismatch: "Custom external dataの所有者が一致しません。",
    unknown_status_section: "状態セクションを解釈できません。",
    dependency_cycle: "依存関係が循環しています。",
    parent_cycle: "親子関係が循環しています。",
    completion_confirmation: "子タスク完了後の完了確認待ちです。",
    missing_dependency: "依存先タスクを確認できません。",
  };
  return labels[reason];
}

function exclusionReasons(task: ViewModelTaskDetail): readonly string[] {
  const reasons = task.ranking.exclusion_reasons ?? [];
  if (reasons.length > 0) {
    return reasons.map((reason) => reason.message);
  }
  if (task.ranking.kind === "unavailable") {
    return task.ranking.reason_codes.map(unavailableReasonLabel);
  }
  return [];
}

function rankingLabel(task: ViewModelTaskDetail): string {
  if (task.ranking.kind === "ranked") {
    return `順位 ${task.ranking.rank}`;
  }
  if (task.ranking.kind === "excluded") {
    return "順位対象外";
  }
  return "順位を確認できません";
}

function rankingSummaryReason(task: ViewModelTaskDetail): string | undefined {
  if (task.ranking.kind === "ranked") {
    return undefined;
  }
  return exclusionReasons(task)[0];
}

function hasCleanupWarnings(task: ViewModelTaskDetail): boolean {
  return task.cleanup_warnings.length > 0;
}
</script>

<template>
  <section
    class="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    aria-labelledby="task-detail-title"
  >
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
          v-if="hasCleanupWarnings(props.task)"
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
        <p
          v-if="props.saving || !props.canWrite"
          class="text-sm text-slate-600 dark:text-slate-300"
          role="status"
          aria-live="polite"
        >
          <span v-if="props.saving">保存しています…</span>
          <span v-else>現在は編集できません。</span>
        </p>
        <div
          class="grid gap-4"
          :aria-busy="props.saving"
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
              >重要度<RekaSelect
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
            >期限</label>
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
              <p class="w-full text-xs text-slate-600 dark:text-slate-400">
                このタスクを今日進めたことを記録し、順位に反映します。
              </p>
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
              </button><button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'mark_activity' })"
              >
                今日取り組んだ
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

        <details class="min-w-0 border-t border-slate-200 pt-5 dark:border-slate-700">
          <summary
            class="cursor-pointer rounded-md px-3 py-3 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
          >
            順位の計算根拠
          </summary>
          <div class="mt-4 space-y-4 border-l border-slate-200 pl-3 dark:border-slate-700">
            <div>
              <p class="text-sm font-medium text-sky-800 dark:text-sky-400">
                {{ rankingLabel(props.task) }}
              </p>
              <p class="mt-2 text-sm text-slate-700 dark:text-slate-300">
                ブロック: {{ blockLabel(props.task.block_state) }}
              </p>
              <p
                v-if="props.task.block_reason != null"
                class="mt-1 text-sm text-amber-800 dark:text-amber-200"
              >
                {{ props.task.block_reason.summary }}
              </p>
              <p
                v-if="rankingSummaryReason(props.task) != null"
                class="mt-1 break-words text-sm text-rose-800 dark:text-rose-200"
              >
                {{ rankingSummaryReason(props.task) }}
              </p>
              <div class="mt-4">
                <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                  順位理由
                </p>
                <div
                  v-if="rankingReasonSummary(props.task).visible.length > 0"
                  class="mt-2 flex flex-wrap gap-1"
                >
                  <span
                    v-for="reason in rankingReasonSummary(props.task).visible"
                    :key="reason"
                    class="break-words rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >{{ reason }}</span>
                  <span
                    v-if="rankingReasonSummary(props.task).remaining > 0"
                    class="break-words rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >ほか{{ rankingReasonSummary(props.task).remaining }}件</span>
                </div>
                <p
                  v-else
                  class="mt-1 text-sm text-slate-600 dark:text-slate-400"
                >
                  なし
                </p>
              </div>
            </div>
            <p
              v-if="props.task.ranking.calculated_at != null"
              class="text-xs text-slate-500 dark:text-slate-400"
            >
              計算日時: {{ jstDateTimeLabel(props.task.ranking.calculated_at) }}
            </p>
            <dl class="grid grid-cols-2 gap-2 text-sm">
              <template
                v-for="entry in scoreEntries(props.task)"
                :key="entry.label"
              >
                <dt class="text-slate-600 dark:text-slate-400">
                  {{ entry.label }}
                </dt>
                <dd class="break-words text-right font-medium text-slate-900 dark:text-slate-100">
                  {{ entry.value }}
                </dd>
              </template>
            </dl>
            <div>
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                全理由
              </p>
              <div
                v-if="rankingReasons(props.task).length > 0"
                class="mt-2 flex flex-wrap gap-1"
              >
                <span
                  v-for="reason in rankingReasons(props.task)"
                  :key="reason"
                  class="break-words rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                >{{ reason }}</span>
              </div>
              <p
                v-else
                class="mt-1 text-sm text-slate-600 dark:text-slate-400"
              >
                なし
              </p>
            </div>
            <div>
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                完了すると進むタスク
              </p>
              <ul class="mt-1 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                <li
                  v-for="gid in releaseTargetGids(props.task)"
                  :key="gid"
                  class="break-all"
                >
                  {{ gid }}
                </li>
                <li v-if="releaseTargetGids(props.task).length === 0">
                  なし
                </li>
              </ul>
            </div>
            <div>
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                除外理由
              </p>
              <ul class="mt-1 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                <li
                  v-for="reason in exclusionReasons(props.task)"
                  :key="reason"
                  class="break-words"
                >
                  {{ reason }}
                </li>
                <li v-if="exclusionReasons(props.task).length === 0">
                  なし
                </li>
              </ul>
            </div>
            <div>
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                同点時の比較値
              </p>
              <p class="mt-1 text-xs text-slate-500 dark:text-slate-400">
                同点の場合は、実効期限、重要度、解放点、活動基準日、タスクGIDの順に比較します。
              </p>
              <dl
                v-if="tieBreakEntries(props.task).length > 0"
                class="mt-2 grid grid-cols-2 gap-2 text-sm"
              >
                <template
                  v-for="entry in tieBreakEntries(props.task)"
                  :key="entry.label"
                >
                  <dt class="text-slate-600 dark:text-slate-400">
                    {{ entry.label }}
                  </dt>
                  <dd class="break-all text-right font-medium text-slate-900 dark:text-slate-100">
                    {{ entry.value }}
                  </dd>
                </template>
              </dl>
              <p
                v-else
                class="mt-1 text-sm text-slate-600 dark:text-slate-400"
              >
                順位キャッシュがないため確認できません。
              </p>
            </div>
            <div v-if="props.task.ranking.detail_text != null">
              <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                順位計算の詳細
              </p>
              <pre class="mt-2 whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 font-sans text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300">{{ props.task.ranking.detail_text }}</pre>
            </div>
          </div>
        </details>

        <details class="min-w-0 border-t border-slate-200 pt-5 dark:border-slate-700">
          <summary
            class="cursor-pointer rounded-md px-3 py-3 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
          >
            <span>タスク関係</span>
            <span class="mt-1 block text-xs font-normal text-slate-500 dark:text-slate-400">
              親 {{ props.task.parent == null ? "なし" : "あり" }}・依存先 {{ props.task.dependencies.length }}件・依存元 {{ props.task.dependents.length }}件・子タスク {{ props.task.children.length }}件
            </span>
          </summary>
          <div class="mt-4 min-w-0 space-y-6">
            <div class="field-group min-w-0">
              <h3 class="section-heading">
                依存関係と親子関係を編集
              </h3>
              <div class="mt-3 grid min-w-0 gap-4 2xl:grid-cols-2">
                <div class="field-group min-w-0">
                  <label
                    class="field-label min-w-0"
                    for="detail-dependencies"
                  >依存するタスク<input
                    id="detail-dependencies"
                    v-model="dependencyText"
                    class="text-input min-w-0"
                    :disabled="!props.canWrite"
                    @change="submitDependencies"
                  ></label>
                  <p class="break-words text-xs text-slate-500 dark:text-slate-400">
                    複数はカンマ区切りで入力します。新しい依存先は GID:full または GID:partial の形式で指定します。
                  </p>
                </div>
                <div class="field-group min-w-0">
                  <label
                    class="field-label min-w-0"
                    for="detail-parent"
                  >親タスク<input
                    id="detail-parent"
                    v-model="parentGid"
                    class="text-input min-w-0"
                    :disabled="!props.canWrite"
                    @change="submitParent"
                  ></label>
                  <p class="break-words text-xs text-slate-500 dark:text-slate-400">
                    空欄で親を解除します。
                  </p>
                </div>
                <div class="field-group min-w-0">
                  <label
                    class="field-label min-w-0"
                    for="detail-parent-mode"
                  >親タスクの作業範囲<RekaSelect
                    id="detail-parent-mode"
                    :model-value="parentWorkMode"
                    :options="parentWorkModeOptions"
                    :disabled="!props.canWrite"
                    @update:model-value="selectParentWorkMode"
                  /></label>
                </div>
              </div>
            </div>

            <div class="grid min-w-0 gap-6 border-t border-slate-200 pt-5 dark:border-slate-700 2xl:grid-cols-2">
              <div class="min-w-0">
                <h3 class="section-heading">
                  既存の関係
                </h3>
                <p class="mt-2 min-w-0 break-words text-sm text-slate-700 dark:text-slate-300">
                  親: {{ props.task.parent == null ? "なし" : relationLabel(props.task.parent) }}
                </p>
                <p class="mt-1 min-w-0 break-words text-sm text-slate-700 dark:text-slate-300">
                  親作業モード: {{ parentWorkModeLabel(props.task.parent_work_mode) }}
                </p>
                <div class="mt-3 min-w-0">
                  <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                    依存先
                  </p>
                  <ul class="mt-1 min-w-0 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                    <li
                      v-for="dependency in props.task.dependencies"
                      :key="`${dependency.gid}-${dependency.source}`"
                      class="min-w-0 break-words"
                    >
                      {{ relationLabel(dependency) }} {{ dependencyScopeLabel(dependency.scope) }}
                    </li>
                    <li v-if="props.task.dependencies.length === 0">
                      なし
                    </li>
                  </ul>
                </div>
                <div class="mt-3 min-w-0">
                  <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
                    依存元
                  </p>
                  <ul class="mt-1 min-w-0 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                    <li
                      v-for="dependent in props.task.dependents"
                      :key="`${dependent.gid}-${dependent.source}`"
                      class="min-w-0 break-words"
                    >
                      {{ relationLabel(dependent) }}<span
                        v-if="dependent.kind === 'found'"
                        class="ml-1"
                      >{{ dependencyScopeLabel(dependent.scope) }}</span>
                    </li>
                    <li v-if="props.task.dependents.length === 0">
                      なし
                    </li>
                  </ul>
                </div>
              </div>
              <div class="min-w-0">
                <h3 class="section-heading">
                  子タスク
                </h3>
                <p class="mt-2 min-w-0 break-words text-sm text-slate-700 dark:text-slate-300">
                  進捗 {{ props.task.child_progress.completed_count }}/{{ props.task.child_progress.total_count }}
                </p>
                <ul class="mt-2 min-w-0 space-y-1 text-sm text-slate-600 dark:text-slate-400">
                  <li
                    v-for="child in props.task.children"
                    :key="child.gid"
                    class="min-w-0 break-words"
                  >
                    {{ relationLabel(child) }}
                  </li>
                  <li v-if="props.task.children.length === 0">
                    なし
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </details>

        <details class="min-w-0 border-t border-slate-200 pt-5 dark:border-slate-700">
          <summary
            class="cursor-pointer rounded-md px-3 py-3 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
          >
            <span>関連ノート</span>
            <span class="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
              {{ props.task.obsidian_links.length }}件
            </span>
          </summary>
          <div class="mt-4 min-w-0">
            <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <p class="text-sm text-slate-600 dark:text-slate-400">
                関連付け済みのノート
              </p>
              <button
                type="button"
                class="secondary-button"
                :disabled="!props.canReanalyzeObsidianNotes"
                @click="emit('reanalyze-obsidian-notes', props.task.gid)"
              >
                関連ノートを再解析
              </button>
            </div>
            <ul class="mt-3 min-w-0 space-y-2 text-sm text-slate-600 dark:text-slate-400">
              <li
                v-for="link in props.task.obsidian_links"
                :key="`${link.vault_id}-${link.path}`"
                class="flex min-w-0 flex-col gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700 sm:flex-row sm:items-start sm:justify-between"
              >
                <div class="min-w-0 flex-1">
                  <p class="break-words font-medium text-slate-800 dark:text-slate-100">
                    {{ link.title }}・{{ statusForLink(link) }}
                  </p>
                  <p class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400">
                    {{ link.path }}
                  </p>
                  <details class="mt-2 min-w-0">
                    <summary
                      class="cursor-pointer rounded-md px-2 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
                    >
                      リンクの詳細
                    </summary>
                    <div class="mt-2 min-w-0 space-y-1 border-l border-slate-200 pl-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                      <p class="break-words">
                        Vault ID: {{ link.vault_id }}
                      </p>
                      <p class="break-words">
                        {{ confidenceLabel(link.confidence) }}・{{ confidenceReason(link.confidence) }}
                      </p>
                    </div>
                  </details>
                </div>
                <span class="flex min-w-0 flex-wrap gap-2">
                  <button
                    type="button"
                    class="text-button"
                    :disabled="!props.readAvailable || !isRegisteredVault(link)"
                    @click="checkLink(link)"
                  >ファイルを確認</button>
                  <button
                    type="button"
                    class="text-button"
                    :disabled="!props.readAvailable || !isRegisteredVault(link)"
                    @click="openLink(link)"
                  >ノートを開く</button>
                  <button
                    type="button"
                    class="text-button"
                    :disabled="!props.canWrite"
                    @click="unlinkLink(link)"
                  >リンクを解除</button>
                </span>
              </li>
              <li v-if="props.task.obsidian_links.length === 0">
                なし
              </li>
            </ul>
            <details class="mt-4 min-w-0 border-t border-slate-200 pt-3 dark:border-slate-700">
              <summary
                class="cursor-pointer rounded-md px-3 py-3 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
              >
                ノートを追加
              </summary>
              <div class="mt-3 min-w-0 space-y-3">
                <form
                  class="min-w-0 space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-700"
                  @submit.prevent="emit('search-obsidian', { vaultId: obsidianVaultId, query: obsidianQuery })"
                >
                  <label
                    v-if="props.obsidianVaultIds.length > 0"
                    class="field-label min-w-0"
                    for="obsidian-vault"
                  >Vault<RekaSelect
                    id="obsidian-vault"
                    :model-value="obsidianVaultId"
                    :options="obsidianVaultOptions"
                    :disabled="!props.readAvailable"
                    @update:model-value="selectObsidianVault"
                  /></label>
                  <p
                    v-else
                    class="break-words text-xs text-slate-600 dark:text-slate-400"
                  >
                    登録済みVaultがありません。
                  </p>
                  <label
                    class="field-label min-w-0"
                    for="obsidian-query"
                  >ノートを検索<input
                    id="obsidian-query"
                    v-model="obsidianQuery"
                    class="text-input min-w-0"
                    :disabled="!props.readAvailable || obsidianVaultId.length === 0"
                  ></label>
                  <div class="flex flex-wrap gap-2">
                    <button
                      type="submit"
                      class="secondary-button"
                      :disabled="!props.readAvailable || props.obsidianBusy || obsidianVaultId.length === 0"
                    >
                      検索
                    </button>
                    <button
                      type="button"
                      class="secondary-button"
                      :disabled="!props.readAvailable || props.obsidianBusy || obsidianVaultId.length === 0"
                      @click="emit('list-obsidian', obsidianVaultId)"
                    >
                      一覧を表示
                    </button>
                  </div>
                </form>
                <div
                  v-if="props.obsidianNotes.length > 0 || props.obsidianSearchResults.length > 0"
                  class="min-w-0"
                >
                  <template v-if="props.obsidianNotes.length > 0">
                    <h4 class="text-sm font-medium text-slate-800 dark:text-slate-100">
                      Vaultのノート
                    </h4>
                    <ul class="mt-2 min-w-0 space-y-2 text-xs text-slate-600 dark:text-slate-400">
                      <li
                        v-for="note in props.obsidianNotes"
                        :key="note.relative_path"
                        class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <span class="min-w-0 break-words">{{ note.title }} <span class="break-words text-slate-500 dark:text-slate-400">{{ note.relative_path }}</span></span>
                        <button
                          type="button"
                          class="text-button"
                          :disabled="!props.canWrite"
                          @click="addNote(note)"
                        >
                          このノートを追加
                        </button>
                      </li>
                    </ul>
                  </template>
                  <template v-if="props.obsidianSearchResults.length > 0">
                    <h4 class="mt-3 text-sm font-medium text-slate-800 dark:text-slate-100">
                      検索結果
                    </h4>
                    <ul class="mt-2 min-w-0 space-y-2 text-xs text-slate-600 dark:text-slate-400">
                      <li
                        v-for="note in props.obsidianSearchResults"
                        :key="`search-${note.relative_path}`"
                        class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"
                      >
                        <span class="min-w-0 break-words">{{ note.title }} <span class="break-words text-slate-500 dark:text-slate-400">{{ note.relative_path }}・{{ note.excerpt }}</span></span>
                        <button
                          type="button"
                          class="text-button"
                          :disabled="!props.canWrite"
                          @click="addSearchResult(note)"
                        >
                          このノートを追加
                        </button>
                      </li>
                    </ul>
                  </template>
                </div>
              </div>
            </details>
          </div>
        </details>
      </div>
    </template>
  </section>
</template>
