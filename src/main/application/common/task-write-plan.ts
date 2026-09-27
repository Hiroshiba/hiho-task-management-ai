import { z } from "zod";
import {
  canonicalizeTaskWriteJson,
  gidSchema,
  identifierSchema,
  isTaskWriteJsonValue,
  isoDateTimeSchema,
  snapshotHashSchema,
} from "../../domain/task-write-values";
import {
  taskWriteStepSchema,
  type TaskWriteStep,
  type TaskWriteStepDraft,
  type TaskWriteExternalBaseline,
  type TaskWriteTarget,
} from "./task-write-step";
import { operationMatchesExternalBaseline } from "./task-write-operation-baseline";

function operationId(step: TaskWriteStep): string {
  if (step.scope.kind !== "operation") {
    throw new Error("作成stepの操作IDがありません。");
  }
  return step.scope.operation_id;
}

function operationReferencedTargets(step: Extract<TaskWriteStep, { kind: "proposal_operation_check" }>): readonly TaskWriteTarget[] {
  const operation = step.payload.operation;
  if (operation.operation === "set_dependencies") {
    return [operation.target, ...[...operation.before, ...operation.after].map((dependency) => dependency.target)];
  }
  if (operation.operation === "set_parent") {
    return [
      operation.target,
      ...(operation.before.kind === "absent" ? [] : [operation.before]),
      ...(operation.after.kind === "absent" ? [] : [operation.after]),
    ];
  }
  return [operation.target];
}

function referencedTargets(step: TaskWriteStep): readonly TaskWriteTarget[] {
  switch (step.kind) {
    case "proposal_operation_check":
      return operationReferencedTargets(step);
    case "asana_create_task":
      return step.payload.initial_external.dependencies.map((dependency) => dependency.target);
    case "asana_update_task":
    case "asana_add_to_project":
    case "asana_add_to_section":
      return [step.payload.target];
    case "asana_clear_parent":
      return [step.payload.target, ...(step.payload.expected_before.kind === "absent" ? [] : [step.payload.expected_before])];
    case "asana_add_tag":
      return [step.payload.tag.target];
    case "asana_remove_tag":
      return [step.payload.tag.target, step.payload.replacement.target];
    case "asana_set_parent":
      return [
        step.payload.target,
        step.payload.parent,
        ...(step.payload.expected_before.kind === "absent" ? [] : [step.payload.expected_before]),
      ];
    case "asana_merge_external_data":
      return [
        step.payload.target,
        ...step.payload.changes.flatMap((change) => change.kind === "dependencies"
          ? [...change.before, ...change.after].map((dependency) => dependency.target)
          : []),
      ];
    case "local_synchronize":
      return step.payload.targets;
  }
}

