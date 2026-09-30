/** SQLite保存用にJSON値を文字列へ変換します。 */
export function serializeStorageJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("SQLite保存用JSONの変換に失敗しました。");
  }
  return serialized;
}

/** SQLite保存値をJSON解析し、指定された契約で検証します。 */
export function parseStorageJson<T>(raw: string, parse: (value: unknown) => T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("SQLiteに保存されたJSONの解析に失敗しました。", { cause: error });
  }

  return parse(parsed);
}
