import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";

type ExecutionStepSource = {
  readonly descriptor: Pick<ExecutionDto["steps"][number], "step_id" | "scope" | "kind">;
  readonly attempt: number;
  readonly updated_at: string;
} & (
  | { readonly state: "planned" | "running" | "succeeded"; readonly error_id?: never }
  | { readonly state: "failed" | "confirmation_required"; readonly error_id: string }
);

/** 保存済みstepから画面表示に必要な値だけを取り出します。 */
export function toExecutionStepsDto(steps: readonly ExecutionStepSource[]): ExecutionDto["steps"] {
  return steps.map((step) => {
    const displayed = {
      step_id: step.descriptor.step_id,
      scope: step.descriptor.scope,
      kind: step.descriptor.kind,
      attempt: step.attempt,
      updated_at: step.updated_at,
    };
    if (step.state === "failed" || step.state === "confirmation_required") {
      return { ...displayed, state: step.state, error_id: step.error_id };
    }
    return { ...displayed, state: step.state };
  });
}
