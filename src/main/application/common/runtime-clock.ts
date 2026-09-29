import { dateSchema, isoDateTimeSchema } from "../../domain";

/** 注入された現在時刻をISO日時として検証します。 */
export function createNowIso(nowProvider: () => Date): string {
  const value = nowProvider();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("現在時刻が不正です。");
  }
  return isoDateTimeSchema.parse(value.toISOString());
}

/** 注入された現在時刻から日本時間の日付を作ります。 */
export function todayJst(nowProvider: () => Date): string {
  const value = nowProvider();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("現在時刻が不正です。");
  }
  const japanTime = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  return dateSchema.parse(japanTime.toISOString().slice(0, 10));
}
