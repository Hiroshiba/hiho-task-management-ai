import { computed, onBeforeUnmount, ref } from "vue";
import { proposalsContracts, type ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import { useDiagnosticsApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";

type HistoryStatus = Extract<Awaited<ReturnType<ProposalsApi["getHistoryStatus"]>>, { readonly kind: "ok" }>["value"];
type HistoryConfirmInput = Parameters<ProposalsApi["confirmHistory"]>[0];

/** 旧非実行履歴の取得、確認、読取同期の画面状態を管理します。 */
export function useProposalHistory(api: ProposalsApi) {
  const diagnostics = useDiagnosticsApi();
  const status = ref<HistoryStatus>();
  const errorMessage = ref<string>();
  const busy = ref(false);
  const clear = computed(() => status.value?.entries.length === 0);
  const canSynchronize = computed(() => {
    const entries = status.value?.entries;
    return entries != null && entries.length > 0
      && entries.every((entry) => entry.kind === "synchronization_required");
  });
  let requestGeneration = 0;
  let disposed = false;

  onBeforeUnmount(() => {
    disposed = true;
    requestGeneration += 1;
  });

  async function load(): Promise<void> {
    const generation = ++requestGeneration;
    status.value = undefined;
    errorMessage.value = undefined;
    try {
      const result = proposalsContracts.getHistoryStatus.response.parse(await api.getHistoryStatus());
      if (disposed || generation !== requestGeneration) return;
      if (result.kind === "error") {
        errorMessage.value = result.message;
        return;
      }
      status.value = result.value;
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && generation === requestGeneration) errorMessage.value = "旧適用履歴を読み込めませんでした。";
    }
  }

  async function confirm(input: HistoryConfirmInput): Promise<boolean> {
    if (busy.value) return false;
    const request = proposalsContracts.confirmHistory.request.parse(input);
    const entry = status.value?.entries.find((candidate) => candidate.proposal_id === request.proposal_id
      && candidate.operation_id === request.operation_id);
    if (entry?.kind !== "confirmation_required" || entry.target_id !== request.checked_target_id) {
      errorMessage.value = "確認対象の履歴が変わりました。履歴を再読込してください。";
      return false;
    }
    busy.value = true;
    const generation = ++requestGeneration;
    errorMessage.value = undefined;
    try {
      const result = proposalsContracts.confirmHistory.response.parse(await api.confirmHistory(request));
      if (disposed || generation !== requestGeneration) return false;
      if (result.kind === "error") {
        errorMessage.value = result.message;
        return false;
      }
      status.value = result.value;
      return true;
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && generation === requestGeneration) errorMessage.value = "旧適用履歴の確認結果を保存できませんでした。";
      return false;
    } finally {
      busy.value = false;
    }
  }

  async function synchronize(): Promise<string | undefined> {
    if (busy.value || !canSynchronize.value) return undefined;
    busy.value = true;
    const generation = ++requestGeneration;
    errorMessage.value = undefined;
    try {
      const result = proposalsContracts.synchronizeHistory.response.parse(await api.synchronizeHistory());
      if (disposed || generation !== requestGeneration) return undefined;
      if (result.kind === "error") {
        errorMessage.value = result.message;
        return undefined;
      }
      status.value = result.value.status;
      return result.value.synced_at;
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && generation === requestGeneration) {
        errorMessage.value = "旧適用履歴の読取同期に失敗しました。確認済みの結果は保存されています。";
      }
      return undefined;
    } finally {
      busy.value = false;
    }
  }

  return { status, errorMessage, busy, clear, canSynchronize, load, confirm, synchronize };
}
