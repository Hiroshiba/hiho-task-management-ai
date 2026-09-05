<script setup lang="ts">
import { computed } from "vue";
import { rendererFilterSchema, type RendererFilter } from "./state";
import RekaSelect from "./RekaSelect.vue";

const props = defineProps<{
  modelValue: RendererFilter;
  areas: readonly string[];
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: RendererFilter): void;
}>();

const filterOptions = computed(() => [
  { value: "normal", label: "通常" },
  { value: "include_full_block", label: "完全ブロックを含める" },
  { value: "include_completed", label: "完了を含める" },
  { value: "include_withdrawn", label: "取り下げを含める" },
  { value: "unclassified", label: "未分類だけ" },
  { value: "overdue", label: "期限超過" },
  { value: "completion_confirmation", label: "完了確認" },
  { value: "cleanup", label: "要整理" },
  ...props.areas.map((area) => ({ value: `area:${area}`, label: `領域: ${area}` })),
]);

function filterValue(filter: RendererFilter): string {
  if (filter.kind === "area") {
    return `area:${filter.area}`;
  }
  return filter.kind;
}

function onChange(value: string | number): void {
  if (typeof value !== "string") {
    throw new TypeError("フィルター値の形式が不正です。");
  }
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
    <RekaSelect
      id="task-filter"
      :model-value="filterValue(props.modelValue)"
      :options="filterOptions"
      :disabled="props.disabled"
      @update:model-value="onChange"
    />
  </label>
</template>
