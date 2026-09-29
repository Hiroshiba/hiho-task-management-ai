import {
  aiWorkflowTurnContextSchema,
  baselineSnapshotSchema,
  canonicalizeJson,
  createExternalReviewEvidenceLocator,
  gidSchema,
  identifierSchema,
  proposalSchema,
  type Proposal,
} from "../../domain";
import {
  validateProposal,
  type ExplicitSplitRequestReference,
  type TrustedStatusEvidenceReference,
} from "../../domain/proposal-analysis/basic";
import { validateProposalGraph } from "../../domain/proposal-analysis/graph";
import { ExternalAgentServiceError } from "../common/errors/external-agent-service-error";
import { AsanaOperationInvalidatedError } from "../common/ports/asana-operation-queue";
import type {
  ExternalAgentBaseline,
  ExternalProposalRecord,
  ExternalProposalValidation,
} from "../common/ports/external-agent-proposal";
import { assertExternalAgentRequestContext, requireExternalAgentWorkspace } from "./external-agent-context";
import {
  assertSelectedExternalAgentEvidence,
  collectExternalAgentProposalEvidence,
} from "./external-agent-evidence";
import { ExternalAgentLifecycle, type ExternalAgentContext } from "./external-agent-lifecycle";
import { ExternalAgentPreparation } from "./external-agent-preparation";
import { createExternalAgentPreparedContext } from "./external-agent-prepared-context";
import { handleExternalAgentRequest } from "./external-agent-request";
import {
  externalAgentPrepareResponse,
  externalAgentSubmitResponse,
  externalAgentWorkspaceDiffResponse,
  externalAgentWorkspaceEditsResponse,
  externalAgentWorkspaceReadResponse,
} from "./external-agent-response";
import { ExternalAgentSubmission } from "./external-agent-submission";
import { executeExternalAgentTaskQuery } from "./external-agent-task-query";
import { validateExternalAgentWorkspaceProposal } from "./external-agent-validation";
import { externalAgentValidationResponse } from "./external-agent-validation-response";
import { UnreachableError, nowIso, validateAbortSignal } from "./external-agent-generation-guards";
import type { ExternalAgentGenerationOptions, TaskctlSnapshotShape } from "./external-agent-generation-options";
import type {
  ExternalAgentCliInput,
  ExternalAgentProposalApplyEditsInput,
  ExternalAgentProposalDiffInput,
  ExternalAgentProposalPrepareInput,
  ExternalAgentProposalReadInput,
  ExternalAgentProposalSubmitInput,
  ExternalAgentProposalValidateInput,
  ExternalAgentRequestInput,
  ExternalAgentTaskQueryInput,
  PreparedExternalContext,
} from "./external-agent-contract";

const maximumRequests = 100;

/** 外部提案の文脈、ワークスペース、提出要求を所有します。 */
export class ExternalAgentGeneration<TState, TTaskctl extends TaskctlSnapshotShape> {
  private readonly submission = new ExternalAgentSubmission();
  private readonly preparation = new ExternalAgentPreparation<PreparedExternalContext<TTaskctl>, ExternalAgentServiceError>({
    parseId: (value) => identifierSchema.parse(value),
    currentContextId: () => this.lifecycle.context?.context_id,
    createError: (message) => new ExternalAgentServiceError("context_changed", message),
  });
  private readonly lifecycle = new ExternalAgentLifecycle<TState>({
    parseProjectGid: (value) => gidSchema.parse(value),
    createId: () => identifierSchema.parse(this.options.create_id()),
    clearPrepared: () => this.preparation.clear(),
    expireProposals: (reason) => this.options.apply.expireProposals(reason),
    validateSignal: validateAbortSignal,
    setBridgeEnabled: (enabled) => this.options.bridge.setEnabled(enabled),
    getBridgeState: () => this.options.bridge.getState(),
    getRuntimeState: () => this.options.get_runtime_state(),
    emitChanged: () => this.options.apply.emitChanged(),
    getState: () => this.options.apply.getState(),
    clearListeners: () => this.options.apply.clearListeners(),
    createError: (code, message) => new ExternalAgentServiceError(code, message),
  });

  public constructor(private readonly options: ExternalAgentGenerationOptions<TState, TTaskctl>) {
    validateAbortSignal(options.lifecycle_signal);
    identifierSchema.parse(options.app_version);
    identifierSchema.parse(options.instance_id);
  }

  /** 現行のAsana文脈IDを返します。 */
  public get contextId(): string | undefined {
    return this.lifecycle.context?.context_id;
  }

