import { z } from "zod";
import {
  asanaTaskResponseSchema,
  createUtf8ByteLimitedStringSchema,
  customExternalDataMaxBytes,
  dateSchema,
  externalTaskGidSchema,
  gidSchema,
  identifierSchema,
  parseCustomExternalData,
  serializeCustomExternalData,
} from "../../../shared/domain";
import {
  proposalOperationSchema,
  proposalSchema,
} from "../../../shared/ai";
import {
  proposalApprovalInputSchema,
} from "../proposal-approval";

const sectionGidsSchema = z
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
          message: "状態セクションGIDを重複して指定できません。",
        });
      }
      seen.add(gid);
    }
  });

const temporaryRefMappingSchema = z
  .object({
    temporary_ref: identifierSchema,
    task_gid: gidSchema,
  })
  .strict();

const temporaryRefMappingsSchema = z
  .array(temporaryRefMappingSchema)
  .max(256)
  .superRefine((mappings, context) => {
    const temporaryRefs = new Set<string>();
    const taskGids = new Set<string>();
    for (const [index, mapping] of mappings.entries()) {
      if (temporaryRefs.has(mapping.temporary_ref)) {
        context.addIssue({
          code: "custom",
          path: [index, "temporary_ref"],
          message: "temporary_refを重複して指定できません。",
        });
      }
      if (taskGids.has(mapping.task_gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "task_gid"],
          message: "temporary_ref対応先GIDを重複して指定できません。",
        });
      }
      temporaryRefs.add(mapping.temporary_ref);
      taskGids.add(mapping.task_gid);
    }
  });

const rawExternalDataSchema = z
  .object({
    gid: externalTaskGidSchema,
    data: createUtf8ByteLimitedStringSchema(customExternalDataMaxBytes),
  })
  .strict()
  .superRefine((external, context) => {
    const parsed = parseCustomExternalData(external.data);
    if (parsed.kind !== "valid") {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "baselineのCustom external dataがvalidではありません。",
      });
      return;
    }
    if (
      external.gid !== `TaskHub:v1:task:${parsed.data.id}`
      || serializeCustomExternalData(parsed.data) !== external.data
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "baselineのCustom external dataの識別子または形式が不正です。",
      });
    }
  });

const writerInputSchema = z
  .object({
    operation: proposalOperationSchema,
    project_gid: gidSchema,
    workspace_gid: gidSchema,
    section_gids: sectionGidsSchema,
    device_id: identifierSchema,
    created_via: identifierSchema,
    activity_date: dateSchema,
    temporary_ref_to_gid: temporaryRefMappingsSchema,
    baseline_external_data: rawExternalDataSchema.optional(),
    create_external_id: z.uuid().optional(),
    existing_task: asanaTaskResponseSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.operation.operation === "create_task") {
      if (input.create_external_id == null) {
        context.addIssue({
          code: "custom",
          path: ["create_external_id"],
          message: "create_taskには事前発行UUIDが必要です。",
        });
      }
      if (input.baseline_external_data != null) {
        context.addIssue({
          code: "custom",
          path: ["baseline_external_data"],
          message: "create_taskにbaseline外部データを指定できません。",
        });
      }
    } else {
      if (input.create_external_id != null) {
        context.addIssue({
          code: "custom",
          path: ["create_external_id"],
          message: "create_task以外に作成UUIDを指定できません。",
        });
      }
      if (input.existing_task != null) {
        context.addIssue({
          code: "custom",
          path: ["existing_task"],
          message: "create_task以外に既存作成タスクを指定できません。",
        });
      }
      if (input.baseline_external_data == null) {
        context.addIssue({
          code: "custom",
          path: ["baseline_external_data"],
          message: "create_task以外にはbaseline外部データが必要です。",
        });
      }
    }
  });

const writerConflictReasonCodeSchema = z.enum([
  "baseline_changed",
  "read_back_mismatch",
  "external_unreadable",
  "external_identity_mismatch",
  "merge_conflict",
  "external_capacity_exceeded",
]);

const writerAppliedResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("applied"),
    reason_code: z.literal("applied"),
  })
  .strict();

const writerAlreadyAppliedResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("already_applied"),
    reason_code: z.literal("already_applied"),
  })
  .strict();

const writerConflictResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("conflict"),
    reason_code: writerConflictReasonCodeSchema,
    side_effect: z.enum(["none", "possible"]),
  })
  .strict();

const writerResultSchema = z.union([
  writerAppliedResultSchema,
  writerAlreadyAppliedResultSchema,
  writerConflictResultSchema,
]);

