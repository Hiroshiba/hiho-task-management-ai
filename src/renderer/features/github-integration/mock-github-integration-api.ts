import { githubIntegrationContracts, type GithubIntegrationApi } from "../../../shared/ipc-contracts/github-integration";

/** GitHub連携の利用不可状態を返す画面確認用APIを作成します。 */
export function createMockGithubIntegrationApi(): GithubIntegrationApi {
  return {
    getStatus: () => Promise.resolve(githubIntegrationContracts.getStatus.response.parse({
      kind: "ok",
      value: { kind: "unavailable", reason_code: "client_unavailable" },
    })),
  };
}
