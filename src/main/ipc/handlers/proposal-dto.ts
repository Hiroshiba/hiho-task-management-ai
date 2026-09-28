import { z } from "zod";
import {
  projectProposalExecutionResults,
  type StoredProposalExecution,
} from "../../application/proposal-apply";
import { executionDtoSchema, type ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { externalProposalStateSchema } from "../../../shared/ipc-contracts/external-proposal-state";
import { identifierSchema } from "../../../shared/ipc-contracts/common";
import {
  proposalImpactSchema,
  proposalOperationSchema,
  proposalValidationSchema,
  proposalViewSchema,
  type ProposalViewDto,
} from "../../../shared/ipc-contracts/proposal-values";
import { proposalsContracts } from "../../../shared/ipc-contracts/proposals";
import type { IpcSuccessValue } from "./contract-handler";

type ApprovalDto = IpcSuccessValue<typeof proposalsContracts.approve.response>;
type ExternalStateDto = z.output<typeof externalProposalStateSchema>;

const proposalViewSourceSchema = z.object({
  proposal_id: identifierSchema,
  baseline_snapshot_hash: z.string(),
  proposal: z.object({
    title: z.string(),
    groups: z.array(z.object({
      group_id: identifierSchema,
      atomic: z.boolean(),
      operations: z.array(proposalOperationSchema),
    }).strict()),
  }).strict(),
  basic_validation: proposalValidationSchema,
  graph_validation: proposalValidationSchema,
  selected_operation_ids: z.array(identifierSchema),
  impact: proposalImpactSchema,
}).strict();

const approvalSourceSchema = z.object({
  proposal_id: identifierSchema,
  execution_id: identifierSchema.optional(),
  application: z.object({
    outcome: z.enum(["applied", "already_applied", "not_applied", "partially_applied", "unknown"]),
    operations: z.array(z.object({
      group_id: identifierSchema,
      operation_id: identifierSchema,
      task_gid: identifierSchema.optional(),
      outcome: z.enum(["applied", "already_applied", "not_applied", "unknown"]),
      reason_code: identifierSchema,
    }).strict()),
    groups: z.array(z.object({
      group_id: identifierSchema,
      atomic: z.boolean(),
      operation_ids: z.array(identifierSchema),
      outcome: z.enum(["applied", "already_applied", "not_applied", "partially_applied", "unknown"]),
    }).strict()),
  }).strict(),
}).strict();

const turnSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("proposal"),
    turn_id: identifierSchema,
    message: z.string(),
    questions: z.array(z.object({ question_id: identifierSchema, text: z.string(), options: z.array(z.string()).optional() }).strict()),
    proposal: z.unknown(),
    retry_count: z.number(),
  }).strict(),
  z.object({
    kind: z.literal("no_proposal"),
    turn_id: identifierSchema,
    message: z.string(),
    questions: z.array(z.object({ question_id: identifierSchema, text: z.string(), options: z.array(z.string()).optional() }).strict()),
    pending_proposal_action: z.enum(["keep", "discard"]),
    retry_count: z.number(),
  }).strict(),
]);

const externalStateSourceSchema = z.object({
  enabled: z.boolean(),
  bridge: z.unknown(),
  registration: z.unknown(),
  proposals: z.array(z.object({
    proposal_id: identifierSchema,
    request_id: identifierSchema,
    revision: z.number(),
    state: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pending_approval") }).strict(),
      z.object({ kind: z.literal("approving") }).strict(),
      z.object({ kind: z.literal("finished"), result: approvalSourceSchema }).strict(),
      z.object({ kind: z.literal("rejected") }).strict(),
      z.object({ kind: z.literal("expired"), reason_code: z.string() }).strict(),
      z.object({ kind: z.literal("failed"), reason_code: z.string(), message: z.string() }).strict(),
      z.object({ kind: z.literal("unknown"), reason_code: z.string(), message: z.string() }).strict(),
    ]),
    view: z.unknown(),
  }).passthrough()),
  review_target: z.unknown().optional(),
}).passthrough();

/** AIターンの提案表示を最終DTOへ変換します。 */
export function toTurnDto(source: unknown): IpcSuccessValue<typeof proposalsContracts.startTurn.response> {
  const result = turnSourceSchema.parse(source);
  return result.kind === "proposal"
    ? { ...result, proposal: toProposalViewDto(result.proposal, undefined) }
    : result;
}

/** 承認結果の保存済みexecution IDを検証します。 */
export function parseApprovalSource(source: unknown): z.output<typeof approvalSourceSchema> {
  return approvalSourceSchema.parse(source);
}

/** 外部変更案の承認結果を状態から取得します。 */
export function externalApprovalSource(source: unknown, proposalId: string): z.output<typeof approvalSourceSchema> {
  const state = externalStateSourceSchema.parse(source);
  const proposal = state.proposals.find((item) => item.proposal_id === proposalId);
  if (proposal?.state.kind !== "finished") throw new Error("外部変更案の承認結果がありません。");
  if (proposal.state.result.proposal_id !== proposalId) throw new Error("外部変更案のIDと承認結果が一致しません。");
  return proposal.state.result;
}

