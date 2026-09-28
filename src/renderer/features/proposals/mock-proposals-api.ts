import { executionDtoSchema, type ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { ipcFailureSchema, type IpcResult } from "../../../shared/ipc-contracts/common";
import { externalProposalStateSchema } from "../../../shared/ipc-contracts/external-proposal-state";
import { proposalsContracts, type ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import { proposalSelectionSchema, proposalViewSchema, type ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import type { z } from "zod";
import { createMockProposalView, editMockProposalView } from "./mock-proposal-data";

type ExternalState = z.infer<typeof externalProposalStateSchema>;
type Selection = Parameters<ProposalsApi["select"]>[0]["selection"];
type Session = { readonly session_id: string; proposal: ProposalViewDto | undefined };
type ExternalProposal = ExternalState["proposals"][number];

function ok<Value>(value: Value): IpcResult<Value> {
  return { kind: "ok", value };
}

function failure(code: "not_found" | "conflict" | "invalid_request", message: string) {
  return ipcFailureSchema.parse({ kind: "error", code, message });
}

function selectedIds(view: ProposalViewDto, selection: Selection): readonly string[] | undefined {
  const parsed = proposalSelectionSchema.parse(selection);
  const knownGroupIds = new Set(view.groups.map((group) => group.group_id));
  const knownOperationIds = new Set(view.groups.flatMap((group) => group.operations.map((operation) => operation.operation_id)));
  if (parsed.kind === "groups" && parsed.group_ids.some((id) => !knownGroupIds.has(id))) return undefined;
  if (parsed.kind === "operations" && parsed.operation_ids.some((id) => !knownOperationIds.has(id))) return undefined;
  if (parsed.kind === "all") return [...knownOperationIds];
  if (parsed.kind === "groups") return view.groups.filter((group) => parsed.group_ids.includes(group.group_id))
    .flatMap((group) => group.operations.map((operation) => operation.operation_id));
  const requested = new Set(parsed.operation_ids);
  return view.groups.flatMap((group) => group.operations
    .filter((operation) => requested.has(operation.operation_id) || group.atomic && group.operations.some((member) => requested.has(member.operation_id)))
    .map((operation) => operation.operation_id));
}

function withSelection(view: ProposalViewDto, operationIds: readonly string[]): ProposalViewDto {
  return proposalViewSchema.parse({ ...view, selected_operation_ids: operationIds });
}

function withRevision(view: ProposalViewDto, revision: number): ProposalViewDto {
  return proposalViewSchema.parse({ ...view, revision });
}

function compareExecutionOrder(left: ExecutionDto, right: ExecutionDto): number {
  if (left.created_at !== right.created_at) return left.created_at < right.created_at ? -1 : 1;
  if (left.execution_id === right.execution_id) return 0;
  return left.execution_id < right.execution_id ? -1 : 1;
}

/** 17操作の生成、表示、編集、選択、承認を同じ状態で扱うmockを作成します。 */
export function createMockProposalsApi(): ProposalsApi {
  const sessions = new Map<string, Session>();
  const executions = new Map<string, { readonly execution: ExecutionDto; readonly rowid: number }>();
  const aiStatus = proposalsContracts.getAiStatus.response.parse(ok({ kind: "ready", model: "mock-model" }));
  if (aiStatus.kind !== "ok") throw new Error("mockのAI状態を作成できません。");
  const aiStatusListeners = new Set<Parameters<ProposalsApi["onAiStatus"]>[0]>();
  const aiDeltaListeners = new Set<Parameters<ProposalsApi["onAiDelta"]>[0]>();
  const externalListeners = new Set<Parameters<ProposalsApi["onExternalState"]>[0]>();
  const executionListeners = new Set<Parameters<ProposalsApi["onExecution"]>[0]>();
  let nextSessionNumber = 1;
  let nextTurnNumber = 1;
  let nextExecutionNumber = 1;
  let externalState = externalProposalStateSchema.parse({
    enabled: true,
    bridge: { kind: "running" },
    registration: {
      command: "taskhub external-agent register",
      allow_execution_command: "taskhub external-agent register --allow-execution",
      instructions: "画面確認用の外部連携です。",
    },
    proposals: [{
      proposal_id: "mock-external-proposal",
      request_id: "mock-external-request",
      revision: 1,
      state: { kind: "pending_approval" },
      view: createMockProposalView("mock-external-proposal", 1),
    }],
    review_target: { proposal_id: "mock-external-proposal", request_id: "mock-external-request" },
  });

  function sessionFor(sessionId: string, proposalId?: string): Session | undefined {
    const session = sessions.get(sessionId);
    if (session == null) return undefined;
    if (proposalId != null && session.proposal?.proposal_id !== proposalId) return undefined;
    return session;
  }

  function externalProposalFor(proposalId: string, revision: number): ExternalProposal | "conflict" | undefined {
    const proposal = externalState.proposals.find((candidate) => candidate.proposal_id === proposalId);
    if (proposal == null) return undefined;
    return proposal.revision === revision ? proposal : "conflict";
  }

  function publishExternal(next: unknown): void {
    externalState = externalProposalStateSchema.parse(next);
    for (const listener of externalListeners) listener(externalState);
  }

  function replaceExternal(proposal: ExternalProposal): void {
    publishExternal({ ...externalState, proposals: externalState.proposals.map((candidate) =>
      candidate.proposal_id === proposal.proposal_id ? proposal : candidate) });
  }

  function createExecution(view: ProposalViewDto, operationIds: readonly string[], retryOfExecutionId?: string): ExecutionDto {
    const selected = new Set(operationIds);
    const groups = view.groups.map((group) => ({ ...group, operations: group.operations.filter((operation) => selected.has(operation.operation_id)) }))
      .filter((group) => group.operations.length > 0);
    const stepKinds = {
      create_task: "asana_create_task",
      update_title: "asana_update_task",
      update_notes: "asana_update_task",
      set_status: "asana_add_to_section",
      set_importance: "asana_add_tag",
      set_due: "asana_update_task",
      clear_due: "asana_update_task",
      set_duration: "asana_merge_external_data",
      clear_duration: "asana_merge_external_data",
      set_area: "asana_add_tag",
      set_dependencies: "asana_merge_external_data",
      set_parent: "asana_set_parent",
      set_parent_work_mode: "asana_merge_external_data",
      link_obsidian: "asana_merge_external_data",
      unlink_obsidian: "asana_merge_external_data",
      complete: "asana_update_task",
      withdraw: "asana_update_task",
    } satisfies Record<ProposalViewDto["groups"][number]["operations"][number]["operation"], ExecutionDto["steps"][number]["kind"]>;
    const updatedAt = "2026-09-28T00:00:00.000Z";
    const execution = executionDtoSchema.parse({
      origin: "proposal",
      execution_id: `mock-proposal-execution-${nextExecutionNumber++}`,
      ...(retryOfExecutionId == null ? {} : { retry_of_execution_id: retryOfExecutionId }),
      proposal_id: view.proposal_id,
      created_at: updatedAt,
      updated_at: updatedAt,
      state: "succeeded",
      steps: [
        ...groups.flatMap((group) => group.operations.map((operation) => ({
          step_id: `mock-step-${operation.operation_id}`,
          scope: { kind: "operation", operation_id: operation.operation_id },
          kind: stepKinds[operation.operation],
          state: "succeeded",
          attempt: 1,
          updated_at: updatedAt,
        }))),
        { step_id: "mock-step-synchronize", scope: { kind: "execution" }, kind: "local_synchronize",
          state: "succeeded", attempt: 1, updated_at: updatedAt },
      ],
      operation_results: groups.flatMap((group) => group.operations.map((operation) => ({
        operation_id: operation.operation_id,
        group_id: group.group_id,
        outcome: "applied",
        reason_code: "mock_applied",
      }))),
      group_results: groups.map((group) => ({
        group_id: group.group_id,
        atomic: group.atomic,
        operation_ids: group.operations.map((operation) => operation.operation_id),
        outcome: "applied",
      })),
    });
    executions.set(execution.execution_id, { execution, rowid: executions.size + 1 });
    for (const listener of executionListeners) listener(execution);
    return execution;
  }

  return {
    getAiStatus: () => Promise.resolve(proposalsContracts.getAiStatus.response.parse(ok(aiStatus.value))),
    startSession: () => Promise.resolve().then(() => {
      const sessionId = `mock-session-${nextSessionNumber++}`;
      sessions.set(sessionId, { session_id: sessionId, proposal: undefined });
      return proposalsContracts.startSession.response.parse(ok({ kind: "started", session_id: sessionId }));
    }),
    startTurn: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.startTurn.request.parse(input);
      const session = sessions.get(request.session_id);
      if (session == null) return failure("not_found", "AIセッションが見つかりません。");
      const delta = proposalsContracts.aiDelta.event.shape.value.parse({
        session_id: session.session_id,
        thread_id: `mock-thread-${session.session_id}`,
        turn_id: `mock-turn-${session.session_id}-${nextTurnNumber++}`,
        item_id: "mock-item",
        delta: "画面確認用の変更案を作成しています。",
      });
      for (const listener of aiDeltaListeners) listener(delta);
      const view = createMockProposalView(`mock-proposal-${session.session_id}`, undefined);
      session.proposal = view;
      return proposalsContracts.startTurn.response.parse(ok({
        kind: "proposal",
        turn_id: delta.turn_id,
        message: "画面確認用の変更案を作成しました。",
        questions: [],
        proposal: view,
        retry_count: 0,
      }));
    }),
    getProposal: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.getProposal.request.parse(input);
      const session = sessionFor(request.session_id, request.proposal_id);
      if (session?.proposal == null) return failure("not_found", "AI変更案が見つかりません。");
      return proposalsContracts.getProposal.response.parse(ok(session.proposal));
    }),
    select: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.select.request.parse(input);
      const session = sessionFor(request.session_id, request.proposal_id);
      if (session?.proposal == null) return failure("not_found", "AI変更案が見つかりません。");
      const ids = selectedIds(session.proposal, request.selection);
      if (ids == null) return failure("invalid_request", "指定した操作が変更案にありません。");
      session.proposal = withSelection(session.proposal, ids);
      return proposalsContracts.select.response.parse(ok(session.proposal));
    }),
    editOperation: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.editOperation.request.parse(input);
      const session = sessionFor(request.session_id, request.proposal_id);
      if (session?.proposal == null) return failure("not_found", "AI変更案が見つかりません。");
      if (!session.proposal.groups.some((group) => group.operations.some((operation) =>
        operation.operation_id === request.operation_id && operation.operation === request.operation))) {
        return failure("invalid_request", "編集対象の操作種別が一致しません。");
      }
      session.proposal = editMockProposalView(session.proposal, request.operation_id, request.operation, request.after, request.evidence_locator, "user_message");
      return proposalsContracts.editOperation.response.parse(ok(session.proposal));
    }),
    reject: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.reject.request.parse(input);
      const session = sessionFor(request.session_id, request.proposal_id);
      if (session?.proposal == null) return failure("not_found", "AI変更案が見つかりません。");
      session.proposal = undefined;
      return proposalsContracts.reject.response.parse(ok({ completed: true }));
    }),
    approve: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.approve.request.parse(input);
      const session = sessionFor(request.session_id, request.proposal_id);
      if (session?.proposal == null) return failure("not_found", "AI変更案が見つかりません。");
      const ids = selectedIds(session.proposal, request.selection);
      if (ids == null || ids.length === 0) return failure("invalid_request", "適用する操作を選択してください。");
      const execution = createExecution(session.proposal, ids);
      session.proposal = undefined;
      return proposalsContracts.approve.response.parse(ok({ kind: "execution", execution }));
    }),
    closeSession: (sessionId) => Promise.resolve().then(() => {
      const request = proposalsContracts.closeSession.request.parse({ session_id: sessionId });
      if (!sessions.delete(request.session_id)) return failure("not_found", "AIセッションが見つかりません。");
      return proposalsContracts.closeSession.response.parse(ok({ completed: true }));
    }),
    getExternalState: () => Promise.resolve(proposalsContracts.getExternalState.response.parse(ok(externalState))),
    setExternalEnabled: (enabled) => Promise.resolve().then(() => {
      const request = proposalsContracts.setExternalEnabled.request.parse({ enabled });
      publishExternal({ ...externalState, enabled: request.enabled });
      return proposalsContracts.setExternalEnabled.response.parse(ok(externalState));
    }),
    editExternalOperation: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.editExternalOperation.request.parse(input);
      const proposal = externalProposalFor(request.proposal_id, request.revision);
      if (proposal == null) return failure("not_found", "外部変更案が見つかりません。");
      if (proposal === "conflict") return failure("conflict", "外部変更案の表示版が変わりました。");
      if (proposal.state.kind !== "pending_approval") return failure("conflict", "外部変更案を編集できません。");
      if (!proposal.view.groups.some((group) => group.operations.some((operation) =>
        operation.operation_id === request.operation_id && operation.operation === request.operation))) {
        return failure("invalid_request", "編集対象の操作種別が一致しません。");
      }
      const revision = proposal.revision + 1;
      const view = withRevision(editMockProposalView(proposal.view, request.operation_id, request.operation, request.after, request.evidence_locator, "external_review"), revision);
      replaceExternal({ ...proposal, revision, view });
      return proposalsContracts.editExternalOperation.response.parse(ok(externalState));
    }),
    selectExternal: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.selectExternal.request.parse(input);
      const proposal = externalProposalFor(request.proposal_id, request.revision);
      if (proposal == null) return failure("not_found", "外部変更案が見つかりません。");
      if (proposal === "conflict") return failure("conflict", "外部変更案の表示版が変わりました。");
      if (proposal.state.kind !== "pending_approval") return failure("conflict", "外部変更案を選択できません。");
      const ids = selectedIds(proposal.view, request.selection);
      if (ids == null) return failure("invalid_request", "指定した操作が変更案にありません。");
      const revision = proposal.revision + 1;
      replaceExternal({ ...proposal, revision, view: withRevision(withSelection(proposal.view, ids), revision) });
      return proposalsContracts.selectExternal.response.parse(ok(externalState));
    }),
    approveExternal: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.approveExternal.request.parse(input);
      const proposal = externalProposalFor(request.proposal_id, request.revision);
      if (proposal == null) return failure("not_found", "外部変更案が見つかりません。");
      if (proposal === "conflict") return failure("conflict", "外部変更案の表示版が変わりました。");
      if (proposal.state.kind !== "pending_approval") return failure("conflict", "外部変更案を承認できません。");
      const ids = selectedIds(proposal.view, request.selection);
      if (ids == null || ids.length === 0) return failure("invalid_request", "適用する操作を選択してください。");
      const execution = createExecution(proposal.view, ids);
      replaceExternal({ ...proposal, state: { kind: "finished", outcome: "applied", execution_id: execution.execution_id } });
      return proposalsContracts.approveExternal.response.parse(ok({ kind: "execution", execution }));
    }),
    rejectExternal: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.rejectExternal.request.parse(input);
      const proposal = externalProposalFor(request.proposal_id, request.revision);
      if (proposal == null) return failure("not_found", "外部変更案が見つかりません。");
      if (proposal === "conflict") return failure("conflict", "外部変更案の表示版が変わりました。");
      if (proposal.state.kind !== "pending_approval") return failure("conflict", "外部変更案を却下できません。");
      replaceExternal({ ...proposal, state: { kind: "rejected" } });
      return proposalsContracts.rejectExternal.response.parse(ok(externalState));
    }),
    getHistoryStatus: () => Promise.resolve(proposalsContracts.getHistoryStatus.response.parse(ok({ entries: [] }))),
    confirmHistory: (input) => Promise.resolve().then(() => {
      proposalsContracts.confirmHistory.request.parse(input);
      return failure("not_found", "確認対象の履歴がありません。");
    }),
    synchronizeHistory: () => Promise.resolve(proposalsContracts.synchronizeHistory.response.parse(ok({ status: { entries: [] }, synced_at: "2026-09-28T00:00:00.000Z" }))),
    getExecution: (executionId) => Promise.resolve().then(() => {
      const request = proposalsContracts.getExecution.request.parse({ execution_id: executionId });
      const execution = executions.get(request.execution_id)?.execution;
      return execution == null ? failure("not_found", "実行履歴が見つかりません。") : proposalsContracts.getExecution.response.parse(ok(execution));
    }),
    listExecutions: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.listExecutions.request.parse(input);
      const cursor = request.cursor;
      const snapshotMaxRowid = cursor?.snapshot_max_rowid ?? executions.size;
      const ordered = [...executions.values()]
        .filter((entry) => entry.rowid <= snapshotMaxRowid)
        .sort((left, right) => compareExecutionOrder(left.execution, right.execution));
      const afterCursor = cursor == null
        ? ordered
        : ordered.filter((entry) => entry.execution.created_at > cursor.created_at
          || entry.execution.created_at === cursor.created_at
            && entry.execution.execution_id > cursor.execution_id);
      const rows = afterCursor.slice(0, request.limit + 1);
      const pageRows = rows.slice(0, request.limit);
      const last = pageRows[pageRows.length - 1];
      const pageExecutions = pageRows.map((entry) => entry.execution);
      if (rows.length <= request.limit) {
        return proposalsContracts.listExecutions.response.parse(ok({ executions: pageExecutions }));
      }
      if (last == null) throw new Error("mockの最終executionがありません。");
      return proposalsContracts.listExecutions.response.parse(ok({
        executions: pageExecutions,
        next_cursor: {
          snapshot_max_rowid: snapshotMaxRowid,
          created_at: last.execution.created_at,
          execution_id: last.execution.execution_id,
        },
      }));
    }),
    retryExecution: (retryOfExecutionId) => Promise.resolve().then(() => {
      const request = proposalsContracts.retryExecution.request.parse({ retry_of_execution_id: retryOfExecutionId });
      const previous = executions.get(request.retry_of_execution_id)?.execution;
      if (previous == null) return failure("not_found", "再試行元の実行履歴が見つかりません。");
      const execution = executionDtoSchema.parse({ ...previous, execution_id: `mock-proposal-execution-${nextExecutionNumber++}`, retry_of_execution_id: request.retry_of_execution_id });
      executions.set(execution.execution_id, { execution, rowid: executions.size + 1 });
      for (const listener of executionListeners) listener(execution);
      return proposalsContracts.retryExecution.response.parse(ok(execution));
    }),
    onAiStatus: (listener) => {
      aiStatusListeners.add(listener);
      listener(aiStatus.value);
      return () => { aiStatusListeners.delete(listener); };
    },
    onAiDelta: (listener) => {
      aiDeltaListeners.add(listener);
      return () => { aiDeltaListeners.delete(listener); };
    },
    onExternalState: (listener) => {
      externalListeners.add(listener);
      listener(externalState);
      return () => { externalListeners.delete(listener); };
    },
    onExecution: (listener) => {
      executionListeners.add(listener);
      return () => { executionListeners.delete(listener); };
    },
  };
}
