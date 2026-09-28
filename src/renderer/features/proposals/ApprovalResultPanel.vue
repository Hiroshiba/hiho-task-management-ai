<script setup lang="ts">
import { computed } from "vue";
import type { ApprovalResult } from "./proposal-presentation";

const props = defineProps<{ result: ApprovalResult }>();
const groupResults = computed(() => props.result.kind === "execution"
  ? props.result.execution.group_results : props.result.group_results);
const operationResults = computed(() => props.result.kind === "execution"
  ? props.result.execution.operation_results : props.result.operation_results);

function outcomeLabel(outcome: "pending" | "applied" | "already_applied" | "not_applied" | "partially_applied" | "unknown"): string {
  switch (outcome) {
    case "pending": return "処理待ち";
    case "applied": return "反映済み";
    case "already_applied": return "既に反映済み";
    case "not_applied": return "未反映";
    case "partially_applied": return "一部反映";
    case "unknown": return "結果不明";
  }
}

function stateLabel(state: "planned" | "running" | "succeeded" | "failed" | "confirmation_required"): string {
  switch (state) {
    case "planned": return "実行待ち";
    case "running": return "実行中";
    case "succeeded": return "実行完了";
    case "failed": return "実行失敗";
    case "confirmation_required": return "確認が必要";
  }
}
</script>

<template>
  <section
    class="space-y-2 rounded-md border border-slate-200 p-4 text-sm dark:border-slate-700"
    aria-label="承認結果"
    role="status"
  >
    <template v-if="result.kind === 'execution'">
      <p class="font-medium">
        承認結果: {{ stateLabel(result.execution.state) }}
      </p>
      <p>実行ID: {{ result.execution.execution_id }}</p>
      <p v-if="result.execution.state === 'failed' || result.execution.state === 'confirmation_required'">
        エラーID: {{ result.execution.error_id }}
      </p>
    </template>
    <template v-else>
      <p class="font-medium">
        承認結果: 実行なし・{{ outcomeLabel(result.outcome) }}
      </p>
    </template>
    <p>グループ {{ groupResults.length }}件・操作 {{ operationResults.length }}件</p>
    <details :open="result.kind === 'not_started' || result.execution.state === 'failed' || result.execution.state === 'confirmation_required'">
      <summary class="cursor-pointer">
        反映結果の詳細
      </summary>
      <div class="mt-2 grid gap-3 sm:grid-cols-2">
        <div>
          <h3 class="font-medium">
            グループ別
          </h3>
          <ul class="mt-1 space-y-1">
            <li
              v-for="group in groupResults"
              :key="group.group_id"
            >
              {{ group.group_id }}: {{ outcomeLabel(group.outcome) }}・{{ group.operation_ids.length }}操作
            </li>
          </ul>
        </div>
        <div>
          <h3 class="font-medium">
            操作別
          </h3>
          <ul class="mt-1 space-y-1">
            <li
              v-for="operation in operationResults"
              :key="operation.operation_id"
            >
              {{ operation.operation_id }}: {{ outcomeLabel(operation.outcome) }}<span v-if="operation.outcome !== 'pending'">・理由コード {{ operation.reason_code }}</span>
            </li>
          </ul>
        </div>
      </div>
    </details>
  </section>
</template>
