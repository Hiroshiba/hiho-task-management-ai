import { z } from "zod";
import {
  asanaSnapshotNormalizationInputSchema,
  asanaSnapshotNormalizationResultSchema,
  customExternalDataInitializationInputSchema,
  ingestAsanaExternalData,
  type CustomExternalDataMergeInput,
  type CustomExternalDataInitializationResult,
  type ExternalDataIngestionResult,
  type SnapshotNormalizationInput,
  type SnapshotNormalizationResult,
  type SnapshotStatusPlan,
} from "../../domain";

const asanaTaskResponseSchema =
  asanaSnapshotNormalizationInputSchema.shape.tasks.element;
const asanaTagResponseSchema = asanaTaskResponseSchema.shape.tags.element;
const dateSchema = asanaSnapshotNormalizationInputSchema.shape.activity_date;
const gidSchema = asanaSnapshotNormalizationInputSchema.shape.project_gid;
const identifierSchema = customExternalDataInitializationInputSchema.shape.device_id;

type AsanaTaskResponse = SnapshotNormalizationInput["tasks"][number];
type CustomExternalData = CustomExternalDataMergeInput["current"];

const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);
const operationOutcomeSchema = z.enum([
  "applied",
  "already_applied",
  "conflict",
]);
const operationReasonCodeSchema = z.enum([
  "applied",
  "already_applied",
  "already_initialized",
  "baseline_changed",
  "read_back_mismatch",
  "external_unreadable",
  "external_identity_mismatch",
  "merge_conflict",
]);

const moveSectionResultSchema = z
  .object({
    operation: z.literal("move_section"),
    task_gid: gidSchema,
    section_gid: gidSchema,
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const setCompletedResultSchema = z
  .object({
    operation: z.literal("set_completed"),
    task_gid: gidSchema,
    completed: z.boolean(),
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const initializeExternalDataResultSchema = z
  .object({
    operation: z.literal("initialize_external_data"),
    task_gid: gidSchema,
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const updateLastActiveStatusResultSchema = z
  .object({
    operation: z.literal("update_last_active_status"),
    task_gid: gidSchema,
    value: activeTaskStatusSchema,
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const updateActivityAnchorOnResultSchema = z
  .object({
    operation: z.literal("update_activity_anchor_on"),
    task_gid: gidSchema,
    value: dateSchema,
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const addTagResultSchema = z
  .object({
    operation: z.literal("add_tag"),
    task_gid: gidSchema,
    tag_gid: gidSchema,
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const removeTagResultSchema = z
  .object({
    operation: z.literal("remove_tag"),
    task_gid: gidSchema,
    tag_gid: gidSchema,
    outcome: operationOutcomeSchema,
    reason_code: operationReasonCodeSchema,
  })
  .strict();

const operationResultSchema = z.discriminatedUnion("operation", [
  moveSectionResultSchema,
  setCompletedResultSchema,
  initializeExternalDataResultSchema,
  updateLastActiveStatusResultSchema,
  updateActivityAnchorOnResultSchema,
  addTagResultSchema,
  removeTagResultSchema,
]);

const asanaTaskArraySchema = z
  .array(asanaTaskResponseSchema)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (const [index, task] of tasks.entries()) {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "同じAsanaタスクGIDを重複して指定できません。",
        });
      }
      seen.add(task.gid);
    }
  });

const workspaceTagArraySchema = z
  .array(asanaTagResponseSchema)
  .superRefine((tags, context) => {
    const seenGids = new Set<string>();
    for (const [index, tag] of tags.entries()) {
      if (seenGids.has(tag.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "同じワークスペースタグGIDを重複して指定できません。",
        });
      }
      seenGids.add(tag.gid);
    }
  });

export const applierInputSchema = z
  .object({
    normalization_result: asanaSnapshotNormalizationResultSchema,
    asana_tasks: asanaTaskArraySchema,
    workspace_tags: workspaceTagArraySchema,
    device_id: identifierSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const normalizedGids = new Set(
      input.normalization_result.tasks.map((task) => task.gid),
    );
    const asanaGids = new Set(input.asana_tasks.map((task) => task.gid));
    const sameSize = normalizedGids.size === asanaGids.size;
    const sameValues =
      sameSize && [...normalizedGids].every((gid) => asanaGids.has(gid));
    if (!sameValues) {
      context.addIssue({
        code: "custom",
        path: ["asana_tasks"],
        message: "正規化前AsanaタスクのGID集合が正規化結果と一致しません。",
      });
    }
    const seenNames = new Set<string>();
    for (const [index, tag] of input.workspace_tags.entries()) {
      if (seenNames.has(tag.name)) {
        context.addIssue({
          code: "custom",
          path: ["workspace_tags", index, "name"],
          message: "同名のワークスペースタグを複数指定できません。",
        });
      }
      seenNames.add(tag.name);
    }
  });

export const resultSchema = z
  .object({
    affected_gids: z
      .array(gidSchema)
      .superRefine((gids, context) => {
        const seen = new Set<string>();
        let previous: string | undefined;
        for (const [index, gid] of gids.entries()) {
          if (seen.has(gid)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "影響対象GIDを重複して指定できません。",
            });
          }
          if (previous != null && previous >= gid) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "影響対象GIDをGID順に並べてください。",
            });
          }
          seen.add(gid);
          previous = gid;
        }
      }),
    operations: z.array(operationResultSchema),
  })
  .strict()
  .superRefine((result, context) => {
    const operationKeys = new Set<string>();
    const operationGids = new Set<string>();
    for (const [index, operation] of result.operations.entries()) {
      const key = operationKey(operation);
      if (operationKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index],
          message: "同じ正規化操作の結果を重複して指定できません。",
        });
      }
      operationKeys.add(key);
      operationGids.add(operation.task_gid);
    }
    const affectedSet = new Set(result.affected_gids);
    const sameSize = affectedSet.size === operationGids.size;
    const sameValues =
      sameSize && [...affectedSet].every((gid) => operationGids.has(gid));
    if (!sameValues) {
      context.addIssue({
        code: "custom",
        path: ["affected_gids"],
        message: "影響対象GIDが操作結果のGID集合と一致しません。",
      });
    }
  });

