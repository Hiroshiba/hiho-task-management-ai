import { z } from "zod";
import {
  asanaTaskResponseSchema,
  areaSchema,
  cleanupItemsSchema,
  dateSchema,
  dependencyScopeSchema,
  durationSchema,
  gidSchema,
  getUtf8ByteLength,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
  taskSchema,
  taskTagSchema,
} from "../domain";

const nonEmptyTextSchema = z.string().refine((value) => value.length > 0, {
  message: "空でない文字列を指定してください。",
});

const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "空白だけでない文字列を指定してください。",
});

const maximumVaultPathBytes = 4_096;

function isAbsoluteVaultPath(value: string): boolean {
  return (
    value.startsWith("/")
    || /^[A-Za-z]:[\\/]/u.test(value)
    || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
  );
}

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
export const taskCacheDiffSchema = z
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

/** 同期で保存する要整理項目のキャッシュを検証するスキーマです。 */
export const cleanupItemsCacheSchema = cleanupItemsSchema;

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

/** 順位除外理由のコードと説明を検証するスキーマです。 */
export const rankingExclusionReasonSchema = z
  .object({
    code: rankingExclusionReasonCodeSchema,
    message: nonBlankTextSchema,
  })
  .strict();

/** 順位の同点判定値を検証するスキーマです。 */
export const rankingTieBreakSchema = z
  .object({
    effective_due_at: isoDateTimeSchema.optional(),
    importance: importanceSchema,
    release_points: z.number().int().nonnegative(),
    activity_anchor_on: dateSchema,
    gid: gidSchema,
  })
  .strict();

/** 順位説明からタスク本文を除いた保存部分を検証するスキーマです。 */
export const rankingCacheDetailSchema = z
  .object({
    exclusion_reasons: z.array(rankingExclusionReasonSchema),
    tie_break: rankingTieBreakSchema,
    reason_chips: z.array(nonBlankTextSchema),
    text: nonEmptyTextSchema,
  })
  .strict();

const rankingReleaseTargetGidsSchema = z
  .array(gidSchema)
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    gids.forEach((gid, index) => {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じ解放対象タスクGIDを重複して保存できません。",
        });
      }
      seen.add(gid);
    });
  });

const rankingCacheRankedTaskSchema = z
  .object({
    gid: gidSchema,
    rank: z.number().int().positive(),
    score_breakdown: rankingScoreBreakdownSchema,
    release_target_gids: rankingReleaseTargetGidsSchema,
    reason_chips: z.array(nonBlankTextSchema),
    tie_break: rankingTieBreakSchema,
    detail: rankingCacheDetailSchema,
  })
  .strict();

const rankingCacheExcludedTaskSchema = z
  .object({
    gid: gidSchema,
    exclusion_reasons: z
      .array(rankingExclusionReasonSchema)
      .min(1)
      .superRefine((reasons, context) => {
        const seen = new Set<RankingExclusionReasonCode>();
        reasons.forEach((reason, index) => {
          if (seen.has(reason.code)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "同じ順位除外理由コードを重複して保存できません。",
            });
            return;
          }
          seen.add(reason.code);
        });
      }),
    score_breakdown: rankingScoreBreakdownSchema.optional(),
    release_target_gids: rankingReleaseTargetGidsSchema,
    reason_chips: z.array(nonBlankTextSchema),
    tie_break: rankingTieBreakSchema,
    detail: rankingCacheDetailSchema,
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
    device_id: identifierSchema,
    client_id: identifierSchema,
    workspace_gid: gidSchema,
    project_gid: gidSchema,
    section_gids: deviceSectionGidsSchema,
  })
  .strict();

