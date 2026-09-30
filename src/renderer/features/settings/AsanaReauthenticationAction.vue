<script setup lang="ts">
import type { SettingsApi } from "../../../shared/ipc-contracts/settings";

type AuthenticationState = Extract<Awaited<ReturnType<SettingsApi["getAsanaAuthenticationState"]>>, { readonly kind: "ok" }>["value"];

const props = defineProps<{
  configured: boolean;
  authenticationRequired: boolean;
  state: AuthenticationState;
  busy: boolean;
  loaded: boolean;
  needsRecheck: boolean;
  requestBusy: boolean;
}>();

const emit = defineEmits<{
  (event: "begin-reauthentication"): void;
  (event: "recheck-authentication-state"): void;
}>();

function buttonLabel(state: AuthenticationState, busy: boolean, needsRecheck: boolean, requestBusy: boolean): string {
  if (needsRecheck) return busy || requestBusy ? "Asana認証状態を再確認中" : "Asana認証状態を再確認";
  switch (state.kind) {
    case "idle": return busy ? "再認証中" : "Asanaを再認証";
    case "opening": return "認証ページを開いています";
    case "authorization_pending": return "認証コード入力待ち";
    case "completing": return "認可コードを確認しています";
    case "synchronizing": return "Asana同期を再開しています";
  }
}

function act(): void {
  if (props.needsRecheck) {
    emit("recheck-authentication-state");
    return;
  }
  emit("begin-reauthentication");
}
</script>

<template>
  <button
    v-if="configured && (authenticationRequired || state.kind !== 'idle' || needsRecheck)"
    type="button"
    class="primary-button"
    :disabled="busy || requestBusy || (!needsRecheck && (!loaded || state.kind !== 'idle'))"
    :aria-label="needsRecheck ? 'Asana認証状態を再確認' : 'Asanaを再認証'"
    @click="act"
  >
    {{ buttonLabel(state, busy, needsRecheck, requestBusy) }}
  </button>
</template>