export type AsanaNormalizationPlanApplierInput = z.infer<
  typeof applierInputSchema
>;
export type AsanaNormalizationPlanApplierResult = z.infer<
  typeof resultSchema
>;
export type UuidGenerator = () => string;

/** Asana正規化計画の入力を検証するスキーマです。 */
export const asanaNormalizationPlanApplierInputSchema = applierInputSchema;

/** Asana正規化計画の適用結果を検証するスキーマです。 */
export const asanaNormalizationPlanApplierResultSchema = resultSchema;

export type StatusOperationResult =
  | z.infer<typeof moveSectionResultSchema>
  | z.infer<typeof setCompletedResultSchema>;
export type AsanaNormalizationPlanOperationResult = z.infer<
  typeof operationResultSchema
>;
export type TagOperationResult =
  | z.infer<typeof addTagResultSchema>
  | z.infer<typeof removeTagResultSchema>;
type OperationOutcome = z.infer<typeof operationOutcomeSchema>;
type OperationReasonCode = z.infer<typeof operationReasonCodeSchema>;
export type ActiveTaskStatus = z.infer<typeof activeTaskStatusSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
export type PreparedTagPlan = {
  readonly task_gid: string;
  readonly added_tag_gids: readonly string[];
  readonly added_taskhub_tags: readonly {
    readonly gid: string;
    readonly name: string;
  }[];
  readonly removed_tag_gids: readonly string[];
  readonly removed_taskhub_tag_gids: readonly string[];
};

/** 文字列を辞書順で比較します。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function operationKey(operation: AsanaNormalizationPlanOperationResult): string {
  switch (operation.operation) {
    case "move_section":
      return `${operation.task_gid}\u0000move_section`;
    case "set_completed":
      return `${operation.task_gid}\u0000set_completed`;
    case "initialize_external_data":
      return `${operation.task_gid}\u0000initialize_external_data`;
    case "update_last_active_status":
      return `${operation.task_gid}\u0000update_last_active_status`;
    case "update_activity_anchor_on":
      return `${operation.task_gid}\u0000update_activity_anchor_on`;
    case "add_tag":
      return `${operation.task_gid}\u0000add_tag\u0000${operation.tag_gid}`;
    case "remove_tag":
      return `${operation.task_gid}\u0000remove_tag\u0000${operation.tag_gid}`;
  }
}

/** 状態計画をタスクGID順に並べます。 */
export function sortedStatusPlans(
  plans: readonly SnapshotStatusPlan[],
): SnapshotStatusPlan[] {
  return [...plans].sort((left, right) =>
    compareStrings(left.task_gid, right.task_gid),
  );
}

