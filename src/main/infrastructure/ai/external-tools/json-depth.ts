function isJsonContainer(value: unknown): value is object {
  return typeof value === "object" && value != null;
}

/** 外部ツール要求のJSON深度を上限まで調べます。 */
export function jsonDepth(value: unknown, depth: number, maximumDepth: number): number {
  type Frame = {
    readonly value: unknown;
    readonly depth: number;
  };
  const stack: Frame[] = [{ value, depth }];
  let deepest = depth;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      throw new Error("JSON深度検証のスタックが不正です。");
    }
    deepest = Math.max(deepest, frame.depth);
    if (frame.depth > maximumDepth) {
      return deepest;
    }
    if (!isJsonContainer(frame.value)) {
      continue;
    }
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item, depth: frame.depth + 1 });
      }
      continue;
    }
    for (const item of Object.values(frame.value)) {
      stack.push({ value: item, depth: frame.depth + 1 });
    }
  }
  return deepest;
}
