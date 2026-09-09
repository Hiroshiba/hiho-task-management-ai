<script setup lang="ts">
import { dateSchema, isoDateTimeSchema } from "../../shared/domain";
import type { ViewModelTaskRow } from "../../shared/view-model";
import { durationLabel } from "./duration";
import { blockLabel, dueRelativeLabel, statusLabel } from "./state";

const props = defineProps<{
  rows: readonly ViewModelTaskRow[];
  selectedTaskGid: string | undefined;
  asOf: string;
}>();

const emit = defineEmits<{
  (event: "select", taskGid: string): void;
  (event: "clear-selection"): void;
}>();

function rankLabel(row: ViewModelTaskRow): string {
  if (row.kind !== "ranked") {
    return "—";
  }
  return String(row.rank);
}

function taskDueLabel(row: ViewModelTaskRow): string {
  switch (row.due.kind) {
    case "none":
      return "期限なし";
    case "on": {
      const value = dateSchema.parse(row.due.value);
      const timestamp = Date.parse(`${value}T00:00:00+09:00`);
      return new Intl.DateTimeFormat("ja-JP", {
        day: "numeric",
        month: "long",
        timeZone: "Asia/Tokyo",
        year: "numeric",
      }).format(new Date(timestamp));
    }
    case "at": {
      const value = isoDateTimeSchema.parse(row.due.value);
      const timestamp = Date.parse(value);
      return new Intl.DateTimeFormat("ja-JP", {
        day: "numeric",
        hour: "2-digit",
        hourCycle: "h23",
        minute: "2-digit",
        month: "long",
        timeZone: "Asia/Tokyo",
        year: "numeric",
      }).format(new Date(timestamp));
    }
  }
}

function taskDurationLabel(row: ViewModelTaskRow): string {
  const duration = row.duration;
  if (duration == null) {
    throw new Error("所要時間がありません。");
  }
  return durationLabel(duration);
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
    rowWarnings(row).length > 0 ||
    row.block_reason != null ||
    row.kind === "excluded" ||
    row.kind === "unavailable"
  );
}

</script>

<template>
  <section
    class="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
    aria-labelledby="task-list-title"
  >
    <div class="border-b border-slate-200 px-4 py-4 sm:px-5 dark:border-slate-700">
      <div class="flex min-w-0 items-center justify-between">
        <div class="min-w-0 flex-1">
          <h2
            id="task-list-title"
            class="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            タスク一覧
          </h2>
        </div>
        <div class="flex shrink-0 items-center gap-3">
          <button
            v-if="props.selectedTaskGid != null"
            type="button"
            class="text-button"
            @click="emit('clear-selection')"
          >
            選択解除
          </button>
          <span class="text-sm text-slate-500 dark:text-slate-400">{{ props.rows.length }}件</span>
        </div>
      </div>
      <div class="mt-4 min-w-0">
        <slot name="filters" />
      </div>
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
      class="min-w-0 divide-y divide-slate-200 dark:divide-slate-700"
    >
      <button
        v-for="row in props.rows"
        :key="row.gid"
        type="button"
        class="block min-w-0 w-full px-4 py-3 text-left hover:bg-slate-50 focus:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-sky-600 sm:px-5 dark:hover:bg-slate-800 dark:focus:bg-slate-800 dark:focus:ring-sky-400"
        :class="props.selectedTaskGid === row.gid ? 'bg-sky-50 dark:bg-sky-950' : ''"
        :aria-pressed="props.selectedTaskGid === row.gid"
        @click="emit('select', row.gid)"
      >
        <div class="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-1">
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
          </div>
          <dl class="col-start-2 min-w-0 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <div class="flex min-w-0 items-baseline gap-x-1">
              <dt class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                状態
              </dt>
              <dd class="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">
                {{ statusLabel(row.status) }}
              </dd>
            </div>
            <div class="flex min-w-0 items-baseline gap-x-1">
              <dt class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                重要度
              </dt>
              <dd class="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">
                {{ row.importance }}
              </dd>
            </div>
            <div
              v-if="row.due.kind !== 'none'"
              class="flex min-w-0 items-baseline gap-x-1"
            >
              <dt class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                期限
              </dt>
              <dd class="flex min-w-0 flex-wrap items-baseline gap-x-2 font-medium text-slate-800 dark:text-slate-100">
                <span>{{ taskDueLabel(row) }}</span>
                <span
                  v-if="dueRelativeLabel(row.due, props.asOf).length > 0"
                  class="text-xs font-normal text-amber-800 dark:text-amber-200"
                >{{ dueRelativeLabel(row.due, props.asOf) }}</span>
              </dd>
            </div>
            <div
              v-if="row.duration != null"
              class="flex min-w-0 items-baseline gap-x-1"
            >
              <dt class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                所要時間
              </dt>
              <dd class="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">
                {{ taskDurationLabel(row) }}
              </dd>
            </div>
            <div
              v-if="row.block_state !== 'none'"
              class="flex min-w-0 items-baseline gap-x-1"
            >
              <dt class="shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
                ブロック
              </dt>
              <dd class="min-w-0 break-words font-medium text-slate-800 dark:text-slate-100">
                {{ blockLabel(row.block_state) }}
              </dd>
            </div>
          </dl>
        </div>
        <div
          v-if="hasSupplementaryInfo(row)"
          class="mt-2 ml-11 min-w-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400"
        >
          <span v-if="row.child_progress.total_count > 0">子タスク {{ row.child_progress.completed_count }}/{{ row.child_progress.total_count }}</span>
          <span v-if="row.has_dependencies">依存先あり</span>
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
