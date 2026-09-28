import { z } from "zod";
import {
  dateSchema,
  gidSchema,
  getUtf8ByteLength,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
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

export type RankingScoreBreakdown = z.infer<typeof rankingScoreBreakdownSchema>;
export type RankingExclusionReasonCode = z.infer<typeof rankingExclusionReasonCodeSchema>;
export type RankingExclusionReason = z.infer<typeof rankingExclusionReasonSchema>;
export type RankingCacheDetail = z.infer<typeof rankingCacheDetailSchema>;
export type RankingTieBreak = z.infer<typeof rankingTieBreakSchema>;
export type RankingCache = z.infer<typeof rankingCacheSchema>;
export type DeviceSectionGids = z.infer<typeof deviceSectionGidsSchema>;
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type ExternalToolCredentialReferenceNames = z.infer<
  typeof externalToolCredentialReferenceNamesSchema
>;
export type VaultMapping = z.infer<typeof vaultMappingSchema>;
export type DiagnosticLogEntry = z.infer<typeof diagnosticLogEntrySchema>;
