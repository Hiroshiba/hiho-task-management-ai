import type { ErrorId } from "../errors/error-reporter";
import type { TaskWritePlan, TaskWriteReceipt } from "../task-write-plan";
import type { ProposalExecutionContext } from "./proposal-execution-context";
import type { TaskWriteSynchronizationFailureCode } from "./asana-task-write";

export type ProposalExecutionState =
  | "planned"
  | "running"
  | "succeeded"
  | "failed"
  | "confirmation_required";

export type ProposalExecutionStepState = ProposalExecutionState;

type ProposalExecutionStepBase = {
  readonly descriptor: TaskWritePlan["steps"][number];
  readonly attempt: number;
  readonly updated_at: string;
};

export type ProposalExecutionStep = ProposalExecutionStepBase & (
  | { readonly state: "planned" | "running"; readonly receipt?: never; readonly error_id?: never }
  | { readonly state: "succeeded"; readonly receipt: TaskWriteReceipt; readonly error_id?: never }
  | { readonly state: "failed" | "confirmation_required"; readonly receipt?: never; readonly error_id: ErrorId; readonly sync_error_code?: TaskWriteSynchronizationFailureCode }
);

type ProposalExecutionBase = {
  readonly execution_id: string;
  readonly proposal_id?: string;
  readonly retry_of_execution_id?: string;
  readonly plan: TaskWritePlan;
  readonly proposal_context?: ProposalExecutionContext;
  readonly created_at: string;
  readonly updated_at: string;
  readonly steps: readonly ProposalExecutionStep[];
};

export type ProposalExecution<Result extends object> = ProposalExecutionBase & (
  | { readonly state: "planned" | "running"; readonly error_id?: never; readonly result?: never }
  | { readonly state: "succeeded"; readonly error_id?: never; readonly result: Result }
  | { readonly state: "failed" | "confirmation_required"; readonly error_id: ErrorId; readonly result?: never }
);

export type SaveProposalExecution = {
  readonly plan: TaskWritePlan;
  readonly proposal_id?: string;
  readonly proposal_context?: ProposalExecutionContext;
  readonly retry_of_execution_id?: string;
  readonly created_at: string;
};

export type StartProposalExecutionStep = {
  readonly execution_id: string;
  readonly step_id: string;
  readonly expected_state: "planned" | "running";
  readonly expected_attempt: number;
  readonly started_at: string;
};

export type SettleProposalExecutionStep = {
  readonly execution_id: string;
  readonly step_id: string;
  readonly expected_attempt: number;
  readonly settled_at: string;
  readonly outcome:
    | { readonly state: "succeeded"; readonly receipt: TaskWriteReceipt }
    | { readonly state: "failed" | "confirmation_required"; readonly error_id: ErrorId; readonly sync_error_code?: TaskWriteSynchronizationFailureCode };
};

export type CompleteProposalExecution<Result extends object> = {
  readonly execution_id: string;
  readonly completed_at: string;
  readonly result: Result;
};

/** 保存済みplanを正本としてexecutionと各stepを原子的に進めます。 */
export interface ProposalExecutionRepository<Result extends object> {
  onChanged(listener: (execution: ProposalExecution<Result>) => void): () => void;
  save(input: SaveProposalExecution): void;
  get(executionId: string): ProposalExecution<Result> | undefined;
  getByProposal(proposalId: string): readonly ProposalExecution<Result>[];
  getIncomplete(): readonly ProposalExecution<Result>[];
  startStep(input: StartProposalExecutionStep): boolean;
  settleStep(input: SettleProposalExecutionStep): boolean;
  complete(input: CompleteProposalExecution<Result>): boolean;
}