/** 外部ツールが参照する資格情報名の配列を検証するスキーマです。 */
export const externalToolCredentialReferenceNamesSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value.trim().length > 0, {
        message: "資格情報参照名を空白だけにできません。",
      })
      .refine(
        (value) => ![...value].some((character) => {
          const codePoint = character.codePointAt(0);
          return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
        }),
        {
          message: "資格情報参照名に制御文字を指定できません。",
        },
      ),
  )
  .max(64)
  .superRefine((names, context) => {
    const seen = new Set<string>();
    names.forEach((name, index) => {
      if (seen.has(name)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じ資格情報参照名を重複して保存できません。",
        });
      }
      seen.add(name);
    });
  });

/** Vaultと端末絶対パスの対応を検証するスキーマです。 */
export const vaultMappingSchema = z
  .object({
    vault_id: identifierSchema,
    absolute_path: nonEmptyTextSchema
      .refine(
        (value) => getUtf8ByteLength(value) <= maximumVaultPathBytes,
        "Vaultの絶対パスが長さ上限を超えています。",
      )
      .refine(
        (value) => !value.includes("\0"),
        "Vaultの絶対パスにNUL文字を指定できません。",
      )
      .refine(
        isAbsoluteVaultPath,
        "Vaultのパスは絶対パスで指定してください。",
      ),
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
  z
    .object({
      kind: z.literal("temporary"),
      ref: identifierSchema,
    })
    .strict(),
]);

/** 適用ジャーナルの段階識別子を検証するスキーマです。 */
export const applicationJournalStageSchema = z.enum([
  "prepared",
  "started",
  "write_started",
  "task_created",
  "attributes_applied",
  "relations_applied",
  "read_back",
  "metadata_verified",
  "ranking_recalculated",
  "legacy_unresolved",
]);

/** 適用ジャーナルの最終結果識別子を検証するスキーマです。 */
export const applicationJournalResultSchema = z.enum([
  "applied",
  "not_applied",
  "unknown",
  "failed",
]);

const applicationJournalExistingTargetReferenceSchema = z
  .object({
    kind: z.literal("existing"),
    gid: gidSchema,
  })
  .strict();

const applicationJournalTemporaryTargetReferenceSchema = z
  .object({
    kind: z.literal("temporary"),
    ref: identifierSchema,
  })
  .strict();

const applicationJournalOperationTargetReferenceSchema = z.discriminatedUnion("kind", [
  applicationJournalExistingTargetReferenceSchema,
  applicationJournalTemporaryTargetReferenceSchema,
]);

const applicationJournalCreateTargetSchema = z
  .object({
    kind: z.literal("new_task"),
    uuid: z.uuid(),
  })
  .strict();

const applicationJournalAbsentValueSchema = z
  .object({ kind: z.literal("absent") })
  .strict();

const applicationJournalDueValueSchema = z.discriminatedUnion("kind", [
  applicationJournalAbsentValueSchema,
  z
    .object({
      kind: z.literal("due_on"),
      due_on: dateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_at"),
      due_at: isoDateTimeSchema,
    })
    .strict(),
]);

const applicationJournalPresentDueValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("due_on"),
      due_on: dateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_at"),
      due_at: isoDateTimeSchema,
    })
    .strict(),
]);

const applicationJournalDurationValueSchema = z.union([
  applicationJournalAbsentValueSchema,
  durationSchema,
]);

const applicationJournalDependencySchema = z
  .object({
    target: applicationJournalOperationTargetReferenceSchema,
    scope: dependencyScopeSchema,
    source: identifierSchema,
  })
  .strict();

