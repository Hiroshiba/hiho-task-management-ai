<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { isoDateTimeSchema } from "../../shared/domain";
import {
  setupAsanaAuthorizationBeginInputSchema,
  setupAsanaAuthorizationCancelInputSchema,
  setupAsanaAuthorizationCompleteInputSchema,
  setupExternalToolChoiceInputSchema,
  setupProjectSelectionInputSchema,
  setupVaultChoiceInputSchema,
  setupWorkspaceSelectionInputSchema,
  type SetupAsanaAuthorizationCancelInput,
  type SetupExternalToolChoiceInput,
  type SetupExternalToolUnavailableReason,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import { vaultMappingSchema } from "../../shared/storage";

type SetupAction =
  | { readonly kind: "start" }
  | { readonly kind: "complete_codex_authentication" }
  | {
      readonly kind: "begin_asana_authorization";
      readonly request: ReturnType<Window["taskHub"]["setup"]["beginAsanaAuthorization"]>;
    }
  | {
      readonly kind: "complete_asana_authorization";
      readonly request: ReturnType<Window["taskHub"]["setup"]["completeAsanaAuthorization"]>;
    }
  | {
      readonly kind: "cancel_asana_authorization";
      readonly request: ReturnType<Window["taskHub"]["setup"]["cancelAsanaAuthorization"]>;
    }
  | { readonly kind: "list_workspaces" }
  | { readonly kind: "select_workspace"; readonly input: SetupWorkspaceSelectionInput }
  | { readonly kind: "select_project"; readonly input: SetupProjectSelectionInput }
  | { readonly kind: "retry_resources" }
  | { readonly kind: "run_capability" }
  | { readonly kind: "choose_vault"; readonly input: SetupVaultChoiceInput }
  | {
      readonly kind: "choose_external_tool";
      readonly request: ReturnType<Window["taskHub"]["setup"]["chooseExternalTool"]>;
    }
  | { readonly kind: "run_full_sync" }
  | { readonly kind: "run_codex_capability" };

type SetupProgressStageNumber = 1 | 2 | 3 | 4;
type SetupProgressStatus = "completed" | "current" | "upcoming";

const setupProgressStages = [
  { number: 1, label: "Codex" },
  { number: 2, label: "Asana" },
  { number: 3, label: "外部情報源" },
  { number: 4, label: "同期と動作確認" },
] satisfies readonly { number: SetupProgressStageNumber; label: string }[];

const props = defineProps<{
  state: SetupState | undefined;
  busy: boolean;
}>();

const emit = defineEmits<{
  (event: "action", action: SetupAction): void;
}>();

const clientId = ref("");
const clientSecretInput = ref<HTMLInputElement | null>(null);
const authorizationCodeInput = ref<HTMLInputElement | null>(null);
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

function clearClientSecret(): void {
  if (clientSecretInput.value != null) {
    clientSecretInput.value.value = "";
  }
}

function clearAuthorizationCode(): void {
  if (authorizationCodeInput.value != null) {
    authorizationCodeInput.value.value = "";
  }
}

function clearSensitiveInputs(): void {
  clearClientSecret();
  clearAuthorizationCode();
}

watch(() => props.state?.kind, clearSensitiveInputs);
onBeforeUnmount(clearSensitiveInputs);

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
    case "asana_authorization_pending":
      return "Asana認可コードを入力します";
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
      return "Asanaの接続と操作を確認します";
    case "vault_choice_required":
      return "Vaultを設定します";
    case "vault_skipped":
    case "vault_configured":
    case "external_tool_skipped":
    case "external_tool_configured":
    case "external_tool_unavailable":
    case "full_sync_required":
      return "初回同期を実行します";
    case "codex_capability_required":
      return "Codexの接続と応答を確認します";
    case "ready":
      return "初回設定が完了しました";
  }
}

function setupProgressStageNumber(state: SetupState | undefined): SetupProgressStageNumber {
  if (state == null) {
    return 1;
  }
  switch (state.step) {
    case "codex_cli":
    case "codex_authentication":
      return 1;
    case "credentials":
    case "workspace":
    case "project":
    case "resources":
    case "asana_capability":
      return 2;
    case "vault":
    case "external_tool":
      return 3;
    case "full_sync":
    case "codex_capability":
    case "ready":
      return 4;
  }
}

