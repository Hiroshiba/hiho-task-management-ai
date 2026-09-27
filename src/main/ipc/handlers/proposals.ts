import type { z } from "zod";
import type { StoredProposalExecution } from "../../application/proposal-apply";
import { proposalsContracts } from "../../../shared/ipc-contracts/proposals";
import { createContractHandler, type ContractHandler, type IpcSuccessValue } from "./contract-handler";
import {
  externalApprovalSource,
  parseApprovalSource,
  toApprovalDto,
  toExternalStateDto,
  toProposalExecutionDto,
  toProposalViewDto,
  toTurnDto,
} from "./proposal-dto";

type MaybePromise<Value> = Value | PromiseLike<Value>;
type Request<Contract extends { readonly request: z.ZodType }> = z.output<Contract["request"]>;
type HistoryStatusDto = IpcSuccessValue<typeof proposalsContracts.getHistoryStatus.response>;
type ProposalInvokeName =
  | "getAiStatus" | "startSession" | "startTurn" | "getProposal" | "select" | "editOperation"
  | "reject" | "approve" | "closeSession" | "getExternalState" | "setExternalEnabled"
  | "editExternalOperation" | "selectExternal" | "approveExternal" | "rejectExternal"
  | "getHistoryStatus" | "confirmHistory" | "synchronizeHistory" | "getExecution" | "retryExecution";

export type ProposalsHandlers = {
  readonly [Name in ProposalInvokeName]: ContractHandler<(typeof proposalsContracts)[Name]>;
};

/** 変更案の公開workflowをIPC handlerへ接続します。 */
export interface ProposalsHandlerWorkflows {
  readonly ai: {
    getStatus(): MaybePromise<IpcSuccessValue<typeof proposalsContracts.getAiStatus.response>>;
    startNewSession(signal: AbortSignal): MaybePromise<IpcSuccessValue<typeof proposalsContracts.startSession.response>>;
    startTurn(input: Request<typeof proposalsContracts.startTurn>, signal: AbortSignal): MaybePromise<unknown>;
    getProposal(input: Request<typeof proposalsContracts.getProposal>): MaybePromise<unknown>;
    select(input: Request<typeof proposalsContracts.select>): MaybePromise<unknown>;
    editOperation(input: Request<typeof proposalsContracts.editOperation>): MaybePromise<unknown>;
    reject(input: Request<typeof proposalsContracts.reject>): MaybePromise<void>;
    approve(input: Request<typeof proposalsContracts.approve>, signal: AbortSignal): MaybePromise<unknown>;
    closeSession(sessionId: string): MaybePromise<{ readonly completed: true }>;
  };
  readonly external: {
    getState(): MaybePromise<unknown>;
    setEnabled(input: Request<typeof proposalsContracts.setExternalEnabled>, signal: AbortSignal): MaybePromise<unknown>;
    edit(input: Request<typeof proposalsContracts.editExternalOperation>, signal: AbortSignal): MaybePromise<unknown>;
    select(input: Request<typeof proposalsContracts.selectExternal>, signal: AbortSignal): MaybePromise<unknown>;
    approve(input: Request<typeof proposalsContracts.approveExternal>, signal: AbortSignal): MaybePromise<unknown>;
    reject(input: Request<typeof proposalsContracts.rejectExternal>, signal: AbortSignal): MaybePromise<unknown>;
  };
  readonly history: {
    getStatus(): MaybePromise<HistoryStatusDto>;
    confirm(input: Request<typeof proposalsContracts.confirmHistory>): MaybePromise<HistoryStatusDto>;
    synchronize(signal: AbortSignal): MaybePromise<{ readonly status: HistoryStatusDto; readonly synced_at: string }>;
  };
  readonly execution: {
    getExecution(executionId: string): MaybePromise<StoredProposalExecution>;
    retryExecution(executionId: string, signal: AbortSignal): MaybePromise<StoredProposalExecution>;
  };
}

