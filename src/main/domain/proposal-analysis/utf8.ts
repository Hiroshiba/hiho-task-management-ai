import { z } from "zod";

/** UTF-8で指定バイト数以下の文字列を検証するスキーマを作成します。 */
export function createUtf8ByteLimitedStringSchema(maxBytes: number): z.ZodString {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("UTF-8文字列の上限は1以上の整数で指定してください。");
  }
  return z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes, {
    message: `UTF-8換算で${maxBytes}バイト以下の文字列を指定してください。`,
  });
}
