import { z } from "zod";

const isoDateTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const externalTaskGidPrefix = "TaskHub:v1:task:";
const uuidSchema = z.uuid();

function isValidIsoDateTime(value: string): boolean {
  if (!isoDateTimePattern.test(value) || Number.isNaN(Date.parse(value))) {
    return false;
  }

  if (!isValidDate(value.slice(0, 10))) {
    return false;
  }

  if (!value.endsWith("Z")) {
    const offset = value.slice(-6);
    const offsetHours = Number.parseInt(offset.slice(1, 3), 10);
    const offsetMinutes = Number.parseInt(offset.slice(4, 6), 10);
    if (offsetHours > 23 || offsetMinutes > 59) {
      return false;
    }
  }

  return true;
}

function isValidDate(value: string): boolean {
  const matched = datePattern.exec(value);
  if (matched == null) {
    return false;
  }

  const yearText = matched[1];
  const monthText = matched[2];
  const dayText = matched[3];
  if (yearText == null || monthText == null || dayText == null) {
    return false;
  }

  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isNonEmptyIdentifier(value: string): boolean {
  return value.length > 0 && value.trim() === value && !/\s/.test(value);
}

function isNonEmptyName(value: string): boolean {
  return value.trim().length > 0;
}

function isRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    return false;
  }

  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }

  const segments = value.split(/[\\/]/u);
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasControlCharacter(value: string): boolean {
  return value.split("").some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (codePoint <= 31 || codePoint === 127);
  });
}

/** ISO 8601形式の日時を検証するスキーマです。 */
export const isoDateTimeSchema = z.string().refine(isValidIsoDateTime, {
  message: "ISO 8601形式の日時を指定してください。",
});

/** 暦として存在するYYYY-MM-DD日付を検証するスキーマです。 */
export const dateSchema = z.string().refine(isValidDate, {
  message: "存在するYYYY-MM-DD形式の日付を指定してください。",
});

/** 空文字と空白を含む値を拒否する識別子スキーマです。 */
export const identifierSchema = z.string().refine(isNonEmptyIdentifier, {
  message: "空白を含まない空でない識別子を指定してください。",
});

/** AsanaのGIDを検証するスキーマです。 */
export const gidSchema = identifierSchema;

/** Custom external data用タスクGIDを検証するスキーマです。 */
export const externalTaskGidSchema = z.string().refine(
  (value) =>
    value.startsWith(externalTaskGidPrefix) &&
    uuidSchema.safeParse(value.slice(externalTaskGidPrefix.length)).success,
  {
    message: "TaskHub:v1:task:<UUID>形式の外部GIDを指定してください。",
  },
);
export type ExternalTaskGid = z.infer<typeof externalTaskGidSchema>;

/** 空文字と空白だけの値を拒否するタグ名スキーマです。 */
export const tagNameSchema = z.string().refine(isNonEmptyName, {
  message: "空白だけでないタグ名を指定してください。",
});

/** セクションGIDを検証するスキーマです。 */
export const sectionGidSchema = gidSchema;

/** Vault IDを検証するスキーマです。 */
export const vaultIdSchema = identifierSchema;

/** Vault内の相対パスを検証するスキーマです。 */
export const relativePathSchema = z.string().refine(isRelativePath, {
  message: "Vault内の相対パスを指定してください。",
});

/** UTF-8バイト数を計測します。 */
export function getUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** UTF-8で指定バイト数以下の文字列を検証するスキーマを作成します。 */
export function createUtf8ByteLimitedStringSchema(maxBytes: number): z.ZodString {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("UTF-8文字列の上限は1以上の整数で指定してください。");
  }

  return z.string().refine((value) => getUtf8ByteLength(value) <= maxBytes, {
    message: `UTF-8換算で${maxBytes}バイト以下の文字列を指定してください。`,
  });
}
