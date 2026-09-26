import { z } from "zod";

/** グラフ検証の入力と結果のスキーマを組み立てます。 */
export function createGraphValidationSchemas<
  TProposal extends z.ZodType,
  TTask extends z.ZodType<{ gid: string }>,
  TBasicResult extends z.ZodType,
>(dependencies: {
  readonly gidSchema: z.ZodType<string>;
  readonly identifierSchema: z.ZodType<string>;
  readonly proposalSchema: TProposal;
  readonly proposalValidationResultSchema: TBasicResult;
  readonly taskSchema: TTask;
}) {
  const {
    gidSchema,
    identifierSchema,
    proposalSchema,
    proposalValidationResultSchema,
    taskSchema,
  } = dependencies;

  function compareStrings(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  }

  const maximumManagedTasks = 10000;
  const maximumCycleNodes = 10000;
  const maximumCycles = 10000;
  const maximumSelectedOperations = 256;
  const maximumTemporaryRefMappings = 256;

  const nonBlankTextSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "空白だけでない文字列を指定してください。",
  });

  const managedTasksSchema = z
    .array(taskSchema)
    .max(maximumManagedTasks)
    .superRefine((tasks, context) => {
      const seen = new Set<string>();
      tasks.forEach((task, index) => {
        if (seen.has(task.gid)) {
          context.addIssue({
            code: "custom",
            path: [index, "gid"],
            message: `管理対象タスクGID ${task.gid} が重複しています。`,
          });
          return;
        }
        seen.add(task.gid);
      });
    });

  const selectedOperationIdsSchema = z
    .array(identifierSchema)
    .max(maximumSelectedOperations)
    .superRefine((operationIds, context) => {
      const seen = new Set<string>();
      operationIds.forEach((operationId, index) => {
        if (seen.has(operationId)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `operation_id ${operationId} を重複指定できません。`,
          });
        }
        seen.add(operationId);
      });
    });

  const temporaryRefMappingSchema = z
    .object({
      temporary_ref: identifierSchema,
      task_gid: gidSchema,
    })
    .strict();

  const temporaryRefMappingsSchema = z
    .array(temporaryRefMappingSchema)
    .max(maximumTemporaryRefMappings)
    .superRefine((mappings, context) => {
      const temporaryRefs = new Set<string>();
      const taskGids = new Set<string>();
      mappings.forEach((mapping, index) => {
        if (temporaryRefs.has(mapping.temporary_ref)) {
          context.addIssue({
            code: "custom",
            path: [index, "temporary_ref"],
            message: `temporary_ref ${mapping.temporary_ref} を重複指定できません。`,
          });
        }
        if (taskGids.has(mapping.task_gid)) {
          context.addIssue({
            code: "custom",
            path: [index, "task_gid"],
            message: `対応先タスクGID ${mapping.task_gid} を重複指定できません。`,
          });
        }
        temporaryRefs.add(mapping.temporary_ref);
        taskGids.add(mapping.task_gid);
      });
    });

  const graphValidationErrorCodeSchema = z.enum([
    "baseline_snapshot_mismatch",
    "target_not_managed",
    "dependency_not_managed",
    "parent_not_managed",
    "area_not_found",
    "before_value_mismatch",
    "split_request_not_explicit",
    "status_evidence_invalid",
    "conflicting_field_update",
    "dependency_cycle",
    "parent_cycle",
  ]);

  const graphValidationErrorSchema = z
    .object({
      code: graphValidationErrorCodeSchema,
      message: nonBlankTextSchema,
    })
    .strict();

  const graphValidOperationResultSchema = z
    .object({
      kind: z.literal("valid"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
    })
    .strict();

  const graphInvalidOperationResultSchema = z
    .object({
      kind: z.literal("invalid"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
      errors: z.array(graphValidationErrorSchema).min(1),
    })
    .strict();

  const graphOperationResultSchema = z.discriminatedUnion("kind", [
    graphValidOperationResultSchema,
    graphInvalidOperationResultSchema,
  ]);

  const cycleSchema = z
    .array(nonBlankTextSchema)
    .min(1)
    .max(maximumCycleNodes)
    .superRefine((nodes, context) => {
      const seen = new Set<string>();
      nodes.forEach((node, index) => {
        if (seen.has(node)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "循環内のノードを重複して指定できません。",
          });
          return;
        }
        seen.add(node);
        const previous = nodes[index - 1];
        if (previous != null && compareStrings(previous, node) > 0) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "循環内のノードは決定論的な順序で指定してください。",
          });
        }
      });
    });

  const cyclesSchema = z
    .array(cycleSchema)
    .max(maximumCycles)
    .superRefine((cycles, context) => {
      const seen = new Set<string>();
      cycles.forEach((cycle, index) => {
        const key = cycle.join("\u0000");
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じ循環を重複して指定できません。",
          });
          return;
        }
        seen.add(key);
        const previous = cycles[index - 1];
        const currentNode = cycle[0];
        const previousNode = previous?.[0];
        if (
          previousNode != null
          && currentNode != null
          && compareStrings(previousNode, currentNode) > 0
        ) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "循環一覧は決定論的な順序で指定してください。",
          });
        }
      });
    });

  const selectedGraphSafeResultSchema = z
    .object({
      kind: z.literal("safe"),
      dependency_cycles: cyclesSchema.length(0),
      parent_cycles: cyclesSchema.length(0),
    })
    .strict();

  const selectedGraphUnsafeResultSchema = z
    .object({
      kind: z.literal("unsafe"),
      dependency_cycles: cyclesSchema,
      parent_cycles: cyclesSchema,
    })
    .strict()
    .superRefine((result, context) => {
      if (result.dependency_cycles.length === 0 && result.parent_cycles.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["kind"],
          message: "unsafeには依存循環または親子循環が必要です。",
        });
      }
    });

  /** 明示選択した操作集合のグラフ検証入力を検証するスキーマです。 */
  const selectedProposalGraphValidationInputBaseSchema = z
    .object({
      proposal: proposalSchema,
      managed_tasks: managedTasksSchema,
      selected_operation_ids: selectedOperationIdsSchema,
      temporary_ref_mappings: temporaryRefMappingsSchema,
    })
    .strict();

  /** 明示選択した操作集合のグラフ検証結果を検証するスキーマです。 */
  const selectedProposalGraphValidationResultSchema = z.discriminatedUnion(
    "kind",
    [selectedGraphSafeResultSchema, selectedGraphUnsafeResultSchema],
  );

  const graphValidationGroupResultSchema = z
    .object({
      group_id: identifierSchema,
      atomic: z.boolean(),
      applicable: z.boolean(),
      operation_ids: z.array(identifierSchema).min(1),
    })
    .strict();

  /** 投影したグラフ検証の入力を検証するスキーマです。 */
  const graphValidationInputBaseSchema = z
    .object({
      proposal: proposalSchema,
      managed_tasks: managedTasksSchema,
      basic_validation_result: proposalValidationResultSchema,
    })
    .strict();

  /** 投影したグラフ検証の結果を検証するスキーマです。 */
  const graphValidationResultSchema = z
    .object({
      operations: z.array(graphOperationResultSchema).min(1),
      groups: z.array(graphValidationGroupResultSchema).min(1),
      dependency_cycles: cyclesSchema,
      parent_cycles: cyclesSchema,
    })
    .strict()
    .superRefine(validateResultContext);

  type GraphValidationResult = z.infer<typeof graphValidationResultSchema>;

  function validateResultContext(
    result: GraphValidationResult,
    context: z.RefinementCtx,
  ): void {
    const operationResults = new Map<
      string,
      { readonly group_id: string; readonly kind: "valid" | "invalid" }
    >();
    result.operations.forEach((operation, index) => {
      if (operationResults.has(operation.operation_id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operation_id"],
          message: "同じoperation_idを検証結果へ重複して指定できません。",
        });
        return;
      }
      operationResults.set(operation.operation_id, {
        group_id: operation.group_id,
        kind: operation.kind,
      });
    });

    const groupIds = new Set<string>();
    const memberships = new Map<string, number>();
    result.groups.forEach((group, groupIndex) => {
      if (groupIds.has(group.group_id)) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "group_id"],
          message: "同じgroup_idを検証結果へ重複して指定できません。",
        });
      } else {
        groupIds.add(group.group_id);
      }
      const groupOperationIds = new Set<string>();
      let validOperationCount = 0;
      group.operation_ids.forEach((operationId, operationIndex) => {
        if (groupOperationIds.has(operationId)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: "同じoperation_idをグループへ重複して指定できません。",
          });
        } else {
          groupOperationIds.add(operationId);
        }
        const membershipCount = memberships.get(operationId);
        memberships.set(operationId, (membershipCount ?? 0) + 1);
        const operation = operationResults.get(operationId);
        if (operation == null) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: `operation_id ${operationId} に対応する操作結果がありません。`,
          });
          return;
        }
        if (operation.group_id !== group.group_id) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: `operation_id ${operationId} の所属group_idが一致しません。`,
          });
        }
        if (operation.kind === "valid") {
          validOperationCount += 1;
        }
      });
      const expectedApplicable = group.atomic
        ? validOperationCount === group.operation_ids.length
        : validOperationCount > 0;
      if (group.applicable !== expectedApplicable) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "applicable"],
          message: "groupのapplicableが操作結果から導かれる値と一致しません。",
        });
      }
    });

    result.operations.forEach((operation, operationIndex) => {
      if (!groupIds.has(operation.group_id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationIndex, "group_id"],
          message: `group_id ${operation.group_id} に対応するグループがありません。`,
        });
      }
      const membershipCount = memberships.get(operation.operation_id);
      if (membershipCount == null) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationIndex, "operation_id"],
          message: `operation_id ${operation.operation_id} がグループに所属していません。`,
        });
      } else if (membershipCount !== 1) {
        context.addIssue({
          code: "custom",
          path: ["operations", operationIndex, "operation_id"],
          message: `operation_id ${operation.operation_id} は一つのグループにだけ所属できます。`,
        });
      }
    });
  }

  return {
    graphValidationErrorSchema,
    graphOperationResultSchema,
    graphValidationGroupResultSchema,
    graphValidationInputBaseSchema,
    graphValidationResultSchema,
    selectedProposalGraphValidationInputBaseSchema,
    selectedProposalGraphValidationResultSchema,
  };
}
