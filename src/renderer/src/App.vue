<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  ipcFailureSchema,
  ipcObsidianOpenNoteInputSchema,
  ipcObsidianPathInputSchema,
  ipcObsidianSearchInputSchema,
  ipcObsidianValidateInputSchema,
  ipcGuiEditInputSchema,
  type IpcFailure,
  type IpcObsidianNoteSummary,
  type IpcObsidianSearchResult,
  type IpcSyncResult,
} from "../../shared/ipc";
import {
  setupStateSchema,
  type SetupCredentialsInput,
  type SetupExternalToolChoiceInput,
  type SetupProjectSelectionInput,
  type SetupState,
  type SetupVaultChoiceInput,
  type SetupWorkspaceSelectionInput,
} from "../../shared/setup";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowTurnRequestSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowTurnRequest,
} from "../../shared/ai-workflow";
import {
  viewModelOverviewSchema,
  viewModelTaskDetailSchema,
  type ViewModelOverview,
  type ViewModelTaskDetail,
} from "../../shared/view-model";
import AppHeader from "./AppHeader.vue";
import AiPanel from "./AiPanel.vue";
import SetupWizard from "./SetupWizard.vue";
import TaskDetail from "./TaskDetail.vue";
import TaskFilters from "./TaskFilters.vue";
import TaskList from "./TaskList.vue";
import {
  createErrorScreenState,
  filterTaskRows,
  rendererAiStateSchema,
  rendererCodexStateSchema,
  rendererFailureSchema,
  rendererScreenStateSchema,
  rendererSyncStateSchema,
  type RendererAiState,
  type RendererCodexState,
  type RendererFailure,
  type RendererFilter,
  type RendererGuiEdit,
  type RendererScreenState,
  type RendererSyncState,
} from "./state";

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

type SetupResult =
  | { readonly kind: "ok"; readonly value: SetupState }
  | IpcFailure;

type CodexStatusValue =
  | { readonly kind: "ready"; readonly codex_version: string; readonly model: string }
  | { readonly kind: "authentication_required"; readonly codex_version: string }
  | { readonly kind: "starting" }
  | { readonly kind: "unavailable"; readonly reason_code: string };

const screen = ref<RendererScreenState>(rendererScreenStateSchema.parse({ kind: "loading" }));
const setupState = ref<SetupState | undefined>();
const setupBusy = ref(false);
const overview = ref<ViewModelOverview | undefined>();
const selectedTask = ref<ViewModelTaskDetail | undefined>();
const selectedTaskGid = ref<string | undefined>();
const filter = ref<RendererFilter>({ kind: "normal" });
const syncState = ref<RendererSyncState>(rendererSyncStateSchema.parse({ kind: "offline" }));
const codexState = ref<RendererCodexState>({ kind: "connecting" });
const aiState = ref<RendererAiState>(rendererAiStateSchema.parse({ kind: "idle" }));
const appVersion = ref("取得中");
const currentAsOf = ref(new Date().toISOString());
const feedback = ref("");
const aiBusy = ref(false);
const obsidianNotes = ref<readonly IpcObsidianNoteSummary[]>([]);
const obsidianSearchResults = ref<readonly IpcObsidianSearchResult[]>([]);
const obsidianStatuses = ref<ReadonlyMap<string, "exists" | "missing" | "unavailable">>(new Map());
const obsidianBusy = ref(false);
const registeredVaultIds = ref<readonly string[]>([]);
let removeSyncSubscription: (() => void) | undefined;
let removeAiSubscription: (() => void) | undefined;
let removeAiStatusSubscription: (() => void) | undefined;
let clockTimer: number | undefined;

