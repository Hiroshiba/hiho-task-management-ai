<script setup lang="ts">
import {
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
} from "reka-ui";
import { useToast, type ToastKind } from "./useToast";

const { messages, dismissToast } = useToast();

function toastTitle(kind: ToastKind): string {
  switch (kind) {
    case "success":
      return "完了";
    case "warning":
      return "お知らせ";
  }
}

function toastClass(kind: ToastKind): string {
  switch (kind) {
    case "success":
      return "border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100";
  }
}

function handleOpenChange(id: number, open: boolean): void {
  if (!open) {
    dismissToast(id);
  }
}
</script>

<template>
  <ToastProvider
    label="通知"
    :duration="5000"
  >
    <ToastRoot
      v-for="toast in messages"
      :key="toast.id"
      open
      type="foreground"
      class="pointer-events-auto flex items-start justify-between gap-4 rounded-lg border px-4 py-3 text-sm shadow-lg"
      :class="toastClass(toast.kind)"
      @update:open="handleOpenChange(toast.id, $event)"
    >
      <div class="min-w-0">
        <ToastTitle class="font-semibold">
          {{ toastTitle(toast.kind) }}
        </ToastTitle>
        <ToastDescription class="mt-1 break-words">
          {{ toast.message }}
        </ToastDescription>
      </div>
      <ToastClose
        class="shrink-0 rounded px-2 py-1 text-xs font-medium underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-current"
        aria-label="通知を閉じる"
      >
        閉じる
      </ToastClose>
    </ToastRoot>
    <ToastViewport
      label="通知一覧。F8キーで移動できます"
      :hotkey="['F8']"
      class="pointer-events-none fixed inset-x-4 top-4 mx-auto flex max-w-md flex-col gap-2 sm:left-auto sm:right-4 sm:mx-0 sm:w-96"
    />
  </ToastProvider>
</template>
