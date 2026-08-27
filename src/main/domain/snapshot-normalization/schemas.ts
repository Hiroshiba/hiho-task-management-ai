import { z } from "zod";
import {
  asanaTaskResponseSchema,
  blockStateSchema,
  cleanupItemSchema,
  cleanupItemsSchema,
  dateSchema,
  dependencyScopeSchema,
  gidSchema,
  tagNameSchema,
  taskSchema,
  taskStatusSchema,
} from "../../../shared/domain";

const activeTaskStatusSchema = z.enum(["not_started", "in_progress"]);

const statusSectionConfigurationSchema = z
  .object({
    not_started: gidSchema,
    in_progress: gidSchema,
    completed: gidSchema,
    withdrawn: gidSchema,
  })
  .strict()
  .superRefine((sections, context) => {
    const seen = new Set<string>();
    for (const [name, gid] of Object.entries(sections)) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "4つの状態セクションGIDはすべて異なる値で指定してください。",
        });
        continue;
      }
      seen.add(gid);
    }
  });

const uniqueGidArraySchema = z.array(gidSchema).superRefine((gids, context) => {
  const seen = new Set<string>();
  for (const [index, gid] of gids.entries()) {
    if (seen.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [index],
        message: "同じGIDを重複して指定できません。",
      });
      continue;
    }
    seen.add(gid);
  }
});

const sortedUniqueGidArraySchema = z
  .array(gidSchema)
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const [index, gid] of gids.entries()) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じGIDを重複して指定できません。",
        });
      } else {
        seen.add(gid);
      }
      if (previous != null && previous >= gid) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "GID順に並べて指定してください。",
        });
      }
      previous = gid;
    }
  });

const statusMoveSectionSchema = z
  .object({
    kind: z.literal("move_section"),
    section_gid: gidSchema,
    status: taskStatusSchema,
  })
  .strict();

const statusSetCompletedSchema = z
  .object({
    kind: z.literal("set_completed"),
    completed: z.boolean(),
  })
  .strict();

const statusWriteSchema = z.discriminatedUnion("kind", [
  statusMoveSectionSchema,
  statusSetCompletedSchema,
]);

const lastActiveStatusUpdateSchema = z
  .object({
    kind: z.literal("set"),
    value: activeTaskStatusSchema,
  })
  .strict();

const statusNotificationSchema = z
  .object({
    kind: z.literal("status_reconciled"),
    message: z.string(),
    status: taskStatusSchema,
  })
  .strict();

const reconciledStatusPlanSchema = z
  .object({
    kind: z.literal("reconciled"),
    task_gid: gidSchema,
    status: taskStatusSchema,
    section_gid: gidSchema,
    completed: z.boolean(),
    writes: z.array(statusWriteSchema),
    warnings: z.array(z.string()),
    notification: statusNotificationSchema.optional(),
  })
  .strict();

const cleanupStatusPlanSchema = z
  .object({
    kind: z.literal("requires_cleanup"),
    task_gid: gidSchema,
    section_gid: gidSchema,
    completed: z.boolean(),
    writes: z.array(z.never()),
    warnings: z.array(z.never()),
    cleanup_item: cleanupItemSchema,
  })
  .strict();

const invalidMembershipStatusPlanSchema = z
  .object({
    kind: z.literal("invalid_membership"),
    task_gid: gidSchema,
    status: taskStatusSchema,
    section_gid: gidSchema,
    completed: z.boolean(),
    writes: z.array(z.never()),
    warnings: z.array(z.never()),
    membership: z.enum(["missing", "multiple"]),
  })
  .strict();

const statusPlanSchema = z.discriminatedUnion("kind", [
  reconciledStatusPlanSchema,
  cleanupStatusPlanSchema,
  invalidMembershipStatusPlanSchema,
]);

