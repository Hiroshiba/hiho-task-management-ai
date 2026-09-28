<script setup lang="ts">
import type { TaskDetail } from "./use-task-read";
import { blockLabel } from "./task-presentation";
import { jstDateTimeLabel } from "../../shared/format/date-time";

const props = defineProps<{ task: TaskDetail }>();
type UnavailableReasonCode = Extract<TaskDetail["ranking"], { kind: "unavailable" }>["reason_codes"][number];

function scoreEntries(task: TaskDetail): readonly { label: string; value: string }[] {
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

function rankingReasons(task: TaskDetail): readonly string[] {
  return task.ranking.reason_chips ?? [];
}

function rankingReasonSummary(task: TaskDetail): {
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

function releaseTargetGids(task: TaskDetail): readonly string[] {
  return task.ranking.release_target_gids ?? [];
}

function tieBreakEntries(task: TaskDetail): readonly { label: string; value: string }[] {
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

function unavailableReasonLabel(reason: UnavailableReasonCode): string {
  const labels: Readonly<Record<UnavailableReasonCode, string>> = {
    ranking_unavailable: "順位キャッシュがありません。",
    critical_error: "正規化不能な重大エラーがあります。",
    custom_external_data_broken: "Asanaの外部データが壊れています。",
    custom_external_data_unknown_schema: "Asanaの外部データの形式を解釈できません。",
    custom_external_data_identity_mismatch: "Asanaの外部データの所有者が一致しません。",
    unknown_status_section: "状態セクションを解釈できません。",
    dependency_cycle: "依存関係が循環しています。",
    parent_cycle: "親子関係が循環しています。",
    completion_confirmation: "子タスク完了後の完了確認待ちです。",
    missing_dependency: "依存先タスクを確認できません。",
  };
  return labels[reason];
}

function exclusionReasons(task: TaskDetail): readonly string[] {
  const reasons = task.ranking.exclusion_reasons ?? [];
  if (reasons.length > 0) {
    return reasons.map((reason) => reason.message);
  }
  if (task.ranking.kind === "unavailable") {
    return task.ranking.reason_codes.map(unavailableReasonLabel);
  }
  return [];
}

function rankingLabel(task: TaskDetail): string {
  if (task.ranking.kind === "ranked") {
    return `順位 ${task.ranking.rank}`;
  }
  if (task.ranking.kind === "excluded") {
    return "順位対象外";
  }
  return "順位を確認できません";
}

function rankingSummaryReason(task: TaskDetail): string | undefined {
  if (task.ranking.kind === "ranked") {
    return undefined;
  }
  return exclusionReasons(task)[0];
}

</script>

<template>
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
          順位情報がないため確認できません。
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
</template>
