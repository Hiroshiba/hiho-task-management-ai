import { onBeforeUnmount, onMounted } from "vue";
import type { IpcResult } from "../../shared/ipc-contracts/common";
import { systemContracts } from "../../shared/ipc-contracts/system";
import { useDiagnosticsApi, useSystemApi } from "../shared/api/feature-apis";
import { reportRendererError } from "../shared/logging/report-renderer-error";

type StartupFailure = Extract<IpcResult<{ completed: true }>, { kind: "error" }>;

/** 起動待ちを実行し、画面の初期化へ接続します。 */
export function useAppStartup(
  onReady: () => Promise<void>,
  onFailure: (failure: StartupFailure) => void,
  onUnexpectedFailure: () => void,
): void {
  const system = useSystemApi();
  const diagnostics = useDiagnosticsApi();
  let mounted = false;

  onMounted(() => {
    mounted = true;
    void start();
  });
  onBeforeUnmount(() => {
    mounted = false;
  });

  async function start(): Promise<void> {
    try {
      const result = systemContracts.waitForStartup.response.parse(await system.waitForStartup());
      if (!mounted) {
        return;
      }
      if (result.kind === "error") {
        onFailure(result);
        return;
      }
      await onReady();
    } catch (error) {
      void reportRendererError(diagnostics, error, "error");
      if (mounted) {
        onUnexpectedFailure();
      }
    }
  }
}
