import {
  canonicalizeJson,
  serializeCustomExternalData,
  type AsanaTaskResponse,
} from "../../../domain";
import { AsanaReadClient } from "../client/client";
import {
  AsanaTaskWriteClient,
  type AsanaTaskUpdate,
} from "../client/task-write-client";
import {
  createInitialCustomExternalData,
  ingestAsanaExternalData,
} from "../../../domain/external-data-ingestion";
import {
  mergeCustomExternalData,
  type CustomExternalDataMergeOperation,
} from "../../../domain/external-data-merge";
import {
  type SnapshotNormalizationResult,
  type SnapshotStatusPlan,
} from "../../../domain/snapshot-normalization";
import {
  applierInputSchema,
  checkInitialExternalReadBack,
  compareStrings,
  externalConflictReason,
  externalUpdateResults,
  hasSection,
  hasTag,
  markStatusConflict,
  markTagConflict,
  parseFetchedTask,
  prepareTagPlans,
  readBackExternalData,
  requireExternalDataResponse,
  requireTask,
  resultSchema,
  sameTaskHubTagState,
  sortedStatusPlans,
  sortedStatusWrites,
  statusBaselineConflictResults,
  tagBaselineConflictResults,
  validatePlanTargets,
  validateStatusPlan,
  type ActiveTaskStatus,
  type AsanaNormalizationPlanApplierInput,
  type AsanaNormalizationPlanApplierResult,
  type AsanaNormalizationPlanOperationResult,
  type PreparedTagPlan,
  type StatusOperationResult,
  type TagOperationResult,
  type UuidGenerator,
} from "../normalization-plan";

export {
  asanaNormalizationPlanApplierInputSchema,
  asanaNormalizationPlanApplierResultSchema,
  type AsanaNormalizationPlanApplierInput,
  type AsanaNormalizationPlanApplierResult,
  type UuidGenerator,
} from "../normalization-plan";

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
    const activityAnchorOnByGid = new Map(
      result.external_data_writes.activity_anchor_on_updates.map((update) => [
        update.task_gid,
        update,
      ]),
    );
    const externalTaskGids = [
      ...new Set([
        ...initializationByGid.keys(),
        ...lastActiveByGid.keys(),
        ...activityAnchorOnByGid.keys(),
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
      const activityAnchorOn = activityAnchorOnByGid.get(taskGid);
      if (lastActive == null && activityAnchorOn == null) {
        throw new Error("外部データ書込みの対象を取得できません。");
      }
      await this.applyExternalDataUpdate(
        taskGid,
        lastActive?.update.value,
        activityAnchorOn?.update.value,
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

  private async applyExternalDataUpdate(
    taskGid: string,
    lastActiveStatus: ActiveTaskStatus | undefined,
    activityAnchorOn: string | undefined,
    taskByGid: ReadonlyMap<string, AsanaTaskResponse>,
    deviceId: string,
    operations: AsanaNormalizationPlanOperationResult[],
    signal: AbortSignal,
  ): Promise<void> {
    if (lastActiveStatus == null && activityAnchorOn == null) {
      throw new Error("外部データ更新内容がありません。");
    }
    const baselineTask = requireTask(taskByGid, taskGid);
    const baselineExternal = ingestAsanaExternalData(baselineTask);
    if (baselineExternal.kind !== "valid") {
      throw new Error("外部データ更新のbaseline外部データがvalidではありません。");
    }
    const baselineExternalResponse = requireExternalDataResponse(baselineTask);
    const currentTask = parseFetchedTask(
      await this.readClient.getTask(taskGid, signal),
      taskGid,
    );
    const currentExternal = ingestAsanaExternalData(currentTask);
    if (currentExternal.kind !== "valid") {
      operations.push(...externalUpdateResults(
        taskGid,
        lastActiveStatus,
        activityAnchorOn,
        "conflict",
        externalConflictReason(currentExternal),
      ));
      return;
    }
    const currentExternalResponse = requireExternalDataResponse(currentTask);
    if (
      baselineExternal.data.id !== currentExternal.data.id ||
      baselineExternalResponse.gid !== currentExternalResponse.gid
    ) {
      operations.push(...externalUpdateResults(
        taskGid,
        lastActiveStatus,
        activityAnchorOn,
        "conflict",
        "external_identity_mismatch",
      ));
      return;
    }

    let mergeBaseline = baselineExternal.data;
    const mergeOperations: CustomExternalDataMergeOperation[] = [];
    let pendingLastActiveStatus: ActiveTaskStatus | undefined;
    let pendingActivityAnchorOn: string | undefined;
    if (lastActiveStatus != null) {
      if (currentExternal.data.last_active_status === lastActiveStatus) {
        operations.push(...externalUpdateResults(
          taskGid,
          lastActiveStatus,
          undefined,
          "already_applied",
          "already_applied",
        ));
      } else {
        pendingLastActiveStatus = lastActiveStatus;
        mergeOperations.push({
          operation: "set_last_active_status",
          before: baselineExternal.data.last_active_status,
          after: lastActiveStatus,
        });
      }
    }
    if (activityAnchorOn != null) {
      if (currentExternal.data.activity_anchor_on >= activityAnchorOn) {
        operations.push(...externalUpdateResults(
          taskGid,
          undefined,
          activityAnchorOn,
          "already_applied",
          "already_applied",
        ));
      } else {
        pendingActivityAnchorOn = activityAnchorOn;
        mergeBaseline = {
          ...mergeBaseline,
          activity_anchor_on: currentExternal.data.activity_anchor_on,
        };
        mergeOperations.push({
          operation: "set_activity_anchor_on",
          before: currentExternal.data.activity_anchor_on,
          after: activityAnchorOn,
        });
      }
    }
    if (mergeOperations.length === 0) {
      return;
    }
    const merged = mergeCustomExternalData({
      baseline: mergeBaseline,
      current: currentExternal.data,
      operations: mergeOperations,
      last_writer: deviceId,
    });
    switch (merged.kind) {
      case "conflict":
        operations.push(...externalUpdateResults(
          taskGid,
          pendingLastActiveStatus,
          pendingActivityAnchorOn,
          "conflict",
          "merge_conflict",
        ));
        return;
      case "already_applied":
        operations.push(...externalUpdateResults(
          taskGid,
          pendingLastActiveStatus,
          pendingActivityAnchorOn,
          "already_applied",
          "already_applied",
        ));
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
    const readBackExternal = readBackExternalData(
      readBack,
      currentExternalResponse.gid,
      currentExternal.data.id,
    );
    if (pendingLastActiveStatus != null) {
      const matches = readBackExternal?.last_active_status === pendingLastActiveStatus;
      operations.push(...externalUpdateResults(
        taskGid,
        pendingLastActiveStatus,
        undefined,
        matches ? "applied" : "conflict",
        matches ? "applied" : "read_back_mismatch",
      ));
    }
    if (pendingActivityAnchorOn != null) {
      const matches =
        readBackExternal != null &&
        readBackExternal.activity_anchor_on >= pendingActivityAnchorOn;
      operations.push(...externalUpdateResults(
        taskGid,
        undefined,
        pendingActivityAnchorOn,
        matches ? "applied" : "conflict",
        matches ? "applied" : "read_back_mismatch",
      ));
    }
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
