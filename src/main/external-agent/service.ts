import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  baselineSnapshotSchema,
  canonicalizeJson,
  gidSchema,
  identifierSchema,
  isoDateTimeSchema,
  type BaselineSnapshot,
} from "../../shared/domain";
import {
  createExternalReviewEvidenceLocator,
  proposalOperationSchema,
  proposalSchema,
  type Proposal,
} from "../../shared/ai";
import {
  aiWorkflowApprovalResultSchema,
  aiWorkflowSelectionSchema,
  aiWorkflowTurnContextSchema,
  type AiWorkflowProposalView,
  type AiWorkflowSnapshot,
  type AiWorkflowSelection,
} from "../../shared/ai-workflow";
import {
  validateProposal,
  type ExplicitSplitRequestReference,
  type TrustedStatusEvidenceReference,
  type ProposalValidationResult,
} from "../domain/proposal-analysis/basic";
import { validateProposalGraph, type GraphValidationResult } from "../domain/proposal-analysis/graph";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
} from "../application/common/proposal-application-schemas";
import {
  createWorkflowProposalView,
  eligibleOperationIds,
  preserveSelection,
  resolveSelectedOperationIds,
  assertSelectedProposalGraphIsSafe,
  AiWorkflowSelectionError,
  type ApprovalPreparationInput,
} from "../ai/workflow";
import {
  ProposalWorkspace,
  ProposalWorkspaceConflictError,
  ProposalWorkspaceInputError,
  type ProposalWorkspaceValidation,
} from "../ai/proposal-workspace";
import {
  AsanaOperationInvalidatedError,
  type AsanaOperationQueue,
  type AsanaOperationKind,
} from "../asana/operation-queue";
import type { AsanaSyncRuntimeState } from "../asana/runtime";
import type {
  ExternalAgentProposalPrepareInput,
  ExternalAgentProposalReadInput,
  ExternalAgentProposalApplyEditsInput,
  ExternalAgentProposalDiffInput,
  ExternalAgentProposalValidateInput,
  ExternalAgentProposalSubmitInput,
  ExternalAgentErrorCode,
  ExternalAgentGuiApproveInput,
  ExternalAgentGuiEditInput,
  ExternalAgentGuiState,
  ExternalAgentGuiRejectInput,
  ExternalAgentGuiSelectInput,
  ExternalAgentGuiSetEnabledInput,
  ExternalAgentInfoResponse,
  ExternalAgentProposalStatus,
  ExternalAgentProposalStatusResult,
  ExternalAgentRequestInput,
  ExternalAgentResponse as ExternalAgentResponseRecord,
  ExternalAgentTaskQueryResponse as ExternalAgentTaskQueryResponseRecord,
  ExternalAgentTaskListInput,
  ExternalAgentTaskDetailInput,
  ExternalAgentTaskRankInput,
  ExternalAgentTaskGraphInput,
  ExternalAgentTaskAreasInput,
  ExternalAgentTaskSearchLocalInput,
  ExternalAgentProposalPrepareResponse,
  ExternalAgentProposalReadResponse,
  ExternalAgentProposalApplyEditsResponse,
  ExternalAgentProposalDiffResponse,
  ExternalAgentProposalValidateResponse,
  ExternalAgentProposalSubmitResponse,
  ExternalAgentProposalStatusResponse,
  ExternalAgentReviewOpenResponse,
} from "../../shared/external-agent";

