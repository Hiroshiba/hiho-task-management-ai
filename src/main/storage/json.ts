import { z } from "zod";

/** SQLite保存用にJSON値を文字列へ変換します。 */
export function serializeStorageJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("SQLite保存用JSONの変換に失敗しました。");
  }
  return serialized;
}

/** SQLite保存値をJSON解析し、指定されたZodスキーマで検証します。 */
export function parseStorageJson<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("SQLiteに保存されたJSONの解析に失敗しました。", { cause: error });
  }

  return schema.parse(parsed);
}

/** SQLite更新件数が一件であることを検証します。 */
export function assertChanged(changes: number, operation: string): void {
  if (changes !== 1) {
    throw new Error(`${operation}の対象が見つかりません。`);
  }
}
