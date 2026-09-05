<script setup lang="ts">
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";

type SelectOptionValue = string | number;

type SelectOption = {
  readonly value: SelectOptionValue;
  readonly label: string;
};

const props = defineProps<{
  id: string;
  modelValue: SelectOptionValue;
  options: readonly SelectOption[];
  disabled: boolean;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: SelectOptionValue): void;
}>();

function toOptionValue(value: unknown): SelectOptionValue {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new TypeError("選択値の形式が不正です。");
  }
  return value;
}

function updateValue(value: unknown): void {
  const optionValue = toOptionValue(value);
  if (!props.options.some((option) => option.value === optionValue)) {
    throw new Error("選択値が選択肢にありません。");
  }
  emit("update:modelValue", optionValue);
}
</script>

<template>
  <SelectRoot
    :model-value="props.modelValue"
    :disabled="props.disabled"
    @update:model-value="updateValue"
  >
    <SelectTrigger
      :id="props.id"
      class="text-input flex min-w-0 w-full items-center justify-between gap-2 text-left"
    >
      <SelectValue class="min-w-0 flex-1 whitespace-normal break-words" />
      <span aria-hidden="true">⌄</span>
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="w-[var(--reka-select-trigger-width)] max-w-[var(--reka-select-content-available-width)] rounded-md border border-slate-300 bg-white p-1 text-sm text-slate-900 shadow-lg dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      >
        <SelectViewport class="max-h-[var(--reka-select-content-available-height)] overflow-auto p-1">
          <SelectItem
            v-for="option in props.options"
            :key="`${typeof option.value}:${String(option.value)}`"
            :value="option.value"
            class="relative flex cursor-default select-none items-center rounded px-8 py-2 outline-none data-[highlighted]:bg-sky-100 data-[highlighted]:text-sky-950 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 dark:data-[highlighted]:bg-sky-950 dark:data-[highlighted]:text-sky-100"
          >
            <SelectItemIndicator class="absolute left-2 inline-flex items-center">
              <span aria-hidden="true">✓</span>
            </SelectItemIndicator>
            <SelectItemText class="min-w-0 whitespace-normal break-words">
              {{ option.label }}
            </SelectItemText>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