import {
  externalAgentCliInputSchema,
  externalAgentErrorResponseSchema,
  externalAgentGuiApproveInputSchema,
  externalAgentGuiEditInputSchema,
  externalAgentGuiRejectInputSchema,
  externalAgentGuiSelectInputSchema,
  externalAgentGuiStateSchema,
  externalAgentInfoResponseSchema,
  externalAgentProposalReadResponseSchema,
  externalAgentProposalApplyEditsResponseSchema,
  externalAgentProposalDiffResponseSchema,
  externalAgentProposalValidateResponseSchema,
  externalAgentProposalSubmitResponseSchema,
  externalAgentProposalPrepareResponseSchema,
  externalAgentProposalSchema,
  externalAgentProposalStatusResponseSchema,
  externalAgentProposalStatusResultSchema,
  externalAgentRequestInputSchema,
  externalAgentReviewOpenResponseSchema,
  createExternalAgentResponseSchemas,
  externalAgentProtocolVersion,
  maximumExternalAgentMessageBytes,
  maximumWorkspaceCliResponseBytes,
} from "../../shared/external-agent";
import type {
  ExternalAgentBridge,
} from "./transport";
import { hashBaselineSnapshot } from "../domain/snapshot-hash";
import {
  executeTaskctlQuery,
  type TaskctlRankingSchemas,
  type TaskctlResponse,
  type TaskctlSnapshot,
} from "../codex/taskctl";
import {
  externalAgentApplicationSummary,
  externalAgentPrepareResponse,
  externalAgentProposalSummary,
  externalAgentSubmitResponse,
  externalAgentWorkspaceDiffResponse,
  externalAgentWorkspaceEditsResponse,
  externalAgentWorkspaceReadResponse,
} from "../application/proposal-generate/external-agent-response";
import { externalAgentValidationResponse } from "../application/proposal-generate/external-agent-validation-response";
import {
  validateExternalAgentSubmittedProposal,
  validateExternalAgentWorkspaceProposal,
} from "../application/proposal-generate/external-agent-validation";
import { ExternalAgentPreparation } from "../application/proposal-generate/external-agent-preparation";
import { ExternalAgentSubmission } from "../application/proposal-generate/external-agent-submission";
import { externalAgentProposalStatus } from "../application/proposal-generate/external-agent-proposal-status";
import {
  editExternalAgentProposal,
  rejectExternalAgentProposal,
  selectExternalAgentProposal,
} from "../application/proposal-generate/external-agent-gui-edit";
import { externalAgentTaskctlQuery } from "../application/proposal-generate/external-agent-task-query";
import {
  assertExternalAgentRequestContext,
  requireExternalAgentWorkspace,
} from "../application/proposal-generate/external-agent-context";
import { createExternalAgentPreparedContext } from "../application/proposal-generate/external-agent-prepared-context";
import { createExternalAgentProposalRecord } from "../application/proposal-generate/external-agent-proposal-record";
import { handleExternalAgentRequest } from "../application/proposal-generate/external-agent-request";
import {
  ExternalAgentLifecycle,
  expireExternalAgentProposals,
  type ExternalAgentContext,
} from "../application/proposal-generate/external-agent-lifecycle";
import { ExternalAgentReview } from "../application/proposal-generate/external-agent-review";
import {
  assertSelectedExternalAgentEvidence,
  collectExternalAgentProposalEvidence,
} from "../application/proposal-generate/external-agent-evidence";
import {
  externalAgentGuiState,
  externalAgentInfoResponse,
} from "../application/proposal-generate/external-agent-state";

const maximumRequests = 100;
const externalAgentOperationKind: AsanaOperationKind = "external_apply";

type ExternalAgentResponse = ExternalAgentResponseRecord<TaskctlResponse>;
type ExternalAgentTaskQueryResponse = ExternalAgentTaskQueryResponseRecord<TaskctlResponse>;

type SavedOperationStatusResult = Extract<Extract<ExternalAgentProposalStatusResult, { kind: "journals" }>["results"][number]["result"], { kind: "execution" | "unknown" | "legacy_history" }>;

export type ExternalAgentBaseline = {
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly taskctl_snapshot: TaskctlSnapshot;
};

type ExternalAgentBridgePort = Pick<
  ExternalAgentBridge,
  "getState" | "getRegistration" | "setEnabled" | "stop"
>;

