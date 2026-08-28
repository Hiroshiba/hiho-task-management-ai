<script setup lang="ts">
import { ref, watch } from "vue";
import { isoDateTimeSchema } from "../../shared/domain";
import type {
  RendererCodexState,
  RendererConnectionState,
  RendererSyncState,
} from "./state";

const props = defineProps<{
  connectionState: RendererConnectionState;
  lastSyncAt: string | undefined;
  configured: boolean;
  canManualSync: boolean;
  canFullSync: boolean;
  fullSyncRunning: boolean;
  canWrite: boolean;
  codexState: RendererCodexState;
  codexAuthenticationBusy: boolean;
  asanaAuthenticationBusy: boolean;
  appVersion: string;
  cleanupCount: number;
}>();

const emit = defineEmits<{
  (event: "sync"): void;
  (event: "full-sync"): void;
  (event: "new-ai-session"): void;
  (event: "complete-codex-authentication"): void;
  (event: "reauthenticate-asana"): void;
}>();

const fullSyncConfirmationOpen = ref(false);

watch(() => props.configured && props.canFullSync, (available) => {
  if (!available) {
    fullSyncConfirmationOpen.value = false;
  }
});

function requestFullSyncConfirmation(): void {
  if (!props.canFullSync) {
    return;
  }
  fullSyncConfirmationOpen.value = true;
}

function cancelFullSync(): void {
  fullSyncConfirmationOpen.value = false;
}

function confirmFullSync(): void {
  if (!props.canFullSync) {
    return;
  }
  fullSyncConfirmationOpen.value = false;
  emit("full-sync");
}

function syncLabel(state: RendererSyncState): string {
  switch (state.kind) {
    case "waiting":
      return "待機中";
    case "syncing":
      return "同期中";
    case "synced":
      return "同期済み";
    case "authentication_required":
      return "Asana認証が必要";
    case "recovery_pending":
      return "復旧待ち";
    case "error":
      return syncErrorLabel(state.error_code);
  }
}

function syncErrorLabel(
  errorCode: Extract<RendererSyncState, { readonly kind: "error" }>["error_code"],
): string {
  switch (errorCode) {
    case "payment_required":
      return "Asanaプラン要確認";
    case "rate_limited":
      return "再試行待ち";
    case "http_error":
      return "Asana応答エラー";
    case "transport_error":
      return "通信失敗";
    case "response_error":
      return "Asana応答不正";
    case "request_aborted":
      return "同期中断";
    case "sync_in_progress":
      return "別の同期を実行中";
    case "unexpected_error":
      return "同期失敗";
  }
}

function networkLabel(state: RendererConnectionState): string {
  switch (state.kind) {
    case "checking":
      return "確認中";
    case "online":
      return "オンライン";
    case "offline":
      return "オフライン";
  }
}

function networkClass(state: RendererConnectionState): string {
  switch (state.kind) {
    case "checking":
      return "bg-slate-100 text-slate-700";
    case "online":
      return "bg-emerald-100 text-emerald-800";
    case "offline":
      return "bg-amber-100 text-amber-900";
  }
}

function codexUnavailableLabel(
  reasonCode: Extract<RendererCodexState, { readonly kind: "unavailable" }>["reason_code"],
): string {
  switch (reasonCode) {
    case "not_installed":
      return "未インストール";
    case "incompatible":
      return "非対応バージョン";
    case "permission_denied":
      return "権限不足";
    case "startup_failed":
      return "起動失敗";
    case "disabled":
      return "安全要件により無効";
    case "stopped":
      return "停止済み";
  }
}

function codexLabel(state: RendererCodexState): string {
  switch (state.kind) {
    case "connecting":
      return "接続中";
    case "ready":
      return `利用可能 ${state.version}`;
    case "authentication_required":
      return "認証が必要です";
    case "unavailable":
      return `利用不可・${codexUnavailableLabel(state.reason_code)}`;
  }
}

