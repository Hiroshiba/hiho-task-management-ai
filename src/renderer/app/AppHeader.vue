<template>
  <header
    class="border-b border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
    aria-label="アプリケーションヘッダー"
  >
    <div class="mx-auto grid max-w-[1600px] grid-cols-1 items-start gap-3 px-4 py-3 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:gap-4 lg:px-6">
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
        class="flex min-w-0 max-w-full flex-wrap items-center justify-start gap-2 text-sm text-slate-700 dark:text-slate-300 lg:justify-center"
        role="group"
        aria-label="状態"
      >
        <slot name="status" />
      </div>
      <div
        class="flex min-w-0 max-w-full flex-wrap items-center justify-start gap-x-5 gap-y-3 lg:justify-end"
        role="group"
        aria-label="操作"
      >
        <slot name="actions" />
      </div>
    </div>
  </header>
</template>
