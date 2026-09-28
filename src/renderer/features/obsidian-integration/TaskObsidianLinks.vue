<script setup lang="ts">
import type { z } from "zod";
import { obsidianLinkSchema } from "../../../shared/ipc-contracts/task-values";

type ObsidianLink = z.infer<typeof obsidianLinkSchema>;
const props = defineProps<{
  taskGid: string;
  links: readonly ObsidianLink[];
  vaultIds: readonly string[];
  statuses: ReadonlyMap<string, "exists" | "missing" | "unavailable">;
  readAvailable: boolean;
  canWrite: boolean;
  canReanalyze: boolean;
}>();
const emit = defineEmits<{
  (event: "check", link: ObsidianLink): void;
  (event: "open", link: ObsidianLink): void;
  (event: "unlink", link: ObsidianLink): void;
  (event: "reanalyze", taskGid: string): void;
}>();

function statusForLink(link: ObsidianLink): string {
  const status = props.statuses.get(`${link.vault_id}\0${link.path}`);
  if (status === "exists") return "確認済み";
  if (status === "missing") return "見つかりません";
  if (status === "unavailable") return "この端末では利用できません";
  return "未確認";
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return "高信頼";
  if (confidence >= 0.6) return "中信頼";
  return "低信頼";
}

function confidenceReason(confidence: number): string {
  return `保存された信頼度 ${confidence.toFixed(2)} に基づく関連付け`;
}

function isRegisteredVault(link: ObsidianLink): boolean {
  return props.vaultIds.includes(link.vault_id);
}
</script>

<template>
  <details class="min-w-0 border-t border-slate-200 pt-5 dark:border-slate-700">
    <summary
      class="cursor-pointer rounded-md px-3 py-3 text-sm font-medium text-slate-800 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
    >
      <span>関連ノート</span>
      <span class="ml-2 text-xs font-normal text-slate-500 dark:text-slate-400">
        {{ props.links.length }}件
      </span>
    </summary>
    <div class="mt-4 min-w-0">
      <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p class="text-sm text-slate-600 dark:text-slate-400">
          関連付け済みのノート
        </p>
        <button
          type="button"
          class="secondary-button"
          :disabled="!props.canReanalyze"
          @click="emit('reanalyze', props.taskGid)"
        >
          関連ノートを再解析
        </button>
      </div>
      <ul class="mt-3 min-w-0 space-y-2 text-sm text-slate-600 dark:text-slate-400">
        <li
          v-for="link in props.links"
          :key="`${link.vault_id}-${link.path}`"
          class="flex min-w-0 flex-col gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-700"
        >
          <div class="min-w-0 flex-1">
            <p class="break-words font-medium text-slate-800 dark:text-slate-100">
              {{ link.title }}・{{ statusForLink(link) }}
            </p>
            <p class="mt-1 break-words text-xs text-slate-500 dark:text-slate-400">
              {{ link.path }}
            </p>
            <details class="mt-2 min-w-0">
              <summary
                class="cursor-pointer rounded-md px-2 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-600 focus:ring-offset-2 dark:text-slate-100 dark:hover:bg-slate-700 dark:focus:ring-sky-400 dark:focus:ring-offset-slate-950"
              >
                リンクの詳細
              </summary>
              <div class="mt-2 min-w-0 space-y-1 border-l border-slate-200 pl-3 text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                <p class="break-words">
                  Vaultの識別子: {{ link.vault_id }}
                </p>
                <p class="break-words">
                  {{ confidenceLabel(link.confidence) }}・{{ confidenceReason(link.confidence) }}
                </p>
              </div>
            </details>
          </div>
          <span class="flex min-w-0 flex-wrap gap-2">
            <button
              type="button"
              class="text-button"
              :disabled="!props.readAvailable || !isRegisteredVault(link)"
              @click="emit('check', link)"
            >ファイルを確認</button>
            <button
              type="button"
              class="text-button"
              :disabled="!props.readAvailable || !isRegisteredVault(link)"
              @click="emit('open', link)"
            >ノートを開く</button>
            <button
              type="button"
              class="text-button"
              :disabled="!props.canWrite"
              @click="emit('unlink', link)"
            >リンクを解除</button>
          </span>
        </li>
        <li v-if="props.links.length === 0">
          なし
        </li>
      </ul>
    </div>
  </details>
</template>