export type ExternalAgentServiceOptions = {
  readonly app_version: string;
  readonly instance_id: string;
  readonly lifecycle_signal: AbortSignal;
  readonly now_provider: () => Date;
  readonly online_provider: () => boolean;
  readonly get_taskctl_snapshot: () => TaskctlSnapshot;
  readonly taskctl_schemas: TaskctlRankingSchemas;
  readonly operation_queue: Pick<AsanaOperationQueue, "enqueue" | "invalidatePendingMutations">;
  readonly get_runtime_state: () => AsanaSyncRuntimeState | undefined;
  readonly create_baseline: (
    signal: AbortSignal,
  ) => ExternalAgentBaseline | PromiseLike<ExternalAgentBaseline>;
  readonly prepare_approval_input: (
    input: ApprovalPreparationInput,
    signal: AbortSignal,
  ) => AsanaProposalApplicationInput | PromiseLike<AsanaProposalApplicationInput>;
  readonly apply_proposal: (
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ) => AsanaProposalApplicationResult | PromiseLike<AsanaProposalApplicationResult>;
  readonly get_saved_operation_result: (
    proposalId: string,
    operationId: string,
  ) => SavedOperationStatusResult | undefined;
  readonly assert_apply_ready: () => void;
  readonly open_review: (
    proposalId: string,
    requestId: string,
  ) => PromiseLike<void> | void;
  readonly bridge: ExternalAgentBridgePort;
};

type ExternalProposalRecord = {
  readonly proposal_id: string;
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly proposal_context_id: string;
  readonly operation_ids: readonly string[];
  readonly source_text: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly turn_context: z.infer<typeof aiWorkflowTurnContextSchema>;
  proposal: Proposal;
  explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  graph_validation: GraphValidationResult;
  selected_operation_ids: readonly string[];
  view: AiWorkflowProposalView;
  revision: number;
  state: ExternalAgentProposalStatus;
};

type PreparedExternalContext = {
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly project_gid: string;
  readonly proposal_context_id: string;
  readonly source_text: string;
  readonly evidence_locator_prefix: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly taskctl_snapshot: TaskctlSnapshot;
  readonly turn_context: z.infer<typeof aiWorkflowTurnContextSchema>;
  readonly workspace: ProposalWorkspace;
};

type ExternalProposalValidation = {
  readonly basic: ProposalValidationResult;
  readonly graph: GraphValidationResult;
  readonly evidence: {
    readonly split_references: readonly ExplicitSplitRequestReference[];
    readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  };
};

/** 外部連携の業務エラーを表します。 */
export class ExternalAgentServiceError extends Error {
  public readonly code: ExternalAgentErrorCode;

  public constructor(code: ExternalAgentErrorCode, message: string, cause?: unknown) {
    super(message, cause == null ? undefined : { cause });
    this.name = "ExternalAgentServiceError";
    this.code = code;
  }
}

class UnreachableError extends Error {}

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

function nowIso(nowProvider: () => Date): string {
  const value = nowProvider();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("時刻関数は有効なDateを返してください。");
  }
  return isoDateTimeSchema.parse(value.toISOString());
}

function createErrorResponse(
  code: ExternalAgentErrorCode,
  message: string,
  currentRevision?: number,
): Record<string, unknown> {
  return externalAgentErrorResponseSchema.parse({
    kind: "error",
    code,
    message,
    ...(currentRevision == null ? {} : { current_revision: currentRevision }),
  });
}

function isProposalStatusMutable(status: ExternalAgentProposalStatus): boolean {
  return status.kind === "pending_approval";
}

/** 外部Codex連携の提案受付とGUI操作を管理します。 */
export class ExternalAgentService {
  private readonly options: ExternalAgentServiceOptions;
  private readonly submission = new ExternalAgentSubmission();
  private readonly preparation = new ExternalAgentPreparation<PreparedExternalContext, ExternalAgentServiceError>({
    parseId: (value) => identifierSchema.parse(value),
    currentContextId: () => this.lifecycle.context?.context_id,
    createError: (message) => new ExternalAgentServiceError("context_changed", message),
  });
  private readonly proposals = new Map<string, ExternalProposalRecord>();
  private readonly lifecycle = new ExternalAgentLifecycle<ExternalAgentGuiState>({
    parseProjectGid: (value) => gidSchema.parse(value),
    createId: () => identifierSchema.parse(randomUUID()),
    clearPrepared: () => this.preparation.clear(),
    expireProposals: (reason) => this.expireProposals(reason),
    validateSignal: validateAbortSignal,
    setBridgeEnabled: (enabled) => this.options.bridge.setEnabled(enabled),
    getBridgeState: () => this.options.bridge.getState(),
    getRuntimeState: () => this.options.get_runtime_state(),
    emitChanged: () => this.review.emitChanged(),
    getState: () => this.getState(),
    clearListeners: () => this.review.clear(),
    createError: (code, message) => new ExternalAgentServiceError(code, message),
  });
  private readonly review = new ExternalAgentReview<ExternalAgentGuiState>(() => this.getState());

