import { z } from "zod";
import { identifierSchema } from "../../../domain/task-write-values";

const proposalExecutionContextSchema = z.object({
  format_version: z.literal(1),
  groups: z.array(z.object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operation_ids: z.array(identifierSchema).min(1),
  }).strict()).min(1),
}).strict().superRefine((context, issues) => {
  const groupIds = new Set<string>();
  const operationIds = new Set<string>();
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
      if (operationIds.has(operationId)) {
        issues.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "operation_ids", operationIndex],
          message: "execution contextの操作IDが重複しています。",
        });
      }
      operationIds.add(operationId);
    }
  }
});

export type ProposalExecutionContext = {
  readonly format_version: 1;
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly operation_ids: readonly string[];
  }[];
};

/** proposalのgroup順と操作順をimmutableな保存値として検証します。 */
export function parseProposalExecutionContext(value: unknown): ProposalExecutionContext {
  const context = proposalExecutionContextSchema.parse(value);
  return Object.freeze({
    format_version: context.format_version,
    groups: Object.freeze(context.groups.map((group) => Object.freeze({
      group_id: group.group_id,
      atomic: group.atomic,
      operation_ids: Object.freeze([...group.operation_ids]),
    }))),
  });
}
