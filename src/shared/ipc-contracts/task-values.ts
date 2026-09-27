import { z } from "zod";
import { dateSchema, dateTimeSchema, displayTextSchema, gidSchema, identifierSchema } from "./common";

export const taskStatusSchema = z.enum(["not_started", "in_progress", "completed", "withdrawn"]);
export const durationSchema = z
  .object({
    value: z.number().int().positive().safe(),
    unit: z.enum(["minute", "hour", "day", "week", "month"]),
  })
  .strict()
  .refine((duration) => duration.unit !== "minute" || duration.value >= 15);
export const dueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("on"), value: dateSchema }).strict(),
  z.object({ kind: z.literal("at"), value: dateTimeSchema }).strict(),
]);
export const parentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent") }).strict(),
  z.object({ kind: z.literal("existing"), gid: gidSchema }).strict(),
]);
export const dependencySchema = z
  .object({
    task_gid: gidSchema,
    scope: z.enum(["full", "partial"]),
    source: identifierSchema,
  })
  .strict();
export const obsidianLinkSchema = z
  .object({
    vault_id: identifierSchema,
    path: z.string().min(1).max(4_096),
    title: displayTextSchema,
    confidence: z.number().min(0).max(1),
  })
  .strict();

export const guiEditOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("update_title"), value: displayTextSchema }).strict(),
  z.object({ kind: z.literal("update_notes"), value: z.string().max(65_536) }).strict(),
  z.object({ kind: z.literal("set_status"), value: taskStatusSchema }).strict(),
  z.object({ kind: z.literal("complete") }).strict(),
  z.object({ kind: z.literal("withdraw") }).strict(),
  z
    .object({
      kind: z.literal("restore"),
      value: z.enum(["not_started", "in_progress"]),
    })
    .strict(),
  z.object({ kind: z.literal("mark_activity") }).strict(),
  z
    .object({
      kind: z.literal("set_importance"),
      value: z.number().int().min(1).max(5),
    })
    .strict(),
  z.object({ kind: z.literal("set_due"), value: dueSchema }).strict(),
  z.object({ kind: z.literal("clear_due") }).strict(),
  z.object({ kind: z.literal("set_duration"), value: durationSchema }).strict(),
  z.object({ kind: z.literal("clear_duration") }).strict(),
  z.object({ kind: z.literal("set_area"), value: displayTextSchema }).strict(),
  z
    .object({
      kind: z.literal("set_dependencies"),
      value: z.array(dependencySchema).max(64),
    })
    .strict(),
  z.object({ kind: z.literal("set_parent"), value: parentSchema }).strict(),
  z
    .object({
      kind: z.literal("set_parent_work_mode"),
      value: z.enum(["children_only", "has_own_work", "unknown"]),
    })
    .strict(),
  z.object({ kind: z.literal("link_obsidian"), value: obsidianLinkSchema }).strict(),
  z.object({ kind: z.literal("unlink_obsidian"), value: obsidianLinkSchema }).strict(),
]);

export type GuiEditOperation = z.infer<typeof guiEditOperationSchema>;
