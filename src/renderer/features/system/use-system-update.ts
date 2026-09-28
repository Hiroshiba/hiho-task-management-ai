import { onBeforeUnmount, onMounted, shallowRef, type ShallowRef } from "vue";
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

  onMounted(() => {
    mounted = true;
    void initialize();
  });
  onBeforeUnmount(() => {
    mounted = false;
    removeSubscription?.();
  });

  async function initialize(): Promise<void> {
    let eventReceived = false;
    try {
      removeSubscription = system.onUpdateState((value) => {
        try {
          state.value = systemUpdateStateSchema.parse(value);
          eventReceived = true;
        } catch (error) {
          state.value = systemUpdateStateSchema.parse({ kind: "failed", phase: "check" });
          eventReceived = true;
          void reportRendererError(diagnostics, error, "error");
        }
      });
      const result = systemContracts.getUpdateState.response.parse(await system.getUpdateState());
      if (!mounted || eventReceived) {
        return;
      }
      state.value = result.kind === "error"
        ? systemUpdateStateSchema.parse({ kind: "failed", phase: "check" })
        : result.value;
    } catch (error) {
      void reportRendererError(diagnostics, error, "error");
      if (mounted && !eventReceived) {
        state.value = systemUpdateStateSchema.parse({ kind: "failed", phase: "check" });
      }
    }
  }

  return state;
}
