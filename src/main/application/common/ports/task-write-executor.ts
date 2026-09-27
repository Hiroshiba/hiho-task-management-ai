import type { TaskWriteStep } from "../task-write-step";
import type { TaskWritePlan } from "../task-write-plan";

export type TaskWriteExecutionContext = {
  readonly execution_id: string;
  readonly plan: TaskWritePlan;
  readonly references: ReadonlyMap<string, string>;
  readonly operation_task_gids: ReadonlyMap<string, string>;
  readonly operation_project_gids: ReadonlyMap<string, string>;
  readonly synchronization_task_gids: readonly string[];
};

type WritableStep = Exclude<TaskWriteStep, { readonly kind: "proposal_operation_check" }>;
type WritableKind = WritableStep["kind"];

export type TaskWriteSubmission<Step extends WritableStep> =
  Step extends { readonly kind: "asana_create_task" }
    ? { readonly kind: "created_task"; readonly task_gid: string }
    : Step extends { readonly kind: "local_synchronize" }
      ? { readonly kind: "synchronized"; readonly task_gids: readonly string[] }
      : { readonly kind: "written" };

/** 保存済みstepを一つの外部callまたは一つのローカル同期として実行します。 */
export interface TaskWriteStepExecutor<Step extends WritableStep> {
  execute(
    step: Step,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<TaskWriteSubmission<Step>>;
}

export type TaskWriteExecutorRegistry = {
  readonly [Kind in WritableKind]: {
    readonly 1: TaskWriteStepExecutor<Extract<WritableStep, { readonly kind: Kind }>>;
  };
};
