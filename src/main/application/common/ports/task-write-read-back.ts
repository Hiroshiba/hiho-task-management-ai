import type { TaskWriteExecutionContext } from "./task-write-executor";
import type { TaskWriteStep } from "../task-write-step";

export type TaskWriteReadBackHint =
  | { readonly kind: "before_write" }
  | { readonly kind: "resume" }
  | { readonly kind: "after_write"; readonly submitted_task_gid?: string };

export type TaskWriteOperationObservation =
  | {
      readonly state: "needs_write" | "already_applied";
      readonly task_gid: string;
      readonly observed_state_fingerprint: string;
    }
  | { readonly state: "conflict" | "unknown" };

export type TaskWriteAsanaObservation =
  | {
      readonly state: "applied";
      readonly task_gid: string;
      readonly observed_state_fingerprint: string;
    }
  | { readonly state: "not_applied" | "unknown" };

type AsanaStep = Exclude<TaskWriteStep,
  { readonly kind: "proposal_operation_check" | "local_synchronize" }>;

/** 保存済み基準とAsanaの現在値からstepの適用有無を判定します。 */
export interface TaskWriteReadBackPort {
  inspectOperation(
    step: Extract<TaskWriteStep, { readonly kind: "proposal_operation_check" }>,
    context: TaskWriteExecutionContext,
    signal: AbortSignal,
  ): Promise<TaskWriteOperationObservation>;
  inspectAsanaStep(
    step: AsanaStep,
    context: TaskWriteExecutionContext,
    hint: TaskWriteReadBackHint,
    signal: AbortSignal,
  ): Promise<TaskWriteAsanaObservation>;
}
