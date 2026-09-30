import type { ObsidianIntegrationWorkflow } from "../../application/obsidian-integration";
import { obsidianIntegrationContracts } from "../../../shared/ipc-contracts/obsidian-integration";
import { createContractHandler, type ContractHandler } from "./contract-handler";

type ObsidianIpcWorkflow = ReturnType<ObsidianIntegrationWorkflow["createIpcPort"]>;

export type ObsidianIntegrationHandlers = {
  readonly [Name in keyof typeof obsidianIntegrationContracts]: ContractHandler<(typeof obsidianIntegrationContracts)[Name]>;
};

/** Obsidianの各use caseをIPC handlerへ接続します。 */
export function createObsidianIntegrationHandlers(workflow: ObsidianIpcWorkflow): ObsidianIntegrationHandlers {
  return {
    validateVault: createContractHandler(obsidianIntegrationContracts.validateVault, (request, signal) =>
      workflow.validateVault(request.vault_id, signal)),
    listVaults: createContractHandler(obsidianIntegrationContracts.listVaults, (_request, signal) => ({
      vault_ids: [...workflow.listVaults(signal)],
    })),
    listVaultMappings: createContractHandler(obsidianIntegrationContracts.listVaultMappings, (_request, signal) =>
      [...workflow.listVaultMappings(signal)]),
    saveVaultMapping: createContractHandler(obsidianIntegrationContracts.saveVaultMapping, async (request, signal) =>
      [...await workflow.saveVaultMapping(request, signal)]),
    resolvePath: createContractHandler(obsidianIntegrationContracts.resolvePath, (request, signal) =>
      workflow.resolvePath(request.vault_id, request.relative_path, signal)),
    noteExists: createContractHandler(obsidianIntegrationContracts.noteExists, (request, signal) =>
      workflow.noteExists(request.vault_id, request.relative_path, signal)),
    openNote: createContractHandler(obsidianIntegrationContracts.openNote, async (request, signal) => {
      await workflow.openNote(request.vault_id, request.relative_path, signal);
      return { completed: true };
    }),
  };
}