/** タスクが指定セクションへ所属するか判定します。 */
export function hasSection(task: AsanaTaskResponse, sectionGid: string): boolean {
  return task.memberships.some(
    (membership) => membership.section?.gid === sectionGid,
  );
}

/** タスクが指定タグを持つか判定します。 */
export function hasTag(task: AsanaTaskResponse, tagGid: string): boolean {
  return task.tags.some((tag) => tag.gid === tagGid);
}

function isTaskHubTagName(name: string): boolean {
  return name.startsWith("TaskHub/");
}

function taskHubTags(task: AsanaTaskResponse): Map<string, string> {
  const tags = new Map<string, string>();
  for (const tag of task.tags) {
    if (!isTaskHubTagName(tag.name)) {
      continue;
    }
    if (tags.has(tag.gid)) {
      throw new Error("AsanaタスクのTaskHubタグGIDが重複しています。");
    }
    tags.set(tag.gid, tag.name);
  }
  return tags;
}

/** 計画対象を踏まえてTaskHubタグの基準状態を照合します。 */
export function sameTaskHubTagState(
  baseline: AsanaTaskResponse,
  current: AsanaTaskResponse,
  addedTags: readonly { readonly gid: string; readonly name: string }[],
  removedTagGids: readonly string[],
): boolean {
  const baselineTags = taskHubTags(baseline);
  const currentTags = taskHubTags(current);
  const addedByGid = new Map(
    addedTags.map((tag) => [tag.gid, tag.name]),
  );
  const removed = new Set(removedTagGids);

  for (const [gid, name] of baselineTags) {
    const currentName = currentTags.get(gid);
    if (addedByGid.has(gid)) {
      if (currentName == null || currentName !== name) {
        return false;
      }
      continue;
    }
    if (removed.has(gid)) {
      continue;
    }
    if (currentName == null || currentName !== name) {
      return false;
    }
  }

  for (const [gid, name] of currentTags) {
    if (baselineTags.has(gid)) {
      continue;
    }
    const addedName = addedByGid.get(gid);
    if (addedName == null || addedName !== name) {
      return false;
    }
  }

  for (const gid of removed) {
    if (!baselineTags.has(gid) && currentTags.has(gid)) {
      return false;
    }
  }
  return true;
}

/** 状態計画の基準値競合結果を作成します。 */
export function statusBaselineConflictResults(
  plan: Extract<SnapshotStatusPlan, { kind: "reconciled" }>,
): StatusOperationResult[] {
  return sortedStatusWrites(plan).map((write) => {
    switch (write.kind) {
      case "move_section":
        return {
          operation: "move_section",
          task_gid: plan.task_gid,
          section_gid: write.section_gid,
          outcome: "conflict",
          reason_code: "baseline_changed",
        };
      case "set_completed":
        return {
          operation: "set_completed",
          task_gid: plan.task_gid,
          completed: write.completed,
          outcome: "conflict",
          reason_code: "baseline_changed",
        };
    }
  });
}

/** タグ計画の基準値競合結果を作成します。 */
export function tagBaselineConflictResults(
  plan: PreparedTagPlan,
): TagOperationResult[] {
  return [
    ...plan.added_tag_gids.map((tagGid): TagOperationResult => ({
      operation: "add_tag",
      task_gid: plan.task_gid,
      tag_gid: tagGid,
      outcome: "conflict",
      reason_code: "baseline_changed",
    })),
    ...plan.removed_tag_gids.map((tagGid): TagOperationResult => ({
      operation: "remove_tag",
      task_gid: plan.task_gid,
      tag_gid: tagGid,
      outcome: "conflict",
      reason_code: "baseline_changed",
    })),
  ];
}

/** 計画対象のAsanaタスクを取得します。 */
export function requireTask(
  tasks: ReadonlyMap<string, AsanaTaskResponse>,
  taskGid: string,
): AsanaTaskResponse {
  const task = tasks.get(taskGid);
  if (task == null) {
    throw new Error("正規化計画の対象Asanaタスクを取得できません。");
  }
  return task;
}

/** 再取得したAsanaタスクと対象GIDを検証します。 */
export function parseFetchedTask(
  task: unknown,
  expectedGid: string,
): AsanaTaskResponse {
  const parsedTask = asanaTaskResponseSchema.parse(task);
  if (parsedTask.gid !== expectedGid) {
    throw new Error("取得したAsanaタスクGIDが計画対象と一致しません。");
  }
  return parsedTask;
}

