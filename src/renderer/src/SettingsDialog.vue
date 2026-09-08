<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "reka-ui";
import type { ExternalAgentBridgeState } from "../../shared/external-agent";
import { vaultMappingSchema, type VaultMapping } from "../../shared/storage";
import type {
  AiSessionFeedback,
  RendererExternalAgentState,
} from "./state";

const props = defineProps<{
  open: boolean;
  state: RendererExternalAgentState;
  busy: boolean;
  restoreFocus: boolean;
  feedback?: AiSessionFeedback | undefined;
  vaultMappings: readonly VaultMapping[];
  vaultMappingsLoading: boolean;
  vaultBusy: boolean;
  vaultFeedback?: AiSessionFeedback | undefined;
  vaultSaveGeneration: number;
}>();

const emit = defineEmits<{
  (event: "set-enabled", enabled: boolean): void;
  (event: "save-vault-mapping", mapping: VaultMapping): void;
}>();

type VaultFormState =
  | { readonly kind: "closed" }
  | {
      readonly kind: "adding";
      readonly vaultId: string;
      readonly vaultPath: string;
      readonly dirty: boolean;
      readonly origin: "initial" | "manual";
    }
  | {
      readonly kind: "editing";
      readonly vaultId: string;
      readonly vaultPath: string;
      readonly dirty: boolean;
    };

const vaultForm = ref<VaultFormState>({ kind: "closed" });
const vaultLocalError = ref<string | undefined>();

const vaultOperationBusy = computed(() => props.busy || props.vaultBusy);
const vaultFormIsEditing = computed(() => vaultForm.value.kind === "editing");
const vaultFormTitle = computed(() => {
  if (vaultForm.value.kind === "editing") {
    return "Vaultのパスを変更";
  }
  return "Vaultを追加";
});
const vaultSubmitLabel = computed(() => {
  if (vaultOperationBusy.value) {
    return "保存中";
  }
  if (vaultForm.value.kind === "editing") {
    return "パスを更新";
  }
  return "Vaultを追加";
});
const vaultCanCancel = computed(() => {
  const form = vaultForm.value;
  return form.kind === "editing"
    || (form.kind === "adding" && props.vaultMappings.length > 0);
});

function assertNonNullable<T>(value: T | undefined, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}
function feedbackClass(kind: AiSessionFeedback["kind"]): string {
  switch (kind) {
    case "success":
      return "bg-emerald-50 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100";
    case "progress":
      return "bg-sky-50 text-sky-950 dark:bg-sky-950 dark:text-sky-100";
    case "warning":
      return "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100";
    case "failure":
      return "bg-rose-50 text-rose-900 dark:bg-rose-950 dark:text-rose-100";
  }
}

function feedbackRole(kind: AiSessionFeedback["kind"]): "status" | "alert" {
  switch (kind) {
    case "success":
    case "progress":
      return "status";
    case "warning":
    case "failure":
      return "alert";
  }
}

function bridgeLabel(bridge: ExternalAgentBridgeState): string {
  switch (bridge.kind) {
    case "stopped":
      return "停止中";
    case "running":
      return "稼働中";
    case "unavailable":
      return `利用不可・${bridge.message}`;
  }
}

function bridgeClass(bridge: ExternalAgentBridgeState): string {
  switch (bridge.kind) {
    case "stopped":
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-100";
    case "running":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "unavailable":
      return "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-100";
  }
}

function setEnabled(event: Event): void {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("外部連携の有効化入力が不正です。");
  }
  emit("set-enabled", input.checked);
}

function syncVaultForm(): void {
  const form = vaultForm.value;
  if (form.kind === "closed") {
    if (!props.vaultMappingsLoading && props.vaultMappings.length === 0) {
      vaultForm.value = {
        kind: "adding",
        vaultId: "tasks",
        vaultPath: "",
        dirty: false,
        origin: "initial",
      };
    }
    return;
  }
  if (form.dirty) {
    return;
  }
  if (form.kind === "adding") {
    if (form.origin === "initial" && props.vaultMappings.length > 0) {
      vaultForm.value = { kind: "closed" };
    }
    return;
  }
  const mapping = props.vaultMappings.find((candidate) => candidate.vault_id === form.vaultId);
  if (mapping == null) {
    vaultForm.value = { kind: "closed" };
    return;
  }
  vaultForm.value = {
    kind: "editing",
    vaultId: mapping.vault_id,
    vaultPath: mapping.absolute_path,
    dirty: false,
  };
}

