import { parseStorageJson, serializeStorageJson } from "./storage-json";
import type { SqliteConnection } from "./sqlite-connection";

type ExternalToolDefinition = { readonly tool_id: string };
type ExternalToolDefinitionRecord<Definition extends ExternalToolDefinition> = Definition & {
  readonly credential_reference_names: readonly string[];
};

type ExternalToolDefinitionContracts<
  Definition extends ExternalToolDefinition,
  Record extends ExternalToolDefinitionRecord<Definition>,
> = {
  readonly parseDefinition: (value: unknown) => Definition;
  readonly parseRecord: (value: unknown) => Record;
  readonly parseCredentialReferenceNames: (value: unknown) => readonly string[];
};

interface ExternalToolDefinitionRow {
  readonly tool_id: string;
  readonly definition_json: string;
  readonly credential_reference_names_json: string;
}

function splitDefinition<
  Definition extends ExternalToolDefinition,
  Record extends ExternalToolDefinitionRecord<Definition>,
>(
  record: Record,
  parseDefinition: (value: unknown) => Definition,
): { readonly definition: Definition; readonly credentialReferenceNames: readonly string[] } {
  const {
    credential_reference_names: credentialReferenceNames,
    ...definition
  } = record;
  return {
    definition: parseDefinition(definition),
    credentialReferenceNames,
  };
}

function rowToExternalToolDefinition<
  Definition extends ExternalToolDefinition,
  Record extends ExternalToolDefinitionRecord<Definition>,
>(
  row: ExternalToolDefinitionRow,
  contracts: ExternalToolDefinitionContracts<Definition, Record>,
): Record {
  const definition = parseStorageJson(
    row.definition_json,
    contracts.parseDefinition,
  );
  if (definition.tool_id !== row.tool_id) {
    throw new Error("外部ツール定義のIDが一致しません。");
  }
  const credentialReferenceNames = parseStorageJson(
    row.credential_reference_names_json,
    contracts.parseCredentialReferenceNames,
  );
  return contracts.parseRecord({
    ...definition,
    credential_reference_names: credentialReferenceNames,
  });
}

/** 外部ツール定義のSQLite操作を提供します。 */
export class SqliteExternalToolDefinitionRepository<
  Definition extends ExternalToolDefinition,
  Record extends ExternalToolDefinitionRecord<Definition>,
> {
  private readonly saveStatement;
  private readonly selectAllStatement;

  public constructor(
    database: SqliteConnection,
    private readonly contracts: ExternalToolDefinitionContracts<Definition, Record>,
  ) {
    this.saveStatement = database.prepare<[string, string, string], unknown>(
      `INSERT INTO external_tool_definitions
         (tool_id, definition_json, credential_reference_names_json)
       VALUES (?, ?, ?)
       ON CONFLICT(tool_id) DO UPDATE SET
         definition_json = excluded.definition_json,
         credential_reference_names_json = excluded.credential_reference_names_json`,
    );
    this.selectAllStatement = database.prepare<[], ExternalToolDefinitionRow>(
      "SELECT tool_id, definition_json, credential_reference_names_json FROM external_tool_definitions ORDER BY tool_id",
    );
  }

  /** 外部ツール定義を保存します。 */
  public save(record: Record): void {
    const validatedRecord = this.contracts.parseRecord(record);
    const { definition, credentialReferenceNames } = splitDefinition(
      validatedRecord,
      this.contracts.parseDefinition,
    );
    this.saveStatement.run(
      definition.tool_id,
      serializeStorageJson(definition),
      serializeStorageJson(credentialReferenceNames),
    );
  }

  /** 外部ツール定義を全件読み出します。 */
  public getAll(): readonly Record[] {
    return this.selectAllStatement.all().map((row) =>
      rowToExternalToolDefinition(row, this.contracts));
  }
}
