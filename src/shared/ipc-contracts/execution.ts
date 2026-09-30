import { z } from "zod";
import { dateTimeSchema, errorIdSchema, gidSchema, identifierSchema } from "./common";

const operationResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      operation_id: identifierSchema,
      group_id: identifierSchema.optional(),
      task_gid: gidSchema.optional(),
      outcome: z.literal("pending"),
    })
    .strict(),
  z
    .object({
      operation_id: identifierSchema,
      group_id: identifierSchema.optional(),
      task_gid: gidSchema.optional(),
      outcome: z.enum(["applied", "already_applied", "not_applied", "unknown"]),
      reason_code: identifierSchema,
    })
    .strict(),
]);

const groupResultSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operation_ids: z.array(identifierSchema).min(1),
    outcome: z.enum(["pending", "applied", "already_applied", "not_applied", "partially_applied", "unknown"]),
  })
  .strict();

const executionStepShape = {
  step_id: identifierSchema,
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("operation"), operation_id: identifierSchema }).strict(),
    z.object({ kind: z.literal("execution") }).strict(),
  ]),
  kind: z.enum([
    "proposal_operation_check",
    "asana_create_task",
    "asana_update_task",
    "asana_add_to_project",
    "asana_add_to_section",
    "asana_add_tag",
    "asana_remove_tag",
    "asana_set_parent",
    "asana_clear_parent",
    "asana_merge_external_data",
    "local_synchronize",
  ]),
  attempt: z.number().int().nonnegative().safe(),
  updated_at: dateTimeSchema,
};

const executionStepSchema = z.discriminatedUnion("state", [
  z.object({ ...executionStepShape, state: z.enum(["planned", "running", "succeeded"]) }).strict(),
  z.object({ ...executionStepShape, state: z.enum(["failed", "confirmation_required"]), error_id: errorIdSchema }).strict(),
]).superRefine((step, context) => {
  if (step.state === "planned" ? step.attempt !== 0 : step.attempt === 0) {
    context.addIssue({ code: "custom", path: ["attempt"], message: "stepの試行回数と状態が一致しません。" });
  }
});

const executionShape = {
  origin: z.enum(["proposal", "gui-edit"]),
  execution_id: identifierSchema,
  retry_of_execution_id: identifierSchema.optional(),
  proposal_id: identifierSchema.optional(),
  task_gid: gidSchema.optional(),
  created_at: dateTimeSchema,
  updated_at: dateTimeSchema,
  steps: z.array(executionStepSchema).min(1),
  operation_results: z.array(operationResultSchema).max(10_000),
  group_results: z.array(groupResultSchema).max(10_000),
};

export const executionDtoSchema = z
  .discriminatedUnion("state", [
    z.object({ ...executionShape, state: z.literal("planned") }).strict(),
    z.object({ ...executionShape, state: z.literal("running") }).strict(),
    z.object({ ...executionShape, state: z.literal("succeeded") }).strict(),
    z
      .object({
        ...executionShape,
        state: z.literal("failed"),
        error_id: errorIdSchema,
      })
      .strict(),
    z
      .object({
        ...executionShape,
        state: z.literal("confirmation_required"),
        error_id: errorIdSchema,
      })
      .strict(),
  ])
  .superRefine((execution, context) => {
    if (execution.retry_of_execution_id === execution.execution_id) {
      context.addIssue({
        code: "custom",
        path: ["retry_of_execution_id"],
        message: "再試行元と実行IDが同じです。",
      });
    }
    if (
      execution.origin === "proposal" &&
      (execution.proposal_id == null ||
        execution.task_gid != null ||
        execution.operation_results.length === 0 ||
        execution.group_results.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["proposal_id"],
        message: "変更案の実行対象が不正です。",
      });
    }
    if (
      execution.origin === "gui-edit" &&
      (execution.task_gid == null ||
        execution.proposal_id != null ||
        execution.operation_results.length !== 1 ||
        execution.group_results.length !== 0 ||
        execution.operation_results[0]?.group_id != null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["task_gid"],
        message: "GUI編集の実行対象が不正です。",
      });
    }
    const operationIds = execution.operation_results.map((operation) => operation.operation_id);
    const stepIds = execution.steps.map((step) => step.step_id);
    if (new Set(stepIds).size !== stepIds.length) {
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "step IDが重複しています。",
      });
    }
    if (new Set(operationIds).size !== operationIds.length) {
      context.addIssue({
        code: "custom",
        path: ["operation_results"],
        message: "操作IDが重複しています。",
      });
    }
    const groupIds = execution.group_results.map((group) => group.group_id);
    if (new Set(groupIds).size !== groupIds.length) {
      context.addIssue({
        code: "custom",
        path: ["group_results"],
        message: "グループIDが重複しています。",
      });
    }
    if (execution.origin === "proposal") {
      const groupedOperationIds = execution.group_results.flatMap((group) => group.operation_ids);
      if (
        new Set(groupedOperationIds).size !== groupedOperationIds.length ||
        groupedOperationIds.length !== operationIds.length ||
        groupedOperationIds.some((operationId) => !operationIds.includes(operationId))
      ) {
        context.addIssue({
          code: "custom",
          path: ["group_results"],
          message: "グループと操作の対応が不正です。",
        });
      }
      for (const operation of execution.operation_results) {
        if (
          operation.group_id == null ||
          !execution.group_results.some(
            (group) => group.group_id === operation.group_id && group.operation_ids.includes(operation.operation_id),
          )
        ) {
          context.addIssue({
            code: "custom",
            path: ["operation_results"],
            message: "操作の所属グループが不正です。",
          });
        }
      }
    }
  });

export type ExecutionDto = z.infer<typeof executionDtoSchema>;
