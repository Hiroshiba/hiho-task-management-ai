import { z } from "zod";
import { dependencySchema } from "../../../shared/ipc-contracts/task-values";

type Dependency = z.infer<typeof dependencySchema>;
type DependencyInputParseResult =
  | { readonly kind: "valid"; readonly value: Dependency[] }
  | { readonly kind: "invalid" };
const dependenciesSchema = z.array(dependencySchema).max(64)
  .refine((value) => new Set(value.map((dependency) => dependency.task_gid)).size === value.length);

/** 依存関係の入力を編集値へ検証します。 */
export function parseDependencyInput(value: string, current: readonly Dependency[]): DependencyInputParseResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "valid", value: [] };
  const currentByGid = new Map(current.map((dependency) => [dependency.task_gid, dependency]));
  const dependencies: Dependency[] = [];
  for (const entry of trimmed.split(",")) {
    const parts = entry.split(":").map((part) => part.trim());
    const gid = parts[0];
    if (gid == null || gid.length === 0 || parts.length > 2) return { kind: "invalid" };
    const existing = currentByGid.get(gid);
    if (parts.length === 1) {
      if (existing == null) return { kind: "invalid" };
      dependencies.push(existing);
      continue;
    }
    const scopeValue = parts[1];
    if (scopeValue !== "full" && scopeValue !== "partial") return { kind: "invalid" };
    dependencies.push({ task_gid: gid, scope: scopeValue, source: existing?.source ?? "renderer" });
  }
  const parsed = dependenciesSchema.safeParse(dependencies);
  return parsed.success ? { kind: "valid", value: parsed.data } : { kind: "invalid" };
}
