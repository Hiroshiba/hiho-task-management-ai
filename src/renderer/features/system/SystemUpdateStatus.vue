<script setup lang="ts">
import type { SystemUpdateState } from "../../../shared/ipc-contracts/system";

defineProps<{
  state: SystemUpdateState;
}>();

function updateLabel(state: SystemUpdateState): string {
  switch (state.kind) {
    case "unavailable":
    case "idle":
      return "";
    case "checking":
      return "更新を確認中";
    case "current":
      return "最新版を使用中";
    case "downloading":
      return `更新版 ${state.version} を取得中 ${Math.round(state.percent)}%`;
    case "ready":
      return `更新版 ${state.version} を終了時に適用`;
    case "failed":
      switch (state.phase) {
        case "release_source":
          return "更新元の設定に不備";
        case "publisher_name":
          return "更新用の署名者名が未設定";
        case "check":
          return "更新の確認に失敗";
        case "download":
          return "更新版の取得に失敗";
        case "install":
          return "更新版の適用に失敗";
      }
  }
}

function updateClass(state: SystemUpdateState): string {
  return state.kind === "failed"
    ? "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100"
    : "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
}
</script>

<template>
  <span
    v-if="state.kind !== 'unavailable' && state.kind !== 'idle'"
    class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
    :class="updateClass(state)"
    role="status"
    aria-live="polite"
  >アプリ: {{ updateLabel(state) }}</span>
</template>
