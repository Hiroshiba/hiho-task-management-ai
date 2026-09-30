<script setup lang="ts">
import type { CreateTaskOperation, FormState, ProposalTarget, TargetOption } from "./proposal-editor-form";
import { durationMinimum, durationUnitOptions } from "./proposal-presentation";
import ProposalDependenciesEditor from "./ProposalDependenciesEditor.vue";

const form = defineModel<FormState>("form", { required: true });
const props = defineProps<{
  operation: CreateTaskOperation;
  targetOptions: readonly TargetOption[];
  disabled: boolean;
  targetLabel: (target: ProposalTarget) => string;
  changeDueKind: () => void;
  addDependency: () => void;
  removeDependency: (id: number) => void;
  addObsidianLink: () => void;
  removeObsidianLink: (id: number) => void;
}>();
</script>

<template>
  <div
    class="create-task-fields grid min-w-0 gap-4 sm:grid-cols-2"
  >
    <label class="field-label sm:col-span-2">
      タイトル
      <input
        v-model="form.title"
        class="text-input"
        type="text"
        required
        :disabled="props.disabled"
      >
    </label>
    <fieldset class="field-group sm:col-span-2">
      <legend class="field-label">
        説明
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.notesSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        説明を指定する
      </label>
      <textarea
        v-model="form.notes"
        class="text-input min-h-28"
        aria-label="説明"
        :disabled="props.disabled || !form.notesSpecified"
      />
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-label">
        状態
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.statusSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        状態を指定する
      </label>
      <select
        v-model="form.status"
        class="text-input"
        aria-label="状態"
        :disabled="props.disabled || !form.statusSpecified"
      >
        <option value="not_started">
          未着手
        </option>
        <option value="in_progress">
          進行中
        </option>
      </select>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-label">
        重要度
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.importanceSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        重要度を指定する
      </label>
      <select
        v-model.number="form.importance"
        class="text-input"
        aria-label="重要度"
        :disabled="props.disabled || !form.importanceSpecified"
      >
        <option :value="1">
          1
        </option>
        <option :value="2">
          2
        </option>
        <option :value="3">
          3
        </option>
        <option :value="4">
          4
        </option>
        <option :value="5">
          5
        </option>
      </select>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-label">
        領域
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.areaSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        領域を指定する
      </label>
      <input
        v-model="form.area"
        class="text-input"
        type="text"
        aria-label="領域"
        :required="form.areaSpecified"
        :disabled="props.disabled || !form.areaSpecified"
      >
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-label">
        期限
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.dueSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        期限を指定する
      </label>
      <select
        v-model="form.dueKind"
        class="text-input"
        aria-label="期限の種類"
        :disabled="props.disabled || !form.dueSpecified"
        @change="props.changeDueKind"
      >
        <option value="due_on">
          日付
        </option>
        <option value="due_at">
          日時
        </option>
      </select>
      <input
        v-if="form.dueKind === 'due_on'"
        v-model="form.dueValue"
        class="text-input"
        type="date"
        aria-label="期限日"
        :required="form.dueSpecified"
        :disabled="props.disabled || !form.dueSpecified"
      >
      <input
        v-else-if="form.dueKind === 'due_at'"
        v-model="form.dueValue"
        class="text-input"
        type="datetime-local"
        aria-label="期限日時 日本時間"
        :required="form.dueSpecified"
        :disabled="props.disabled || !form.dueSpecified"
      >
      <p
        v-if="form.dueKind === 'due_at'"
        class="text-xs text-slate-600 dark:text-slate-400"
      >
        日時は日本時間で入力します。
      </p>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-label">
        所要時間
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.durationSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        所要時間を指定する
      </label>
      <div
        v-if="form.durationSpecified"
        class="grid min-w-0 gap-2 sm:grid-cols-[minmax(7rem,1fr)_minmax(0,2fr)]"
      >
        <select
          v-model="form.durationUnit"
          class="text-input min-w-0"
          aria-label="所要時間の単位"
          :disabled="props.disabled"
        >
          <option
            v-for="option in durationUnitOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <input
          v-model="form.durationValue"
          class="text-input min-w-0"
          type="number"
          inputmode="numeric"
          aria-label="所要時間の数値"
          :min="durationMinimum(form.durationUnit)"
          step="1"
          required
          :disabled="props.disabled"
        >
      </div>
    </fieldset>
    <fieldset
      v-if="props.operation.creation.kind === 'split_child'"
      class="field-group sm:col-span-2"
    >
      <legend class="field-label">
        親タスク
      </legend>
      <p class="text-input">
        {{ props.targetLabel(props.operation.creation.parent) }}
      </p>
      <p class="text-xs text-slate-600 dark:text-slate-400">
        分割元の親タスクに固定されています。
      </p>
    </fieldset>
    <fieldset class="field-group">
      <legend class="field-label">
        親タスクの作業範囲
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.parentWorkModeSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        作業範囲を指定する
      </label>
      <select
        v-model="form.parentWorkMode"
        class="text-input"
        aria-label="親タスクの作業範囲"
        :disabled="props.disabled || !form.parentWorkModeSpecified"
      >
        <option value="children_only">
          子タスクのみ
        </option>
        <option value="has_own_work">
          親自身の作業あり
        </option>
        <option value="unknown">
          不明
        </option>
      </select>
    </fieldset>
    <fieldset class="field-group sm:col-span-2">
      <legend class="field-label">
        依存するタスク
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.dependenciesSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        依存関係を指定する
      </label>
      <ProposalDependenciesEditor
        v-if="form.dependenciesSpecified"
        v-model:dependencies="form.dependencies"
        :target-options="props.targetOptions"
        :disabled="props.disabled"
        :add-dependency="props.addDependency"
        :remove-dependency="props.removeDependency"
      />
    </fieldset>
    <fieldset class="field-group sm:col-span-2">
      <legend class="field-label">
        Obsidianリンク
      </legend>
      <label class="flex items-center gap-2 text-xs font-normal text-slate-600 dark:text-slate-400">
        <input
          v-model="form.obsidianLinksSpecified"
          type="checkbox"
          :disabled="props.disabled"
        >
        Obsidianリンクを指定する
      </label>
      <div
        v-if="form.obsidianLinksSpecified"
        class="space-y-3"
      >
        <div
          v-for="(link, index) in form.obsidianLinks"
          :key="link.id"
          class="grid min-w-0 gap-2 rounded-md border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-2"
        >
          <label class="field-label">
            Vault ID
            <input
              v-model="link.vaultId"
              class="text-input"
              type="text"
              required
              :disabled="props.disabled"
            >
          </label>
          <label class="field-label">
            パス
            <input
              v-model="link.path"
              class="text-input"
              type="text"
              required
              :disabled="props.disabled"
            >
          </label>
          <label class="field-label">
            ノートタイトル
            <input
              v-model="link.title"
              class="text-input"
              type="text"
              required
              :disabled="props.disabled"
            >
          </label>
          <label class="field-label">
            信頼度
            <input
              v-model="link.confidence"
              class="text-input"
              type="number"
              min="0"
              max="1"
              step="any"
              :aria-label="`Obsidianリンクの信頼度${index + 1}`"
              required
              :disabled="props.disabled"
            >
          </label>
          <button
            type="button"
            class="secondary-button justify-self-start sm:col-span-2"
            :disabled="props.disabled"
            @click="props.removeObsidianLink(link.id)"
          >
            リンクを削除
          </button>
        </div>
        <button
          type="button"
          class="secondary-button"
          :disabled="props.disabled"
          @click="props.addObsidianLink"
        >
          Obsidianリンクを追加
        </button>
      </div>
    </fieldset>
  </div>
</template>

<style scoped>
.create-task-fields,
.create-task-fields .field-group,
.create-task-fields fieldset,
.create-task-fields .grid,
.create-task-fields .field-label {
  min-width: 0;
}

.create-task-fields .text-input {
  width: 100%;
  min-width: 0;
}
</style>
