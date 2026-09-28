import { z } from "zod";

type CacheSchemaDependencies<
  AsanaResponse extends { readonly gid: string },
  Task extends { readonly gid: string },
  Tag extends { readonly gid: string; readonly name: string },
> = {
  readonly gidSchema: z.ZodType<string>;
  readonly asanaTaskResponseSchema: z.ZodType<AsanaResponse>;
  readonly taskSchema: z.ZodType<Task>;
  readonly taskTagSchema: z.ZodType<Tag>;
  readonly isoDateTimeSchema: z.ZodType<string>;
};

/** SQLiteのタスクとプロジェクトキャッシュの検証schemaを作ります。 */
export function createTaskReadCacheSchemas<
  AsanaResponse extends { readonly gid: string },
  Task extends { readonly gid: string },
  Tag extends { readonly gid: string; readonly name: string },
>(dependencies: CacheSchemaDependencies<AsanaResponse, Task, Tag>) {
  const { gidSchema, asanaTaskResponseSchema, taskSchema, taskTagSchema, isoDateTimeSchema } = dependencies;
  const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "空白だけでない文字列を指定してください。",
  });

  const customExternalDataCacheValidSchema = z
    .object({
      status: z.literal("valid"),
      raw: z.string(),
    })
    .strict();

  const customExternalDataCacheBrokenSchema = z
    .object({
      status: z.literal("broken"),
      raw: z.string(),
    })
    .strict();

  const customExternalDataCacheUnknownVersionSchema = z
    .object({
      status: z.literal("unknown_version"),
      raw: z.string(),
      schema: z.number().int(),
    })
    .strict();

  /** Custom external dataのキャッシュ状態を検証するスキーマです。 */
  const customExternalDataCacheSchema = z.discriminatedUnion("status", [
    customExternalDataCacheValidSchema,
    customExternalDataCacheBrokenSchema,
    customExternalDataCacheUnknownVersionSchema,
  ]);

  /** タスクキャッシュの一件を検証するスキーマです。 */
  const taskCacheEntrySchema = z
    .object({
      gid: gidSchema,
      asana_response: asanaTaskResponseSchema,
      task: taskSchema,
      custom_external_data: customExternalDataCacheSchema.optional(),
      cached_at: isoDateTimeSchema,
    })
    .strict()
    .superRefine((entry, context) => {
      if (entry.asana_response.gid !== entry.gid) {
        context.addIssue({
          code: "custom",
          path: ["asana_response", "gid"],
          message: "AsanaレスポンスのGIDがキャッシュのGIDと一致しません。",
        });
      }
      if (entry.task.gid !== entry.gid) {
        context.addIssue({
          code: "custom",
          path: ["task", "gid"],
          message: "正規化タスクのGIDがキャッシュのGIDと一致しません。",
        });
      }
    });

  /** タスクキャッシュの配列を重複なく検証するスキーマです。 */
  const taskCacheEntriesSchema = z
    .array(taskCacheEntrySchema)
    .superRefine((entries, context) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.gid)) {
          context.addIssue({
            code: "custom",
            path: [index, "gid"],
            message: "同じGIDのタスクを重複して保存できません。",
          });
          return;
        }
        seen.add(entry.gid);
      });
    });

  const uniqueMissingTaskGidsSchema = z
    .array(gidSchema)
    .superRefine((gids, context) => {
      const seen = new Set<string>();
      gids.forEach((gid, index) => {
        if (seen.has(gid)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じGIDを差分削除対象へ重複して指定できません。",
          });
          return;
        }
        seen.add(gid);
      });
    });

  /** タスクキャッシュ差分を検証するスキーマです。 */
  const taskCacheDiffSchema = z
    .object({
      upsert: taskCacheEntriesSchema,
      missing_gids: uniqueMissingTaskGidsSchema,
    })
    .strict()
    .superRefine((diff, context) => {
      const upsertGids = new Set(diff.upsert.map((entry) => entry.gid));
      diff.missing_gids.forEach((gid, index) => {
        if (upsertGids.has(gid)) {
          context.addIssue({
            code: "custom",
            path: ["missing_gids", index],
            message: "同じGIDをupsertと削除の両方へ指定できません。",
          });
        }
      });
    });

  const projectMetadataProjectSchema = z
    .object({
      gid: gidSchema,
      name: z.string().optional(),
    })
    .strict();

  /** プロジェクトメタデータへ保存するセクションを検証するスキーマです。 */
  const projectMetadataSectionSchema = z
    .object({
      gid: gidSchema,
      name: nonBlankTextSchema,
    })
    .strict();

  /** プロジェクトメタデータキャッシュの一件を検証するスキーマです。 */
  const projectMetadataCacheSchema = z
    .object({
      project: projectMetadataProjectSchema,
      sections: z.array(projectMetadataSectionSchema),
      tags: z.array(taskTagSchema),
      cached_at: isoDateTimeSchema,
    })
    .strict()
    .superRefine((cache, context) => {
      const sectionGids = new Set<string>();
      cache.sections.forEach((section, index) => {
        if (sectionGids.has(section.gid)) {
          context.addIssue({
            code: "custom",
            path: ["sections", index, "gid"],
            message: "同じセクションGIDを重複して保存できません。",
          });
        }
        sectionGids.add(section.gid);
      });

      const tagGids = new Set<string>();
      cache.tags.forEach((tag, index) => {
        if (tagGids.has(tag.gid)) {
          context.addIssue({
            code: "custom",
            path: ["tags", index, "gid"],
            message: "同じタグGIDを重複して保存できません。",
          });
        }
        tagGids.add(tag.gid);
      });
    });
  return {
    customExternalDataCacheSchema,
    taskCacheEntrySchema,
    taskCacheEntriesSchema,
    taskCacheDiffSchema,
    projectMetadataSectionSchema,
    projectMetadataCacheSchema,
  };
}
