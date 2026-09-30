import { z } from "zod";
import type { JsonArray, JsonValue } from "../../domain";
import type { TrustedStatusEvidenceReference } from "../../domain/proposal-analysis/basic";

type StatusEvidence = Extract<TrustedStatusEvidenceReference, { readonly kind: "external_tool" }>;

type ExternalToolOutput =
  | { readonly format: "json"; readonly value: JsonValue }
  | { readonly format: "jsonl"; readonly values: readonly JsonValue[] };

const outputStatusEvidenceRecordSchema = z.object({
  locator: z.unknown(),
  target_task_gid: z.unknown(),
  status: z.unknown(),
}).passthrough();

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

function topLevelRecords(output: ExternalToolOutput): readonly JsonValue[] {
  const records: JsonValue[] = [];
  const values = output.format === "json" ? [output.value] : output.values;
  for (const value of values) {
    if (isJsonArray(value)) {
      records.push(...value);
    } else {
      records.push(value);
    }
  }
  return records;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function assertCompatibleEvidence(current: StatusEvidence, incoming: StatusEvidence): void {
  if (
    current.locator === incoming.locator
    && current.target_task_gid === incoming.target_task_gid
    && current.status === incoming.status
  ) {
    return;
  }
  throw new Error(`外部状態根拠locator ${incoming.locator} に異なる対象または状態を指定できません。`);
}

/** 検証済み外部ツール出力から変更案の状態根拠を抽出する関数を作ります。 */
export function createExternalToolStatusEvidenceParser(
  evidenceSchema: z.ZodType<StatusEvidence>,
): (output: ExternalToolOutput) => readonly StatusEvidence[] {
  return (output) => {
    const evidenceByLocator = new Map<string, StatusEvidence>();
    for (const record of topLevelRecords(output)) {
      const parsedRecord = outputStatusEvidenceRecordSchema.safeParse(record);
      if (!parsedRecord.success) {
        continue;
      }
      const candidate = evidenceSchema.safeParse({
        kind: "external_tool",
        locator: parsedRecord.data.locator,
        target_task_gid: parsedRecord.data.target_task_gid,
        status: parsedRecord.data.status,
      });
      if (!candidate.success) {
        continue;
      }
      const current = evidenceByLocator.get(candidate.data.locator);
      if (current != null) {
        assertCompatibleEvidence(current, candidate.data);
        continue;
      }
      evidenceByLocator.set(candidate.data.locator, candidate.data);
    }
    return [...evidenceByLocator.values()].sort((left, right) =>
      compareStrings(left.locator, right.locator));
  };
}