  /** 外部連携が停止済みか返します。 */
  public get stopped(): boolean {
    return this.lifecycle.stopped;
  }

  /** 設定済みAsana文脈を反映して世代を更新します。 */
  public configureContext(contextInput: { readonly project_gid: string; readonly source_key: string } | undefined): void {
    this.lifecycle.configure(contextInput);
  }

  /** 外部連携要求を検証して処理します。 */
  public async handleRequest(input: unknown, signal: AbortSignal): Promise<unknown> {
    validateAbortSignal(signal);
    return handleExternalAgentRequest<ExternalAgentCliInput, string, unknown>(input, {
      parseInput: this.options.protocol.parse_cli_input,
      isInputError: this.options.protocol.is_input_error,
      isServiceError: (error): error is ExternalAgentServiceError => error instanceof ExternalAgentServiceError,
      workspaceConflict: this.options.protocol.workspace_conflict,
      isWorkspaceInputError: this.options.protocol.is_workspace_input_error,
      createErrorResponse: (code, message, revision) => this.options.protocol.parse_error_response({
        kind: "error", code, message,
        ...(revision == null ? {} : { current_revision: revision }),
      }),
      createInfoResponse: () => this.createInfoResponse(),
      assertEnabled: () => this.lifecycle.assertEnabled(),
      dispatch: (request) => {
        if (request.operation === "agent-info") {
          throw new UnreachableError("外部連携の情報要求は配送前に処理済みです。");
        }
        return this.dispatchRequest(request);
      },
      currentWorkspaceRevision: (request) => {
        if (!("workspace_id" in request)) {
          throw new UnreachableError("ワークスペースのIDがありません。");
        }
        return this.requireWorkspace(request).workspace.getStatus().revision;
      },
    });
  }

  /** 外部連携の有効状態を変更します。 */
  public setEnabled(input: { readonly enabled: boolean }, signal: AbortSignal): Promise<TState> {
    return this.lifecycle.setEnabled(input.enabled, signal);
  }

  /** 外部提案を文脈変更として失効させます。 */
  public expireForContextChange(): void {
    this.lifecycle.rotate();
    this.options.apply.expireProposals("context_changed");
  }

  /** 外部連携の購読と準備済み文脈を停止します。 */
  public stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  /** 選択した外部提案の根拠を検証します。 */
  public assertExternalEvidence(record: ExternalProposalRecord, operationIds: readonly string[]): {
    readonly split_references: readonly ExplicitSplitRequestReference[];
    readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  } {
    return assertSelectedExternalAgentEvidence(record.proposal, operationIds, {
      parseProposal: (value) => proposalSchema.parse(value),
      collectEvidence: (proposal) => collectExternalAgentProposalEvidence({
        proposal_context_id: record.proposal_context_id,
        source_text: record.source_text,
      }, proposal.groups, createExternalReviewEvidenceLocator),
      validateProposal: (proposal, evidence) => validateProposal({
        proposal,
        baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
        managed_tasks: record.snapshot.tasks,
        existing_areas: record.snapshot.areas,
        explicit_split_request_references: [...evidence.split_references],
        trusted_status_evidence: [...evidence.trusted_status_evidence],
      }).operations,
      createError: () => new ExternalAgentServiceError("invalid_request", "承認対象の外部根拠を検証できません。"),
    });
  }

  private async dispatchRequest(input: ExternalAgentRequestInput): Promise<unknown> {
    switch (input.operation) {
      case "tasks.list":
      case "tasks.get":
      case "tasks.rank":
      case "tasks.graph":
      case "tasks.areas":
      case "tasks.search-local":
        return this.executeTaskctlRequest(input);
      case "proposals.prepare":
        return this.prepareExternalProposal(input);
      case "proposals.read":
        return this.readWorkspace(input);
      case "proposals.apply-edits":
        return this.applyWorkspaceEdits(input);
      case "proposals.diff":
        return this.diffWorkspace(input);
      case "proposals.validate":
        return this.validateWorkspace(input);
      case "proposals.submit":
        return this.submitWorkspace(input);
      case "proposals.status":
        return this.options.apply.getProposalStatus(input.proposal_id, input.operation_ids);
      case "review.open":
        return this.options.apply.openReview(input.proposal_id);
    }
  }