const online = computed(() => syncState.value.kind === "synced" || syncState.value.kind === "syncing");
const canManualSync = computed(() => syncState.value.kind !== "offline" && syncState.value.kind !== "syncing");
const canWrite = computed(() => syncState.value.kind === "synced");
const canReadLocal = computed(() => setupState.value?.kind === "ready");
const lastSyncAt = computed(() => {
  const currentOverview = overview.value;
  if (currentOverview != null) {
    return currentOverview.last_successful_sync_at;
  }
  if (syncState.value.kind === "synced") {
    return syncState.value.synced_at;
  }
  return undefined;
});
const cleanupCount = computed(() => overview.value?.cleanup_count ?? 0);
const visibleRows = computed(() => {
  const currentOverview = overview.value;
  if (currentOverview == null) {
    return [];
  }
  return filterTaskRows(currentOverview, filter.value, currentAsOf.value);
});

function isFailure(value: unknown): value is IpcFailure {
  const parsed = ipcFailureSchema.safeParse(value);
  if (parsed.success) {
    return true;
  }
  if (typeof value === "object" && value != null && "kind" in value && value.kind === "error") {
    throw new Error("IPC失敗応答の形式が不正です。");
  }
  return false;
}

function failureText(code: RendererFailure["code"]): string {
  switch (code) {
    case "invalid_request":
      return "入力を確認してください。";
    case "invalid_response":
      return "応答を確認できませんでした。";
    case "sender_untrusted":
      return "安全な送信元を確認できませんでした。";
    case "not_configured":
      return "この機能はまだ設定されていません。";
    case "operation_failed":
      return "操作に失敗しました。";
    case "aborted":
      return "操作を中断しました。";
    case "conflict":
      return "最新状態と競合しました。再同期してください。";
    case "not_found":
      return "対象が見つかりません。";
    case "authentication_required":
      return "認証が必要です。";
    case "unavailable":
      return "この機能は現在利用できません。";
  }
}

function displayFailure(value: IpcFailure): RendererFailure {
  return rendererFailureSchema.parse({
    kind: "error",
    code: value.code,
    message: failureText(value.code),
  });
}

function showFailure(value: IpcFailure): void {
  feedback.value = displayFailure(value).message;
}

function showUnexpectedFailure(): void {
  feedback.value = "予期しないエラーが発生しました。もう一度お試しください。";
}

function createSyncFeedback(result: IpcSyncResult): string {
  let appliedCount = 0;
  let alreadyAppliedCount = 0;
  let conflictCount = 0;
  for (const operation of result.application_result.operations) {
    switch (operation.outcome) {
      case "applied":
        appliedCount += 1;
        break;
      case "already_applied":
        alreadyAppliedCount += 1;
        break;
      case "conflict":
        conflictCount += 1;
        break;
    }
  }
  const remainingWriteCount = result.remaining_plan.status_write_task_gids.length
    + result.remaining_plan.external_write_task_gids.length
    + result.remaining_plan.tag_write_task_gids.length;
  return [
    `同期しました。対象 ${result.application_result.affected_gids.length}件`,
    `反映 ${appliedCount}件`,
    `反映済み ${alreadyAppliedCount}件`,
    `競合 ${conflictCount}件`,
    `残り書き込み ${remainingWriteCount}件`,
    `重大エラー ${result.critical_errors.length}件。`,
  ].join("、");
}

function cleanupKindLabel(kind: ViewModelOverview["cleanup_items"][number]["kind"]): string {
  switch (kind) {
    case "importance_tag_conflict":
      return "重要度タグの競合";
    case "area_tag_conflict":
      return "領域タグの競合";
    case "unknown_status_section":
      return "不明な状態セクション";
    case "missing_required_section":
      return "必須セクション不足";
    case "dependency_cycle":
      return "依存関係の循環";
    case "missing_dependency":
      return "依存先の欠落";
    case "parent_cycle":
      return "親子関係の循環";
    case "parent_relation_conflict":
      return "親子関係の矛盾";
    case "children_only_completion_confirmation":
      return "子タスク完了確認";
    case "missing_task":
      return "タスクの欠落";
    case "custom_external_data_broken":
      return "外部データ破損";
    case "oauth_app_mismatch":
      return "OAuthアプリ不一致";
    case "proposal_conflict":
      return "変更案の競合";
    case "broken_vault_link":
      return "Vaultリンク破損";
  }
}

