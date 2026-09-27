import { z } from "zod";
import {
  areaSchema,
  dependencyScopeSchema,
  durationSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
} from "../task-write-values";

/** 公開タスクの検証後に比較とグラフ計算に必要な値を投影します。 */
export const analysisTaskSchema = z.object({
  gid: gidSchema,
  title: z.string(),
  notes: z.string(),
  status: z.enum(["not_started", "in_progress", "completed", "withdrawn"]),
  importance: importanceSchema,
  area: areaSchema,
  parent_work_mode: parentWorkModeSchema,
  child_gids: z.array(gidSchema),
  dependencies: z.array(z.object({
    task_gid: gidSchema,
    scope: dependencyScopeSchema,
    source: identifierSchema,
  })),
  obsidian_links: obsidianLinksSchema,
  duration: durationSchema.optional(),
  due_on: z.string().optional(),
  due_at: z.string().optional(),
  parent_gid: gidSchema.optional(),
});

export type AnalysisTask = z.infer<typeof analysisTaskSchema>;
