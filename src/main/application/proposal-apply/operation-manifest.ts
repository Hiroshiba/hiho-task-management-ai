import { z } from "zod";
import {
  canonicalizeTaskWriteJson,
  dateSchema,
  gidSchema,
  identifierSchema,
  importanceTagNameSchema,
  areaTagNameSchema,
} from "../../domain/task-write-values";
import { proposalWriteOperationSchema, type ProposalWriteOperation } from "../../domain/proposal-write-operation";
import {
  type TaskWriteExternalBaseline,
  type TaskWriteExternalChange,
  type TaskWriteStepDraft,
  type TaskWriteTarget,
  taskWriteExternalBaselineSchema,
} from "../common/task-write-step";

type OperationKind = ProposalWriteOperation["operation"];
type OperationEffect = TaskWriteStepDraft extends infer T
  ? T extends { readonly kind: "local_synchronize" }
    ? never
    : T extends TaskWriteStepDraft
      ? Pick<T, "kind" | "payload">
      : never
  : never;

const sectionGidsSchema = z.object({
  not_started: gidSchema,
  in_progress: gidSchema,
  completed: gidSchema,
  withdrawn: gidSchema,
}).strict();

const contextSchema = z.object({
  project_gid: gidSchema,
  workspace_gid: gidSchema,
  section_gids: sectionGidsSchema,
  activity_date: dateSchema,
  device_id: identifierSchema,
  created_via: identifierSchema,
  create_uuid: z.uuid().optional(),
  external_baseline: taskWriteExternalBaselineSchema.optional(),
}).strict();

export type ProposalOperationPlanningContext = z.infer<typeof contextSchema>;

function requireOperation<K extends OperationKind>(
  operation: ProposalWriteOperation,
  kind: K,
): Extract<ProposalWriteOperation, { readonly operation: K }> {
  if (!isOperation(operation, kind)) {
    throw new Error("変更案の操作とhandlerが一致しません。");
  }
  return operation;
}

function isOperation<K extends OperationKind>(
  operation: ProposalWriteOperation,
  kind: K,
): operation is Extract<ProposalWriteOperation, { readonly operation: K }> {
  return operation.operation === kind;
}

function requireExternalBaseline(context: ProposalOperationPlanningContext): TaskWriteExternalBaseline {
  if (context.external_baseline == null) {
    throw new Error("Custom external dataの承認時baselineがありません。");
  }
  return context.external_baseline;
}

function externalEffect(
  target: TaskWriteTarget,
  context: ProposalOperationPlanningContext,
  changes: readonly TaskWriteExternalChange[],
): OperationEffect {
  return {
    kind: "asana_merge_external_data",
    payload: {
      target,
      baseline: requireExternalBaseline(context),
      changes: [...changes],
      device_id: context.device_id,
    },
  };
}

function activityChange(context: ProposalOperationPlanningContext): TaskWriteExternalChange {
  return { kind: "activity_anchor_on", after: context.activity_date };
}

function compareCollections(left: readonly unknown[], right: readonly unknown[]): boolean {
  const orderedLeft = left.map(canonicalizeTaskWriteJson).sort();
  const orderedRight = right.map(canonicalizeTaskWriteJson).sort();
  return canonicalizeTaskWriteJson(orderedLeft) === canonicalizeTaskWriteJson(orderedRight);
}

function statusCompleted(status: "not_started" | "in_progress" | "completed" | "withdrawn"): boolean {
  return status === "completed" || status === "withdrawn";
}

function statusEffects(
  target: TaskWriteTarget,
  before: "not_started" | "in_progress" | "completed" | "withdrawn",
  after: "not_started" | "in_progress" | "completed" | "withdrawn",
  context: ProposalOperationPlanningContext,
): readonly OperationEffect[] {
  if (before === after) {
    return [];
  }
  const effects: OperationEffect[] = [{
    kind: "asana_add_to_section",
    payload: {
      target,
      before_section_gid: context.section_gids[before],
      after_section_gid: context.section_gids[after],
    },
  }];
  if (statusCompleted(before) !== statusCompleted(after)) {
    effects.push({
      kind: "asana_update_task",
      payload: { target, update: { kind: "completed", before: statusCompleted(before), after: statusCompleted(after) } },
    });
  }
  return effects;
}

