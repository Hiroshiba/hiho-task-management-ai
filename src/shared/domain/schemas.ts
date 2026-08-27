import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  relativePathSchema,
  sectionGidSchema,
  tagNameSchema,
  vaultIdSchema,
} from "./primitives";

const externalTextSchema = z.string();
const boundedExternalTextSchema = createUtf8ByteLimitedStringSchema(1024);

function addUniqueIssue<T>(
  values: readonly T[],
  key: (value: T) => string,
  path: (index: number) => PropertyKey[],
  message: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const valueKey = key(value);
    if (seen.has(valueKey)) {
      context.addIssue({ code: "custom", message, path: path(index) });
      return;
    }
    seen.add(valueKey);
  });
}

function rejectBothDueValues(
  input: { due_on?: string | undefined; due_at?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (input.due_on != null && input.due_at != null) {
    context.addIssue({
      code: "custom",
      path: ["due_at"],
      message: "due_onとdue_atを同時に指定できません。",
    });
  }
}

const uniqueGidArraySchema = z
  .array(gidSchema)
  .superRefine((gids, context) => {
    addUniqueIssue(
      gids,
      (gid) => gid,
      (index) => [index],
      "同じタスクGIDを重複して指定できません。",
      context,
    );
  });

/** TaskHubが扱う進行状態を検証するスキーマです。 */
export const taskStatusSchema = z.enum([
  "not_started",
  "in_progress",
  "completed",
  "withdrawn",
]);

/** 状態を表すAsanaセクション名を検証するスキーマです。 */
export const statusSectionNameSchema = z.enum([
  "01 未着手",
  "02 進行中",
  "90 完了",
  "99 取り下げ",
]);

/** 状態を表すAsanaセクションを検証するスキーマです。 */
export const statusSectionSchema = z.discriminatedUnion("name", [
  z
    .object({
      gid: sectionGidSchema,
      name: z.literal("01 未着手"),
      status: z.literal("not_started"),
      completed: z.literal(false),
    })
    .strict(),
  z
    .object({
      gid: sectionGidSchema,
      name: z.literal("02 進行中"),
      status: z.literal("in_progress"),
      completed: z.literal(false),
    })
    .strict(),
  z
    .object({
      gid: sectionGidSchema,
      name: z.literal("90 完了"),
      status: z.literal("completed"),
      completed: z.literal(true),
    })
    .strict(),
  z
    .object({
      gid: sectionGidSchema,
      name: z.literal("99 取り下げ"),
      status: z.literal("withdrawn"),
      completed: z.literal(true),
    })
    .strict(),
]);

/** TaskHubが扱う重要度を検証するスキーマです。 */
export const importanceSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

/** 親タスク自身の作業有無を検証するスキーマです。 */
export const parentWorkModeSchema = z.enum([
  "children_only",
  "has_own_work",
  "unknown",
]);

/** 依存関係のブロック範囲を検証するスキーマです。 */
export const dependencyScopeSchema = z.enum(["full", "partial"]);

/** タスクのブロック状態を検証するスキーマです。 */
export const blockStateSchema = z.enum(["none", "partial", "full"]);

/** 重要度を表すAsanaタグ名を検証するスキーマです。 */
export const importanceTagNameSchema = z.enum([
  "TaskHub/重要度/1",
  "TaskHub/重要度/2",
  "TaskHub/重要度/3",
  "TaskHub/重要度/4",
  "TaskHub/重要度/5",
]);

/** ブロック状態を表すAsanaタグ名を検証するスキーマです。 */
export const blockTagNameSchema = z.enum([
  "TaskHub/ブロック/なし",
  "TaskHub/ブロック/一部",
  "TaskHub/ブロック/完全",
]);

/** 領域を表すAsanaタグ名を検証するスキーマです。 */
export const areaTagNameSchema = z.string().refine(
  (value) =>
    value.startsWith("TaskHub/領域/") &&
    value.slice("TaskHub/領域/".length).trim().length > 0,
  {
    message: "TaskHub/領域/で始まる領域タグ名を指定してください。",
  },
);

/** タスクの領域名を検証するスキーマです。 */
export const areaSchema = tagNameSchema;

/** 要整理一覧へ集約する問題種別を検証するスキーマです。 */
export const cleanupItemKindSchema = z.enum([
  "importance_tag_conflict",
  "area_tag_conflict",
  "unknown_status_section",
  "missing_required_section",
  "dependency_cycle",
  "missing_dependency",
  "parent_cycle",
  "children_only_completion_confirmation",
  "missing_task",
  "custom_external_data_broken",
  "oauth_app_mismatch",
  "proposal_conflict",
  "broken_vault_link",
]);

/** 要整理一覧へ表示する項目を検証するスキーマです。 */
export const cleanupItemSchema = z
  .object({
    kind: cleanupItemKindSchema,
    message: z.string().refine((value) => value.trim().length > 0, {
      message: "要整理項目の説明を空にできません。",
    }),
    task_gid: gidSchema.optional(),
    related_task_gids: uniqueGidArraySchema.optional(),
  })
  .strict();

/** 要整理項目の配列を検証するスキーマです。 */
export const cleanupItemsSchema = z.array(cleanupItemSchema);

/** Asanaタグのドメイン表現を検証するスキーマです。 */
export const taskTagSchema = z
  .object({
    gid: gidSchema,
    name: tagNameSchema,
  })
  .strict();

/** Custom external dataに保存する依存辺を検証するスキーマです。 */
export const dependencySchema = z
  .object({
    task_gid: gidSchema,
    scope: dependencyScopeSchema,
    source: identifierSchema,
  })
  .strict();

/** 親子関係の辺を検証するスキーマです。 */
export const parentChildRelationSchema = z
  .object({
    parent_gid: gidSchema,
    child_gid: gidSchema,
  })
  .strict();

/** Custom external dataに保存するObsidianリンクを検証するスキーマです。 */
export const obsidianLinkSchema = z
  .object({
    vault_id: vaultIdSchema,
    path: relativePathSchema.pipe(boundedExternalTextSchema),
    title: boundedExternalTextSchema.refine((value) => value.trim().length > 0, {
      message: "ノートタイトルを空にできません。",
    }),
    confidence: z.number().finite().min(0).max(1),
  })
  .strict();

/** Custom external dataの書き込み診断情報を検証するスキーマです。 */
export const provenanceSchema = z
  .object({
    created_via: identifierSchema,
    last_writer: identifierSchema,
  })
  .strict();

/** Custom external dataの依存辺配列を検証するスキーマです。 */
export const dependenciesSchema = z
  .array(dependencySchema)
  .max(64, "依存関係は1タスクあたり64件までです。")
  .superRefine((dependencies, context) => {
    addUniqueIssue(
      dependencies,
      (dependency) => dependency.task_gid,
      (index) => [index, "task_gid"],
      "同じ依存先を重複して指定できません。",
      context,
    );
  });

/** 依存グラフを検証するスキーマです。 */
export const dependencyGraphSchema = z.array(
  z
    .object({
      task_gid: gidSchema,
      dependencies: dependenciesSchema,
    })
    .strict(),
);

/** Custom external dataのObsidianリンク配列を検証するスキーマです。 */
export const obsidianLinksSchema = z
  .array(obsidianLinkSchema)
  .max(10, "Obsidianリンクは1タスクあたり10件までです。")
  .superRefine((links, context) => {
    addUniqueIssue(
      links,
      (link) => `${link.vault_id}\u0000${link.path}`,
      (index) => [index],
      "同じVaultとパスのObsidianリンクを重複して指定できません。",
      context,
    );
  });

/** 現行版のCustom external dataを検証するスキーマです。 */
export const customExternalDataSchema = z
  .object({
    schema: z.literal(1),
    id: z.uuid(),
    rev: z.number().int().positive(),
    last_active_status: z.enum(["not_started", "in_progress"]),
    activity_anchor_on: dateSchema,
    parent_work_mode: parentWorkModeSchema,
    dependencies: dependenciesSchema,
    obsidian_links: obsidianLinksSchema,
    provenance: provenanceSchema,
  })
  .strict();

/** Asanaタスクをアプリへ取り込むための正規化済みドメイン表現を検証するスキーマです。 */
export const taskSchema = z
  .object({
    gid: gidSchema,
    title: z.string().refine((value) => value.trim().length > 0, {
      message: "タスク名を空にできません。",
    }),
    notes: z.string(),
    status: taskStatusSchema,
    importance: importanceSchema,
    area: areaSchema,
    block_state: blockStateSchema,
    parent_work_mode: parentWorkModeSchema,
    section_gid: sectionGidSchema,
    completed: z.boolean(),
    tags: z.array(taskTagSchema),
    child_gids: uniqueGidArraySchema,
    dependencies: dependenciesSchema,
    obsidian_links: obsidianLinksSchema,
    activity_anchor_on: dateSchema,
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    parent_gid: gidSchema.optional(),
    created_at: isoDateTimeSchema.optional(),
    modified_at: isoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine(rejectBothDueValues);

/** 基準スナップショットへ保存するタスク値を検証するスキーマです。 */
export const taskSnapshotSchema = z
  .object({
    gid: gidSchema,
    title: z.string(),
    notes: z.string(),
    status: taskStatusSchema,
    importance: importanceSchema,
    area: areaSchema,
    block_state: blockStateSchema,
    parent_work_mode: parentWorkModeSchema,
    section_gid: sectionGidSchema,
    completed: z.boolean(),
    tags: z.array(taskTagSchema),
    child_gids: uniqueGidArraySchema,
    dependencies: dependenciesSchema,
    obsidian_links: obsidianLinksSchema,
    activity_anchor_on: dateSchema,
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    parent_gid: gidSchema.optional(),
  })
  .strict()
  .superRefine(rejectBothDueValues);

/** 同期の基準値を検証するスキーマです。 */
export const baselineSnapshotSchema = z
  .object({
    app_version: identifierSchema.optional(),
    project_gid: gidSchema.optional(),
    as_of: isoDateTimeSchema.optional(),
    tasks: z.array(taskSnapshotSchema),
  })
  .strict();

/** 同期スナップショットのドメイン表現を検証するスキーマです。 */
export const syncSnapshotSchema = z
  .object({
    app_version: identifierSchema,
    project_gid: gidSchema,
    synced_at: isoDateTimeSchema,
    tasks: z.array(taskSnapshotSchema),
    cleanup_items: cleanupItemsSchema.optional(),
  })
  .strict();

/** 基準スナップショットハッシュを検証するスキーマです。 */
export const snapshotHashSchema = z.string().regex(/^[0-9a-f]{64}$/u, {
  message: "小文字のSHA-256ハッシュを指定してください。",
});

/** 新規タスク作成要求を検証する厳格なアプリ境界スキーマです。 */
export const createTaskInputSchema = z
  .object({
    title: z.string().refine((value) => value.trim().length > 0, {
      message: "タスク名を空にできません。",
    }),
    notes: z.string().optional(),
    status: taskStatusSchema.optional(),
    importance: importanceSchema.optional(),
    area: areaSchema.optional(),
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    parent_gid: gidSchema.optional(),
    parent_work_mode: parentWorkModeSchema.optional(),
    dependencies: dependenciesSchema.optional(),
    obsidian_links: obsidianLinksSchema.optional(),
  })
  .strict()
  .superRefine(rejectBothDueValues);

/** 既存タスク更新要求を検証する厳格なアプリ境界スキーマです。 */
export const updateTaskInputSchema = z
  .object({
    gid: gidSchema,
    title: z
      .string()
      .refine((value) => value.trim().length > 0, {
        message: "タスク名を空にできません。",
      })
      .optional(),
    notes: z.string().optional(),
    status: taskStatusSchema.optional(),
    importance: importanceSchema.optional(),
    area: areaSchema.optional(),
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    parent_gid: gidSchema.optional(),
    parent_work_mode: parentWorkModeSchema.optional(),
    dependencies: dependenciesSchema.optional(),
    obsidian_links: obsidianLinksSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 1) {
      context.addIssue({
        code: "custom",
        message: "更新対象の項目を1つ以上指定してください。",
      });
    }
  });

/** Asanaタグレスポンスを未知フィールドを無視して検証するスキーマです。 */
export const asanaTagResponseSchema = z
  .object({
    gid: gidSchema,
    name: tagNameSchema,
  })
  .strip();

/** Asanaセクションレスポンスを未知フィールドを無視して検証するスキーマです。 */
export const asanaSectionResponseSchema = z
  .object({
    gid: sectionGidSchema,
    name: z.string(),
  })
  .strip();

/** Asanaプロジェクト参照を未知フィールドを無視して検証するスキーマです。 */
export const asanaProjectReferenceResponseSchema = z
  .object({
    gid: gidSchema,
    name: z.string().optional(),
  })
  .strip();

/** Asanaタスク参照を未知フィールドを無視して検証するスキーマです。 */
export const asanaTaskReferenceResponseSchema = z
  .object({
    gid: gidSchema,
    name: z.string().optional(),
  })
  .strip();

/** Asanaプロジェクト内所属を未知フィールドを無視して検証するスキーマです。 */
export const asanaMembershipResponseSchema = z
  .object({
    project: asanaProjectReferenceResponseSchema.optional(),
    section: asanaSectionResponseSchema.optional(),
  })
  .strip();

/** Asanaタスクレスポンスを未知フィールドを無視して検証するスキーマです。 */
export const asanaTaskResponseSchema = z
  .object({
    gid: gidSchema,
    name: z.string(),
    notes: externalTextSchema.optional(),
    completed: z.boolean().optional(),
    due_on: dateSchema.optional(),
    due_at: isoDateTimeSchema.optional(),
    created_at: isoDateTimeSchema.optional(),
    modified_at: isoDateTimeSchema.optional(),
    completed_at: isoDateTimeSchema.optional(),
    memberships: z.array(asanaMembershipResponseSchema).optional(),
    tags: z.array(asanaTagResponseSchema).optional(),
    parent: asanaTaskReferenceResponseSchema.optional(),
    subtasks: z.array(asanaTaskReferenceResponseSchema).optional(),
    projects: z.array(asanaProjectReferenceResponseSchema).optional(),
  })
  .strip();

/** Asanaページングレスポンスを未知フィールドを無視して検証するスキーマです。 */
export const asanaTaskPageResponseSchema = z
  .object({
    data: z.array(asanaTaskResponseSchema),
    next_page: z
      .object({
        offset: identifierSchema,
        path: z.string(),
        uri: z.string(),
      })
      .strip()
      .optional(),
  })
  .strip();

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type StatusSectionName = z.infer<typeof statusSectionNameSchema>;
export type StatusSection = z.infer<typeof statusSectionSchema>;
export type Importance = z.infer<typeof importanceSchema>;
export type ParentWorkMode = z.infer<typeof parentWorkModeSchema>;
export type DependencyScope = z.infer<typeof dependencyScopeSchema>;
export type BlockState = z.infer<typeof blockStateSchema>;
export type ImportanceTagName = z.infer<typeof importanceTagNameSchema>;
export type BlockTagName = z.infer<typeof blockTagNameSchema>;
export type AreaTagName = z.infer<typeof areaTagNameSchema>;
export type Area = z.infer<typeof areaSchema>;
export type CleanupItemKind = z.infer<typeof cleanupItemKindSchema>;
export type CleanupItem = z.infer<typeof cleanupItemSchema>;
export type TaskTag = z.infer<typeof taskTagSchema>;
export type Dependency = z.infer<typeof dependencySchema>;
export type ParentChildRelation = z.infer<typeof parentChildRelationSchema>;
export type DependencyGraph = z.infer<typeof dependencyGraphSchema>;
export type ObsidianLink = z.infer<typeof obsidianLinkSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type CustomExternalData = z.infer<typeof customExternalDataSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskSnapshot = z.infer<typeof taskSnapshotSchema>;
export type BaselineSnapshot = z.infer<typeof baselineSnapshotSchema>;
export type SyncSnapshot = z.infer<typeof syncSnapshotSchema>;
export type SnapshotHash = z.infer<typeof snapshotHashSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;
export type AsanaTaskResponse = z.infer<typeof asanaTaskResponseSchema>;
export type AsanaTaskPageResponse = z.infer<typeof asanaTaskPageResponseSchema>;