export type AsanaProposalOperationWriterInput = z.infer<typeof writerInputSchema>;
export type AsanaProposalOperationWriterResult = z.infer<typeof writerResultSchema>;
export type AsanaProposalWriterSectionGids = z.infer<typeof sectionGidsSchema>;
export type AsanaProposalWriterTemporaryRefMapping = z.infer<
  typeof temporaryRefMappingSchema
>;

/** 単一AI変更操作の適用入力を検証するスキーマです。 */
export const asanaProposalOperationWriterInputSchema = writerInputSchema;

/** 単一AI変更操作の適用結果を検証するスキーマです。 */
export const asanaProposalOperationWriterResultSchema = writerResultSchema;

const applicationSectionGidsSchema = z
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
          message: "状態セクションGIDを重複して指定できません。",
        });
      }
      seen.add(gid);
    }
  });

const applicationRawExternalDataSchema = z
  .object({
    gid: externalTaskGidSchema,
    data: createUtf8ByteLimitedStringSchema(customExternalDataMaxBytes),
  })
  .strict()
  .superRefine((external, context) => {
    const parsed = parseCustomExternalData(external.data);
    if (parsed.kind !== "valid") {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "適用基準のCustom external dataがvalidではありません。",
      });
      return;
    }
    if (
      external.gid !== `TaskHub:v1:task:${parsed.data.id}`
      || serializeCustomExternalData(parsed.data) !== external.data
    ) {
      context.addIssue({
        code: "custom",
        path: ["data"],
        message: "適用基準のCustom external dataの形式が不正です。",
      });
    }
  });

const applicationBaselineExternalDataSchema = z
  .object({
    task_gid: gidSchema,
    external: applicationRawExternalDataSchema,
  })
  .strict();

const applicationBaselineExternalDataArraySchema = z
  .array(applicationBaselineExternalDataSchema)
  .max(10_000)
  .superRefine((entries, context) => {
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (seen.has(entry.task_gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "task_gid"],
          message: "同じタスクGIDの適用基準外部データを重複指定できません。",
        });
      }
      seen.add(entry.task_gid);
    }
  });

const applicationContextShape = {
  proposal_id: identifierSchema,
  project_gid: gidSchema,
  workspace_gid: gidSchema,
  section_gids: applicationSectionGidsSchema,
  device_id: identifierSchema,
  created_via: identifierSchema,
  activity_date: dateSchema,
  baseline_external_data: applicationBaselineExternalDataArraySchema,
};

const applicationInputSchema = z
  .object({
    ...applicationContextShape,
    approval_input: proposalApprovalInputSchema,
  })
  .strict();

const recoveryApplicationSchema = z
  .object({
    ...applicationContextShape,
    proposal: proposalSchema,
  })
  .strict();

const recoveryProjectGidsSchema = z
  .array(gidSchema)
  .max(32)
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    for (const [index, gid] of gids.entries()) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "復旧対象project GIDを重複して指定できません。",
        });
      }
      seen.add(gid);
    }
  });

const recoveryInputSchema = z
  .object({
    applications: z.array(recoveryApplicationSchema).max(32),
    project_gids: recoveryProjectGidsSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const proposalIds = new Set<string>();
    for (const [index, application] of input.applications.entries()) {
      if (proposalIds.has(application.proposal_id)) {
        context.addIssue({
          code: "custom",
          path: ["applications", index, "proposal_id"],
          message: "同じproposal_idの復旧対象を重複指定できません。",
        });
      }
      proposalIds.add(application.proposal_id);
    }
    if (
      input.applications.length === 0
      && (input.project_gids == null || input.project_gids.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["project_gids"],
        message: "文脈なし復旧にはproject GIDが必要です。",
      });
    }
  });

const applicationReasonCodeSchema = z.enum([
  "applied",
  "already_applied",
  "approval_conflict",
  "atomic_group_blocked",
  "writer_conflict",
  "recovery_required",
  "recovery_context_missing",
  "task_not_found",
  "duplicate_external_id",
  "journal_target_mismatch",
]);

const applicationOutcomeSchema = z.enum([
  "applied",
  "already_applied",
  "not_applied",
  "unknown",
]);

