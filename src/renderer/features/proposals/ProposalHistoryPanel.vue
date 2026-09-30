<script setup lang="ts">
import { ref } from "vue";
import type { useProposalHistory } from "./use-proposal-history";

type History = ReturnType<typeof useProposalHistory>;
type Entry = NonNullable<History["status"]["value"]>["entries"][number];
type ConfirmationEntry = Extract<Entry, { readonly kind: "confirmation_required" }>;
type ConfirmedResult = Parameters<History["confirm"]>[0]["confirmed_result"];

const props = defineProps<{ readonly history: History }>();
const emit = defineEmits<{ synchronized: [syncedAt: string] }>();
const targetIds = ref<Record<string, string>>({});
const results = ref<Record<string, ConfirmedResult>>({});
const checked = ref<Record<string, boolean>>({});
const feedback = ref<{ readonly kind: "success" | "warning"; readonly message: string }>();

function historyKey(entry: Entry): string {
  return `${entry.proposal_id}\u0000${entry.operation_id}`;
}

function targetLabel(kind: "task" | "temporary" | "new_task"): string {
  switch (kind) {
    case "task": return "タスクGID";
    case "temporary": return "一時参照ID";
    case "new_task": return "作成UUID";
  }
}

function resultLabel(result: ConfirmedResult): string {
  switch (result) {
    case "applied": return "適用済み";
    case "not_applied": return "未適用";
    case "manually_adjusted": return "手動で調整済み";
  }
}

async function confirm(entry: ConfirmationEntry): Promise<void> {
  const key = historyKey(entry);
  const targetId = targetIds.value[key];
  const result = results.value[key];
  if (targetId !== entry.target_id || result == null || checked.value[key] !== true) {
    feedback.value = { kind: "warning", message: "Asana上の実状態を確認し、対象IDと確認結果を入力してください。" };
    return;
  }
  feedback.value = undefined;
  const saved = await props.history.confirm({
    proposal_id: entry.proposal_id,
    operation_id: entry.operation_id,
    checked_target_id: targetId,
    confirmed_result: result,
    asana_checked: true,
  });
  if (saved) {
    feedback.value = { kind: "success", message: "旧適用履歴の確認結果を保存しました。全件確認後に読取同期を実行してください。" };
  }
}

async function synchronize(): Promise<void> {
  feedback.value = undefined;
  const syncedAt = await props.history.synchronize();
  if (syncedAt != null) emit("synchronized", syncedAt);
}
</script>

<template>
  <section
    v-if="history.errorMessage.value != null"
    class="rounded-xl border border-rose-200 bg-white p-4 text-sm text-rose-900 dark:border-rose-800 dark:bg-slate-900 dark:text-rose-100"
    role="alert"
  >
    <p>{{ history.errorMessage.value }}</p>
    <button
      type="button"
      class="mt-2 rounded-md border border-rose-400 px-3 py-2"
      :disabled="history.busy.value"
      @click="history.load"
    >
      履歴を再読込
    </button>
  </section>
  <section
    v-if="history.status.value != null && history.status.value.entries.length > 0"
    class="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
    aria-labelledby="proposal-history-title"
  >
    <h2
      id="proposal-history-title"
      class="text-lg font-semibold"
    >
      旧適用履歴の確認が必要です
    </h2>
    <p class="mt-2 text-sm">
      Asanaの実状態を確認してください。全件の確認結果を保存して読取同期が成功するまで、書き込みと通常同期を再開できません。
    </p>
    <p
      v-if="feedback != null"
      class="mt-3 text-sm"
      :role="feedback.kind === 'warning' ? 'alert' : 'status'"
    >
      {{ feedback.message }}
    </p>
    <div class="mt-4 space-y-4">
      <div
        v-for="entry in history.status.value.entries"
        :key="historyKey(entry)"
        class="rounded-lg border border-amber-300 bg-white p-3 text-sm dark:border-amber-700 dark:bg-slate-900"
      >
        <p>変更案ID: {{ entry.proposal_id }}</p>
        <p>操作ID: {{ entry.operation_id }}</p>
        <template v-if="entry.kind === 'confirmation_required'">
          <p>{{ targetLabel(entry.target_kind) }}: {{ entry.target_id }}</p>
          <p>元の保存結果: {{ entry.source_final_result === null ? "結果なし" : "結果不明" }}</p>
          <p>保存段階: {{ entry.source_stage }}</p>
          <label class="mt-3 block font-medium">
            確認した対象ID
            <input
              v-model="targetIds[historyKey(entry)]"
              type="text"
              autocomplete="off"
              class="mt-1 block w-full max-w-xl rounded-md border border-amber-400 bg-white px-3 py-2 text-slate-900 dark:border-amber-700 dark:bg-slate-800 dark:text-slate-100"
            >
          </label>
          <fieldset class="mt-3">
            <legend class="font-medium">
              Asanaで確認した結果
            </legend>
            <div class="mt-1 flex flex-wrap gap-4">
              <label><input
                v-model="results[historyKey(entry)]"
                type="radio"
                :name="historyKey(entry)"
                value="applied"
              > 適用済み</label>
              <label><input
                v-model="results[historyKey(entry)]"
                type="radio"
                :name="historyKey(entry)"
                value="not_applied"
              > 未適用</label>
              <label><input
                v-model="results[historyKey(entry)]"
                type="radio"
                :name="historyKey(entry)"
                value="manually_adjusted"
              > 手動で調整済み</label>
            </div>
          </fieldset>
          <label class="mt-3 block">
            <input
              v-model="checked[historyKey(entry)]"
              type="checkbox"
            >
            Asana上の実状態を確認しました
          </label>
          <button
            type="button"
            class="mt-3 rounded-md bg-amber-700 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-amber-600"
            :disabled="history.busy.value"
            @click="confirm(entry)"
          >
            確認結果を保存
          </button>
        </template>
        <template v-else-if="entry.kind === 'synchronization_required'">
          <p>{{ targetLabel(entry.target_kind) }}: {{ entry.target_id }}</p>
          <p>確認結果: {{ resultLabel(entry.confirmed_result) }}</p>
          <p class="mt-2 font-medium">
            読取同期を待っています。
          </p>
        </template>
        <template v-else>
          <p class="mt-2">
            元の旧行を履歴へ移行できません。確認操作では解除できません。
          </p>
          <p>エラーID: {{ entry.error_id }}</p>
        </template>
      </div>
    </div>
    <button
      v-if="history.canSynchronize.value"
      type="button"
      class="mt-4 rounded-md bg-amber-700 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-amber-600"
      :disabled="history.busy.value"
      @click="synchronize"
    >
      確認済み履歴を読取同期
    </button>
  </section>
</template>
