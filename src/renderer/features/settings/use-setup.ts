import { computed, ref } from "vue";
import { settingsContracts, type SettingsApi } from "../../../shared/ipc-contracts/settings";
import type { SetupState } from "../../../shared/ipc-contracts/setup-schemas";
import type { SetupAction } from "./setup-action";

type SetupFeedback = { readonly kind: "failure" | "warning"; readonly message: string };
type SetupOptions = {
  readonly onState: (state: SetupState) => void;
  readonly onFeedback: (feedback: SetupFeedback) => void;
  readonly onToast: (kind: "success", message: string) => void;
  readonly onReady: () => Promise<void>;
  readonly onCodexAuthentication: () => Promise<void>;
};

/** 初回設定の状態遷移と要求を所有します。 */
export function useSetup(api: SettingsApi, options: SetupOptions) {
  const state = ref<SetupState>();
  const busy = ref(false);
  const configured = computed(() => state.value?.kind === "ready");

  function applyState(next: SetupState): void {
    state.value = next;
    options.onState(state.value);
  }

  async function load(): Promise<SetupState | undefined> {
    const result = settingsContracts.getState.response.parse(await api.getState());
    if (result.kind === "error") {
      options.onFeedback({ kind: "failure", message: failureMessage(result) });
      return undefined;
    }
    applyState(result.value);
    return result.value;
  }

  async function resynchronize(): Promise<void> {
    const result = settingsContracts.getState.response.parse(await api.getState());
    if (result.kind === "error") {
      options.onFeedback({ kind: "failure", message: failureMessage(result) });
      return;
    }
    applyState(result.value);
  }

  function requestFor(action: SetupAction): ReturnType<SettingsApi["getState"]> {
    switch (action.kind) {
      case "start":
        return api.start();
      case "complete_codex_authentication":
        return api.completeCodexAuthentication();
      case "begin_asana_authorization":
        return api.beginAsanaAuthorization(settingsContracts.beginAsanaAuthorization.request.parse(action.input));
      case "complete_asana_authorization":
        return api.completeAsanaAuthorization(settingsContracts.completeAsanaAuthorization.request.parse(action.input));
      case "cancel_asana_authorization":
        return api.cancelAsanaAuthorization(settingsContracts.cancelAsanaAuthorization.request.parse(action.input));
      case "list_workspaces":
        return api.listWorkspaces();
      case "select_workspace":
        return api.selectWorkspace(settingsContracts.selectWorkspace.request.parse({ workspace_gid: action.workspaceGid }).workspace_gid);
      case "select_project":
        return api.selectProject(settingsContracts.selectProject.request.parse(action.input));
      case "retry_resources":
        return api.retryResources();
      case "run_capability":
        return api.runCapability();
      case "choose_vault":
        return api.chooseVault(settingsContracts.chooseVault.request.parse(action.input));
      case "choose_external_tool":
        return api.chooseExternalTool(settingsContracts.chooseExternalTool.request.parse(action.input));
      case "run_full_sync":
        return api.runFullSync();
      case "run_codex_capability":
        return api.runCodexCapability();
    }
  }

  async function act(action: SetupAction): Promise<void> {
    if (busy.value) {
      return;
    }
    busy.value = true;
    try {
      const previousKind = state.value?.kind;
      const request = requestFor(action);
      let response: Awaited<ReturnType<SettingsApi["getState"]>>;
      try {
        response = await request;
      } catch {
        options.onFeedback({ kind: "failure", message: "設定操作を完了できませんでした。状態を確認して再試行してください。" });
        await resynchronize();
        return;
      }
      const result = settingsContracts.getState.response.parse(response);
      if (result.kind === "error") {
        options.onFeedback({ kind: "failure", message: failureMessage(result) });
        await resynchronize();
        return;
      }
      if (previousKind === "ready" && action.kind === "complete_codex_authentication" && result.value.kind !== "ready") {
        throw new Error("設定済み状態のCodex認証結果が不正です。");
      }
      applyState(result.value);
      if (result.value.kind === "external_tool_configured") {
        options.onToast("success", "Discord読取連携を登録しました。");
      }
      if (result.value.kind === "ready" && previousKind !== "ready") {
        await options.onReady();
      }
      if (previousKind === "ready" && action.kind === "complete_codex_authentication") {
        await options.onCodexAuthentication();
      }
    } finally {
      busy.value = false;
    }
  }

  return { state, busy, configured, load, act };
}

type SetupFailure = Extract<Awaited<ReturnType<SettingsApi["getState"]>>, { readonly kind: "error" }>;

function failureMessage(failure: SetupFailure): string {
  return `${failure.message}${failure.error_id == null ? "" : ` エラーID ${failure.error_id}`}`;
}
