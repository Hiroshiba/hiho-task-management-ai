import { z } from "zod";

const identifierSchema = z.string().min(1).regex(/^\S+$/u);
const dateSchema = z.iso.date();
const isoDateTimeSchema = z.iso.datetime({ offset: true });
const gidSchema = identifierSchema;
const externalTaskGidPrefix = "TaskHub:v1:task:";
const externalTaskGidSchema = z.string().refine(
  (value) => value.startsWith(externalTaskGidPrefix)
    && z.uuid().safeParse(value.slice(externalTaskGidPrefix.length)).success,
);
const parentWorkModeSchema = z.enum(["children_only", "has_own_work", "unknown"]);
const dependencyScopeSchema = z.enum(["full", "partial"]);
const importanceSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
const areaSchema = z.string().refine((value) => value.trim().length > 0);
const importanceTagNameSchema = z.enum([
  "TaskHub/重要度/1",
  "TaskHub/重要度/2",
  "TaskHub/重要度/3",
  "TaskHub/重要度/4",
  "TaskHub/重要度/5",
]);
const areaTagNameSchema = z.string().refine(
  (value) => value.startsWith("TaskHub/領域/") && value.slice("TaskHub/領域/".length).trim().length > 0,
);
const durationSchema = z.object({
  value: z.number().int().positive().safe(),
  unit: z.enum(["minute", "hour", "day", "week", "month"]),
}).strict().refine((duration) => duration.unit !== "minute" || duration.value >= 15);
const relativePathSchema = z.string().refine((value) => {
  if (value.length === 0 || value.trim() !== value || value.split("").some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (codePoint <= 31 || codePoint === 127);
  })) return false;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/u.test(value)) return false;
  return value.split(/[\\/]/u).every((segment) => segment !== "" && segment !== "." && segment !== "..");
});
const obsidianLinkSchema = z.object({
  vault_id: identifierSchema,
  path: relativePathSchema.refine((value) => new TextEncoder().encode(value).byteLength <= 1024),
  title: z.string().refine((value) => value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 1024),
  confidence: z.number().finite().min(0).max(1),
}).strict();
const obsidianLinksSchema = z.array(obsidianLinkSchema).max(10).superRefine((links, context) => {
  const seen = new Set<string>();
  for (const [index, link] of links.entries()) {
    const key = `${link.vault_id}\u0000${link.path}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: [index], message: "同じVaultとパスのObsidianリンクを重複して指定できません。" });
    seen.add(key);
  }
});
const dependencySchema = z.object({
  task_gid: gidSchema,
  scope: dependencyScopeSchema,
  source: identifierSchema,
}).strict();
const dependenciesSchema = z.array(dependencySchema).max(64).superRefine((dependencies, context) => {
  const seen = new Set<string>();
  for (const [index, dependency] of dependencies.entries()) {
    if (seen.has(dependency.task_gid)) context.addIssue({ code: "custom", path: [index, "task_gid"], message: "同じ依存先を重複して指定できません。" });
    seen.add(dependency.task_gid);
  }
});
const customExternalDataSchema = z.object({
  schema: z.literal(1),
  id: z.uuid(),
  rev: z.number().int().positive(),
  last_active_status: z.enum(["not_started", "in_progress"]),
  activity_anchor_on: dateSchema,
  duration: durationSchema.optional(),
  parent_work_mode: parentWorkModeSchema,
  dependencies: dependenciesSchema,
  obsidian_links: obsidianLinksSchema,
  provenance: z.object({ created_via: identifierSchema, last_writer: identifierSchema }).strict(),
}).strict();
const snapshotHashSchema = z.string().regex(/^[0-9a-f]{64}$/u);

function isJsonValue(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) return false;
      return Reflect.ownKeys(value).every((key) => key === "length" || typeof key === "string"
        && /^(0|[1-9]\d*)$/u.test(key) && Number(key) < value.length
        && isJsonValue(Object.getOwnPropertyDescriptor(value, key)?.value, ancestors));
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && "value" in descriptor
        && isJsonValue(descriptor.value, ancestors);
    });
  } finally {
    ancestors.delete(value);
  }
}

/** 値を保存可能なJSON値として検証します。 */
export function isTaskWriteJsonValue(value: unknown): boolean {
  return isJsonValue(value, new WeakSet<object>());
}

/** JSON値をキー順で正規化した文字列に変換します。 */
export function canonicalizeTaskWriteJson(value: unknown): string {
  if (!isTaskWriteJsonValue(value)) throw new Error("正規化対象はJSON値でなければなりません。");
  function stringify(item: unknown): string {
    if (item === null || typeof item !== "object") {
      const encoded = JSON.stringify(item);
      if (encoded === undefined) throw new Error("JSON値の正規化に失敗しました。");
      return encoded;
    }
    if (Array.isArray(item)) return `[${item.map(stringify).join(",")}]`;
    return `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${stringify(Reflect.get(item, key))}`).join(",")}}`;
  }
  return stringify(value);
}

export {
  areaSchema,
  areaTagNameSchema,
  customExternalDataSchema,
  dateSchema,
  dependencyScopeSchema,
  durationSchema,
  externalTaskGidSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  importanceTagNameSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
  snapshotHashSchema,
};