const applicationOperationResultSchema = z
  .object({
    group_id: identifierSchema,
    operation_id: identifierSchema,
    task_gid: gidSchema.optional(),
    outcome: applicationOutcomeSchema,
    reason_code: applicationReasonCodeSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "applied") {
      if (result.reason_code !== "applied") {
        context.addIssue({
          code: "custom",
          path: ["reason_code"],
          message: "appliedのreason_codeが一致しません。",
        });
      }
      if (result.task_gid == null) {
        context.addIssue({
          code: "custom",
          path: ["task_gid"],
          message: "appliedには対象GIDが必要です。",
        });
      }
    }
    if (result.outcome === "already_applied") {
      if (result.reason_code !== "already_applied") {
        context.addIssue({
          code: "custom",
          path: ["reason_code"],
          message: "already_appliedのreason_codeが一致しません。",
        });
      }
      if (result.task_gid == null) {
        context.addIssue({
          code: "custom",
          path: ["task_gid"],
          message: "already_appliedには対象GIDが必要です。",
        });
      }
    }
    if (
      result.outcome === "not_applied"
      && ![
        "approval_conflict",
        "atomic_group_blocked",
        "writer_conflict",
      ].includes(result.reason_code)
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "not_appliedのreason_codeが不正です。",
      });
    }
    if (
      result.outcome === "unknown"
      && ![
        "recovery_required",
        "recovery_context_missing",
        "task_not_found",
        "duplicate_external_id",
        "journal_target_mismatch",
      ].includes(result.reason_code)
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "unknownのreason_codeが不正です。",
      });
    }
  });

const applicationGroupOutcomeSchema = z.enum([
  "applied",
  "already_applied",
  "partially_applied",
  "not_applied",
  "unknown",
]);

const applicationGroupResultSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operation_ids: z.array(identifierSchema).min(1),
    outcome: applicationGroupOutcomeSchema,
  })
  .strict()
  .superRefine((group, context) => {
    const seen = new Set<string>();
    for (const [index, operationId] of group.operation_ids.entries()) {
      if (seen.has(operationId)) {
        context.addIssue({
          code: "custom",
          path: ["operation_ids", index],
          message: "同じoperation_idをグループへ重複指定できません。",
        });
      }
      seen.add(operationId);
    }
  });

type ApplicationOperationResultValue = z.infer<
  typeof applicationOperationResultSchema
>;
type ApplicationGroupOutcomeValue = z.infer<typeof applicationGroupOutcomeSchema>;

function applicationGroupOutcomeFromOperations(
  operations: readonly ApplicationOperationResultValue[],
): ApplicationGroupOutcomeValue {
  const hasUnknown = operations.some((operation) => operation.outcome === "unknown");
  const hasApplied = operations.some((operation) => operation.outcome === "applied");
  const hasAlreadyApplied = operations.some(
    (operation) => operation.outcome === "already_applied",
  );
  const hasNotApplied = operations.some(
    (operation) => operation.outcome === "not_applied",
  );
  if (hasUnknown && !hasApplied && !hasAlreadyApplied) {
    return "unknown";
  }
  if (hasUnknown || (hasNotApplied && (hasApplied || hasAlreadyApplied))) {
    return "partially_applied";
  }
  if (hasNotApplied) {
    return "not_applied";
  }
  if (hasApplied) {
    return "applied";
  }
  return "already_applied";
}

function applicationResultOutcomeFromGroups(
  groups: readonly ApplicationGroupOutcomeValue[],
): ApplicationGroupOutcomeValue {
  const hasUnknown = groups.some((group) => group === "unknown");
  const hasApplied = groups.some((group) => group === "applied");
  const hasAlreadyApplied = groups.some((group) => group === "already_applied");
  const hasPartiallyApplied = groups.some((group) => group === "partially_applied");
  const hasNotApplied = groups.some((group) => group === "not_applied");
  const hasAppliedFact = hasApplied || hasAlreadyApplied || hasPartiallyApplied;
  if (hasUnknown && !hasAppliedFact) {
    return "unknown";
  }
  if (hasUnknown || hasPartiallyApplied || (hasNotApplied && hasAppliedFact)) {
    return "partially_applied";
  }
  if (hasNotApplied) {
    return "not_applied";
  }
  if (hasApplied) {
    return "applied";
  }
  return "already_applied";
}

