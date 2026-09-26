export type TaskDueValue =
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };


export function sameDueValue(left: TaskDueValue, right: TaskDueValue): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "absent" && right.kind === "absent") {
    return true;
  }
  if (left.kind === "due_on" && right.kind === "due_on") {
    return left.due_on === right.due_on;
  }
  if (left.kind === "due_at" && right.kind === "due_at") {
    return left.due_at === right.due_at;
  }
  return false;
}

export function sameDurationValue<T extends { readonly value: number; readonly unit: string }>(
  left: T | { readonly kind: "absent" },
  right: T | { readonly kind: "absent" },
): boolean {
  if ("kind" in left || "kind" in right) {
    return "kind" in left && "kind" in right;
  }
  return left.value === right.value && left.unit === right.unit;
}
