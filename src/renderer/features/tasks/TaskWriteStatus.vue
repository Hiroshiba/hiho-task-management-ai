<script setup lang="ts">
defineProps<{ canWrite: boolean }>();
</script>

<template>
  <span
    v-if="!canWrite"
    class="max-w-full whitespace-normal break-words rounded-full bg-amber-100 px-3 py-1 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
  >読み取り専用</span>
</template>
