import { z } from "zod";

type DiagnosticLogStoragePort<Entry> = {
  readonly appendDiagnosticLog: (entry: Entry, retentionLimit: number) => void;
};

function createOccurredAt(nowProvider: () => Date): string {
  const now = nowProvider();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error("現在時刻が不正です。");
  }
  return now.toISOString();
}

/** 許可済みの構造化情報だけを診断ログへ保存します。 */
export class DiagnosticLogService<Record extends object, Entry> {
  private readonly storage: DiagnosticLogStoragePort<Entry>;
  private readonly appVersion: string;
  private readonly nowProvider: () => Date;
  private readonly retentionLimit: number;

  public constructor(
    storage: DiagnosticLogStoragePort<Entry>,
    appVersion: string,
    nowProvider: () => Date,
    retentionLimit: number,
    private readonly parseAppVersion: (value: unknown) => string,
    private readonly parseRecord: (value: unknown) => Record,
    private readonly parseEntry: (value: unknown) => Entry,
  ) {
    this.storage = z.custom<DiagnosticLogStoragePort<Entry>>(
      (value) => typeof value === "object" && value != null
        && "appendDiagnosticLog" in value
        && typeof value.appendDiagnosticLog === "function",
      "診断ログ保存ポートが必要です。",
    ).parse(storage);
    this.appVersion = this.parseAppVersion(appVersion);
    this.nowProvider = z.custom<() => Date>(
      (value) => typeof value === "function",
      "現在時刻関数が必要です。",
    ).parse(nowProvider);
    this.retentionLimit = z.number().int().min(1).parse(retentionLimit);
  }

  /** 許可済みの構造化診断情報へ時刻とアプリ版を付与して保存します。 */
  public record(record: Record): void {
    const validatedRecord = this.parseRecord(record);
    const entry = this.parseEntry({
      occurred_at: createOccurredAt(this.nowProvider),
      app_version: this.appVersion,
      ...validatedRecord,
    });
    this.storage.appendDiagnosticLog(entry, this.retentionLimit);
  }
}