  private createInfoResponse(): unknown {
    const context = this.lifecycle.context;
    return this.options.apply.createInfoResponse({
      appVersion: identifierSchema.parse(this.options.app_version),
      protocolVersion: this.options.protocol.protocol_version,
      instanceId: identifierSchema.parse(this.options.instance_id),
      context,
      observedAt: nowIso(this.options.now_provider),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      bridgeState: this.options.bridge.getState(),
      runtime: this.options.get_runtime_state(),
      onlineProvider: this.options.online_provider,
      preparedContextCount: this.preparation.contextCount(),
      inputSchema: this.options.protocol.input_schema,
    });
  }

  private executeTaskctlRequest(input: ExternalAgentTaskQueryInput): unknown {
    return executeExternalAgentTaskQuery(input, {
      assertReadReady: () => this.lifecycle.assertReadReady(),
      getCurrentSnapshot: () => this.options.parse_taskctl_snapshot(this.options.get_taskctl_snapshot()),
      getPreparedSnapshot: (contextId) => this.preparation.requireContext(contextId).taskctl_snapshot,
      execute: this.options.execute_taskctl_query,
      parseResponse: this.options.protocol.parse_task_query_response,
    });
  }

  private prepareExternalProposal(input: ExternalAgentProposalPrepareInput): Promise<unknown> {
    return this.preparation.prepare(input, {
      digest: canonicalizeJson,
      stopped: () => this.lifecycle.stopped,
      requireContext: () => this.lifecycle.requireContext(),
      assertRequestContext: (request, context) => assertExternalAgentRequestContext(
        request, context, this.options.instance_id,
        (message) => new ExternalAgentServiceError("context_mismatch", message),
      ),
      assertApplyReady: this.options.assert_apply_ready,
      online: this.options.online_provider,
      maximumRequests,
      createBaseline: () => this.options.create_baseline(this.options.lifecycle_signal),
      createPreparedContext: (request, context, baseline) => this.createPreparedContext(request, context, baseline),
      createResponse: (prepared) => this.options.protocol.parse_prepare_response(externalAgentPrepareResponse(prepared)),
      createError: (code, message, cause) => new ExternalAgentServiceError(code, message, cause),
      isExpectedError: (error): error is ExternalAgentServiceError => error instanceof ExternalAgentServiceError,
      isContextInvalidatedError: (error) => error instanceof AsanaOperationInvalidatedError
        && error.reason === "context_changed",
    });
  }

  private createPreparedContext(
    input: ExternalAgentProposalPrepareInput,
    context: ExternalAgentContext,
    baseline: ExternalAgentBaseline<TTaskctl>,
  ): PreparedExternalContext<TTaskctl> {
    return createExternalAgentPreparedContext(input, context, baseline, {
      stopped: () => this.lifecycle.stopped,
      currentContextId: () => this.lifecycle.context?.context_id,
      parseBaseline: (value) => baselineSnapshotSchema.parse(value),
      parseTaskctl: this.options.parse_taskctl_snapshot,
      taskctlSummary: (snapshot) => ({
        sync_kind: snapshot.sync.kind,
        ...(snapshot.sync.kind === "synced" ? { synced_at: snapshot.sync.synced_at } : {}),
        tasks: snapshot.tasks,
      }),
      canonicalize: canonicalizeJson,
      createId: () => identifierSchema.parse(this.options.create_id()),
      hashBaseline: this.options.hash_baseline_snapshot,
      parseTurnContext: (value) => aiWorkflowTurnContextSchema.parse(value),
      createWorkspace: this.options.create_workspace,
      createError: (code, message) => new ExternalAgentServiceError(code, message),
    });
  }

  private requireWorkspace(input: {
    readonly instance_id: string;
    readonly context_id: string;
    readonly project_gid: string;
    readonly proposal_context_id: string;
    readonly workspace_id: string;
  }): PreparedExternalContext<TTaskctl> {
    return requireExternalAgentWorkspace(input, {
      requireContext: () => this.lifecycle.requireContext(),
      instanceId: this.options.instance_id,
      requirePreparedContext: (id) => this.preparation.requireContext(id),
      createError: (message) => new ExternalAgentServiceError("context_mismatch", message),
    });
  }

  private readWorkspace(input: ExternalAgentProposalReadInput): unknown {
    const workspace = this.requireWorkspace(input).workspace;
    const chunk = workspace.read({
      workspace_id: input.workspace_id,
      revision: input.revision,
      target: input.target,
      ...(input.offset == null ? {} : { offset: input.offset }),
    });
    return this.options.protocol.parse_read_response(
      externalAgentWorkspaceReadResponse(input.target, chunk, this.options.protocol.maximum_workspace_response_bytes),
    );
  }

