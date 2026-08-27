import { z } from "zod";
import {
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  gidSchema,
  identifierSchema,
  serializeCustomExternalData,
  type AsanaTaskResponse,
} from "../../../shared/domain";
import { AsanaReadClient } from "../client/client";
import {
  AsanaTaskWriteClient,
  type AsanaTaskUpdate,
} from "../client/task-write-client";
import {
  createInitialCustomExternalData,
  ingestAsanaExternalData,
  type CustomExternalDataInitializationResult,
  type ExternalDataIngestionResult,
} from "../../domain/external-data-ingestion";
import { mergeCustomExternalData } from "../../domain/external-data-merge";
import {
  asanaSnapshotNormalizationResultSchema,
  type SnapshotNormalizationResult,
  type SnapshotStatusPlan,
} from "../../domain/snapshot-normalization";

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

const applierInputSchema = z
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

const resultSchema = z
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

type StatusOperationResult =
  | z.infer<typeof moveSectionResultSchema>
  | z.infer<typeof setCompletedResultSchema>;
type AsanaNormalizationPlanOperationResult = z.infer<
  typeof operationResultSchema
>;
type TagOperationResult =
  | z.infer<typeof addTagResultSchema>
  | z.infer<typeof removeTagResultSchema>;
type AsanaTagResponse = z.infer<typeof asanaTagResponseSchema>;
type PreparedTagPlan = {
  readonly task_gid: string;
  readonly added_tag_gids: readonly string[];
  readonly added_taskhub_tags: readonly {
    readonly gid: string;
    readonly name: string;
  }[];
  readonly removed_tag_gids: readonly string[];
  readonly removed_taskhub_tag_gids: readonly string[];
};

function compareStrings(left: string, right: string): number {
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
    case "add_tag":
      return `${operation.task_gid}\u0000add_tag\u0000${operation.tag_gid}`;
    case "remove_tag":
      return `${operation.task_gid}\u0000remove_tag\u0000${operation.tag_gid}`;
  }
}

function sortedStatusPlans(
  plans: readonly SnapshotStatusPlan[],
): SnapshotStatusPlan[] {
  return [...plans].sort((left, right) =>
    compareStrings(left.task_gid, right.task_gid),
  );
}

function hasSection(task: AsanaTaskResponse, sectionGid: string): boolean {
  return task.memberships.some(
    (membership) => membership.section?.gid === sectionGid,
  );
}

function hasTag(task: AsanaTaskResponse, tagGid: string): boolean {
  return task.tags.some((tag) => tag.gid === tagGid);
}

function isTaskHubTagName(name: string): boolean {
  return name.startsWith("TaskHub/");
}

function membershipKeys(task: AsanaTaskResponse): string[] {
  return task.memberships
    .map((membership) =>
      canonicalizeJson({
        project_gid: membership.project.gid,
        section_gid: membership.section == null ? null : membership.section.gid,
      }),
    )
    .sort(compareStrings);
}

function sameSortedStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function sameMemberships(
  left: AsanaTaskResponse,
  right: AsanaTaskResponse,
): boolean {
  return sameSortedStrings(membershipKeys(left), membershipKeys(right));
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

function sameTaskHubTagState(
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

function statusBaselineConflictResults(
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

function tagBaselineConflictResults(
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

function requireTask(
  tasks: ReadonlyMap<string, AsanaTaskResponse>,
  taskGid: string,
): AsanaTaskResponse {
  const task = tasks.get(taskGid);
  if (task == null) {
    throw new Error("正規化計画の対象Asanaタスクを取得できません。");
  }
  return task;
}

function parseFetchedTask(
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

function requireExternalDataResponse(
  task: AsanaTaskResponse,
): AsanaExternalDataResponse {
  if (task.external == null) {
    throw new Error("validな外部データのAsana応答に外部GIDがありません。");
  }
  return task.external;
}

function markStatusConflict(
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

function markTagConflict(operation: TagOperationResult): TagOperationResult {
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

function externalConflictReason(
  ingestion: Exclude<ExternalDataIngestionResult, { kind: "valid" }>,
): "external_unreadable" | "external_identity_mismatch" {
  if (ingestion.kind === "identity_mismatch") {
    return "external_identity_mismatch";
  }
  return "external_unreadable";
}

function checkInitialExternalReadBack(
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

function checkLastActiveReadBack(
  task: AsanaTaskResponse,
  expectedExternalGid: string,
  expectedValue: "not_started" | "in_progress",
): boolean {
  if (task.external == null || task.external.gid !== expectedExternalGid) {
    return false;
  }
  const ingestion = ingestAsanaExternalData(task);
  return ingestion.kind === "valid" &&
    ingestion.data.last_active_status === expectedValue;
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

function validateStatusPlan(plan: Extract<SnapshotStatusPlan, { kind: "reconciled" }>): void {
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

type StatusPreflightResult =
  | { readonly kind: "safe"; readonly task: AsanaTaskResponse }
  | { readonly kind: "conflict" };

function preflightStatusPlan(
  baseline: AsanaTaskResponse,
  current: AsanaTaskResponse,
  plan: Extract<SnapshotStatusPlan, { kind: "reconciled" }>,
): StatusPreflightResult {
  const sectionAllowed =
    sameMemberships(baseline, current) || hasSection(current, plan.section_gid);
  const completedAllowed =
    current.completed === baseline.completed || current.completed === plan.completed;
  if (!sectionAllowed || !completedAllowed) {
    return { kind: "conflict" };
  }
  return { kind: "safe", task: current };
}

function sortedStatusWrites(
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

function prepareTagPlans(
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

function validatePlanTargets(
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
  for (const plan of result.tag_plans) {
    requireTask(taskByGid, plan.task_gid);
  }
}

/** Asana正規化計画を安全な順序で適用します。 */
export class AsanaNormalizationPlanApplier {
  private readonly readClient: AsanaReadClient;
  private readonly writeClient: AsanaTaskWriteClient;
  private readonly uuidGenerator: UuidGenerator;

  public constructor(
    readClient: AsanaReadClient,
    writeClient: AsanaTaskWriteClient,
    uuidGenerator: UuidGenerator,
  ) {
    this.readClient = readClient;
    this.writeClient = writeClient;
    this.uuidGenerator = uuidGenerator;
  }

  /** 正規化結果の状態・外部データ・タグ計画だけを適用します。 */
  public async apply(
    input: AsanaNormalizationPlanApplierInput,
    signal: AbortSignal,
  ): Promise<AsanaNormalizationPlanApplierResult> {
    const validatedInput = applierInputSchema.parse(input);
    const taskByGid = new Map(
      validatedInput.asana_tasks.map((task) => [task.gid, task]),
    );
    validatePlanTargets(validatedInput.normalization_result, taskByGid);
    const preparedTagPlans = prepareTagPlans(
      validatedInput.normalization_result,
      taskByGid,
      validatedInput.workspace_tags,
    );
    const operations: AsanaNormalizationPlanOperationResult[] = [];

    await this.applyStatusWrites(
      validatedInput.normalization_result,
      taskByGid,
      operations,
      signal,
    );
    await this.applyExternalDataWrites(
      validatedInput.normalization_result,
      taskByGid,
      validatedInput.device_id,
      operations,
      signal,
    );
    await this.applyTagWrites(
      taskByGid,
      preparedTagPlans,
      operations,
      signal,
    );

    const affectedGids = [...new Set(operations.map((operation) => operation.task_gid))]
      .sort(compareStrings);
    return resultSchema.parse({
      affected_gids: affectedGids,
      operations,
    });
  }

  private async applyStatusWrites(
    result: SnapshotNormalizationResult,
    taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
    operations: AsanaNormalizationPlanOperationResult[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const plan of sortedStatusPlans(result.status_plans)) {
      if (plan.kind !== "reconciled" || plan.writes.length === 0) {
        continue;
      }
      validateStatusPlan(plan);
      const baselineTask = requireTask(taskByGid, plan.task_gid);
      const preflightTask = parseFetchedTask(
        await this.readClient.getTask(plan.task_gid, signal),
        plan.task_gid,
      );
      const preflight = preflightStatusPlan(
        baselineTask,
        preflightTask,
        plan,
      );
      if (preflight.kind === "conflict") {
        operations.push(...statusBaselineConflictResults(plan));
        continue;
      }
      const task = preflight.task;
      const statusOperations: StatusOperationResult[] = [];
      for (const write of sortedStatusWrites(plan)) {
        switch (write.kind) {
          case "move_section": {
            if (hasSection(task, write.section_gid)) {
              statusOperations.push({
                operation: "move_section",
                task_gid: plan.task_gid,
                section_gid: write.section_gid,
                outcome: "already_applied",
                reason_code: "already_applied",
              });
            } else {
              await this.writeClient.addTaskToSection(
                plan.task_gid,
                write.section_gid,
                { kind: "none" },
                signal,
              );
              statusOperations.push({
                operation: "move_section",
                task_gid: plan.task_gid,
                section_gid: write.section_gid,
                outcome: "applied",
                reason_code: "applied",
              });
            }
            break;
          }
          case "set_completed": {
            if (task.completed === write.completed) {
              statusOperations.push({
                operation: "set_completed",
                task_gid: plan.task_gid,
                completed: write.completed,
                outcome: "already_applied",
                reason_code: "already_applied",
              });
            } else {
              const update: AsanaTaskUpdate = {
                kind: "completed",
                value: write.completed,
              };
              await this.writeClient.updateTask(
                plan.task_gid,
                update,
                signal,
              );
              statusOperations.push({
                operation: "set_completed",
                task_gid: plan.task_gid,
                completed: write.completed,
                outcome: "applied",
                reason_code: "applied",
              });
            }
            break;
          }
        }
      }
      const readBack = parseFetchedTask(
        await this.readClient.getTask(plan.task_gid, signal),
        plan.task_gid,
      );
      const readBackMatches =
        hasSection(readBack, plan.section_gid) &&
        readBack.completed === plan.completed;
      operations.push(
        ...(readBackMatches
          ? statusOperations
          : statusOperations.map((operation) => markStatusConflict(operation))),
      );
    }
  }

  private async applyExternalDataWrites(
    result: SnapshotNormalizationResult,
    taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
    deviceId: string,
    operations: AsanaNormalizationPlanOperationResult[],
    signal: AbortSignal,
  ): Promise<void> {
    const initializationByGid = new Map(
      result.external_data_writes.initialization_requests.map((request) => [
        request.task_gid,
        request,
      ]),
    );
    const lastActiveByGid = new Map(
      result.external_data_writes.last_active_status_updates.map((update) => [
        update.task_gid,
        update,
      ]),
    );
    const externalTaskGids = [
      ...new Set([
        ...initializationByGid.keys(),
        ...lastActiveByGid.keys(),
      ]),
    ].sort(compareStrings);
    for (const taskGid of externalTaskGids) {
      const initialization = initializationByGid.get(taskGid);
      if (initialization != null) {
        await this.applyInitializationRequest(
          initialization,
          taskByGid,
          deviceId,
          operations,
          signal,
        );
        continue;
      }
      const lastActive = lastActiveByGid.get(taskGid);
      if (lastActive == null) {
        throw new Error("外部データ書込みの対象を取得できません。");
      }
      await this.applyLastActiveStatusUpdate(
        lastActive.task_gid,
        lastActive.update.value,
        taskByGid,
        deviceId,
        operations,
        signal,
      );
    }
  }

  private async applyInitializationRequest(
    request: SnapshotNormalizationResult["external_data_writes"]["initialization_requests"][number],
    taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
    deviceId: string,
    operations: AsanaNormalizationPlanOperationResult[],
    signal: AbortSignal,
  ): Promise<void> {
    requireTask(taskByGid, request.task_gid);
    const currentTask = parseFetchedTask(
      await this.readClient.getTask(request.task_gid, signal),
      request.task_gid,
    );
    const currentExternal = ingestAsanaExternalData(currentTask);
    switch (currentExternal.kind) {
      case "valid":
        operations.push({
          operation: "initialize_external_data",
          task_gid: request.task_gid,
          outcome: "already_applied",
          reason_code: "already_initialized",
        });
        return;
      case "broken":
      case "unknown_version":
      case "identity_mismatch":
        operations.push({
          operation: "initialize_external_data",
          task_gid: request.task_gid,
          outcome: "conflict",
          reason_code: externalConflictReason(currentExternal),
        });
        return;
      case "missing":
        break;
    }

    const generated = createInitialCustomExternalData({
      id: this.uuidGenerator(),
      activity_anchor_on: request.activity_anchor_on,
      last_active_status: request.last_active_status,
      device_id: deviceId,
      created_via: request.created_via,
    });
    await this.writeClient.updateTask(
      request.task_gid,
      { kind: "external", value: generated },
      signal,
    );
    const readBack = parseFetchedTask(
      await this.readClient.getTask(request.task_gid, signal),
      request.task_gid,
    );
    const readBackMatches = checkInitialExternalReadBack(readBack, generated);
    operations.push({
      operation: "initialize_external_data",
      task_gid: request.task_gid,
      outcome: readBackMatches ? "applied" : "conflict",
      reason_code: readBackMatches ? "applied" : "read_back_mismatch",
    });
  }

  private async applyLastActiveStatusUpdate(
    taskGid: string,
    value: "not_started" | "in_progress",
    taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
    deviceId: string,
    operations: AsanaNormalizationPlanOperationResult[],
    signal: AbortSignal,
  ): Promise<void> {
    const baselineTask = requireTask(taskByGid, taskGid);
    const baselineExternal = ingestAsanaExternalData(baselineTask);
    if (baselineExternal.kind !== "valid") {
      throw new Error("last_active_status更新のbaseline外部データがvalidではありません。");
    }
    const baselineExternalResponse = requireExternalDataResponse(baselineTask);
    const currentTask = parseFetchedTask(
      await this.readClient.getTask(taskGid, signal),
      taskGid,
    );
    const currentExternal = ingestAsanaExternalData(currentTask);
    if (currentExternal.kind !== "valid") {
      operations.push({
        operation: "update_last_active_status",
        task_gid: taskGid,
        value,
        outcome: "conflict",
        reason_code: externalConflictReason(currentExternal),
      });
      return;
    }
    const currentExternalResponse = requireExternalDataResponse(currentTask);
    if (
      baselineExternal.data.id !== currentExternal.data.id ||
      baselineExternalResponse.gid !== currentExternalResponse.gid
    ) {
      operations.push({
        operation: "update_last_active_status",
        task_gid: taskGid,
        value,
        outcome: "conflict",
        reason_code: "external_identity_mismatch",
      });
      return;
    }
    const merged = mergeCustomExternalData({
      baseline: baselineExternal.data,
      current: currentExternal.data,
      operations: [
        {
          operation: "set_last_active_status",
          before: baselineExternal.data.last_active_status,
          after: value,
        },
      ],
      last_writer: deviceId,
    });
    switch (merged.kind) {
      case "conflict":
        operations.push({
          operation: "update_last_active_status",
          task_gid: taskGid,
          value,
          outcome: "conflict",
          reason_code: "merge_conflict",
        });
        return;
      case "already_applied":
        operations.push({
          operation: "update_last_active_status",
          task_gid: taskGid,
          value,
          outcome: "already_applied",
          reason_code: "already_applied",
        });
        return;
      case "merged":
        break;
    }
    const serialized = serializeCustomExternalData(merged.data);
    await this.writeClient.updateTask(
      taskGid,
      {
        kind: "external",
        value: {
          gid: currentExternalResponse.gid,
          data: serialized,
        },
      },
      signal,
    );
    const readBack = parseFetchedTask(
      await this.readClient.getTask(taskGid, signal),
      taskGid,
    );
    const readBackMatches = checkLastActiveReadBack(
      readBack,
      currentExternalResponse.gid,
      value,
    );
    operations.push({
      operation: "update_last_active_status",
      task_gid: taskGid,
      value,
      outcome: readBackMatches ? "applied" : "conflict",
      reason_code: readBackMatches ? "applied" : "read_back_mismatch",
    });
  }

  private async applyTagWrites(
    taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
    tagPlans: readonly PreparedTagPlan[],
    operations: AsanaNormalizationPlanOperationResult[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const plan of tagPlans) {
      const baselineTask = requireTask(taskByGid, plan.task_gid);
      if (plan.added_tag_gids.length === 0 && plan.removed_tag_gids.length === 0) {
        continue;
      }
      const preflightTask = parseFetchedTask(
        await this.readClient.getTask(plan.task_gid, signal),
        plan.task_gid,
      );
      if (!sameTaskHubTagState(
        baselineTask,
        preflightTask,
        plan.added_taskhub_tags,
        plan.removed_taskhub_tag_gids,
      )) {
        operations.push(...tagBaselineConflictResults(plan));
        continue;
      }
      const task = preflightTask;
      const tagOperations: TagOperationResult[] = [];
      for (const tagGid of plan.added_tag_gids) {
        if (hasTag(task, tagGid)) {
          tagOperations.push({
            operation: "add_tag",
            task_gid: plan.task_gid,
            tag_gid: tagGid,
            outcome: "already_applied",
            reason_code: "already_applied",
          });
        } else {
          await this.writeClient.addTaskTag(plan.task_gid, tagGid, signal);
          tagOperations.push({
            operation: "add_tag",
            task_gid: plan.task_gid,
            tag_gid: tagGid,
            outcome: "applied",
            reason_code: "applied",
          });
        }
      }
      for (const tagGid of plan.removed_tag_gids) {
        if (!hasTag(task, tagGid)) {
          tagOperations.push({
            operation: "remove_tag",
            task_gid: plan.task_gid,
            tag_gid: tagGid,
            outcome: "already_applied",
            reason_code: "already_applied",
          });
        } else {
          await this.writeClient.removeTaskTag(plan.task_gid, tagGid, signal);
          tagOperations.push({
            operation: "remove_tag",
            task_gid: plan.task_gid,
            tag_gid: tagGid,
            outcome: "applied",
            reason_code: "applied",
          });
        }
      }
      if (tagOperations.length === 0) {
        continue;
      }
      const readBack = parseFetchedTask(
        await this.readClient.getTask(plan.task_gid, signal),
        plan.task_gid,
      );
      const readBackOperations = tagOperations.map((operation) => {
        const matches = operation.operation === "add_tag"
          ? hasTag(readBack, operation.tag_gid)
          : !hasTag(readBack, operation.tag_gid);
        return matches ? operation : markTagConflict(operation);
      });
      operations.push(...readBackOperations);
    }
  }
}
