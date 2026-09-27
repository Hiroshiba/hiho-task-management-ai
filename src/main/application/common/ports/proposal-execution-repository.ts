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
  save(input: SaveProposalExecution): void;
  get(executionId: string): ProposalExecution<Result> | undefined;
  getByProposal(proposalId: string): readonly ProposalExecution<Result>[];
  getIncomplete(): readonly ProposalExecution<Result>[];
  startStep(input: StartProposalExecutionStep): boolean;
  settleStep(input: SettleProposalExecutionStep): boolean;
  complete(input: CompleteProposalExecution<Result>): boolean;
}

export type LegacyProposalExecutionStep = {
  readonly step_id: string;
  readonly operation_id: string;
  readonly operation_order?: number;
  readonly stage: string;
  readonly state: "succeeded" | "failed" | "confirmation_required" | "synchronization_required";
  readonly started_at: string;
  readonly target:
    | { readonly kind: "task"; readonly gid: string }
    | { readonly kind: "temporary"; readonly ref: string }
    | { readonly kind: "new_task"; readonly uuid: string };
  readonly final_result: "applied" | "not_applied" | "unknown" | "failed" | null;
  readonly confirmation_state?: "not_required" | "required" | "confirmed" | "synchronized";
  readonly confirmed_result?: "applied" | "not_applied" | "manually_adjusted";
  readonly operation_kind?: string;
};

export type LegacyProposalExecution = {
  readonly format: "application_journal";
  readonly execution_id: string;
  readonly proposal_id: string;
  readonly state: "succeeded" | "failed" | "confirmation_required" | "synchronization_required";
  readonly steps: readonly LegacyProposalExecutionStep[];
};

export type LegacyProposalExecutionRead =
  | { readonly kind: "execution"; readonly execution: LegacyProposalExecution }
  | {
      readonly kind: "rejected";
      readonly proposal_id: string;
      readonly operation_id?: string;
      readonly error_id: ErrorId;
    };

/** 旧行と非実行履歴を変更せず復旧表示へ変換します。 */
export interface LegacyProposalExecutionRepository {
  getByProposal(proposalId: string): LegacyProposalExecutionRead | undefined;
  getIncomplete(): readonly LegacyProposalExecutionRead[];
}
