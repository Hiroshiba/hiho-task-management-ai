import { obsidianIntegrationContracts, type ObsidianIntegrationApi } from "../../../shared/ipc-contracts/obsidian-integration";
import { vaultMappingSchema } from "../../../shared/ipc-contracts/vault-values";

type Mapping = ReturnType<typeof vaultMappingSchema.parse>;

/** Vaultとノートの画面確認用APIを作成します。 */
export function createMockObsidianIntegrationApi(): ObsidianIntegrationApi {
  let mappings: Mapping[] = [vaultMappingSchema.parse({
    vault_id: "mock-vault",
    absolute_path: "/mock/vault",
  })];

  function exists(vaultId: string, relativePath: string): boolean {
    return mappings.some((mapping) => mapping.vault_id === vaultId)
      && relativePath === "notes/focus.md";
  }

  function pathResult(vaultId: string, relativePath: string) {
    return {
      kind: exists(vaultId, relativePath) ? "resolved" : "missing",
      vault_id: vaultId,
      relative_path: relativePath,
    };
  }

  return {
    validateVault: (vaultId) => {
      obsidianIntegrationContracts.validateVault.request.parse({ vault_id: vaultId });
      const response = mappings.some((mapping) => mapping.vault_id === vaultId)
        ? { kind: "ok", value: { vault_id: vaultId, kind: "valid" } }
        : { kind: "error", code: "not_found", message: "Vaultが登録されていません。" };
      return Promise.resolve(obsidianIntegrationContracts.validateVault.response.parse(response));
    },
    listVaults: () => Promise.resolve(obsidianIntegrationContracts.listVaults.response.parse({
      kind: "ok", value: { vault_ids: mappings.map((mapping) => mapping.vault_id) },
    })),
    listVaultMappings: () => Promise.resolve(obsidianIntegrationContracts.listVaultMappings.response.parse({
      kind: "ok", value: [...mappings],
    })),
    saveVaultMapping: (mapping) => {
      const validated = obsidianIntegrationContracts.saveVaultMapping.request.parse(mapping);
      mappings = [...mappings.filter((item) => item.vault_id !== validated.vault_id), validated];
      return Promise.resolve(obsidianIntegrationContracts.saveVaultMapping.response.parse({
        kind: "ok", value: [...mappings],
      }));
    },
    resolvePath: (input) => {
      const validated = obsidianIntegrationContracts.resolvePath.request.parse(input);
      return Promise.resolve(obsidianIntegrationContracts.resolvePath.response.parse({
        kind: "ok", value: pathResult(validated.vault_id, validated.relative_path),
      }));
    },
    noteExists: (input) => {
      const validated = obsidianIntegrationContracts.noteExists.request.parse(input);
      return Promise.resolve(obsidianIntegrationContracts.noteExists.response.parse({
        kind: "ok", value: pathResult(validated.vault_id, validated.relative_path),
      }));
    },
    openNote: (input) => {
      const validated = obsidianIntegrationContracts.openNote.request.parse(input);
      const response = exists(validated.vault_id, validated.relative_path)
        ? { kind: "ok", value: { completed: true } }
        : { kind: "error", code: "not_found", message: "ノートが見つかりません。" };
      return Promise.resolve(obsidianIntegrationContracts.openNote.response.parse(response));
    },
  };
}
