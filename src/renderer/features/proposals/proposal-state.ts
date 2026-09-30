import type { ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import type { ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import type { IpcResult } from "../../../shared/ipc-contracts/common";

export type AiStatus = Extract<Awaited<ReturnType<ProposalsApi["getAiStatus"]>>, { readonly kind: "ok" }>["value"];
export type AiDelta = Parameters<Parameters<ProposalsApi["onAiDelta"]>[0]>[0];
export type ExternalState = Extract<Awaited<ReturnType<ProposalsApi["getExternalState"]>>, { readonly kind: "ok" }>["value"];
type ApprovalResult = Extract<Awaited<ReturnType<ProposalsApi["approve"]>>, { readonly kind: "ok" }>["value"];
type TurnResult = Extract<Awaited<ReturnType<ProposalsApi["startTurn"]>>, { readonly kind: "ok" }>["value"];
type Question = TurnResult["questions"][number];
export type IpcFailure = Extract<IpcResult<unknown>, { readonly kind: "error" }>;

export type AiProposalState =
  | { readonly kind: "idle"; readonly pending_proposal?: ProposalViewDto }
  | { readonly kind: "turning"; readonly pending_proposal?: ProposalViewDto; readonly buffered_deltas: readonly AiDelta[] }
  | { readonly kind: "proposal"; readonly message: string; readonly questions: readonly Question[]; readonly proposal: ProposalViewDto; readonly turn_id: string; readonly text: string }
  | { readonly kind: "questions"; readonly message: string; readonly questions: readonly Question[]; readonly pending_proposal?: ProposalViewDto; readonly turn_id: string; readonly text: string }
  | { readonly kind: "failed"; readonly failure: IpcFailure; readonly pending_proposal?: ProposalViewDto }
  | { readonly kind: "approved"; readonly result: ApprovalResult };

export type AiProposalSession = {
  readonly session_id: string;
  readonly state: AiProposalState;
  readonly activity: "idle" | "turn" | "get" | "select" | "edit" | "approve" | "reject" | "close";
  readonly generation: number;
};

/** AI表示状態から保持中の変更案を取得します。 */
export function proposalFromState(state: AiProposalState): ProposalViewDto | undefined {
  switch (state.kind) {
    case "idle":
    case "turning":
    case "questions":
    case "failed":
      return state.pending_proposal;
    case "proposal":
      return state.proposal;
    case "approved":
      return undefined;
  }
}

/** 返却された変更案をAI表示状態へ反映します。 */
export function withProposal(state: AiProposalState, proposal: ProposalViewDto): AiProposalState {
  switch (state.kind) {
    case "idle":
      return { ...state, pending_proposal: proposal };
    case "questions":
      return { ...state, pending_proposal: proposal };
    case "failed":
      return { ...state, pending_proposal: proposal };
    case "proposal":
      return { ...state, proposal };
    case "turning":
    case "approved":
      throw new Error("現在のAI状態では変更案を更新できません。");
  }
}
