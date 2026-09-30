<script setup lang="ts">
import type { DependencyDraft, TargetOption } from "./proposal-editor-form";

const dependencies = defineModel<DependencyDraft[]>("dependencies", { required: true });
const props = defineProps<{
  targetOptions: readonly TargetOption[];
  disabled: boolean;
  addDependency: () => void;
  removeDependency: (id: number) => void;
}>();
</script>

<template>
  <div class="proposal-dependencies space-y-2">
    <div
      v-for="(dependency, index) in dependencies"
      :key="dependency.id"
      class="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,7rem)_minmax(0,1fr)_auto]"
    >
      <select
        v-model="dependency.targetKey"
        class="text-input"
        :aria-label="`依存先${index + 1}`"
        required
        :disabled="props.disabled"
      >
        <option value="">
          依存先を選択
        </option>
        <option
          v-for="option in props.targetOptions"
          :key="option.key"
          :value="option.key"
        >
          {{ option.label }}
        </option>
      </select>
      <select
        v-model="dependency.scope"
        class="text-input"
        :aria-label="`依存範囲${index + 1}`"
        :disabled="props.disabled"
      >
        <option value="full">
          完全依存
        </option>
        <option value="partial">
          一部依存
        </option>
      </select>
      <input
        v-model="dependency.source"
        class="text-input"
        type="text"
        :aria-label="`依存関係の根拠${index + 1}`"
        placeholder="根拠の識別子"
        required
        :disabled="props.disabled"
      >
      <button
        type="button"
        class="secondary-button"
        :disabled="props.disabled"
        @click="props.removeDependency(dependency.id)"
      >
        削除
      </button>
    </div>
    <button
      type="button"
      class="secondary-button"
      :disabled="props.disabled"
      @click="props.addDependency"
    >
      依存先を追加
    </button>
  </div>
</template>

<style scoped>
.proposal-dependencies .text-input {
  width: 100%;
  min-width: 0;
}
</style>
