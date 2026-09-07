<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "reka-ui";
import type { ExternalAgentBridgeState } from "../../shared/external-agent";
import type {
  AiSessionFeedback,
  RendererExternalAgentState,
} from "./state";

const props = defineProps<{
  state: RendererExternalAgentState;
  busy: boolean;
  feedback?: AiSessionFeedback | undefined;
}>();

const emit = defineEmits<{
  (event: "set-enabled", enabled: boolean): void;
}>();

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
</script>

<template>
  <DialogPortal>
    <DialogOverlay class="fixed inset-0 bg-slate-950/50" />
    <DialogContent
      class="fixed left-1/2 top-1/2 flex max-h-[calc(100vh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900 sm:max-h-[calc(100vh-3rem)] sm:w-[calc(100vw-3rem)]"
    >
      <header class="flex items-start justify-between gap-4 border-b border-slate-200 px-4 py-4 dark:border-slate-700 sm:px-6">
        <div class="min-w-0">
          <DialogTitle
            class="text-lg font-semibold text-slate-900 dark:text-slate-100"
          >
            設定
          </DialogTitle>
          <DialogDescription class="sr-only">
            外部連携の設定を管理します。
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
              :disabled="props.busy"
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
      </div>
    </DialogContent>
  </DialogPortal>
</template>
