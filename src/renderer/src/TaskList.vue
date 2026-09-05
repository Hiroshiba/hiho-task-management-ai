<script setup lang="ts">
import type { ViewModelTaskRow } from "../../shared/view-model";
import { blockLabel, dueLabel, dueRelativeLabel, importanceLabel, statusLabel } from "./state";

const props = defineProps<{
  rows: readonly ViewModelTaskRow[];
  selectedTaskGid: string | undefined;
  asOf: string;
}>();

const emit = defineEmits<{
  (event: "select", taskGid: string): void;
}>();

function rankLabel(row: ViewModelTaskRow): string {
  if (row.kind !== "ranked") {
    return "—";
  }
  return String(row.rank);
}

function rowWarnings(row: ViewModelTaskRow): string {
  if (row.warning_count === 0) {
    return "";
  }
  return `${row.warning_count}件の警告`;
}

function hasSupplementaryInfo(row: ViewModelTaskRow): boolean {
  return (
    row.child_progress.total_count > 0 ||
    row.has_dependencies ||
    row.has_children ||
    rowWarnings(row).length > 0 ||
    row.block_reason != null ||
    row.kind === "excluded" ||
    row.kind === "unavailable"
  );
}

</script>

<template>
  <section
    class="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    aria-labelledby="task-list-title"
  >
    <div class="flex items-center justify-between border-b border-slate-200 px-4 py-4 sm:px-5 dark:border-slate-700">
      <h2
        id="task-list-title"
        class="text-lg font-semibold text-slate-900 dark:text-slate-100"
      >
        タスク一覧
      </h2>
      <span class="text-sm text-slate-500 dark:text-slate-400">{{ props.rows.length }}件</span>
    </div>

    <div
      v-if="props.rows.length === 0"
      class="px-5 py-10 text-center text-sm text-slate-600 dark:text-slate-400"
      role="status"
    >
      表示できるタスクがありません。
    </div>
    <div
      v-else
      class="divide-y divide-slate-200 dark:divide-slate-700"
    >
      <button
        v-for="row in props.rows"
        :key="row.gid"
        type="button"
        class="block w-full px-4 py-4 text-left hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sky-600 sm:px-5 dark:hover:bg-slate-800 dark:focus:bg-slate-800 dark:focus:ring-sky-400"
        :class="props.selectedTaskGid === row.gid ? 'bg-sky-50 dark:bg-sky-950' : ''"
        :aria-pressed="props.selectedTaskGid === row.gid"
        @click="emit('select', row.gid)"
      >
        <div class="grid gap-3 2xl:grid-cols-[3rem_minmax(14rem,2fr)_repeat(5,minmax(5rem,1fr))] 2xl:items-center">
          <div
            class="text-center text-lg font-semibold text-sky-800 dark:text-sky-400"
            aria-label="順位"
          >
            {{ rankLabel(row) }}
          </div>
          <div class="min-w-0">
            <p class="truncate font-medium text-slate-900 dark:text-slate-100">
              {{ row.title }}
            </p>
            <div
              class="mt-2 flex flex-wrap gap-1"
              aria-label="順位理由"
            >
              <span
                v-for="reason in row.reason_chips.slice(0, 3)"
                :key="reason"
                class="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
              >{{ reason }}</span>
            </div>
          </div>
          <div><span class="table-label">状態</span><span class="table-value">{{ statusLabel(row.status) }}</span></div>
          <div><span class="table-label">重要度</span><span class="table-value">{{ importanceLabel(row.importance) }}</span></div>
          <div>
            <span class="table-label">期限</span><span class="table-value">{{ dueLabel(row.due) }} <span
              v-if="dueRelativeLabel(row.due, props.asOf).length > 0"
              class="text-xs text-amber-800 dark:text-amber-200"
            >{{ dueRelativeLabel(row.due, props.asOf) }}</span></span>
          </div>
          <div><span class="table-label">ブロック</span><span class="table-value">{{ blockLabel(row.block_state) }}</span></div>
          <div><span class="table-label">領域</span><span class="table-value truncate">{{ row.area }}</span></div>
        </div>
        <div
          v-if="hasSupplementaryInfo(row)"
          class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400"
        >
          <span v-if="row.child_progress.total_count > 0">子タスク {{ row.child_progress.completed_count }}/{{ row.child_progress.total_count }}</span>
          <span v-if="row.has_dependencies">依存先あり</span>
          <span v-if="row.has_children">子タスクあり</span>
          <span
            v-if="rowWarnings(row).length > 0"
            class="font-medium text-amber-800 dark:text-amber-200"
            role="status"
          >{{ rowWarnings(row) }}</span>
          <span
            v-if="row.block_reason != null"
            class="text-amber-800 dark:text-amber-200"
          >{{ row.block_reason.summary }}</span>
          <span
            v-if="row.kind === 'excluded'"
            class="text-rose-800 dark:text-rose-200"
          >順位除外: {{ row.exclusion_reasons[0]?.message }}</span>
          <span
            v-if="row.kind === 'unavailable'"
            class="text-rose-800 dark:text-rose-200"
          >確認が必要です</span>
        </div>
      </button>
    </div>
  </section>
</template>
