<script setup lang="ts">
import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";
import type { ApprovalResult } from "./proposal-presentation";
import type { IpcFailure } from "./proposal-state";
import ExecutionResultPanel from "./ExecutionResultPanel.vue";
import { reasonCodeLabel } from "./proposal-execution-labels";

const props = defineProps<{
  result: ApprovalResult;
  execution?: ExecutionDto | undefined;
  busy: boolean;
  failure?: IpcFailure | undefined;
}>();

const emit = defineEmits<{
  (event: "refresh", executionId: string): void;
  (event: "retry", executionId: string): void;
}>();

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

function executionForResult(): ExecutionDto {
  if (props.result.kind !== "execution") throw new Error("実行のない承認結果に実行状態はありません。");
  return props.execution ?? props.result.execution;
}

function notStartedResult(): Extract<ApprovalResult, { readonly kind: "not_started" }> {
  if (props.result.kind !== "not_started") throw new Error("実行のある承認結果に実行なしの結果はありません。");
  return props.result;
}
</script>

<template>
  <ExecutionResultPanel
    v-if="props.result.kind === 'execution'"
    :execution="executionForResult()"
    :busy="props.busy"
    :failure="props.failure"
    @refresh="emit('refresh', $event)"
    @retry="emit('retry', $event)"
  />
  <section
    v-else
    class="space-y-2 rounded-md border border-slate-200 p-4 text-sm dark:border-slate-700"
    aria-label="承認結果"
    role="status"
  >
    <p class="font-medium">
      承認結果: 実行なし・{{ outcomeLabel(notStartedResult().outcome) }}
    </p>
    <p>グループ {{ notStartedResult().group_results.length }}件・操作 {{ notStartedResult().operation_results.length }}件</p>
    <details open>
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
              v-for="group in notStartedResult().group_results"
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
              v-for="operation in notStartedResult().operation_results"
              :key="operation.operation_id"
            >
              {{ operation.operation_id }}: {{ outcomeLabel(operation.outcome) }}・理由 {{ reasonCodeLabel(operation.reason_code) }}
            </li>
          </ul>
        </div>
      </div>
    </details>
  </section>
</template>