const taskWritePlanSchema = z.object({
  format_version: z.literal(1),
  execution_id: identifierSchema,
  origin: z.enum(["proposal", "gui-edit"]),
  gui_context: z.object({ operation_id: identifierSchema, task_gid: gidSchema, project_gid: gidSchema }).strict().optional(),
  plan_fingerprint: snapshotHashSchema,
  known_references: z.array(z.object({
    temporary_ref: identifierSchema,
    task_gid: gidSchema,
  }).strict()),
  steps: z.array(taskWriteStepSchema).min(1),
}).strict().superRefine((plan, context) => {
  if ((plan.origin === "gui-edit") !== (plan.gui_context != null)) {
    context.addIssue({ code: "custom", path: ["gui_context"], message: "GUI編集の保存文脈が実行元と一致しません。" });
  }
  const stepIds = new Set<string>();
  const temporaryRefs = new Set<string>();
  const taskGids = new Set<string>();
  const createdRefs = new Map<string, string>();
  const createPayloads = new Map<string, Extract<TaskWriteStep, { kind: "asana_create_task" }>["payload"]>();
  const checkedOperations = new Set<string>();
  const operationBaselines = new Map<string, TaskWriteExternalBaseline | undefined>();
  const createdOperations = new Set<string>();
  const closedOperations = new Set<string>();
  const knownReferences = new Map(plan.known_references.map((reference) => [reference.temporary_ref, reference.task_gid]));
  for (const [index, reference] of plan.known_references.entries()) {
    if (temporaryRefs.has(reference.temporary_ref) || taskGids.has(reference.task_gid)) {
      context.addIssue({
        code: "custom",
        path: ["known_references", index],
        message: "既知の一時参照またはタスクGIDが重複しています。",
      });
    }
    temporaryRefs.add(reference.temporary_ref);
    taskGids.add(reference.task_gid);
  }
  let synchronizationCount = 0;
  let currentOperationId: string | undefined;
  let nonCreateStarted = false;
  for (const [index, step] of plan.steps.entries()) {
    if (stepIds.has(step.step_id)) {
      context.addIssue({ code: "custom", path: ["steps", index, "step_id"], message: "step IDが重複しています。" });
    }
    stepIds.add(step.step_id);
    if (step.kind === "local_synchronize") {
      synchronizationCount += 1;
      if (step.scope.kind !== "execution" || index !== plan.steps.length - 1) {
        context.addIssue({ code: "custom", path: ["steps", index], message: "後続同期は実行全体の最後に置いてください。" });
      }
      if (step.payload.condition !== (plan.origin === "proposal" ? "verified_operation" : "writer_result_available")) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "condition"], message: "後続同期条件が実行元と一致しません。" });
      }
    } else if (step.scope.kind !== "operation") {
      context.addIssue({ code: "custom", path: ["steps", index, "scope"], message: "Asana stepには操作IDが必要です。" });
    }
    if (step.scope.kind === "operation") {
      const operationId = step.scope.operation_id;
      if (currentOperationId !== operationId) {
        if (currentOperationId != null) closedOperations.add(currentOperationId);
        currentOperationId = operationId;
      }
      if (closedOperations.has(operationId)) {
        context.addIssue({ code: "custom", path: ["steps", index, "scope"], message: "同じ操作のstepは連続して指定してください。" });
      }
    }
    if (step.kind === "proposal_operation_check") {
      nonCreateStarted = true;
      const operation = step.payload.operation;
      if (step.scope.kind !== "operation"
        || step.scope.operation_id !== operation.operation_id
        || checkedOperations.has(operation.operation_id) || createdOperations.has(operation.operation_id)) {
        context.addIssue({ code: "custom", path: ["steps", index], message: "非作成操作の照合stepと操作IDが一致しません。" });
      }
      checkedOperations.add(operation.operation_id);
      const baseline = step.payload.external_baseline;
      operationBaselines.set(operation.operation_id, baseline);
      if (operation.operation !== "complete" && operation.operation !== "withdraw" && baseline == null) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "external_baseline"], message: "承認時の外部データ基準がありません。" });
      }
      if (baseline != null) {
        const createOperationId = baseline.kind === "created_task" ? createdRefs.get(baseline.temporary_ref) : undefined;
        if (baseline.kind === "created_task" && (operation.target.kind !== "temporary" || operation.target.ref !== baseline.temporary_ref
          || createOperationId !== baseline.create_operation_id)) {
          context.addIssue({ code: "custom", path: ["steps", index, "payload", "external_baseline"], message: "作成時の外部データ基準が対象操作と一致しません。" });
        } else if (!operationMatchesExternalBaseline(
          operation,
          baseline,
          knownReferences,
          baseline.kind === "created_task" ? createPayloads.get(baseline.temporary_ref) : undefined,
        )) {
          context.addIssue({ code: "custom", path: ["steps", index, "payload", "external_baseline"], message: "操作の変更前値が承認時の外部データ基準と一致しません。" });
        }
      }
    }
    if (step.kind === "asana_create_task") {
      if (plan.origin === "gui-edit") {
        context.addIssue({ code: "custom", path: ["steps", index], message: "GUI編集でタスク作成stepを指定できません。" });
      }
      const temporaryRef = step.payload.target.ref;
      if (nonCreateStarted || step.scope.kind !== "operation" || checkedOperations.has(step.scope.operation_id)
        || createdOperations.has(step.scope.operation_id)) {
        context.addIssue({ code: "custom", path: ["steps", index], message: "作成stepは作成操作の先頭に置いてください。" });
      }
      if (temporaryRefs.has(temporaryRef)) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "target"], message: "作成タスクの一時参照が重複しています。" });
      }
    } else if (step.kind !== "local_synchronize" && step.kind !== "proposal_operation_check"
      && plan.origin === "proposal" && step.scope.kind === "operation"
      && !checkedOperations.has(step.scope.operation_id) && !createdOperations.has(step.scope.operation_id)) {
      context.addIssue({ code: "custom", path: ["steps", index, "scope"], message: "非作成操作の書き込み前に照合stepが必要です。" });
    }
    if (step.kind === "asana_set_parent"
      && step.payload.target.kind === "temporary"
      && step.payload.parent.kind === "temporary"
      && step.payload.target.ref === step.payload.parent.ref) {
      context.addIssue({ code: "custom", path: ["steps", index, "payload", "parent"], message: "タスク自身を親に指定できません。" });
    }
    for (const target of referencedTargets(step)) {
      if (target.kind === "temporary" && !temporaryRefs.has(target.ref)) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload"], message: "未作成の一時参照は書き込みstepに使用できません。" });
      }
    }
    if (step.kind === "asana_create_task" && step.scope.kind === "operation") {
      temporaryRefs.add(step.payload.target.ref);
      createdRefs.set(step.payload.target.ref, step.scope.operation_id);
      createPayloads.set(step.payload.target.ref, step.payload);
      createdOperations.add(step.scope.operation_id);
    }
    if (step.kind === "asana_merge_external_data" && step.payload.baseline.kind === "created_task") {
      const baseline = step.payload.baseline;
      if (step.payload.target.kind !== "temporary"
        || step.payload.target.ref !== baseline.temporary_ref
        || createdRefs.get(baseline.temporary_ref) !== baseline.create_operation_id) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "baseline"], message: "作成時の外部データ基準が作成stepと一致しません。" });
      }
    }
    if (step.kind === "asana_merge_external_data" && plan.origin === "proposal" && step.scope.kind === "operation") {
      const operationBaseline = operationBaselines.get(step.scope.operation_id);
      if (operationBaseline == null
        || canonicalizeTaskWriteJson(operationBaseline) !== canonicalizeTaskWriteJson(step.payload.baseline)) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "baseline"], message: "外部データ更新の基準が操作の承認時基準と一致しません。" });
      }
    }
  }
  if (synchronizationCount !== 1) {
    context.addIssue({ code: "custom", path: ["steps"], message: "後続同期stepを1件だけ指定してください。" });
  }
  if (plan.origin === "proposal" && checkedOperations.size + createdOperations.size === 0) {
    context.addIssue({ code: "custom", path: ["steps"], message: "変更案には操作の作成または照合stepが必要です。" });
  }
  if (plan.origin === "gui-edit" && plan.gui_context != null && plan.steps.some((step) =>
    step.scope.kind === "operation" && step.scope.operation_id !== plan.gui_context?.operation_id)) {
    context.addIssue({ code: "custom", path: ["steps"], message: "GUI編集の操作IDが保存文脈と一致しません。" });
  }
  const createSteps = plan.steps.filter((step) => step.kind === "asana_create_task");
  const readyReferences = new Set(plan.known_references.map((reference) => reference.temporary_ref));
  for (const [index, step] of createSteps.entries()) {
    const readyOperationIds = createSteps.slice(index)
      .filter((candidate) => {
        const dependencies = plan.steps
          .filter((operationStep) => operationStep.scope.kind === "operation"
            && operationStep.scope.operation_id === operationId(candidate))
          .flatMap(referencedTargets)
          .filter((target): target is Extract<TaskWriteTarget, { kind: "temporary" }> =>
            target.kind === "temporary" && target.ref !== candidate.payload.target.ref);
        return dependencies.every((target) => readyReferences.has(target.ref));
      })
      .map(operationId)
      .sort();
    if (readyOperationIds.length > 0 && readyOperationIds[0] !== operationId(step)) {
      context.addIssue({ code: "custom", path: ["steps"], message: "作成操作の順序が一時参照の依存関係と操作ID順に一致しません。" });
    }
    readyReferences.add(step.payload.target.ref);
  }
});

