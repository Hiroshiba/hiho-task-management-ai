import { z } from "zod";
import {
  externalToolDefinitionSchema,
  type ExternalToolDefinition,
} from "../external-tools/schemas";
import {
  externalToolCredentialReferenceNamesSchema,
} from "../../shared/storage";
import { identifierSchema } from "../../shared/domain";
import { assertChanged, parseStorageJson, serializeStorageJson } from "./json";
import type { SqliteDatabase } from "./types";

const externalToolDefinitionRecordSchema = externalToolDefinitionSchema
  .extend({
    credential_reference_names: externalToolCredentialReferenceNamesSchema,
  })
  .strict();

const externalToolDefinitionRecordsSchema = z
  .array(externalToolDefinitionRecordSchema)
  .superRefine((records, context) => {
    const seen = new Set<string>();
    records.forEach((record, index) => {
      if (seen.has(record.tool_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "tool_id"],
          message: "同じ外部ツールIDを重複して保存できません。",
        });
      }
      seen.add(record.tool_id);
    });
  });

export type ExternalToolDefinitionRecord = z.infer<
  typeof externalToolDefinitionRecordSchema
>;

interface ExternalToolDefinitionRow {
  readonly tool_id: string;
  readonly definition_json: string;
  readonly credential_reference_names_json: string;
}

function splitDefinition(
  record: ExternalToolDefinitionRecord,
): { readonly definition: ExternalToolDefinition; readonly credentialReferenceNames: readonly string[] } {
  const {
    credential_reference_names: credentialReferenceNames,
    ...definition
  } = record;
  return {
    definition: externalToolDefinitionSchema.parse(definition),
    credentialReferenceNames,
  };
}

function rowToExternalToolDefinition(
  row: ExternalToolDefinitionRow,
): ExternalToolDefinitionRecord {
  const definition = parseStorageJson(
    row.definition_json,
    externalToolDefinitionSchema,
  );
  if (definition.tool_id !== row.tool_id) {
    throw new Error("外部ツール定義のIDが一致しません。");
  }
  const credentialReferenceNames = parseStorageJson(
    row.credential_reference_names_json,
    externalToolCredentialReferenceNamesSchema,
  );
  return externalToolDefinitionRecordSchema.parse({
    ...definition,
    credential_reference_names: credentialReferenceNames,
  });
}

/** 外部ツール定義のSQLite操作を提供します。 */
export class ExternalToolDefinitionStore {
  private readonly deleteAllStatement;
  private readonly deleteStatement;
  private readonly saveStatement;
  private readonly selectAllStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.deleteAllStatement = database.prepare<[], unknown>(
      "DELETE FROM external_tool_definitions",
    );
    this.deleteStatement = database.prepare<[string], unknown>(
      "DELETE FROM external_tool_definitions WHERE tool_id = ?",
    );
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
  public save(record: ExternalToolDefinitionRecord): void {
    const validatedRecord = externalToolDefinitionRecordSchema.parse(record);
    const { definition, credentialReferenceNames } = splitDefinition(validatedRecord);
    this.saveStatement.run(
      definition.tool_id,
      serializeStorageJson(definition),
      serializeStorageJson(credentialReferenceNames),
    );
  }

  /** 外部ツール定義を一つのトランザクションで置き換えます。 */
  public replace(records: readonly ExternalToolDefinitionRecord[]): void {
    const validatedRecords = externalToolDefinitionRecordsSchema.parse(records);
    const replace = this.database.transaction(() => {
      this.deleteAllStatement.run();
      validatedRecords.forEach((record) => {
        const { definition, credentialReferenceNames } = splitDefinition(record);
        this.saveStatement.run(
          definition.tool_id,
          serializeStorageJson(definition),
          serializeStorageJson(credentialReferenceNames),
        );
      });
    });
    replace();
  }

  /** 外部ツール定義を削除します。 */
  public delete(toolId: string): void {
    const validatedToolId = identifierSchema.parse(toolId);
    const result = this.deleteStatement.run(validatedToolId);
    assertChanged(result.changes, "外部ツール定義削除");
  }

  /** 外部ツール定義を全件読み出します。 */
  public getAll(): readonly ExternalToolDefinitionRecord[] {
    return this.selectAllStatement.all().map(rowToExternalToolDefinition);
  }
}
