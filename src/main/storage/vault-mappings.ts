import {
  vaultMappingSchema,
  type VaultMapping,
} from "../../shared/storage";
import { assertChanged } from "./json";
import type { SqliteDatabase } from "./types";

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
export class VaultMappingStore {
  private readonly deleteStatement;
  private readonly saveStatement;
  private readonly selectAllStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.deleteStatement = database.prepare<[string], unknown>(
      "DELETE FROM vault_mappings WHERE vault_id = ?",
    );
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
  public save(mapping: VaultMapping): void {
    const validatedMapping = validateVaultMapping(mapping);
    this.saveStatement.run(validatedMapping.vault_id, validatedMapping.absolute_path);
  }

  /** Vaultマッピングを削除します。 */
  public delete(vaultId: string): void {
    const validatedVaultId = vaultMappingSchema.shape.vault_id.parse(vaultId);
    const result = this.deleteStatement.run(validatedVaultId);
    assertChanged(result.changes, "Vaultマッピング削除");
  }

  /** Vaultマッピングを全件読み出します。 */
  public getAll(): readonly VaultMapping[] {
    return this.selectAllStatement.all().map(rowToVaultMapping);
  }
}
