<script setup lang="ts">
import RekaSelect from "../../shared/components/RekaSelect.vue";
import type { TaskDetail } from "./use-task-read";
import { parentWorkModeLabel, statusLabel } from "./task-presentation";

type TaskReference = NonNullable<TaskDetail["parent"]> | TaskDetail["dependencies"][number];
const props = defineProps<{
  task: TaskDetail;
  canWrite: boolean;
  dependencyText: string;
  parentGid: string;
  parentWorkMode: TaskDetail["parent_work_mode"];
}>();
const emit = defineEmits<{
  (event: "update:dependencyText", value: string): void;
  (event: "update:parentGid", value: string): void;
  (event: "submit-dependencies"): void;
  (event: "submit-parent"): void;
  (event: "select-parent-work-mode", value: string | number): void;
}>();

const parentWorkModeOptions = [
  { value: "children_only", label: "子タスクのみ" },
  { value: "has_own_work", label: "親自身の作業あり" },
  { value: "unknown", label: "不明" },
];

function updateDependencyText(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) throw new Error("依存先の入力欄がありません。");
  emit("update:dependencyText", event.target.value);
}

function updateParentGid(event: Event): void {
  if (!(event.target instanceof HTMLInputElement)) throw new Error("親タスクの入力欄がありません。");
  emit("update:parentGid", event.target.value);
}

function dependencyScopeLabel(scope: "full" | "partial"): string {
  return scope === "full" ? "完全依存" : "一部依存";
}

function relationLabel(reference: TaskReference): string {
  if (reference.kind === "missing") {
    return `${reference.gid} 見つかりません`;
  }
  return `${reference.title} ${statusLabel(reference.status)}`;
}

</script>

<template>
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
        <div class="mt-3 grid min-w-0 gap-4 xl:grid-cols-2">
          <div class="field-group min-w-0">
            <label
              class="field-label min-w-0"
              for="detail-dependencies"
            >依存するタスク<input
              id="detail-dependencies"
              :value="props.dependencyText"
              class="text-input min-w-0"
              :disabled="!props.canWrite"
              @input="updateDependencyText"
              @change="emit('submit-dependencies')"
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
              :value="props.parentGid"
              class="text-input min-w-0"
              :disabled="!props.canWrite"
              @input="updateParentGid"
              @change="emit('submit-parent')"
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
              :model-value="props.parentWorkMode"
              :options="parentWorkModeOptions"
              :disabled="!props.canWrite"
              @update:model-value="emit('select-parent-work-mode', $event)"
            /></label>
          </div>
        </div>
      </div>

      <div class="grid min-w-0 gap-6 border-t border-slate-200 pt-5 dark:border-slate-700 xl:grid-cols-2">
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
</template>
