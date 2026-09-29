import { z } from "zod";
import { canonicalizeJson } from "../domain";
import {
  createDiscordExternalToolDefinition,
  discordExternalToolCredentialReferenceName,
  externalToolDefinitionSchema,
  type ExternalToolDefinition,
} from "../infrastructure/ai";
import { externalToolCredentialReferenceNamesSchema, type ExternalToolCredentialReferenceNames } from "../infrastructure/persistence";
import type { SqliteExternalToolDefinitionRepository } from "../infrastructure/persistence";
import type { SecretStorageData, SecretStoragePort } from "../application/common/ports/secret-storage";

export type ExternalToolDefinitionRecord = ExternalToolDefinition & {
  readonly credential_reference_names: ExternalToolCredentialReferenceNames;
};

export type ExternalToolPersistenceResult =
  | { readonly kind: "saved" }
  | { readonly kind: "credential_storage_unavailable"; readonly error: unknown }
  | { readonly kind: "startup_failed"; readonly error: unknown }
  | { readonly kind: "recovery_required"; readonly error: unknown };

type ExternalToolDefinitionRepository = SqliteExternalToolDefinitionRepository<
  ExternalToolDefinition,
  ExternalToolDefinitionRecord
>;

/** 外部ツール定義の保存形式を検証します。 */
export function createExternalToolDefinitionRecordSchema(): z.ZodType<ExternalToolDefinitionRecord> {
  return externalToolDefinitionSchema.extend({
    credential_reference_names: externalToolCredentialReferenceNamesSchema,
  }).strict();
}

/** 保存済みの固定Discord定義を検証します。 */
function assertPersistedExternalToolRecord(
  records: readonly ExternalToolDefinitionRecord[],
): void {
  if (records.length !== 1) {
    throw new Error("保存済み外部ツール設定は固定Discord定義一件でなければなりません。");
  }
  const record = records[0];
  if (record == null) {
    throw new Error("保存済み外部ツール設定を取得できません。");
  }
  if (
    record.credential_reference_names.length !== 1
    || record.credential_reference_names[0] !== discordExternalToolCredentialReferenceName
  ) {
    throw new Error("保存済みDiscord資格情報参照が固定値と一致しません。");
  }
  const { credential_reference_names: _credentialReferenceNames, ...storedDefinition } = record;
  void _credentialReferenceNames;
  const definition = createDiscordExternalToolDefinition(storedDefinition.allowed_channel_ids);
  if (canonicalizeJson(storedDefinition) !== canonicalizeJson(definition)) {
    throw new Error("保存済み外部ツール設定が固定Discord定義と一致しません。");
  }
}

/** 保存済みの固定Discord定義を取得します。 */
export function findPersistedDiscordExternalToolRecord(
  records: readonly ExternalToolDefinitionRecord[],
): ExternalToolDefinitionRecord | undefined {
  const discordRecords = records.filter((record) => record.tool_id === "discord-context");
  if (discordRecords.length > 1) {
    throw new Error("保存済み固定Discord定義が重複しています。");
  }
  const record = discordRecords[0];
  if (record == null) return undefined;
  assertPersistedExternalToolRecord([record]);
  return record;
}

/** 外部ツール定義と固定資格情報参照を組み立てます。 */
export function createExternalToolDefinitionRecord(
  definition: ExternalToolDefinition,
): ExternalToolDefinitionRecord {
  return { ...definition, credential_reference_names: [discordExternalToolCredentialReferenceName] };
}

/** 保存済みの固定Discord定義とcheckpointの内容を照合します。 */
export function assertPersistedExternalToolDefinition(
  repository: ExternalToolDefinitionRepository,
  expectedDefinition: ExternalToolDefinition,
): void {
  const record = findPersistedDiscordExternalToolRecord(repository.getAll());
  if (record == null) {
    throw new Error("保存済み固定Discord定義がありません。");
  }
  const { credential_reference_names: _credentialReferenceNames, ...storedDefinition } = record;
  void _credentialReferenceNames;
  if (canonicalizeJson(storedDefinition) !== canonicalizeJson(expectedDefinition)) {
    throw new Error("保存済み固定Discord定義がcheckpointと一致しません。");
  }
}

/** Discord資格情報と固定定義を保存し、定義の失敗時は既存資格情報を復元します。 */
export function persistDiscordExternalToolConfiguration(
  secretStorage: SecretStoragePort,
  repository: ExternalToolDefinitionRepository,
  definition: ExternalToolDefinition,
  botToken: string,
): ExternalToolPersistenceResult {
  let secrets: SecretStorageData | undefined;
  try {
    secrets = secretStorage.load();
  } catch (error: unknown) {
    return { kind: "credential_storage_unavailable", error };
  }
  try {
    secretStorage.save({
      ...(secrets ?? {}),
      discord_bot_token: botToken,
    });
  } catch (error: unknown) {
    return { kind: "credential_storage_unavailable", error };
  }
  try {
    repository.save(createExternalToolDefinitionRecord(definition));
  } catch (databaseError: unknown) {
    if (secrets?.discord_bot_token == null) {
      return { kind: "startup_failed", error: databaseError };
    }
    try {
      secretStorage.save(secrets);
    } catch (restoreError: unknown) {
      return {
        kind: "recovery_required",
        error: new AggregateError(
          [databaseError, restoreError],
          "固定Discord定義の保存失敗後に既存Tokenを復元できませんでした。",
          { cause: databaseError },
        ),
      };
    }
    return { kind: "startup_failed", error: databaseError };
  }
  return { kind: "saved" };
}