function cleanupScopeLabel(item: ViewModelOverview["cleanup_items"][number]): string {
  if (item.scope.scope === "task") {
    return `タスク ${item.scope.task_gid}`;
  }
  return "全体";
}

function cleanupRelatedGids(item: ViewModelOverview["cleanup_items"][number]): string {
  const gids = item.scope.related_task_gids;
  if (gids == null || gids.length === 0) {
    return "";
  }
  return `関連: ${gids.join("、")}`;
}

function setScreenError(value: IpcFailure): void {
  screen.value = createErrorScreenState(value.code, failureText(value.code));
}

function handleSyncState(value: {
  readonly kind: "online" | "offline" | "syncing" | "authentication_required" | "error";
  readonly last_successful_sync_at?: string | undefined;
}): void {
  if (value.kind === "syncing") {
    syncState.value = rendererSyncStateSchema.parse({ kind: "syncing" });
    return;
  }
  if (value.kind === "offline") {
    syncState.value = rendererSyncStateSchema.parse({ kind: "offline" });
    return;
  }
  if (value.kind === "authentication_required") {
    syncState.value = rendererSyncStateSchema.parse({
      kind: "error",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "authentication_required",
        message: failureText("authentication_required"),
      }),
    });
    return;
  }
  if (value.kind === "error") {
    syncState.value = rendererSyncStateSchema.parse({
      kind: "error",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "operation_failed",
        message: failureText("operation_failed"),
      }),
    });
    return;
  }
  if (value.last_successful_sync_at == null) {
    syncState.value = rendererSyncStateSchema.parse({ kind: "syncing" });
    return;
  }
  syncState.value = rendererSyncStateSchema.parse({
    kind: "synced",
    synced_at: value.last_successful_sync_at,
  });
}

function setCodexFromSetup(state: SetupState): void {
  if (state.kind === "codex_authentication_required") {
    codexState.value = { kind: "authentication_required" };
    return;
  }
  if ("codex" in state && state.codex.kind === "unavailable") {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "unavailable",
        message: failureText("unavailable"),
      }),
    });
    return;
  }
  if (state.kind === "ready" && state.context.codex.kind === "unavailable") {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "unavailable",
        message: failureText("unavailable"),
      }),
    });
  }
}

function handleCodexStatus(value: CodexStatusValue): void {
  if (value.kind === "ready") {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "ready",
      version: value.codex_version,
    });
    return;
  }
  if (value.kind === "authentication_required") {
    codexState.value = rendererCodexStateSchema.parse({ kind: "authentication_required" });
    return;
  }
  if (value.kind === "starting") {
    codexState.value = rendererCodexStateSchema.parse({ kind: "connecting" });
    return;
  }
  codexState.value = rendererCodexStateSchema.parse({
    kind: "unavailable",
    failure: rendererFailureSchema.parse({
      kind: "error",
      code: "unavailable",
      message: failureText("unavailable"),
    }),
  });
}

async function loadOverview(): Promise<void> {
  try {
    const result = await window.taskHub.readModel.getOverview();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    overview.value = viewModelOverviewSchema.parse(result.value);
  } catch {
    showUnexpectedFailure();
  }
}

function applySetupState(value: unknown): void {
  const parsed = setupStateSchema.parse(value);
  setupState.value = parsed;
  setCodexFromSetup(parsed);
  if (parsed.kind === "ready") {
    screen.value = rendererScreenStateSchema.parse({ kind: "dashboard" });
    void loadOverview();
    return;
  }
  screen.value = rendererScreenStateSchema.parse({ kind: "setup", setup: parsed });
}

async function runSetupRequest(request: Promise<SetupResult>): Promise<void> {
  setupBusy.value = true;
  feedback.value = "";
  try {
    const result = await request;
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    applySetupState(result.value);
  } catch {
    showUnexpectedFailure();
  } finally {
    setupBusy.value = false;
  }
}