const tagPlanSchema = z
  .object({
    task_gid: gidSchema,
    added_tag_names: z.array(tagNameSchema).superRefine((names, context) => {
      const seen = new Set<string>();
      for (const [index, name] of names.entries()) {
        if (seen.has(name)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じタグ名を重複して追加できません。",
          });
          continue;
        }
        seen.add(name);
      }
    }),
    removed_tag_gids: uniqueGidArraySchema,
  })
  .strict();

const blockReasonSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("dependency"),
      dependency_gid: gidSchema,
      scope: dependencyScopeSchema,
      cause: z.enum(["unfinished", "withdrawn", "missing", "inaccessible"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("parent"),
      parent_gid: gidSchema,
      child_gid: gidSchema,
      cause: z.enum(["unfinished", "withdrawn", "missing", "inaccessible"]),
    })
    .strict(),
  z
    .object({
      kind: z.enum(["dependency_cycle", "parent_cycle"]),
      task_gids: sortedUniqueGidArraySchema,
    })
    .strict(),
]);

const blockStateResultSchema = z
  .object({
    gid: gidSchema,
    block_state: blockStateSchema,
    reasons: z.array(blockReasonSchema),
    dependency_reasons: z.array(
      z
        .object({
          kind: z.literal("dependency"),
          dependency_gid: gidSchema,
          scope: dependencyScopeSchema,
          cause: z.enum([
            "unfinished",
            "withdrawn",
            "missing",
            "inaccessible",
          ]),
        })
        .strict(),
    ),
    parent_reasons: z.array(
      z
        .object({
          kind: z.literal("parent"),
          parent_gid: gidSchema,
          child_gid: gidSchema,
          cause: z.enum([
            "unfinished",
            "withdrawn",
            "missing",
            "inaccessible",
          ]),
        })
        .strict(),
    ),
    dependency_cycle: z.boolean(),
    parent_cycle: z.boolean(),
    completion_confirmation: z.boolean(),
  })
  .strict();

const graphResultSchema = z
  .object({
    tasks: z.array(blockStateResultSchema),
    cleanup_items: cleanupItemsSchema,
    dependency_cycles: z.array(sortedUniqueGidArraySchema),
    parent_cycles: z.array(sortedUniqueGidArraySchema),
  })
  .strict()
  .superRefine((graph, context) => {
    const taskGids = graph.tasks.map((task) => task.gid);
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const [index, gid] of taskGids.entries()) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "gid"],
          message: "同じタスクGIDを重複して指定できません。",
        });
      } else {
        seen.add(gid);
      }
      if (previous != null && previous >= gid) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "gid"],
          message: "タスクGID順に並べてください。",
        });
      }
      previous = gid;
    }
    const cycleGroups: readonly [string, readonly (readonly string[])[]][] = [
      ["dependency_cycles", graph.dependency_cycles],
      ["parent_cycles", graph.parent_cycles],
    ];
    for (const [name, cycles] of cycleGroups) {
      const seen = new Set<string>();
      let previousCycle: string | undefined;
      for (const [index, cycle] of cycles.entries()) {
        const key = cycle.join("\u0000");
        if (seen.has(key)) {
          context.addIssue({
            code: "custom",
            path: [name, index],
            message: "同じ循環を重複して指定できません。",
          });
        } else {
          seen.add(key);
        }
        if (previousCycle != null && previousCycle >= key) {
          context.addIssue({
            code: "custom",
            path: [name, index],
            message: "循環情報をGID順に並べてください。",
          });
        }
        previousCycle = key;
      }
    }
  });

const criticalErrorCodeSchema = z.enum([
  "project_membership_missing",
  "project_membership_multiple",
  "unknown_status_section",
  "custom_external_data_broken",
  "custom_external_data_unknown_schema",
  "custom_external_data_identity_mismatch",
  "dependency_cycle",
  "parent_cycle",
]);

const criticalErrorSchema = z
  .object({
    task_gid: gidSchema,
    code: criticalErrorCodeSchema,
  })
  .strict();

