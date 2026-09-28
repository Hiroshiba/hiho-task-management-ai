import { computed, onUnmounted, ref, type Ref } from "vue";
import { z } from "zod";
import { syncResultSchema, syncStateSchema, tasksContracts, type TasksApi } from "../../../shared/ipc-contracts/tasks";
import { useDiagnosticsApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";
import type { useTaskRead } from "./use-task-read";

const displaySyncStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("waiting") }).strict(),
  z.object({ kind: z.literal("syncing"), can_accept_write: z.boolean() }).strict(),
  z.object({ kind: z.literal("synced"), synced_at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal("authentication_required") }).strict(),
  z.object({ kind: z.literal("recovery_pending") }).strict(),
  z.object({ kind: z.literal("error"), error_code: z.enum([
    "payment_required", "rate_limited", "http_error", "transport_error", "response_error",
    "request_aborted", "sync_in_progress", "unexpected_error",
  ]) }).strict(),
]);
const connectionStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("checking"), sync: displaySyncStateSchema }).strict(),
  z.object({ kind: z.literal("online"), sync: displaySyncStateSchema }).strict(),
  z.object({ kind: z.literal("offline"), sync: displaySyncStateSchema }).strict(),
]);

export type TaskSyncState = z.infer<typeof displaySyncStateSchema>;
export type TaskConnectionState = z.infer<typeof connectionStateSchema>;
type SyncStateEvent = z.infer<typeof syncStateSchema>;
type SyncResult = z.infer<typeof syncResultSchema>;
type SyncErrorCode = Extract<SyncStateEvent, { readonly kind: "error" }>["error_code"];
type NormalizationNotification = SyncResult["normalization_notifications"][number];

export type TaskSyncOptions = {
  readonly configured: Ref<boolean>;
  readonly historyClear: Ref<boolean>;
  readonly authenticationBusy: Ref<boolean>;
  readonly onFeedback: (kind: "success" | "progress" | "warning" | "failure", message: string) => void;
  readonly onToast: (kind: "success" | "warning", message: string) => void;
  readonly onSyncingChange: (isSyncing: boolean) => void;
};

