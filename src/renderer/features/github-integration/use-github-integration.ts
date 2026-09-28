import { onBeforeUnmount, ref } from "vue";
import { githubIntegrationContracts } from "../../../shared/ipc-contracts/github-integration";
import { useDiagnosticsApi, useGithubIntegrationApi } from "../../shared/api/feature-apis";
import { reportRendererError } from "../../shared/logging/report-renderer-error";

export type GithubStatusState =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "failure"; readonly message: string };

/** GitHub連携の表示状態を所有します。 */
export function useGithubIntegration() {
  const api = useGithubIntegrationApi();
  const diagnostics = useDiagnosticsApi();
  const state = ref<GithubStatusState>({ kind: "loading" });
  let generation = 0;
  let disposed = false;

  onBeforeUnmount(() => {
    disposed = true;
    generation += 1;
  });

  async function loadStatus(): Promise<void> {
    const requestGeneration = ++generation;
    state.value = { kind: "loading" };
    try {
      const result = githubIntegrationContracts.getStatus.response.parse(await api.getStatus());
      if (disposed || requestGeneration !== generation) return;
      if (result.kind === "error") {
        state.value = {
          kind: "failure",
          message: result.error_id == null
            ? "GitHub連携の状態を確認できませんでした。"
            : "GitHub連携の状態を確認できませんでした。エラーID " + result.error_id,
        };
        return;
      }
      state.value = { kind: "unavailable" };
    } catch (error) {
      await reportRendererError(diagnostics, error, "error");
      if (!disposed && requestGeneration === generation) {
        state.value = { kind: "failure", message: "GitHub連携の状態を確認できませんでした。" };
      }
    }
  }

  return { state, loadStatus };
}
