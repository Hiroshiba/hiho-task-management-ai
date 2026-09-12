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
  validateProposalGraph,
  type ExplicitSplitRequestReference,
  type TrustedStatusEvidenceReference,
  type GraphValidationResult,
  type ProposalValidationResult,
} from "../ai/proposal-validation";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
} from "../ai/proposal-application";
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
  AsanaOperationInvalidatedError,
  type AsanaOperationQueue,
  type AsanaOperationKind,
} from "../asana/operation-queue";
import type { AsanaSyncRuntimeState } from "../asana/runtime";
import type { ApplicationJournal } from "../../shared/storage";
import type {
  ExternalAgentBridgeState,
  ExternalAgentCreateProposalInput,
  ExternalAgentProposalPrepareInput,
  ExternalAgentErrorCode,
  ExternalAgentGuiApproveInput,
  ExternalAgentGuiEditInput,
  ExternalAgentGuiState,
  ExternalAgentGuiRejectInput,
  ExternalAgentGuiSelectInput,
  ExternalAgentGuiSetEnabledInput,
  ExternalAgentInfoResponse,
  ExternalAgentProposal,
  ExternalAgentProposalStatus,
  ExternalAgentProposalStatusResult,
  ExternalAgentRequestInput,
  ExternalAgentResponse,
  ExternalAgentTaskQueryResponse,
  ExternalAgentTaskListInput,
  ExternalAgentTaskDetailInput,
  ExternalAgentTaskRankInput,
  ExternalAgentTaskGraphInput,
  ExternalAgentTaskAreasInput,
  ExternalAgentTaskSearchLocalInput,
  ExternalAgentProposalPrepareResponse,
  ExternalAgentProposalCreateResponse,
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
  externalAgentProposalCreateResponseSchema,
  externalAgentProposalPrepareResponseSchema,
  externalAgentProposalSchema,
  externalAgentProposalStatusResponseSchema,
  externalAgentProposalStatusResultSchema,
  externalAgentRequestInputSchema,
  externalAgentReviewOpenResponseSchema,
  externalAgentTaskQueryResponseSchema,
  externalAgentProtocolVersion,
} from "../../shared/external-agent";
import type { IpcExternalAgentPort } from "../ipc";
import type {
  ExternalAgentBridge,
} from "./transport";
import { hashBaselineSnapshot } from "../domain/snapshot-hash";
import {
  executeTaskctlQuery,
  taskctlSnapshotSchema,
  type TaskctlQuery,
  type TaskctlSnapshot,
} from "../codex/taskctl";

const maximumRequests = 100;
const externalAgentOperationKind: AsanaOperationKind = "external_apply";

type ExternalAgentContext = {
  readonly context_id: string;
  readonly project_gid: string;
  readonly source_key: string;
};

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

type ExternalAgentRegistration = {
  readonly symlinkCommand: string;
  readonly allowExecutionCommand: string;
};

type TransportExternalAgentBridgeState = ReturnType<ExternalAgentBridge["getState"]>;

export type ExternalAgentServiceOptions = {
  readonly app_version: string;
  readonly instance_id: string;
  readonly lifecycle_signal: AbortSignal;
  readonly now_provider: () => Date;
  readonly online_provider: () => boolean;
  readonly get_taskctl_snapshot: () => TaskctlSnapshot;
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
  readonly get_journal: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
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
  readonly evidence_locator_prefix: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly taskctl_snapshot: TaskctlSnapshot;
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

type ExternalAgentRequestFailure =
  | { readonly kind: "expected"; readonly error: ExternalAgentServiceError }
  | { readonly kind: "unexpected" };

type RequestRecord =
  | {
      readonly kind: "pending";
      readonly prepare_digest: string;
      readonly create_digest: string;
      readonly proposal_id: string;
      readonly creation: Promise<ExternalProposalRecord | undefined>;
    }
  | {
      readonly kind: "accepted";
      readonly prepare_digest: string;
      readonly create_digest: string;
      readonly proposal_id: string;
      readonly creation: Promise<ExternalProposalRecord>;
    }
  | {
      readonly kind: "failed";
      readonly prepare_digest: string;
      readonly create_digest: string;
      readonly proposal_id: string;
      readonly creation: Promise<undefined>;
      readonly failure: ExternalAgentRequestFailure;
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
};

type PreparedRequestRecord =
  | {
      readonly kind: "pending";
      readonly digest: string;
      readonly creation: Promise<PreparedExternalContext | undefined>;
    }
  | {
      readonly kind: "accepted";
      readonly digest: string;
      readonly creation: Promise<PreparedExternalContext>;
    }
  | {
      readonly kind: "failed";
      readonly digest: string;
      readonly creation: Promise<undefined>;
      readonly failure: ExternalAgentRequestFailure;
    };

type ExternalAgentJournalStatus = Extract<
  ExternalAgentProposalStatusResult,
  { readonly kind: "journals" }
>["results"][number];

/** 外部連携の業務エラーを表します。 */
export class ExternalAgentServiceError extends Error {
  public readonly code: ExternalAgentErrorCode;

  public constructor(code: ExternalAgentErrorCode, message: string, cause?: unknown) {
    super(message, cause == null ? undefined : { cause });
    this.name = "ExternalAgentServiceError";
    this.code = code;
  }
}

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

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
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
): Record<string, unknown> {
  return externalAgentErrorResponseSchema.parse({
    kind: "error",
    code,
    message,
  });
}

