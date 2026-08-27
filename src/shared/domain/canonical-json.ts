export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

function isJsonValueInternal(value: unknown, ancestors: WeakSet<object>): value is JsonValue {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "object") {
    return false;
  }

  if (ancestors.has(value)) {
    return false;
  }
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  ancestors.add(value);

  if (Array.isArray(value)) {
    const valid = value.every((item: unknown) => isJsonValueInternal(item, ancestors));
    ancestors.delete(value);
    return valid;
  }

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor == null || !("value" in descriptor)) {
      ancestors.delete(value);
      return false;
    }
    if (!isJsonValueInternal(descriptor.value, ancestors)) {
      ancestors.delete(value);
      return false;
    }
  }

  ancestors.delete(value);
  return true;
}

/** 値が再帰的なJSON値として表現できるか判定します。 */
export function isJsonValue(value: unknown): value is JsonValue {
  return isJsonValueInternal(value, new WeakSet<object>());
}

function stringifyJsonString(value: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("JSON文字列の正規化に失敗しました。");
  }
  return serialized;
}

function stringifyJsonNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("JSON値に有限でない数値は指定できません。");
  }

  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("JSON数値の正規化に失敗しました。");
  }
  return serialized;
}

function canonicalizeJsonValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return stringifyJsonString(value);
  }

  if (typeof value === "number") {
    return stringifyJsonNumber(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (isJsonArray(value)) {
    return `[${value.map((item) => canonicalizeJsonValue(item)).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => {
      const propertyValue = value[key];
      if (propertyValue === undefined) {
        throw new Error("JSONオブジェクトに未定義の値は指定できません。");
      }
      return `${stringifyJsonString(key)}:${canonicalizeJsonValue(propertyValue)}`;
    });

  return `{${entries.join(",")}}`;
}

/** JSON値をキー順で正規化した決定論的なJSON文字列へ変換します。 */
export function canonicalizeJson(value: unknown): string {
  if (!isJsonValue(value)) {
    throw new Error("正規化対象はJSON値でなければなりません。");
  }

  return canonicalizeJsonValue(value);
}