async function completeCodexAuthenticationFromHeader(): Promise<void> {
  if (setupBusy.value) {
    return;
  }
  const keepDashboard = screen.value.kind === "dashboard";
  setupBusy.value = true;
  feedback.value = "";
  try {
    const result = await window.taskHub.setup.completeCodexAuthentication();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    const state = setupStateSchema.parse(result.value);
    if (keepDashboard && state.kind !== "ready") {
      throw new Error("設定済み状態のCodex認証結果が不正です。");
    }
    applySetupState(state);
    if (keepDashboard) {
      await loadInitialCodexStatus();
    }
  } catch {
    showUnexpectedFailure();
  } finally {
    setupBusy.value = false;
  }
}

function handleSetupAction(action: SetupAction): void {
  switch (action.kind) {
    case "start":
      void runSetupRequest(window.taskHub.setup.start());
      return;
    case "complete_codex_authentication":
      void runSetupRequest(window.taskHub.setup.completeCodexAuthentication());
      return;
    case "authenticate_asana":
      void runSetupRequest(window.taskHub.setup.authenticateAsana(action.input));
      return;
    case "list_workspaces":
      void runSetupRequest(window.taskHub.setup.listWorkspaces());
      return;
    case "select_workspace":
      void runSetupRequest(window.taskHub.setup.selectWorkspace(action.input));
      return;
    case "select_project":
      void runSetupRequest(window.taskHub.setup.selectProject(action.input));
      return;
    case "retry_resources":
      void runSetupRequest(window.taskHub.setup.retryResources());
      return;
    case "run_capability":
      void runSetupRequest(window.taskHub.setup.runCapability());
      return;
    case "choose_vault":
      void runSetupRequest(window.taskHub.setup.chooseVault(action.input));
      return;
    case "choose_external_tool":
      void runSetupRequest(window.taskHub.setup.chooseExternalTool(action.input));
      return;
    case "run_full_sync":
      void runSetupRequest(window.taskHub.setup.runFullSync());
      return;
    case "run_codex_capability":
      void runSetupRequest(window.taskHub.setup.runCodexCapability());
      return;
  }
}

async function manualSync(): Promise<void> {
  if (!canManualSync.value) {
    return;
  }
  syncState.value = rendererSyncStateSchema.parse({ kind: "syncing" });
  try {
    const result = await window.taskHub.sync.run({ mode: "delta" });
    if (isFailure(result)) {
      showFailure(result);
      syncState.value = rendererSyncStateSchema.parse({ kind: "error", failure: displayFailure(result) });
      return;
    }
    syncState.value = rendererSyncStateSchema.parse({ kind: "synced", synced_at: result.value.synced_at });
    feedback.value = createSyncFeedback(result.value);
    await loadOverview();
  } catch {
    showUnexpectedFailure();
    syncState.value = rendererSyncStateSchema.parse({
      kind: "error",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "operation_failed",
        message: failureText("operation_failed"),
      }),
    });
  }
}

async function selectTask(taskGid: string): Promise<void> {
  selectedTaskGid.value = taskGid;
  try {
    const result = await window.taskHub.readModel.getTaskDetail(taskGid);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    selectedTask.value = viewModelTaskDetailSchema.parse(result.value);
    await checkObsidianLinks(selectedTask.value.obsidian_links);
  } catch {
    showUnexpectedFailure();
  }
}

async function checkObsidianLinks(links: readonly ViewModelTaskDetail["obsidian_links"][number][]): Promise<void> {
  const statuses = new Map<string, "exists" | "missing" | "unavailable">();
  for (const link of links) {
    if (!registeredVaultIds.value.includes(link.vault_id)) {
      statuses.set(`${link.vault_id}\0${link.path}`, "unavailable");
      continue;
    }
    try {
      const input = ipcObsidianPathInputSchema.parse({
        vault_id: link.vault_id,
        relative_path: link.path,
      });
      const result = await window.taskHub.obsidian.noteExists(input);
      if (isFailure(result)) {
        showFailure(result);
        continue;
      }
      statuses.set(`${link.vault_id}\0${link.path}`, result.value.kind === "resolved" ? "exists" : "missing");
    } catch {
      showUnexpectedFailure();
    }
  }
  obsidianStatuses.value = statuses;
}