function isProposalStatusMutable(status: ExternalAgentProposalStatus): boolean {
  return status.kind === "pending_approval";
}

function isProposalApplying(status: ExternalAgentProposalStatus): boolean {
  return status.kind === "approving";
}

function createApplicationSummary(
  result: AsanaProposalApplicationResult,
): z.infer<typeof aiWorkflowApprovalResultSchema>["application"] {
  return {
    outcome: result.outcome,
    operations: result.operations.map((operation) => ({
      group_id: operation.group_id,
      operation_id: operation.operation_id,
      ...(operation.task_gid == null ? {} : { task_gid: operation.task_gid }),
      outcome: operation.outcome,
      reason_code: operation.reason_code,
    })),
    groups: result.groups.map((group) => ({
      group_id: group.group_id,
      atomic: group.atomic,
      outcome: group.outcome,
      operation_ids: [...group.operation_ids],
    })),
  };
}

function createProposalResult(
  record: ExternalProposalRecord,
): ExternalAgentProposal {
  return externalAgentProposalSchema.parse({
    proposal_id: record.proposal_id,
    request_id: record.request_id,
    instance_id: record.instance_id,
    context_id: record.context_id,
    proposal_context_id: record.proposal_context_id,
    operation_ids: [...record.operation_ids],
    revision: record.revision,
    source: "external_tool",
    state: record.state,
    view: record.view,
  });
}

