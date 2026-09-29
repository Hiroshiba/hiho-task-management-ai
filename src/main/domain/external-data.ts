import { z } from "zod";
import { canonicalizeJson } from "./canonical-json";
import { customExternalDataSchema, type CustomExternalData } from "./schemas";
import { getUtf8ByteLength } from "./primitives";

export const customExternalDataSchemaVersion = 1;
export const customExternalDataRecommendedMaxBytes = 24 * 1024;
export const customExternalDataMaxBytes = 28 * 1024;

export type BrokenExternalDataResult = {
  readonly kind: "broken";
  readonly status: "broken";
  readonly raw: string;
  readonly readOnly: true;
  readonly canOverwrite: false;
  readonly reason: "invalid_json" | "invalid_schema" | "capacity_exceeded";
  readonly issues?: readonly z.ZodIssue[];
};

export type UnknownVersionExternalDataResult = {
  readonly kind: "unknown_version";
  readonly status: "unknown_version";
  readonly raw: string;
  readonly schema: number;
  readonly readOnly: true;
  readonly canOverwrite: false;
};

export type ValidExternalDataResult = {
  readonly kind: "valid";
  readonly status: "valid";
  readonly raw: string;
  readonly data: CustomExternalData;
  readonly readOnly: false;
  readonly canOverwrite: true;
};

export type CustomExternalDataParseResult =
  | ValidExternalDataResult
  | BrokenExternalDataResult
  | UnknownVersionExternalDataResult;

/** Custom external dataの容量超過を表すエラーです。 */
export class CustomExternalDataCapacityError extends Error {
  public readonly byteLength: number;

  public constructor(byteLength: number) {
    super("Custom external dataが28KBの強制上限を超えています。");
    this.name = "CustomExternalDataCapacityError";
    this.byteLength = byteLength;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function brokenJsonResult(raw: string): BrokenExternalDataResult {
  return {
    kind: "broken",
    status: "broken",
    raw,
    readOnly: true,
    canOverwrite: false,
    reason: "invalid_json",
  };
}

function brokenSchemaResult(
  raw: string,
  issues: readonly z.ZodIssue[],
): BrokenExternalDataResult {
  return {
    kind: "broken",
    status: "broken",
    raw,
    readOnly: true,
    canOverwrite: false,
    reason: "invalid_schema",
    issues,
  };
}

function brokenCapacityResult(raw: string): BrokenExternalDataResult {
  return {
    kind: "broken",
    status: "broken",
    raw,
    readOnly: true,
    canOverwrite: false,
    reason: "capacity_exceeded",
    issues: [
      {
        code: "custom",
        path: [],
        message: "Custom external dataが28KBの強制上限を超えています。",
      },
    ],
  };
}

/** Custom external dataを正常値・破損値・未知版に分類して解析します。 */
export function parseCustomExternalData(raw: string): CustomExternalDataParseResult {
  if (getUtf8ByteLength(raw) > customExternalDataMaxBytes) {
    return brokenCapacityResult(raw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return brokenJsonResult(raw);
  }

  if (!isRecord(parsed)) {
    return brokenSchemaResult(raw, [
      {
        code: "custom",
        path: [],
        message: "Custom external dataのルートはJSONオブジェクトでなければなりません。",
      },
    ]);
  }

  const schemaVersion = parsed.schema;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion)) {
    return brokenSchemaResult(raw, [
      {
        code: "custom",
        path: ["schema"],
        message: "schemaは整数で指定してください。",
      },
    ]);
  }

  if (schemaVersion !== customExternalDataSchemaVersion) {
    return {
      kind: "unknown_version",
      status: "unknown_version",
      raw,
      schema: schemaVersion,
      readOnly: true,
      canOverwrite: false,
    };
  }

  const result = customExternalDataSchema.safeParse(parsed);
  if (!result.success) {
    return brokenSchemaResult(raw, result.error.issues);
  }

  return {
    kind: "valid",
    status: "valid",
    raw,
    data: result.data,
    readOnly: false,
    canOverwrite: true,
  };
}

/** 解析結果が上書き可能な現行版データか判定します。 */
export function isWritableCustomExternalData(
  result: CustomExternalDataParseResult,
): result is ValidExternalDataResult {
  return result.kind === "valid" && result.canOverwrite;
}

/** 現行版Custom external dataを容量検証済みJSONへ変換します。 */
export function serializeCustomExternalData(data: CustomExternalData): string {
  const validated = customExternalDataSchema.parse(data);
  const serialized = canonicalizeJson(validated);
  const byteLength = getUtf8ByteLength(serialized);
  if (byteLength > customExternalDataMaxBytes) {
    throw new CustomExternalDataCapacityError(byteLength);
  }

  return serialized;
}

/** Custom external dataの保存JSONが強制上限内か判定します。 */
export function isWithinCustomExternalDataLimit(raw: string): boolean {
  return getUtf8ByteLength(raw) <= customExternalDataMaxBytes;
}
