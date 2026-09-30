import { z } from "zod";

/** 基本検証の入力と結果のスキーマを組み立てます。 */
export function createBasicValidationSchemas<
  TProposal extends z.ZodType,
  TTask extends z.ZodType<{ gid: string }>,
>(dependencies: {
  readonly areaSchema: z.ZodType<string>;
  readonly createUtf8ByteLimitedStringSchema: (maxBytes: number) => z.ZodString;
  readonly gidSchema: z.ZodType<string>;
  readonly identifierSchema: z.ZodType<string>;
  readonly proposalSchema: TProposal;
  readonly snapshotHashSchema: z.ZodType<string>;
  readonly taskSchema: TTask;
}) {
  const {
    areaSchema,
    createUtf8ByteLimitedStringSchema,
    gidSchema,
    identifierSchema,
    proposalSchema,
    snapshotHashSchema,
    taskSchema,
  } = dependencies;

  const nonBlankLocatorSchema = z.string().refine((value) => value.trim().length > 0, {
    message: "根拠locatorを空にできません。",
  });

  const maximumManagedTasks = 10000;
  const maximumExistingAreas = 256;
  const maximumSplitRequestReferences = 256;
  const maximumTrustedStatusEvidenceReferences = 110_257;
  const maximumEvidenceBytes = 4 * 1024;
  const evidenceExcerptSchema = createUtf8ByteLimitedStringSchema(maximumEvidenceBytes).optional();
  const explicitSplitRequestExcerptSchema = createUtf8ByteLimitedStringSchema(
    maximumEvidenceBytes,
  ).refine((value) => value.trim().length > 0, {
    message: "分割依頼の根拠抜粋を空にできません。",
  });

  /** タスク根拠の正規locatorを作成します。 */
  function createTaskEvidenceLocator(taskGid: string): string {
    return `task:${gidSchema.parse(taskGid)}`;
  }

  /** 全子タスク完了根拠の正規locatorを作成します。 */
  function createChildrenOnlyEvidenceLocator(taskGid: string): string {
    return `${createTaskEvidenceLocator(taskGid)}#children-only-all-completed`;
  }

  /** 当該ターンへ提供された完了・取り下げ根拠を検証するスキーマです。 */
  const trustedStatusEvidenceReferenceSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("user_message"),
        locator: nonBlankLocatorSchema,
        target_task_gid: gidSchema,
        allowed_operation: z.enum(["complete", "withdraw"]),
        excerpt: evidenceExcerptSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("task"),
        locator: nonBlankLocatorSchema,
        target_task_gid: gidSchema,
        allowed_operation: z.enum(["complete", "withdraw"]),
        validation_kind: z.enum([
          "explicit_text",
          "children_only_all_completed",
        ]),
        excerpt: evidenceExcerptSchema,
      })
      .strict()
      .superRefine((reference, context) => {
        if (
          reference.validation_kind === "children_only_all_completed"
          && reference.allowed_operation !== "complete"
        ) {
          context.addIssue({
            code: "custom",
            path: ["allowed_operation"],
            message: "全子タスク完了根拠は完了操作だけに利用できます。",
          });
        }
      }),
    z
      .object({
        kind: z.literal("external_tool"),
        locator: nonBlankLocatorSchema,
        target_task_gid: gidSchema,
        status: z.enum(["closed", "completed", "cancelled"]),
      })
      .strict(),
    z
      .object({
        kind: z.literal("external_review"),
        locator: nonBlankLocatorSchema,
        target_task_gid: gidSchema,
        allowed_operation: z.enum(["complete", "withdraw"]),
        excerpt: explicitSplitRequestExcerptSchema,
      })
      .strict(),
  ]);

  /** 当該ターンへ提供された完了・取り下げ根拠集合を検証するスキーマです。 */
  const trustedStatusEvidenceReferencesSchema = z
    .array(trustedStatusEvidenceReferenceSchema)
    .max(maximumTrustedStatusEvidenceReferences)
    .superRefine((references, context) => {
      const seen = new Set<string>();
      references.forEach((reference, index) => {
        const key = `${reference.kind}\u0000${reference.locator}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `信頼済み根拠locator ${reference.locator} が重複しています。`,
          });
          return;
        }
        seen.add(key);
      });
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

  const existingAreasSchema = z
    .array(areaSchema)
    .max(maximumExistingAreas)
    .superRefine((areas, context) => {
      const seen = new Set<string>();
      areas.forEach((area, index) => {
        if (seen.has(area)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `領域 ${area} が重複しています。`,
          });
          return;
        }
        seen.add(area);
      });
    });

  const explicitSplitRequestParentSchema = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("existing"),
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

  const explicitSplitRequestReferenceSchema = z
    .object({
      parent: explicitSplitRequestParentSchema,
      locator: nonBlankLocatorSchema,
      excerpt: explicitSplitRequestExcerptSchema,
    })
    .strict();

  const explicitSplitRequestReferencesSchema = z
    .array(explicitSplitRequestReferenceSchema)
    .max(maximumSplitRequestReferences)
    .superRefine((references, context) => {
      const seen = new Set<string>();
      references.forEach((reference, index) => {
        const parent = reference.parent.kind === "existing"
          ? `existing:${reference.parent.gid}`
          : `temporary:${reference.parent.ref}`;
        const key = `${parent}\u0000${reference.locator}\u0000${reference.excerpt}`;
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: `分割依頼根拠 ${reference.locator} が重複しています。`,
          });
          return;
        }
        seen.add(key);
      });
    });

  /** AI変更案の基本検証入力を検証するスキーマです。 */
  const proposalValidationInputSchema = z
    .object({
      proposal: proposalSchema,
      baseline_snapshot_hash: snapshotHashSchema,
      managed_tasks: managedTasksSchema,
      existing_areas: existingAreasSchema,
      explicit_split_request_references: explicitSplitRequestReferencesSchema,
      trusted_status_evidence: trustedStatusEvidenceReferencesSchema,
    })
    .strict();

  const proposalValidationErrorCodeSchema = z.enum([
    "baseline_snapshot_mismatch",
    "target_not_managed",
    "dependency_not_managed",
    "parent_not_managed",
    "area_not_found",
    "before_value_mismatch",
    "split_request_not_explicit",
    "status_evidence_invalid",
    "conflicting_field_update",
  ]);

  const proposalValidationErrorSchema = z
    .object({
      code: proposalValidationErrorCodeSchema,
      message: z.string().refine((value) => value.trim().length > 0, {
        message: "検証エラーの説明を空にできません。",
      }),
    })
    .strict();

  const validOperationResultSchema = z
    .object({
      kind: z.literal("valid"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
    })
    .strict();

  const invalidOperationResultSchema = z
    .object({
      kind: z.literal("invalid"),
      group_id: identifierSchema,
      operation_id: identifierSchema,
      errors: z.array(proposalValidationErrorSchema).min(1),
    })
    .strict();

  const proposalValidationOperationResultSchema = z.discriminatedUnion("kind", [
    validOperationResultSchema,
    invalidOperationResultSchema,
  ]);

  const proposalValidationGroupResultSchema = z
    .object({
      group_id: identifierSchema,
      atomic: z.boolean(),
      applicable: z.boolean(),
      operation_ids: z.array(identifierSchema).min(1),
    })
    .strict();

  /** AI変更案の基本検証結果を検証するスキーマです。 */
  const proposalValidationResultSchema = z
    .object({
      operations: z.array(proposalValidationOperationResultSchema).min(1),
      groups: z.array(proposalValidationGroupResultSchema).min(1),
    })
    .strict()
    .superRefine((result, context) => {
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
      const operationMemberships = new Map<string, number>();
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

          const membershipCount = operationMemberships.get(operationId);
          operationMemberships.set(operationId, (membershipCount ?? 0) + 1);
          const operationResult = operationResults.get(operationId);
          if (operationResult == null) {
            context.addIssue({
              code: "custom",
              path: ["groups", groupIndex, "operation_ids", operationIndex],
              message: `operation_id ${operationId} に対応する操作結果がありません。`,
            });
            return;
          }
          if (operationResult.group_id !== group.group_id) {
            context.addIssue({
              code: "custom",
              path: ["groups", groupIndex, "operation_ids", operationIndex],
              message: `operation_id ${operationId} の所属group_idが一致しません。`,
            });
          }
          if (operationResult.kind === "valid") {
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
        const membershipCount = operationMemberships.get(operation.operation_id);
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
    });

  return {
    createChildrenOnlyEvidenceLocator,
    proposalValidationErrorCodeSchema,
    proposalValidationErrorSchema,
    proposalValidationGroupResultSchema,
    proposalValidationInputSchema,
    proposalValidationOperationResultSchema,
    proposalValidationResultSchema,
    trustedStatusEvidenceReferenceSchema,
    trustedStatusEvidenceReferencesSchema,
    explicitSplitRequestReferenceSchema,
  };
}
