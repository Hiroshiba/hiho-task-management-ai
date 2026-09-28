import { executionDtoSchema, type ExecutionDto } from "../../../shared/ipc-contracts/execution";
import { ipcFailureSchema, type IpcResult } from "../../../shared/ipc-contracts/common";
import { externalProposalStateSchema } from "../../../shared/ipc-contracts/external-proposal-state";
import { proposalsContracts, type ProposalsApi } from "../../../shared/ipc-contracts/proposals";
import { proposalSelectionSchema, proposalViewSchema, type ProposalViewDto } from "../../../shared/ipc-contracts/proposal-values";
import type { z } from "zod";
import { createMockProposalView, editMockProposalView } from "./mock-proposal-data";

type ExternalState = z.infer<typeof externalProposalStateSchema>;
type Selection = Parameters<ProposalsApi["select"]>[0]["selection"];
type ApprovalResult = Extract<Awaited<ReturnType<ProposalsApi["approve"]>>, { readonly kind: "ok" }>["value"];
type Session = { readonly session_id: string; proposal: ProposalViewDto | undefined; approved_proposal_id?: string };
type ExternalProposal = ExternalState["proposals"][number];
type HistoryStatus = Extract<Awaited<ReturnType<ProposalsApi["getHistoryStatus"]>>, { readonly kind: "ok" }>["value"];
type HistoryConfirmInput = Parameters<ProposalsApi["confirmHistory"]>[0];
type HistorySource = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly target_id: string;
  readonly target_kind: "task" | "temporary" | "new_task";
  readonly source_stage: string;
  readonly source_final_result: "unknown" | null;
};
type HistoryRecord =
  | { readonly kind: "required"; readonly source: HistorySource }
  | { readonly kind: "confirmed" | "synchronized"; readonly source: HistorySource; readonly confirmed_result: HistoryConfirmInput["confirmed_result"] }
  | { readonly kind: "invalid"; readonly proposal_id: string; readonly operation_id: string; readonly error_id: string };

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

