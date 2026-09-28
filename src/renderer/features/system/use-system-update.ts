import { onBeforeUnmount, onMounted, shallowRef, type ShallowRef } from "vue";
import type { IpcSubscriptionFailure } from "../../../shared/ipc-contracts/common";
import {
  systemContracts,
  systemUpdateStateSchema,
  type SystemUpdateState,
} from "../../../shared/ipc-contracts/system";
import { useDiagnosticsApi, useSystemApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";

/** 自動更新の表示状態と購読を所有します。 */
export function useSystemUpdate(): Readonly<ShallowRef<SystemUpdateState>> {
  const system = useSystemApi();
  const diagnostics = useDiagnosticsApi();
  const state = shallowRef<SystemUpdateState>(systemUpdateStateSchema.parse({ kind: "idle" }));
  let removeSubscription: (() => void) | undefined;
  let mounted = false;
  let eventGeneration = 0;
  let pendingFailureId: string | undefined;

  onMounted(() => {
    mounted = true;
    void initialize();
  });
  onBeforeUnmount(() => {
    mounted = false;
    removeSubscription?.();
  });

  async function initialize(): Promise<void> {
    const initialGeneration = eventGeneration;
    try {
      removeSubscription = system.onUpdateState((value) => {
        state.value = systemUpdateStateSchema.parse(value);
        eventGeneration += 1;
        pendingFailureId = undefined;
      }, handleSubscriptionFailure);
      const result = systemContracts.getUpdateState.response.parse(await system.getUpdateState());
      if (!mounted || initialGeneration !== eventGeneration) {
        return;
      }
      state.value = result.kind === "error"
        ? systemUpdateStateSchema.parse({ kind: "failed", phase: "check", ...(result.error_id == null ? {} : { error_id: result.error_id }) })
        : result.value;
    } catch (error) {
      const errorId = await reportRendererError(diagnostics, error, "error");
      if (mounted && initialGeneration === eventGeneration) {
        state.value = systemUpdateStateSchema.parse({ kind: "failed", phase: "check", ...(errorId == null ? {} : { error_id: errorId }) });
      }
    }
  }

  function handleSubscriptionFailure(failure: IpcSubscriptionFailure): void {
    if (!mounted) return;
    if (failure.kind === "started") {
      eventGeneration += 1;
      pendingFailureId = failure.failure_id;
      state.value = systemUpdateStateSchema.parse({ kind: "failed", phase: "check" });
      return;
    }
    if (pendingFailureId !== failure.failure_id) return;
    pendingFailureId = undefined;
    state.value = systemUpdateStateSchema.parse({
      kind: "failed",
      phase: "check",
      ...(failure.kind === "reported" ? { error_id: failure.error_id } : {}),
    });
  }

  return state;
}