/** 外部Codex連携の提案受付とGUI操作を管理します。 */
export class ExternalAgentService implements IpcExternalAgentPort {
  private readonly options: ExternalAgentServiceOptions;
  private readonly requests = new Map<string, RequestRecord>();
  private readonly preparedRequests = new Map<string, PreparedRequestRecord>();
  private readonly preparedContexts = new Map<string, PreparedExternalContext>();
  private readonly proposals = new Map<string, ExternalProposalRecord>();
  private readonly listeners = new Set<(state: ExternalAgentGuiState) => void>();
  private context: ExternalAgentContext | undefined;
  private reviewTarget: { readonly proposal_id: string; readonly request_id: string } | undefined;
  private stopped = false;

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
    if (contextInput == null) {
      if (this.context != null) {
        this.context = undefined;
        this.preparedContexts.clear();
        this.preparedRequests.clear();
        this.expireProposals("context_changed");
      }
      return;
    }
    const validatedProjectGid = gidSchema.parse(contextInput.project_gid);
    if (
      this.context?.project_gid === validatedProjectGid
      && this.context.source_key === contextInput.source_key
    ) {
      return;
    }
    this.context = {
      context_id: identifierSchema.parse(randomUUID()),
      project_gid: validatedProjectGid,
      source_key: contextInput.source_key,
    };
    this.preparedContexts.clear();
    this.preparedRequests.clear();
    this.expireProposals("context_changed");
  }

  /** 外部連携要求を検証して処理します。 */
  public async handleRequest(input: unknown, signal: AbortSignal): Promise<unknown> {
    validateAbortSignal(signal);
    let parsedInput: z.infer<typeof externalAgentCliInputSchema>;
    try {
      parsedInput = externalAgentCliInputSchema.parse(input);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return createErrorResponse("invalid_request", "外部連携要求の形式が不正です。");
      }
      throw error;
    }
    try {
      if (parsedInput.operation === "agent-info") {
        return this.createInfoResponse();
      }
      this.assertEnabled();
      return await this.dispatchRequest(parsedInput);
    } catch (error: unknown) {
      if (error instanceof ExternalAgentServiceError) {
        return createErrorResponse(error.code, error.message);
      }
      if (error instanceof z.ZodError) {
        return createErrorResponse("invalid_request", "外部連携要求の形式が不正です。");
      }
      throw error;
    }
  }

  /** GUIへ返す外部提案の状態スナップショットを取得します。 */
  public getState(): ExternalAgentGuiState {
    const bridgeState = this.options.bridge.getState();
    const bridge = this.createBridgeState(bridgeState);
    const registration = this.createRegistration(this.options.bridge.getRegistration());
    const proposals = [...this.proposals.values()]
      .sort((left, right) => compareStrings(left.proposal_id, right.proposal_id))
      .map(createProposalResult);
    return externalAgentGuiStateSchema.parse({
      enabled: bridgeState.enabled,
      bridge,
      registration,
      proposals,
      ...(this.reviewTarget == null ? {} : { review_target: this.reviewTarget }),
    });
  }

  /** 外部連携の有効状態を変更します。 */
  public async setEnabled(
    input: ExternalAgentGuiSetEnabledInput,
    signal: AbortSignal,
  ): Promise<ExternalAgentGuiState> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    if (this.stopped) {
      throw new ExternalAgentServiceError("unavailable", "外部連携サービスは停止済みです。");
    }
    await this.options.bridge.setEnabled(input.enabled);
    if (!input.enabled) {
      this.rotateContextGeneration();
      this.expireProposals("superseded");
    }
    this.emitChanged();
    return this.getState();
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
    this.assertRevision(record, request.revision);
    if (!isProposalStatusMutable(record.state)) {
      throw new ExternalAgentServiceError("conflict", "この提案は選択を変更できません。");
    }
    const selectedOperationIds = this.resolveSelection(record, request.selection);
    record.selected_operation_ids = [...selectedOperationIds];
    record.view = this.createView(
      record,
      record.proposal,
      this.validateProposal(record, record.proposal).basic,
      record.graph_validation,
    );
    record.revision += 1;
    this.emitChanged();
    return this.getState();
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
    if (!record.operation_ids.includes(request.operation_id)) {
      throw new ExternalAgentServiceError("conflict", "操作IDが提案と一致しません。");
    }
    this.assertRevision(record, request.revision);
    if (!isProposalStatusMutable(record.state)) {
      throw new ExternalAgentServiceError("conflict", "この提案は編集できません。");
    }
    const operation = record.proposal.groups
      .flatMap((group) => group.operations)
      .find((candidate) => candidate.operation_id === request.operation_id);
    if (operation == null) {
      throw new ExternalAgentServiceError("not_found", "指定した操作が提案にありません。");
    }
    const editedOperation = proposalOperationSchema.parse({
      ...operation,
      after: request.after,
      basis: "explicit",
      confidence: 1,
      evidence_refs: [
        ...operation.evidence_refs,
        { kind: "external_review", locator: request.evidence_locator },
      ],
    });
    const editedProposal = proposalSchema.parse({
      ...record.proposal,
      groups: record.proposal.groups.map((group) => ({
        ...group,
        operations: group.operations.map((candidate) =>
          candidate.operation_id === request.operation_id ? editedOperation : candidate),
      })),
    });
    const validation = this.validateProposal(record, editedProposal);
    record.proposal = editedProposal;
    record.graph_validation = validation.graph;
    record.selected_operation_ids = preserveSelection(
      editedProposal,
      validation.graph,
      record.selected_operation_ids,
    );
    record.view = this.createView(record, editedProposal, validation.basic, validation.graph);
    record.revision += 1;
    record.state = { kind: "pending_approval" };
    this.emitChanged();
    return this.getState();
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
    this.emitChanged();
    const expectedContext = record.context_id;
    try {
      const run = this.options.operation_queue.enqueue({
        priority: "user",
        kind: externalAgentOperationKind,
        signal: this.options.lifecycle_signal,
        beforeStart: () => {
          this.options.assert_apply_ready();
          if (this.context?.context_id !== expectedContext) {
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
        application: createApplicationSummary(application),
      });
      record.revision += 1;
      record.state = { kind: "finished", result };
      this.emitChanged();
    } catch (error: unknown) {
      if (error instanceof AsanaOperationInvalidatedError && error.reason === "context_changed") {
        record.revision += 1;
        record.state = { kind: "expired", reason_code: "context_changed" };
        this.emitChanged();
        throw new ExternalAgentServiceError("context_changed", "提案の文脈が変更されたため失効しました。", error);
      }
      record.revision += 1;
      record.state = {
        kind: "failed",
        reason_code: "unavailable",
        message: "提案の適用に失敗しました。",
      };
      this.emitChanged();
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
    this.assertRevision(record, request.revision);
    if (!isProposalStatusMutable(record.state)) {
      throw new ExternalAgentServiceError("conflict", "この提案は却下できません。");
    }
    record.revision += 1;
    record.state = { kind: "rejected" };
    this.emitChanged();
    return this.getState();
  }

  /** GUI状態の変更購読を登録します。 */
  public onChanged(listener: (state: ExternalAgentGuiState) => void): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("外部連携状態の購読関数が必要です。");
    }
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  /** 外部提案を文脈変更として失効させます。 */
  public expireForContextChange(): void {
    this.rotateContextGeneration();
    this.expireProposals("context_changed");
  }

  private rotateContextGeneration(): void {
    if (this.context != null) {
      this.context = {
        ...this.context,
        context_id: identifierSchema.parse(randomUUID()),
      };
      this.preparedContexts.clear();
      this.preparedRequests.clear();
    }
  }

  /** 外部連携サービスを停止します。 */
  public stop(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.stopped = true;
    this.preparedContexts.clear();
    this.preparedRequests.clear();
    this.expireProposals("instance_restarted");
    this.listeners.clear();
    return Promise.resolve();
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
      case "proposals.create":
        return this.createExternalProposal(input);
      case "proposals.status":
        return this.getProposalStatus(input.proposal_id, input.operation_ids);
      case "review.open":
        return this.openReview(input.proposal_id);
    }
  }

  private createInfoResponse(): ExternalAgentInfoResponse {
    const runtime = this.options.get_runtime_state();
    const context = this.context;
    const bridgeState = this.options.bridge.getState();
    const bridge = this.createBridgeState(bridgeState);
    const response = {
      app_version: identifierSchema.parse(this.options.app_version),
      protocol_version: externalAgentProtocolVersion,
      instance_id: identifierSchema.parse(this.options.instance_id),
      context: context == null
        ? { kind: "unconfigured" }
        : {
            kind: "ready",
            context_id: context.context_id,
            project_gid: context.project_gid,
          },
      observed_at: nowIso(this.options.now_provider),
      time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      bridge,
      sync_status: this.syncStatus(runtime),
      ...(runtime?.last_successful_sync_at == null
        ? {}
        : { last_successful_sync_at: runtime.last_successful_sync_at }),
      capabilities: this.createCapabilities(context, runtime, bridgeState),
      input_schema: z.toJSONSchema(externalAgentRequestInputSchema, { target: "draft-07" }),
    };
    return externalAgentInfoResponseSchema.parse(response);
  }

  private createCapabilities(
    context: ExternalAgentContext | undefined,
    runtime: AsanaSyncRuntimeState | undefined,
    bridge: TransportExternalAgentBridgeState,
  ): readonly string[] {
    if (bridge.kind !== "running" || bridge.enabled !== true) {
      return [];
    }
    const capabilities: string[] = ["proposals.status"];
    if (context != null && runtime?.last_successful_sync_at != null) {
      capabilities.push(
        "tasks.list",
        "tasks.get",
        "tasks.rank",
        "tasks.graph",
        "tasks.areas",
        "tasks.search-local",
      );
    }
    const runtimeCanAcceptCreate = runtime != null
      && (runtime.kind === "online" || runtime.kind === "syncing")
      && runtime.last_successful_sync_at != null
      && runtime.last_error_code == null;
    if (context != null && runtimeCanAcceptCreate && this.options.online_provider() === true) {
      capabilities.push("proposals.prepare", "proposals.create");
    }
    if (this.proposals.size > 0) {
      capabilities.push("review.open");
    }
    return capabilities;
  }

  private syncStatus(runtime: AsanaSyncRuntimeState | undefined):
    | "synced"
    | "syncing"
    | "offline"
    | "never_synced" {
    if (runtime == null || runtime.last_successful_sync_at == null) {
      return "never_synced";
    }
    if (runtime.kind === "syncing") {
      return "syncing";
    }
    if (runtime.kind === "offline" || runtime.kind === "authentication_required" || runtime.kind === "error") {
      return "offline";
    }
    return "synced";
  }

  private createBridgeState(
    state: TransportExternalAgentBridgeState,
  ): ExternalAgentBridgeState {
    if (state.kind === "unavailable") {
      return {
        kind: "unavailable",
        code: "unavailable",
        message: "外部連携ブリッジを利用できません。",
      };
    }
    return { kind: state.kind };
  }

  private createRegistration(registration: ExternalAgentRegistration): ExternalAgentGuiState["registration"] {
    return {
      command: registration.symlinkCommand,
      allow_execution_command: registration.allowExecutionCommand,
      instructions: "TaskHubで外部連携を有効にし、使用するWSLまたはMacのターミナルで登録コマンドを実行してください。実行許可を登録した場合はCodexを再起動してください。",
    };
  }

  private assertEnabled(): void {
    const bridge = this.options.bridge.getState();
    if (bridge.kind === "unavailable") {
      throw new ExternalAgentServiceError("unavailable", "外部連携ブリッジを利用できません。");
    }
    if (bridge.enabled !== true || bridge.kind !== "running") {
      throw new ExternalAgentServiceError("disabled", "外部連携が無効です。");
    }
  }

  private requireContext(): ExternalAgentContext {
    const context = this.context;
    if (context == null) {
      throw new ExternalAgentServiceError("setup_required", "Asanaの初回設定が完了していません。");
    }
    return context;
  }

  private assertReadReady(): ExternalAgentContext {
    const context = this.requireContext();
    const runtime = this.options.get_runtime_state();
    if (runtime == null || runtime.last_successful_sync_at == null) {
      throw new ExternalAgentServiceError("offline", "一覧を取得できる同期済みキャッシュがありません。");
    }
    return context;
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
      snapshot = taskctlSnapshotSchema.parse(this.options.get_taskctl_snapshot());
    } else {
      snapshot = this.requirePreparedContext(contextId).taskctl_snapshot;
    }
    const query = this.toTaskctlQuery(input);
    const result = executeTaskctlQuery(query, snapshot);
    return externalAgentTaskQueryResponseSchema.parse({
      operation: input.operation,
      ...(contextId == null ? {} : { proposal_context_id: contextId }),
      result,
    });
  }

  private toTaskctlQuery(
    input: ExternalAgentTaskListInput
      | ExternalAgentTaskDetailInput
      | ExternalAgentTaskRankInput
      | ExternalAgentTaskGraphInput
      | ExternalAgentTaskAreasInput
      | ExternalAgentTaskSearchLocalInput,
  ): TaskctlQuery {
    switch (input.operation) {
      case "tasks.list":
        return { command: "list" };
      case "tasks.get":
        return { command: "get", gid: input.gid };
      case "tasks.rank":
        return { command: "rank" };
      case "tasks.graph":
        return { command: "graph" };
      case "tasks.areas":
        return { command: "areas" };
      case "tasks.search-local":
        return { command: "search-local", query: input.query };
    }
  }

  private async prepareExternalProposal(
    input: ExternalAgentProposalPrepareInput,
  ): Promise<ExternalAgentProposalPrepareResponse> {
    const digest = canonicalizeJson(input);
    const existing = this.preparedRequests.get(input.request_id);
    if (existing != null) {
      if (existing.digest !== digest) {
        throw new ExternalAgentServiceError("request_id_reused", "同じrequest_idへ別の内容を指定できません。");
      }
      const prepared = await existing.creation;
      if (prepared == null) {
        const current = this.preparedRequests.get(input.request_id);
        if (current?.kind === "failed" && current.failure.kind === "expected") {
          throw current.failure.error;
        }
        throw new ExternalAgentServiceError("unknown_result", "提案基準の準備結果が不明です。");
      }
      return this.createPrepareResponse(prepared);
    }
    if (this.stopped) {
      throw new ExternalAgentServiceError("unavailable", "外部連携サービスは停止済みです。");
    }
    const context = this.requireContext();
    this.assertRequestContext(input.instance_id, input.context_id, input.project_gid, context);
    this.options.assert_apply_ready();
    if (this.options.online_provider() !== true) {
      throw new ExternalAgentServiceError("offline", "オフライン中は提案基準を準備できません。");
    }
    if (this.preparedRequests.size >= maximumRequests) {
      throw new ExternalAgentServiceError("capacity_exceeded", "外部提案の受付上限に達しています。");
    }
    const creation = Promise.resolve()
      .then(() => this.options.create_baseline(this.options.lifecycle_signal))
      .then((baseline) => this.createPreparedContext(input, context, baseline))
      .then(
        (prepared) => {
          this.preparedContexts.set(prepared.proposal_context_id, prepared);
          this.preparedRequests.set(input.request_id, {
            kind: "accepted",
            digest,
            creation: Promise.resolve(prepared),
          });
          return prepared;
        },
        (error: unknown) => {
          let expectedError: ExternalAgentServiceError | undefined;
          if (error instanceof ExternalAgentServiceError) {
            expectedError = error;
          } else if (
            error instanceof AsanaOperationInvalidatedError
            && error.reason === "context_changed"
          ) {
            expectedError = new ExternalAgentServiceError(
              "context_changed",
              "提案準備中にAsana文脈が変更されました。",
              error,
            );
          }
          let failure: ExternalAgentRequestFailure;
          if (expectedError == null) {
            failure = { kind: "unexpected" };
          } else {
            failure = { kind: "expected", error: expectedError };
          }
          this.preparedRequests.set(input.request_id, {
            kind: "failed",
            digest,
            creation: Promise.resolve(undefined),
            failure,
          });
          if (expectedError != null) {
            return undefined;
          }
          throw error;
        },
      );
    this.preparedRequests.set(input.request_id, { kind: "pending", digest, creation });
    const prepared = await creation;
    if (prepared == null) {
      const current = this.preparedRequests.get(input.request_id);
      if (current?.kind === "failed" && current.failure.kind === "expected") {
        throw current.failure.error;
      }
      throw new ExternalAgentServiceError("unknown_result", "提案基準の準備結果が不明です。");
    }
    return this.createPrepareResponse(prepared);
  }

  private createPreparedContext(
    input: ExternalAgentProposalPrepareInput,
    context: ExternalAgentContext,
    baseline: ExternalAgentBaseline,
  ): PreparedExternalContext {
    if (this.stopped || this.context?.context_id !== context.context_id) {
      throw new ExternalAgentServiceError("context_changed", "提案準備中にAsana文脈が変更されました。");
    }
    const validatedBaseline = baselineSnapshotSchema.parse(baseline.baseline_snapshot);
    const validatedTaskctlSnapshot = taskctlSnapshotSchema.parse(baseline.taskctl_snapshot);
    if (
      baseline.snapshot.project_gid !== context.project_gid
      || validatedBaseline.project_gid !== context.project_gid
      || validatedTaskctlSnapshot.sync.kind !== "synced"
      || validatedTaskctlSnapshot.sync.synced_at !== baseline.snapshot.synced_at
      || canonicalizeJson(validatedTaskctlSnapshot.tasks) !== canonicalizeJson(baseline.snapshot.tasks)
    ) {
      throw new ExternalAgentServiceError("conflict", "提案基準とtaskctl基準が一致しません。");
    }
    const proposalContextId = identifierSchema.parse(randomUUID());
    const baselineSnapshotHash = hashBaselineSnapshot(validatedBaseline);
    const turnContext = aiWorkflowTurnContextSchema.parse({
      baseline_snapshot_hash: baselineSnapshotHash,
      app_version: baseline.snapshot.app_version,
      project_gid: baseline.snapshot.project_gid,
      synced_at: baseline.snapshot.synced_at,
      as_of: baseline.snapshot.as_of,
    });
    return {
      request_id: input.request_id,
      instance_id: input.instance_id,
      context_id: input.context_id,
      project_gid: input.project_gid,
      proposal_context_id: proposalContextId,
      source_text: input.source_text,
      evidence_locator_prefix: `external-review:${proposalContextId}`,
      snapshot: baseline.snapshot,
      baseline_snapshot: validatedBaseline,
      baseline_external_data: baseline.baseline_external_data,
      taskctl_snapshot: validatedTaskctlSnapshot,
      turn_context: turnContext,
    };
  }

  private createPrepareResponse(
    prepared: PreparedExternalContext,
  ): ExternalAgentProposalPrepareResponse {
    return externalAgentProposalPrepareResponseSchema.parse({
      operation: "proposals.prepare",
      request_id: prepared.request_id,
      proposal_context_id: prepared.proposal_context_id,
      turn_context: prepared.turn_context,
      evidence_locator_prefix: prepared.evidence_locator_prefix,
    });
  }

  private async createExternalProposal(
    input: ExternalAgentCreateProposalInput,
  ): Promise<ExternalAgentProposalCreateResponse> {
    const digest = canonicalizeJson(input);
    const existing = this.requests.get(input.request_id);
    if (existing != null) {
      if (existing.create_digest !== digest) {
        throw new ExternalAgentServiceError("request_id_reused", "同じrequest_idへ別の内容を指定できません。");
      }
      const record = await existing.creation;
      if (record == null) {
        const current = this.requests.get(input.request_id);
        if (current?.kind === "failed" && current.failure.kind === "expected") {
          throw current.failure.error;
        }
        throw new ExternalAgentServiceError("unknown_result", "受理済み提案の作成結果が不明です。");
      }
      return externalAgentProposalCreateResponseSchema.parse({
        operation: "proposals.create",
        proposal: createProposalResult(record),
      });
    }
    const preparedRecord = this.preparedRequests.get(input.request_id);
    if (preparedRecord == null) {
      throw new ExternalAgentServiceError("invalid_request", "先にproposals.prepareを実行してください。");
    }
    const context = this.requireContext();
    this.assertRequestContext(input.instance_id, input.context_id, input.project_gid, context);
    this.options.assert_apply_ready();
    if (this.options.online_provider() !== true) {
      throw new ExternalAgentServiceError("offline", "オフライン中は提案を作成できません。");
    }
    if (this.requests.size >= maximumRequests) {
      throw new ExternalAgentServiceError("capacity_exceeded", "外部提案の受付上限に達しています。");
    }
    const proposalId = identifierSchema.parse(randomUUID());
    const creation = preparedRecord.creation.then((prepared) => {
      if (prepared == null) {
        if (preparedRecord.kind === "failed" && preparedRecord.failure.kind === "expected") {
          throw preparedRecord.failure.error;
        }
        throw new ExternalAgentServiceError("unknown_result", "提案基準の準備結果が不明です。");
      }
      this.options.assert_apply_ready();
      if (this.options.online_provider() !== true) {
        throw new ExternalAgentServiceError("offline", "オフライン中は提案を作成できません。");
      }
      if (prepared.proposal_context_id !== input.proposal_context_id) {
        throw new ExternalAgentServiceError("context_changed", "指定した提案基準が失効しています。");
      }
      if (this.context?.context_id !== prepared.context_id) {
        throw new ExternalAgentServiceError("context_changed", "Asana文脈が変更されたため提案基準が失効しています。");
      }
      return this.createExternalProposalRecord(input, prepared, proposalId);
    }).then(
      (record) => {
        this.requests.set(input.request_id, {
          kind: "accepted",
          prepare_digest: preparedRecord.digest,
          create_digest: digest,
          proposal_id: proposalId,
          creation: Promise.resolve(record),
        });
        return record;
      },
      (error: unknown) => {
        const expectedError = error instanceof ExternalAgentServiceError ? error : undefined;
        const failure: ExternalAgentRequestFailure = expectedError == null
          ? { kind: "unexpected" }
          : { kind: "expected", error: expectedError };
        this.requests.set(input.request_id, {
          kind: "failed",
          prepare_digest: preparedRecord.digest,
          create_digest: digest,
          proposal_id: proposalId,
          creation: Promise.resolve(undefined),
          failure,
        });
        if (expectedError != null) {
          return undefined;
        }
        throw error;
      },
    );
    this.requests.set(input.request_id, {
      kind: "pending",
      prepare_digest: preparedRecord.digest,
      create_digest: digest,
      proposal_id: proposalId,
      creation,
    });
    const record = await creation;
    if (record == null) {
      const current = this.requests.get(input.request_id);
      if (current?.kind === "failed" && current.failure.kind === "expected") {
        throw current.failure.error;
      }
      throw new ExternalAgentServiceError("unknown_result", "受理済み提案の作成結果が不明です。");
    }
    return externalAgentProposalCreateResponseSchema.parse({
      operation: "proposals.create",
      proposal: createProposalResult(record),
    });
  }

  private createExternalProposalRecord(
    input: ExternalAgentCreateProposalInput,
    prepared: PreparedExternalContext,
    proposalId: string,
  ): ExternalProposalRecord {
    if (this.stopped || this.context?.context_id !== prepared.context_id) {
      throw new ExternalAgentServiceError("context_changed", "Asana文脈が変更されたため提案基準が失効しています。");
    }
    const proposal = proposalSchema.parse(input.proposal);
    const operationIds = proposal.groups.flatMap((group) =>
      group.operations.map((operation) => operation.operation_id));
    const evidence = this.collectExternalEvidence(prepared, proposal);
    const basic = validateProposal({
      proposal,
      baseline_snapshot_hash: prepared.turn_context.baseline_snapshot_hash,
      managed_tasks: prepared.snapshot.tasks,
      existing_areas: prepared.snapshot.areas,
      explicit_split_request_references: [...evidence.split_references],
      trusted_status_evidence: [...evidence.trusted_status_evidence],
    });
    const graph = validateProposalGraph({
      proposal,
      managed_tasks: prepared.snapshot.tasks,
      basic_validation_result: basic,
    });
    const selectedOperationIds = eligibleOperationIds(proposal, graph);
    const record: ExternalProposalRecord = {
      proposal_id: proposalId,
      request_id: input.request_id,
      instance_id: input.instance_id,
      context_id: input.context_id,
      proposal_context_id: prepared.proposal_context_id,
      operation_ids: operationIds,
      source_text: prepared.source_text,
      evidence_locator_prefix: prepared.evidence_locator_prefix,
      snapshot: prepared.snapshot,
      baseline_snapshot: prepared.baseline_snapshot,
      baseline_external_data: prepared.baseline_external_data,
      taskctl_snapshot: prepared.taskctl_snapshot,
      turn_context: prepared.turn_context,
      proposal,
      explicit_split_request_references: [...evidence.split_references],
      trusted_status_evidence: [...evidence.trusted_status_evidence],
      graph_validation: graph,
      selected_operation_ids: [...selectedOperationIds],
      view: createWorkflowProposalView({
        proposal_id: proposalId,
        proposal,
        snapshot: prepared.snapshot,
        baseline_snapshot_hash: prepared.turn_context.baseline_snapshot_hash,
        basic_validation: basic,
        graph_validation: graph,
        selected_operation_ids: selectedOperationIds,
      }),
      revision: 1,
      state: { kind: "pending_approval" },
    };
    this.proposals.set(proposalId, record);
    this.emitChanged();
    return record;
  }

  private collectExternalEvidence(
    prepared: PreparedExternalContext,
    proposal: Proposal,
  ): {
    readonly split_references: readonly ExplicitSplitRequestReference[];
    readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  } {
    const splitReferences: ExplicitSplitRequestReference[] = [];
    const trustedStatusEvidence: TrustedStatusEvidenceReference[] = [];
    for (const operation of proposal.groups.flatMap((group) => group.operations)) {
      const locator = createExternalReviewEvidenceLocator(
        prepared.proposal_context_id,
        operation.operation_id,
      );
      const reference = operation.evidence_refs.find((candidate) =>
        candidate.kind === "external_review"
        && candidate.locator === locator
        && candidate.excerpt != null
        && candidate.excerpt.trim().length > 0
        && prepared.source_text.includes(candidate.excerpt));
      if (reference == null || reference.excerpt == null) {
        throw new ExternalAgentServiceError("invalid_request", "各操作へ提案原文の根拠を指定してください。");
      }
      if (operation.operation === "complete" || operation.operation === "withdraw") {
        if (
          operation.target.kind !== "existing"
          || operation.status_evidence.kind !== "external_review_explicit"
          || operation.status_evidence.reference.kind !== "external_review"
          || operation.status_evidence.reference.locator !== locator
          || operation.status_evidence.reference.excerpt !== reference.excerpt
        ) {
          throw new ExternalAgentServiceError("invalid_request", "完了・取り下げ操作の外部根拠が一致しません。");
        }
        trustedStatusEvidence.push({
          kind: "external_review",
          locator,
          target_task_gid: operation.target.gid,
          allowed_operation: operation.operation,
          excerpt: reference.excerpt,
        });
      }
      if (operation.operation === "create_task" && operation.creation.kind === "split_child") {
        if (
          operation.creation.instruction_reference.kind !== "external_review"
          || operation.creation.instruction_reference.locator !== locator
          || operation.creation.instruction_reference.excerpt !== reference.excerpt
        ) {
          throw new ExternalAgentServiceError("invalid_request", "分割操作の外部根拠が一致しません。");
        }
        splitReferences.push({
          parent: operation.creation.parent,
          locator,
          excerpt: reference.excerpt,
        });
      }
    }
    return {
      split_references: splitReferences,
      trusted_status_evidence: trustedStatusEvidence,
    };
  }

  private getProposalStatus(
    proposalId: string,
    operationIds: readonly string[],
  ): ExternalAgentProposalStatusResponse {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const parsedOperationIds = operationIds.map((operationId) => identifierSchema.parse(operationId));
    const current = this.proposals.get(parsedProposalId);
    if (current != null) {
      if (
        current.operation_ids.length !== parsedOperationIds.length
        || current.operation_ids.some((operationId, index) => operationId !== parsedOperationIds[index])
      ) {
        throw new ExternalAgentServiceError("conflict", "操作ID集合が提案と一致しません。");
      }
      return externalAgentProposalStatusResponseSchema.parse({
        operation: "proposals.status",
        proposal_id: parsedProposalId,
        operation_ids: parsedOperationIds,
        result: externalAgentProposalStatusResultSchema.parse({
          kind: "current",
          proposal: createProposalResult(current),
        }),
      });
    }
    const request = [...this.requests.values()].find((candidate) => candidate.proposal_id === parsedProposalId);
    const results: ExternalAgentJournalStatus[] = parsedOperationIds.map((operationId) => {
      if (request?.kind === "failed") {
        const result: ExternalAgentJournalStatus = {
          operation_id: operationId,
          result: {
            kind: "unknown",
            reason_code: "journal_result_unknown",
            message: "提案は受理されましたが、提案本体を作成できませんでした。",
          },
        };
        return result;
      }
      const journal = this.options.get_journal(parsedProposalId, operationId);
      if (journal != null) {
        const result: ExternalAgentJournalStatus = {
          operation_id: operationId,
          result: { kind: "journal", journal },
        };
        return result;
      }
      const result: ExternalAgentJournalStatus = {
        operation_id: operationId,
        result: {
          kind: "unknown",
          reason_code: "journal_not_found",
          message: "指定操作の適用ジャーナルを確認できません。",
        },
      };
      return result;
    });
    return externalAgentProposalStatusResponseSchema.parse({
      operation: "proposals.status",
      proposal_id: parsedProposalId,
      operation_ids: parsedOperationIds,
      result: { kind: "journals", results },
    });
  }

  private async openReview(
    proposalId: string,
  ): Promise<ExternalAgentReviewOpenResponse> {
    const record = this.requireProposal(proposalId);
    if (!isProposalStatusMutable(record.state) && !isProposalApplying(record.state)) {
      throw new ExternalAgentServiceError("conflict", "この提案は確認画面を開けません。");
    }
    const requestId = identifierSchema.parse(randomUUID());
    this.reviewTarget = { proposal_id: record.proposal_id, request_id: requestId };
    this.emitChanged();
    await this.options.open_review(record.proposal_id, requestId);
    return externalAgentReviewOpenResponseSchema.parse({
      operation: "review.open",
      proposal_id: record.proposal_id,
      request_id: requestId,
      opened: true,
    });
  }

  private assertRequestContext(
    instanceId: string,
    contextId: string,
    projectGid: string,
    context: ExternalAgentContext,
  ): void {
    if (instanceId !== this.options.instance_id) {
      throw new ExternalAgentServiceError("context_mismatch", "TaskHubのinstance_idが一致しません。");
    }
    if (contextId !== context.context_id) {
      throw new ExternalAgentServiceError("context_mismatch", "Asanaのcontext_idが一致しません。");
    }
    if (projectGid !== context.project_gid) {
      throw new ExternalAgentServiceError("context_mismatch", "Asanaのproject_gidが一致しません。");
    }
  }

  private requireProposal(proposalId: string): ExternalProposalRecord {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const record = this.proposals.get(parsedProposalId);
    if (record == null) {
      throw new ExternalAgentServiceError("not_found", "指定された外部提案がありません。");
    }
    return record;
  }

  private requirePreparedContext(proposalContextId: string): PreparedExternalContext {
    const parsedContextId = identifierSchema.parse(proposalContextId);
    const prepared = this.preparedContexts.get(parsedContextId);
    if (prepared == null) {
      throw new ExternalAgentServiceError("context_changed", "指定した提案基準が失効しています。");
    }
    if (this.context?.context_id !== prepared.context_id) {
      throw new ExternalAgentServiceError("context_changed", "Asana文脈が変更されたため提案基準が失効しています。");
    }
    return prepared;
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
    const prepared: PreparedExternalContext = {
      request_id: record.request_id,
      instance_id: record.instance_id,
      context_id: record.context_id,
      project_gid: record.snapshot.project_gid,
      proposal_context_id: record.proposal_context_id,
      source_text: record.source_text,
      evidence_locator_prefix: record.evidence_locator_prefix,
      snapshot: record.snapshot,
      baseline_snapshot: record.baseline_snapshot,
      baseline_external_data: record.baseline_external_data,
      taskctl_snapshot: record.taskctl_snapshot,
      turn_context: record.turn_context,
    };
    const selected = new Set(operationIds);
    const selectedProposal: Proposal = {
      ...record.proposal,
      groups: record.proposal.groups.map((group) => ({
        ...group,
        operations: group.operations.filter((operation) => selected.has(operation.operation_id)),
      })).filter((group) => group.operations.length > 0),
    };
    const validatedProposal = proposalSchema.parse(selectedProposal);
    const evidence = this.collectExternalEvidence(prepared, validatedProposal);
    const validation = validateProposal({
      proposal: validatedProposal,
      baseline_snapshot_hash: record.turn_context.baseline_snapshot_hash,
      managed_tasks: record.snapshot.tasks,
      existing_areas: record.snapshot.areas,
      explicit_split_request_references: [...evidence.split_references],
      trusted_status_evidence: [...evidence.trusted_status_evidence],
    });
    for (const operation of validation.operations) {
      if (operation.kind === "invalid") {
        throw new ExternalAgentServiceError("invalid_request", "承認対象の外部根拠を検証できません。");
      }
    }
    return evidence;
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
    let changed = false;
    for (const record of this.proposals.values()) {
      if (record.state.kind === "pending_approval") {
        record.revision += 1;
        record.state = { kind: "expired", reason_code: reasonCode };
        changed = true;
      }
    }
    if (changed) {
      this.emitChanged();
    }
  }

  private emitChanged(): void {
    const state = this.getState();
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}
