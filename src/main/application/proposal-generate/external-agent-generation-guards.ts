import { isoDateTimeSchema } from "../../domain";

export class UnreachableError extends Error {}

export function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

export function nowIso(nowProvider: () => Date): string {
  const value = nowProvider();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("時刻関数は有効なDateを返してください。");
  }
  return isoDateTimeSchema.parse(value.toISOString());
}
