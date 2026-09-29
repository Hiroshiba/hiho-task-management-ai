import {
  aiWorkflowSelectionSchema,
  identifierSchema,
  proposalOperationSchema,
  proposalSchema,
  type AiWorkflowProposalView,
  type AiWorkflowSelection,
  type Proposal,
} from "../../domain";
import {
  validateProposal,
  type ProposalValidationResult,
} from "../../domain/proposal-analysis/basic";
import { validateProposalGraph, type GraphValidationResult } from "../../domain/proposal-analysis/graph";
import { asanaProposalApplicationInputSchema } from "../common/proposal-application-schemas";
import { ExternalAgentServiceError } from "../common/errors/external-agent-service-error";
import { AsanaOperationInvalidatedError } from "../common/ports/asana-operation-queue";
import type {
  ExternalAgentApplyPort,
  ExternalProposalRecord,
  ExternalProposalPreparation,
  ExternalProposalValidation,
} from "../common/ports/external-agent-proposal";
import type { ExternalAgentApplicationOptions } from "./external-agent-application-options";
import {
  externalAgentApplicationSummary,
  externalAgentProposalSummary,
} from "./external-agent-response";
import { externalAgentGuiState, externalAgentInfoResponse } from "./external-agent-state";
import {
  editExternalAgentProposal,
  rejectExternalAgentProposal,
  selectExternalAgentProposal,
} from "./external-agent-gui-edit";
import { externalAgentProposalStatus } from "./external-agent-proposal-status";
import { createExternalAgentProposalRecord } from "./external-agent-proposal-record";
import { ExternalAgentReview } from "./external-agent-review";
import { expireExternalAgentProposals } from "./external-agent-expiration";

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

/** 提出済み外部提案の確認、承認、履歴を所有します。 */
export class ExternalAgentApplication<TState> implements ExternalAgentApplyPort<TState> {
  private readonly proposals = new Map<string, ExternalProposalRecord>();
  private readonly review = new ExternalAgentReview<TState>(() => this.getState());

  public constructor(private readonly options: ExternalAgentApplicationOptions<TState>) {
    validateAbortSignal(options.lifecycle_signal);
  }

  /** 提出済み外部提案の件数を返します。 */
  public get proposalCount(): number {
    return this.proposals.size;
  }

  /** 外部連携のCLI情報応答を組み立てます。 */
  public createInfoResponse(input: {
    readonly appVersion: string;
    readonly protocolVersion: number;
    readonly instanceId: string;
    readonly context: { readonly context_id: string; readonly project_gid: string } | undefined;
    readonly observedAt: string;
    readonly timeZone: string;
    readonly bridgeState: { readonly kind: string; readonly enabled: boolean };
    readonly runtime: { readonly kind: string; readonly last_successful_sync_at?: string | undefined; readonly last_error_code?: string | undefined } | undefined;
    readonly onlineProvider: () => boolean;
    readonly preparedContextCount: number;
    readonly inputSchema: () => unknown;
  }): unknown {
    return this.options.parse_info_response(externalAgentInfoResponse({
      ...input,
      proposalCount: this.proposals.size,
    }));
  }

  /** 提出した外部提案の表示と承認用の状態を組み立てます。 */
  public createProposalRecord(
    input: { readonly request_id: string; readonly instance_id: string; readonly context_id: string },
    prepared: ExternalProposalPreparation,
    proposal: Proposal,
    validation: ExternalProposalValidation,
    proposalId: string,
  ): ExternalProposalRecord {
    return createExternalAgentProposalRecord(input, prepared, proposal, validation, proposalId, {
      stopped: this.options.stopped,
      currentContextId: this.options.current_context_id,
      eligibleOperationIds: this.options.eligible_operation_ids,
      createView: (id, candidate, snapshot, hash, basic, graph, selectedIds) => this.options.create_view({
        proposal_id: id,
        proposal: candidate,
        snapshot,
        baseline_snapshot_hash: hash,
        basic_validation: basic,
        graph_validation: graph,
        selected_operation_ids: selectedIds,
      }),
      createError: () => new ExternalAgentServiceError(
        "context_changed", "Asana文脈が変更されたため提案基準が失効しています。",
      ),
    });
  }

  /** 提出済み外部提案を登録します。 */
  public registerProposal(record: ExternalProposalRecord): void {
    if (this.proposals.has(record.proposal_id)) {
      throw new ExternalAgentServiceError("conflict", "同じ提案IDは再登録できません。");
    }
    this.proposals.set(record.proposal_id, record);
  }

  /** 提出済み外部提案を要求します。 */
  public requireProposal(proposalId: string): ExternalProposalRecord {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const record = this.proposals.get(parsedProposalId);
    if (record == null) {
      throw new ExternalAgentServiceError("not_found", "指定された外部提案がありません。");
    }
    return record;
  }

