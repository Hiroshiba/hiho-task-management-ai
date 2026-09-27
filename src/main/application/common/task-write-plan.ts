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
  type TaskWriteTarget,
} from "./task-write-step";

function referencedTargets(step: TaskWriteStep): readonly TaskWriteTarget[] {
  switch (step.kind) {
    case "asana_create_task":
      return step.payload.initial_external.dependencies.map((dependency) => dependency.target);
    case "asana_update_task":
    case "asana_add_to_section":
    case "asana_clear_parent":
      return [step.payload.target];
    case "asana_add_tag":
      return [step.payload.tag.target];
    case "asana_remove_tag":
      return [step.payload.tag.target, step.payload.replacement.target];
    case "asana_set_parent":
      return [step.payload.target, step.payload.parent];
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
  known_references: z.array(z.object({
    temporary_ref: identifierSchema,
    task_gid: gidSchema,
  }).strict()),
  steps: z.array(taskWriteStepSchema).min(1),
}).strict().superRefine((plan, context) => {
  const stepIds = new Set<string>();
  const temporaryRefs = new Set<string>();
  const taskGids = new Set<string>();
  const createdRefs = new Map<string, string>();
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
    if (step.kind === "asana_create_task") {
      const temporaryRef = step.payload.target.ref;
      if (temporaryRefs.has(temporaryRef)) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "target"], message: "作成タスクの一時参照が重複しています。" });
      }
      temporaryRefs.add(temporaryRef);
      if (step.scope.kind === "operation") createdRefs.set(temporaryRef, step.scope.operation_id);
    }
    for (const target of referencedTargets(step)) {
      if (target.kind === "temporary" && !temporaryRefs.has(target.ref)) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload"], message: "未作成の一時参照は書き込みstepに使用できません。" });
      }
    }
    if (step.kind === "asana_merge_external_data" && step.payload.baseline.kind === "created_task") {
      const baseline = step.payload.baseline;
      if (step.payload.target.kind !== "temporary"
        || step.payload.target.ref !== baseline.temporary_ref
        || createdRefs.get(baseline.temporary_ref) !== baseline.create_operation_id) {
        context.addIssue({ code: "custom", path: ["steps", index, "payload", "baseline"], message: "作成時の外部データ基準が作成stepと一致しません。" });
      }
    }
  }
  if (synchronizationCount !== 1) {
    context.addIssue({ code: "custom", path: ["steps"], message: "後続同期stepを1件だけ指定してください。" });
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
  if (kind === "local_synchronize") {
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

/** 保存済みplanを検証し、payloadのfingerprintを照合します。 */
export function parseTaskWritePlan(
  value: unknown,
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  if (!isTaskWriteJsonValue(value)) {
    throw new TypeError("write planはJSON値で指定してください。");
  }
  const plan = taskWritePlanSchema.parse(value);
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
  return parseTaskWritePlan({
    format_version: 1,
    execution_id: input.execution_id,
    origin: input.origin,
    known_references: input.known_references,
    steps,
  }, fingerprint);
}
