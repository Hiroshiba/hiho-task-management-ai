import { z } from "zod";
import {
  areaSchema,
  createUtf8ByteLimitedStringSchema,
  dateSchema,
  dependencyScopeSchema,
  gidSchema,
  identifierSchema,
  importanceSchema,
  isoDateTimeSchema,
  obsidianLinkSchema,
  obsidianLinksSchema,
  parentWorkModeSchema,
  snapshotHashSchema,
  taskStatusSchema,
} from "../domain";

const maximumProposalGroups = 32;
const maximumGroupOperations = 64;
const maximumProposalOperations = 256;
const maximumQuestions = 8;
const maximumEvidenceReferences = 16;
const maximumDependencyReferences = 64;
const maximumAsanaNotesBytes = 64 * 1024;
const maximumReasonBytes = 4 * 1024;
const maximumEvidenceBytes = 4 * 1024;
const maximumQuestionBytes = 4 * 1024;
const maximumTitleBytes = 1024;
const maximumMessageBytes = 16 * 1024;

const nonBlankTitleSchema = createUtf8ByteLimitedStringSchema(
  maximumTitleBytes,
).refine((value) => value.trim().length > 0, {
  message: "タイトルを空にできません。",
});
const nonBlankReasonSchema = createUtf8ByteLimitedStringSchema(
  maximumReasonBytes,
).refine((value) => value.trim().length > 0, {
  message: "理由を空にできません。",
});
const nonBlankEvidenceTextSchema = createUtf8ByteLimitedStringSchema(
  maximumEvidenceBytes,
).refine((value) => value.trim().length > 0, {
  message: "根拠参照を空にできません。",
});
const nonBlankQuestionSchema = createUtf8ByteLimitedStringSchema(
  maximumQuestionBytes,
).refine((value) => value.trim().length > 0, {
  message: "質問を空にできません。",
});
const taskNotesSchema = createUtf8ByteLimitedStringSchema(maximumAsanaNotesBytes);

const temporaryReferenceSchema = identifierSchema;

const existingTargetSchema = z
  .object({
    kind: z.literal("existing"),
    gid: gidSchema,
  })
  .strict();

const temporaryTargetSchema = z
  .object({
    kind: z.literal("temporary"),
    ref: temporaryReferenceSchema,
  })
  .strict();

const targetSchema = z.discriminatedUnion("kind", [
  existingTargetSchema,
  temporaryTargetSchema,
]);

const absentValueSchema = z
  .object({
    kind: z.literal("absent"),
  })
  .strict();

const dueValueSchema = z.discriminatedUnion("kind", [
  absentValueSchema,
  z
    .object({
      kind: z.literal("due_on"),
      due_on: dateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_at"),
      due_at: isoDateTimeSchema,
    })
    .strict(),
]);

const presentDueValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("due_on"),
      due_on: dateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("due_at"),
      due_at: isoDateTimeSchema,
    })
    .strict(),
]);

const evidenceKindSchema = z.enum([
  "user_message",
  "task",
  "obsidian",
  "external_tool",
]);

const evidenceReferenceSchema = z
  .object({
    kind: evidenceKindSchema,
    locator: nonBlankEvidenceTextSchema,
    excerpt: createUtf8ByteLimitedStringSchema(maximumEvidenceBytes).optional(),
  })
  .strict();

const userMessageEvidenceReferenceSchema = z
  .object({
    kind: z.literal("user_message"),
    locator: nonBlankEvidenceTextSchema,
    excerpt: createUtf8ByteLimitedStringSchema(maximumEvidenceBytes).optional(),
  })
  .strict();

const taskEvidenceReferenceSchema = z
  .object({
    kind: z.literal("task"),
    locator: nonBlankEvidenceTextSchema,
    excerpt: createUtf8ByteLimitedStringSchema(maximumEvidenceBytes).optional(),
  })
  .strict();

const obsidianEvidenceReferenceSchema = z
  .object({
    kind: z.literal("obsidian"),
    locator: nonBlankEvidenceTextSchema,
    excerpt: createUtf8ByteLimitedStringSchema(maximumEvidenceBytes).optional(),
  })
  .strict();

const externalToolEvidenceReferenceSchema = z
  .object({
    kind: z.literal("external_tool"),
    locator: nonBlankEvidenceTextSchema,
    excerpt: createUtf8ByteLimitedStringSchema(maximumEvidenceBytes).optional(),
  })
  .strict();

const taskOrNoteEvidenceReferenceSchema = z.discriminatedUnion("kind", [
  taskEvidenceReferenceSchema,
  obsidianEvidenceReferenceSchema,
]);

const evidenceReferencesSchema = z
  .array(evidenceReferenceSchema)
  .min(1)
  .max(maximumEvidenceReferences);

const statusEvidenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user_explicit"),
      reference: userMessageEvidenceReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("task_or_note_explicit"),
      reference: taskOrNoteEvidenceReferenceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("external_structured_status"),
      reference: externalToolEvidenceReferenceSchema,
      status: z.enum(["closed", "completed", "cancelled"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("children_only_all_completed"),
      reference: taskEvidenceReferenceSchema,
    })
    .strict(),
]);

const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);

const proposalDependencySchema = z
  .object({
    target: targetSchema,
    scope: dependencyScopeSchema,
    source: identifierSchema,
  })
  .strict();

const proposalDependenciesSchema = z
  .array(proposalDependencySchema)
  .max(maximumDependencyReferences)
  .superRefine((dependencies, context) => {
    const seen = new Set<string>();
    dependencies.forEach((dependency, index) => {
      const targetId = dependency.target.kind === "existing"
        ? dependency.target.gid
        : dependency.target.ref;
      const key = `${dependency.target.kind}\u0000${targetId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index, "target"],
          message: "同じ依存先を重複して指定できません。",
        });
        return;
      }
      seen.add(key);
    });
  });

const createTaskFieldsSchema = z
  .object({
    title: nonBlankTitleSchema,
    notes: taskNotesSchema.optional(),
    status: activeTaskStatusSchema.optional(),
    importance: importanceSchema.optional(),
    area: areaSchema.optional(),
    due: presentDueValueSchema.optional(),
    parent: targetSchema.optional(),
    parent_work_mode: parentWorkModeSchema.optional(),
    dependencies: proposalDependenciesSchema.optional(),
    obsidian_links: obsidianLinksSchema.optional(),
  })
  .strict();

const splitCreationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("single_task"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("split_child"),
      parent: targetSchema,
      instruction_reference: userMessageEvidenceReferenceSchema,
    })
    .strict(),
]);

const operationCommonShape = {
  operation_id: identifierSchema,
  baseline_snapshot_hash: snapshotHashSchema,
  reason: nonBlankReasonSchema,
  basis: z.enum(["explicit", "inferred"]),
  confidence: z.number().finite().min(0).max(1),
  evidence_refs: evidenceReferencesSchema,
};

const operationTargetShape = {
  ...operationCommonShape,
  target: targetSchema,
};

const createTaskOperationSchema = z
  .object({
    operation: z.literal("create_task"),
    ...operationCommonShape,
    temporary_ref: temporaryReferenceSchema,
    creation: splitCreationSchema,
    before: absentValueSchema,
    after: createTaskFieldsSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (operation.creation.kind === "split_child" && operation.basis !== "explicit") {
      context.addIssue({
        code: "custom",
        path: ["basis"],
        message: "分割作成は明示依頼として指定してください。",
      });
    }
    if (operation.creation.kind === "split_child" && operation.after.parent == null) {
      context.addIssue({
        code: "custom",
        path: ["after", "parent"],
        message: "分割作成には親タスクを指定してください。",
      });
    }
    if (operation.creation.kind === "single_task" && operation.after.parent != null) {
      context.addIssue({
        code: "custom",
        path: ["after", "parent"],
        message: "通常作成には親タスクを指定できません。",
      });
    }
    if (
      operation.creation.kind === "split_child"
      && operation.after.parent != null
      && !isSameTarget(operation.creation.parent, operation.after.parent)
    ) {
      context.addIssue({
        code: "custom",
        path: ["after", "parent"],
        message: "分割作成の親タスク指定が一致しません。",
      });
    }
  });

const updateTitleOperationSchema = z
  .object({
    operation: z.literal("update_title"),
    ...operationTargetShape,
    before: nonBlankTitleSchema,
    after: nonBlankTitleSchema,
  })
  .strict();

const updateNotesOperationSchema = z
  .object({
    operation: z.literal("update_notes"),
    ...operationTargetShape,
    before: taskNotesSchema,
    after: taskNotesSchema,
  })
  .strict();

const setStatusOperationSchema = z
  .object({
    operation: z.literal("set_status"),
    ...operationTargetShape,
    before: taskStatusSchema,
    after: activeTaskStatusSchema,
  })
  .strict();

const setImportanceOperationSchema = z
  .object({
    operation: z.literal("set_importance"),
    ...operationTargetShape,
    before: importanceSchema,
    after: importanceSchema,
  })
  .strict();

const setDueOperationSchema = z
  .object({
    operation: z.literal("set_due"),
    ...operationTargetShape,
    before: dueValueSchema,
    after: presentDueValueSchema,
  })
  .strict();

const clearDueOperationSchema = z
  .object({
    operation: z.literal("clear_due"),
    ...operationTargetShape,
    before: presentDueValueSchema,
    after: absentValueSchema,
  })
  .strict();

const setAreaOperationSchema = z
  .object({
    operation: z.literal("set_area"),
    ...operationTargetShape,
    before: areaSchema,
    after: areaSchema,
  })
  .strict();

const setDependenciesOperationSchema = z
  .object({
    operation: z.literal("set_dependencies"),
    ...operationTargetShape,
    before: proposalDependenciesSchema,
    after: proposalDependenciesSchema,
  })
  .strict();

const parentValueSchema = z.discriminatedUnion("kind", [
  absentValueSchema,
  existingTargetSchema,
  temporaryTargetSchema,
]);

const setParentOperationSchema = z
  .object({
    operation: z.literal("set_parent"),
    ...operationTargetShape,
    before: parentValueSchema,
    after: parentValueSchema,
  })
  .strict();

const setParentWorkModeOperationSchema = z
  .object({
    operation: z.literal("set_parent_work_mode"),
    ...operationTargetShape,
    before: parentWorkModeSchema,
    after: parentWorkModeSchema,
  })
  .strict();

const linkObsidianOperationSchema = z
  .object({
    operation: z.literal("link_obsidian"),
    ...operationTargetShape,
    before: absentValueSchema,
    after: obsidianLinkSchema,
  })
  .strict();

const unlinkObsidianOperationSchema = z
  .object({
    operation: z.literal("unlink_obsidian"),
    ...operationTargetShape,
    before: obsidianLinkSchema,
    after: absentValueSchema,
  })
  .strict();

const completeOperationSchema = z
  .object({
    operation: z.literal("complete"),
    ...operationTargetShape,
    basis: z.literal("explicit"),
    before: activeTaskStatusSchema,
    after: z.literal("completed"),
    status_evidence: statusEvidenceSchema,
  })
  .strict();

const withdrawOperationSchema = z
  .object({
    operation: z.literal("withdraw"),
    ...operationTargetShape,
    basis: z.literal("explicit"),
    before: activeTaskStatusSchema,
    after: z.literal("withdrawn"),
    status_evidence: statusEvidenceSchema,
  })
  .strict();

/** AI変更案で許可する操作を検証するスキーマです。 */
export const proposalOperationSchema = z.discriminatedUnion("operation", [
  createTaskOperationSchema,
  updateTitleOperationSchema,
  updateNotesOperationSchema,
  setStatusOperationSchema,
  setImportanceOperationSchema,
  setDueOperationSchema,
  clearDueOperationSchema,
  setAreaOperationSchema,
  setDependenciesOperationSchema,
  setParentOperationSchema,
  setParentWorkModeOperationSchema,
  linkObsidianOperationSchema,
  unlinkObsidianOperationSchema,
  completeOperationSchema,
  withdrawOperationSchema,
]);

type ProposalOperationValue = z.infer<typeof proposalOperationSchema>;
type ProposalTarget = z.infer<typeof targetSchema>;
type ProposalParentValue = z.infer<typeof parentValueSchema>;
type ProposalDependencies = z.infer<typeof proposalDependenciesSchema>;

function isSameTarget(left: ProposalTarget, right: ProposalTarget): boolean {
  if (left.kind === "existing" && right.kind === "existing") {
    return left.gid === right.gid;
  }
  if (left.kind === "temporary" && right.kind === "temporary") {
    return left.ref === right.ref;
  }
  return false;
}

function validateTargetReference(
  target: ProposalTarget,
  createdTemporaryRefs: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (
    target.kind === "temporary"
    && !createdTemporaryRefs.has(target.ref)
  ) {
    context.addIssue({
      code: "custom",
      path,
      message: "一時参照IDが同じ変更案内のcreate_taskへ解決できません。",
    });
  }
}

function validateParentValueReference(
  value: ProposalParentValue,
  createdTemporaryRefs: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (value.kind === "absent") {
    return;
  }
  validateTargetReference(value, createdTemporaryRefs, path, context);
}

function validateDependencyReferences(
  dependencies: ProposalDependencies,
  createdTemporaryRefs: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  dependencies.forEach((dependency, index) => {
    validateTargetReference(
      dependency.target,
      createdTemporaryRefs,
      [...path, index, "target"],
      context,
    );
  });
}

function validateOperationTemporaryTargets(
  operation: ProposalOperationValue,
  createdTemporaryRefs: ReadonlySet<string>,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") {
      validateTargetReference(
        operation.creation.parent,
        createdTemporaryRefs,
        [...path, "creation", "parent"],
        context,
      );
    }
    if (operation.after.parent != null) {
      validateTargetReference(
        operation.after.parent,
        createdTemporaryRefs,
        [...path, "after", "parent"],
        context,
      );
    }
    if (operation.after.dependencies != null) {
      validateDependencyReferences(
        operation.after.dependencies,
        createdTemporaryRefs,
        [...path, "after", "dependencies"],
        context,
      );
    }
    return;
  }

  validateTargetReference(
    operation.target,
    createdTemporaryRefs,
    [...path, "target"],
    context,
  );
  if (operation.operation === "set_dependencies") {
    validateDependencyReferences(
      operation.before,
      createdTemporaryRefs,
      [...path, "before"],
      context,
    );
    validateDependencyReferences(
      operation.after,
      createdTemporaryRefs,
      [...path, "after"],
      context,
    );
    return;
  }
  if (operation.operation === "set_parent") {
    validateParentValueReference(
      operation.before,
      createdTemporaryRefs,
      [...path, "before"],
      context,
    );
    validateParentValueReference(
      operation.after,
      createdTemporaryRefs,
      [...path, "after"],
      context,
    );
  }
}

const proposalGroupSchema = z
  .object({
    group_id: identifierSchema,
    atomic: z.boolean(),
    operations: z
      .array(proposalOperationSchema)
      .min(1)
      .max(maximumGroupOperations),
  })
  .strict();

/** AI変更案の操作群を検証するスキーマです。 */
export const proposalSchema = z
  .object({
    title: nonBlankTitleSchema,
    groups: z.array(proposalGroupSchema).min(1).max(maximumProposalGroups),
  })
  .strict()
  .superRefine((proposal, context) => {
    const groupIds = new Set<string>();
    const operationIds = new Set<string>();
    const temporaryRefs = new Set<string>();
    let operationCount = 0;
    proposal.groups.forEach((group, groupIndex) => {
      if (groupIds.has(group.group_id)) {
        context.addIssue({
          code: "custom",
          path: ["groups", groupIndex, "group_id"],
          message: "同じgroup_idを重複して指定できません。",
        });
      } else {
        groupIds.add(group.group_id);
      }
      operationCount += group.operations.length;
      group.operations.forEach((operation, operationIndex) => {
        if (operationIds.has(operation.operation_id)) {
          context.addIssue({
            code: "custom",
            path: ["groups", groupIndex, "operations", operationIndex, "operation_id"],
            message: "同じoperation_idを重複して指定できません。",
          });
        } else {
          operationIds.add(operation.operation_id);
        }
        if (operation.operation === "create_task") {
          if (temporaryRefs.has(operation.temporary_ref)) {
            context.addIssue({
              code: "custom",
              path: ["groups", groupIndex, "operations", operationIndex, "temporary_ref"],
              message: "同じ一時参照IDを重複して指定できません。",
            });
          } else {
            temporaryRefs.add(operation.temporary_ref);
          }
        }
      });
    });
    if (operationCount > maximumProposalOperations) {
      context.addIssue({
        code: "custom",
        path: ["groups"],
        message: `変更案全体の操作数は${maximumProposalOperations}件までです。`,
      });
    }
    proposal.groups.forEach((group, groupIndex) => {
      group.operations.forEach((operation, operationIndex) => {
        validateOperationTemporaryTargets(
          operation,
          temporaryRefs,
          ["groups", groupIndex, "operations", operationIndex],
          context,
        );
      });
    });
  });

const withdrawConfirmationSchema = z
  .object({
    target_task_gid: gidSchema,
    allowed_operation: z.literal("withdraw"),
  })
  .strict();

const questionSchema = z
  .object({
    question_id: identifierSchema,
    text: nonBlankQuestionSchema,
    options: z
      .array(nonBlankQuestionSchema)
      .min(2)
      .max(8)
      .optional(),
    withdraw_confirmation: withdrawConfirmationSchema.optional(),
  })
  .strict();

const questionsSchema = z
  .array(questionSchema)
  .max(maximumQuestions)
  .superRefine((questions, context) => {
    const seen = new Set<string>();
    questions.forEach((question, index) => {
      if (seen.has(question.question_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "question_id"],
          message: "同じquestion_idを重複して指定できません。",
        });
        return;
      }
      seen.add(question.question_id);
    });
  });

const messageSchema = createUtf8ByteLimitedStringSchema(
  maximumMessageBytes,
).refine((value) => value.trim().length > 0, {
  message: "messageを空にできません。",
});

const proposalResponseSchema = z
  .object({
    kind: z.literal("proposal"),
    message: messageSchema,
    questions: questionsSchema,
    proposal: proposalSchema,
  })
  .strict();

const noProposalResponseSchema = z
  .object({
    kind: z.literal("no_proposal"),
    message: messageSchema,
    questions: questionsSchema,
  })
  .strict();

/** Codexの構造化出力を検証するスキーマです。 */
export const codexResponseSchema = z.discriminatedUnion("kind", [
  proposalResponseSchema,
  noProposalResponseSchema,
]);

export type ProposalOperation = z.infer<typeof proposalOperationSchema>;
export type Proposal = z.infer<typeof proposalSchema>;
export type ProposalGroup = z.infer<typeof proposalGroupSchema>;
export type CodexResponse = z.infer<typeof codexResponseSchema>;