const applicationJournalDependenciesSchema = z
  .array(applicationJournalDependencySchema)
  .max(64)
  .superRefine((dependencies, context) => {
    const seen = new Set<string>();
    dependencies.forEach((dependency, index) => {
      const targetKey = dependency.target.kind === "existing"
        ? dependency.target.gid
        : dependency.target.ref;
      const key = `${dependency.target.kind}\u0000${targetKey}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "target"],
          message: "同じ依存先を復旧計画へ重複して指定できません。",
        });
        return;
      }
      seen.add(key);
    });
  });

const applicationJournalParentValueSchema = z.discriminatedUnion("kind", [
  applicationJournalAbsentValueSchema,
  applicationJournalExistingTargetReferenceSchema,
  applicationJournalTemporaryTargetReferenceSchema,
]);

const applicationJournalCreateFieldsSchema = z
  .object({
    title: z.string().refine((value) => value.trim().length > 0),
    notes: z.string().optional(),
    status: z.enum(["not_started", "in_progress"]).optional(),
    importance: importanceSchema.optional(),
    area: areaSchema.optional(),
    due: applicationJournalPresentDueValueSchema.optional(),
    duration: durationSchema.optional(),
    parent: applicationJournalOperationTargetReferenceSchema.optional(),
    parent_work_mode: parentWorkModeSchema.optional(),
    dependencies: applicationJournalDependenciesSchema.optional(),
    obsidian_links: obsidianLinksSchema.optional(),
  })
  .strict();

const applicationJournalOperationBaseShape = {
  operation_id: identifierSchema,
  target: applicationJournalOperationTargetReferenceSchema,
};

const applicationJournalCreateOperationSchema = z
  .object({
    operation: z.literal("create_task"),
    operation_id: identifierSchema,
    target: applicationJournalCreateTargetSchema,
    temporary_ref: identifierSchema,
    expected_before: applicationJournalAbsentValueSchema,
    expected_after: applicationJournalCreateFieldsSchema,
  })
  .strict();

const applicationJournalUpdateTitleOperationSchema = z
  .object({
    operation: z.literal("update_title"),
    ...applicationJournalOperationBaseShape,
    expected_before: z.string().refine((value) => value.trim().length > 0),
    expected_after: z.string().refine((value) => value.trim().length > 0),
  })
  .strict();

const applicationJournalUpdateNotesOperationSchema = z
  .object({
    operation: z.literal("update_notes"),
    ...applicationJournalOperationBaseShape,
    expected_before: z.string(),
    expected_after: z.string(),
  })
  .strict();

const applicationJournalSetStatusOperationSchema = z
  .object({
    operation: z.literal("set_status"),
    ...applicationJournalOperationBaseShape,
    expected_before: z.enum(["not_started", "in_progress", "completed", "withdrawn"]),
    expected_after: z.enum(["not_started", "in_progress"]),
  })
  .strict();

const applicationJournalSetImportanceOperationSchema = z
  .object({
    operation: z.literal("set_importance"),
    ...applicationJournalOperationBaseShape,
    expected_before: importanceSchema,
    expected_after: importanceSchema,
  })
  .strict();

const applicationJournalSetDueOperationSchema = z
  .object({
    operation: z.literal("set_due"),
    ...applicationJournalOperationBaseShape,
    expected_before: applicationJournalDueValueSchema,
    expected_after: applicationJournalPresentDueValueSchema,
  })
  .strict();

const applicationJournalClearDueOperationSchema = z
  .object({
    operation: z.literal("clear_due"),
    ...applicationJournalOperationBaseShape,
    expected_before: applicationJournalPresentDueValueSchema,
    expected_after: applicationJournalAbsentValueSchema,
  })
  .strict();

const applicationJournalSetDurationOperationSchema = z
  .object({
    operation: z.literal("set_duration"),
    ...applicationJournalOperationBaseShape,
    expected_before: applicationJournalDurationValueSchema,
    expected_after: durationSchema,
  })
  .strict();

const applicationJournalClearDurationOperationSchema = z
  .object({
    operation: z.literal("clear_duration"),
    ...applicationJournalOperationBaseShape,
    expected_before: durationSchema,
    expected_after: applicationJournalAbsentValueSchema,
  })
  .strict();

const applicationJournalSetAreaOperationSchema = z
  .object({
    operation: z.literal("set_area"),
    ...applicationJournalOperationBaseShape,
    expected_before: areaSchema,
    expected_after: areaSchema,
  })
  .strict();

const applicationJournalSetDependenciesOperationSchema = z
  .object({
    operation: z.literal("set_dependencies"),
    ...applicationJournalOperationBaseShape,
    expected_before: applicationJournalDependenciesSchema,
    expected_after: applicationJournalDependenciesSchema,
  })
  .strict();

const applicationJournalSetParentOperationSchema = z
  .object({
    operation: z.literal("set_parent"),
    ...applicationJournalOperationBaseShape,
    expected_before: applicationJournalParentValueSchema,
    expected_after: applicationJournalParentValueSchema,
  })
  .strict();

const applicationJournalSetParentWorkModeOperationSchema = z
  .object({
    operation: z.literal("set_parent_work_mode"),
    ...applicationJournalOperationBaseShape,
    expected_before: parentWorkModeSchema,
    expected_after: parentWorkModeSchema,
  })
  .strict();

const applicationJournalLinkObsidianOperationSchema = z
  .object({
    operation: z.literal("link_obsidian"),
    ...applicationJournalOperationBaseShape,
    expected_before: applicationJournalAbsentValueSchema,
    expected_after: obsidianLinkSchema,
  })
  .strict();

const applicationJournalUnlinkObsidianOperationSchema = z
  .object({
    operation: z.literal("unlink_obsidian"),
    ...applicationJournalOperationBaseShape,
    expected_before: obsidianLinkSchema,
    expected_after: applicationJournalAbsentValueSchema,
  })
  .strict();

const applicationJournalCompleteOperationSchema = z
  .object({
    operation: z.literal("complete"),
    ...applicationJournalOperationBaseShape,
    expected_before: z.enum(["not_started", "in_progress"]),
    expected_after: z.literal("completed"),
  })
  .strict();

const applicationJournalWithdrawOperationSchema = z
  .object({
    operation: z.literal("withdraw"),
    ...applicationJournalOperationBaseShape,
    expected_before: z.enum(["not_started", "in_progress"]),
    expected_after: z.literal("withdrawn"),
  })
  .strict();

/** 再起動後のwriterに渡す操作本体を検証するスキーマです。 */
export const applicationJournalOperationSchema = z.discriminatedUnion("operation", [
  applicationJournalCreateOperationSchema,
  applicationJournalUpdateTitleOperationSchema,
  applicationJournalUpdateNotesOperationSchema,
  applicationJournalSetStatusOperationSchema,
  applicationJournalSetImportanceOperationSchema,
  applicationJournalSetDueOperationSchema,
  applicationJournalClearDueOperationSchema,
  applicationJournalSetDurationOperationSchema,
  applicationJournalClearDurationOperationSchema,
  applicationJournalSetAreaOperationSchema,
  applicationJournalSetDependenciesOperationSchema,
  applicationJournalSetParentOperationSchema,
  applicationJournalSetParentWorkModeOperationSchema,
  applicationJournalLinkObsidianOperationSchema,
  applicationJournalUnlinkObsidianOperationSchema,
  applicationJournalCompleteOperationSchema,
  applicationJournalWithdrawOperationSchema,
]);

const applicationJournalSectionGidsSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .superRefine((sectionGids, context) => {
    const seen = new Set<string>();
    for (const [name, gid] of Object.entries(sectionGids)) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "状態セクションGIDを重複して復旧計画へ指定できません。",
        });
      }
      seen.add(gid);
    }
  });

const applicationJournalTemporaryRefMappingSchema = z
  .object({
    temporary_ref: identifierSchema,
    task_gid: gidSchema,
  })
  .strict();

/** 外部API呼び出し前に保存する適用操作の復旧計画を検証するスキーマです。 */
export const applicationJournalPlanSchema = z
  .object({
    group_id: identifierSchema,
    group_order: z.number().int().nonnegative(),
    operation_order: z.number().int().nonnegative(),
    atomic: z.boolean(),
    project_gid: gidSchema,
    workspace_gid: gidSchema,
    section_gids: applicationJournalSectionGidsSchema,
    device_id: identifierSchema,
    created_via: identifierSchema,
    activity_date: dateSchema,
    temporary_ref_to_gid: z
      .array(applicationJournalTemporaryRefMappingSchema)
      .max(256)
      .superRefine((mappings, context) => {
        const temporaryRefs = new Set<string>();
        const taskGids = new Set<string>();
        mappings.forEach((mapping, index) => {
          if (temporaryRefs.has(mapping.temporary_ref)) {
            context.addIssue({
              code: "custom",
              path: [index, "temporary_ref"],
              message: "temporary_refを復旧計画へ重複して指定できません。",
            });
          }
          if (taskGids.has(mapping.task_gid)) {
            context.addIssue({
              code: "custom",
              path: [index, "task_gid"],
              message: "temporary_refの対応先を復旧計画へ重複して指定できません。",
            });
          }
          temporaryRefs.add(mapping.temporary_ref);
          taskGids.add(mapping.task_gid);
        });
      }),
    operation: applicationJournalOperationSchema,
    create_uuid: z.uuid().optional(),
  })
  .strict()
  .superRefine((plan, context) => {
    const create = plan.operation.operation === "create_task";
    if (create !== (plan.create_uuid != null)) {
      context.addIssue({
        code: "custom",
        path: ["create_uuid"],
        message: "create_taskと作成UUIDの指定が一致しません。",
      });
    }
    if (create) {
      if (plan.operation.target.kind !== "new_task") {
        context.addIssue({
          code: "custom",
          path: ["operation", "target"],
          message: "create_taskの復旧対象は新規タスクでなければなりません。",
        });
      } else if (plan.create_uuid !== plan.operation.target.uuid) {
        context.addIssue({
          code: "custom",
          path: ["create_uuid"],
          message: "作成UUIDが復旧対象と一致しません。",
        });
      }
    } else if (
      plan.operation.target.kind !== "existing"
      && plan.operation.target.kind !== "temporary"
    ) {
      context.addIssue({
        code: "custom",
        path: ["operation", "target"],
        message: "既存タスク操作の復旧対象が不正です。",
      });
    }
  });

const applicationJournalBaseShape = {
  proposal_id: identifierSchema,
  operation_id: identifierSchema,
  target: applicationJournalTargetSchema,
  started_at: isoDateTimeSchema,
};

const applicationJournalPreparedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("prepared"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalWriteStartedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("write_started"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalTaskCreatedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("task_created"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalAttributesAppliedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("attributes_applied"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalRelationsAppliedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("relations_applied"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalReadBackSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("read_back"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalMetadataVerifiedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("metadata_verified"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

const applicationJournalRankingRecalculatedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("ranking_recalculated"),
    final_result: applicationJournalResultSchema.optional(),
    plan: applicationJournalPlanSchema,
  })
  .strict();

/** 復旧計画を必ず含む適用ジャーナルを検証するスキーマです。 */
export const applicationJournalWithPlanSchema = z.discriminatedUnion("stage", [
  applicationJournalPreparedSchema,
  applicationJournalWriteStartedSchema,
  applicationJournalTaskCreatedSchema,
  applicationJournalAttributesAppliedSchema,
  applicationJournalRelationsAppliedSchema,
  applicationJournalReadBackSchema,
  applicationJournalMetadataVerifiedSchema,
  applicationJournalRankingRecalculatedSchema,
]);

const applicationJournalLegacyUnresolvedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("legacy_unresolved"),
    final_result: z.literal("unknown").optional(),
    plan: z.undefined().optional(),
  })
  .strict();

/** 適用ジャーナルの一件を検証するスキーマです。 */
export const applicationJournalSchema = z.discriminatedUnion("stage", [
  applicationJournalPreparedSchema,
  applicationJournalWriteStartedSchema,
  applicationJournalTaskCreatedSchema,
  applicationJournalAttributesAppliedSchema,
  applicationJournalRelationsAppliedSchema,
  applicationJournalReadBackSchema,
  applicationJournalMetadataVerifiedSchema,
  applicationJournalRankingRecalculatedSchema,
  applicationJournalLegacyUnresolvedSchema,
]);

const applicationJournalLegacyCompletedStartedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("started"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

const applicationJournalLegacyCompletedTaskCreatedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("task_created"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

const applicationJournalLegacyCompletedAttributesAppliedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("attributes_applied"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

const applicationJournalLegacyCompletedRelationsAppliedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("relations_applied"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

const applicationJournalLegacyCompletedReadBackSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("read_back"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

const applicationJournalLegacyCompletedMetadataVerifiedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("metadata_verified"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

const applicationJournalLegacyCompletedRankingRecalculatedSchema = z
  .object({
    ...applicationJournalBaseShape,
    stage: z.literal("ranking_recalculated"),
    final_result: applicationJournalResultSchema,
    plan: z.undefined().optional(),
  })
  .strict();

/** v3から移行した完了済み適用ジャーナルを読み出すスキーマです。 */
export const applicationJournalLegacyCompletedSchema = z.discriminatedUnion("stage", [
  applicationJournalLegacyCompletedStartedSchema,
  applicationJournalLegacyCompletedTaskCreatedSchema,
  applicationJournalLegacyCompletedAttributesAppliedSchema,
  applicationJournalLegacyCompletedRelationsAppliedSchema,
  applicationJournalLegacyCompletedReadBackSchema,
  applicationJournalLegacyCompletedMetadataVerifiedSchema,
  applicationJournalLegacyCompletedRankingRecalculatedSchema,
]);

/** 現行形式またはv3から移行した完了済み行を読み出すスキーマです。 */
export const applicationJournalReadableSchema = z.union([
  applicationJournalSchema,
  applicationJournalLegacyCompletedSchema,
]);

const diagnosticSeveritySchema = z.enum(["debug", "info", "warning", "error"]);

/** 診断ログの固定コードを検証するスキーマです。 */
export const diagnosticCodeSchema = z.enum([
  "app.start",
  "app.stop",
  "app.error",
  "ipc.error",
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
  "external_tools.status",
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
export type TaskCacheDiff = z.infer<typeof taskCacheDiffSchema>;
export type CleanupItemsCache = z.infer<typeof cleanupItemsCacheSchema>;
export type ProjectMetadataCache = z.infer<typeof projectMetadataCacheSchema>;
export type ProjectMetadataSection = z.infer<typeof projectMetadataSectionSchema>;
export type RankingScoreBreakdown = z.infer<typeof rankingScoreBreakdownSchema>;
export type RankingExclusionReasonCode = z.infer<typeof rankingExclusionReasonCodeSchema>;
export type RankingExclusionReason = z.infer<typeof rankingExclusionReasonSchema>;
export type RankingCacheDetail = z.infer<typeof rankingCacheDetailSchema>;
export type RankingTieBreak = z.infer<typeof rankingTieBreakSchema>;
export type RankingCache = z.infer<typeof rankingCacheSchema>;
export type SyncState = z.infer<typeof syncStateSchema>;
export type DeviceSectionGids = z.infer<typeof deviceSectionGidsSchema>;
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type ExternalToolCredentialReferenceNames = z.infer<
  typeof externalToolCredentialReferenceNamesSchema
>;
export type VaultMapping = z.infer<typeof vaultMappingSchema>;
export type ApplicationJournalTarget = z.infer<typeof applicationJournalTargetSchema>;
export type ApplicationJournalStage = z.infer<typeof applicationJournalStageSchema>;
export type ApplicationJournalResult = z.infer<typeof applicationJournalResultSchema>;
export type ApplicationJournal =
  z.infer<typeof applicationJournalReadableSchema>;
export type ApplicationJournalOperation = z.infer<typeof applicationJournalOperationSchema>;
export type ApplicationJournalPlan = z.infer<typeof applicationJournalPlanSchema>;
export type DiagnosticLogEntry = z.infer<typeof diagnosticLogEntrySchema>;