  /** GUIへ返す外部提案の状態スナップショットを取得します。 */
  public getState(): TState {
    return this.options.parse_gui_state(externalAgentGuiState(
      this.options.bridge.getState(),
      this.options.bridge.getRegistration(),
      [...this.proposals.values()],
      (record) => record.proposal_id,
      (record) => this.options.parse_proposal(externalAgentProposalSummary(record)),
      this.review.target,
    ));
  }

  /** GUIから外部提案の選択操作を更新します。 */
  public select(input: { readonly proposal_id: string; readonly revision: number; readonly selection: AiWorkflowSelection }, signal: AbortSignal): TState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = this.options.parse_gui_select_input(input);
    const record = this.requireProposal(request.proposal_id);
    return selectExternalAgentProposal(record, request, {
      resolveSelection: (selection) => this.resolveSelection(record, selection),
      validateCurrent: () => this.validateProposal(record, record.proposal),
      createView: (basic, graph) => this.createView(record, record.proposal, basic, graph),
      createError: (code, message) => new ExternalAgentServiceError(code, message),
      emitChanged: () => this.review.emitChanged(),
      getState: () => this.getState(),
    });
  }

  /** GUI編集を外部提案へ反映します。 */
  public edit(input: { readonly proposal_id: string; readonly operation_id: string; readonly revision: number; readonly after: unknown; readonly evidence_locator: string }, signal: AbortSignal): TState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = this.options.parse_gui_edit_input(input);
    const record = this.requireProposal(request.proposal_id);
    return editExternalAgentProposal(record, request, {
      parseOperation: (value) => proposalOperationSchema.parse(value),
      parseProposal: (value) => proposalSchema.parse(value),
      validateProposal: (proposal) => this.validateProposal(record, proposal),
      preserveSelection: this.options.preserve_selection,
      createView: (proposal, basic, graph) => this.createView(record, proposal, basic, graph),
      createError: (code, message) => new ExternalAgentServiceError(code, message),
      emitChanged: () => this.review.emitChanged(),
      getState: () => this.getState(),
    });
  }

  /** GUIから外部提案を承認します。 */
  public async approve(input: { readonly proposal_id: string; readonly revision: number; readonly selection: AiWorkflowSelection }, signal: AbortSignal): Promise<TState> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = this.options.parse_gui_approve_input(input);
    const record = this.requireProposal(request.proposal_id);
    this.assertRevision(record, request.revision);
    if (record.state.kind !== "pending_approval") {
      throw new ExternalAgentServiceError("conflict", "この提案は承認できません。");
    }
    this.options.assert_apply_ready();
    if (this.options.online_provider() !== true) {
      throw new ExternalAgentServiceError("offline", "オフライン中は提案を承認できません。");
    }
    const selectedOperationIds = this.resolveSelection(record, request.selection);
    const selectedEvidence = this.options.assert_external_evidence(record, selectedOperationIds);
    record.selected_operation_ids = [...selectedOperationIds];
    const validation = this.validateProposal(record, record.proposal);
    record.view = this.createView(record, record.proposal, validation.basic, record.graph_validation);
    record.revision += 1;
    record.state = { kind: "approving" };
    this.review.emitChanged();
    const expectedContext = record.context_id;
    try {
      const run = this.options.operation_queue.enqueue({
        priority: "user",
        kind: "external_apply",
        signal: this.options.lifecycle_signal,
        beforeStart: () => {
          this.options.assert_apply_ready();
          if (this.options.current_context_id() !== expectedContext) {
            throw new AsanaOperationInvalidatedError("context_changed");
          }
        },
        run: async (operationContext) => {
          const approvalInput = await this.options.prepare_approval_input({
            proposal_id: record.proposal_id,
            proposal: record.proposal,
            baseline_snapshot: record.baseline_snapshot,
            baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
            baseline_external_data: record.baseline_external_data,
            existing_areas: record.snapshot.areas,
            graph_validation_result: record.graph_validation,
            selected_operation_ids: [...selectedOperationIds],
            explicit_split_request_references: selectedEvidence.split_references,
            trusted_status_evidence: selectedEvidence.trusted_status_evidence,
            created_via: "external_tool",
          }, operationContext.signal);
          const validatedInput = asanaProposalApplicationInputSchema.parse(approvalInput);
          return this.options.apply_proposal(validatedInput, operationContext.signal);
        },
      });
      const application = this.options.parse_application_result(await run);
      const result = this.options.parse_approval_result({
        proposal_id: record.proposal_id,
        ...(application.execution_id == null ? {} : { execution_id: application.execution_id }),
        application: externalAgentApplicationSummary(application),
      });
      record.revision += 1;
      record.state = { kind: "finished", result };
      this.review.emitChanged();
    } catch (error: unknown) {
      if (error instanceof AsanaOperationInvalidatedError && error.reason === "context_changed") {
        record.revision += 1;
        record.state = { kind: "expired", reason_code: "context_changed" };
        this.review.emitChanged();
        throw new ExternalAgentServiceError("context_changed", "提案の文脈が変更されたため失効しました。", error);
      }
      record.revision += 1;
      record.state = {
        kind: "failed",
        reason_code: "unavailable",
        message: "提案の適用に失敗しました。",
      };
      this.review.emitChanged();
      throw error;
    }
    return this.getState();
  }

  /** GUIから外部提案を却下します。 */
  public reject(input: { readonly proposal_id: string; readonly revision: number }, signal: AbortSignal): TState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = this.options.parse_gui_reject_input(input);
    const record = this.requireProposal(request.proposal_id);
    return rejectExternalAgentProposal(record, request.revision, {
      createError: (code, message) => new ExternalAgentServiceError(code, message),
      emitChanged: () => this.review.emitChanged(),
      getState: () => this.getState(),
    });
  }

  /** GUI状態の変更購読を登録します。 */
  public onChanged(listener: (state: TState) => void): () => void {
    return this.review.onChanged(listener);
  }

  /** 提出済み外部提案の変更を購読者へ通知します。 */
  public emitChanged(): void {
    this.review.emitChanged();
  }

  /** 提出済み外部提案の購読を破棄します。 */
  public clearListeners(): void {
    this.review.clear();
  }

  /** 未承認の外部提案を指定理由で失効させます。 */
  public expireProposals(reason: "context_changed" | "instance_restarted" | "superseded"): void {
    expireExternalAgentProposals(this.proposals.values(), reason, () => this.review.emitChanged());
  }

  /** 外部提案の現行状態または保存済み操作結果を返します。 */
  public getProposalStatus(proposalId: string, operationIds: readonly string[]): unknown {
    return externalAgentProposalStatus(proposalId, operationIds, {
      parseIdentifier: (value) => identifierSchema.parse(value),
      getProposal: (id) => this.proposals.get(id),
      getSavedResult: this.options.get_saved_operation_result,
      createConflictError: () => new ExternalAgentServiceError("conflict", "操作ID集合が提案と一致しません。"),
      parseCurrentResult: this.options.parse_proposal_status_result,
      parseResponse: this.options.parse_proposal_status_response,
    });
  }

  /** 提出済み外部提案の確認画面を開きます。 */
  public async openReview(proposalId: string): Promise<unknown> {
    return this.review.open(proposalId, {
      requireProposal: (id) => this.requireProposal(id),
      createId: () => identifierSchema.parse(this.options.create_id()),
      openReview: this.options.open_review,
      createResponse: (id, requestId) => this.options.parse_review_open_response({
        operation: "review.open", proposal_id: id, request_id: requestId, opened: true,
      }),
      createConflictError: () => new ExternalAgentServiceError("conflict", "この提案は確認画面を開けません。"),
    });
  }

  private resolveSelection(record: ExternalProposalRecord, selection: AiWorkflowSelection): readonly string[] {
    try {
      const selected = this.options.resolve_selection(record, aiWorkflowSelectionSchema.parse(selection));
      this.options.assert_selected_graph_safe(record, selected);
      return selected;
    } catch (error: unknown) {
      if (this.options.is_selection_error(error)) {
        throw new ExternalAgentServiceError("invalid_request", error.message, error);
      }
      throw error;
    }
  }

  private assertRevision(record: ExternalProposalRecord, revision: number): void {
    if (record.revision !== revision) {
      throw new ExternalAgentServiceError("stale_revision", "提案の表示版が更新されています。");
    }
  }

  private validateProposal(record: ExternalProposalRecord, proposal: Proposal): { readonly basic: ProposalValidationResult; readonly graph: GraphValidationResult } {
    const basic = validateProposal({
      proposal,
      baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
      managed_tasks: record.snapshot.tasks,
      existing_areas: record.snapshot.areas,
      explicit_split_request_references: [...record.explicit_split_request_references],
      trusted_status_evidence: [...record.trusted_status_evidence],
    });
    const graph = validateProposalGraph({
      proposal,
      managed_tasks: record.snapshot.tasks,
      basic_validation_result: basic,
    });
    return { basic, graph };
  }

  private createView(record: ExternalProposalRecord, proposal: Proposal, basic: ProposalValidationResult, graph: GraphValidationResult): AiWorkflowProposalView {
    return this.options.create_view({
      proposal_id: record.proposal_id,
      proposal,
      snapshot: record.snapshot,
      baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
      basic_validation: basic,
      graph_validation: graph,
      selected_operation_ids: [...record.selected_operation_ids],
    });
  }
}
