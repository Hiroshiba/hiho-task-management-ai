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

const storagePortSchema = z.custom<DiagnosticLogStoragePort>(
  (value) =>
    typeof value === "object"
    && value != null
    && "appendDiagnosticLog" in value
    && typeof value.appendDiagnosticLog === "function",
  "診断ログ保存ポートが必要です。",
);

const nowProviderSchema = z.custom<() => Date>(
  (value) => typeof value === "function",
  "現在時刻関数が必要です。",
);

const retentionLimitSchema = z.number().int().min(1);

export interface DiagnosticLogStoragePort {
  appendDiagnosticLog(entry: DiagnosticLogEntry, retentionLimit: number): void;
}

export type DiagnosticRecord = Readonly<z.infer<typeof diagnosticRecordSchema>>;

function createOccurredAt(nowProvider: () => Date): string {
  const now = nowProvider();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("現在時刻が不正です。");
  }
  return now.toISOString();
}

/** 許可済みの構造化情報だけを診断ログへ保存します。 */
export class DiagnosticLogService {
  private readonly storage: DiagnosticLogStoragePort;
  private readonly appVersion: string;
  private readonly nowProvider: () => Date;
  private readonly retentionLimit: number;

  public constructor(
    storage: DiagnosticLogStoragePort,
    appVersion: string,
    nowProvider: () => Date,
    retentionLimit: number,
  ) {
    this.storage = storagePortSchema.parse(storage);
    this.appVersion = identifierSchema.parse(appVersion);
    this.nowProvider = nowProviderSchema.parse(nowProvider);
    this.retentionLimit = retentionLimitSchema.parse(retentionLimit);
  }

  /** 許可済みの構造化診断情報へ時刻とアプリ版を付与して保存します。 */
  public record(record: DiagnosticRecord): void {
    const validatedRecord = diagnosticRecordSchema.parse(record);
    const entry = diagnosticLogEntrySchema.parse({
      occurred_at: createOccurredAt(this.nowProvider),
      app_version: this.appVersion,
      ...validatedRecord,
    });
    this.storage.appendDiagnosticLog(entry, this.retentionLimit);
  }
}
