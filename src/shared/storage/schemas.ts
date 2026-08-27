import { z } from "zod";
import {
  asanaTaskResponseSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  taskSchema,
  taskTagSchema,
} from "../domain";

const nonEmptyTextSchema = z.string().refine((value) => value.length > 0, {
  message: "空でない文字列を指定してください。",
});

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
export const customExternalDataCacheSchema = z.discriminatedUnion("status", [
  customExternalDataCacheValidSchema,
  customExternalDataCacheBrokenSchema,
  customExternalDataCacheUnknownVersionSchema,
]);

/** タスクキャッシュの一件を検証するスキーマです。 */
export const taskCacheEntrySchema = z
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
export const taskCacheEntriesSchema = z
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

const projectMetadataProjectSchema = z
  .object({
    gid: gidSchema,
    name: z.string().optional(),
  })
  .strict();

/** プロジェクトメタデータへ保存するセクションを検証するスキーマです。 */
export const projectMetadataSectionSchema = z
  .object({
    gid: gidSchema,
    name: nonBlankTextSchema,
  })
  .strict();

/** プロジェクトメタデータキャッシュの一件を検証するスキーマです。 */
export const projectMetadataCacheSchema = z
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

/** 順位点数の内訳を検証するスキーマです。 */
export const rankingScoreBreakdownSchema = z
  .object({
    importance_points: z.number().int().nonnegative(),
    deadline_points: z.number().int().nonnegative(),
    release_points: z.number().int().nonnegative(),
    partial_block_penalty: z.number().int().nonnegative(),
    stagnation_penalty: z.number().int().nonnegative(),
    execution_points: z.number().int(),
  })
  .strict();

/** 順位除外理由コードを検証するスキーマです。 */
export const rankingExclusionReasonCodeSchema = z.enum([
  "inactive_status",
  "full_block",
  "dependency_cycle",
  "parent_cycle",
  "completion_confirmation",
  "critical_error",
]);

const rankingCacheRankedTaskSchema = z
  .object({
    gid: gidSchema,
    rank: z.number().int().positive(),
    score_breakdown: rankingScoreBreakdownSchema,
  })
  .strict();

const rankingCacheExcludedTaskSchema = z
  .object({
    gid: gidSchema,
    exclusion_reasons: z
      .array(rankingExclusionReasonCodeSchema)
      .min(1)
      .superRefine((reasons, context) => {
        const seen = new Set<string>();
        reasons.forEach((reason, index) => {
          if (seen.has(reason)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "同じ順位除外理由コードを重複して保存できません。",
            });
            return;
          }
          seen.add(reason);
        });
      }),
    score_breakdown: rankingScoreBreakdownSchema.optional(),
  })
  .strict();

/** 順位キャッシュのスナップショットを検証するスキーマです。 */
export const rankingCacheSchema = z
  .object({
    app_version: identifierSchema,
    calculated_at: isoDateTimeSchema,
    ranked_tasks: z.array(rankingCacheRankedTaskSchema),
    excluded_tasks: z.array(rankingCacheExcludedTaskSchema),
  })
  .strict()
  .superRefine((cache, context) => {
    const seen = new Set<string>();
    cache.ranked_tasks.forEach((task, index) => {
      if (task.rank !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["ranked_tasks", index, "rank"],
          message: "順位キャッシュの順位は配列順の1からの連番でなければなりません。",
        });
      }
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: ["ranked_tasks", index, "gid"],
          message: "同じタスクGIDを順位キャッシュへ重複して保存できません。",
        });
        return;
      }
      seen.add(task.gid);
    });
    cache.excluded_tasks.forEach((task, index) => {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: ["excluded_tasks", index, "gid"],
          message: "同じタスクGIDを順位キャッシュへ重複して保存できません。",
        });
        return;
      }
      seen.add(task.gid);
    });
  });

/** プロジェクトごとの同期状態を検証するスキーマです。 */
export const syncStateSchema = z
  .object({
    project_gid: gidSchema,
    events_token: nonEmptyTextSchema.optional(),
    last_successful_sync_at: isoDateTimeSchema.optional(),
    last_full_sync_at: isoDateTimeSchema.optional(),
  })
  .strict();

/** 端末が使用する四つの状態セクションGIDを検証するスキーマです。 */
export const deviceSectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .superRefine((sectionGids, context) => {
    const seen = new Set<string>();
    Object.entries(sectionGids).forEach(([name, gid]) => {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "4つの状態セクションGIDはすべて異なる値で指定してください。",
        });
        return;
      }
      seen.add(gid);
    });
  });

