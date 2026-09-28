<script setup lang="ts">
import { ref, watch } from "vue";
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "reka-ui";

const props = defineProps<{
  configured: boolean;
  canManualSync: boolean;
  canFullSync: boolean;
  fullSyncRunning: boolean;
}>();

const emit = defineEmits<{
  (event: "sync"): void;
  (event: "full-sync"): void;
}>();

const fullSyncConfirmationOpen = ref(false);

watch(() => props.configured && props.canFullSync, (available) => {
  if (!available) fullSyncConfirmationOpen.value = false;
});

function confirmFullSync(): void {
  if (!props.canFullSync) return;
  fullSyncConfirmationOpen.value = false;
  emit("full-sync");
}
</script>

<template>
  <button
    v-if="configured"
    type="button"
    class="secondary-button"
    :disabled="!canManualSync"
    aria-label="最新の変更を取得"
    @click="emit('sync')"
  >
    最新の変更を取得
  </button>
  <AlertDialogRoot v-model:open="fullSyncConfirmationOpen">
    <AlertDialogTrigger
      v-if="configured"
      type="button"
      class="secondary-button"
      :disabled="!canFullSync"
      aria-label="全データを再取得"
      title="Asanaから全タスクを取得して全データを再構築します"
    >
      {{ fullSyncRunning ? "全データを再取得中" : "全データを再取得" }}
    </AlertDialogTrigger>
    <AlertDialogPortal>
      <AlertDialogOverlay class="fixed inset-0 bg-slate-950/50" />
      <AlertDialogContent class="fixed left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <AlertDialogTitle class="text-lg font-semibold text-slate-900 dark:text-slate-100">
          全データ再取得の確認
        </AlertDialogTitle>
        <AlertDialogDescription class="mt-2 text-sm leading-6 text-slate-700 dark:text-slate-300">
          全タスク、順位、キャッシュを再構築し、必要に応じてAsana側を整合します。
        </AlertDialogDescription>
        <div class="mt-5 flex flex-wrap justify-end gap-3">
          <AlertDialogCancel class="text-button">
            やめる
          </AlertDialogCancel>
          <AlertDialogAction
            class="secondary-button"
            :disabled="!canFullSync"
            @click="confirmFullSync"
          >
            全データを再取得
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>
