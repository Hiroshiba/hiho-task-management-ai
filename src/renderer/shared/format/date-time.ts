import { dateSchema, dateTimeSchema } from "../../../shared/ipc-contracts/common";

type DatetimeLocalParseResult =
  | { readonly kind: "valid"; readonly value: string }
  | { readonly kind: "invalid"; readonly reason: "format" | "date" | "time" | "timestamp" };

function assertNonNullable<T>(value: T | undefined, message: string): asserts value is T {
  if (value == null) {
    throw new Error(message);
  }
}

/** 日本時間の日時入力をISO形式へ検証します。 */
export function parseJstDatetimeLocal(value: string): DatetimeLocalParseResult {
  const matched = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (matched == null) {
    return { kind: "invalid", reason: "format" };
  }
  const datePart = matched[1];
  const hourPart = matched[2];
  const minutePart = matched[3];
  assertNonNullable(datePart, "日時入力の正規表現結果に日付がありません。");
  assertNonNullable(hourPart, "日時入力の正規表現結果に時刻がありません。");
  assertNonNullable(minutePart, "日時入力の正規表現結果に分がありません。");
  if (!dateSchema.safeParse(datePart).success) {
    return { kind: "invalid", reason: "date" };
  }
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { kind: "invalid", reason: "time" };
  }
  const timestamp = Date.parse(`${datePart}T${hourPart}:${minutePart}:00+09:00`);
  if (!Number.isFinite(timestamp)) {
    return { kind: "invalid", reason: "timestamp" };
  }
  return { kind: "valid", value: dateTimeSchema.parse(new Date(timestamp).toISOString()) };
}

/** 日本時間の日時入力をISO形式へ変換します。 */
export function jstDatetimeLocalToIso(value: string): string {
  const parsed = parseJstDatetimeLocal(value);
  if (parsed.kind === "invalid") {
    throw new Error("日時入力を変換できません。");
  }
  return parsed.value;
}

/** ISO形式の日時を日本時間の入力形式へ変換します。 */
export function isoToJstDatetimeLocal(value: string): string {
  const timestamp = Date.parse(dateTimeSchema.parse(value));
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
  assertNonNullable(year, "日本時間の表示日時に年がありません。");
  assertNonNullable(month, "日本時間の表示日時に月がありません。");
  assertNonNullable(day, "日本時間の表示日時に日がありません。");
  assertNonNullable(hour, "日本時間の表示日時に時がありません。");
  assertNonNullable(minute, "日本時間の表示日時に分がありません。");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

/** ISO形式の日時を日本時間で表示します。 */
export function jstDateTimeLabel(value: string): string {
  const timestamp = Date.parse(dateTimeSchema.parse(value));
  if (!Number.isFinite(timestamp)) {
    throw new Error("日時を表示できません。");
  }
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(timestamp));
}