function jstDateTimeLabel(value: string | undefined): string {
  if (value == null) {
    return "未同期";
  }
  const validated = isoDateTimeSchema.parse(value);
  const timestamp = Date.parse(validated);
  if (!Number.isFinite(timestamp)) {
    throw new Error("最終同期日時を表示できません。");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}
</script>

<template>
  <header
    class="border-b border-slate-200 bg-white"
    aria-label="アプリケーションヘッダー"
  >
    <div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 lg:px-6">
      <div class="mr-auto min-w-[12rem]">
        <p class="text-xs font-semibold tracking-[0.18em] text-sky-700">
          TASKHUB
        </p>
        <h1 class="text-lg font-semibold text-slate-900">
          Asanaタスク管理
        </h1>
      </div>
      <div
        class="flex flex-wrap items-center gap-2 text-sm text-slate-700"
        aria-live="polite"
      >
        <span class="rounded-full bg-slate-100 px-3 py-1">同期: {{ syncLabel(connectionState.sync) }}</span>
        <span class="rounded-full bg-slate-100 px-3 py-1">
          最終同期: {{ jstDateTimeLabel(lastSyncAt) }}
        </span>
        <span
          class="rounded-full px-3 py-1"
          :class="networkClass(connectionState)"
        >
          ネットワーク: {{ networkLabel(connectionState) }}
        </span>
        <span class="rounded-full bg-slate-100 px-3 py-1">Codex: {{ codexLabel(codexState) }}</span>
        <span class="rounded-full bg-slate-100 px-3 py-1">編集: {{ canWrite ? "可能" : "読み取り専用" }}</span>
        <span class="rounded-full bg-slate-100 px-3 py-1">要整理: {{ cleanupCount }}件</span>
      </div>
      <div class="flex items-center gap-2">
        <button
          v-if="configured && connectionState.sync.kind === 'authentication_required'"
          type="button"
          class="rounded-md bg-amber-700 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="asanaAuthenticationBusy"
          aria-label="Asanaを再認証"
          @click="emit('reauthenticate-asana')"
        >
          {{ asanaAuthenticationBusy ? "再認証中" : "Asanaを再認証" }}
        </button>
        <button
          v-if="configured"
          type="button"
          class="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canManualSync"
          aria-label="手動同期を実行"
          @click="emit('sync')"
        >
          手動同期
        </button>
        <button
          v-if="configured && !fullSyncConfirmationOpen"
          type="button"
          class="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-950 hover:bg-amber-100 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canFullSync"
          aria-label="キャッシュを再構築する完全同期を確認"
          title="Asanaから全件を取得してローカルキャッシュを再構築します"
          @click="requestFullSyncConfirmation"
        >
          {{ fullSyncRunning ? "再構築中" : "キャッシュを再構築" }}
        </button>
        <div
          v-else-if="configured"
          class="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950"
          role="group"
          aria-label="完全同期の確認"
        >
          <span>Asanaから全件を取得します。</span>
          <button
            type="button"
            class="rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canFullSync"
            @click="confirmFullSync"
          >
            完全同期を実行
          </button>
          <button
            type="button"
            class="rounded-md border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2"
            @click="cancelFullSync"
          >
            やめる
          </button>
        </div>
        <button
          v-if="codexState.kind === 'authentication_required'"
          type="button"
          class="rounded-md bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="codexAuthenticationBusy"
          aria-label="Codex認証を完了"
          @click="emit('complete-codex-authentication')"
        >
          Codex認証を完了
        </button>
        <button
          v-else-if="codexState.kind === 'ready'"
          type="button"
          class="rounded-md bg-sky-700 px-3 py-2 text-sm font-medium text-white hover:bg-sky-800 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canWrite"
          aria-label="新しいAIセッションを開始"
          @click="emit('new-ai-session')"
        >
          新しいAIセッション
        </button>
      </div>
      <p class="w-full text-xs text-slate-500 lg:w-auto">
        アプリ {{ appVersion }}
      </p>
    </div>
  </header>
</template>
