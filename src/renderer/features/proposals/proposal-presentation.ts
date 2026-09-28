import { durationSchema, taskStatusSchema } from "../../../shared/ipc-contracts/task-values";
import type { z } from "zod";
import type { ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import type { ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import type { AiProposalState, IpcFailure } from "./proposal-state";

export type ProposalOperation = ProposalViewDto["groups"][number]["operations"][number];
export type ProposalSelectionInput = Omit<Parameters<ProposalsApi["select"]>[0], "session_id">;
type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;
export type ProposalEditInput = DistributiveOmit<Parameters<ProposalsApi["editOperation"]>[0], "session_id">;
export type ExternalSelectionInput = Parameters<ProposalsApi["selectExternal"]>[0];
export type ExternalEditInput = Parameters<ProposalsApi["editExternalOperation"]>[0];
export type ExternalRejectInput = Parameters<ProposalsApi["rejectExternal"]>[0];
export type ExternalState = Extract<Awaited<ReturnType<ProposalsApi["getExternalState"]>>, { readonly kind: "ok" }>["value"];
export type ExternalProposal = ExternalState["proposals"][number];
export type ExternalProposalStatus = ExternalProposal["state"];
export type ApprovalResult = Extract<Awaited<ReturnType<ProposalsApi["approve"]>>, { readonly kind: "ok" }>["value"];
export type ExternalApprovalResult = ApprovalResult;
export type ExternalProposalViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly value: ExternalState }
  | { readonly kind: "error"; readonly message: string };
export type ExternalEditResult = {
  readonly kind: "saved" | "failed";
  readonly proposal_id: string;
  readonly revision: number;
};
export type Feedback = { readonly kind: "success" | "progress" | "warning" | "failure"; readonly message: string };
export type AiSessionStatus = "waiting_answer" | "waiting_approval" | "running" | "error" | "completed" | "idle";
export type AiSessionOperation = "idle" | "turn" | "get" | "select" | "edit" | "approve" | "reject" | "close";
export type AiConversationEntry =
  | { readonly kind: "pending"; readonly request: string }
  | { readonly kind: "response"; readonly request: string; readonly message: string; readonly questions: readonly { readonly question_id: string; readonly text: string; readonly options?: readonly string[] | undefined }[]; readonly text: string }
  | { readonly kind: "failure"; readonly request: string; readonly failure: IpcFailure };
export type AiSessionView = {
  readonly session_id: string;
  readonly title: string;
  readonly created_at: number;
  readonly task_gid?: string;
  readonly task_title?: string;
  readonly state: AiProposalState;
  readonly status: AiSessionStatus;
  readonly operation: AiSessionOperation;
  readonly conversation_history: readonly AiConversationEntry[];
  readonly feedback?: Feedback | undefined;
  readonly can_write: boolean;
  readonly can_send_ai: boolean;
  readonly ai_send_disabled_reason: string;
};

/** タスク状態を日本語で表示します。 */
export function statusLabel(status: z.infer<typeof taskStatusSchema>): string {
  switch (status) {
    case "not_started": return "未着手";
    case "in_progress": return "進行中";
    case "completed": return "完了";
    case "withdrawn": return "取り下げ";
  }
}

/** 重要度を日本語で表示します。 */
export function importanceLabel(importance: number): string {
  return `重要度 ${importance}`;
}

/** 親タスクの作業範囲を日本語で表示します。 */
export function parentWorkModeLabel(mode: "children_only" | "has_own_work" | "unknown"): string {
  switch (mode) {
    case "children_only": return "子タスクのみ";
    case "has_own_work": return "親自身の作業あり";
    case "unknown": return "不明";
  }
}

export type DurationUnit = ReturnType<typeof durationSchema.parse>["unit"];
export type Duration = ReturnType<typeof durationSchema.parse>;

/** 所要時間の入力単位を定義します。 */
export const durationUnitOptions: readonly { readonly value: DurationUnit; readonly label: string }[] = [
  { value: "minute", label: "分" },
  { value: "hour", label: "時間" },
  { value: "day", label: "日" },
  { value: "week", label: "週" },
  { value: "month", label: "月" },
];

/** 所要時間を数値付きで表示します。 */
export function durationLabel(duration: Duration): string {
  const unit = durationUnitOptions.find((candidate) => candidate.value === duration.unit);
  if (unit == null) throw new Error("所要時間の単位が見つかりません。");
  if (duration.unit === "week") return `${duration.value}週間`;
  if (duration.unit === "month") return `${duration.value}ヶ月`;
  return `${duration.value}${unit.label}`;
}

/** 所要時間の単位ごとの最小値を返します。 */
export function durationMinimum(unit: DurationUnit): number {
  return unit === "minute" ? 15 : 1;
}

/** 入力された所要時間を検証します。 */
export function parseDurationInput(unit: DurationUnit, value: string): Duration {
  return durationSchema.parse({ unit, value: Number(value) });
}
