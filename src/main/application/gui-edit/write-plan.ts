import { proposalWriteOperationSchema } from "../../domain/proposal-write-operation";
import { createTaskWritePlan, type TaskWritePayloadFingerprint, type TaskWritePlan } from "../common/task-write-plan";
import { taskWriteExternalBaselineSchema, type TaskWriteStepDraft } from "../common/task-write-step";
import { planProposalOperation } from "../common/task-write-operation-manifest";
import { buildProposalOperation } from "./build-proposal-operation";
import type { GuiExternalBaseline } from "./external-baseline";

type PlanningInput = Parameters<typeof buildProposalOperation>[0];
export type GuiEditOperation = Parameters<typeof buildProposalOperation>[3] | { readonly kind: "mark_activity" };

export type GuiEditInput = PlanningInput & {
  readonly workspace_gid: string;
  readonly device_id: string;
  readonly created_via: string;
  readonly activity_date: string;
  readonly baseline_task: PlanningInput["baseline_task"] & {
    readonly gid: string;
    readonly external: { readonly gid: string; readonly data: string } | null;
  };
  readonly operation: GuiEditOperation;
};

function planWithSynchronization(
  input: GuiEditInput,
  executionId: string,
  operationId: string,
  steps: readonly TaskWriteStepDraft[],
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  return createTaskWritePlan({
    execution_id: executionId,
    origin: "gui-edit",
    gui_context: { operation_id: operationId, task_gid: input.task_gid, project_gid: input.project_gid },
    known_references: [],
    steps: [...steps, {
      kind: "local_synchronize",
      step_id: `${executionId}:sync`,
      scope: { kind: "execution" },
      payload: { targets: [{ kind: "existing", gid: input.task_gid }], condition: "writer_result_available" },
    }],
  }, fingerprint);
}

/** GUI編集の通常操作を共通の保存用planへ変換します。 */
export function planGuiEditOperation(
  input: GuiEditInput,
  executionId: string,
  operationId: string,
  external: Extract<GuiExternalBaseline, { readonly kind: "valid" }> | undefined,
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  if (input.operation.kind === "mark_activity") {
    throw new Error("活動記録は通常操作として計画できません。");
  }
  const operation = buildProposalOperation(
    input,
    operationId,
    external?.baseline.data,
    input.operation,
    (value) => proposalWriteOperationSchema.parse(value),
  );
  if (operation.operation === "create_task") throw new Error("GUI編集で作成操作を計画できません。");
  const externalBaseline = external == null ? undefined
    : taskWriteExternalBaselineSchema.parse(external.baseline);
  const activityDate = external == null || external.baseline.data.activity_anchor_on <= input.activity_date
    ? input.activity_date
    : external.baseline.data.activity_anchor_on;
  const context = {
    project_gid: input.project_gid,
    workspace_gid: input.workspace_gid,
    section_gids: input.section_gids,
    device_id: input.device_id,
    created_via: input.created_via,
    activity_date: activityDate,
    ...(externalBaseline == null ? {} : { external_baseline: externalBaseline }),
  };
  const steps: TaskWriteStepDraft[] = [{
    kind: "proposal_operation_check",
    step_id: `${operationId}:check`,
    scope: { kind: "operation", operation_id: operationId },
    payload: {
      operation,
      project_gid: input.project_gid,
      workspace_gid: input.workspace_gid,
      section_gids: input.section_gids,
      activity_date: activityDate,
      ...(externalBaseline == null ? {} : { external_baseline: externalBaseline }),
    },
  }, ...planProposalOperation(operation, context)];
  return planWithSynchronization(input, executionId, operationId, steps, fingerprint);
}

/** GUI編集の活動日更新を独立したAsana stepへ変換します。 */
export function planGuiActivity(
  input: GuiEditInput,
  executionId: string,
  operationId: string,
  external: Extract<GuiExternalBaseline, { readonly kind: "valid" }>,
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  const steps: TaskWriteStepDraft[] = external.baseline.data.activity_anchor_on >= input.activity_date
    ? []
    : [{
      kind: "asana_merge_external_data",
      step_id: `${operationId}:1`,
      scope: { kind: "operation", operation_id: operationId },
      payload: {
        target: { kind: "existing", gid: input.task_gid },
        baseline: external.baseline,
        changes: [{ kind: "activity_anchor_on", after: input.activity_date }],
        device_id: input.device_id,
      },
    }];
  return planWithSynchronization(input, executionId, operationId, steps, fingerprint);
}

/** GUI編集の状態修復stepを共通の保存用planへまとめます。 */
export function planGuiRepair(
  input: GuiEditInput,
  executionId: string,
  operationId: string,
  steps: readonly TaskWriteStepDraft[],
  fingerprint: TaskWritePayloadFingerprint,
): TaskWritePlan {
  return planWithSynchronization(input, executionId, operationId, steps, fingerprint);
}
