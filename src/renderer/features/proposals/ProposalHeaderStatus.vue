<script setup lang="ts">
import type { ProposalCodexState } from "./use-proposal-workspace";

defineProps<{ codexState: ProposalCodexState }>();

function codexUnavailableLabel(reasonCode: Extract<ProposalCodexState, { readonly kind: "unavailable" }>["reason_code"]): string {
  switch (reasonCode) {
    case "not_installed": return "未インストール";
    case "incompatible": return "非対応バージョン";
    case "permission_denied": return "権限不足";
    case "startup_failed": return "起動失敗";
    case "disabled": return "安全要件により無効";
    case "stopped": return "停止済み";
  }
}

function codexLabel(state: ProposalCodexState): string {
  switch (state.kind) {
    case "connecting": return "接続中";
    case "ready": return "利用可能";
    case "authentication_required": return "認証が必要です";
    case "unavailable": return `利用不可・${codexUnavailableLabel(state.reason_code)}`;
  }
}

function codexClass(state: ProposalCodexState): string {
  switch (state.kind) {
    case "connecting": return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-100";
    case "ready": return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "authentication_required": return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "unavailable": return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
  }
}
</script>

<template>
  <span
    v-if="codexState.kind === 'authentication_required' || codexState.kind === 'unavailable'"
    class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
    :class="codexClass(codexState)"
  >Codex: {{ codexLabel(codexState) }}</span>
</template>