function setupProgressStatus(
  stageNumber: SetupProgressStageNumber,
  state: SetupState | undefined,
): SetupProgressStatus {
  if (state?.kind === "ready") {
    return "completed";
  }
  const currentStageNumber = setupProgressStageNumber(state);
  if (stageNumber < currentStageNumber) {
    return "completed";
  }
  if (stageNumber === currentStageNumber) {
    return "current";
  }
  return "upcoming";
}

function setupProgressStatusLabel(status: SetupProgressStatus): string {
  switch (status) {
    case "completed":
      return "完了";
    case "current":
      return "現在";
    case "upcoming":
      return "未着手";
  }
}

function setupProgressStatusClass(status: SetupProgressStatus): string {
  switch (status) {
    case "completed":
      return "border border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100";
    case "current":
      return "border border-sky-300 bg-sky-50 text-sky-900 ring-1 ring-sky-200 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100 dark:ring-sky-800";
    case "upcoming":
      return "border border-slate-200 bg-slate-100 text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400";
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
      return `AIは利用できません。${codexReasonLabel(state.codex.reason_code)} Asana Developer ConsoleのRedirect URLにurn:ietf:wg:oauth:2.0:oobを登録してください。Client IDとClient Secretはこの入力欄から送信するだけで、画面には再表示しません。`;
    }
    return `AIは利用できません。${codexReasonLabel(state.codex.reason_code)} Asanaの初期設定と同期を先に進められます。`;
  }
  if (state.kind === "codex_authentication_required") {
    return "ChatGPTログイン画面を開き、完了後にこの画面へ戻ってください。";
  }
  if (state.kind === "credentials_required") {
    return "Asana Developer ConsoleのRedirect URLにurn:ietf:wg:oauth:2.0:oobを登録してください。Client IDとClient Secretはこの入力欄から送信するだけで、画面には再表示しません。";
  }
  if (state.kind === "asana_authorization_pending") {
    return "Asanaに表示された認可コードを入力して確定してください。";
  }
  if (state.kind === "resources_requires_action") {
    return "必須セクションやタグの不足、重複、名前変更を確認してから再照合します。";
  }
  if (state.kind === "external_tool_unavailable") {
    return `${externalToolUnavailableReasonLabel(state.reason_code)} 外部情報取得を無効にしたまま初回設定を続けられます。`;
  }
  return "現在の手順を完了して次へ進んでください。";
}

function jstDateTimeLabel(value: string): string {
  const validated = isoDateTimeSchema.parse(value);
  const timestamp = Date.parse(validated);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Asana認証期限を表示できません。");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
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
      return "タスクの作成を確認できませんでした。";
    case "task_update_failed":
      return "タスクの更新を確認できませんでした。";
    case "section_move_failed":
      return "セクションの移動を確認できませんでした。";
    case "tag_update_failed":
      return "タグの更新を確認できませんでした。";
    case "external_data_failed":
      return "外部データの取得を確認できませんでした。";
    case "read_back_failed":
      return "書き込み後の再取得を確認できませんでした。";
    case "cleanup_failed":
      return "検査後の整理を確認できませんでした。";
    case "unknown":
      return "接続と操作の確認を完了できませんでした。";
  }
}

function externalToolUnavailableReasonLabel(
  reason: SetupExternalToolUnavailableReason,
): string {
  switch (reason) {
    case "unsupported_platform":
      return "このOSではDiscord読取連携を安全に利用できません。";
    case "safe_execution_boundary_unavailable":
      return "Discord読取連携の安全な実行境界を用意できません。";
    case "credential_storage_unavailable":
      return "Discord Bot Tokenを安全に保存できません。";
    case "startup_failed":
      return "Discord読取連携を開始できませんでした。";
  }
}

function submitCredentials(): void {
  localError.value = "";
  const secretInput = clientSecretInput.value;
  if (secretInput == null) {
    throw new Error("Client Secret入力欄が見つかりません。");
  }
  const parsed = setupAsanaAuthorizationBeginInputSchema.safeParse({
    client_id: clientId.value,
    client_secret: secretInput.value,
  });
  if (!parsed.success) {
    clearClientSecret();
    localError.value = "入力値を確認してください。";
    return;
  }
  try {
    const request = window.taskHub.setup.beginAsanaAuthorization(parsed.data);
    void request.then(clearClientSecret, clearClientSecret);
    emit("action", { kind: "begin_asana_authorization", request });
  } catch {
    localError.value = "Asana認証を開始できませんでした。";
  } finally {
    clearClientSecret();
  }
}