async function loadObsidianVaults(): Promise<void> {
  try {
    const result = await window.taskHub.obsidian.listVaults();
    if (isFailure(result)) {
      showFailure(result);
      registeredVaultIds.value = [];
      if (selectedTask.value != null) {
        await checkObsidianLinks(selectedTask.value.obsidian_links);
      }
      return;
    }
    registeredVaultIds.value = result.value.vault_ids;
    if (selectedTask.value != null) {
      await checkObsidianLinks(selectedTask.value.obsidian_links);
    }
  } catch {
    showUnexpectedFailure();
    registeredVaultIds.value = [];
    if (selectedTask.value != null) {
      await checkObsidianLinks(selectedTask.value.obsidian_links);
    }
  }
}

async function listObsidian(vaultId: string): Promise<void> {
  const trimmedVaultId = vaultId.trim();
  if (!registeredVaultIds.value.includes(trimmedVaultId)) {
    feedback.value = "登録済みのVaultだけを指定してください。";
    return;
  }
  obsidianBusy.value = true;
  try {
    const input = ipcObsidianValidateInputSchema.parse({ vault_id: trimmedVaultId });
    const result = await window.taskHub.obsidian.listNotes(input.vault_id);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    obsidianNotes.value = result.value;
    obsidianSearchResults.value = [];
  } catch {
    showUnexpectedFailure();
  } finally {
    obsidianBusy.value = false;
  }
}

async function searchObsidian(input: { readonly vaultId: string; readonly query: string }): Promise<void> {
  const trimmedVaultId = input.vaultId.trim();
  if (!registeredVaultIds.value.includes(trimmedVaultId)) {
    feedback.value = "登録済みのVaultだけを指定してください。";
    return;
  }
  obsidianBusy.value = true;
  try {
    const validated = ipcObsidianSearchInputSchema.parse({
      vault_id: trimmedVaultId,
      query: input.query,
    });
    const result = await window.taskHub.obsidian.search(validated);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    obsidianSearchResults.value = result.value;
    obsidianNotes.value = [];
  } catch {
    showUnexpectedFailure();
  } finally {
    obsidianBusy.value = false;
  }
}

async function checkObsidianLink(link: ViewModelTaskDetail["obsidian_links"][number]): Promise<void> {
  if (!registeredVaultIds.value.includes(link.vault_id)) {
    const statuses = new Map(obsidianStatuses.value);
    statuses.set(`${link.vault_id}\0${link.path}`, "unavailable");
    obsidianStatuses.value = statuses;
    return;
  }
  try {
    const input = ipcObsidianPathInputSchema.parse({ vault_id: link.vault_id, relative_path: link.path });
    const result = await window.taskHub.obsidian.noteExists(input);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    const statuses = new Map(obsidianStatuses.value);
    statuses.set(`${link.vault_id}\0${link.path}`, result.value.kind === "resolved" ? "exists" : "missing");
    obsidianStatuses.value = statuses;
  } catch {
    showUnexpectedFailure();
  }
}

async function openObsidianLink(link: ViewModelTaskDetail["obsidian_links"][number]): Promise<void> {
  if (!registeredVaultIds.value.includes(link.vault_id)) {
    feedback.value = "このVaultは登録されていません。";
    return;
  }
  try {
    const input = ipcObsidianOpenNoteInputSchema.parse({ vault_id: link.vault_id, relative_path: link.path });
    const result = await window.taskHub.obsidian.openNote(input);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    feedback.value = "Obsidianでノートを開きました。";
  } catch {
    showUnexpectedFailure();
  }
}