/** AI変更案の表示値を最終DTOへ変換します。 */
export function toProposalViewDto(source: unknown, revision: number | undefined): ProposalViewDto {
  const view = proposalViewSourceSchema.parse(source);
  return proposalViewSchema.parse({
    proposal_id: view.proposal_id,
    ...(revision == null ? {} : { revision }),
    baseline_snapshot_hash: view.baseline_snapshot_hash,
    title: view.proposal.title,
    groups: view.proposal.groups,
    basic_validation: view.basic_validation,
    graph_validation: view.graph_validation,
    selected_operation_ids: view.selected_operation_ids,
    impact: view.impact,
  });
}

/** 編集要求の操作種別が保存中の変更案と一致することを確認します。 */
export function assertProposalEditOperation(source: unknown, operationId: string, operationKind: string): void {
  const view = proposalViewSourceSchema.parse(source);
  const operation = view.proposal.groups.flatMap((group) => group.operations)
    .find((candidate) => candidate.operation_id === operationId);
  if (operation == null) throw new Error("指定した操作が変更案にありません。");
  if (operation.operation !== operationKind) throw new Error("編集要求の操作種別が変更案と一致しません。");
}

/** 外部変更案の編集要求と保存中の版、操作種別を照合します。 */
export function assertExternalProposalEditOperation(
  source: unknown,
  proposalId: string,
  revision: number,
  operationId: string,
  operationKind: string,
): void {
  const state = externalStateSourceSchema.parse(source);
  const proposal = state.proposals.find((candidate) => candidate.proposal_id === proposalId);
  if (proposal == null) throw new Error("指定した外部変更案がありません。");
  if (proposal.revision !== revision) throw new Error("外部変更案の表示版が一致しません。");
  if (proposal.state.kind !== "pending_approval") throw new Error("外部変更案は編集できない状態です。");
  const view = proposalViewSourceSchema.parse(proposal.view);
  if (view.proposal_id !== proposalId) throw new Error("外部変更案のIDが表示値と一致しません。");
  assertProposalEditOperation(view, operationId, operationKind);
}

/** 保存済み変更案executionを表示DTOへ変換します。 */
export function toProposalExecutionDto(execution: StoredProposalExecution): ExecutionDto {
  const proposalId = execution.proposal_id;
  if (execution.plan.origin !== "proposal" || proposalId == null) {
    throw new Error("変更案executionの保存文脈がありません。");
  }
  const projected = projectProposalExecutionResults(execution);
  return executionDtoSchema.parse({
    origin: "proposal",
    execution_id: execution.execution_id,
    ...(execution.retry_of_execution_id == null ? {} : { retry_of_execution_id: execution.retry_of_execution_id }),
    proposal_id: proposalId,
    state: execution.state,
    ...(execution.error_id == null ? {} : { error_id: execution.error_id }),
    created_at: execution.created_at,
    updated_at: execution.updated_at,
    operation_results: projected.operation_results,
    group_results: projected.group_results,
  });
}

/** 承認結果を保存済みexecutionまたは開始前競合へ変換します。 */
export function toApprovalDto(source: unknown, execution: StoredProposalExecution | undefined): ApprovalDto {
  const result = approvalSourceSchema.parse(source);
  if (execution != null) {
    if (result.execution_id !== execution.execution_id || result.proposal_id !== execution.proposal_id) {
      throw new Error("変更案の承認結果と保存済みexecutionが一致しません。");
    }
    return { kind: "execution", execution: toProposalExecutionDto(execution) };
  }
  if (result.execution_id != null || result.application.outcome === "applied" || result.application.outcome === "unknown") {
    throw new Error("変更案の開始前結果に保存済みexecutionがありません。");
  }
  return {
    kind: "not_started",
    proposal_id: result.proposal_id,
    outcome: result.application.outcome,
    operation_results: result.application.operations.map((operation) => {
      if (operation.outcome !== "already_applied" && operation.outcome !== "not_applied") {
        throw new Error("変更案の開始前操作に書き込み結果があります。");
      }
      return { ...operation, outcome: operation.outcome };
    }),
    group_results: result.application.groups.map((group) => {
      if (group.outcome !== "already_applied" && group.outcome !== "not_applied"
        && group.outcome !== "partially_applied") {
        throw new Error("変更案の開始前グループに書き込み結果があります。");
      }
      return { ...group, outcome: group.outcome };
    }),
  };
}

/** 外部変更案の旧状態を最終DTOへ変換します。 */
export function toExternalStateDto(source: unknown): ExternalStateDto {
  const state = externalStateSourceSchema.parse(source);
  return externalProposalStateSchema.parse({
    enabled: state.enabled,
    bridge: state.bridge,
    registration: state.registration,
    proposals: state.proposals.map((proposal) => {
      if (proposal.state.kind === "finished" && proposal.state.result.proposal_id !== proposal.proposal_id) {
        throw new Error("外部変更案のIDと承認結果が一致しません。");
      }
      return {
        proposal_id: proposal.proposal_id,
        request_id: proposal.request_id,
        revision: proposal.revision,
        state: proposal.state.kind === "finished" ? {
          kind: "finished",
          outcome: proposal.state.result.application.outcome,
          ...(proposal.state.result.execution_id == null ? {} : { execution_id: proposal.state.result.execution_id }),
        } : proposal.state,
        view: toProposalViewDto(proposal.view, proposal.revision),
      };
    }),
    ...(state.review_target == null ? {} : { review_target: state.review_target }),
  });
}
