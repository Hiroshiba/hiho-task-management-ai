<script setup lang="ts">
import { rendererTaskSortSchema, type RendererTaskSort } from "./state";
import RekaSelect from "./RekaSelect.vue";

const props = defineProps<{
  modelValue: RendererTaskSort;
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: RendererTaskSort): void;
}>();

const sortOptions = [
  { value: "execution_order", label: "実行順位順" },
  { value: "due_ascending", label: "期限の早い順" },
  { value: "due_descending", label: "期限の遅い順" },
  { value: "importance_descending", label: "重要度の高い順" },
  { value: "importance_ascending", label: "重要度の低い順" },
  {
    value: "duration_ascending",
    label: "所要時間の単位が小さい順、同じ単位では値が小さい順",
  },
  {
    value: "duration_descending",
    label: "所要時間の単位が大きい順、同じ単位では値が大きい順",
  },
] satisfies readonly { readonly value: RendererTaskSort; readonly label: string }[];

function onChange(value: string | number): void {
  if (typeof value !== "string") {
    throw new TypeError("並び順の形式が不正です。");
  }
  emit("update:modelValue", rendererTaskSortSchema.parse(value));
}
</script>

<template>
  <label
    class="field-label min-w-52"
    for="task-sort"
  >
    並び順
    <RekaSelect
      id="task-sort"
      :model-value="props.modelValue"
      :options="sortOptions"
      :disabled="props.disabled"
      @update:model-value="onChange"
    />
  </label>
</template>