const asanaReceiptShape = {
  step_id: identifierSchema,
  recorded_at: isoDateTimeSchema,
  planned_payload_fingerprint: snapshotHashSchema,
  applied_payload_fingerprint: snapshotHashSchema,
  observed_state_fingerprint: snapshotHashSchema,
};

/** 書き込みstepの読戻し済み結果を検証します。 */
export const taskWriteReceiptSchema = z.discriminatedUnion("kind", [
  z.object({
    ...asanaReceiptShape,
    kind: z.literal("created_task"),
    task_gid: gidSchema,
    temporary_ref: identifierSchema,
  }).strict(),
  z.object({
    ...asanaReceiptShape,
    kind: z.literal("asana_write"),
    task_gid: gidSchema,
    write_performed: z.boolean().optional(),
    verification_step_id: identifierSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("proposal_operation_check"),
    step_id: identifierSchema,
    recorded_at: isoDateTimeSchema,
    planned_payload_fingerprint: snapshotHashSchema,
    observed_state_fingerprint: snapshotHashSchema,
    task_gid: gidSchema,
    outcome: z.enum(["needs_write", "already_applied"]),
  }).strict(),
  z.object({
    kind: z.literal("local_synchronize"),
    step_id: identifierSchema,
    recorded_at: isoDateTimeSchema,
    planned_payload_fingerprint: snapshotHashSchema,
    task_gids: z.array(gidSchema).min(1),
  }).strict(),
]);