async function applyGuiEdit(input: RendererGuiEdit): Promise<void> {
  const currentOverview = overview.value;
  if (!canWrite.value || currentOverview == null) {
    feedback.value = "オフライン中は編集できません。";
    return;
  }
  try {
    const validatedInput = ipcGuiEditInputSchema.parse({
      task_gid: input.task_gid,
      expected_sync_at: currentOverview.last_successful_sync_at,
      operation: input.operation,
    });
    const result = await window.taskHub.gui.apply(validatedInput);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    feedback.value = result.value.outcome === "conflict" ? "最新状態と競合しました。" : "変更を反映しました。";
    await loadOverview();
    await selectTask(input.task_gid);
  } catch {
    showUnexpectedFailure();
  }
}

async function startAiSession(): Promise<void> {
  try {
    const result = await window.taskHub.ai.startNewSession();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    if (aiState.value.kind !== "proposal") {
      aiState.value = rendererAiStateSchema.parse({ kind: "idle" });
    }
    feedback.value = "新しいAIセッションを開始しました。";
  } catch {
    showUnexpectedFailure();
  }
}

function appendDelta(delta: { readonly delta: string }): void {
  if (aiState.value.kind !== "streaming") {
    return;
  }
  try {
    aiState.value = rendererAiStateSchema.parse({
      kind: "streaming",
      text: `${aiState.value.text}${delta.delta}`,
    });
  } catch {
    aiState.value = rendererAiStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "invalid_response",
        message: failureText("invalid_response"),
      }),
    });
  }
}

async function startAiTurn(input: AiWorkflowTurnRequest): Promise<void> {
  if (!canWrite.value) {
    feedback.value = "オフライン中はAIを利用できません。";
    return;
  }
  aiBusy.value = true;
  aiState.value = rendererAiStateSchema.parse({ kind: "streaming", text: "" });
  try {
    const request = aiWorkflowTurnRequestSchema.parse(input);
    const result = await window.taskHub.ai.startTurn(request);
    if (isFailure(result)) {
      showFailure(result);
      aiState.value = rendererAiStateSchema.parse({ kind: "unavailable", failure: displayFailure(result) });
      return;
    }
    if (result.value.kind === "proposal") {
      const proposal = aiWorkflowProposalViewSchema.parse(result.value.proposal);
      aiState.value = rendererAiStateSchema.parse({
        kind: "proposal",
        message: result.value.message,
        proposal,
      });
      return;
    }
    aiState.value = rendererAiStateSchema.parse({
      kind: "questions",
      message: result.value.message,
      questions: result.value.questions,
    });
  } catch {
    aiState.value = rendererAiStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "invalid_response",
        message: failureText("invalid_response"),
      }),
    });
  } finally {
    aiBusy.value = false;
  }
}

function proposalState(proposal: AiWorkflowProposalView): void {
  const message = aiState.value.kind === "proposal" ? aiState.value.message : "変更案を更新しました。";
  aiState.value = rendererAiStateSchema.parse({ kind: "proposal", message, proposal });
}

async function selectAiProposal(input: AiWorkflowSelectionRequest): Promise<void> {
  try {
    const request = aiWorkflowSelectionRequestSchema.parse(input);
    const result = await window.taskHub.ai.select(request);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    proposalState(aiWorkflowProposalViewSchema.parse(result.value));
  } catch {
    showUnexpectedFailure();
  }
}

async function editAiOperation(input: AiWorkflowOperationEdit): Promise<void> {
  try {
    const request = aiWorkflowOperationEditSchema.parse(input);
    const result = await window.taskHub.ai.editOperation(request);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    proposalState(aiWorkflowProposalViewSchema.parse(result.value));
  } catch {
    showUnexpectedFailure();
  }
}

async function approveAiProposal(input: AiWorkflowApprovalRequest): Promise<void> {
  if (!canWrite.value) {
    feedback.value = "オフライン中は変更案を適用できません。";
    return;
  }
  try {
    const request = aiWorkflowApprovalRequestSchema.parse(input);
    const result = await window.taskHub.ai.approve(request);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    aiState.value = rendererAiStateSchema.parse({
      kind: "applied",
      message: "適用結果を確認してください。",
      result: result.value,
    });
    await manualSync();
  } catch {
    showUnexpectedFailure();
  }
}