function resetVaultForm(): void {
  vaultForm.value = { kind: "closed" };
  vaultLocalError.value = undefined;
  syncVaultForm();
}

function startVaultEdit(mapping: VaultMapping): void {
  if (vaultOperationBusy.value || props.vaultMappingsLoading) {
    return;
  }
  vaultForm.value = {
    kind: "editing",
    vaultId: mapping.vault_id,
    vaultPath: mapping.absolute_path,
    dirty: false,
  };
  vaultLocalError.value = undefined;
}

function startVaultAdd(): void {
  if (vaultOperationBusy.value || props.vaultMappingsLoading) {
    return;
  }
  vaultForm.value = {
    kind: "adding",
    vaultId: props.vaultMappings.length === 0 ? "tasks" : "",
    vaultPath: "",
    dirty: false,
    origin: "manual",
  };
  vaultLocalError.value = undefined;
}

function cancelVaultForm(): void {
  vaultForm.value = { kind: "closed" };
  vaultLocalError.value = undefined;
}

function inputValue(event: Event, message: string): string {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(message);
  }
  return input.value;
}

function updateVaultId(event: Event): void {
  const form = vaultForm.value;
  if (form.kind !== "adding") {
    throw new Error("編集中のVault IDを変更できません。");
  }
  vaultForm.value = {
    ...form,
    vaultId: inputValue(event, "Vault ID入力欄が見つかりません。"),
    dirty: true,
  };
  vaultLocalError.value = undefined;
}

function updateVaultPath(event: Event): void {
  const form = vaultForm.value;
  if (form.kind === "closed") {
    throw new Error("Vault設定フォームが開かれていません。");
  }
  vaultForm.value = {
    ...form,
    vaultPath: inputValue(event, "Vaultパス入力欄が見つかりません。"),
    dirty: true,
  };
  vaultLocalError.value = undefined;
}

function submitVault(): void {
  if (vaultOperationBusy.value || props.vaultMappingsLoading) {
    return;
  }
  const form = vaultForm.value;
  if (form.kind === "closed") {
    throw new Error("Vault設定フォームが開かれていません。");
  }
  vaultLocalError.value = undefined;
  const parsed = vaultMappingSchema.safeParse({
    vault_id: form.vaultId,
    absolute_path: form.vaultPath,
  });
  if (!parsed.success) {
    vaultLocalError.value = "Vault IDと絶対パスを確認してください。";
    return;
  }
  if (form.kind === "editing" && parsed.data.vault_id !== form.vaultId) {
    throw new Error("既存VaultのIDを変更できません。");
  }
  if (form.kind === "adding" && props.vaultMappings.some((mapping) => mapping.vault_id === parsed.data.vault_id)) {
    vaultLocalError.value = "このVault IDは登録済みです。「パスを変更」から既存のVaultを変更してください。";
    return;
  }
  emit("save-vault-mapping", parsed.data);
}

function preventClose(event: Event): void {
  if (props.busy || props.vaultBusy) {
    event.preventDefault();
  }
}

function handleCloseAutoFocus(event: Event): void {
  if (!props.restoreFocus) {
    event.preventDefault();
  }
}

watch(() => props.open, (open) => {
  if (open) {
    resetVaultForm();
    return;
  }
  vaultForm.value = { kind: "closed" };
  vaultLocalError.value = undefined;
});

watch([() => props.vaultMappings, () => props.vaultMappingsLoading], () => {
  if (props.open) {
    syncVaultForm();
  }
}, { deep: true });