type AsanaExternalDataResponse = NonNullable<AsanaTaskResponse["external"]>;

/** タスクの外部データ応答を取得します。 */
export function requireExternalDataResponse(
  task: AsanaTaskResponse,
): AsanaExternalDataResponse {
  if (task.external == null) {
    throw new Error("validな外部データのAsana応答に外部GIDがありません。");
  }
  return task.external;
}

/** 状態操作の読み戻し不一致を記録します。 */
export function markStatusConflict(
  operation: StatusOperationResult,
): StatusOperationResult {
  switch (operation.operation) {
    case "move_section":
      return {
        ...operation,
        outcome: "conflict",
        reason_code: "read_back_mismatch",
      };
    case "set_completed":
      return {
        ...operation,
        outcome: "conflict",
        reason_code: "read_back_mismatch",
      };
  }
}

/** タグ操作の読み戻し不一致を記録します。 */
export function markTagConflict(operation: TagOperationResult): TagOperationResult {
  switch (operation.operation) {
    case "add_tag":
      return {
        ...operation,
        outcome: "conflict",
        reason_code: "read_back_mismatch",
      };
    case "remove_tag":
      return {
        ...operation,
        outcome: "conflict",
        reason_code: "read_back_mismatch",
      };
  }
}

/** 外部データの取込状態から競合理由を決めます。 */
export function externalConflictReason(
  ingestion: Exclude<ExternalDataIngestionResult, { kind: "valid" }>,
): "external_unreadable" | "external_identity_mismatch" {
  if (ingestion.kind === "identity_mismatch") {
    return "external_identity_mismatch";
  }
  return "external_unreadable";
}

/** 初期化した外部データの読み戻し結果を照合します。 */
export function checkInitialExternalReadBack(
  task: AsanaTaskResponse,
  expected: CustomExternalDataInitializationResult,
): boolean {
  if (task.external == null) {
    return false;
  }
  if (task.external.gid !== expected.gid || task.external.data !== expected.data) {
    return false;
  }
  return ingestAsanaExternalData(task).kind === "valid";
}

/** 更新した外部データの読み戻し結果を照合します。 */
export function readBackExternalData(
  task: AsanaTaskResponse,
  expectedExternalGid: string,
  expectedExternalId: string,
): CustomExternalData | undefined {
  if (task.external == null || task.external.gid !== expectedExternalGid) {
    return undefined;
  }
  const ingestion = ingestAsanaExternalData(task);
  if (ingestion.kind !== "valid" || ingestion.data.id !== expectedExternalId) {
    return undefined;
  }
  return ingestion.data;
}

/** 外部データ更新の操作結果を作成します。 */
export function externalUpdateResults(
  taskGid: string,
  lastActiveStatus: ActiveTaskStatus | undefined,
  activityAnchorOn: string | undefined,
  outcome: OperationOutcome,
  reasonCode: OperationReasonCode,
): AsanaNormalizationPlanOperationResult[] {
  const results: AsanaNormalizationPlanOperationResult[] = [];
  if (lastActiveStatus != null) {
    results.push({
      operation: "update_last_active_status",
      task_gid: taskGid,
      value: lastActiveStatus,
      outcome,
      reason_code: reasonCode,
    });
  }
  if (activityAnchorOn != null) {
    results.push({
      operation: "update_activity_anchor_on",
      task_gid: taskGid,
      value: activityAnchorOn,
      outcome,
      reason_code: reasonCode,
    });
  }
  return results;
}

function resolveTagGid(
  name: string,
  workspaceTags: readonly AsanaTagResponse[],
): string {
  const matches = workspaceTags.filter((tag) => tag.name === name);
  if (matches.length !== 1) {
    throw new Error("計画のタグ名をワークスペースタグへ一意に解決できません。");
  }
  const match = matches[0];
  if (match == null) {
    throw new Error("計画のタグ名をワークスペースタグへ解決できません。");
  }
  return match.gid;
}