async function rejectAiProposal(proposalId: string): Promise<void> {
  try {
    const result = await window.taskHub.ai.reject(proposalId);
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    aiState.value = rendererAiStateSchema.parse({ kind: "idle" });
    feedback.value = "変更案を却下しました。";
  } catch {
    showUnexpectedFailure();
  }
}

async function loadInitialSyncState(): Promise<void> {
  try {
    const result = await window.taskHub.sync.getState();
    if (isFailure(result)) {
      showFailure(result);
      return;
    }
    handleSyncState(result.value);
  } catch {
    feedback.value = "同期状態を取得できませんでした。";
  }
}

async function loadInitialCodexStatus(): Promise<void> {
  try {
    const result = await window.taskHub.ai.getStatus();
    if (isFailure(result)) {
      codexState.value = rendererCodexStateSchema.parse({
        kind: "unavailable",
        failure: displayFailure(result),
      });
      return;
    }
    handleCodexStatus(result.value);
  } catch {
    codexState.value = rendererCodexStateSchema.parse({
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "unavailable",
        message: failureText("unavailable"),
      }),
    });
  }
}

async function initialize(): Promise<void> {
  try {
    appVersion.value = await window.taskHub.app.getVersion();
  } catch {
    appVersion.value = "取得不可";
  }
  try {
    removeSyncSubscription = window.taskHub.sync.onState((value) => {
      try {
        handleSyncState(value);
      } catch {
        feedback.value = "同期状態を確認できませんでした。";
      }
    });
  } catch {
    syncState.value = rendererSyncStateSchema.parse({
      kind: "error",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "unavailable",
        message: failureText("unavailable"),
      }),
    });
  }
  try {
    removeAiSubscription = window.taskHub.ai.onDelta((delta) => {
      appendDelta(delta);
    });
  } catch {
    codexState.value = {
      kind: "unavailable",
      failure: rendererFailureSchema.parse({
        kind: "error",
        code: "unavailable",
        message: failureText("unavailable"),
      }),
    };
  }
  try {
    removeAiStatusSubscription = window.taskHub.ai.onStatus((value) => {
      try {
        handleCodexStatus(value);
      } catch {
        codexState.value = rendererCodexStateSchema.parse({
          kind: "unavailable",
          failure: rendererFailureSchema.parse({
            kind: "error",
            code: "invalid_response",
            message: failureText("invalid_response"),
          }),
        });
      }
    });
  } catch {
    feedback.value = "Codex状態を購読できませんでした。";
  }
  try {
    const result = await window.taskHub.setup.getState();
    if (isFailure(result)) {
      setScreenError(result);
    } else {
      applySetupState(result.value);
    }
  } catch {
    screen.value = createErrorScreenState("operation_failed", failureText("operation_failed"));
  }
  if (setupState.value?.kind === "ready") {
    await loadObsidianVaults();
  }
  await loadInitialSyncState();
  await loadInitialCodexStatus();
}

onMounted(() => {
  clockTimer = window.setInterval(() => {
    currentAsOf.value = new Date().toISOString();
  }, 60_000);
  void initialize();
});

onUnmounted(() => {
  if (clockTimer != null) {
    window.clearInterval(clockTimer);
  }
  if (removeSyncSubscription != null) {
    removeSyncSubscription();
  }
  if (removeAiSubscription != null) {
    removeAiSubscription();
  }
  if (removeAiStatusSubscription != null) {
    removeAiStatusSubscription();
  }
});
</script>