/** 秘密情報を含まない端末設定を検証するスキーマです。 */
export const deviceSettingsSchema = z
  .object({
    client_id: identifierSchema,
    project_gid: gidSchema,
    section_gids: deviceSectionGidsSchema,
  })
  .strict();

/** Vaultと端末絶対パスの対応を検証するスキーマです。 */
export const vaultMappingSchema = z
  .object({
    vault_id: identifierSchema,
    absolute_path: nonEmptyTextSchema,
  })
  .strict();

/** Vaultマッピングの配列を重複なく検証するスキーマです。 */
export const vaultMappingsSchema = z
  .array(vaultMappingSchema)
  .superRefine((mappings, context) => {
    const seen = new Set<string>();
    mappings.forEach((mapping, index) => {
      if (seen.has(mapping.vault_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "vault_id"],
          message: "同じVault IDを重複して保存できません。",
        });
        return;
      }
      seen.add(mapping.vault_id);
    });
  });

/** 適用ジャーナルの対象を検証するスキーマです。 */
export const applicationJournalTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("new_task"),
      uuid: z.uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("task"),
      gid: gidSchema,
    })
    .strict(),
]);

/** 適用ジャーナルの段階識別子を検証するスキーマです。 */
export const applicationJournalStageSchema = z.enum([
  "started",
  "task_created",
  "attributes_applied",
  "relations_applied",
  "read_back",
  "metadata_verified",
  "ranking_recalculated",
]);

/** 適用ジャーナルの最終結果識別子を検証するスキーマです。 */
export const applicationJournalResultSchema = z.enum([
  "applied",
  "not_applied",
  "unknown",
  "failed",
]);

/** 適用ジャーナルの一件を検証するスキーマです。 */
export const applicationJournalSchema = z
  .object({
    proposal_id: identifierSchema,
    operation_id: identifierSchema,
    target: applicationJournalTargetSchema,
    started_at: isoDateTimeSchema,
    stage: applicationJournalStageSchema,
    final_result: applicationJournalResultSchema.optional(),
  })
  .strict();

const diagnosticSeveritySchema = z.enum(["debug", "info", "warning", "error"]);

/** 診断ログの固定コードを検証するスキーマです。 */
export const diagnosticCodeSchema = z.enum([
  "app.start",
  "app.stop",
  "sync.started",
  "sync.completed",
  "sync.failed",
  "asana.http",
  "asana.auth",
  "asana.rate_limited",
  "asana.events_reset",
  "asana.not_found",
  "external_data.invalid",
  "external_data.unknown_schema",
  "external_data.too_large",
  "proposal.validation_failed",
  "proposal.conflict",
  "proposal.application",
  "codex.status",
  "codex.protocol",
  "storage.error",
]);

/** 構造化診断ログを検証するスキーマです。 */
export const diagnosticLogEntrySchema = z
  .object({
    occurred_at: isoDateTimeSchema,
    severity: diagnosticSeveritySchema,
    code: diagnosticCodeSchema,
    http_status: z.number().int().min(100).max(599).optional(),
    asana_gid: gidSchema.optional(),
    proposal_id: identifierSchema.optional(),
    operation_id: identifierSchema.optional(),
    app_version: identifierSchema.optional(),
    codex_version: identifierSchema.optional(),
  })
  .strict();

export type CustomExternalDataCache = z.infer<typeof customExternalDataCacheSchema>;
export type TaskCacheEntry = z.infer<typeof taskCacheEntrySchema>;
export type ProjectMetadataCache = z.infer<typeof projectMetadataCacheSchema>;
export type ProjectMetadataSection = z.infer<typeof projectMetadataSectionSchema>;
export type RankingScoreBreakdown = z.infer<typeof rankingScoreBreakdownSchema>;
export type RankingExclusionReasonCode = z.infer<typeof rankingExclusionReasonCodeSchema>;
export type RankingCache = z.infer<typeof rankingCacheSchema>;
export type SyncState = z.infer<typeof syncStateSchema>;
export type DeviceSectionGids = z.infer<typeof deviceSectionGidsSchema>;
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type VaultMapping = z.infer<typeof vaultMappingSchema>;
export type ApplicationJournalTarget = z.infer<typeof applicationJournalTargetSchema>;
export type ApplicationJournalStage = z.infer<typeof applicationJournalStageSchema>;
export type ApplicationJournalResult = z.infer<typeof applicationJournalResultSchema>;
export type ApplicationJournal = z.infer<typeof applicationJournalSchema>;
export type DiagnosticLogEntry = z.infer<typeof diagnosticLogEntrySchema>;
