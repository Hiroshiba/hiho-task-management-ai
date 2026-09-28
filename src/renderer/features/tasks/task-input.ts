import { z } from "zod";
import { dependencySchema } from "../../../shared/ipc-contracts/task-values";

type Dependency = z.infer<typeof dependencySchema>;
const dependenciesSchema = z.array(dependencySchema).max(64)
  .refine((value) => new Set(value.map((dependency) => dependency.task_gid)).size === value.length);

/** 依存関係の入力を編集値へ検証します。 */
export function parseDependencyInput(value: string, current: readonly Dependency[]): Dependency[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const currentByGid = new Map(current.map((dependency) => [dependency.task_gid, dependency]));
  const entries = trimmed.split(",").map((entry) => entry.trim());
  const dependencies = entries.map((entry) => {
    const parts = entry.split(":").map((part) => part.trim());
    const gid = parts[0];
    if (gid == null || gid.length === 0 || parts.length > 2) throw new Error("依存先の入力形式が不正です。");
    const existing = currentByGid.get(gid);
    if (parts.length === 1) {
      if (existing == null) throw new Error("新しい依存先にはfullまたはpartialを指定してください。");
      return existing;
    }
    const scopeValue = parts[1];
    if (scopeValue !== "full" && scopeValue !== "partial") throw new Error("依存先のscopeを指定してください。");
    return { task_gid: gid, scope: scopeValue, source: existing?.source ?? "renderer" };
  });
  return dependenciesSchema.parse(dependencies);
}