/** 状態計画の書き込み内容を検証します。 */
export function validateStatusPlan(plan: Extract<SnapshotStatusPlan, { kind: "reconciled" }>): void {
  const expectedCompleted =
    plan.status === "completed" || plan.status === "withdrawn";
  if (plan.completed !== expectedCompleted) {
    throw new Error("Asana状態計画の完了状態が状態名と一致しません。");
  }
  const seen = new Set<string>();
  for (const write of plan.writes) {
    if (seen.has(write.kind)) {
      throw new Error("同じAsana状態書込みを正規化計画へ重複指定できません。");
    }
    seen.add(write.kind);
    switch (write.kind) {
      case "move_section":
        if (write.section_gid !== plan.section_gid || write.status !== plan.status) {
          throw new Error("Asana状態移動計画の内容が計画本体と一致しません。");
        }
        break;
      case "set_completed":
        if (write.completed !== plan.completed) {
          throw new Error("Asana完了状態計画の内容が計画本体と一致しません。");
        }
        break;
    }
  }
}

/** 状態書き込みを適用順に並べます。 */
export function sortedStatusWrites(
  plan: Extract<SnapshotStatusPlan, { kind: "reconciled" }>,
): Extract<SnapshotStatusPlan, { kind: "reconciled" }>["writes"] {
  return [...plan.writes].sort((left, right) => {
    const leftOrder = left.kind === "move_section" ? 0 : 1;
    const rightOrder = right.kind === "move_section" ? 0 : 1;
    return leftOrder - rightOrder;
  });
}

function ensureNoTagTargetOverlap(
  addedTagGids: readonly string[],
  removedTagGids: readonly string[],
): void {
  const removed = new Set(removedTagGids);
  for (const tagGid of addedTagGids) {
    if (removed.has(tagGid)) {
      throw new Error("同じタグを追加と削除へ同時に指定できません。");
    }
  }
}

/** タグ計画の対象GIDと基準状態を準備します。 */
export function prepareTagPlans(
  result: SnapshotNormalizationResult,
  taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
  workspaceTags: readonly AsanaTagResponse[],
): PreparedTagPlan[] {
  const plans: PreparedTagPlan[] = [];
  const tagPlans = [...result.tag_plans].sort((left, right) =>
    compareStrings(left.task_gid, right.task_gid),
  );
  for (const plan of tagPlans) {
    const baselineTask = requireTask(taskByGid, plan.task_gid);
    const addedTags = plan.added_tag_names
      .map((name) => ({ gid: resolveTagGid(name, workspaceTags), name }))
      .sort((left, right) => compareStrings(left.gid, right.gid));
    const addedTagGids = addedTags.map((tag) => tag.gid);
    const removedTagGids = [...plan.removed_tag_gids].sort(compareStrings);
    ensureNoTagTargetOverlap(addedTagGids, removedTagGids);
    const addedTaskhubTags = addedTags.filter((tag) =>
      isTaskHubTagName(tag.name),
    );
    const baselineTaskhubTags = taskHubTags(baselineTask);
    const removedTaskhubTagGids = removedTagGids.filter((tagGid) =>
      baselineTaskhubTags.has(tagGid),
    );
    plans.push({
      task_gid: plan.task_gid,
      added_tag_gids: addedTagGids,
      added_taskhub_tags: addedTaskhubTags,
      removed_tag_gids: removedTagGids,
      removed_taskhub_tag_gids: removedTaskhubTagGids,
    });
  }
  return plans;
}

/** 正規化計画の対象と基準値を検証します。 */
export function validatePlanTargets(
  result: SnapshotNormalizationResult,
  taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
): void {
  for (const plan of result.status_plans) {
    if (plan.kind === "reconciled" && plan.writes.length > 0) {
      validateStatusPlan(plan);
      requireTask(taskByGid, plan.task_gid);
    }
  }
  for (const request of result.external_data_writes.initialization_requests) {
    requireTask(taskByGid, request.task_gid);
  }
  for (const update of result.external_data_writes.last_active_status_updates) {
    const task = requireTask(taskByGid, update.task_gid);
    const baselineExternal = ingestAsanaExternalData(task);
    if (baselineExternal.kind !== "valid") {
      throw new Error("last_active_status更新のbaseline外部データがvalidではありません。");
    }
  }
  for (const update of result.external_data_writes.activity_anchor_on_updates) {
    const task = requireTask(taskByGid, update.task_gid);
    const baselineExternal = ingestAsanaExternalData(task);
    if (baselineExternal.kind !== "valid") {
      throw new Error("activity_anchor_on更新のbaseline外部データがvalidではありません。");
    }
    if (update.update.value <= baselineExternal.data.activity_anchor_on) {
      throw new Error("activity_anchor_onを同日以前へ更新できません。");
    }
  }
  for (const plan of result.tag_plans) {
    requireTask(taskByGid, plan.task_gid);
  }
}