/** 17操作、保存済み実行、旧非実行履歴を独立した状態で扱うmockを作成します。 */
export function createMockProposalsApi(
  historyScenario: "confirmable" | "invalid",
  onHistorySynchronized: (syncedAt: string) => void,
): ProposalsApi {
  const sessions = new Map<string, Session>();
  const executions = new Map<string, { readonly execution: ExecutionDto; readonly rowid: number }>();
  const approvals = new Map<string, ApprovalResult>();
  let historyRecords: readonly HistoryRecord[] = [
    { kind: "required", source: {
      proposal_id: "mock-legacy-proposal-1", operation_id: "mock-legacy-operation-1",
      target_id: "mock-task-1", target_kind: "task", source_stage: "applying", source_final_result: "unknown",
    } },
    { kind: "required", source: {
      proposal_id: "mock-legacy-proposal-2", operation_id: "mock-legacy-operation-2",
      target_id: "mock-temporary-2", target_kind: "temporary", source_stage: "planned", source_final_result: null,
    } },
    { kind: "confirmed", source: {
      proposal_id: "mock-legacy-proposal-3", operation_id: "mock-legacy-operation-3",
      target_id: "mock-created-3", target_kind: "new_task", source_stage: "finished", source_final_result: "unknown",
    }, confirmed_result: "manually_adjusted" },
    ...(historyScenario === "invalid" ? [{
      kind: "invalid", proposal_id: "mock-legacy-proposal-invalid",
      operation_id: "mock-legacy-operation-invalid", error_id: "00000000-0000-4000-8000-000000000044",
    } satisfies HistoryRecord] : []),
  ];
  let historySyncedAt: string | undefined;
  const aiStatus = proposalsContracts.getAiStatus.response.parse(ok({ kind: "ready", model: "mock-model" }));
  if (aiStatus.kind !== "ok") throw new Error("mockのAI状態を作成できません。");
  const aiStatusListeners = new Set<Parameters<ProposalsApi["onAiStatus"]>[0]>();
  const aiDeltaListeners = new Set<Parameters<ProposalsApi["onAiDelta"]>[0]>();
  const externalListeners = new Set<Parameters<ProposalsApi["onExternalState"]>[0]>();
  const executionListeners = new Set<Parameters<ProposalsApi["onExecution"]>[0]>();
  let nextSessionNumber = 1;
  let nextTurnNumber = 1;
  let nextExecutionNumber = 1;
  let nextEventNumber = 1;
  let nextErrorNumber = 1;
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

  function historyStatus(): HistoryStatus {
    const entries: HistoryStatus["entries"] = [];
    for (const record of historyRecords) {
      if (record.kind === "synchronized") continue;
      if (record.kind === "invalid") {
        entries.push({
          kind: "history_invalid", proposal_id: record.proposal_id,
          operation_id: record.operation_id, error_id: record.error_id,
        });
      } else if (record.kind === "confirmed") {
        entries.push({
          kind: "synchronization_required", proposal_id: record.source.proposal_id,
          operation_id: record.source.operation_id, target_id: record.source.target_id,
          target_kind: record.source.target_kind, confirmed_result: record.confirmed_result,
        });
      } else {
        entries.push({ kind: "confirmation_required", ...record.source });
      }
    }
    return { entries };
  }

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

  function timestamp(): string {
    return new Date(Date.UTC(2026, 8, 28, 0, 0, nextEventNumber++)).toISOString();
  }

  function publishExecution(execution: ExecutionDto): void {
    const existing = executions.get(execution.execution_id);
    executions.set(execution.execution_id, { execution, rowid: existing?.rowid ?? executions.size + 1 });
    for (const listener of executionListeners) listener(execution);
  }

  function finishExecution(executionId: string, result: "succeeded" | "failed" | "confirmation_required"): void {
    const current = executions.get(executionId)?.execution;
    if (current == null) throw new Error("mockの実行履歴が見つかりません。");
    const updatedAt = timestamp();
    const errorId = `00000000-0000-4000-8000-${String(nextErrorNumber++).padStart(12, "0")}`;
    const stoppedIndex = current.steps.findIndex((step) => step.state !== "succeeded");
    const stoppedStep = current.steps[stoppedIndex];
    if (stoppedStep == null) throw new Error("mockの停止対象工程が見つかりません。");
    const steps = current.steps.map((step, index) => {
      if (step.state === "succeeded") return step;
      if (result !== "succeeded" && index === stoppedIndex) {
        return { ...step, state: result, attempt: 1, updated_at: updatedAt, error_id: errorId };
      }
      if (result !== "succeeded") return step;
      return { ...step, state: "succeeded", attempt: 1, updated_at: updatedAt };
    });
    const operationResults = current.operation_results.map((operation) => {
      const step = steps.find((candidate) => candidate.scope.kind === "operation" && candidate.scope.operation_id === operation.operation_id);
      if (step?.state === "succeeded" && result !== "succeeded") {
        return { ...operation, outcome: "applied", reason_code: "mock_applied" };
      }
      if (result === "succeeded") return { ...operation, outcome: "applied", reason_code: "mock_applied" };
      if (step?.state === result) return { ...operation, outcome: "unknown", reason_code: "mock_result_unknown" };
      return operation;
    });
    const groupResults = current.group_results.map((group) => ({ ...group,
      outcome: result === "succeeded" ? "applied" : "unknown" }));
    publishExecution(executionDtoSchema.parse({ ...current, state: result, updated_at: updatedAt, steps,
      operation_results: operationResults, group_results: groupResults,
      ...(result === "succeeded" ? {} : { error_id: errorId }),
    }));
    const externalProposal = externalState.proposals.find((proposal) =>
      proposal.proposal_id === current.proposal_id && proposal.state.kind === "approving");
    if (externalProposal != null) {
      const revision = externalProposal.revision + 1;
      replaceExternal({ ...externalProposal, revision, view: withRevision(externalProposal.view, revision),
        state: { kind: "finished", outcome: result === "succeeded" ? "applied" : "unknown", execution_id: executionId } });
    }
  }

  function progressExecution(executionId: string, result: "succeeded" | "failed" | "confirmation_required"): void {
    const current = executions.get(executionId)?.execution;
    if (current == null) throw new Error("mockの実行履歴が見つかりません。");
    const updatedAt = timestamp();
    let running = false;
    const steps = current.steps.map((step) => {
      if (running || step.state === "succeeded") return step;
      running = true;
      return { ...step, state: "running", attempt: 1, updated_at: updatedAt };
    });
    publishExecution(executionDtoSchema.parse({ ...current, state: "running", updated_at: updatedAt, steps }));
    setTimeout(() => finishExecution(executionId, result), 150);
  }

  function scheduleExecution(execution: ExecutionDto, result: "succeeded" | "failed" | "confirmation_required"): void {
    publishExecution(execution);
    setTimeout(() => progressExecution(execution.execution_id, result), 30);
  }

  function executionResult(operationIds: readonly string[]): "succeeded" | "failed" | "confirmation_required" {
    if (operationIds.some((id) => id.endsWith("-set_dependencies"))) return "confirmation_required";
    if (operationIds.some((id) => id.endsWith("-set_duration"))) return "failed";
    return "succeeded";
  }

  function createExecution(view: ProposalViewDto, operationIds: readonly string[]): ExecutionDto {
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
    const updatedAt = timestamp();
    const execution = executionDtoSchema.parse({
      origin: "proposal",
      execution_id: `mock-proposal-execution-${nextExecutionNumber++}`,
      proposal_id: view.proposal_id,
      created_at: updatedAt,
      updated_at: updatedAt,
      state: "planned",
      steps: [
        ...groups.flatMap((group) => group.operations.map((operation) => ({
          step_id: `mock-step-${operation.operation_id}`,
          scope: { kind: "operation", operation_id: operation.operation_id },
          kind: stepKinds[operation.operation],
          state: "planned",
          attempt: 0,
          updated_at: updatedAt,
        }))),
        { step_id: "mock-step-synchronize", scope: { kind: "execution" }, kind: "local_synchronize",
          state: "planned", attempt: 0, updated_at: updatedAt },
      ],
      operation_results: groups.flatMap((group) => group.operations.map((operation) => ({
        operation_id: operation.operation_id,
        group_id: group.group_id,
        outcome: "pending",
      }))),
      group_results: groups.map((group) => ({
        group_id: group.group_id,
        atomic: group.atomic,
        operation_ids: group.operations.map((operation) => operation.operation_id),
        outcome: "pending",
      })),
    });
    scheduleExecution(execution, executionResult(operationIds));
    return execution;
  }

  function approvalFor(view: ProposalViewDto, operationIds: readonly string[]): ApprovalResult {
    if (operationIds.every((id) => id.endsWith("-clear_due"))) {
      const selected = new Set(operationIds);
      const groups = view.groups.map((group) => ({ ...group,
        operations: group.operations.filter((operation) => selected.has(operation.operation_id)) }))
        .filter((group) => group.operations.length > 0);
      const result = proposalsContracts.approve.response.parse(ok({
        kind: "not_started",
        proposal_id: view.proposal_id,
        outcome: "already_applied",
        operation_results: groups.flatMap((group) => group.operations.map((operation) => ({
          group_id: group.group_id,
          operation_id: operation.operation_id,
          outcome: "already_applied",
          reason_code: "mock_already_applied",
        }))),
        group_results: groups.map((group) => ({
          group_id: group.group_id,
          atomic: group.atomic,
          operation_ids: group.operations.map((operation) => operation.operation_id),
          outcome: "already_applied",
        })),
      }));
      if (result.kind !== "ok") throw new Error("mockの承認結果を作成できません。");
      return result.value;
    }
    return { kind: "execution", execution: createExecution(view, operationIds) };
  }

  function currentApprovalResult(result: ApprovalResult): ApprovalResult {
    if (result.kind === "not_started") return result;
    const execution = executions.get(result.execution.execution_id)?.execution;
    if (execution == null) throw new Error("mockの承認済み実行が見つかりません。");
    return { kind: "execution", execution };
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
      const session = sessions.get(request.session_id);
      const previous = approvals.get(request.proposal_id);
      if (previous != null && session?.approved_proposal_id === request.proposal_id) {
        return proposalsContracts.approve.response.parse(ok(currentApprovalResult(previous)));
      }
      if (session?.proposal?.proposal_id !== request.proposal_id) return failure("not_found", "AI変更案が見つかりません。");
      const ids = selectedIds(session.proposal, request.selection);
      if (ids == null || ids.length === 0) return failure("invalid_request", "適用する操作を選択してください。");
      const result = approvalFor(session.proposal, ids);
      approvals.set(request.proposal_id, result);
      session.approved_proposal_id = request.proposal_id;
      session.proposal = undefined;
      return proposalsContracts.approve.response.parse(ok(result));
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
      const previous = approvals.get(request.proposal_id);
      if (previous != null) return proposalsContracts.approveExternal.response.parse(ok(currentApprovalResult(previous)));
      const proposal = externalProposalFor(request.proposal_id, request.revision);
      if (proposal == null) return failure("not_found", "外部変更案が見つかりません。");
      if (proposal === "conflict") return failure("conflict", "外部変更案の表示版が変わりました。");
      if (proposal.state.kind !== "pending_approval") return failure("conflict", "外部変更案を承認できません。");
      const ids = selectedIds(proposal.view, request.selection);
      if (ids == null || ids.length === 0) return failure("invalid_request", "適用する操作を選択してください。");
      const result = approvalFor(proposal.view, ids);
      approvals.set(request.proposal_id, result);
      if (result.kind === "execution") replaceExternal({ ...proposal, state: { kind: "approving" } });
      else {
        const revision = proposal.revision + 1;
        replaceExternal({ ...proposal, revision, view: withRevision(proposal.view, revision),
          state: { kind: "finished", outcome: result.outcome } });
      }
      return proposalsContracts.approveExternal.response.parse(ok(result));
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
    getHistoryStatus: () => Promise.resolve(proposalsContracts.getHistoryStatus.response.parse(ok(historyStatus()))),
    confirmHistory: (input) => Promise.resolve().then(() => {
      const request = proposalsContracts.confirmHistory.request.parse(input);
      const record = historyRecords.find((candidate) => candidate.kind === "invalid"
        ? candidate.proposal_id === request.proposal_id && candidate.operation_id === request.operation_id
        : candidate.source.proposal_id === request.proposal_id && candidate.source.operation_id === request.operation_id);
      if (record == null) return failure("not_found", "確認対象の履歴がありません。");
      if (record.kind === "invalid") return failure("conflict", "移行できなかった旧履歴は確認できません。");
      if (request.checked_target_id !== record.source.target_id) {
        return failure("invalid_request", "確認対象IDが旧履歴と一致しません。");
      }
      if (record.kind !== "required") {
        return record.confirmed_result === request.confirmed_result
          ? proposalsContracts.confirmHistory.response.parse(ok(historyStatus()))
          : failure("conflict", "旧履歴の確認結果がすでに保存されています。");
      }
      historyRecords = historyRecords.map((candidate) => candidate === record ? {
        kind: "confirmed", source: record.source, confirmed_result: request.confirmed_result,
      } : candidate);
      return proposalsContracts.confirmHistory.response.parse(ok(historyStatus()));
    }),
    synchronizeHistory: () => Promise.resolve().then(() => {
      const pending = historyRecords.filter((record) => record.kind !== "synchronized");
      if (pending.length === 0 && historySyncedAt != null) {
        return proposalsContracts.synchronizeHistory.response.parse(ok({ status: historyStatus(), synced_at: historySyncedAt }));
      }
      if (pending.length === 0 || pending.some((record) => record.kind !== "confirmed")) {
        return failure("conflict", "全件を確認し、移行できなかった旧履歴がない状態で読取同期を実行してください。");
      }
      const syncedAt = "2026-09-28T02:00:00.000Z";
      onHistorySynchronized(syncedAt);
      historySyncedAt = syncedAt;
      historyRecords = historyRecords.map((record) => record.kind === "confirmed"
        ? { ...record, kind: "synchronized" } : record);
      return proposalsContracts.synchronizeHistory.response.parse(ok({ status: historyStatus(), synced_at: historySyncedAt }));
    }),
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
      const successor = [...executions.values()].find((entry) =>
        entry.execution.retry_of_execution_id === request.retry_of_execution_id)?.execution;
      if (successor != null) return proposalsContracts.retryExecution.response.parse(ok(successor));
      if (previous.state !== "failed" && previous.state !== "confirmation_required") {
        return failure("conflict", "停止していない実行は再試行できません。");
      }
      if (previous.proposal_id == null) throw new Error("mockの変更案IDが見つかりません。");
      const updatedAt = timestamp();
      const execution = executionDtoSchema.parse({
        origin: "proposal",
        execution_id: `mock-proposal-execution-${nextExecutionNumber++}`,
        retry_of_execution_id: request.retry_of_execution_id,
        proposal_id: previous.proposal_id,
        created_at: updatedAt,
        updated_at: updatedAt,
        state: "planned",
        steps: previous.steps.map((step) => step.state === "succeeded" ? step : {
          step_id: step.step_id, scope: step.scope, kind: step.kind,
          state: "planned", attempt: 0, updated_at: updatedAt,
        }),
        operation_results: previous.operation_results.map((operation) => operation.outcome === "applied"
          ? operation : { operation_id: operation.operation_id, group_id: operation.group_id, outcome: "pending" }),
        group_results: previous.group_results.map((group) => ({ ...group, outcome: "pending" })),
      });
      scheduleExecution(execution, previous.state === "failed" ? "succeeded" : "confirmation_required");
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
