import { githubIntegrationContracts } from "../../../shared/ipc-contracts/github-integration";
import { createContractHandler, type ContractHandler } from "./contract-handler";

type GithubStatusReporter = {
  reportErrorOnce(error: Error, context: {
    readonly source: "ipc";
    readonly diagnosticCode: "github.integration";
    readonly context: "ipc_diagnostic";
    readonly level: "warning";
  }): string;
};

export type GithubIntegrationHandlers = {
  readonly getStatus: ContractHandler<typeof githubIntegrationContracts.getStatus>;
};

/** GitHub連携状態のuse caseをIPC handlerへ接続します。 */
export function createGithubIntegrationHandlers(workflow: {
  getStatus(): { readonly kind: "unavailable"; readonly reason_code: "client_unavailable" };
}, reporter: GithubStatusReporter): GithubIntegrationHandlers {
  return {
    getStatus: createContractHandler(githubIntegrationContracts.getStatus, () => ({
      ...workflow.getStatus(),
      error_id: reporter.reportErrorOnce(new Error("GitHub App連携が設定されていません。"), {
        source: "ipc",
        diagnosticCode: "github.integration",
        context: "ipc_diagnostic",
        level: "warning",
      }),
    })),
  };
}