function submitAuthorizationCode(): void {
  localError.value = "";
  const codeInput = authorizationCodeInput.value;
  const state = props.state;
  if (codeInput == null || state?.kind !== "asana_authorization_pending") {
    throw new Error("OAuth認可コード入力欄が見つかりません。");
  }
  const parsed = setupAsanaAuthorizationCompleteInputSchema.safeParse({
    authorization_id: state.authorization_id,
    authorization_code: codeInput.value.trim(),
  });
  if (!parsed.success) {
    clearAuthorizationCode();
    localError.value = "認可コードを確認してください。";
    return;
  }
  try {
    const request = window.taskHub.setup.completeAsanaAuthorization(parsed.data);
    void request.then(clearAuthorizationCode, clearAuthorizationCode);
    emit("action", { kind: "complete_asana_authorization", request });
  } catch {
    localError.value = "Asana認証を完了できませんでした。";
  } finally {
    clearAuthorizationCode();
  }
}

function cancelAuthorization(): void {
  localError.value = "";
  const state = props.state;
  if (state?.kind !== "asana_authorization_pending") {
    throw new Error("OAuth認可待機状態が見つかりません。");
  }
  const input: SetupAsanaAuthorizationCancelInput =
    setupAsanaAuthorizationCancelInputSchema.parse({
      authorization_id: state.authorization_id,
    });
  try {
    const request = window.taskHub.setup.cancelAsanaAuthorization(input);
    void request.then(clearAuthorizationCode, clearAuthorizationCode);
    emit("action", { kind: "cancel_asana_authorization", request });
  } catch {
    localError.value = "Asana認証を取り消せませんでした。";
  } finally {
    clearAuthorizationCode();
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
    localError.value = "Vault IDとフォルダパスを確認してください。";
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

function beginExternalToolChoice(input: SetupExternalToolChoiceInput): void {
  try {
    const request = window.taskHub.setup.chooseExternalTool(input);
    emit("action", { kind: "choose_external_tool", request });
  } catch {
    localError.value = "外部ツール設定を開始できませんでした。";
  }
}

function skipExternalTool(): void {
  localError.value = "";
  const input = setupExternalToolChoiceInputSchema.parse({ kind: "skip" });
  beginExternalToolChoice(input);
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
    class="mx-auto w-full max-w-4xl rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900 sm:p-8"
    aria-labelledby="setup-title"
  >
    <div class="border-b border-slate-200 pb-5 dark:border-slate-700">
      <p class="text-sm font-semibold text-sky-700 dark:text-sky-400">
        初回設定ウィザード
      </p>
      <h2
        id="setup-title"
        class="mt-2 text-2xl font-semibold text-slate-900 dark:text-slate-100"
      >
        {{ stateTitle(props.state) }}
      </h2>
      <p class="mt-2 max-w-2xl text-sm leading-6 text-slate-600 dark:text-slate-300">
        {{ stateDescription(props.state) }}
      </p>
    </div>

    <ol
      class="mt-6 grid grid-cols-1 items-stretch gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4"
      aria-label="初回設定の手順"
    >
      <li
        v-for="stage in setupProgressStages"
        :key="stage.number"
        class="flex h-full flex-col justify-between rounded-md px-3 py-2"
        :class="setupProgressStatusClass(setupProgressStatus(stage.number, props.state))"
        :aria-current="setupProgressStatus(stage.number, props.state) === 'current' ? 'step' : undefined"
      >
        <span class="font-medium">
          {{ stage.number }}. {{ stage.label }}
        </span>
        <span class="mt-1 text-xs font-semibold">
          {{ setupProgressStatusLabel(setupProgressStatus(stage.number, props.state)) }}
        </span>
      </li>
    </ol>

    <p
      v-if="localError.length > 0"
      class="mt-5 rounded-md bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100"
      role="alert"
    >
      {{ localError }}
    </p>

    <div class="mt-6 space-y-4">
      <div
        v-if="props.state == null || isState(props.state, 'created', 'codex_cli_ready')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600 dark:text-slate-300">
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
        <p class="text-sm text-slate-600 dark:text-slate-300">
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
          ref="clientSecretInput"
          class="text-input"
          type="password"
          autocomplete="off"
        ></label>
        <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
          Asana Developer ConsoleのRedirect URLに<code>urn:ietf:wg:oauth:2.0:oob</code>を登録してください。
        </p>
        <button
          type="submit"
          class="primary-button"
          :disabled="props.busy"
        >
          Asanaへ接続
        </button>
      </form>

      <div
        v-else-if="props.state?.kind === 'asana_authorization_pending'"
        class="space-y-4"
      >
        <p class="text-sm leading-6 text-slate-600 dark:text-slate-300">
          Asanaの認可画面に表示された認可コードを入力してください。認可コードの有効期限は{{ jstDateTimeLabel(props.state.expires_at) }}までです。
        </p>
        <form
          class="grid gap-4 sm:max-w-xl"
          @submit.prevent="submitAuthorizationCode"
        >
          <label
            class="field-label"
            for="authorization-code"
          >Asana認可コード<input
            id="authorization-code"
            ref="authorizationCodeInput"
            class="text-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
          ></label>
          <div class="flex flex-wrap gap-3">
            <button
              type="submit"
              class="primary-button"
              :disabled="props.busy"
            >
              認可コードを確定
            </button>
            <button
              type="button"
              class="secondary-button"
              :disabled="props.busy"
              @click="cancelAuthorization"
            >
              認証をキャンセル
            </button>
          </div>
        </form>
      </div>

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
        <p class="text-sm font-medium text-slate-800 dark:text-slate-100">
          対象ワークスペース
        </p>
        <div class="grid gap-2">
          <button
            v-for="workspace in workspaceOptions(props.state)"
            :key="workspace.gid"
            type="button"
            class="choice-button min-w-0"
            :disabled="props.busy"
            @click="selectWorkspace(workspace.gid)"
          >
            <span class="min-w-0 whitespace-normal break-words">{{ workspace.name }}</span>
            <span class="min-w-0 whitespace-normal break-words text-xs text-slate-500 dark:text-slate-400">{{ workspace.gid }}</span>
          </button>
        </div>
      </div>

      <div
        v-else-if="isState(props.state, 'project_selection_required', 'project_requires_action')"
        class="space-y-4"
      >
        <p
          v-if="props.state.kind === 'project_requires_action'"
          class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          role="alert"
        >
          {{ projectReasonLabel(props.state.reason_code) }}
        </p>
        <div class="grid gap-2">
          <button
            v-for="project in projectOptions(props.state)"
            :key="project.gid"
            type="button"
            class="choice-button min-w-0"
            :disabled="props.busy"
            @click="selectProject(project.gid)"
          >
            <span class="min-w-0 whitespace-normal break-words">{{ project.name }}</span>
            <span class="min-w-0 whitespace-normal break-words text-xs text-slate-500 dark:text-slate-400">{{ project.gid }}</span>
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
        <ul class="list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
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
        <p class="text-sm text-slate-600 dark:text-slate-300">
          タスク、セクション、タグ、外部データへの操作を確認します。
        </p>
        <p
          v-if="props.state.kind === 'asana_capability_failed'"
          class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
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
          接続と操作を確認
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
          >Vaultのフォルダパス<input
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
        class="space-y-4"
      >
        <p class="text-sm text-slate-600 dark:text-slate-300">
          Discord連携は使用しません。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="skipExternalTool"
        >
          初回同期へ進む
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'external_tool_skipped', 'external_tool_configured', 'external_tool_unavailable', 'full_sync_required')"
        class="space-y-3"
      >
        <p
          v-if="props.state.kind === 'external_tool_unavailable'"
          class="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          role="status"
        >
          {{ externalToolUnavailableReasonLabel(props.state.reason_code) }}
        </p>
        <p class="text-sm text-slate-600 dark:text-slate-300">
          専用プロジェクトから初回の完全同期を実行します。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'run_full_sync' })"
        >
          完全同期を実行
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'codex_capability_required')"
        class="space-y-3"
      >
        <p class="text-sm text-slate-600 dark:text-slate-300">
          専用ワークスペース、権限、スキル、構造化出力を確認します。
        </p>
        <button
          type="button"
          class="primary-button"
          :disabled="props.busy"
          @click="emit('action', { kind: 'run_codex_capability' })"
        >
          接続と応答を確認
        </button>
      </div>

      <div
        v-else-if="isState(props.state, 'ready')"
        class="rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
        role="status"
      >
        設定済みです。同期済みデータを表示します。
      </div>
    </div>
  </section>
</template>
