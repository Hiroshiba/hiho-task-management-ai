<script setup lang="ts">
import type { ProposalCodexState } from "./use-proposal-workspace";

defineProps<{
  configured: boolean;
  canOpenAiAssistant: boolean;
  aiWaitingCount: number;
  aiRunningCount: number;
  codexState: ProposalCodexState;
  codexAuthenticationBusy: boolean;
}>();

const emit = defineEmits<{
  (event: "open-ai-assistant"): void;
  (event: "complete-codex-authentication"): void;
}>();
</script>

<template>
  <div
    class="flex min-w-0 max-w-full flex-wrap items-center gap-3"
    role="group"
    aria-label="Codexの操作"
  >
    <button
      v-if="configured"
      type="button"
      class="secondary-button"
      :disabled="!canOpenAiAssistant"
      data-ai-assistant-trigger
      aria-label="AIアシスタントを開く"
      @click="emit('open-ai-assistant')"
    >
      AIアシスタント
      <span
        v-if="aiWaitingCount > 0 || aiRunningCount > 0"
        class="ml-2 text-xs font-normal"
      >
        対応待ち{{ aiWaitingCount }}件・実行中{{ aiRunningCount }}件
      </span>
    </button>
    <button
      v-if="codexState.kind === 'authentication_required'"
      type="button"
      class="primary-button"
      :disabled="codexAuthenticationBusy"
      aria-label="Codex認証を完了"
      @click="emit('complete-codex-authentication')"
    >
      Codex認証を完了
    </button>
  </div>
</template>