<template>
  <div class="min-h-screen bg-slate-100 text-slate-900">
    <AppHeader
      :sync-state="syncState"
      :last-sync-at="lastSyncAt"
      :online="online"
      :can-manual-sync="canManualSync"
      :can-write="canWrite"
      :codex-state="codexState"
      :codex-authentication-busy="setupBusy"
      :app-version="appVersion"
      :cleanup-count="cleanupCount"
      @sync="manualSync"
      @new-ai-session="startAiSession"
      @complete-codex-authentication="completeCodexAuthenticationFromHeader"
    />
    <main class="mx-auto flex w-full max-w-[1600px] flex-col gap-5 px-4 py-5 lg:px-6">
      <p
        v-if="feedback.length > 0"
        class="rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-900"
        role="status"
        aria-live="polite"
      >
        {{ feedback }}
      </p>
      <div
        v-if="screen.kind === 'loading'"
        class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
        role="status"
      >
        読み込み中です。
      </div>
      <SetupWizard
        v-else-if="screen.kind === 'setup'"
        :state="setupState"
        :busy="setupBusy"
        @action="handleSetupAction"
      />
      <div
        v-else-if="screen.kind === 'error'"
        class="rounded-xl border border-rose-200 bg-white p-8"
        role="alert"
      >
        <h2 class="text-xl font-semibold text-rose-900">
          画面を読み込めません
        </h2><p class="mt-2 text-sm text-rose-800">
          {{ screen.failure.message }}
        </p>
      </div>
      <template v-else>
        <section
          v-if="overview != null"
          class="space-y-5"
          aria-label="タスク管理画面"
        >
          <div class="flex flex-wrap items-end justify-between gap-4">
            <TaskFilters
              v-model="filter"
              :areas="overview.areas"
              :disabled="false"
            /><p class="text-sm text-slate-600">
              {{ visibleRows.length }}件を表示
            </p>
          </div>
          <section
            v-if="overview.cleanup_items.length > 0"
            class="rounded-xl border border-amber-200 bg-amber-50 p-4"
            aria-labelledby="cleanup-title"
          >
            <h2
              id="cleanup-title"
              class="text-lg font-semibold text-amber-950"
            >
              要整理項目
            </h2>
            <ul class="mt-3 grid gap-2 text-sm text-amber-950 lg:grid-cols-2">
              <li
                v-for="item in overview.cleanup_items"
                :key="`${item.kind}-${item.message}-${cleanupScopeLabel(item)}`"
                class="rounded-md border border-amber-200 bg-white p-3"
              >
                <p class="font-medium">
                  {{ cleanupKindLabel(item.kind) }}・{{ cleanupScopeLabel(item) }}
                </p>
                <p class="mt-1">
                  {{ item.message }}
                </p>
                <p
                  v-if="cleanupRelatedGids(item).length > 0"
                  class="mt-1 text-xs"
                >
                  {{ cleanupRelatedGids(item) }}
                </p>
              </li>
            </ul>
          </section>
          <div class="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(24rem,1fr)]">
            <TaskList
              :rows="visibleRows"
              :selected-task-gid="selectedTaskGid"
              :as-of="currentAsOf"
              @select="selectTask"
            /><TaskDetail
              :task="selectedTask"
              :areas="overview.areas"
              :can-write="canWrite"
              :read-available="canReadLocal"
              :obsidian-vault-ids="registeredVaultIds"
              :obsidian-notes="obsidianNotes"
              :obsidian-search-results="obsidianSearchResults"
              :obsidian-statuses="obsidianStatuses"
              :obsidian-busy="obsidianBusy"
              @edit="applyGuiEdit"
              @list-obsidian="listObsidian"
              @search-obsidian="searchObsidian"
              @check-obsidian="checkObsidianLink"
              @open-obsidian="openObsidianLink"
            />
          </div>
          <AiPanel
            :state="aiState"
            :can-write="canWrite && !aiBusy"
            @start="startAiTurn"
            @select="selectAiProposal"
            @edit="editAiOperation"
            @approve="approveAiProposal"
            @reject="rejectAiProposal"
          />
        </section>
        <div
          v-else
          class="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600"
          role="status"
        >
          タスク一覧を読み込んでいます。
        </div>
      </template>
    </main>
  </div>
</template>
