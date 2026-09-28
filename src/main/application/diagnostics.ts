import { z } from "zod";
import { identifierSchema } from "../../shared/domain";
import {
  diagnosticLogEntrySchema,
  type DiagnosticLogEntry,
} from "../../shared/storage";

const diagnosticRecordSchema = diagnosticLogEntrySchema
  .omit({
    occurred_at: true,
    app_version: true,
  })
  .strict();

export type DiagnosticRecord = Readonly<z.infer<typeof diagnosticRecordSchema>>;

export const applicationDiagnosticSchema = z.object({
  kind: z.literal("service"),
  severity: z.enum(["warning", "error"]),
}).strict();

export type ApplicationDiagnostic = z.infer<typeof applicationDiagnosticSchema>;

/** 診断ログの許可済み入力を検証します。 */
export function parseDiagnosticRecord(value: unknown): DiagnosticRecord {
  return diagnosticRecordSchema.parse(value);
}

/** 診断ログの保存値を検証します。 */
export function parseDiagnosticLogEntry(value: unknown): DiagnosticLogEntry {
  return diagnosticLogEntrySchema.parse(value);
}

/** 診断ログのアプリ版を検証します。 */
export function parseDiagnosticAppVersion(value: unknown): string {
  return identifierSchema.parse(value);
}
