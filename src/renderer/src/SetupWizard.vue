<script setup lang="ts">
import { computed, ref } from "vue";
import {
  setupCredentialsInputSchema,
  setupExternalToolChoiceInputSchema,
  setupProjectSelectionInputSchema,
  setupVaultChoiceInputSchema,
  setupWorkspaceSelectionInputSchema,
  type SetupCredentialsInput,
  type SetupExternalToolChoiceInput,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import { vaultMappingSchema } from "../../shared/storage";

type SetupAction =
  | { readonly kind: "start" }
  | { readonly kind: "complete_codex_authentication" }
  | { readonly kind: "authenticate_asana"; readonly input: SetupCredentialsInput }
  | { readonly kind: "list_workspaces" }
  | { readonly kind: "select_workspace"; readonly input: SetupWorkspaceSelectionInput }
  | { readonly kind: "select_project"; readonly input: SetupProjectSelectionInput }
  | { readonly kind: "retry_resources" }
  | { readonly kind: "run_capability" }
  | { readonly kind: "choose_vault"; readonly input: SetupVaultChoiceInput }
  | { readonly kind: "choose_external_tool"; readonly input: SetupExternalToolChoiceInput }
  | { readonly kind: "run_full_sync" }
  | { readonly kind: "run_codex_capability" };

const props = defineProps<{
  state: SetupState | undefined;
  busy: boolean;
}>();

const emit = defineEmits<{
  (event: "action", action: SetupAction): void;
}>();

const clientId = ref("");
const clientSecret = ref("");
const timeoutMilliseconds = ref("120000");
const projectName = ref("");
const vaultId = ref("");
const vaultPath = ref("");
const localError = ref("");

const resourceIssues = computed(() => {
  if (props.state?.kind !== "resources_requires_action") {
    return [];
  }
  return props.state.issues;
});

function stateTitle(state: SetupState | undefined): string {
  if (state == null) {
    return "初回設定を開始します";
  }
  switch (state.kind) {
    case "created":
    case "codex_cli_ready":
      return "Codex CLIを確認します";
    case "codex_authentication_required":
      return "Codexへログインしてください";
    case "credentials_required":
      return "Asanaを接続します";
    case "workspace_listing_required":
    case "workspace_selection_required":
      return "ワークスペースを選びます";
    case "project_selection_required":
    case "project_requires_action":
      return "専用プロジェクトを選びます";
    case "resources_requires_action":
      return "必須リソースを確認します";
    case "resources_ready":
    case "asana_capability_failed":
      return "Asanaの能力を確認します";
    case "vault_choice_required":
      return "Vaultを設定します";
    case "vault_skipped":
    case "vault_configured":
      return "外部読み取りツールを設定します";
    case "external_tool_skipped":
    case "external_tool_configured":
    case "full_sync_required":
      return "初回同期を実行します";
    case "codex_capability_required":
      return "Codexの能力を確認します";
    case "ready":
      return "初回設定が完了しました";
  }
}

function stateDescription(state: SetupState | undefined): string {
  if (state == null) {
    return "Asanaを唯一の正本として利用するための安全な初期設定です。";
  }
  if (state.kind === "ready") {
    if (state.context.codex.kind === "unavailable") {
      return `AIは利用できません。${codexReasonLabel(state.context.codex.reason_code)} Asanaの同期と編集は利用できます。`;
    }
    return "同期済みのタスクを表示できます。未承認のAI変更案は保存されません。";
  }
  if ("codex" in state && state.codex.kind === "unavailable") {
    if (state.kind === "credentials_required") {
      return `AIは利用できません。${codexReasonLabel(state.codex.reason_code)} Client IDとClient Secretはこの入力欄から送信するだけで、画面には再表示しません。`;
    }
    return `AIは利用できません。${codexReasonLabel(state.codex.reason_code)} Asanaの初期設定と同期を先に進められます。`;
  }
  if (state.kind === "codex_authentication_required") {
    return "ChatGPTログイン画面を開き、完了後にこの画面へ戻ってください。";
  }
  if (state.kind === "credentials_required") {
    return "Client IDとClient Secretはこの入力欄から送信するだけで、画面には再表示しません。";
  }
  if (state.kind === "resources_requires_action") {
    return "必須セクションやタグの不足、重複、名前変更を確認してから再照合します。";
  }
  return "現在の手順を完了して次へ進んでください。";
}

function codexReasonLabel(reason: "not_installed" | "incompatible" | "permission_denied" | "startup_failed" | "disabled"): string {
  switch (reason) {
    case "not_installed":
      return "Codex CLIが見つかりません。";
    case "incompatible":
      return "対応していないCodex CLIです。";
    case "permission_denied":
      return "Codexの権限を確認できません。";
    case "startup_failed":
      return "Codexの起動に失敗しました。";
    case "disabled":
      return "Codexは安全確認により停止しています。";
  }
}

function projectReasonLabel(reason: "duplicate_project_name"): string {
  switch (reason) {
    case "duplicate_project_name":
      return "同名の専用プロジェクトが複数あります。対象を選び直してください。";
  }
}

function capabilityReasonLabel(reason: "task_create_failed" | "task_update_failed" | "section_move_failed" | "tag_update_failed" | "external_data_failed" | "read_back_failed" | "cleanup_failed" | "unknown"): string {
  switch (reason) {
    case "task_create_failed":
      return "タスク作成能力を確認できませんでした。";
    case "task_update_failed":
      return "タスク更新能力を確認できませんでした。";
    case "section_move_failed":
      return "セクション移動能力を確認できませんでした。";
    case "tag_update_failed":
      return "タグ更新能力を確認できませんでした。";
    case "external_data_failed":
      return "外部データ能力を確認できませんでした。";
    case "read_back_failed":
      return "書き込み後の再取得能力を確認できませんでした。";
    case "cleanup_failed":
      return "検査後の整理能力を確認できませんでした。";
    case "unknown":
      return "能力検査を完了できませんでした。";
  }
}

function submitCredentials(): void {
  localError.value = "";
  try {
    const input = setupCredentialsInputSchema.parse({
      client_id: clientId.value,
      client_secret: clientSecret.value,
      timeout_milliseconds: Number(timeoutMilliseconds.value),
    });
    emit("action", { kind: "authenticate_asana", input });
    clientSecret.value = "";
  } catch {
    localError.value = "入力値を確認してください。";
  }
}

function submitProjectCreate(): void {
  localError.value = "";
  try {
    const input = setupProjectSelectionInputSchema.parse({
      kind: "create",
      name: projectName.value,
    });
    emit("action", { kind: "select_project", input });
  } catch {
    localError.value = "プロジェクト名を確認してください。";
  }
}

function submitVault(): void {
  localError.value = "";
  try {
    const mapping = vaultMappingSchema.parse({
      vault_id: vaultId.value,
      absolute_path: vaultPath.value,
    });
    const input = setupVaultChoiceInputSchema.parse({ kind: "configure", mapping });
    emit("action", { kind: "choose_vault", input });
  } catch {
    localError.value = "Vault IDと絶対パスを確認してください。";
  }
}

function selectWorkspace(value: string): void {
  localError.value = "";
  try {
    const input = setupWorkspaceSelectionInputSchema.parse({ workspace_gid: value });
    emit("action", { kind: "select_workspace", input });
  } catch {
    localError.value = "ワークスペースを選択できません。";
  }
}

function selectProject(value: string): void {
  localError.value = "";
  try {
    const input = setupProjectSelectionInputSchema.parse({
      kind: "existing",
      project_gid: value,
    });
    emit("action", { kind: "select_project", input });
  } catch {
    localError.value = "プロジェクトを選択できません。";
  }
}

function skipExternalTool(): void {
  const input = setupExternalToolChoiceInputSchema.parse({ kind: "skip" });
  emit("action", { kind: "choose_external_tool", input });
}

function workspaceOptions(state: SetupState | undefined): readonly { gid: string; name: string }[] {
  if (state?.kind !== "workspace_selection_required") {
    return [];
  }
  return state.workspaces;
}

function projectOptions(state: SetupState | undefined): readonly { gid: string; name: string }[] {
  if (state?.kind !== "project_selection_required" && state?.kind !== "project_requires_action") {
    return [];
  }
  return state.projects;
}

function isState(state: SetupState | undefined, ...kinds: SetupState["kind"][]): boolean {
  if (state == null) {
    return false;
  }
  return kinds.includes(state.kind);
}
</script>

<template>
  <section
    class="mx-auto w-full max-w-4xl rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-8"
    aria-labelledby="setup-title"
  >
    <div class="border-b border-slate-200 pb-5">
      <p class="text-sm font-semibold text-sky-700">
        初回設定ウィザード
      </p>
      <h2
        id="setup-title"
        class="mt-2 text-2xl font-semibold text-slate-900"
      >
        {{ stateTitle(props.state) }}
      </h2>
      <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
        {{ stateDescription(props.state) }}
      </p>
    </div>

    <ol
      class="mt-6 grid gap-2 text-sm text-slate-700 sm:grid-cols-4"
      aria-label="初回設定の手順"
    >
      <li class="rounded-md bg-slate-100 px-3 py-2">
        1. Codex
      </li>
      <li class="rounded-md bg-slate-100 px-3 py-2">
        2. Asana
      </li>
      <li class="rounded-md bg-slate-100 px-3 py-2">
        3. 外部情報源
      </li>
      <li class="rounded-md bg-slate-100 px-3 py-2">
        4. 同期と能力検査
      </li>
    </ol>

    <p
      v-if="localError.length > 0"
      class="mt-5 rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-800"
      role="alert"
    >
      {{ localError }}
    </p>

    <div class="mt-6 space-y-4">
      <div
        v-if="props.state == null || isState(props.state, 'created', 'codex_cli_ready')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600">
          対応するCodex CLIと接続状態を確認します。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'start' })"
        >
          Codexを確認
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'codex_authentication_required')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600">
          ChatGPTのブラウザログインを開始できます。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'complete_codex_authentication' })"
        >
          ChatGPTログインを開始
        </button>
      </div>

      <form
        v-else-if="isState(props.state, 'credentials_required')"
        class="grid gap-4 sm:max-w-xl"
        @submit.prevent="submitCredentials"
      >
        <label
          class="field-label"
          for="client-id"
        >Asana Client ID<input
          id="client-id"
          v-model="clientId"
          class="text-input"
          autocomplete="off"
        ></label>
        <label
          class="field-label"
          for="client-secret"
        >Asana Client Secret<input
          id="client-secret"
          v-model="clientSecret"
          class="text-input"
          type="password"
          autocomplete="off"
        ></label>
        <label
          class="field-label"
          for="oauth-timeout"
        >認証待ち時間ミリ秒<input
          id="oauth-timeout"
          v-model="timeoutMilliseconds"
          class="text-input"
          inputmode="numeric"
        ></label>
        <button
          type="submit"
          class="primary-button"
          :disabled="props.busy"
        >
          Asanaへ接続
        </button>
      </form>

      <div
        v-else-if="isState(props.state, 'workspace_listing_required')"
        class="space-y-3"
      >
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'list_workspaces' })"
        >
          ワークスペースを取得
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'workspace_selection_required')"
        class="space-y-3"
      >
        <p class="text-sm font-medium text-slate-800">
          対象ワークスペース
        </p>
        <div class="grid gap-2">
          <button
            v-for="workspace in workspaceOptions(props.state)"
            :key="workspace.gid"
            type="button"
            class="choice-button"
            :disabled="props.busy"
            @click="selectWorkspace(workspace.gid)"
          >
            {{ workspace.name }} <span class="text-xs text-slate-500">{{ workspace.gid }}</span>
          </button>
        </div>
      </div>

      <div
        v-else-if="isState(props.state, 'project_selection_required', 'project_requires_action')"
        class="space-y-4"
      >
        <p
          v-if="props.state.kind === 'project_requires_action'"
          class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          {{ projectReasonLabel(props.state.reason_code) }}
        </p>
        <div class="grid gap-2">
          <button
            v-for="project in projectOptions(props.state)"
            :key="project.gid"
            type="button"
            class="choice-button"
            :disabled="props.busy"
            @click="selectProject(project.gid)"
          >
            {{ project.name }} <span class="text-xs text-slate-500">{{ project.gid }}</span>
          </button>
        </div>
        <form
          class="grid gap-2 sm:max-w-xl"
          @submit.prevent="submitProjectCreate"
        >
          <label
            class="field-label"
            for="project-name"
          >新しい専用プロジェクト名<input
            id="project-name"
            v-model="projectName"
            class="text-input"
          ></label>
          <button
            type="submit"
            class="secondary-button"
            :disabled="props.busy"
          >
            専用プロジェクトを作成
          </button>
        </form>
      </div>

      <div
        v-else-if="isState(props.state, 'resources_requires_action')"
        class="space-y-3"
      >
        <ul class="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li
            v-for="issue in resourceIssues"
            :key="`${issue.resource}-${issue.name}-${issue.reason}`"
          >
            {{ issue.resource === 'section' ? 'セクション' : 'タグ' }}「{{ issue.name }}」を{{ issue.reason === 'duplicate' ? '確認してください' : issue.reason === 'renamed' ? '名前変更として確認してください' : '再作成してください' }}
          </li>
        </ul>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'retry_resources' })"
        >
          必須リソースを再照合
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'resources_ready', 'asana_capability_failed')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600">
          タスク、セクション、タグ、外部データの実操作能力を確認します。
        </p>
        <p
          v-if="props.state.kind === 'asana_capability_failed'"
          class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900"
          role="alert"
        >
          {{ capabilityReasonLabel(props.state.reason_code) }}
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'run_capability' })"
        >
          Asana能力を検査
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'vault_choice_required')"
        class="space-y-4"
      >
        <form
          class="grid gap-4 sm:max-w-xl"
          @submit.prevent="submitVault"
        >
          <label
            class="field-label"
            for="vault-id"
          >Vault ID<input
            id="vault-id"
            v-model="vaultId"
            class="text-input"
            autocomplete="off"
          ></label>
          <label
            class="field-label"
            for="vault-path"
          >Vault絶対パス<input
            id="vault-path"
            v-model="vaultPath"
            class="text-input"
            autocomplete="off"
          ></label>
          <button
            type="submit"
            class="primary-button"
            :disabled="props.busy"
          >
            Vaultを登録
          </button>
        </form>
        <button
          type="button"
          class="secondary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'choose_vault', input: { kind: 'skip' } })"
        >
          Vaultを使わずに続ける
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'vault_skipped', 'vault_configured')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600">
          この実装では安全な資格情報境界と実行境界を提供できないため、外部ツール連携は利用できません。
          外部情報取得の能力不足として初回設定を続行します。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="skipExternalTool"
        >
          外部ツールを使わずに続ける
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'external_tool_skipped', 'external_tool_configured', 'full_sync_required')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600">
          専用プロジェクトから初回の完全同期を実行します。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'run_full_sync' })"
        >
          フル同期を実行
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'codex_capability_required')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600">
          専用ワークスペース、権限、スキル、構造化出力を確認します。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'run_codex_capability' })"
        >
          Codex能力を検査
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'ready')"
        class="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        role="status"
      >
        設定済みです。同期済みデータを表示します。
      </div>
    </div>
  </section>
</template>
