import { isAbsolute } from "node:path";
import { z } from "zod";

export const nonEmptyTextSchema = z.string().min(1);
export const boundedTextSchema = nonEmptyTextSchema.max(200_000);
export const pathSchema = nonEmptyTextSchema.max(4_096);
export const absolutePathSchema = pathSchema.refine(
  isAbsolute,
  "パスは絶対パスでなければなりません。",
);
export const modelIdSchema = nonEmptyTextSchema.max(200);
export const threadIdSchema = nonEmptyTextSchema.max(200);
export const turnIdSchema = nonEmptyTextSchema.max(200);
const maxJsonValueBytes = 128 * 1024;
const maxJsonValueDepth = 32;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype == null;
}

function addJsonValueIssue(context: { addIssue: (issue: { code: "custom"; message: string }) => void }, message: string): void {
  context.addIssue({ code: "custom", message });
}

function validateJsonValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  context: { addIssue: (issue: { code: "custom"; message: string }) => void },
): void {
  type Frame = {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting: boolean;
  };
  const pending: Frame[] = [{ value, depth, exiting: false }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame == null) {
      throw new Error("JSON検証のスタックが不正です。");
    }
    if (frame.exiting) {
      if (typeof frame.value !== "object" || frame.value == null) {
        throw new Error("JSON検証の状態が不正です。");
      }
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.depth > maxJsonValueDepth) {
      addJsonValueIssue(context, "JSON値の深度が上限を超えています。");
      continue;
    }
    if (frame.value == null || typeof frame.value === "string" || typeof frame.value === "boolean") {
      continue;
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        addJsonValueIssue(context, "JSON値の数値は有限でなければなりません。");
      }
      continue;
    }
    if (typeof frame.value !== "object") {
      addJsonValueIssue(context, "JSON値に対応しない型です。");
      continue;
    }
    if (ancestors.has(frame.value)) {
      addJsonValueIssue(context, "JSON値に循環参照があります。");
      continue;
    }
    ancestors.add(frame.value);
    pending.push({ value: frame.value, depth: frame.depth, exiting: true });
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        pending.push({ value: item, depth: frame.depth + 1, exiting: false });
      }
    } else if (isJsonObject(frame.value)) {
      for (const item of Object.values(frame.value)) {
        pending.push({ value: item, depth: frame.depth + 1, exiting: false });
      }
    } else {
      addJsonValueIssue(context, "JSON値はプレーンなオブジェクトでなければなりません。");
    }
  }
}

export const jsonValueSchema = z.unknown().superRefine((value, context) => {
  validateJsonValue(value, 0, new WeakSet<object>(), context);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    addJsonValueIssue(context, "JSON値を文字列化できません。");
    return;
  }
  if (serialized == null) {
    addJsonValueIssue(context, "JSON値を文字列化できません。");
    return;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxJsonValueBytes) {
    addJsonValueIssue(context, "JSON値のサイズが上限を超えています。");
  }
});

export const jsonObjectSchema = jsonValueSchema.superRefine((value, context) => {
  if (!isJsonObject(value)) {
    addJsonValueIssue(context, "JSONスキーマはオブジェクトでなければなりません。");
  }
});

/** JSON-RPCの要求識別子を表すスキーマです。 */