type DeepReadonly<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export type TaskWritePlan = DeepReadonly<z.infer<typeof taskWritePlanSchema>>;
export type TaskWriteReceipt = DeepReadonly<z.infer<typeof taskWriteReceiptSchema>>;
export type TaskWritePayloadFingerprint = (canonicalPayload: string) => string;

function retryClassForStep(kind: TaskWriteStep["kind"]): TaskWriteStep["retry_class"] {
  if (kind === "asana_create_task") {
    return "non_retryable";
  }
  if (kind === "local_synchronize" || kind === "proposal_operation_check") {
    return "idempotent";
  }
  return "read_back_verifiable";
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) {
      freezeValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** 保存済みplanを検証し、planとpayloadのfingerprintを照合します。 */
export function parseTaskWritePlan(
  value: unknown,
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  if (!isTaskWriteJsonValue(value)) {
    throw new TypeError("write planはJSON値で指定してください。");
  }
  const plan = taskWritePlanSchema.parse(value);
  const { plan_fingerprint: planFingerprint, ...planContents } = plan;
  const expectedPlanFingerprint = snapshotHashSchema.parse(fingerprint(canonicalizeTaskWriteJson(planContents)));
  if (expectedPlanFingerprint !== planFingerprint) {
    throw new Error("保存済みwrite planのfingerprintが一致しません。");
  }
  for (const step of plan.steps) {
    const expected = snapshotHashSchema.parse(fingerprint(canonicalizeTaskWriteJson(step.payload)));
    if (expected !== step.payload_fingerprint) {
      throw new Error("保存済みwrite stepのpayload fingerprintが一致しません。");
    }
    if (step.retry_class !== retryClassForStep(step.kind)) {
      throw new Error("write stepのretry classが種類と一致しません。");
    }
  }
  return freezeValue(plan);
}

/** 順序付きstepを検証してimmutableな保存用planを作ります。 */
export function createTaskWritePlan(
  input: {
    readonly execution_id: string;
    readonly origin: TaskWritePlan["origin"];
    readonly gui_context?: TaskWritePlan["gui_context"];
    readonly known_references: TaskWritePlan["known_references"];
    readonly steps: readonly TaskWriteStepDraft[];
  },
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  if (!isTaskWriteJsonValue(input)) {
    throw new TypeError("write planの入力はJSON値で指定してください。");
  }
  const steps = input.steps.map((draft) => taskWriteStepSchema.parse({
    ...draft,
    executor_version: 1,
    retry_class: retryClassForStep(draft.kind),
    payload_fingerprint: snapshotHashSchema.parse(fingerprint(canonicalizeTaskWriteJson(draft.payload))),
  }));
  const planContents = {
    format_version: 1,
    execution_id: input.execution_id,
    origin: input.origin,
    ...(input.gui_context == null ? {} : { gui_context: input.gui_context }),
    known_references: input.known_references,
    steps,
  };
  return parseTaskWritePlan({
    ...planContents,
    plan_fingerprint: snapshotHashSchema.parse(fingerprint(canonicalizeTaskWriteJson(planContents))),
  }, fingerprint);
}