  private applyWorkspaceEdits(input: ExternalAgentProposalApplyEditsInput): unknown {
    const status = this.requireWorkspace(input).workspace.applyBatch({
      workspace_id: input.workspace_id,
      edit_batch_id: input.edit_batch_id,
      expected_revision: input.expected_revision,
      edits: input.edits,
    });
    return this.options.protocol.parse_apply_edits_response(externalAgentWorkspaceEditsResponse(status));
  }

  private diffWorkspace(input: ExternalAgentProposalDiffInput): unknown {
    const workspace = this.requireWorkspace(input).workspace;
    const chunk = workspace.diff({
      workspace_id: input.workspace_id,
      from_revision: input.from_revision,
      revision: input.revision,
      ...(input.offset == null ? {} : { offset: input.offset }),
    });
    return this.options.protocol.parse_diff_response(
      externalAgentWorkspaceDiffResponse(chunk, this.options.protocol.maximum_workspace_response_bytes),
    );
  }

  private validateWorkspace(input: ExternalAgentProposalValidateInput): unknown {
    const prepared = this.requireWorkspace(input);
    const result = prepared.workspace.validate({
      workspace_id: input.workspace_id,
      expected_revision: input.expected_revision,
    }, (proposal) => this.validateExternalProposal(prepared, proposal));
    return this.options.protocol.parse_validate_response(externalAgentValidationResponse(
      input.workspace_id,
      input.offset ?? 0,
      result,
      this.options.eligible_operation_ids,
      this.options.protocol.maximum_message_bytes,
      this.options.protocol.maximum_workspace_response_bytes,
      () => new ExternalAgentServiceError("invalid_request", "検証結果の読み取り位置が件数を超えています。"),
    ));
  }

  private submitWorkspace(input: ExternalAgentProposalSubmitInput): unknown {
    return this.submission.submit(input, {
      digest: canonicalizeJson,
      requireProposal: (proposalId) => this.options.apply.requireProposal(proposalId),
      requireWorkspace: (request) => this.requireWorkspace(request),
      assertApplyReady: this.options.assert_apply_ready,
      online: this.options.online_provider,
      maximumRequests,
      validate: (prepared, request) => prepared.workspace.validate({
        workspace_id: request.workspace_id,
        expected_revision: request.expected_revision,
      }, (proposal) => this.validateExternalProposal(prepared, proposal)),
      createProposalId: () => identifierSchema.parse(this.options.create_id()),
      createRecord: (request, prepared, proposal, validation, id) =>
        this.options.apply.createProposalRecord(request, prepared, proposal, validation, id),
      seal: (prepared, request) => prepared.workspace.submit({
        workspace_id: request.workspace_id,
        expected_revision: request.expected_revision,
      }, (proposal) => this.validateExternalProposal(prepared, proposal)),
      registerProposal: (record) => this.options.apply.registerProposal(record),
      emitChanged: () => this.options.apply.emitChanged(),
      createInvalidResponse: (workspaceId, revision) => this.options.protocol.parse_submit_response({
        operation: "proposals.submit",
        workspace_id: workspaceId,
        revision,
        result: { kind: "invalid" },
      }),
      createSubmitResponse: (workspaceId, revision, record) => this.options.protocol.parse_submit_response(
        externalAgentSubmitResponse(workspaceId, revision, record),
      ),
      createError: (code, message) => new ExternalAgentServiceError(code, message),
    });
  }

  private validateExternalProposal(prepared: PreparedExternalContext<TTaskctl>, proposal: Proposal):
    | { readonly kind: "invalid"; readonly issues: readonly { readonly message: string }[] }
    | { readonly kind: "valid"; readonly proposal: Proposal; readonly value: ExternalProposalValidation } {
    return validateExternalAgentWorkspaceProposal(proposal, {
      collectEvidence: () => collectExternalAgentProposalEvidence(
        prepared, proposal.groups, createExternalReviewEvidenceLocator,
      ),
      validateBasic: (evidence) => validateProposal({
        proposal,
        baseline_snapshot_hash: prepared.turn_context.baseline_snapshot_hash,
        managed_tasks: prepared.snapshot.tasks,
        existing_areas: prepared.snapshot.areas,
        explicit_split_request_references: [...evidence.split_references],
        trusted_status_evidence: [...evidence.trusted_status_evidence],
      }),
      validateGraph: (basic) => validateProposalGraph({
        proposal,
        managed_tasks: prepared.snapshot.tasks,
        basic_validation_result: basic,
      }),
    });
  }
}
