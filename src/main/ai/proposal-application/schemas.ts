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
} from "../../../shared/ai";

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

const writerReasonCodeSchema = z.enum([
  "applied",
  "already_applied",
  "baseline_changed",
  "read_back_mismatch",
  "external_unreadable",
  "external_identity_mismatch",
  "merge_conflict",
  "external_capacity_exceeded",
]);

const writerResultSchema = z
  .object({
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.enum(["applied", "already_applied", "conflict"]),
    reason_code: writerReasonCodeSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.outcome === "applied" && result.reason_code !== "applied") {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "appliedのreason_codeが一致しません。",
      });
    }
    if (
      result.outcome === "already_applied"
      && result.reason_code !== "already_applied"
    ) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "already_appliedのreason_codeが一致しません。",
      });
    }
    if (result.outcome === "conflict" && ["applied", "already_applied"].includes(result.reason_code)) {
      context.addIssue({
        code: "custom",
        path: ["reason_code"],
        message: "conflictのreason_codeが不正です。",
      });
    }
  });

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