const applicationResultSchema = z
  .object({
    proposal_id: identifierSchema,
    outcome: applicationGroupOutcomeSchema,
    operations: z.array(applicationOperationResultSchema).min(1),
    groups: z.array(applicationGroupResultSchema).min(1),
  })
  .strict()
  .superRefine((result, context) => {
    const operationMap = new Map<string, string>();
    const operationResults = new Map<string, ApplicationOperationResultValue>();
    for (const [index, operation] of result.operations.entries()) {
      if (operationMap.has(operation.operation_id)) {
        context.addIssue({
          code: "custom",
          path: ["operations", index, "operation_id"],
          message: "同じoperation_idの適用結果を重複指定できません。",
        });
      }
      operationMap.set(operation.operation_id, operation.group_id);
      operationResults.set(operation.operation_id, operation);
    }
    const groupIds = new Set<string>();
    for (const [groupIndex, group] of result.groups.entries()) {
      if (groupIds.has(group.group_id)) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "group_id"],
          message: "同じgroup_idの適用結果を重複指定できません。",
        });
      }
      groupIds.add(group.group_id);
      for (const [operationIndex, operationId] of group.operation_ids.entries()) {
        const operationGroupId = operationMap.get(operationId);
        if (operationGroupId == null) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: "グループのoperation_idに対応する結果がありません。",
          });
        } else if (operationGroupId !== group.group_id) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operation_ids", operationIndex],
            message: "操作結果のgroup_idが一致しません。",
          });
        }
      }
    }
    for (const [operationId, groupId] of operationMap) {
      const group = result.groups.find((candidate) => candidate.group_id === groupId);
      if (group == null || !group.operation_ids.includes(operationId)) {
        context.addIssue({
          code: "custom",
          path: ["operations"],
          message: "操作結果がグループへ所属していません。",
        });
      }
    }
    for (const group of result.groups) {
      const groupOperations: ApplicationOperationResultValue[] = [];
      for (const operationId of group.operation_ids) {
        const operation = operationResults.get(operationId);
        if (operation != null) {
          groupOperations.push(operation);
        }
      }
      if (groupOperations.length === group.operation_ids.length) {
        const expected = applicationGroupOutcomeFromOperations(groupOperations);
        if (group.outcome !== expected) {
          context.addIssue({
            code: "custom",
            path: ["groups"],
            message: "グループ結果のoutcomeが操作結果と一致しません。",
          });
        }
      }
    }
    const expectedOutcome = applicationResultOutcomeFromGroups(
      result.groups.map((group) => group.outcome),
    );
    if (result.outcome !== expectedOutcome) {
      context.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "適用結果のoutcomeがグループ結果と一致しません。",
      });
    }
  });

const unresolvedJournalSchema = z
  .object({
    proposal_id: identifierSchema,
    operation_id: identifierSchema,
    task_gid: gidSchema.optional(),
    outcome: z.literal("unknown"),
    reason_code: z.enum([
      "recovery_context_missing",
      "task_not_found",
      "duplicate_external_id",
      "journal_target_mismatch",
      "recovery_required",
    ]),
  })
  .strict();

const recoveryResultSchema = z
  .object({
    applications: z.array(applicationResultSchema),
    unresolved_journals: z.array(unresolvedJournalSchema),
  })
  .strict()
  .superRefine((result, context) => {
    const applicationIds = new Set<string>();
    const journalKeys = new Set<string>();
    for (const [index, application] of result.applications.entries()) {
      if (applicationIds.has(application.proposal_id)) {
        context.addIssue({
          code: "custom",
          path: ["applications", index, "proposal_id"],
          message: "同じproposal_idの復旧結果を重複指定できません。",
        });
      }
      applicationIds.add(application.proposal_id);
      for (const operation of application.operations) {
        journalKeys.add(`${application.proposal_id}\u0000${operation.operation_id}`);
      }
    }
    for (const [index, journal] of result.unresolved_journals.entries()) {
      const key = `${journal.proposal_id}\u0000${journal.operation_id}`;
      if (journalKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["unresolved_journals", index],
          message: "同じ適用ジャーナルの復旧結果を重複指定できません。",
        });
      }
      journalKeys.add(key);
    }
  });

export type AsanaProposalApplicationInput = z.infer<typeof applicationInputSchema>;
export type AsanaProposalApplicationResult = z.infer<typeof applicationResultSchema>;
export type AsanaProposalRecoveryInput = z.infer<typeof recoveryInputSchema>;
export type AsanaProposalRecoveryResult = z.infer<typeof recoveryResultSchema>;

/** 承認済みAI変更案の適用入力を検証するスキーマです。 */
export const asanaProposalApplicationInputSchema = applicationInputSchema;

/** 承認済みAI変更案の適用結果を検証するスキーマです。 */
export const asanaProposalApplicationResultSchema = applicationResultSchema;

/** 未完了ジャーナルの復旧入力を検証するスキーマです。 */
export const asanaProposalRecoveryInputSchema = recoveryInputSchema;

/** 未完了ジャーナルの復旧結果を検証するスキーマです。 */
export const asanaProposalRecoveryResultSchema = recoveryResultSchema;
