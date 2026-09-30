import { z } from "zod";
import { completedSchema, emptyRequestSchema, identifierSchema, responseSchema, type IpcResult } from "./common";
import { relativeMarkdownPathSchema, vaultMappingSchema } from "./vault-values";

export const obsidianIntegrationChannels = {
  validateVault: "obsidian-integration:validate-vault",
  listVaults: "obsidian-integration:list-vaults",
  listVaultMappings: "obsidian-integration:list-vault-mappings",
  saveVaultMapping: "obsidian-integration:save-vault-mapping",
  resolvePath: "obsidian-integration:resolve-path",
  noteExists: "obsidian-integration:note-exists",
  openNote: "obsidian-integration:open-note",
} satisfies Record<string, string>;

const vaultRequestSchema = z.object({ vault_id: identifierSchema }).strict();
const pathRequestSchema = z
  .object({
    vault_id: identifierSchema,
    relative_path: relativeMarkdownPathSchema,
  })
  .strict();
const pathResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("resolved"),
      vault_id: identifierSchema,
      relative_path: relativeMarkdownPathSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("missing"),
      vault_id: identifierSchema,
      relative_path: relativeMarkdownPathSchema,
    })
    .strict(),
]);

export const obsidianIntegrationContracts = {
  validateVault: {
    channel: obsidianIntegrationChannels.validateVault,
    request: vaultRequestSchema,
    response: responseSchema(z.object({ vault_id: identifierSchema, kind: z.literal("valid") }).strict()),
  },
  listVaults: {
    channel: obsidianIntegrationChannels.listVaults,
    request: emptyRequestSchema,
    response: responseSchema(z.object({ vault_ids: z.array(identifierSchema).max(1_000) }).strict()),
  },
  listVaultMappings: {
    channel: obsidianIntegrationChannels.listVaultMappings,
    request: emptyRequestSchema,
    response: responseSchema(z.array(vaultMappingSchema).max(1_000)),
  },
  saveVaultMapping: {
    channel: obsidianIntegrationChannels.saveVaultMapping,
    request: vaultMappingSchema,
    response: responseSchema(z.array(vaultMappingSchema).max(1_000)),
  },
  resolvePath: {
    channel: obsidianIntegrationChannels.resolvePath,
    request: pathRequestSchema,
    response: responseSchema(pathResultSchema),
  },
  noteExists: {
    channel: obsidianIntegrationChannels.noteExists,
    request: pathRequestSchema,
    response: responseSchema(pathResultSchema),
  },
  openNote: {
    channel: obsidianIntegrationChannels.openNote,
    request: pathRequestSchema,
    response: responseSchema(completedSchema),
  },
};

export type ObsidianIntegrationApi = {
  readonly validateVault: (
    vaultId: string,
  ) => Promise<IpcResult<{ readonly vault_id: string; readonly kind: "valid" }>>;
  readonly listVaults: () => Promise<IpcResult<{ readonly vault_ids: string[] }>>;
  readonly listVaultMappings: () => Promise<IpcResult<z.infer<typeof vaultMappingSchema>[]>>;
  readonly saveVaultMapping: (
    mapping: z.infer<typeof vaultMappingSchema>,
  ) => Promise<IpcResult<z.infer<typeof vaultMappingSchema>[]>>;
  readonly resolvePath: (
    input: z.infer<typeof pathRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof pathResultSchema>>>;
  readonly noteExists: (
    input: z.infer<typeof pathRequestSchema>,
  ) => Promise<IpcResult<z.infer<typeof pathResultSchema>>>;
  readonly openNote: (input: z.infer<typeof pathRequestSchema>) => Promise<IpcResult<z.infer<typeof completedSchema>>>;
};
