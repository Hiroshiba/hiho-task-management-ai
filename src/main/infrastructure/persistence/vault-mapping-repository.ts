import {
  vaultMappingSchema,
  type VaultMapping,
} from "../../domain/obsidian-contracts";
import type { ObsidianVaultRepository } from "../../application/common/ports/obsidian-vault-repository";
import type { SqliteConnection } from "./sqlite-connection";

interface VaultMappingRow {
  readonly vault_id: string;
  readonly absolute_path: string;
}

function validateVaultMapping(mapping: VaultMapping): VaultMapping {
  return vaultMappingSchema.parse(mapping);
}

function rowToVaultMapping(row: VaultMappingRow): VaultMapping {
  return validateVaultMapping({
    vault_id: row.vault_id,
    absolute_path: row.absolute_path,
  });
}

/** VaultマッピングのSQLite操作を提供します。 */
export class SqliteVaultMappingRepository implements ObsidianVaultRepository {
  private readonly saveStatement;
  private readonly selectAllStatement;

  public constructor(database: SqliteConnection) {
    this.saveStatement = database.prepare<[string, string], unknown>(
      `INSERT INTO vault_mappings (vault_id, absolute_path)
       VALUES (?, ?)
       ON CONFLICT(vault_id) DO UPDATE SET absolute_path = excluded.absolute_path`,
    );
    this.selectAllStatement = database.prepare<[], VaultMappingRow>(
      "SELECT vault_id, absolute_path FROM vault_mappings ORDER BY vault_id",
    );
  }

  /** Vaultマッピングを保存します。 */
  public saveVaultMapping(mapping: VaultMapping): void {
    const validatedMapping = validateVaultMapping(mapping);
    this.saveStatement.run(validatedMapping.vault_id, validatedMapping.absolute_path);
  }

  /** Vaultマッピングを全件読み出します。 */
  public getVaultMappings(): readonly VaultMapping[] {
    return this.selectAllStatement.all().map(rowToVaultMapping);
  }
}
