/** 値が参照可能なオブジェクトか判定します。 */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value != null;
}

function getNonErrorName(value: unknown): string {
  if (value == null) {
    return "Nullish";
  }
  if (typeof value === "function") {
    return "Function";
  }
  if (typeof value === "object") {
    return "Object";
  }
  if (typeof value === "string") {
    return "String";
  }
  if (typeof value === "number") {
    return "Number";
  }
  if (typeof value === "boolean") {
    return "Boolean";
  }
  if (typeof value === "bigint") {
    return "BigInt";
  }
  return "Symbol";
}

/** エラー名を伏せ字処理して返します。 */
export function getErrorName(value: unknown, redactText: (value: string) => string): string {
  if (!(value instanceof Error)) {
    return getNonErrorName(value);
  }
  return redactText(value.name);
}

/** エラーメッセージを伏せ字処理して返します。 */
export function getErrorMessage(value: unknown, redactText: (value: string) => string): string {
  if (value instanceof Error) {
    return redactText(value.message);
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  return `Error以外の${getNonErrorName(value)}が例外として渡されました。`;
}

/** スタックを伏せ字処理して返します。 */
export function getStackTrace(value: unknown, redactText: (value: string) => string): string {
  if (!(value instanceof Error) || typeof value.stack !== "string") {
    return "";
  }
  return redactText(value.stack);
}