function categoryEffects(
  target: TaskWriteTarget,
  category: "importance" | "area",
  beforeName: string,
  afterName: string,
  defaultBefore: boolean,
  context: ProposalOperationPlanningContext,
): readonly OperationEffect[] {
  const before = category === "importance"
    ? { category, target, workspace_gid: context.workspace_gid, tag_name: importanceTagNameSchema.parse(beforeName) }
    : { category, target, workspace_gid: context.workspace_gid, tag_name: areaTagNameSchema.parse(beforeName) };
  const after = category === "importance"
    ? { category, target, workspace_gid: context.workspace_gid, tag_name: importanceTagNameSchema.parse(afterName) }
    : { category, target, workspace_gid: context.workspace_gid, tag_name: areaTagNameSchema.parse(afterName) };
  return [
    {
      kind: "asana_add_tag",
      payload: {
        tag: after,
        expected_before: defaultBefore
          ? { kind: "named_or_absent", tag_name: before.tag_name }
          : { kind: "named", tag_name: before.tag_name },
      },
    },
    { kind: "asana_remove_tag", payload: { tag: before, replacement: after, condition: "if_present" } },
  ];
}

function createTaskEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const create = requireOperation(operation, "create_task");
  if (context.create_uuid == null) {
    throw new Error("create_taskの事前発行UUIDがありません。");
  }
  const target: TaskWriteTarget = { kind: "temporary", ref: create.temporary_ref };
  const status = create.after.status ?? "not_started";
  const effects: OperationEffect[] = [{
    kind: "asana_create_task",
    payload: {
      target,
      create_uuid: context.create_uuid,
      project_gid: context.project_gid,
      section_gid: context.section_gids[status],
      title: create.after.title,
      ...(create.after.notes == null ? {} : { notes: create.after.notes }),
      ...(create.after.due == null ? {} : { due: create.after.due }),
      initial_external: {
        activity_date: context.activity_date,
        last_active_status: status,
        device_id: context.device_id,
        created_via: context.created_via,
        ...(create.after.duration == null ? {} : { duration: create.after.duration }),
        dependencies: create.after.dependencies ?? [],
        parent_work_mode: create.after.parent_work_mode ?? "unknown",
        obsidian_links: create.after.obsidian_links ?? [],
      },
    },
  }];
  effects.push({
    kind: "asana_add_tag",
    payload: {
      tag: {
        category: "importance", target, workspace_gid: context.workspace_gid,
        tag_name: importanceTagNameSchema.parse(`TaskHub/重要度/${create.after.importance ?? 3}`),
      },
      expected_before: { kind: "absent" },
    },
  });
  effects.push({
    kind: "asana_add_tag",
    payload: {
      tag: {
        category: "area", target, workspace_gid: context.workspace_gid,
        tag_name: areaTagNameSchema.parse(`TaskHub/領域/${create.after.area ?? "未分類"}`),
      },
      expected_before: { kind: "absent" },
    },
  });
  if (create.after.parent != null) {
    effects.push({ kind: "asana_set_parent", payload: { target, expected_before: { kind: "absent" }, parent: create.after.parent } });
  }
  return effects;
}

function updateTitleEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "update_title");
  requireExternalBaseline(context);
  return update.before === update.after ? [] : [
    { kind: "asana_update_task", payload: { target: update.target, update: { kind: "title", before: update.before, after: update.after } } },
    externalEffect(update.target, context, [activityChange(context)]),
  ];
}

function updateNotesEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "update_notes");
  requireExternalBaseline(context);
  return update.before === update.after ? [] : [
    { kind: "asana_update_task", payload: { target: update.target, update: { kind: "notes", before: update.before, after: update.after } } },
    externalEffect(update.target, context, [activityChange(context)]),
  ];
}

function setStatusEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "set_status");
  requireExternalBaseline(context);
  if (update.before === update.after) {
    return [];
  }
  const changes: TaskWriteExternalChange[] = [{ kind: "last_active_status", after: update.after }];
  if (statusCompleted(update.before)) {
    changes.push(activityChange(context));
  }
  return [
    ...statusEffects(update.target, update.before, update.after, context),
    externalEffect(update.target, context, changes),
  ];
}

function setImportanceEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "set_importance");
  requireExternalBaseline(context);
  return update.before === update.after ? [] : [
    ...categoryEffects(update.target, "importance", `TaskHub/重要度/${update.before}`, `TaskHub/重要度/${update.after}`, update.before === 3, context),
    externalEffect(update.target, context, [activityChange(context)]),
  ];
}

function setAreaEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "set_area");
  requireExternalBaseline(context);
  return update.before === update.after ? [] : [
    ...categoryEffects(update.target, "area", `TaskHub/領域/${update.before}`, `TaskHub/領域/${update.after}`, update.before === "未分類", context),
    externalEffect(update.target, context, [activityChange(context)]),
  ];
}

function dueEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  if (operation.operation === "set_due") {
    const update = requireOperation(operation, "set_due");
    requireExternalBaseline(context);
    if (canonicalizeTaskWriteJson(update.before) === canonicalizeTaskWriteJson(update.after)) {
      return [];
    }
    const native: Extract<TaskWriteStepDraft, { readonly kind: "asana_update_task" }>["payload"]["update"] = update.after.kind === "due_on"
      ? { kind: "due_on", before: update.before, after: update.after.due_on }
      : { kind: "due_at", before: update.before, after: update.after.due_at };
    return [
      { kind: "asana_update_task", payload: { target: update.target, update: native } },
      externalEffect(update.target, context, [activityChange(context)]),
    ];
  }
  const update = requireOperation(operation, "clear_due");
  requireExternalBaseline(context);
  return [
    { kind: "asana_update_task", payload: { target: update.target, update: { kind: "clear_due", before: update.before } } },
    externalEffect(update.target, context, [activityChange(context)]),
  ];
}

function durationEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  if (operation.operation === "set_duration") {
    const update = requireOperation(operation, "set_duration");
    requireExternalBaseline(context);
    return canonicalizeTaskWriteJson(update.before) === canonicalizeTaskWriteJson(update.after)
      ? []
      : [externalEffect(update.target, context, [{ kind: "duration", before: update.before, after: update.after }])];
  }
  const update = requireOperation(operation, "clear_duration");
  requireExternalBaseline(context);
  return [externalEffect(update.target, context, [{ kind: "duration", before: update.before, after: { kind: "absent" } }])];
}

function dependenciesEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "set_dependencies");
  requireExternalBaseline(context);
  return compareCollections(update.before, update.after) ? [] : [externalEffect(update.target, context, [
    { kind: "dependencies", before: [...update.before], after: [...update.after] },
    activityChange(context),
  ])];
}

function parentEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "set_parent");
  requireExternalBaseline(context);
  if (canonicalizeTaskWriteJson(update.before) === canonicalizeTaskWriteJson(update.after)) {
    return [];
  }
  const native: OperationEffect = update.after.kind === "absent"
    ? { kind: "asana_clear_parent", payload: { target: update.target, expected_before: update.before } }
    : { kind: "asana_set_parent", payload: { target: update.target, expected_before: update.before, parent: update.after } };
  return [native, externalEffect(update.target, context, [activityChange(context)])];
}

function parentWorkModeEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  const update = requireOperation(operation, "set_parent_work_mode");
  requireExternalBaseline(context);
  return update.before === update.after ? [] : [externalEffect(update.target, context, [
    { kind: "parent_work_mode", before: update.before, after: update.after },
    activityChange(context),
  ])];
}

function obsidianEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  if (operation.operation === "link_obsidian") {
    const update = requireOperation(operation, "link_obsidian");
    return [externalEffect(update.target, context, [{ kind: "obsidian_links", action: "add", link: update.after }])];
  }
  const update = requireOperation(operation, "unlink_obsidian");
  return [externalEffect(update.target, context, [{ kind: "obsidian_links", action: "remove", link: update.before }])];
}

function terminalEffects(operation: ProposalWriteOperation, context: ProposalOperationPlanningContext): readonly OperationEffect[] {
  if (operation.operation === "complete") {
    const update = requireOperation(operation, "complete");
    return statusEffects(update.target, update.before, update.after, context);
  }
  const update = requireOperation(operation, "withdraw");
  return statusEffects(update.target, update.before, update.after, context);
}

type OperationHandler = (
  operation: ProposalWriteOperation,
  context: ProposalOperationPlanningContext,
) => readonly OperationEffect[];

/** 17操作を保存用stepへ変換するhandlerを一意に登録します。 */
export const operationManifest = {
  create_task: createTaskEffects,
  update_title: updateTitleEffects,
  update_notes: updateNotesEffects,
  set_status: setStatusEffects,
  set_importance: setImportanceEffects,
  set_due: dueEffects,
  clear_due: dueEffects,
  set_duration: durationEffects,
  clear_duration: durationEffects,
  set_area: setAreaEffects,
  set_dependencies: dependenciesEffects,
  set_parent: parentEffects,
  set_parent_work_mode: parentWorkModeEffects,
  link_obsidian: obsidianEffects,
  unlink_obsidian: obsidianEffects,
  complete: terminalEffects,
  withdraw: terminalEffects,
} satisfies Record<OperationKind, OperationHandler>;

/** 単一操作の外部call順を保存可能なstepへ変換します。 */
export function planProposalOperation(
  operation: ProposalWriteOperation,
  context: ProposalOperationPlanningContext,
): readonly TaskWriteStepDraft[] {
  const validatedOperation = proposalWriteOperationSchema.parse(operation);
  const validatedContext = contextSchema.parse(context);
  const effects = operationManifest[validatedOperation.operation](validatedOperation, validatedContext);
  return effects.map((effect, index) => ({
    step_id: `${validatedOperation.operation_id}:${index + 1}`,
    scope: { kind: "operation", operation_id: validatedOperation.operation_id },
    ...effect,
  }));
}
