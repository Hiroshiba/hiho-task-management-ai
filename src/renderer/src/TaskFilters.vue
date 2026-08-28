<script setup lang="ts">
import { rendererFilterSchema, type RendererFilter } from "./state";

const props = defineProps<{
  modelValue: RendererFilter;
  areas: readonly string[];
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: RendererFilter): void;
}>();

function filterValue(filter: RendererFilter): string {
  if (filter.kind === "area") {
    return `area:${filter.area}`;
  }
  return filter.kind;
}

function onChange(event: Event): void {
  if (!(event.currentTarget instanceof HTMLSelectElement)) {
    throw new TypeError("フィルター入力元が不正です。");
  }
  const value = event.currentTarget.value;
  const filter = value.startsWith("area:")
    ? { kind: "area", area: value.slice("area:".length) }
    : { kind: value };
  emit("update:modelValue", rendererFilterSchema.parse(filter));
}
</script>

<template>
  <label
    class="field-label min-w-52"
    for="task-filter"
  >
    表示フィルター
    <select
      id="task-filter"
      class="text-input"
      :value="filterValue(props.modelValue)"
      :disabled="props.disabled"
      @change="onChange"
    >
      <option value="normal">通常</option>
      <option value="include_full_block">完全ブロックを含める</option>
      <option value="include_completed">完了を含める</option>
      <option value="include_withdrawn">取り下げを含める</option>
      <option value="unclassified">未分類だけ</option>
      <option value="overdue">期限超過</option>
      <option value="completion_confirmation">完了確認</option>
      <option value="cleanup">要整理</option>
      <option
        v-for="area in props.areas"
        :key="area"
        :value="`area:${area}`"
      >領域: {{ area }}</option>
    </select>
  </label>
</template>