const externalDataInitializationRequestSchema = z
  .object({
    task_gid: gidSchema,
    last_active_status: activeTaskStatusSchema,
    activity_anchor_on: dateSchema,
    created_via: z.literal("asana"),
  })
  .strict();

const taskGidArrayResultSchema = z
  .array(gidSchema)
  .superRefine((gids, context) => {
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const [index, gid] of gids.entries()) {
      if (seen.has(gid)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じタスクGIDを重複して指定できません。",
        });
      } else {
        seen.add(gid);
      }
      if (previous != null && previous >= gid) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "タスクGID順に並べてください。",
        });
      }
      previous = gid;
    }
  });

const taskPlanArraySchema = z
  .array(statusPlanSchema)
  .superRefine((plans, context) => {
    const gids = plans.map((plan) => plan.task_gid);
    const parsed = taskGidArrayResultSchema.safeParse(gids);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["status_plans", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

const taggedPlanArraySchema = z
  .array(tagPlanSchema)
  .superRefine((plans, context) => {
    const gids = plans.map((plan) => plan.task_gid);
    const parsed = taskGidArrayResultSchema.safeParse(gids);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["tag_plans", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

const taskInitializationArraySchema = z
  .array(externalDataInitializationRequestSchema)
  .superRefine((requests, context) => {
    const gids = requests.map((request) => request.task_gid);
    const parsed = taskGidArrayResultSchema.safeParse(gids);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["initialization_requests", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

const lastActiveUpdateArraySchema = z
  .array(
    z
      .object({
        task_gid: gidSchema,
        update: lastActiveStatusUpdateSchema,
      })
      .strict(),
  )
  .superRefine((updates, context) => {
    const gids = updates.map((update) => update.task_gid);
    const parsed = taskGidArrayResultSchema.safeParse(gids);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["last_active_status_updates", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

const externalDataWritePlanSchema = z
  .object({
    initialization_requests: taskInitializationArraySchema,
    last_active_status_updates: lastActiveUpdateArraySchema,
  })
  .strict();

const criticalErrorArraySchema = z
  .array(criticalErrorSchema)
  .superRefine((errors, context) => {
    const seen = new Set<string>();
    let previous: string | undefined;
    for (const [index, error] of errors.entries()) {
      const key = `${error.task_gid}\u0000${error.code}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じ重大エラーを重複して指定できません。",
        });
      } else {
        seen.add(key);
      }
      if (previous != null && previous >= key) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "重大エラーをGIDとコード順に並べてください。",
        });
      }
      previous = key;
    }
  });

const taskArraySchema = z
  .array(taskSchema)
  .superRefine((tasks, context) => {
    const gids = tasks.map((task) => task.gid);
    const parsed = taskGidArrayResultSchema.safeParse(gids);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({
          code: "custom",
          path: ["tasks", ...issue.path],
          message: issue.message,
        });
      }
    }
  });

const inputArraySchema = z
  .array(asanaTaskResponseSchema)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (const [index, task] of tasks.entries()) {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "同じタスクGIDを重複して指定できません。",
        });
      } else {
        seen.add(task.gid);
      }
    }
  });

const previousTaskArraySchema = z
  .array(taskSchema)
  .superRefine((tasks, context) => {
    const seen = new Set<string>();
    for (const [index, task] of tasks.entries()) {
      if (seen.has(task.gid)) {
        context.addIssue({
          code: "custom",
          path: [index, "gid"],
          message: "同じ前回タスクGIDを重複して指定できません。",
        });
      } else {
        seen.add(task.gid);
      }
    }
  });

function addExactTaskSetIssue(
  expected: readonly string[],
  actual: readonly string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const sameSize = expectedSet.size === actualSet.size;
  const sameValues =
    sameSize && [...expectedSet].every((gid) => actualSet.has(gid));
  if (expected.length !== actual.length || !sameValues) {
    context.addIssue({
      code: "custom",
      path,
      message: "タスク計画のGID集合が正規化タスクと一致しません。",
    });
  }
}

function addTaskSubsetIssues(
  taskGids: ReadonlySet<string>,
  candidateGids: readonly string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  for (const [index, gid] of candidateGids.entries()) {
    if (!taskGids.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [...path, index, "task_gid"],
        message: "書込みまたは重大エラーのタスクGIDが正規化タスクにありません。",
      });
    }
  }
}

const inputSchema = z
  .object({
    project_gid: gidSchema,
    section_gids: statusSectionConfigurationSchema,
    tasks: inputArraySchema,
    previous_tasks: previousTaskArraySchema,
    inaccessible_gids: uniqueGidArraySchema,
  })
  .strict();

const resultSchema = z
  .object({
    tasks: taskArraySchema,
    status_plans: taskPlanArraySchema,
    external_data_writes: externalDataWritePlanSchema,
    tag_plans: taggedPlanArraySchema,
    graph: graphResultSchema,
    cleanup_items: cleanupItemsSchema,
    critical_errors: criticalErrorArraySchema,
  })
  .strict()
  .superRefine((result, context) => {
    const taskGids = result.tasks.map((task) => task.gid);
    const taskGidSet = new Set(taskGids);
    addExactTaskSetIssue(
      taskGids,
      result.status_plans.map((plan) => plan.task_gid),
      ["status_plans"],
      context,
    );
    addExactTaskSetIssue(
      taskGids,
      result.tag_plans.map((plan) => plan.task_gid),
      ["tag_plans"],
      context,
    );
    addExactTaskSetIssue(
      taskGids,
      result.graph.tasks.map((task) => task.gid),
      ["graph", "tasks"],
      context,
    );
    const initializationGids = result.external_data_writes.initialization_requests.map(
      (request) => request.task_gid,
    );
    const lastActiveGids = result.external_data_writes.last_active_status_updates.map(
      (update) => update.task_gid,
    );
    addTaskSubsetIssues(
      taskGidSet,
      initializationGids,
      ["external_data_writes", "initialization_requests"],
      context,
    );
    addTaskSubsetIssues(
      taskGidSet,
      lastActiveGids,
      ["external_data_writes", "last_active_status_updates"],
      context,
    );
    addTaskSubsetIssues(taskGidSet, result.critical_errors.map((error) => error.task_gid), ["critical_errors"], context);
    const initializationSet = new Set(initializationGids);
    for (const [index, gid] of lastActiveGids.entries()) {
      if (initializationSet.has(gid)) {
        context.addIssue({
          code: "custom",
          path: ["external_data_writes", "last_active_status_updates", index, "task_gid"],
          message: "同じタスクへ初期化要求とlast_active_status更新を同時に指定できません。",
        });
      }
    }
  });

export type SnapshotNormalizationInput = z.infer<typeof inputSchema>;
export type SnapshotNormalizationResult = z.infer<typeof resultSchema>;
export type SnapshotStatusPlan = z.infer<typeof statusPlanSchema>;
export type SnapshotTagPlan = z.infer<typeof tagPlanSchema>;
export type SnapshotCriticalError = z.infer<typeof criticalErrorSchema>;
export type SnapshotGraphResult = z.infer<typeof graphResultSchema>;
export type SnapshotExternalDataInitializationRequest = z.infer<
  typeof externalDataInitializationRequestSchema
>;
export type SnapshotExternalDataWritePlan = z.infer<
  typeof externalDataWritePlanSchema
>;

/** Asanaスナップショット正規化の入力を検証するスキーマです。 */
export const asanaSnapshotNormalizationInputSchema = inputSchema;

/** Asanaスナップショット正規化の結果を検証するスキーマです。 */
export const asanaSnapshotNormalizationResultSchema = resultSchema;
