import { onBeforeUnmount, ref } from "vue";
import { settingsContracts, type SettingsApi } from "../../../shared/ipc-contracts/settings";
import { useDiagnosticsApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";

const pollIntervalMilliseconds = 500;
const maximumRetryCount = 3;

type AuthenticationState = Extract<Awaited<ReturnType<SettingsApi["getAsanaAuthenticationState"]>>, { readonly kind: "ok" }>["value"];
type SynchronizationResult = Extract<Awaited<ReturnType<SettingsApi["completeAsanaReauthentication"]>>, { readonly kind: "ok" }>["value"];
type AuthenticationFailure = Extract<Awaited<ReturnType<SettingsApi["getAsanaAuthenticationState"]>>, { readonly kind: "error" }>;

type AuthenticationOptions = {
  readonly configured: () => boolean;
  readonly authenticationRequired: () => boolean;
  readonly onFeedback: (kind: "success" | "warning" | "failure", message: string) => void;
  readonly onToast: (kind: "warning", message: string) => void;
  readonly onAuthenticationRequired: () => void;
  readonly onAuthenticationIdle: () => Promise<void>;
  readonly onAuthenticationFailure: () => Promise<void>;
  readonly onSynchronized: (result: SynchronizationResult) => Promise<boolean>;
  readonly onNormalizationNotifications: (result: SynchronizationResult) => void;
};

/** Asana再認証の状態、確認タイマー、操作を所有します。 */
export function useAsanaReauthentication(api: SettingsApi, options: AuthenticationOptions) {
  const diagnostics = useDiagnosticsApi();
  const state = ref<AuthenticationState>({ kind: "idle" });
  const busy = ref(false);
  const loaded = ref(false);
  const needsRecheck = ref(true);
  const requestBusy = ref(false);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function clearTimer(): void {
    if (timer != null) {
      globalThis.clearTimeout(timer);
      timer = undefined;
    }
  }

  function advanceGeneration(): number {
    generation += 1;
    clearTimer();
    requestBusy.value = false;
    return generation;
  }

  function schedule(next: AuthenticationState, currentGeneration: number, retryCount: number): void {
    clearTimer();
    if (disposed || currentGeneration !== generation) {
      return;
    }
    let delay: number;
    if (retryCount > 0) {
      if (retryCount > maximumRetryCount) {
        return;
      }
      delay = pollIntervalMilliseconds;
    } else {
      switch (next.kind) {
        case "idle":
          return;
        case "opening":
        case "completing":
        case "synchronizing":
          delay = pollIntervalMilliseconds;
          break;
        case "authorization_pending": {
          const expiresAt = Date.parse(next.expires_at);
          if (!Number.isFinite(expiresAt)) {
            throw new Error("Asana認証の有効期限を確認できません。");
          }
          delay = Math.max(0, expiresAt - Date.now());
          break;
        }
      }
    }
    timer = globalThis.setTimeout(() => {
      timer = undefined;
      if (disposed || currentGeneration !== generation) {
        return;
      }
      void requestState(advanceGeneration(), retryCount).catch(async (error) => {
        const errorId = await reportRendererError(diagnostics, error, "error");
        needsRecheck.value = true;
        options.onFeedback("failure", `Asana認証状態を確認できませんでした。${errorId == null ? "" : ` エラーID ${errorId}`}`);
      });
    }, delay);
  }

  function applyState(next: AuthenticationState, currentGeneration: number, reconcileIdle: boolean, poll: boolean): void {
    if (disposed || currentGeneration !== generation) {
      return;
    }
    const previous = state.value;
    const parsed = settingsContracts.getAsanaAuthenticationState.response.parse({ kind: "ok", value: next });
    if (parsed.kind !== "ok") {
      throw new Error("Asana認証状態を検証できません。");
    }
    state.value = parsed.value;
    needsRecheck.value = false;
    loaded.value = true;
    if (poll) {
      schedule(parsed.value, currentGeneration, 0);
    } else {
      clearTimer();
    }
    if (reconcileIdle && previous.kind !== "idle" && parsed.value.kind === "idle") {
      void options.onAuthenticationIdle().catch(async (error) => {
        const errorId = await reportRendererError(diagnostics, error, "error");
        options.onFeedback("failure", `Asana同期の状態を確認できませんでした。${errorId == null ? "" : ` エラーID ${errorId}`}`);
      });
    }
  }

  async function requestState(currentGeneration: number, retryCount: number): Promise<boolean> {
    requestBusy.value = true;
    try {
      const result = settingsContracts.getAsanaAuthenticationState.response.parse(
        await api.getAsanaAuthenticationState(),
      );
      if (disposed || currentGeneration !== generation) {
        return false;
      }
      if (result.kind === "error") {
        needsRecheck.value = true;
        options.onFeedback("failure", failureMessage(result));
        schedule(state.value, currentGeneration, retryCount + 1);
        return false;
      }
      applyState(result.value, currentGeneration, true, true);
      if (result.value.kind === "opening" || result.value.kind === "authorization_pending") {
        options.onAuthenticationRequired();
      }
      return true;
    } catch (error) {
      const errorId = await reportRendererError(diagnostics, error, "error");
      if (!disposed && currentGeneration === generation) {
        needsRecheck.value = true;
        options.onFeedback("failure", `Asana認証状態を確認できませんでした。${errorId == null ? "" : ` エラーID ${errorId}`}`);
        schedule(state.value, currentGeneration, retryCount + 1);
      }
      return false;
    } finally {
      if (currentGeneration === generation) {
        requestBusy.value = false;
      }
    }
  }

  async function load(): Promise<void> {
    if (busy.value || requestBusy.value) {
      return;
    }
    loaded.value = false;
    needsRecheck.value = true;
    const currentGeneration = advanceGeneration();
    busy.value = true;
    try {
      await requestState(currentGeneration, 0);
    } finally {
      busy.value = false;
    }
  }

  async function recheck(): Promise<void> {
    if (busy.value || requestBusy.value || !options.configured()) {
      return;
    }
    const currentGeneration = advanceGeneration();
    busy.value = true;
    try {
      await requestState(currentGeneration, 0);
    } finally {
      busy.value = false;
    }
  }

  async function reconcileFailure(message: string): Promise<void> {
    needsRecheck.value = true;
    await requestState(advanceGeneration(), 0);
    await options.onAuthenticationFailure();
    options.onFeedback("failure", message);
  }

  async function begin(): Promise<void> {
    if (busy.value || !options.configured() || !options.authenticationRequired()
      || !loaded.value || needsRecheck.value || state.value.kind !== "idle") {
      return;
    }
    const currentGeneration = advanceGeneration();
    busy.value = true;
    try {
      let response: Awaited<ReturnType<SettingsApi["beginAsanaReauthentication"]>>;
      try {
        response = await api.beginAsanaReauthentication();
      } catch (error) {
        const errorId = await reportRendererError(diagnostics, error, "error");
        if (!disposed) {
          await reconcileFailure(`Asana再認証の開始に失敗しました。${errorId == null ? "" : ` エラーID ${errorId}`}`);
        }
        return;
      }
      const result = settingsContracts.beginAsanaReauthentication.response.parse(response);
      if (disposed || currentGeneration !== generation) {
        return;
      }
      if (result.kind === "error") {
        await reconcileFailure(failureMessage(result));
        return;
      }
      if (result.value.kind === "idle") {
        throw new Error("Asana再認証の開始結果が不正です。");
      }
      applyState(result.value, currentGeneration, false, true);
      options.onAuthenticationRequired();
    } finally {
      busy.value = false;
    }
  }

  async function complete(code: string): Promise<void> {
    const pending = state.value;
    if (busy.value || !options.configured() || needsRecheck.value || requestBusy.value
      || pending.kind !== "authorization_pending") {
      return;
    }
    const currentGeneration = advanceGeneration();
    const parsedInput = settingsContracts.completeAsanaReauthentication.request.safeParse({
      authorization_id: pending.authorization_id,
      authorization_code: code.trim(),
    });
    if (!parsedInput.success) {
      schedule(pending, currentGeneration, 0);
      options.onFeedback("warning", "Asana認可コードを確認してください。");
      return;
    }
    busy.value = true;
    applyState({ kind: "completing", authorization_id: pending.authorization_id }, currentGeneration, false, false);
    try {
      let response: Awaited<ReturnType<SettingsApi["completeAsanaReauthentication"]>>;
      try {
        response = await api.completeAsanaReauthentication(parsedInput.data);
      } catch (error) {
        const errorId = await reportRendererError(diagnostics, error, "error");
        if (!disposed) {
          await reconcileFailure(`Asanaの再認証に失敗しました。保存済みのタスクを表示しています。${errorId == null ? "" : ` エラーID ${errorId}`}`);
        }
        return;
      }
      const result = settingsContracts.completeAsanaReauthentication.response.parse(response);
      if (disposed || currentGeneration !== generation) {
        return;
      }
      if (result.kind === "error") {
        await reconcileFailure(failureMessage(result));
        return;
      }
      applyState({ kind: "synchronizing", authorization_id: pending.authorization_id }, currentGeneration, false, false);
      let refreshed: boolean;
      try {
        refreshed = await options.onSynchronized(result.value);
      } catch (error) {
        const errorId = await reportRendererError(diagnostics, error, "error");
        applyState({ kind: "idle" }, advanceGeneration(), false, false);
        options.onFeedback("warning", `Asanaの再認証と同期は完了しました。タスク表示を更新できませんでした。${errorId == null ? "" : ` エラーID ${errorId}`}`);
        return;
      }
      applyState({ kind: "idle" }, advanceGeneration(), false, false);
      const notificationCount = result.value.normalization_notifications.length;
      const hasWarning = result.value.conflict_count > 0
        || result.value.remaining_write_count > 0
        || result.value.critical_error_count > 0
        || result.value.cleanup_count > 0;
      if (refreshed) {
        options.onNormalizationNotifications(result.value);
      }
      options.onFeedback(refreshed ? (hasWarning ? "warning" : "success") : "warning",
        `Asanaを再認証して同期しました。競合 ${result.value.conflict_count}件、残りの書き込み ${result.value.remaining_write_count}件、重大なエラー ${result.value.critical_error_count}件、要整理 ${result.value.cleanup_count}件、状態整合通知 ${notificationCount}件。${refreshed ? "" : "タスク表示を更新できませんでした。"}`);
    } finally {
      busy.value = false;
    }
  }

  async function cancel(): Promise<void> {
    const pending = state.value;
    if (busy.value || !options.configured() || needsRecheck.value || requestBusy.value
      || pending.kind !== "authorization_pending") {
      return;
    }
    const currentGeneration = advanceGeneration();
    const input = settingsContracts.cancelAsanaReauthentication.request.parse({
      authorization_id: pending.authorization_id,
    });
    busy.value = true;
    try {
      let response: Awaited<ReturnType<SettingsApi["cancelAsanaReauthentication"]>>;
      try {
        response = await api.cancelAsanaReauthentication(input);
      } catch (error) {
        const errorId = await reportRendererError(diagnostics, error, "error");
        if (!disposed) {
          await reconcileFailure(`Asana再認証のキャンセルに失敗しました。${errorId == null ? "" : ` エラーID ${errorId}`}`);
        }
        return;
      }
      const result = settingsContracts.cancelAsanaReauthentication.response.parse(response);
      if (disposed || currentGeneration !== generation) {
        return;
      }
      if (result.kind === "error") {
        await reconcileFailure(failureMessage(result));
        return;
      }
      if (result.value.kind !== "idle") {
        throw new Error("Asana再認証の取消結果が不正です。");
      }
      applyState(result.value, currentGeneration, false, true);
      options.onAuthenticationRequired();
      options.onToast("warning", "Asana再認証をキャンセルしました。");
    } finally {
      busy.value = false;
    }
  }

  function reset(): void {
    advanceGeneration();
    loaded.value = false;
    needsRecheck.value = true;
    state.value = { kind: "idle" };
  }

  onBeforeUnmount(() => {
    disposed = true;
    reset();
  });

  return { state, busy, loaded, needsRecheck, requestBusy, load, recheck, begin, complete, cancel, reset };
}

function failureMessage(failure: AuthenticationFailure): string {
  return `${failure.message}${failure.error_id == null ? "" : ` エラーID ${failure.error_id}`}`;
}