/** 同期状態と同期要求を管理します。 */
export function useTaskSync(api: TasksApi, read: ReturnType<typeof useTaskRead>, options: TaskSyncOptions) {
  const diagnostics = useDiagnosticsApi();
  const connectionState = ref<TaskConnectionState>(connectionStateSchema.parse({ kind: "checking", sync: { kind: "waiting" } }));
  const activeSyncMode = ref<"idle" | "delta" | "full">("idle");
  const syncState = computed(() => connectionState.value.sync);
  const authenticationRequired = computed(() => syncState.value.kind === "authentication_required");
  const canManualSync = computed(() => options.configured.value
    && options.historyClear.value
    && activeSyncMode.value === "idle"
    && !options.authenticationBusy.value
    && connectionState.value.kind === "online"
    && syncState.value.kind !== "syncing"
    && syncState.value.kind !== "authentication_required"
    && syncState.value.kind !== "recovery_pending");
  const canAcceptWrite = computed(() => {
    if (!options.historyClear.value) return false;
    const currentOverview = read.overview.value;
    const currentSyncState = syncState.value;
    if (connectionState.value.kind !== "online" || currentOverview == null) return false;
    if (currentSyncState.kind === "syncing") return currentSyncState.can_accept_write;
    if (currentSyncState.kind !== "synced") return false;
    return syncTimestamp(currentOverview.last_successful_sync_at) >= syncTimestamp(currentSyncState.synced_at);
  });
  let removeSyncSubscription: (() => void) | undefined;
  let normalizationDisplayedAt: string | undefined;

  onUnmounted(() => {
    removeSyncSubscription?.();
  });

  function subscribeSyncState(): void {
    try {
      removeSyncSubscription = api.onSyncState((value) => {
        try {
          handleSyncState(value);
        } catch (error) {
          void reportRendererError(diagnostics, error, "error");
          options.onFeedback("failure", "同期状態を確認できませんでした。");
        }
      });
    } catch (error) {
      void reportRendererError(diagnostics, error, "error");
      setSyncState({ kind: "error", error_code: "unexpected_error" });
      options.onFeedback("failure", "同期状態を購読できませんでした。");
    }
  }

  function setConnectionState(kind: TaskConnectionState["kind"], sync: TaskSyncState): void {
    connectionState.value = connectionStateSchema.parse({ kind, sync });
    options.onSyncingChange(sync.kind === "syncing");
  }

  function setSyncState(sync: TaskSyncState): void {
    setConnectionState(connectionState.value.kind, sync);
  }

  function markAuthenticationRequired(): void {
    setSyncState({ kind: "authentication_required" });
  }

  function chromiumConnectionState(): TaskConnectionState["kind"] {
    return window.navigator.onLine ? "online" : "offline";
  }

  function connectionStateForSyncFailure(errorCode: SyncErrorCode): TaskConnectionState["kind"] {
    const current = chromiumConnectionState();
    return errorCode === "transport_error" && current === "online" ? "checking" : current;
  }

  function syncFailureState(errorCode: SyncErrorCode): TaskSyncState {
    if (errorCode === "authentication_required") return { kind: "authentication_required" };
    if (errorCode === "events_reset") return { kind: "recovery_pending" };
    return displaySyncStateSchema.parse({ kind: "error", error_code: errorCode });
  }

  function settledSyncState(value: Extract<SyncStateEvent, { readonly kind: "online" | "offline" }>): TaskSyncState {
    if (value.last_error_code != null) return syncFailureState(value.last_error_code);
    return value.last_successful_sync_at == null
      ? { kind: "waiting" }
      : { kind: "synced", synced_at: value.last_successful_sync_at };
  }

  function applySyncStateDisplay(value: SyncStateEvent): void {
    const state = syncStateSchema.parse(value);
    if (state.kind === "syncing") {
      setConnectionState(chromiumConnectionState(), {
        kind: "syncing",
        can_accept_write: state.last_successful_sync_at != null && state.last_error_code == null,
      });
      return;
    }
    if (state.kind === "offline") {
      const current = chromiumConnectionState();
      if (state.last_error_code != null) {
        setConnectionState(connectionStateForSyncFailure(state.last_error_code), settledSyncState(state));
      } else if (current === "online") {
        setConnectionState("online", { kind: "recovery_pending" });
      } else {
        setConnectionState("offline", settledSyncState(state));
      }
      return;
    }
    if (state.kind === "authentication_required") {
      setConnectionState(chromiumConnectionState(), { kind: "authentication_required" });
      return;
    }
    if (state.kind === "error") {
      setConnectionState(connectionStateForSyncFailure(state.error_code), syncFailureState(state.error_code));
      return;
    }
    if (state.last_error_code != null) {
      setConnectionState(connectionStateForSyncFailure(state.last_error_code), settledSyncState(state));
      return;
    }
    setConnectionState(chromiumConnectionState(), settledSyncState(state));
  }

  function showNormalizationNotificationToast(syncedAt: string, notifications: readonly NormalizationNotification[]): void {
    if (notifications.length === 0 || normalizationDisplayedAt === syncedAt) return;
    const message = normalizationNotificationMessage(notifications);
    if (message == null) throw new Error("状態整合化通知を表示できません。");
    options.onToast("success", message);
    normalizationDisplayedAt = syncedAt;
  }

  function handleSyncState(value: SyncStateEvent): void {
    if (value.last_successful_sync_at != null && options.configured.value) {
      void read.reloadTaskDataAfterSuccessfulSync(value.last_successful_sync_at);
    }
    applySyncStateDisplay(value);
    if (value.kind === "online" && value.normalization_notifications != null && value.normalization_notifications.length > 0) {
      if (value.last_successful_sync_at == null) throw new Error("状態整合化通知に同期日時がありません。");
      showNormalizationNotificationToast(value.last_successful_sync_at, value.normalization_notifications);
    }
  }

  async function readCurrentSyncState(): Promise<{ readonly kind: "received"; readonly value: SyncStateEvent } | { readonly kind: "unavailable" }> {
    const result = tasksContracts.getSyncState.response.parse(await api.getSyncState());
    return result.kind === "ok" ? { kind: "received", value: result.value } : { kind: "unavailable" };
  }

  async function reconcileSyncStateAfterFailure(fallback: TaskSyncState): Promise<void> {
    setSyncState(fallback);
    const result = await readCurrentSyncState();
    if (result.kind === "received") handleSyncState(result.value);
  }

  async function reconcileAuthenticationFailure(): Promise<void> {
    await reconcileSyncStateAfterFailure({ kind: "authentication_required" });
  }

  async function completeAuthenticationSync(syncedAt: string): Promise<boolean> {
    setConnectionState("online", { kind: "synced", synced_at: syncedAt });
    const refresh = await read.reloadTaskDataAfterSuccessfulSync(syncedAt);
    return refresh.kind !== "failed";
  }

  async function completeHistorySync(syncedAt: string): Promise<void> {
    setConnectionState(chromiumConnectionState(), { kind: "synced", synced_at: syncedAt });
    const refresh = await read.reloadTaskDataAfterSuccessfulSync(syncedAt);
    if (refresh.kind === "applied" || refresh.kind === "unchanged") {
      options.onToast("success", "旧適用履歴の読取同期が完了しました。書き込みを再開できます。");
    }
  }

  async function loadInitialSyncState(): Promise<void> {
    const result = tasksContracts.getSyncState.response.parse(await api.getSyncState());
    if (result.kind === "error") {
      options.onFeedback("failure", failureMessage(result));
      return;
    }
    handleSyncState(result.value);
  }

  async function runSynchronization(mode: "delta" | "full"): Promise<void> {
    if (!canManualSync.value) return;
    activeSyncMode.value = mode;
    setSyncState({ kind: "syncing", can_accept_write: canAcceptWrite.value });
    try {
      const result = tasksContracts.runSync.response.parse(await api.runSync(mode));
      if (result.kind === "error") {
        options.onFeedback("failure", failureMessage(result));
        await reconcileSyncStateAfterFailure(result.code === "authentication_required"
          ? { kind: "authentication_required" }
          : { kind: "error", error_code: "unexpected_error" });
        return;
      }
      setConnectionState(chromiumConnectionState(), { kind: "synced", synced_at: result.value.synced_at });
      const refreshResult = await read.reloadTaskDataAfterSuccessfulSync(result.value.synced_at);
      if (refreshResult.kind === "applied" || refreshResult.kind === "unchanged") {
        showNormalizationNotificationToast(result.value.synced_at, result.value.normalization_notifications);
        const hasWarning = result.value.conflict_count > 0 || result.value.remaining_write_count > 0 || result.value.critical_error_count > 0;
        options.onFeedback(hasWarning ? "warning" : "success", syncFeedbackMessage(result.value));
      }
    } catch (error) {
      const errorId = await reportRendererError(diagnostics, error, "error");
      options.onFeedback("failure", `予期しないエラーが発生しました。もう一度お試しください。${errorId == null ? "" : ` エラーID ${errorId}`}`);
      await reconcileSyncStateAfterFailure({ kind: "error", error_code: "unexpected_error" });
    } finally {
      activeSyncMode.value = "idle";
    }
  }

  async function manualSync(): Promise<void> {
    await runSynchronization("delta");
  }

  async function fullSync(): Promise<void> {
    await runSynchronization("full");
  }

  return { connectionState, syncState, activeSyncMode, canManualSync, canAcceptWrite, authenticationRequired,
    markAuthenticationRequired, reconcileAuthenticationFailure, completeAuthenticationSync, completeHistorySync,
    showNormalizationNotificationToast, subscribeSyncState, loadInitialSyncState, manualSync, fullSync };
}

function syncTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("同期日時を比較できません。");
  return timestamp;
}

function failureMessage(failure: Extract<Awaited<ReturnType<TasksApi["runSync"]>>, { readonly kind: "error" }>): string {
  return `${failure.message}${failure.error_id == null ? "" : ` エラーID ${failure.error_id}`}`;
}

function normalizationNotificationMessage(notifications: readonly NormalizationNotification[]): string | undefined {
  if (notifications.length === 0) return undefined;
  if (notifications.length === 1) return notifications[0]?.message;
  const labels = { not_started: "未着手", in_progress: "進行中", completed: "完了", withdrawn: "取り下げ" };
  const order: readonly NormalizationNotification["status"][] = ["not_started", "in_progress", "completed", "withdrawn"];
  const summaries = order.flatMap((status) => {
    const count = notifications.filter((notification) => notification.status === status).length;
    return count === 0 ? [] : [`${labels[status]} ${count}件`];
  });
  return `タスク状態を整合化しました。対象 ${notifications.length}件。${summaries.join("、")}。`;
}

function syncFeedbackMessage(result: SyncResult): string {
  const notificationMessage = normalizationNotificationMessage(result.normalization_notifications);
  const summary = [
    `同期しました。対象 ${result.affected_count}件`,
    `反映 ${result.applied_count}件`,
    `反映済み ${result.already_applied_count}件`,
    `競合 ${result.conflict_count}件`,
    `残り書き込み ${result.remaining_write_count}件`,
    `重大エラー ${result.critical_error_count}件。`,
  ].join("、");
  return notificationMessage == null ? summary : `${notificationMessage} ${summary}`;
}
