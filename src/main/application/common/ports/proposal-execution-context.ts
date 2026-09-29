import { z } from "zod";
import { gidSchema, identifierSchema } from "../../../domain/primitives";

const preflightResultSchema = z.discriminatedUnion("reason_code", [
  z.object({
    group_id: identifierSchema,
    operation_id: identifierSchema,
    task_gid: gidSchema.optional(),
    outcome: z.literal("not_applied"),
    reason_code: z.literal("approval_conflict"),
  }).strict(),
  z.object({
    group_id: identifierSchema,
    operation_id: identifierSchema,
    task_gid: gidSchema.optional(),
    outcome: z.literal("not_applied"),
    reason_code: z.literal("atomic_group_blocked"),
  }).strict(),
  z.object({
    group_id: identifierSchema,
    operation_id: identifierSchema,
    task_gid: gidSchema,
    outcome: z.literal("already_applied"),
    reason_code: z.literal("already_applied"),
  }).strict(),
]);

const proposalExecutionContextSchema = z.object({
  format_version: z.literal(1),
  groups: z.array(z.object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operation_ids: z.array(identifierSchema).min(1),
  }).strict()).min(1),
  preflight_results: z.array(preflightResultSchema),
}).strict().superRefine((context, issues) => {
  const groupIds = new Set<string>();
  const operationGroups = new Map<string, string>();
  for (const [groupIndex, group] of context.groups.entries()) {
    if (groupIds.has(group.group_id)) {
      issues.addIssue({
        code: "custom",
        path: ["groups", groupIndex, "group_id"],
        message: "execution contextのgroup IDが重複しています。",
      });
    }
    groupIds.add(group.group_id);
    for (const [operationIndex, operationId] of group.operation_ids.entries()) {
      if (operationGroups.has(operationId)) {
        issues.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "operation_ids", operationIndex],
          message: "execution contextの操作IDが重複しています。",
        });
      }
      operationGroups.set(operationId, group.group_id);
    }
  }
  const preflightIds = new Set<string>();
  for (const [index, result] of context.preflight_results.entries()) {
    if (preflightIds.has(result.operation_id)
      || operationGroups.get(result.operation_id) !== result.group_id) {
      issues.addIssue({
        code: "custom",
        path: ["preflight_results", index],
        message: "execution contextの事前判定結果が選択操作と一致しません。",
      });
    }
    preflightIds.add(result.operation_id);
  }
});

export type ProposalPreflightOperationResult = {
  readonly group_id: string;
  readonly operation_id: string;
} & (
  | { readonly task_gid?: string; readonly outcome: "not_applied"; readonly reason_code: "approval_conflict" }
  | { readonly task_gid?: string; readonly outcome: "not_applied"; readonly reason_code: "atomic_group_blocked" }
  | { readonly task_gid: string; readonly outcome: "already_applied"; readonly reason_code: "already_applied" }
);

export type ProposalExecutionContext = {
  readonly format_version: 1;
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operation_ids: readonly string[];
  }[];
  readonly preflight_results: readonly ProposalPreflightOperationResult[];
};

/** proposalの選択順と事前判定結果をimmutableな保存値として検証します。 */
export function parseProposalExecutionContext(value: unknown): ProposalExecutionContext {
  const context = proposalExecutionContextSchema.parse(value);
  const preflightResults: ProposalPreflightOperationResult[] = context.preflight_results.map((result) => {
    if (result.reason_code === "already_applied") return Object.freeze(result);
    const { task_gid: taskGid, ...operation } = result;
    return Object.freeze(taskGid == null ? operation : { ...operation, task_gid: taskGid });
  });
  return Object.freeze({
    format_version: context.format_version,
    groups: Object.freeze(context.groups.map((group) => Object.freeze({
      group_id: group.group_id,
      atomic: group.atomic,
      operation_ids: Object.freeze([...group.operation_ids]),
    }))),
    preflight_results: Object.freeze(preflightResults),
  });
}
