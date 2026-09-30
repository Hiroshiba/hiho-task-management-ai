<script setup lang="ts">
import { DialogTrigger } from "reka-ui";

defineProps<{ configured: boolean }>();
</script>

<template>
  <div
    class="flex min-w-0 max-w-full flex-wrap items-center gap-3"
    role="group"
    aria-label="アプリケーションの設定"
  >
    <DialogTrigger
      v-if="configured"
      as-child
    >
      <button
        type="button"
        class="secondary-button"
        aria-label="設定を開く"
      >
        設定
      </button>
    </DialogTrigger>
  </div>
</template>
