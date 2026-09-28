import type { IpcResult } from "../../shared/ipc-contracts/common";
import type { SetupState } from "../../shared/ipc-contracts/setup-schemas";
import { useAppScreen } from "./use-app-screen";
import { useAppStartup } from "./use-app-startup";

type StartupFailure = Extract<IpcResult<unknown>, { readonly kind: "error" }>;
type BootstrapOptions = {
  readonly subscribeSyncState: () => void;
  readonly initializeProposals: () => Promise<void>;
  readonly loadSetup: () => Promise<SetupState | undefined>;
  readonly loadVaults: () => Promise<void>;
  readonly loadSyncState: () => Promise<void>;
  readonly loadAuthentication: () => Promise<void>;
  readonly onSetupReady: () => void;
};
type AppBootstrap = {
  readonly screen: ReturnType<typeof useAppScreen>["screen"];
  readonly handleSetupState: (state: SetupState) => void;
};

/** 起動順と画面遷移を管理します。 */
export function useAppBootstrap(options: BootstrapOptions): AppBootstrap {
  const { screen, showSetup, showDashboard, showError } = useAppScreen();

  function handleSetupState(state: SetupState): void {
    if (state.kind === "ready") {
      showDashboard();
      options.onSetupReady();
    } else {
      showSetup();
    }
  }

  async function initialize(): Promise<void> {
    options.subscribeSyncState();
    await options.initializeProposals();
    const state = await options.loadSetup();
    if (state == null) {
      showError("初回設定の状態を読み込めませんでした。");
      return;
    }
    if (state.kind === "ready") {
      await options.loadVaults();
    }
    await options.loadSyncState();
    if (state.kind === "ready") {
      await options.loadAuthentication();
    }
  }

  useAppStartup(initialize, (failure) => showError(startupFailureText(failure.code)), () => {
    showError(startupFailureText("operation_failed"));
  });

  return { screen, handleSetupState };
}

function startupFailureText(code: StartupFailure["code"]): string {
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