  public constructor(options: ExternalAgentServiceOptions) {
    validateAbortSignal(options.lifecycle_signal);
    this.options = options;
    identifierSchema.parse(options.app_version);
    identifierSchema.parse(options.instance_id);
  }

  /** 設定済みAsana文脈を反映して世代を更新します。 */
  public configureContext(
    contextInput: { readonly project_gid: string; readonly source_key: string } | undefined,
  ): void {
    this.lifecycle.configure(contextInput);
  }

  /** 外部連携要求を検証して処理します。 */
  public async handleRequest(input: unknown, signal: AbortSignal): Promise<unknown> {
    validateAbortSignal(signal);
    return handleExternalAgentRequest<z.infer<typeof externalAgentCliInputSchema>, ExternalAgentErrorCode, unknown>(input, {
      parseInput: (value) => externalAgentCliInputSchema.parse(value),
      isInputError: (error) => error instanceof z.ZodError,
      isServiceError: (error): error is ExternalAgentServiceError => error instanceof ExternalAgentServiceError,
      workspaceConflict: (error) => error instanceof ProposalWorkspaceConflictError ? error : undefined,
      isWorkspaceInputError: (error): error is ProposalWorkspaceInputError => error instanceof ProposalWorkspaceInputError,
      createErrorResponse,
      createInfoResponse: () => this.createInfoResponse(),
      assertEnabled: () => this.assertEnabled(),
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

  /** GUIへ返す外部提案の状態スナップショットを取得します。 */
  public getState(): ExternalAgentGuiState {
    const bridgeState = this.options.bridge.getState();
    return externalAgentGuiStateSchema.parse(externalAgentGuiState(
      bridgeState,
      this.options.bridge.getRegistration(),
      [...this.proposals.values()],
      (record) => record.proposal_id,
      (record) => externalAgentProposalSchema.parse(externalAgentProposalSummary(record)),
      this.review.target,
    ));
  }

  /** 外部連携の有効状態を変更します。 */
  public async setEnabled(
    input: ExternalAgentGuiSetEnabledInput,
    signal: AbortSignal,
  ): Promise<ExternalAgentGuiState> {
    return this.lifecycle.setEnabled(input.enabled, signal);
  }

  /** GUIから外部提案の選択操作を更新します。 */
  public select(
    input: ExternalAgentGuiSelectInput,
    signal: AbortSignal,
  ): ExternalAgentGuiState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = externalAgentGuiSelectInputSchema.parse(input);
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
  public edit(
    input: ExternalAgentGuiEditInput,
    signal: AbortSignal,
  ): ExternalAgentGuiState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = externalAgentGuiEditInputSchema.parse(input);
    const record = this.requireProposal(request.proposal_id);
    return editExternalAgentProposal(record, request, {
      parseOperation: (value) => proposalOperationSchema.parse(value),
      parseProposal: (value) => proposalSchema.parse(value),
      validateProposal: (proposal) => this.validateProposal(record, proposal),
      preserveSelection,
      createView: (proposal, basic, graph) => this.createView(record, proposal, basic, graph),
      createError: (code, message) => new ExternalAgentServiceError(code, message),
      emitChanged: () => this.review.emitChanged(),
      getState: () => this.getState(),
    });
  }

  /** GUIから外部提案を承認します。 */
  public async approve(
    input: ExternalAgentGuiApproveInput,
    signal: AbortSignal,
  ): Promise<ExternalAgentGuiState> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = externalAgentGuiApproveInputSchema.parse(input);
    const record = this.requireProposal(request.proposal_id);
    this.assertRevision(record, request.revision);
    if (!isProposalStatusMutable(record.state)) {
      throw new ExternalAgentServiceError("conflict", "この提案は承認できません。");
    }
    this.options.assert_apply_ready();
    if (this.options.online_provider() !== true) {
      throw new ExternalAgentServiceError("offline", "オフライン中は提案を承認できません。");
    }
    const selectedOperationIds = this.resolveSelection(record, request.selection);
    const selectedEvidence = this.assertExternalEvidence(record, selectedOperationIds);
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
        kind: externalAgentOperationKind,
        signal: this.options.lifecycle_signal,
        beforeStart: () => {
          this.options.assert_apply_ready();
          if (this.lifecycle.context?.context_id !== expectedContext) {
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
      const application = asanaProposalApplicationResultSchema.parse(await run);
      const result = aiWorkflowApprovalResultSchema.parse({
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
  public reject(
    input: ExternalAgentGuiRejectInput,
    signal: AbortSignal,
  ): ExternalAgentGuiState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = externalAgentGuiRejectInputSchema.parse(input);
    const record = this.requireProposal(request.proposal_id);
    return rejectExternalAgentProposal(record, request.revision, {
      createError: (code, message) => new ExternalAgentServiceError(code, message),
      emitChanged: () => this.review.emitChanged(),
      getState: () => this.getState(),
    });
  }

  /** GUI状態の変更購読を登録します。 */
  public onChanged(listener: (state: ExternalAgentGuiState) => void): () => void {
    return this.review.onChanged(listener);
  }

  /** 外部提案を文脈変更として失効させます。 */
  public expireForContextChange(): void {
    this.lifecycle.rotate();
    this.expireProposals("context_changed");
  }

  /** 外部連携サービスを停止します。 */
  public stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  private async dispatchRequest(
    input: ExternalAgentRequestInput,
  ): Promise<ExternalAgentResponse | Record<string, unknown>> {
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
        return this.getProposalStatus(input.proposal_id, input.operation_ids);
      case "review.open":
        return this.openReview(input.proposal_id);
    }
  }

  private createInfoResponse(): ExternalAgentInfoResponse {
    const runtime = this.options.get_runtime_state();
    const context = this.lifecycle.context;
    const bridgeState = this.options.bridge.getState();
    return externalAgentInfoResponseSchema.parse(externalAgentInfoResponse({
      appVersion: identifierSchema.parse(this.options.app_version),
      protocolVersion: externalAgentProtocolVersion,
      instanceId: identifierSchema.parse(this.options.instance_id),
      context,
      observedAt: nowIso(this.options.now_provider),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      bridgeState,
      runtime,
      onlineProvider: this.options.online_provider,
      preparedContextCount: this.preparation.contextCount(),
      proposalCount: this.proposals.size,
      inputSchema: () => z.toJSONSchema(externalAgentRequestInputSchema, { target: "draft-07" }),
    }));
  }

  private assertEnabled(): void {
    this.lifecycle.assertEnabled();
  }

  private requireContext(): ExternalAgentContext {
    return this.lifecycle.requireContext();
  }

  private assertReadReady(): ExternalAgentContext {
    return this.lifecycle.assertReadReady();
  }

  private executeTaskctlRequest(
    input: ExternalAgentTaskListInput
      | ExternalAgentTaskDetailInput
      | ExternalAgentTaskRankInput
      | ExternalAgentTaskGraphInput
      | ExternalAgentTaskAreasInput
      | ExternalAgentTaskSearchLocalInput,
  ): ExternalAgentTaskQueryResponse {
    const contextId = input.proposal_context_id;
    let snapshot: TaskctlSnapshot;
    if (contextId == null) {
      this.assertReadReady();
      snapshot = this.options.taskctl_schemas.taskctlSnapshotSchema.parse(this.options.get_taskctl_snapshot());
    } else {
      snapshot = this.preparation.requireContext(contextId).taskctl_snapshot;
    }
    const query = externalAgentTaskctlQuery(input);
    const result = executeTaskctlQuery(query, snapshot, this.options.taskctl_schemas);
    return createExternalAgentResponseSchemas(
      this.options.taskctl_schemas.taskctlResponseSchema,
    ).externalAgentTaskQueryResponseSchema.parse({
      operation: input.operation,
      ...(contextId == null ? {} : { proposal_context_id: contextId }),
      result,
    });
  }

  private prepareExternalProposal(
    input: ExternalAgentProposalPrepareInput,
  ): Promise<ExternalAgentProposalPrepareResponse> {
    return this.preparation.prepare(input, {
      digest: canonicalizeJson,
      stopped: () => this.lifecycle.stopped,
      requireContext: () => this.requireContext(),
      assertRequestContext: (request, context) => assertExternalAgentRequestContext(
        request, context, this.options.instance_id,
        (message) => new ExternalAgentServiceError("context_mismatch", message),
      ),
      assertApplyReady: () => this.options.assert_apply_ready(),
      online: this.options.online_provider,
      maximumRequests,
      createBaseline: () => this.options.create_baseline(this.options.lifecycle_signal),
      createPreparedContext: (request, context, baseline) => this.createPreparedContext(request, context, baseline),
      createResponse: (prepared) => this.createPrepareResponse(prepared),
      createError: (code, message, cause) => new ExternalAgentServiceError(code, message, cause),
      isExpectedError: (error): error is ExternalAgentServiceError => error instanceof ExternalAgentServiceError,
      isContextInvalidatedError: (error) => error instanceof AsanaOperationInvalidatedError
        && error.reason === "context_changed",
    });
  }

  private createPreparedContext(
    input: ExternalAgentProposalPrepareInput,
    context: ExternalAgentContext,
    baseline: ExternalAgentBaseline,
  ): PreparedExternalContext {
    return createExternalAgentPreparedContext(input, context, baseline, {
      stopped: () => this.lifecycle.stopped,
      currentContextId: () => this.lifecycle.context?.context_id,
      parseBaseline: (value) => baselineSnapshotSchema.parse(value),
      parseTaskctl: (value) => this.options.taskctl_schemas.taskctlSnapshotSchema.parse(value),
      taskctlSummary: (snapshot) => ({
        sync_kind: snapshot.sync.kind,
        ...(snapshot.sync.kind === "synced" ? { synced_at: snapshot.sync.synced_at } : {}),
        tasks: snapshot.tasks,
      }),
      canonicalize: canonicalizeJson,
      createId: () => identifierSchema.parse(randomUUID()),
      hashBaseline: hashBaselineSnapshot,
      parseTurnContext: (value) => aiWorkflowTurnContextSchema.parse(value),
      createWorkspace: (workspaceId, baselineSnapshotHash) => new ProposalWorkspace({
        workspace_id: workspaceId,
        baseline_snapshot_hash: baselineSnapshotHash,
      }),
      createError: (code, message) => new ExternalAgentServiceError(code, message),
    });
  }

  private createPrepareResponse(
    prepared: PreparedExternalContext,
  ): ExternalAgentProposalPrepareResponse {
    return externalAgentProposalPrepareResponseSchema.parse(externalAgentPrepareResponse(prepared));
  }

  private requireWorkspace(input: {
    readonly instance_id: string;
    readonly context_id: string;
    readonly project_gid: string;
    readonly proposal_context_id: string;
    readonly workspace_id: string;
  }): PreparedExternalContext {
    return requireExternalAgentWorkspace(input, {
      requireContext: () => this.requireContext(),
      instanceId: this.options.instance_id,
      requirePreparedContext: (id) => this.preparation.requireContext(id),
      createError: (message) => new ExternalAgentServiceError("context_mismatch", message),
    });
  }

  private readWorkspace(input: ExternalAgentProposalReadInput): ExternalAgentProposalReadResponse {
    const workspace = this.requireWorkspace(input).workspace;
    const chunk = workspace.read({
      workspace_id: input.workspace_id,
      revision: input.revision,
      target: input.target,
      ...(input.offset == null ? {} : { offset: input.offset }),
    });
    return externalAgentProposalReadResponseSchema.parse(
      externalAgentWorkspaceReadResponse(input.target, chunk, maximumWorkspaceCliResponseBytes),
    );
  }

  private applyWorkspaceEdits(
    input: ExternalAgentProposalApplyEditsInput,
  ): ExternalAgentProposalApplyEditsResponse {
    const status = this.requireWorkspace(input).workspace.applyBatch({
      workspace_id: input.workspace_id,
      edit_batch_id: input.edit_batch_id,
      expected_revision: input.expected_revision,
      edits: input.edits,
    });
    return externalAgentProposalApplyEditsResponseSchema.parse(externalAgentWorkspaceEditsResponse(status));
  }

  private diffWorkspace(input: ExternalAgentProposalDiffInput): ExternalAgentProposalDiffResponse {
    const workspace = this.requireWorkspace(input).workspace;
    const chunk = workspace.diff({
      workspace_id: input.workspace_id,
      from_revision: input.from_revision,
      revision: input.revision,
      ...(input.offset == null ? {} : { offset: input.offset }),
    });
    return externalAgentProposalDiffResponseSchema.parse(
      externalAgentWorkspaceDiffResponse(chunk, maximumWorkspaceCliResponseBytes),
    );
  }

  private validateWorkspace(
    input: ExternalAgentProposalValidateInput,
  ): ExternalAgentProposalValidateResponse {
    const prepared = this.requireWorkspace(input);
    const result = prepared.workspace.validate({
      workspace_id: input.workspace_id,
      expected_revision: input.expected_revision,
    }, (proposal) => this.validateExternalProposal(prepared, proposal));
    return externalAgentProposalValidateResponseSchema.parse(
      externalAgentValidationResponse(
        input.workspace_id,
        input.offset ?? 0,
        result,
        eligibleOperationIds,
        maximumExternalAgentMessageBytes,
        maximumWorkspaceCliResponseBytes,
        () => new ExternalAgentServiceError("invalid_request", "検証結果の読み取り位置が件数を超えています。"),
      ),
    );
  }

  private submitWorkspace(input: ExternalAgentProposalSubmitInput): ExternalAgentProposalSubmitResponse {
    return this.submission.submit(input, {
      digest: canonicalizeJson,
      requireProposal: (proposalId) => this.requireProposal(proposalId),
      requireWorkspace: (request) => this.requireWorkspace(request),
      assertApplyReady: () => this.options.assert_apply_ready(),
      online: this.options.online_provider,
      maximumRequests,
      validate: (prepared, request) => prepared.workspace.validate({
        workspace_id: request.workspace_id,
        expected_revision: request.expected_revision,
      }, (proposal) => this.validateExternalProposal(prepared, proposal)),
      createProposalId: () => identifierSchema.parse(randomUUID()),
      createRecord: (request, prepared, proposal, validation, id) =>
        this.createExternalProposalRecord(request, prepared, proposal, validation, id),
      seal: (prepared, request) => prepared.workspace.submit({
        workspace_id: request.workspace_id,
        expected_revision: request.expected_revision,
      }, (proposal) => this.validateExternalProposal(prepared, proposal)),
      registerProposal: (record) => { this.proposals.set(record.proposal_id, record); },
      emitChanged: () => this.review.emitChanged(),
      createInvalidResponse: (workspaceId, revision) => externalAgentProposalSubmitResponseSchema.parse({
        operation: "proposals.submit",
        workspace_id: workspaceId,
        revision,
        result: { kind: "invalid" },
      }),
      createSubmitResponse: (workspaceId, revision, record) => this.createSubmitResponse(workspaceId, revision, record),
      createError: (code, message) => new ExternalAgentServiceError(code, message),
    });
  }

  private createSubmitResponse(
    workspaceId: string,
    revision: number,
    record: ExternalProposalRecord,
  ): ExternalAgentProposalSubmitResponse {
    return externalAgentProposalSubmitResponseSchema.parse(
      externalAgentSubmitResponse(workspaceId, revision, record),
    );
  }

  private createExternalProposalRecord(
    input: ExternalAgentProposalSubmitInput,
    prepared: PreparedExternalContext,
    proposal: Proposal,
    validation: ExternalProposalValidation,
    proposalId: string,
  ): ExternalProposalRecord {
    return createExternalAgentProposalRecord(input, prepared, proposal, validation, proposalId, {
      stopped: () => this.lifecycle.stopped,
      currentContextId: () => this.lifecycle.context?.context_id,
      eligibleOperationIds,
      createView: (id, candidate, snapshot, hash, basic, graph, selectedIds) => createWorkflowProposalView({
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

  private validateExternalProposal(
    prepared: PreparedExternalContext,
    proposal: Proposal,
  ): ProposalWorkspaceValidation<ExternalProposalValidation> {
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

  private getProposalStatus(
    proposalId: string,
    operationIds: readonly string[],
  ): ExternalAgentProposalStatusResponse {
    return externalAgentProposalStatus(proposalId, operationIds, {
      parseIdentifier: (value) => identifierSchema.parse(value),
      getProposal: (id) => this.proposals.get(id),
      getSavedResult: (id, operationId) => this.options.get_saved_operation_result(id, operationId),
      createConflictError: () => new ExternalAgentServiceError("conflict", "操作ID集合が提案と一致しません。"),
      parseCurrentResult: (value) => externalAgentProposalStatusResultSchema.parse(value),
      parseResponse: (value) => externalAgentProposalStatusResponseSchema.parse(value),
    });
  }

  private async openReview(
    proposalId: string,
  ): Promise<ExternalAgentReviewOpenResponse> {
    return this.review.open(proposalId, {
      requireProposal: (id) => this.requireProposal(id),
      createId: () => identifierSchema.parse(randomUUID()),
      openReview: (id, requestId) => this.options.open_review(id, requestId),
      createResponse: (id, requestId) => externalAgentReviewOpenResponseSchema.parse({
        operation: "review.open", proposal_id: id, request_id: requestId, opened: true,
      }),
      createConflictError: () => new ExternalAgentServiceError("conflict", "この提案は確認画面を開けません。"),
    });
  }

  private requireProposal(proposalId: string): ExternalProposalRecord {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const record = this.proposals.get(parsedProposalId);
    if (record == null) {
      throw new ExternalAgentServiceError("not_found", "指定された外部提案がありません。");
    }
    return record;
  }

  private resolveSelection(
    record: ExternalProposalRecord,
    selection: AiWorkflowSelection,
  ): readonly string[] {
    try {
      const selected = resolveSelectedOperationIds(record, aiWorkflowSelectionSchema.parse(selection));
      assertSelectedProposalGraphIsSafe(record, selected);
      return selected;
    } catch (error: unknown) {
      if (error instanceof AiWorkflowSelectionError) {
        throw new ExternalAgentServiceError("invalid_request", error.message, error);
      }
      throw error;
    }
  }

  private assertExternalEvidence(
    record: ExternalProposalRecord,
    operationIds: readonly string[],
  ): {
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

  private assertRevision(record: ExternalProposalRecord, revision: number): void {
    if (record.revision !== revision) {
      throw new ExternalAgentServiceError("stale_revision", "提案の表示版が更新されています。");
    }
  }

  private validateProposal(
    record: ExternalProposalRecord,
    proposal: Proposal,
  ): { readonly basic: ProposalValidationResult; readonly graph: GraphValidationResult } {
    return validateExternalAgentSubmittedProposal({
      validateBasic: () => validateProposal({
        proposal,
        baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
        managed_tasks: record.snapshot.tasks,
        existing_areas: record.snapshot.areas,
        explicit_split_request_references: [...record.explicit_split_request_references],
        trusted_status_evidence: [...record.trusted_status_evidence],
      }),
      validateGraph: (basic) => validateProposalGraph({
        proposal,
        managed_tasks: record.snapshot.tasks,
        basic_validation_result: basic,
      }),
    });
  }

  private createView(
    record: ExternalProposalRecord,
    proposal: Proposal,
    basic: ProposalValidationResult,
    graph: GraphValidationResult,
  ): AiWorkflowProposalView {
    return createWorkflowProposalView({
      proposal_id: record.proposal_id,
      proposal,
      snapshot: record.snapshot,
      baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
      basic_validation: basic,
      graph_validation: graph,
      selected_operation_ids: [...record.selected_operation_ids],
    });
  }

  private expireProposals(reasonCode: "context_changed" | "instance_restarted" | "superseded"): void {
    expireExternalAgentProposals(this.proposals.values(), reasonCode, () => this.review.emitChanged());
  }
}
