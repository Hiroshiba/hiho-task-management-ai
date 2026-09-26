import { z } from "zod";

type SafeErrorCause = { readonly kind: "absent" } | { readonly kind: "present"; readonly value: SafeErrorProjection };

type SafeErrorProjection =
  | {
      readonly kind: "error";
      readonly node_id: string;
      readonly error_name: string;
      readonly description: string;
      readonly stack_frames: readonly string[];
      readonly cause: SafeErrorCause;
      readonly aggregate_errors: readonly SafeErrorProjection[];
    }
  | { readonly kind: "reference"; readonly node_id: string };

type SafeErrorProjectionDependencies = {
  readonly projectionSchema: z.ZodType<SafeErrorProjection>;
  readonly isRetryableFailure: (error: unknown) => boolean;
  readonly isOutputValidationFailure: (error: unknown) => boolean;
  readonly redactSensitiveText: (value: string) => string;
};

function safeErrorDescription(error: unknown, dependencies: SafeErrorProjectionDependencies): string {
  if (dependencies.isRetryableFailure(error)) {
    return "AI変更案の検証に失敗しました。";
  }
  if (dependencies.isOutputValidationFailure(error)) {
    return "Codexの構造化出力を検証できませんでした。";
  }
  if (error instanceof AggregateError) {
    return "複数の処理に失敗しました。";
  }
  if (error instanceof z.ZodError) {
    return "構造化データの検証に失敗しました。";
  }
  if (error instanceof Error) {
    return "処理に失敗しました。";
  }
  return "Error以外の値が例外として送出されました。";
}

function safeNonErrorName(error: unknown): string {
  if (error == null) {
    return "Nullish";
  }
  if (typeof error === "object") {
    return "Object";
  }
  if (typeof error === "function") {
    return "Function";
  }
  return typeof error;
}

const safeErrorConstructorNameSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u);

function safeErrorName(error: Error): string {
  const prototype: unknown = Object.getPrototypeOf(error);
  if (typeof prototype !== "object" || prototype == null) {
    return "Error";
  }
  const constructor: unknown = Reflect.get(prototype, "constructor");
  if (typeof constructor !== "function") {
    return "Error";
  }
  const parsedName = safeErrorConstructorNameSchema.safeParse(
    Reflect.get(constructor, "name"),
  );
  return parsedName.success ? parsedName.data : "Error";
}

function safeStackFrames(error: Error, redactSensitiveText: (value: string) => string): string[] {
  if (typeof error.stack !== "string") {
    return [];
  }
  return error.stack
    .split(/\r?\n/u)
    .filter((frame) => /^\s+at\s/u.test(frame))
    .map((frame) => redactSensitiveText(frame));
}

/** 例外の原因とstackを伏せ字付きの診断値へ変換します。 */
export function createSafeErrorProjection(error: unknown, dependencies: SafeErrorProjectionDependencies): SafeErrorProjection {
  const nodeIds = new WeakMap<object, string>();
  let nextNodeNumber = 1;
  function project(value: unknown): SafeErrorProjection {
    if ((typeof value === "object" && value != null) || typeof value === "function") {
      if (nodeIds.has(value)) {
        const existingNodeId = nodeIds.get(value);
        if (existingNodeId == null) {
          throw new Error("再試行ログの原因参照を取得できません。");
        }
        return { kind: "reference", node_id: existingNodeId };
      }
      const nodeId = `error-${nextNodeNumber}`;
      nextNodeNumber += 1;
      nodeIds.set(value, nodeId);
      return projectDetail(value, nodeId);
    }
    const nodeId = `error-${nextNodeNumber}`;
    nextNodeNumber += 1;
    return projectDetail(value, nodeId);
  }
  function projectDetail(
    value: unknown,
    nodeId: string,
  ): SafeErrorProjection {
    const isError = value instanceof Error;
    const cause: SafeErrorCause = isError && Object.hasOwn(value, "cause")
      ? { kind: "present", value: project(value.cause) }
      : { kind: "absent" };
    const aggregateErrors = value instanceof AggregateError
      ? Array.from(value.errors, (nestedError) => project(nestedError))
      : [];
    return {
      kind: "error",
      node_id: nodeId,
      error_name: isError ? safeErrorName(value) : safeNonErrorName(value),
      description: safeErrorDescription(value, dependencies),
      stack_frames: isError ? safeStackFrames(value, dependencies.redactSensitiveText) : [],
      cause,
      aggregate_errors: aggregateErrors,
    };
  }
  return dependencies.projectionSchema.parse(project(error));
}
