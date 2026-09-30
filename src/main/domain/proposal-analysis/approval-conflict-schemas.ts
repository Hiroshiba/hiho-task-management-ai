import { z } from "zod";

/** 承認競合の入力と結果のスキーマを組み立てます。 */
export function createApprovalConflictSchemas<
  TProposal extends z.ZodType,
  TTask extends z.ZodType<{ gid: string }>,
  TGraphResult extends z.ZodType,
>(dependencies: {
  readonly gidSchema: z.ZodType<string>;
  readonly identifierSchema: z.ZodType<string>;
  readonly taskSchema: TTask;
  readonly proposalSchema: TProposal;
  readonly graphValidationResultSchema: TGraphResult;
}) {
  const {
    gidSchema,
    identifierSchema,
    taskSchema,
    proposalSchema,
    graphValidationResultSchema,
  } = dependencies;

  type ConflictReasonCode = z.infer<typeof conflictReasonCodeSchema>;

  const maximumManagedTasks = 10000;
  const maximumSelectedOperations = 256;
  const maximumJournalMappings = 256;

  const conflictReasonCodeSchema = z.enum([
    "current_task_missing",
    "field_changed",
    "external_data_unwritable",
    "temporary_target_unresolved",
  ]);

  const normalizedTaskArraySchema = z
    .array(taskSchema)
    .max(maximumManagedTasks)
    .superRefine((tasks, context) => {
      const seen = new Set<string>();
      tasks.forEach((task, index) => {
        if (seen.has(task.gid)) {
          context.addIssue({
            code: "custom",
            path: [index, "gid"],
            message: "正規化済みタスクGIDを重複して指定できません。",
          });
        }
        seen.add(task.gid);
      });
    });

  const selectedOperationIdsSchema = z
    .array(identifierSchema)
    .min(1)
    .max(maximumSelectedOperations)
    .superRefine((operationIds, context) => {
      const seen = new Set<string>();
      operationIds.forEach((operationId, index) => {
        if (seen.has(operationId)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じoperation_idを重複して選択できません。",
          });
        }
        seen.add(operationId);
      });
    });

  const writableExternalDataTaskGidsSchema = z
    .array(gidSchema)
    .max(maximumManagedTasks)
    .superRefine((gids, context) => {
      const seen = new Set<string>();
      gids.forEach((gid, index) => {
        if (seen.has(gid)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "外部データ書き込み可能タスクGIDを重複して指定できません。",
          });
        }
        seen.add(gid);
      });
    });

  const journalTaskMappingSchema = z
    .object({
      temporary_ref: identifierSchema,
      task_gid: gidSchema,
    })
    .strict();

  const journalTaskMappingsSchema = z
    .array(journalTaskMappingSchema)
    .max(maximumJournalMappings)
    .superRefine((mappings, context) => {
      const temporaryRefs = new Set<string>();
      const taskGids = new Set<string>();
      mappings.forEach((mapping, index) => {
        if (temporaryRefs.has(mapping.temporary_ref)) {
          context.addIssue({
            code: "custom",
            path: [index, "temporary_ref"],
            message: "同じtemporary_refをjournal mappingへ重複して指定できません。",
          });
        }
        if (taskGids.has(mapping.task_gid)) {
          context.addIssue({
            code: "custom",
            path: [index, "task_gid"],
            message: "同じタスクGIDをjournal mappingへ重複して指定できません。",
          });
        }
        temporaryRefs.add(mapping.temporary_ref);
        taskGids.add(mapping.task_gid);
      });
    });

  const approvalInputSchema = z
    .object({
      proposal: proposalSchema,
      baseline_tasks: normalizedTaskArraySchema,
      current_tasks: normalizedTaskArraySchema,
      graph_validation_result: graphValidationResultSchema,
      selected_operation_ids: selectedOperationIdsSchema,
      writable_external_data_task_gids: writableExternalDataTaskGidsSchema,
      journal_task_mappings: journalTaskMappingsSchema,
    })
    .strict();

  const affectedTaskGidsSchema = z
    .array(gidSchema)
    .max(maximumManagedTasks)
    .superRefine((gids, context) => {
      const seen = new Set<string>();
      let previous: string | undefined;
      gids.forEach((gid, index) => {
        if (seen.has(gid)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "影響タスクGIDを重複して指定できません。",
          });
        }
        if (previous != null && previous >= gid) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "影響タスクGIDはGID順に指定してください。",
          });
        }
        seen.add(gid);
        previous = gid;
      });
    });

  const applicableOperationResultSchema = z
    .object({
      kind: z.literal("applicable"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
      affected_task_gids: affectedTaskGidsSchema,
    })
    .strict();

  const alreadyAppliedOperationResultSchema = z
    .object({
      kind: z.literal("already_applied"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
      affected_task_gids: affectedTaskGidsSchema,
    })
    .strict();

  const conflictOperationResultSchema = z
    .object({
      kind: z.literal("conflict"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
      reason_codes: z
        .array(conflictReasonCodeSchema)
        .min(1)
        .superRefine((codes, context) => {
          const seen = new Set<ConflictReasonCode>();
          codes.forEach((code, index) => {
            if (seen.has(code)) {
              context.addIssue({
                code: "custom",
                path: [index],
                message: "同じ競合理由コードを重複して指定できません。",
              });
            }
            seen.add(code);
          });
        }),
      affected_task_gids: affectedTaskGidsSchema,
    })
    .strict();

  const operationResultSchema = z.discriminatedUnion("kind", [
    applicableOperationResultSchema,
    alreadyAppliedOperationResultSchema,
    conflictOperationResultSchema,
  ]);

  const groupResultSchema = z
    .object({
      group_id: identifierSchema,
      atomic: z.boolean(),
      applicable: z.boolean(),
      operation_ids: z.array(identifierSchema).min(1),
    })
    .strict();

  const approvalResultSchema = z
    .object({
      operations: z.array(operationResultSchema).min(1),
      groups: z.array(groupResultSchema).min(1),
    })
    .strict()
    .superRefine((result, context) => {
      const operationGroups = new Map<string, string>();
      const groupIds = new Set<string>();
      for (const [index, group] of result.groups.entries()) {
        if (groupIds.has(group.group_id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", index, "group_id"],
            message: "同じgroup_idを重複して指定できません。",
          });
        }
        groupIds.add(group.group_id);
        const groupOperationIds = new Set<string>();
        let hasApplicableOperation = false;
        let hasConflict = false;
        for (const [operationIndex, operationId] of group.operation_ids.entries()) {
          if (groupOperationIds.has(operationId)) {
            context.addIssue({
              code: "custom",
              path: ["groups", index, "operation_ids", operationIndex],
              message: "同じoperation_idをグループへ重複して指定できません。",
            });
          }
          groupOperationIds.add(operationId);
          if (operationGroups.has(operationId)) {
            context.addIssue({
              code: "custom",
              path: ["groups", index, "operation_ids", operationIndex],
              message: "operation_idを複数のグループへ指定できません。",
            });
          }
          operationGroups.set(operationId, group.group_id);
          const operation = result.operations.find(
            (candidate) => candidate.operation_id === operationId,
          );
          if (operation == null) {
            context.addIssue({
              code: "custom",
              path: ["groups", index, "operation_ids", operationIndex],
              message: "グループのoperation_idに対応する結果がありません。",
            });
            continue;
          }
          if (operation.group_id !== group.group_id) {
            context.addIssue({
              code: "custom",
              path: ["groups", index, "operation_ids", operationIndex],
              message: "操作結果のgroup_idがグループと一致しません。",
            });
          }
          if (operation.kind === "conflict") {
            hasConflict = true;
          } else {
            hasApplicableOperation = true;
          }
        }
        const expectedApplicable = group.atomic
          ? hasApplicableOperation && !hasConflict
          : hasApplicableOperation;
        if (group.applicable !== expectedApplicable) {
          context.addIssue({
            code: "custom",
            path: ["groups", index, "applicable"],
            message: "グループのapplicableが操作結果と一致しません。",
          });
        }
      }

      const operationIds = new Set<string>();
      result.operations.forEach((operation, index) => {
        if (operationIds.has(operation.operation_id)) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "operation_id"],
            message: "同じoperation_idを重複して指定できません。",
          });
        }
        operationIds.add(operation.operation_id);
        const groupId = operationGroups.get(operation.operation_id);
        if (groupId == null) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "operation_id"],
            message: "操作結果がグループへ所属していません。",
          });
        } else if (groupId !== operation.group_id) {
          context.addIssue({
            code: "custom",
            path: ["operations", index, "group_id"],
            message: "操作結果のgroup_idが対応グループと一致しません。",
          });
        }
      });
    });

  return {
    approvalInputSchema,
    approvalResultSchema,
    conflictReasonCodeSchema,
    journalTaskMappingSchema,
  };
}
