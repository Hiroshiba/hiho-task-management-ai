<script setup lang="ts">
import type { GithubStatusState } from "./use-github-integration";

defineProps<{ state: GithubStatusState }>();
</script>

<template>
  <section class="mt-5 rounded-lg border border-slate-200 p-4 dark:border-slate-700">
    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
      GitHub連携
    </h2>
    <p
      v-if="state.kind === 'loading'"
      class="mt-2 text-sm text-slate-700 dark:text-slate-300"
      role="status"
    >
      連携状態を確認しています。
    </p>
    <p
      v-else-if="state.kind === 'failure'"
      class="mt-2 text-sm text-rose-900 dark:text-rose-100"
      role="alert"
    >
      {{ state.message }}
    </p>
    <p
      v-else
      class="mt-2 text-sm text-slate-700 dark:text-slate-300"
      role="status"
    >
      GitHub連携は現在利用できません。
    </p>
  </section>
</template>
