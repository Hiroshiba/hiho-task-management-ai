<script setup lang="ts">
import { computed } from "vue";
import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";
import type { IpcFailure } from "./proposal-state";

const props = defineProps<{
  execution: ExecutionDto;
  busy: boolean;
  failure?: IpcFailure | undefined;
  successorExecutionId?: string | undefined;
}>();

const emit = defineEmits<{
  (event: "refresh", executionId: string): void;
  (event: "retry", executionId: string): void;
}>();

const stopped = computed(() => props.execution.state === "failed" || props.execution.state === "confirmation_required");

function stateLabel(state: ExecutionDto["state"]): string {
  switch (state) {
    case "planned": return "実行待ち";
    case "running": return "実行中";
    case "succeeded": return "実行完了";
    case "failed": return "実行失敗";
    case "confirmation_required": return "実状態の確認が必要";
  }
}

function outcomeLabel(outcome: ExecutionDto["group_results"][number]["outcome"] | ExecutionDto["operation_results"][number]["outcome"]): string {
  switch (outcome) {
    case "pending": return "処理待ち";
    case "applied": return "反映済み";
    case "already_applied": return "既に反映済み";
    case "not_applied": return "未反映";
    case "partially_applied": return "一部反映";
    case "unknown": return "結果不明";
  }
}

function stepKindLabel(kind: ExecutionDto["steps"][number]["kind"]): string {
  switch (kind) {
    case "proposal_operation_check": return "操作の状態確認";
    case "asana_create_task": return "タスク作成";
    case "asana_update_task": return "タスク更新";
    case "asana_add_to_project": return "プロジェクト追加";
    case "asana_add_to_section": return "セクション移動";
    case "asana_add_tag": return "タグ追加";
    case "asana_remove_tag": return "タグ削除";
    case "asana_set_parent": return "親タスク設定";
    case "asana_clear_parent": return "親タスク解除";
    case "asana_merge_external_data": return "タスクの追加情報更新";
    case "local_synchronize": return "ローカル同期";
  }
}
</script>

<template>
  <section
    class="space-y-3 rounded-md border border-slate-200 p-4 text-sm dark:border-slate-700"
    aria-label="変更案の実行結果"
    :role="stopped ? 'alert' : 'status'"
  >
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0 space-y-1">
        <p class="font-medium text-slate-900 dark:text-slate-100">
          反映結果: {{ stateLabel(props.execution.state) }}
        </p>
        <p class="break-all">
          実行ID: {{ props.execution.execution_id }}
        </p>
        <p
          v-if="props.execution.retry_of_execution_id != null"
          class="break-all"
        >
          再試行元の実行ID: {{ props.execution.retry_of_execution_id }}
        </p>
        <p
          v-if="props.successorExecutionId != null"
          class="break-all"
        >
          再試行先の実行ID: {{ props.successorExecutionId }}
        </p>
        <p v-if="props.execution.state === 'failed' || props.execution.state === 'confirmation_required'">
          エラーID: {{ props.execution.error_id }}
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="secondary-button"
          :disabled="props.busy"
          @click="emit('refresh', props.execution.execution_id)"
        >
          状態を更新
        </button>
        <button
          v-if="stopped && props.successorExecutionId == null"
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('retry', props.execution.execution_id)"
        >
          {{ props.busy ? "処理中" : "明示的に再試行" }}
        </button>
      </div>
    </div>
    <p
      v-if="props.execution.state === 'confirmation_required'"
      class="text-amber-900 dark:text-amber-200"
    >
      外部サービスで反映されたか確認できません。実状態を確認してから再試行してください。
    </p>
    <p
      v-if="props.failure != null"
      class="text-rose-800 dark:text-rose-100"
    >
      {{ props.failure.message }}<span v-if="props.failure.error_id != null"> エラーID: {{ props.failure.error_id }}</span>
    </p>
    <p>グループ {{ props.execution.group_results.length }}件・操作 {{ props.execution.operation_results.length }}件・工程 {{ props.execution.steps.length }}件</p>
    <details :open="stopped">
      <summary class="cursor-pointer">
        工程と反映結果の詳細
      </summary>
      <div class="mt-3 space-y-4">
        <div>
          <h3 class="font-medium">
            工程別
          </h3>
          <ol class="mt-1 space-y-2">
            <li
              v-for="step in props.execution.steps"
              :key="step.step_id"
              class="break-words rounded-md bg-slate-50 p-2 dark:bg-slate-800"
            >
              <p>{{ stepKindLabel(step.kind) }}・{{ stateLabel(step.state) }}・試行 {{ step.attempt }}回</p>
              <p class="text-xs">
                {{ step.scope.kind === 'operation' ? `操作ID: ${step.scope.operation_id}` : '実行全体' }}
              </p>
              <p class="break-all text-xs">
                工程ID: {{ step.step_id }}
              </p>
              <p
                v-if="step.state === 'failed' || step.state === 'confirmation_required'"
                class="break-all text-xs"
              >
                エラーID: {{ step.error_id }}
              </p>
            </li>
          </ol>
        </div>
        <div>
          <h3 class="font-medium">
            グループ別
          </h3>
          <ul class="mt-1 space-y-2">
            <li
              v-for="group in props.execution.group_results"
              :key="group.group_id"
              class="break-words rounded-md bg-slate-50 p-2 dark:bg-slate-800"
            >
              <p>{{ group.group_id }}: {{ outcomeLabel(group.outcome) }}</p>
              <p class="text-xs">
                操作ID: {{ group.operation_ids.join('、') }}
              </p>
            </li>
          </ul>
        </div>
        <div>
          <h3 class="font-medium">
            操作別
          </h3>
          <ul class="mt-1 space-y-2">
            <li
              v-for="operation in props.execution.operation_results"
              :key="operation.operation_id"
              class="break-words rounded-md bg-slate-50 p-2 dark:bg-slate-800"
            >
              <p>{{ operation.operation_id }}: {{ outcomeLabel(operation.outcome) }}</p>
              <p class="text-xs">
                グループID: {{ operation.group_id }}
              </p>
              <p
                v-if="operation.task_gid != null"
                class="text-xs"
              >
                タスクGID: {{ operation.task_gid }}
              </p>
              <p
                v-if="operation.outcome !== 'pending'"
                class="text-xs"
              >
                理由コード: {{ operation.reason_code }}
              </p>
            </li>
          </ul>
        </div>
      </div>
    </details>
  </section>
</template>
