import { dateSchema, dateTimeSchema } from "../../../shared/ipc-contracts/common";

function assertNonNullable<T>(value: T | undefined, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}

type DatetimeLocalParseResult =
  | { readonly kind: "valid"; readonly value: string }
  | { readonly kind: "invalid" };

/** 日時入力を検証します。 */
export function parseDatetimeLocal(value: string): DatetimeLocalParseResult {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (matched == null) {
    return { kind: "invalid" };
  }
  const datePart = matched[1];
  const hourPart = matched[2];
  const minutePart = matched[3];
  assertNonNullable(datePart, "日時入力の正規表現結果に日付がありません。");
  assertNonNullable(hourPart, "日時入力の正規表現結果に時刻がありません。");
  assertNonNullable(minutePart, "日時入力の正規表現結果に分がありません。");
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { kind: "invalid" };
  }
  if (!dateSchema.safeParse(datePart).success) {
    return { kind: "invalid" };
  }
  const timestamp = Date.parse(`${datePart}T${hourPart}:${minutePart}:00+09:00`);
  if (!Number.isFinite(timestamp)) {
    return { kind: "invalid" };
  }
  const parsed = dateTimeSchema.safeParse(new Date(timestamp).toISOString());
  if (!parsed.success) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value: parsed.data };
}

/** 日時入力をISO形式へ変換します。 */
export function datetimeLocalToIso(value: string): string {
  const parsed = parseDatetimeLocal(value);
  if (parsed.kind === "invalid") {
    throw new Error("日時入力を変換できません。");
  }
  return parsed.value;
}

/** 日時をJSTの入力形式へ変換します。 */
export function isoToDatetimeLocal(value: string): string {
  const validated = dateTimeSchema.parse(value);
  const timestamp = Date.parse(validated);
  if (!Number.isFinite(timestamp)) {
    throw new Error("日時を表示用へ変換できません。");
  }
  const parts = new Map(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Tokyo",
      year: "numeric",
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
  const year = parts.get("year");
  const month = parts.get("month");
  const day = parts.get("day");
  const hour = parts.get("hour");
  const minute = parts.get("minute");
  if (year == null || month == null || day == null || hour == null || minute == null) {
    throw new Error("JSTの表示日時を取得できません。");
  }
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** 日時をJSTで表示します。 */
export function jstDateTimeLabel(value: string): string {
  const validated = dateTimeSchema.parse(value);
  const timestamp = Date.parse(validated);
  if (!Number.isFinite(timestamp)) {
    throw new Error("順位計算日時を表示できません。");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}
