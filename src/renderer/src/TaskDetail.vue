<script setup lang="ts">
import { ref, watch } from "vue";
import {
  areaSchema,
  dateSchema,
  importanceSchema,
  isoDateTimeSchema,
  type Dependency,
  type ObsidianLink,
} from "../../shared/domain";
import type {
  IpcObsidianNoteSummary,
  IpcObsidianSearchResult,
} from "../../shared/ipc";
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

function submitImportance(): void {
  try {
    submitOperation({ kind: "set_importance", value: importanceSchema.parse(importance.value) });
  } catch {
    localError.value = "重要度を確認してください。";
  }
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

function submitArea(): void {
  try {
    submitOperation({ kind: "set_area", value: areaSchema.parse(area.value) });
  } catch {
    localError.value = "領域を確認してください。";
  }
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
    return "存在を確認済み";
  }
  if (status === "missing") {
    return "見つかりません";
  }
  if (status === "unavailable") {
    return "この端末では利用不可";
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
  const entries = [
    { label: "活動基準日", value: task.activity_anchor_on },
  ];
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
    { label: "実効期限", value: tieBreak.effective_due_at ?? "期限なし" },
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

function executionPoints(task: ViewModelTaskDetail): number | undefined {
  const breakdown = task.ranking.score_breakdown;
  if (breakdown == null) {
    return undefined;
  }
  return breakdown.execution_points;
}

function rankingDetailsOpen(task: ViewModelTaskDetail): boolean {
  switch (task.ranking.kind) {
    case "ranked":
      return false;
    case "excluded":
    case "unavailable":
      return true;
  }
}

function hasCleanupWarnings(task: ViewModelTaskDetail): boolean {
  return task.cleanup_warnings.length > 0;
}
</script>

<template>
  <section
    class="rounded-xl border border-slate-200 bg-white shadow-sm"
    aria-labelledby="task-detail-title"
  >
    <div
      v-if="props.task == null"
      class="px-5 py-10 text-center text-sm text-slate-600"
    >
      タスクを選択してください。
    </div>
    <template v-else>
      <div class="border-b border-slate-200 px-5 py-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="text-xs text-slate-500">
              {{ props.task.gid }}
            </p>
            <h2
              id="task-detail-title"
              class="mt-1 text-xl font-semibold text-slate-900"
            >
              {{ props.task.title }}
            </h2>
          </div>
          <a
            class="secondary-button inline-flex"
            :href="props.task.asana_url"
            target="_blank"
            rel="noreferrer"
          >Asanaで開く</a>
        </div>
        <p
          v-if="hasCleanupWarnings(props.task)"
          class="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          要整理項目があります。
        </p>
        <ul
          v-if="props.task.cleanup_warnings.length > 0"
          class="mt-2 list-disc pl-5 text-xs text-amber-900"
        >
          <li
            v-for="warning in props.task.cleanup_warnings"
            :key="`${warning.kind}-${warning.message}`"
          >
            {{ warning.message }}
          </li>
        </ul>
      </div>

      <div class="space-y-6 p-5">
        <p
          v-if="localError.length > 0"
          class="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800"
          role="alert"
        >
          {{ localError }}
        </p>
        <p
          class="text-sm text-slate-600"
          role="status"
          aria-live="polite"
        >
          <span v-if="props.saving">保存しています…</span>
          <span v-else-if="props.canWrite">変更すると自動で保存されます。</span>
          <span v-else>現在は編集できません。</span>
        </p>
        <div
          class="grid gap-4 sm:grid-cols-2"
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
          <div class="field-group">
            <label
              class="field-label"
              for="detail-status"
            >状態<select
              id="detail-status"
              v-model="status"
              class="text-input"
              :disabled="!props.canWrite"
              @change="submitStatus"
            ><option value="not_started">未着手</option><option value="in_progress">進行中</option><option value="completed">完了</option><option value="withdrawn">取り下げ</option></select></label>
          </div>
          <div class="field-group">
            <label
              class="field-label"
              for="detail-importance"
            >重要度<select
              id="detail-importance"
              v-model.number="importance"
              class="text-input"
              :disabled="!props.canWrite"
              @change="submitImportance"
            ><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option><option :value="4">4</option><option :value="5">5</option></select></label>
          </div>
          <div class="field-group">
            <label
              class="field-label"
              for="detail-due-kind"
            >期限<select
              id="detail-due-kind"
              v-model="dueKind"
              class="text-input"
              :disabled="!props.canWrite"
              @change="submitDueKind"
            ><option value="none">期限なし</option><option value="due_on">日付</option><option value="due_at">日時</option></select></label><input
              v-if="dueKind === 'due_on'"
              v-model="dueValue"
              class="text-input"
              type="date"
              aria-label="期限日"
              :disabled="!props.canWrite"
              @change="submitDue"
            ><input
              v-else-if="dueKind === 'due_at'"
              v-model="dueValue"
              class="text-input"
              type="datetime-local"
              aria-label="期限日時"
              :disabled="!props.canWrite"
              @change="submitDue"
            >
          </div>
          <div class="field-group">
            <label
              class="field-label"
              for="detail-area"
            >領域<select
              id="detail-area"
              v-model="area"
              class="text-input"
              :disabled="!props.canWrite"
              @change="submitArea"
            ><option
              v-for="candidate in props.areas"
              :key="candidate"
              :value="candidate"
            >{{ candidate }}</option></select></label>
          </div>
          <div class="field-group sm:col-span-2">
            <label
              class="field-label"
              for="detail-notes"
            >説明<textarea
              id="detail-notes"
              v-model="notes"
              class="text-input min-h-32"
              :disabled="!props.canWrite"
              @change="submitNotes"
            /></label>
          </div>
        </div>

        <div class="grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-2">
          <form
            class="field-group"
            @submit.prevent="submitDependencies"
          >
            <label
              class="field-label"
              for="detail-dependencies"
            >依存先GIDと範囲 <input
              id="detail-dependencies"
              v-model="dependencyText"
              class="text-input"
              :disabled="!props.canWrite"
            ></label><p class="text-xs text-slate-500">
              複数はカンマ区切りで、追加時はGID:fullまたはGID:partialを指定します。
            </p><button
              type="submit"
              class="secondary-button self-start"
              :disabled="!props.canWrite"
            >
              依存関係を保存
            </button>
          </form>
          <form
            class="field-group"
            @submit.prevent="submitParent"
          >
            <label
              class="field-label"
              for="detail-parent"
            >親タスクGID<input
              id="detail-parent"
              v-model="parentGid"
              class="text-input"
              :disabled="!props.canWrite"
            ></label><p class="text-xs text-slate-500">
              空欄で親を解除します。
            </p><button
              type="submit"
              class="secondary-button self-start"
              :disabled="!props.canWrite"
            >
              親子関係を保存
            </button>
          </form>
          <form
            class="field-group"
            @submit.prevent="submitParentWorkMode"
          >
            <label
              class="field-label"
              for="detail-parent-mode"
            >parent_work_mode<select
              id="detail-parent-mode"
              v-model="parentWorkMode"
              class="text-input"
              :disabled="!props.canWrite"
            ><option value="children_only">子タスクのみ</option><option value="has_own_work">親自身の作業あり</option><option value="unknown">不明</option></select></label><button
              type="submit"
              class="secondary-button self-start"
              :disabled="!props.canWrite"
            >
              親作業モードを保存
            </button>
          </form>
          <div class="field-group">
            <p class="field-label">
              状態操作
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'complete' })"
              >
                完了
              </button><button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'withdraw' })"
              >
                取り下げ
              </button><button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'restore', value: 'not_started' })"
              >
                未着手へ復帰
              </button><button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'restore', value: 'in_progress' })"
              >
                進行中へ復帰
              </button><button
                type="button"
                class="secondary-button"
                :disabled="!props.canWrite"
                @click="submitOperation({ kind: 'mark_activity' })"
              >
                活動あり
              </button>
            </div>
          </div>
        </div>

        <div class="grid gap-6 border-t border-slate-200 pt-5 lg:grid-cols-2">
          <div>
            <h3 class="section-heading">
              順位の要約
            </h3><p class="mt-2 text-sm font-medium text-sky-800">
              {{ rankingLabel(props.task) }}
            </p><p
              v-if="executionPoints(props.task) != null"
              class="mt-2 text-sm text-slate-700"
            >
              実行点: {{ executionPoints(props.task) }}
            </p><p class="mt-2 text-sm text-slate-700">
              ブロック: {{ blockLabel(props.task.block_state) }}
            </p><p
              v-if="props.task.block_reason != null"
              class="mt-1 text-sm text-amber-800"
            >
              {{ props.task.block_reason.summary }}
            </p><div class="mt-4">
              <p class="text-sm font-medium text-slate-800">
                順位理由
              </p><div
                v-if="rankingReasonSummary(props.task).visible.length > 0"
                class="mt-2 flex flex-wrap gap-1"
              >
                <span
                  v-for="reason in rankingReasonSummary(props.task).visible"
                  :key="reason"
                  class="break-words rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
                >{{ reason }}</span>
                <span
                  v-if="rankingReasonSummary(props.task).remaining > 0"
                  class="break-words rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
                >ほか{{ rankingReasonSummary(props.task).remaining }}件</span>
              </div><p
                v-else
                class="mt-1 text-sm text-slate-600"
              >
                なし
              </p>
            </div>
            <details
              class="mt-4 border-t border-slate-200 pt-3"
              :open="rankingDetailsOpen(props.task)"
            >
              <summary
                class="cursor-pointer rounded-md px-2 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2"
              >
                順位の計算根拠
              </summary>
              <div class="mt-3 space-y-4 border-l border-slate-200 pl-3">
                <p
                  v-if="props.task.ranking.calculated_at != null"
                  class="text-xs text-slate-500"
                >
                  計算日時: {{ props.task.ranking.calculated_at }}
                </p>
                <dl class="grid grid-cols-2 gap-2 text-sm">
                  <template
                    v-for="entry in scoreEntries(props.task)"
                    :key="entry.label"
                  >
                    <dt class="text-slate-600">
                      {{ entry.label }}
                    </dt><dd class="break-words text-right font-medium text-slate-900">
                      {{ entry.value }}
                    </dd>
                  </template>
                </dl>
                <div>
                  <p class="text-sm font-medium text-slate-800">
                    全理由
                  </p><div
                    v-if="rankingReasons(props.task).length > 0"
                    class="mt-2 flex flex-wrap gap-1"
                  >
                    <span
                      v-for="reason in rankingReasons(props.task)"
                      :key="reason"
                      class="break-words rounded bg-slate-100 px-2 py-1 text-xs text-slate-700"
                    >{{ reason }}</span>
                  </div><p
                    v-else
                    class="mt-1 text-sm text-slate-600"
                  >
                    なし
                  </p>
                </div>
                <div>
                  <p class="text-sm font-medium text-slate-800">
                    完了すると進むタスク
                  </p><ul class="mt-1 space-y-1 text-sm text-slate-600">
                    <li
                      v-for="gid in releaseTargetGids(props.task)"
                      :key="gid"
                      class="break-all"
                    >
                      {{ gid }}
                    </li><li v-if="releaseTargetGids(props.task).length === 0">
                      なし
                    </li>
                  </ul>
                </div>
                <div>
                  <p class="text-sm font-medium text-slate-800">
                    除外理由
                  </p><ul class="mt-1 space-y-1 text-sm text-slate-600">
                    <li
                      v-for="reason in exclusionReasons(props.task)"
                      :key="reason"
                      class="break-words"
                    >
                      {{ reason }}
                    </li><li v-if="exclusionReasons(props.task).length === 0">
                      なし
                    </li>
                  </ul>
                </div>
                <div>
                  <p class="text-sm font-medium text-slate-800">
                    同点時の比較値
                  </p><p class="mt-1 text-xs text-slate-500">
                    同点の場合は、実効期限、重要度、解放点、活動基準日、タスクGIDの順に比較します。
                  </p><dl
                    v-if="tieBreakEntries(props.task).length > 0"
                    class="mt-2 grid grid-cols-2 gap-2 text-sm"
                  >
                    <template
                      v-for="entry in tieBreakEntries(props.task)"
                      :key="entry.label"
                    >
                      <dt class="text-slate-600">
                        {{ entry.label }}
                      </dt><dd class="break-all text-right font-medium text-slate-900">
                        {{ entry.value }}
                      </dd>
                    </template>
                  </dl><p
                    v-else
                    class="mt-1 text-sm text-slate-600"
                  >
                    順位キャッシュがないため確認できません。
                  </p>
                </div>
                <div
                  v-if="props.task.ranking.detail_text != null"
                >
                  <p class="text-sm font-medium text-slate-800">
                    順位計算の詳細
                  </p><pre class="mt-2 whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 font-sans text-xs text-slate-700">{{ props.task.ranking.detail_text }}</pre>
                </div>
              </div>
            </details>
          </div>
          <div>
            <h3 class="section-heading">
              タスク関係
            </h3><p class="mt-2 text-sm text-slate-700">
              親: {{ props.task.parent == null ? "なし" : relationLabel(props.task.parent) }}
            </p><p class="mt-1 text-sm text-slate-700">
              親作業モード: {{ parentWorkModeLabel(props.task.parent_work_mode) }}
            </p><div class="mt-3">
              <p class="text-sm font-medium text-slate-800">
                依存先
              </p><ul class="mt-1 space-y-1 text-sm text-slate-600">
                <li
                  v-for="dependency in props.task.dependencies"
                  :key="`${dependency.gid}-${dependency.source}`"
                >
                  {{ relationLabel(dependency) }} {{ dependencyScopeLabel(dependency.scope) }}
                </li><li v-if="props.task.dependencies.length === 0">
                  なし
                </li>
              </ul>
            </div><div class="mt-3">
              <p class="text-sm font-medium text-slate-800">
                依存元
              </p><ul class="mt-1 space-y-1 text-sm text-slate-600">
                <li
                  v-for="dependent in props.task.dependents"
                  :key="`${dependent.gid}-${dependent.source}`"
                >
                  {{ relationLabel(dependent) }}<span
                    v-if="dependent.kind === 'found'"
                    class="ml-1"
                  >{{ dependencyScopeLabel(dependent.scope) }}</span>
                </li><li v-if="props.task.dependents.length === 0">
                  なし
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div class="grid gap-6 border-t border-slate-200 pt-5 lg:grid-cols-2">
          <div>
            <h3 class="section-heading">
              子タスク
            </h3><p class="mt-2 text-sm text-slate-700">
              進捗 {{ props.task.child_progress.completed_count }}/{{ props.task.child_progress.total_count }}
            </p><ul class="mt-2 space-y-1 text-sm text-slate-600">
              <li
                v-for="child in props.task.children"
                :key="child.gid"
              >
                {{ relationLabel(child) }}
              </li><li v-if="props.task.children.length === 0">
                なし
              </li>
            </ul>
          </div>
          <div>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="section-heading">
                Obsidianリンク
              </h3><button
                type="button"
                class="secondary-button"
                :disabled="!props.canReanalyzeObsidianNotes"
                @click="emit('reanalyze-obsidian-notes', props.task.gid)"
              >
                関連ノートを再解析
              </button>
            </div><ul class="mt-2 space-y-2 text-sm text-slate-600">
              <li
                v-for="link in props.task.obsidian_links"
                :key="`${link.vault_id}-${link.path}`"
                class="flex flex-wrap items-center justify-between gap-2"
              >
                <span><span>{{ link.title }}</span> <span class="text-xs text-slate-500">Vault: {{ link.vault_id }}・{{ link.path }}</span> <span class="ml-1 text-xs text-slate-500">{{ confidenceLabel(link.confidence) }}・{{ confidenceReason(link.confidence) }}・{{ statusForLink(link) }}</span></span><span class="flex flex-wrap gap-2"><button
                  type="button"
                  class="text-button"
                  :disabled="!props.readAvailable || !isRegisteredVault(link)"
                  @click="checkLink(link)"
                >存在確認</button><button
                  type="button"
                  class="text-button"
                  :disabled="!props.readAvailable || !isRegisteredVault(link)"
                  @click="openLink(link)"
                >ローカルで開く</button><button
                  type="button"
                  class="text-button"
                  :disabled="!props.canWrite"
                  @click="unlinkLink(link)"
                >解除</button></span>
              </li><li v-if="props.task.obsidian_links.length === 0">
                なし
              </li>
            </ul>
            <form
              class="mt-4 space-y-2 rounded-md border border-slate-200 p-3"
              @submit.prevent="emit('search-obsidian', { vaultId: obsidianVaultId, query: obsidianQuery })"
            >
              <label
                v-if="props.obsidianVaultIds.length > 0"
                class="field-label"
                for="obsidian-vault"
              >登録Vault<select
                id="obsidian-vault"
                v-model="obsidianVaultId"
                class="text-input"
                :disabled="!props.readAvailable"
              ><option
                v-for="candidate in props.obsidianVaultIds"
                :key="candidate"
                :value="candidate"
              >{{ candidate }}</option></select></label><p
                v-else
                class="text-xs text-slate-600"
              >
                登録済みVaultがありません。
              </p><label
                class="field-label"
                for="obsidian-query"
              >ノート検索<input
                id="obsidian-query"
                v-model="obsidianQuery"
                class="text-input"
                :disabled="!props.readAvailable || obsidianVaultId.length === 0"
              ></label><div class="flex flex-wrap gap-2">
                <button
                  type="submit"
                  class="secondary-button"
                  :disabled="!props.readAvailable || props.obsidianBusy || obsidianVaultId.length === 0"
                >
                  検索
                </button><button
                  type="button"
                  class="secondary-button"
                  :disabled="!props.readAvailable || props.obsidianBusy || obsidianVaultId.length === 0"
                  @click="emit('list-obsidian', obsidianVaultId)"
                >
                  ノート一覧
                </button>
              </div>
            </form>
            <ul
              v-if="props.obsidianNotes.length > 0"
              class="mt-3 space-y-2 text-xs text-slate-600"
            >
              <li
                v-for="note in props.obsidianNotes"
                :key="note.relative_path"
                class="flex flex-wrap items-center justify-between gap-2"
              >
                <span>{{ note.title }} <span class="text-slate-500">{{ note.relative_path }}</span></span><button
                  type="button"
                  class="text-button"
                  :disabled="!props.canWrite"
                  @click="addNote(note)"
                >
                  リンク追加
                </button>
              </li>
            </ul>
            <ul
              v-if="props.obsidianSearchResults.length > 0"
              class="mt-3 space-y-2 text-xs text-slate-600"
            >
              <li
                v-for="note in props.obsidianSearchResults"
                :key="`search-${note.relative_path}`"
                class="flex flex-wrap items-center justify-between gap-2"
              >
                <span>{{ note.title }} <span class="text-slate-500">{{ note.relative_path }}・{{ note.excerpt }}</span></span><button
                  type="button"
                  class="text-button"
                  :disabled="!props.canWrite"
                  @click="addSearchResult(note)"
                >
                  検索結果を追加
                </button>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
