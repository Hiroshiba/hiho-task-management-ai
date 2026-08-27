export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function isJsonArray(value: JsonValue): value is JsonArray {
  return Array.isArray(value);
}

function isDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { readonly value: unknown } {
  return descriptor != null && "value" in descriptor;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isJsonArrayInternal(
  value: readonly unknown[],
  ancestors: WeakSet<object>,
): boolean {
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!isDataDescriptor(lengthDescriptor) || lengthDescriptor.value !== value.length) {
    return false;
  }

  const ownKeys = Reflect.ownKeys(value);
  let elementCount = 0;
  for (const key of ownKeys) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !isArrayIndex(key, value.length)) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isDataDescriptor(descriptor)) {
      return false;
    }
    elementCount += 1;
    if (!isJsonValueInternal(descriptor.value, ancestors)) {
      return false;
    }
  }
  return elementCount === value.length;
}

function isJsonObjectInternal(
  value: Record<string, unknown>,
  ancestors: WeakSet<object>,
): boolean {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor == null ||
      descriptor.enumerable !== true ||
      !isDataDescriptor(descriptor)
    ) {
      return false;
    }
    if (!isJsonValueInternal(descriptor.value, ancestors)) {
      return false;
    }
  }
  return true;
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
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return isJsonArrayInternal(value, ancestors);
    }
    if (!isPlainObject(value)) {
      return false;
    }
    return isJsonObjectInternal(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
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
