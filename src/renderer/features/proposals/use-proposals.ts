import { computed, onBeforeUnmount, onUnmounted, ref } from "vue";
import { ipcFailureSchema, type IpcSubscriptionFailure } from "../../../shared/ipc-contracts/common";
import { proposalsContracts, type ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import type { ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { proposalViewSchema } from "../../../shared/ipc-contracts/proposal-values";
import { externalProposalStateSchema } from "../../../shared/ipc-contracts/external-proposal-state";
import { useProposalsApi } from "../../shared/api/feature-apis";
import { proposalFromState, withProposal, type AiDelta, type AiProposalSession, type AiStatus, type ExternalState, type IpcFailure } from "./proposal-state";
import { useProposalHistory } from "./use-proposal-history";

type SubscriptionFailureKind = "ai_status" | "ai_delta" | "execution" | "external_state";

/** AI変更案と外部提案の表示状態、要求、購読を所有します。 */
export function useProposals() {
  const api = useProposalsApi();
  const history = useProposalHistory(api);
  const aiStatus = ref<AiStatus>();
  const aiStatusFailure = ref<IpcFailure>();
  const sessions = ref<readonly AiProposalSession[]>([]);
  const externalState = ref<ExternalState>();
  const externalStateFailure = ref<IpcFailure>();
  const executions = ref<Readonly<Record<string, ExecutionDto>>>({});
  const executionListFailure = ref<IpcFailure>();
  const executionFailures = ref<Readonly<Record<string, IpcFailure>>>({});
  const subscriptionFailure = ref<{ readonly kind: "ai_delta" | "execution"; readonly failure: IpcFailure }>();
  const executionListBusy = ref(false);
  const executionRequestIds = ref<readonly string[]>([]);
  const retryingExecutionIds = ref<readonly string[]>([]);
  const selectedExternalProposalId = ref<string>();
  const selectedExternalProposal = computed(() => externalState.value?.proposals.find((proposal) =>
    proposal.proposal_id === selectedExternalProposalId.value));
  let removeAiStatus: (() => void) | undefined;
  let removeAiDelta: (() => void) | undefined;
  let removeExternalState: (() => void) | undefined;
  let removeExecution: (() => void) | undefined;
  let initialized = false;
  let disposed = false;
  let lifecycleGeneration = 0;
  let aiStatusGeneration = 0;
  let aiDeltaGeneration = 0;
  let externalStateGeneration = 0;
  let executionGeneration = 0;
  let executionEventGeneration = 0;
  const pendingSubscriptionFailures = new Map<SubscriptionFailureKind, { readonly failureId: string; readonly generation: number }>();
  const receivedExecutionGenerations = new Map<string, number>();

  onBeforeUnmount(() => {
    disposed = true;
    lifecycleGeneration += 1;
  });
  onUnmounted(() => {
    removeSubscriptions();
  });

  function removeSubscriptions(): void {
    const removeStatus = removeAiStatus;
    removeAiStatus = undefined;
    removeStatus?.();
    const removeDelta = removeAiDelta;
    removeAiDelta = undefined;
    removeDelta?.();
    const removeExternal = removeExternalState;
    removeExternalState = undefined;
    removeExternal?.();
    const removeExecutionSubscription = removeExecution;
    removeExecution = undefined;
    removeExecutionSubscription?.();
  }

  function subscriptionGeneration(kind: SubscriptionFailureKind): number {
    switch (kind) {
      case "ai_status": return aiStatusGeneration;
      case "ai_delta": return aiDeltaGeneration;
      case "execution": return executionEventGeneration;
      case "external_state": return externalStateGeneration;
    }
  }

  function handleSubscriptionFailure(kind: SubscriptionFailureKind, event: IpcSubscriptionFailure): void {
    if (disposed) return;
    if (event.kind === "started") {
      switch (kind) {
        case "ai_status":
          aiStatusGeneration += 1;
          aiStatus.value = undefined;
          aiStatusFailure.value = undefined;
          break;
        case "ai_delta":
          aiDeltaGeneration += 1;
          if (subscriptionFailure.value?.kind === kind) subscriptionFailure.value = undefined;
          break;
        case "execution":
          executionEventGeneration += 1;
          if (subscriptionFailure.value?.kind === kind) subscriptionFailure.value = undefined;
          break;
        case "external_state":
          externalStateGeneration += 1;
          externalState.value = undefined;
          externalStateFailure.value = undefined;
          break;
      }
      pendingSubscriptionFailures.set(kind, { failureId: event.failure_id, generation: subscriptionGeneration(kind) });
      return;
    }
    const pending = pendingSubscriptionFailures.get(kind);
    if (pending?.failureId !== event.failure_id || pending.generation !== subscriptionGeneration(kind)) return;
    pendingSubscriptionFailures.delete(kind);
    const message = {
      ai_status: "AIの状態を確認できませんでした。",
      ai_delta: "AIの応答を確認できませんでした。",
      execution: "実行状態を確認できませんでした。",
      external_state: "外部提案の状態を確認できませんでした。",
    }[kind];
    const failure = ipcFailureSchema.parse({
      kind: "error",
      code: "operation_failed",
      message,
      ...(event.kind === "reported" ? { error_id: event.error_id } : {}),
    });
    switch (kind) {
      case "ai_status":
        aiStatusFailure.value = failure;
        return;
      case "ai_delta":
      case "execution":
        subscriptionFailure.value = { kind, failure };
        return;
      case "external_state":
        externalStateFailure.value = failure;
        return;
    }
  }

  function sessionFor(sessionId: string): AiProposalSession | undefined {
    return sessions.value.find((session) => session.session_id === sessionId);
  }

  function requireSession(sessionId: string): AiProposalSession {
    const session = sessionFor(sessionId);
    if (session == null) throw new Error("AIセッションが見つかりません。");
    return session;
  }

  function replaceSession(sessionId: string, update: (session: AiProposalSession) => AiProposalSession): void {
    let found = false;
    sessions.value = sessions.value.map((session) => {
      if (session.session_id !== sessionId) return session;
      found = true;
      return update(session);
    });
    if (!found) throw new Error("AIセッションが見つかりません。");
  }

  function beginSessionRequest(sessionId: string, activity: AiProposalSession["activity"]): number {
    const session = requireSession(sessionId);
    if (session.activity !== "idle") throw new Error("AIセッションの操作中です。");
    const generation = session.generation + 1;
    replaceSession(sessionId, (current) => ({ ...current, activity, generation }));
    return generation;
  }

  function isCurrentSessionRequest(sessionId: string, generation: number): boolean {
    return !disposed && sessionFor(sessionId)?.generation === generation;
  }

  function finishSessionRequest(sessionId: string, generation: number): void {
    if (isCurrentSessionRequest(sessionId, generation)) {
      replaceSession(sessionId, (session) => ({ ...session, activity: "idle" }));
    }
  }

  function applyExternalState(value: ExternalState): void {
    externalState.value = externalProposalStateSchema.parse(value);
    externalStateGeneration += 1;
    pendingSubscriptionFailures.delete("external_state");
    externalStateFailure.value = undefined;
    const selectedId = selectedExternalProposalId.value;
    if (selectedId != null && !externalState.value.proposals.some((proposal) => proposal.proposal_id === selectedId)) {
      selectedExternalProposalId.value = undefined;
    }
  }

  function receiveExecution(value: ExecutionDto, requestGeneration?: number): void {
    if (disposed) return;
    const execution = proposalsContracts.execution.event.shape.value.parse(value);
    if (requestGeneration != null && (receivedExecutionGenerations.get(execution.execution_id) ?? 0) > requestGeneration) return;
    executionEventGeneration += 1;
    pendingSubscriptionFailures.delete("execution");
    if (subscriptionFailure.value?.kind === "execution") subscriptionFailure.value = undefined;
    executionGeneration += 1;
    receivedExecutionGenerations.set(execution.execution_id, executionGeneration);
    executions.value = { ...executions.value, [execution.execution_id]: execution };
    const failures = { ...executionFailures.value };
    delete failures[execution.execution_id];
    executionFailures.value = failures;
  }

  function latestExecutionFor(executionId: string): ExecutionDto | undefined {
    let execution = executions.value[executionId];
    const visited = new Set<string>();
    while (execution != null) {
      const currentExecutionId = execution.execution_id;
      if (visited.has(currentExecutionId)) throw new Error("実行履歴の再試行関係が循環しています。");
      visited.add(currentExecutionId);
      const successors = Object.values(executions.value).filter((candidate) =>
        candidate.retry_of_execution_id === currentExecutionId);
      if (successors.length > 1) throw new Error("実行履歴の再試行先が重複しています。");
      const successor = successors[0];
      if (successor == null) return execution;
      execution = successor;
    }
    return undefined;
  }

  async function listExecutions(): ReturnType<ProposalsApi["listExecutions"]> {
    if (executionListBusy.value) throw new Error("実行履歴の一覧を読み込み中です。");
    executionListBusy.value = true;
    executionListFailure.value = undefined;
    const generation = executionGeneration;
    let cursor: Parameters<ProposalsApi["listExecutions"]>[0]["cursor"];
    try {
      while (true) {
        const request = proposalsContracts.listExecutions.request.parse({ limit: 100, ...(cursor == null ? {} : { cursor }) });
        const result = proposalsContracts.listExecutions.response.parse(await api.listExecutions(request));
        if (result.kind === "error") {
          if (!disposed) executionListFailure.value = result;
          return result;
        }
        if (disposed) return result;
        for (const execution of result.value.executions) receiveExecution(execution, generation);
        cursor = result.value.next_cursor;
        if (cursor == null) return result;
      }
    } finally {
      executionListBusy.value = false;
    }
  }

  async function getExecution(executionId: string): ReturnType<ProposalsApi["getExecution"]> {
    const request = proposalsContracts.getExecution.request.parse({ execution_id: executionId });
    if (executionRequestIds.value.includes(request.execution_id)) throw new Error("実行結果を読み込み中です。");
    executionRequestIds.value = [...executionRequestIds.value, request.execution_id];
    const generation = executionGeneration;
    try {
      const result = proposalsContracts.getExecution.response.parse(await api.getExecution(request.execution_id));
      if (disposed) return result;
      if (result.kind === "ok") receiveExecution(result.value, generation);
      else if ((receivedExecutionGenerations.get(request.execution_id) ?? 0) <= generation) {
        executionFailures.value = { ...executionFailures.value, [request.execution_id]: result };
      }
      return result;
    } finally {
      executionRequestIds.value = executionRequestIds.value.filter((id) => id !== request.execution_id);
    }
  }

  async function retryExecution(executionId: string): ReturnType<ProposalsApi["retryExecution"]> {
    const request = proposalsContracts.retryExecution.request.parse({ retry_of_execution_id: executionId });
    if (retryingExecutionIds.value.includes(request.retry_of_execution_id)) throw new Error("実行結果を再試行中です。");
    retryingExecutionIds.value = [...retryingExecutionIds.value, request.retry_of_execution_id];
    const generation = executionGeneration;
    try {
      const result = proposalsContracts.retryExecution.response.parse(await api.retryExecution(request.retry_of_execution_id));
      if (disposed) return result;
      if (result.kind === "ok") receiveExecution(result.value, generation);
      else executionFailures.value = { ...executionFailures.value, [request.retry_of_execution_id]: result };
      return result;
    } finally {
      retryingExecutionIds.value = retryingExecutionIds.value.filter((id) => id !== request.retry_of_execution_id);
    }
  }

  function handleDelta(value: AiDelta): boolean {
    if (disposed) return false;
    const delta = proposalsContracts.aiDelta.event.shape.value.parse(value);
    const session = sessionFor(delta.session_id);
    if (session == null) return false;
    if (session.state.kind === "turning" && session.activity === "turn") {
      replaceSession(delta.session_id, (current) => {
        if (current.state.kind !== "turning") return current;
        return { ...current, state: { ...current.state, buffered_deltas: [...current.state.buffered_deltas, delta] } };
      });
      return true;
    }
    if ((session.state.kind === "proposal" || session.state.kind === "questions")
      && session.state.turn_id === delta.turn_id) {
      replaceSession(delta.session_id, (current) => {
        if (current.state.kind !== "proposal" && current.state.kind !== "questions") return current;
        return { ...current, state: { ...current.state, text: current.state.text + delta.delta } };
      });
      return true;
    }
    return false;
  }

  async function initialize(): Promise<void> {
    if (initialized) throw new Error("変更案の購読は開始済みです。");
    initialized = true;
    const statusGeneration = aiStatusGeneration;
    const externalGeneration = externalStateGeneration;
    try {
      removeAiStatus = api.onAiStatus((value) => {
        if (disposed) return;
        aiStatus.value = proposalsContracts.aiStatus.event.shape.value.parse(value);
        aiStatusGeneration += 1;
        pendingSubscriptionFailures.delete("ai_status");
        aiStatusFailure.value = undefined;
      }, (failure) => handleSubscriptionFailure("ai_status", failure));
      removeAiDelta = api.onAiDelta((value) => {
        if (disposed) return;
        handleDelta(value);
        aiDeltaGeneration += 1;
        pendingSubscriptionFailures.delete("ai_delta");
        if (subscriptionFailure.value?.kind === "ai_delta") subscriptionFailure.value = undefined;
      }, (failure) => handleSubscriptionFailure("ai_delta", failure));
      removeExecution = api.onExecution((value) => {
        if (disposed) return;
        receiveExecution(value);
      }, (failure) => handleSubscriptionFailure("execution", failure));
      removeExternalState = api.onExternalState((value) => {
        if (disposed) return;
        applyExternalState(value);
      }, (failure) => handleSubscriptionFailure("external_state", failure));
    } catch (error) {
      disposed = true;
      removeSubscriptions();
      throw error;
    }
    const generation = lifecycleGeneration;
    const [statusResult, externalResult] = await Promise.all([
      api.getAiStatus(),
      api.getExternalState(),
      listExecutions(),
      history.load(),
    ]);
    if (disposed || generation !== lifecycleGeneration) return;
    const status = proposalsContracts.getAiStatus.response.parse(statusResult);
    if (statusGeneration === aiStatusGeneration) {
      aiStatusGeneration += 1;
      if (status.kind === "ok") {
        aiStatus.value = status.value;
        pendingSubscriptionFailures.delete("ai_status");
        aiStatusFailure.value = undefined;
      } else aiStatusFailure.value = status;
    }
    const external = proposalsContracts.getExternalState.response.parse(externalResult);
    if (externalGeneration === externalStateGeneration) {
      if (external.kind === "ok") applyExternalState(external.value);
      else {
        externalStateGeneration += 1;
        externalStateFailure.value = external;
      }
    }
  }

  async function startSession(): ReturnType<ProposalsApi["startSession"]> {
    const generation = lifecycleGeneration;
    const result = proposalsContracts.startSession.response.parse(await api.startSession());
    if (!disposed && generation === lifecycleGeneration && result.kind === "ok" && result.value.kind === "authentication_required") {
      aiStatusGeneration += 1;
      pendingSubscriptionFailures.delete("ai_status");
      aiStatus.value = { kind: "authentication_required" };
      aiStatusFailure.value = undefined;
    }
    if (!disposed && generation === lifecycleGeneration && result.kind === "ok" && result.value.kind === "started") {
      sessions.value = [...sessions.value, { session_id: result.value.session_id, state: { kind: "idle" }, activity: "idle", generation: 0 }];
    }
    return result;
  }

  async function refreshAiStatus(): ReturnType<ProposalsApi["getAiStatus"]> {
    const generation = aiStatusGeneration;
    const result = proposalsContracts.getAiStatus.response.parse(await api.getAiStatus());
    if (!disposed && generation === aiStatusGeneration) {
      aiStatusGeneration += 1;
      if (result.kind === "ok") {
        aiStatus.value = result.value;
        pendingSubscriptionFailures.delete("ai_status");
        aiStatusFailure.value = undefined;
      } else {
        aiStatus.value = undefined;
        aiStatusFailure.value = result;
      }
    }
    return result;
  }

  async function startTurn(input: Parameters<ProposalsApi["startTurn"]>[0]): ReturnType<ProposalsApi["startTurn"]> {
    const request = proposalsContracts.startTurn.request.parse(input);
    const generation = beginSessionRequest(request.session_id, "turn");
    replaceSession(request.session_id, (session) => {
      const pending = proposalFromState(session.state);
      return { ...session, state: { kind: "turning", buffered_deltas: [], ...(pending == null ? {} : { pending_proposal: pending }) } };
    });
    try {
      const result = proposalsContracts.startTurn.response.parse(await api.startTurn(request));
      if (!isCurrentSessionRequest(request.session_id, generation)) return result;
      const current = requireSession(request.session_id);
      if (current.state.kind !== "turning") throw new Error("AIターンの状態が一致しません。");
      const text = result.kind === "ok"
        ? current.state.buffered_deltas.filter((delta) => delta.turn_id === result.value.turn_id).map((delta) => delta.delta).join("")
        : "";
      if (result.kind === "error") {
        replaceSession(request.session_id, (session) => {
          const pending = proposalFromState(session.state);
          return { ...session, state: { kind: "failed", failure: result, ...(pending == null ? {} : { pending_proposal: pending }) } };
        });
      } else if (result.value.kind === "proposal") {
        const turn = result.value;
        replaceSession(request.session_id, (session) => ({ ...session, state: {
          kind: "proposal",
          message: turn.message,
          questions: turn.questions,
          proposal: proposalViewSchema.parse(turn.proposal),
          turn_id: turn.turn_id,
          text,
        } }));
      } else {
        const pending = result.value.pending_proposal_action === "keep" ? current.state.pending_proposal : undefined;
        replaceSession(request.session_id, (session) => ({ ...session, state: {
          kind: "questions",
          message: result.value.message,
          questions: result.value.questions,
          ...(pending == null ? {} : { pending_proposal: pending }),
          turn_id: result.value.turn_id,
          text,
        } }));
      }
      return result;
    } catch (error) {
      if (isCurrentSessionRequest(request.session_id, generation)) {
        replaceSession(request.session_id, (session) => {
          if (session.state.kind !== "turning") return session;
          const pending = session.state.pending_proposal;
          return { ...session, state: { kind: "idle", ...(pending == null ? {} : { pending_proposal: pending }) } };
        });
      }
      throw error;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  async function getProposal(input: Parameters<ProposalsApi["getProposal"]>[0]): ReturnType<ProposalsApi["getProposal"]> {
    const request = proposalsContracts.getProposal.request.parse(input);
    const generation = beginSessionRequest(request.session_id, "get");
    try {
      const result = proposalsContracts.getProposal.response.parse(await api.getProposal(request));
      if (isCurrentSessionRequest(request.session_id, generation) && result.kind === "ok") {
        replaceSession(request.session_id, (session) => ({ ...session, state: withProposal(session.state, result.value) }));
      }
      return result;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  async function select(input: Parameters<ProposalsApi["select"]>[0]): ReturnType<ProposalsApi["select"]> {
    const request = proposalsContracts.select.request.parse(input);
    const generation = beginSessionRequest(request.session_id, "select");
    try {
      const result = proposalsContracts.select.response.parse(await api.select(request));
      if (isCurrentSessionRequest(request.session_id, generation) && result.kind === "ok") {
        replaceSession(request.session_id, (session) => ({ ...session, state: withProposal(session.state, result.value) }));
      }
      return result;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  async function editOperation(input: Parameters<ProposalsApi["editOperation"]>[0]): ReturnType<ProposalsApi["editOperation"]> {
    const request = proposalsContracts.editOperation.request.parse(input);
    const generation = beginSessionRequest(request.session_id, "edit");
    try {
      const result = proposalsContracts.editOperation.response.parse(await api.editOperation(request));
      if (isCurrentSessionRequest(request.session_id, generation) && result.kind === "ok") {
        replaceSession(request.session_id, (session) => ({ ...session, state: withProposal(session.state, result.value) }));
      }
      return result;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  async function reject(input: Parameters<ProposalsApi["reject"]>[0]): ReturnType<ProposalsApi["reject"]> {
    const request = proposalsContracts.reject.request.parse(input);
    const generation = beginSessionRequest(request.session_id, "reject");
    try {
      const result = proposalsContracts.reject.response.parse(await api.reject(request));
      if (isCurrentSessionRequest(request.session_id, generation) && result.kind === "ok") {
        replaceSession(request.session_id, (session) => ({ ...session, state: { kind: "idle" } }));
      }
      return result;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  async function approve(input: Parameters<ProposalsApi["approve"]>[0]): ReturnType<ProposalsApi["approve"]> {
    const request = proposalsContracts.approve.request.parse(input);
    const generation = beginSessionRequest(request.session_id, "approve");
    const executionRequestGeneration = executionGeneration;
    try {
      const result = proposalsContracts.approve.response.parse(await api.approve(request));
      if (isCurrentSessionRequest(request.session_id, generation) && result.kind === "ok") {
        if (result.value.kind === "execution") receiveExecution(result.value.execution, executionRequestGeneration);
        replaceSession(request.session_id, (session) => ({ ...session, state: { kind: "approved", result: result.value } }));
      }
      return result;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  async function closeSession(sessionId: string): ReturnType<ProposalsApi["closeSession"]> {
    const request = proposalsContracts.closeSession.request.parse({ session_id: sessionId });
    const generation = beginSessionRequest(request.session_id, "close");
    try {
      const result = proposalsContracts.closeSession.response.parse(await api.closeSession(request.session_id));
      if (isCurrentSessionRequest(request.session_id, generation) && result.kind === "ok") {
        sessions.value = sessions.value.filter((session) => session.session_id !== request.session_id);
      }
      return result;
    } finally {
      finishSessionRequest(request.session_id, generation);
    }
  }

  function selectExternalProposal(proposalId: string | undefined): void {
    if (proposalId != null && (externalState.value == null || !externalState.value.proposals.some((proposal) => proposal.proposal_id === proposalId))) {
      throw new Error("外部変更案が見つかりません。");
    }
    selectedExternalProposalId.value = proposalId;
  }

  async function setExternalEnabled(enabled: boolean): ReturnType<ProposalsApi["setExternalEnabled"]> {
    const request = proposalsContracts.setExternalEnabled.request.parse({ enabled });
    const generation = externalStateGeneration;
    const result = proposalsContracts.setExternalEnabled.response.parse(await api.setExternalEnabled(request.enabled));
    if (!disposed && generation === externalStateGeneration && result.kind === "ok") applyExternalState(result.value);
    return result;
  }

  async function editExternalOperation(input: Parameters<ProposalsApi["editExternalOperation"]>[0]): ReturnType<ProposalsApi["editExternalOperation"]> {
    const request = proposalsContracts.editExternalOperation.request.parse(input);
    const generation = externalStateGeneration;
    const result = proposalsContracts.editExternalOperation.response.parse(await api.editExternalOperation(request));
    if (!disposed && generation === externalStateGeneration && result.kind === "ok") applyExternalState(result.value);
    return result;
  }

  async function selectExternal(input: Parameters<ProposalsApi["selectExternal"]>[0]): ReturnType<ProposalsApi["selectExternal"]> {
    const request = proposalsContracts.selectExternal.request.parse(input);
    const generation = externalStateGeneration;
    const result = proposalsContracts.selectExternal.response.parse(await api.selectExternal(request));
    if (!disposed && generation === externalStateGeneration && result.kind === "ok") applyExternalState(result.value);
    return result;
  }

  async function approveExternal(input: Parameters<ProposalsApi["approveExternal"]>[0]): ReturnType<ProposalsApi["approveExternal"]> {
    const request = proposalsContracts.approveExternal.request.parse(input);
    const generation = executionGeneration;
    const result = proposalsContracts.approveExternal.response.parse(await api.approveExternal(request));
    if (!disposed && result.kind === "ok" && result.value.kind === "execution") receiveExecution(result.value.execution, generation);
    return result;
  }

  async function rejectExternal(input: Parameters<ProposalsApi["rejectExternal"]>[0]): ReturnType<ProposalsApi["rejectExternal"]> {
    const request = proposalsContracts.rejectExternal.request.parse(input);
    const generation = externalStateGeneration;
    const result = proposalsContracts.rejectExternal.response.parse(await api.rejectExternal(request));
    if (!disposed && generation === externalStateGeneration && result.kind === "ok") applyExternalState(result.value);
    return result;
  }

  return {
    history,
    aiStatus,
    aiStatusFailure,
    sessions,
    externalState,
    externalStateFailure,
    executions,
    executionListFailure,
    executionFailures,
    subscriptionFailure,
    executionListBusy,
    executionRequestIds,
    retryingExecutionIds,
    selectedExternalProposalId,
    selectedExternalProposal,
    initialize,
    refreshAiStatus,
    startSession,
    startTurn,
    getProposal,
    select,
    editOperation,
    reject,
    approve,
    closeSession,
    selectExternalProposal,
    setExternalEnabled,
    editExternalOperation,
    selectExternal,
    approveExternal,
    listExecutions,
    getExecution,
    retryExecution,
    latestExecutionFor,
    rejectExternal,
  };
}
