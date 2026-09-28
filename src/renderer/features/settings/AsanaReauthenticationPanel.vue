<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { SettingsApi } from "../../../shared/ipc-contracts/settings";

type AuthenticationState = Extract<Awaited<ReturnType<SettingsApi["getAsanaAuthenticationState"]>>, { readonly kind: "ok" }>["value"];

const props = defineProps<{
  state: AuthenticationState;
  busy: boolean;
  needsRecheck: boolean;
  requestBusy: boolean;
}>();

const emit = defineEmits<{
  (event: "complete", code: string): void;
  (event: "cancel"): void;
}>();

const codeInput = ref<HTMLInputElement>();

function clearCode(): void {
  if (codeInput.value != null) {
    codeInput.value.value = "";
  }
}

function complete(): void {
  const input = codeInput.value;
  if (input == null) {
    throw new Error("Asana認可コード入力欄がありません。");
  }
  const code = input.value;
  clearCode();
  emit("complete", code);
}

function cancel(): void {
  clearCode();
  emit("cancel");
}

watch(() => props.state, clearCode);
onBeforeUnmount(clearCode);
</script>

<template>
  <section
    v-if="props.state.kind === 'opening' || props.state.kind === 'completing' || props.state.kind === 'synchronizing'"
    class="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
    role="status"
    aria-live="polite"
  >
    <p v-if="props.state.kind === 'opening'">
      認証ページを開いています
    </p>
    <p v-else-if="props.state.kind === 'completing'">
      認可コードを確認しています
    </p>
    <p v-else>
      Asana同期を再開しています
    </p>
  </section>
  <section
    v-else-if="props.state.kind === 'authorization_pending'"
    class="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
    aria-labelledby="asana-reauthentication-title"
  >
    <h2
      id="asana-reauthentication-title"
      class="text-lg font-semibold text-amber-950 dark:text-amber-100"
    >
      Asana認証コードを入力してください
    </h2>
    <p class="mt-2 text-sm text-amber-950 dark:text-amber-100">
      Asanaの認証後に表示された認可コードを貼り付けてください。
    </p>
    <form
      class="mt-3 flex flex-wrap items-end gap-2"
      @submit.prevent="complete"
    >
      <label class="w-full min-w-0 max-w-xl flex-1 text-sm font-medium text-amber-950 dark:text-amber-100">
        認可コード
        <input
          ref="codeInput"
          type="text"
          autocomplete="off"
          class="mt-1 block w-full rounded-md border border-amber-300 bg-white px-3 py-2 text-slate-900 shadow-sm focus:border-sky-600 focus:outline-none focus:ring-2 focus:ring-sky-600 dark:border-amber-800 dark:bg-slate-800 dark:text-slate-100 dark:placeholder:text-slate-400 dark:focus:border-sky-400 dark:focus:ring-sky-400"
        >
      </label>
      <button
        type="submit"
        class="rounded-md bg-amber-700 px-3 py-2 text-sm font-medium text-white hover:bg-amber-800 focus:outline-none focus:ring-2 focus:ring-amber-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-amber-800 dark:text-amber-100 dark:hover:bg-amber-700 dark:focus:ring-amber-400 dark:focus:ring-offset-slate-950 dark:disabled:bg-slate-700 dark:disabled:text-slate-400"
        :disabled="props.busy || props.needsRecheck || props.requestBusy"
      >
        {{ props.busy ? "確認中" : "認証を確定" }}
      </button>
      <button
        type="button"
        class="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950 dark:disabled:border-slate-700 dark:disabled:bg-slate-900 dark:disabled:text-slate-400"
        :disabled="props.busy || props.needsRecheck || props.requestBusy"
        @click="cancel"
      >
        キャンセル
      </button>
    </form>
  </section>
</template>