watch(() => props.vaultSaveGeneration, () => {
  const form = vaultForm.value;
  if (form.kind === "closed") {
    return;
  }
  const mapping = props.vaultMappings.find((candidate) => candidate.vault_id === form.vaultId);
  assertNonNullable(mapping, "保存したVault設定が一覧にありません。");
  vaultForm.value = {
    kind: "editing",
    vaultId: mapping.vault_id,
    vaultPath: mapping.absolute_path,
    dirty: false,
  };
  vaultLocalError.value = undefined;
});
</script>

<template>
  <DialogPortal>
    <DialogOverlay class="fixed inset-0 bg-slate-950/50" />
    <DialogContent
      class="fixed left-1/2 top-1/2 flex max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 sm:max-h-[calc(100vh-3rem)] sm:w-[calc(100vw-3rem)]"
      @close-auto-focus="handleCloseAutoFocus"
      @escape-key-down="preventClose"
      @pointer-down-outside="preventClose"
    >
      <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 dark:border-slate-700 sm:px-6">
        <div class="min-w-0">
          <DialogTitle
            class="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            設定
          </DialogTitle>
          <DialogDescription class="sr-only">
            外部連携とObsidian Vaultの設定を管理します。
          </DialogDescription>
          <p
            v-if="props.feedback != null"
            class="mt-3 rounded-md px-3 py-2 text-sm"
            :class="feedbackClass(props.feedback.kind)"
            :role="feedbackRole(props.feedback.kind)"
          >
            {{ props.feedback.message }}
          </p>
        </div>
        <DialogClose
          type="button"
          class="secondary-button shrink-0"
          aria-label="設定を閉じる"
          :disabled="props.busy || props.vaultBusy"
        >
          閉じる
        </DialogClose>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <section
          v-if="props.state.kind === 'ready'"
          class="rounded-lg border border-slate-200 p-4 dark:border-slate-700"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
                外部連携
              </h2>
            </div>
            <span
              class="shrink-0 rounded-full px-2 py-1 text-xs"
              :class="bridgeClass(props.state.value.bridge)"
            >
              連携: {{ bridgeLabel(props.state.value.bridge) }}
            </span>
          </div>
          <label class="mt-4 flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300">
            <input
              type="checkbox"
              class="mt-0.5 size-4 shrink-0"
              :checked="props.state.value.enabled"
              :disabled="props.busy || props.vaultBusy"
              @change="setEnabled"
            >
            <span>
              外部連携を有効にする
              <span class="mt-1 block text-xs text-slate-600 dark:text-slate-400">
                外部からの一覧参照と新規タスク提案を受け付けます。
              </span>
            </span>
          </label>
          <details class="mt-4 rounded-md border border-slate-200 p-3 dark:border-slate-700">
            <summary class="cursor-pointer text-sm font-medium text-slate-800 dark:text-slate-100">
              連携登録の案内
            </summary>
            <div class="mt-3 space-y-3 text-sm text-slate-700 dark:text-slate-300">
              <p class="whitespace-pre-wrap break-words">
                {{ props.state.value.registration.instructions }}
              </p>
              <p>Codexを使うWSLまたはMacのターミナルで、次のコマンドを実行してください。</p>
              <div class="min-w-0">
                <p class="text-xs text-slate-600 dark:text-slate-400">
                  登録コマンド
                </p>
                <code class="mt-1 block overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{{ props.state.value.registration.command }}</code>
              </div>
              <div class="min-w-0">
                <p class="text-xs text-slate-600 dark:text-slate-400">
                  実行許可を設定するコマンド
                </p>
                <code class="mt-1 block overflow-x-auto rounded bg-slate-100 p-2 text-xs dark:bg-slate-800">{{ props.state.value.registration.allow_execution_command }}</code>
              </div>
              <p class="text-xs text-slate-600 dark:text-slate-400">
                固定ランチャーだけを許可し、登録後は外部Codexを再起動してください。
              </p>
            </div>
          </details>
        </section>
        <p
          v-else-if="props.state.kind === 'loading'"
          class="rounded-md bg-slate-100 px-4 py-3 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200"
          role="status"
        >
          外部連携の状態を読み込んでいます。
        </p>
        <p
          v-else
          class="rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-100"
          role="alert"
        >
          {{ props.state.message }}
        </p>

        <section class="mt-5 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
                Obsidian Vault
              </h2>
              <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Obsidianノートを参照するVaultの絶対パスを設定します。
              </p>
            </div>
          </div>

          <p
            v-if="props.vaultFeedback != null"
            class="mt-4 rounded-md px-3 py-2 text-sm"
            :class="feedbackClass(props.vaultFeedback.kind)"
            :role="feedbackRole(props.vaultFeedback.kind)"
          >
            {{ props.vaultFeedback.message }}
          </p>
          <p
            v-if="vaultLocalError != null"
            class="mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:bg-rose-950 dark:text-rose-100"
            role="alert"
          >
            {{ vaultLocalError }}
          </p>

          <p
            v-if="props.vaultMappingsLoading"
            class="mt-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            role="status"
          >
            Vault設定を読み込んでいます。
          </p>
          <template v-else>
            <ul
              v-if="props.vaultMappings.length > 0"
              class="mt-4 space-y-3"
            >
              <li
                v-for="mapping in props.vaultMappings"
                :key="mapping.vault_id"
                class="rounded-md border border-slate-200 p-3 dark:border-slate-700"
              >
                <dl class="grid min-w-0 gap-1 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-x-4">
                  <dt class="text-slate-600 dark:text-slate-400">
                    Vault ID
                  </dt>
                  <dd class="break-words text-slate-800 dark:text-slate-100">
                    {{ mapping.vault_id }}
                  </dd>
                  <dt class="text-slate-600 dark:text-slate-400">
                    絶対パス
                  </dt>
                  <dd class="break-all text-slate-800 dark:text-slate-100">
                    {{ mapping.absolute_path }}
                  </dd>
                </dl>
                <button
                  type="button"
                  class="secondary-button mt-3"
                  :disabled="vaultOperationBusy || props.vaultMappingsLoading"
                  @click="startVaultEdit(mapping)"
                >
                  パスを変更
                </button>
              </li>
            </ul>

            <button
              v-if="vaultForm.kind === 'closed' && props.vaultMappings.length > 0"
              type="button"
              class="secondary-button mt-4"
              :disabled="vaultOperationBusy || props.vaultMappingsLoading"
              @click="startVaultAdd"
            >
              Vaultを追加
            </button>

            <form
              v-if="vaultForm.kind !== 'closed'"
              class="mt-4 grid gap-4 sm:max-w-xl"
              @submit.prevent="submitVault"
            >
              <h3 class="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {{ vaultFormTitle }}
              </h3>
              <label
                class="field-label"
                for="settings-vault-id"
              >Vault ID<input
                id="settings-vault-id"
                :value="vaultForm.vaultId"
                class="text-input"
                autocomplete="off"
                :readonly="vaultFormIsEditing"
                :aria-readonly="vaultFormIsEditing"
                :disabled="vaultOperationBusy || props.vaultMappingsLoading"
                @input="updateVaultId"
              ></label>
              <label
                class="field-label"
                for="settings-vault-path"
              >Vaultの絶対パス<input
                id="settings-vault-path"
                :value="vaultForm.vaultPath"
                class="text-input"
                autocomplete="off"
                :disabled="vaultOperationBusy || props.vaultMappingsLoading"
                @input="updateVaultPath"
              ></label>
              <div class="flex flex-wrap gap-2">
                <button
                  type="submit"
                  class="primary-button"
                  :disabled="vaultOperationBusy || props.vaultMappingsLoading"
                >
                  {{ vaultSubmitLabel }}
                </button>
                <button
                  v-if="vaultCanCancel"
                  type="button"
                  class="secondary-button"
                  :disabled="vaultOperationBusy"
                  @click="cancelVaultForm"
                >
                  キャンセル
                </button>
              </div>
            </form>
          </template>
        </section>
      </div>
    </DialogContent>
  </DialogPortal>
</template>
