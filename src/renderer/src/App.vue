<script setup lang="ts">
import { onMounted, ref } from "vue";

const version = ref("読み込み中");

onMounted(() => {
  void window.taskHub.app.getVersion().then(
    (appVersion) => {
      version.value = appVersion;
    },
    (error: unknown) => {
      console.error("アプリバージョンの取得に失敗しました。", error);
      version.value = "取得失敗";
    },
  );
});
</script>

<template>
  <main class="flex min-h-screen items-center justify-center p-8">
    <section class="w-full max-w-xl rounded-2xl bg-white p-10 shadow-sm">
      <p class="text-sm font-semibold tracking-wide text-sky-700">
        TASKHUB
      </p>
      <h1 class="mt-3 text-3xl font-bold tracking-tight">
        Asanaタスク管理
      </h1>
      <p class="mt-4 text-slate-600">
        安全なElectron基盤が起動しました。
      </p>
      <p class="mt-8 text-sm text-slate-500">
        アプリバージョン: {{ version }}
      </p>
    </section>
  </main>
</template>
