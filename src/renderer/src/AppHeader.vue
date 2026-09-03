<script setup lang="ts">
import { ref, watch } from "vue";
import type { IpcAsanaAuthenticationState } from "../../shared/ipc";
import type {
  RendererCodexState,
  RendererConnectionState,
  RendererSyncState,
} from "./state";

const props = defineProps<{
  connectionState: RendererConnectionState;
  configured: boolean;
  canManualSync: boolean;
  canFullSync: boolean;
  fullSyncRunning: boolean;
  canWrite: boolean;
  codexState: RendererCodexState;
  codexAuthenticationBusy: boolean;
  asanaAuthenticationBusy: boolean;
  asanaAuthenticationStateLoaded: boolean;
  asanaAuthenticationStateNeedsRecheck: boolean;
  asanaAuthenticationStateRequestBusy: boolean;
  asanaAuthenticationState: IpcAsanaAuthenticationState;
}>();

const emit = defineEmits<{
  (event: "sync"): void;
  (event: "full-sync"): void;
  (event: "complete-codex-authentication"): void;
  (event: "begin-reauthentication"): void;
  (event: "recheck-authentication-state"): void;
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

function shouldShowSyncState(state: RendererSyncState): boolean {
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

function syncClass(state: RendererSyncState): string {
  switch (state.kind) {
    case "waiting":
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
    case "syncing":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-100";
    case "synced":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "authentication_required":
    case "recovery_pending":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "error":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
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

function shouldShowNetworkState(state: RendererConnectionState): boolean {
  switch (state.kind) {
    case "offline":
      return true;
    case "checking":
    case "online":
      return false;
  }
}

function networkClass(state: RendererConnectionState): string {
  switch (state.kind) {
    case "checking":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-100";
    case "online":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "offline":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
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
      return "利用可能";
    case "authentication_required":
      return "認証が必要です";
    case "unavailable":
      return `利用不可・${codexUnavailableLabel(state.reason_code)}`;
  }
}

function shouldShowCodexState(state: RendererCodexState): boolean {
  switch (state.kind) {
    case "authentication_required":
    case "unavailable":
      return true;
    case "connecting":
    case "ready":
      return false;
  }
}

function codexClass(state: RendererCodexState): string {
  switch (state.kind) {
    case "connecting":
      return "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-100";
    case "ready":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "authentication_required":
      return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "unavailable":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
  }
}

function asanaAuthenticationButtonLabel(
  state: IpcAsanaAuthenticationState,
  busy: boolean,
  needsRecheck: boolean,
  requestBusy: boolean,
): string {
  if (needsRecheck) {
    return busy || requestBusy
      ? "Asana認証状態を再確認中"
      : "Asana認証状態を再確認";
  }
  switch (state.kind) {
    case "idle":
      return busy ? "再認証中" : "Asanaを再認証";
    case "opening":
      return "認証ページを開いています";
    case "authorization_pending":
      return "認証コード入力待ち";
    case "completing":
      return "認可コードを確認しています";
    case "synchronizing":
      return "Asana同期を再開しています";
  }
}

function handleAsanaAuthenticationAction(): void {
  if (props.asanaAuthenticationStateNeedsRecheck) {
    emit("recheck-authentication-state");
    return;
  }
  emit("begin-reauthentication");
}

</script>

<template>
  <header
    class="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
    aria-label="アプリケーションヘッダー"
  >
    <div class="mx-auto grid max-w-[1600px] grid-cols-1 items-start gap-3 px-4 py-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:px-6 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:gap-4">
      <div
        class="flex min-w-0 max-w-full flex-col px-1 py-1"
        role="group"
        aria-label="ブランド"
      >
        <h1 class="text-lg font-semibold text-slate-900 dark:text-slate-100">
          タスクハブ
        </h1>
      </div>
      <div
        class="flex min-w-0 max-w-full flex-wrap items-center justify-start gap-2 text-sm text-slate-700 dark:text-slate-300 xl:justify-center"
        role="group"
        aria-label="状態"
      >
        <span
          v-if="shouldShowSyncState(connectionState.sync)"
          class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
          :class="syncClass(connectionState.sync)"
          aria-live="polite"
          aria-atomic="true"
        >同期: {{ syncLabel(connectionState.sync) }}</span>
        <span
          v-if="shouldShowNetworkState(connectionState)"
          class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
          :class="networkClass(connectionState)"
        >
          ネットワーク: {{ networkLabel(connectionState) }}
        </span>
        <span
          v-if="shouldShowCodexState(codexState)"
          class="max-w-full whitespace-normal break-words rounded-full px-3 py-1"
          :class="codexClass(codexState)"
        >Codex: {{ codexLabel(codexState) }}</span>
        <span
          v-if="!canWrite"
          class="max-w-full whitespace-normal break-words rounded-full bg-amber-100 px-3 py-1 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
        >読み取り専用</span>
      </div>
      <div
        class="flex min-w-0 max-w-full flex-wrap items-center justify-start gap-x-5 gap-y-3 lg:col-span-2 xl:col-span-1 xl:justify-end"
        role="group"
        aria-label="操作"
      >
        <div
          class="flex min-w-0 max-w-full flex-wrap items-center gap-3"
          role="group"
          aria-label="Asanaと同期の操作"
        >
          <button
            v-if="configured && (connectionState.sync.kind === 'authentication_required' || asanaAuthenticationState.kind !== 'idle' || asanaAuthenticationStateNeedsRecheck)"
            type="button"
            class="primary-button"
            :disabled="asanaAuthenticationBusy || asanaAuthenticationStateRequestBusy || (!asanaAuthenticationStateNeedsRecheck && (!asanaAuthenticationStateLoaded || asanaAuthenticationState.kind !== 'idle'))"
            :aria-label="asanaAuthenticationStateNeedsRecheck ? 'Asana認証状態を再確認' : 'Asanaを再認証'"
            @click="handleAsanaAuthenticationAction"
          >
            {{ asanaAuthenticationButtonLabel(asanaAuthenticationState, asanaAuthenticationBusy, asanaAuthenticationStateNeedsRecheck, asanaAuthenticationStateRequestBusy) }}
          </button>
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
          <button
            v-if="configured && !fullSyncConfirmationOpen"
            type="button"
            class="secondary-button"
            :disabled="!canFullSync"
            aria-label="全データを再取得"
            title="Asanaから全タスクを取得して全データを再構築します"
            @click="requestFullSyncConfirmation"
          >
            {{ fullSyncRunning ? "全データを再取得中" : "全データを再取得" }}
          </button>
        </div>
        <div
          class="flex min-w-0 max-w-full flex-wrap items-center gap-3"
          role="group"
          aria-label="Codexの操作"
        >
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
      </div>
      <div
        v-if="configured && fullSyncConfirmationOpen"
        class="flex min-w-0 max-w-full flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100 lg:col-span-2 xl:col-span-3"
        role="group"
        aria-label="全データ再取得の確認"
      >
        <span>全タスク、順位、キャッシュを再構築し、必要に応じてAsana側を整合します。</span>
        <button
          type="button"
          class="secondary-button"
          :disabled="!canFullSync"
          @click="confirmFullSync"
        >
          全データを再取得
        </button>
        <button
          type="button"
          class="text-button"
          @click="cancelFullSync"
        >
          やめる
        </button>
      </div>
    </div>
  </header>
</template>
