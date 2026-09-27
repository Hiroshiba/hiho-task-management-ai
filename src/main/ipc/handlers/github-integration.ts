import { githubIntegrationContracts } from "../../../shared/ipc-contracts/github-integration";
import { createContractHandler, type ContractHandler } from "./contract-handler";

export type GithubIntegrationHandlers = {
  readonly getStatus: ContractHandler<typeof githubIntegrationContracts.getStatus>;
};

/** GitHub連携状態のuse caseをIPC handlerへ接続します。 */
export function createGithubIntegrationHandlers(workflow: {
  getStatus(): { readonly kind: "unavailable"; readonly reason_code: "client_unavailable" };
}): GithubIntegrationHandlers {
  return {
    getStatus: createContractHandler(githubIntegrationContracts.getStatus, () => workflow.getStatus()),
  };
}
