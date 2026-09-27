import type { ErrorId } from "../errors/error-reporter";

export type ProposalApplicationHistoryStep = {
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
  readonly confirmation_state: "not_required" | "required" | "confirmed" | "synchronized";
  readonly confirmed_result?: "applied" | "not_applied" | "manually_adjusted";
  readonly operation_kind?: string;
};

export type ProposalApplicationHistory = {
  readonly proposal_id: string;
  readonly state: "succeeded" | "failed" | "confirmation_required" | "synchronization_required";
  readonly steps: readonly ProposalApplicationHistoryStep[];
};

export type ProposalApplicationHistoryRead =
  | { readonly kind: "history"; readonly history: ProposalApplicationHistory }
  | {
      readonly kind: "rejected";
      readonly proposal_id: string;
      readonly operation_id: string;
      readonly error_id: ErrorId;
    };

/** 移行済みの非実行履歴を復旧表示へ読み出します。 */
export interface ProposalApplicationHistoryRepository {
  getByProposal(proposalId: string): ProposalApplicationHistoryRead | undefined;
  getIncomplete(): readonly ProposalApplicationHistoryRead[];
}
