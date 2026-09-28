<script setup lang="ts">
import type { TaskConnectionState, TaskSyncState } from "./use-task-sync";

defineProps<{
  connectionState: TaskConnectionState;
}>();

function syncLabel(state: TaskSyncState): string {
  switch (state.kind) {
    case "waiting": return "待機中";
    case "syncing": return "同期中";
    case "synced": return "同期済み";
    case "authentication_required": return "Asana認証が必要";
    case "recovery_pending": return "復旧待ち";
    case "error": return syncErrorLabel(state.error_code);
  }
}

function shouldShowSyncState(state: TaskSyncState): boolean {
  switch (state.kind) {
    case "waiting":
    case "syncing":
    case "authentication_required":
    case "recovery_pending":
    case "error":
      return true;
    case "synced":
      return false;
  }
}

function syncErrorLabel(errorCode: Extract<TaskSyncState, { readonly kind: "error" }>["error_code"]): string {
  switch (errorCode) {
    case "payment_required": return "Asanaプラン要確認";
    case "rate_limited": return "再試行待ち";
    case "http_error": return "Asana応答エラー";
    case "transport_error": return "通信失敗";
    case "response_error": return "Asana応答不正";
    case "request_aborted": return "同期中断";
    case "sync_in_progress": return "別の同期を実行中";
    case "unexpected_error": return "同期失敗";
  }
}

function syncClass(state: TaskSyncState): string {
  switch (state.kind) {
    case "waiting": return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
    case "syncing": return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-100";
    case "synced": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "authentication_required":
    case "recovery_pending":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "error": return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
  }
}

function networkLabel(state: TaskConnectionState): string {
  switch (state.kind) {
    case "checking": return "確認中";
    case "online": return "オンライン";
    case "offline": return "オフライン";
  }
}

function networkClass(state: TaskConnectionState): string {
  switch (state.kind) {
    case "checking": return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-100";
    case "online": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "offline": return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
  }
}
</script>

<template>
  <span
    v-if="shouldShowSyncState(connectionState.sync)"
    class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
    :class="syncClass(connectionState.sync)"
    aria-live="polite"
    aria-atomic="true"
  >同期: {{ syncLabel(connectionState.sync) }}</span>
  <span
    v-if="connectionState.kind === 'offline'"
    class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
    :class="networkClass(connectionState)"
  >ネットワーク: {{ networkLabel(connectionState) }}</span>
</template>