/** proposalの各use caseに対応するIPC handlerを作成します。 */
export function createProposalsHandlers(workflows: ProposalsHandlerWorkflows): ProposalsHandlers {
  const { ai, external, history, execution } = workflows;
  const getExecution = createContractHandler(proposalsContracts.getExecution, async (request) =>
    toProposalExecutionDto(await execution.getExecution(request.execution_id)));
  const retryExecution = createContractHandler(proposalsContracts.retryExecution, async (request, signal) =>
    toProposalExecutionDto(await execution.retryExecution(request.retry_of_execution_id, signal)));
  return {
    getAiStatus: createContractHandler(proposalsContracts.getAiStatus, () => ai.getStatus()),
    startSession: createContractHandler(proposalsContracts.startSession, (_request, signal) => ai.startNewSession(signal)),
    startTurn: createContractHandler(proposalsContracts.startTurn, async (request, signal) =>
      toTurnDto(await ai.startTurn(request, signal))),
    getProposal: createContractHandler(proposalsContracts.getProposal, async (request) =>
      toProposalViewDto(await ai.getProposal(request), undefined)),
    select: createContractHandler(proposalsContracts.select, async (request) =>
      toProposalViewDto(await ai.select(request), undefined)),
    editOperation: createContractHandler(proposalsContracts.editOperation, async (request) =>
      toProposalViewDto(await ai.editOperation(request), undefined)),
    reject: createContractHandler(proposalsContracts.reject, async (request) => {
      await ai.reject(request);
      return { completed: true };
    }),
    approve: createContractHandler(proposalsContracts.approve, async (request, signal) => {
      const result = parseApprovalSource(await ai.approve(request, signal));
      return toApprovalDto(result, result.execution_id == null ? undefined : await execution.getExecution(result.execution_id));
    }),
    closeSession: createContractHandler(proposalsContracts.closeSession, (request) => ai.closeSession(request.session_id)),
    getExternalState: createContractHandler(proposalsContracts.getExternalState, async () =>
      toExternalStateDto(await external.getState())),
    setExternalEnabled: createContractHandler(proposalsContracts.setExternalEnabled, async (request, signal) =>
      toExternalStateDto(await external.setEnabled(request, signal))),
    editExternalOperation: createContractHandler(proposalsContracts.editExternalOperation, async (request, signal) =>
      toExternalStateDto(await external.edit(request, signal))),
    selectExternal: createContractHandler(proposalsContracts.selectExternal, async (request, signal) =>
      toExternalStateDto(await external.select(request, signal))),
    approveExternal: createContractHandler(proposalsContracts.approveExternal, async (request, signal) => {
      const result = externalApprovalSource(await external.approve(request, signal), request.proposal_id);
      return toApprovalDto(result, result.execution_id == null ? undefined : await execution.getExecution(result.execution_id));
    }),
    rejectExternal: createContractHandler(proposalsContracts.rejectExternal, async (request, signal) =>
      toExternalStateDto(await external.reject(request, signal))),
    getHistoryStatus: createContractHandler(proposalsContracts.getHistoryStatus, async () =>
      history.getStatus()),
    confirmHistory: createContractHandler(proposalsContracts.confirmHistory, async (request) =>
      history.confirm(request)),
    synchronizeHistory: createContractHandler(proposalsContracts.synchronizeHistory, async (_request, signal) => {
      const synchronized = await history.synchronize(signal);
      return { status: synchronized.status, synced_at: synchronized.synced_at };
    }),
    getExecution,
    retryExecution,
  };
}

/** AI状態の購読要求を検証します。 */
export function parseProposalsAiStatusSubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.subscribeAiStatus> {
  return proposalsContracts.subscribeAiStatus.request.parse(payload);
}

/** AI状態の購読解除要求を検証します。 */
export function parseProposalsAiStatusUnsubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.unsubscribeAiStatus> {
  return proposalsContracts.unsubscribeAiStatus.request.parse(payload);
}

/** AI状態を購読イベントへ直列化します。 */
export function serializeProposalsAiStatusEvent(subscriptionId: string, status: IpcSuccessValue<typeof proposalsContracts.getAiStatus.response>): z.output<typeof proposalsContracts.aiStatus.event> {
  return proposalsContracts.aiStatus.event.parse({ subscription_id: subscriptionId, value: status });
}

/** AI差分の購読要求を検証します。 */
export function parseProposalsAiDeltaSubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.subscribeAiDelta> {
  return proposalsContracts.subscribeAiDelta.request.parse(payload);
}

/** AI差分の購読解除要求を検証します。 */
export function parseProposalsAiDeltaUnsubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.unsubscribeAiDelta> {
  return proposalsContracts.unsubscribeAiDelta.request.parse(payload);
}

/** AI差分を購読イベントへ直列化します。 */
export function serializeProposalsAiDeltaEvent(subscriptionId: string, delta: z.output<typeof proposalsContracts.aiDelta.event>["value"]): z.output<typeof proposalsContracts.aiDelta.event> {
  return proposalsContracts.aiDelta.event.parse({ subscription_id: subscriptionId, value: delta });
}

/** 外部変更案状態の購読要求を検証します。 */
export function parseProposalsExternalStateSubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.subscribeExternalState> {
  return proposalsContracts.subscribeExternalState.request.parse(payload);
}

/** 外部変更案状態の購読解除要求を検証します。 */
export function parseProposalsExternalStateUnsubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.unsubscribeExternalState> {
  return proposalsContracts.unsubscribeExternalState.request.parse(payload);
}

/** 外部変更案状態を購読イベントへ直列化します。 */
export function serializeProposalsExternalStateEvent(subscriptionId: string, state: unknown): z.output<typeof proposalsContracts.externalState.event> {
  return proposalsContracts.externalState.event.parse({ subscription_id: subscriptionId, value: toExternalStateDto(state) });
}

/** 変更案executionの購読要求を検証します。 */
export function parseProposalsExecutionSubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.subscribeExecution> {
  return proposalsContracts.subscribeExecution.request.parse(payload);
}

/** 変更案executionの購読解除要求を検証します。 */
export function parseProposalsExecutionUnsubscriptionRequest(payload: unknown): Request<typeof proposalsContracts.unsubscribeExecution> {
  return proposalsContracts.unsubscribeExecution.request.parse(payload);
}

/** 変更案executionを購読イベントへ直列化します。 */
export function serializeProposalsExecutionEvent(subscriptionId: string, execution: StoredProposalExecution): z.output<typeof proposalsContracts.execution.event> {
  return proposalsContracts.execution.event.parse({ subscription_id: subscriptionId, value: toProposalExecutionDto(execution) });
}
