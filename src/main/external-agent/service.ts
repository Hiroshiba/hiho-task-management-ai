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
  proposalOperationSchema,
  proposalSchema,
  type Proposal,
  type ProposalOperation,
} from "../../shared/ai";
import {
  aiWorkflowApprovalResultSchema,
  type AiWorkflowProposalView,
  type AiWorkflowSnapshot,
} from "../../shared/ai-workflow";
import {
  validateProposal,
  validateProposalGraph,
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
  type ApprovalPreparationInput,
} from "../ai/workflow";
import {
  AsanaOperationInvalidatedError,
  type AsanaOperationQueue,
  type AsanaOperationKind,
} from "../asana/operation-queue";
import type { AsanaSyncRuntimeState } from "../asana/runtime";
import type { ReadModelService } from "../read-model";
import type { ApplicationJournal } from "../../shared/storage";
import type {
  ExternalAgentBridgeState,
  ExternalAgentCreateProposalInput,
  ExternalAgentErrorCode,
  ExternalAgentGuiApproveInput,
  ExternalAgentGuiEditInput,
  ExternalAgentGuiState,
  ExternalAgentGuiRejectInput,
  ExternalAgentGuiSetEnabledInput,
  ExternalAgentInfoResponse,
  ExternalAgentProposal,
  ExternalAgentProposalStatus,
  ExternalAgentRequestInput,
  ExternalAgentResponse,
  ExternalAgentTaskDetailResponse,
  ExternalAgentTaskListInput,
  ExternalAgentTaskListResponse,
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
  externalAgentGuiStateSchema,
  externalAgentInfoResponseSchema,
  externalAgentProposalCreateResponseSchema,
  externalAgentProposalSchema,
  externalAgentProposalStatusResponseSchema,
  externalAgentProposalStatusResultSchema,
  externalAgentReadSnapshotSchema,
  externalAgentRequestInputSchema,
  externalAgentReviewOpenResponseSchema,
  externalAgentTaskDetailResponseSchema,
  externalAgentTaskListResponseSchema,
  externalAgentProtocolVersion,
} from "../../shared/external-agent";
import {
  filterTaskRows,
  taskFilterSchema,
  type ViewModelOverview,
  type ViewModelTaskRow,
} from "../../shared/view-model";
import type { IpcExternalAgentPort } from "../ipc";
import type {
  ExternalAgentBridge,
} from "./transport";
import { hashBaselineSnapshot } from "../domain/snapshot-hash";

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
  readonly read_model: Pick<ReadModelService, "getOverview" | "getTaskDetail">;
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
  readonly operation_id: string;
  readonly request_id: string;
  readonly instance_id: string;
  readonly context_id: string;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  proposal: Proposal;
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
      readonly digest: string;
      readonly proposal_id: string;
      readonly operation_id: string;
      readonly creation: Promise<ExternalProposalRecord | undefined>;
    }
  | {
      readonly kind: "accepted";
      readonly digest: string;
      readonly proposal_id: string;
      readonly operation_id: string;
      readonly creation: Promise<ExternalProposalRecord>;
    }
  | {
      readonly kind: "failed";
      readonly digest: string;
      readonly proposal_id: string;
      readonly operation_id: string;
      readonly creation: Promise<undefined>;
      readonly failure: ExternalAgentRequestFailure;
    };

type ExternalAgentReadSnapshot = z.infer<typeof externalAgentReadSnapshotSchema>;

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
    operation_id: record.operation_id,
    request_id: record.request_id,
    instance_id: record.instance_id,
    context_id: record.context_id,
    revision: record.revision,
    source: "external_tool",
    state: record.state,
    view: record.view,
  });
}

function createOperationFields(
  input: ExternalAgentCreateInput,
  baselineSnapshotHash: string,
  operationId: string,
  temporaryRef: string,
): ProposalOperation {
  const after = {
    title: input.title,
    ...(input.notes == null ? {} : { notes: input.notes }),
    status: input.status ?? "not_started",
    importance: input.importance ?? 3,
    area: input.area ?? "未分類",
    ...(input.due == null ? {} : { due: input.due }),
    ...(input.duration == null ? {} : { duration: input.duration }),
  };
  return proposalOperationSchema.parse({
    operation: "create_task",
    operation_id: operationId,
    baseline_snapshot_hash: baselineSnapshotHash,
    reason: input.reason,
    basis: "inferred",
    confidence: input.confidence,
    evidence_refs: [{
      kind: "external_tool",
      locator: `external-tool:${input.request_id}`,
    }],
    temporary_ref: temporaryRef,
    creation: { kind: "single_task" },
    before: { kind: "absent" },
    after,
  });
}

type ExternalAgentCreateInput = ExternalAgentCreateProposalInput;

function createProposal(
  input: ExternalAgentCreateInput,
  baselineSnapshotHash: string,
  operationId: string,
): { readonly proposal: Proposal; readonly operation_id: string } {
  const temporaryRef = identifierSchema.parse(`external-${randomUUID()}`);
  const operation = createOperationFields(
    input,
    baselineSnapshotHash,
    operationId,
    temporaryRef,
  );
  const proposal = proposalSchema.parse({
    title: input.title,
    groups: [{
      group_id: identifierSchema.parse(randomUUID()),
      atomic: true,
      operations: [operation],
    }],
  });
  return { proposal, operation_id: operationId };
}

function findCreateOperation(proposal: Proposal): Extract<
  ProposalOperation,
  { readonly operation: "create_task" }
> {
  const operations = proposal.groups.flatMap((group) => group.operations);
  if (operations.length !== 1) {
    throw new Error("外部提案は一つの操作だけを含まなければなりません。");
  }
  const operation = operations[0];
  if (operation == null || operation.operation !== "create_task") {
    throw new Error("外部提案の操作がcreate_taskではありません。");
  }
  return operation;
}

/** 外部Codex連携の提案受付とGUI操作を管理します。 */
export class ExternalAgentService implements IpcExternalAgentPort {
  private readonly options: ExternalAgentServiceOptions;
  private readonly requests = new Map<string, RequestRecord>();
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
      if (parsedInput.operation !== "proposals.create") {
        this.assertEnabled();
      }
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

  /** GUI編集を外部提案へ反映します。 */
  public edit(
    input: ExternalAgentGuiEditInput,
    signal: AbortSignal,
  ): ExternalAgentGuiState {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const request = externalAgentGuiEditInputSchema.parse(input);
    const record = this.requireProposal(request.proposal_id);
    if (record.operation_id !== request.operation_id) {
      throw new ExternalAgentServiceError("conflict", "操作IDが提案と一致しません。");
    }
    this.assertRevision(record, request.revision);
    if (!isProposalStatusMutable(record.state)) {
      throw new ExternalAgentServiceError("conflict", "この提案は編集できません。");
    }
    const operation = findCreateOperation(record.proposal);
    const candidateAfter = {
      title: request.title,
      ...(request.notes == null ? {} : { notes: request.notes }),
      status: request.status ?? "not_started",
      importance: request.importance ?? 3,
      area: request.area ?? "未分類",
      ...(request.due == null ? {} : { due: request.due }),
      ...(request.duration == null ? {} : { duration: request.duration }),
    };
    if (request.area != null && !record.snapshot.areas.includes(request.area)) {
      throw new ExternalAgentServiceError("invalid_request", "指定した領域が現在の一覧にありません。");
    }
    const editedOperation = proposalOperationSchema.parse({
      ...operation,
      after: candidateAfter,
      basis: "explicit",
      confidence: 1,
      evidence_refs: [
        ...operation.evidence_refs,
        { kind: "user_message", locator: `gui-edit:${randomUUID()}` },
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
    record.selected_operation_ids = [record.operation_id];
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
            baseline_external_data: record.baseline_external_data,
            graph_validation_result: record.graph_validation,
            selected_operation_ids: record.selected_operation_ids,
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
    }
  }

  /** 外部連携サービスを停止します。 */
  public stop(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    this.stopped = true;
    this.expireProposals("instance_restarted");
    this.listeners.clear();
    return Promise.resolve();
  }

  private async dispatchRequest(
    input: ExternalAgentRequestInput,
  ): Promise<ExternalAgentResponse | Record<string, unknown>> {
    switch (input.operation) {
      case "tasks.list":
        return this.listTasks(input);
      case "tasks.get":
        return this.getTask(input.task_gid);
      case "proposals.create":
        return this.createExternalProposal(input);
      case "proposals.status":
        return this.getProposalStatus(input.proposal_id, input.operation_id);
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
      capabilities.push("tasks.list", "tasks.get");
    }
    const runtimeCanAcceptCreate = runtime != null
      && (runtime.kind === "online" || runtime.kind === "syncing")
      && runtime.last_successful_sync_at != null
      && runtime.last_error_code == null;
    if (context != null && runtimeCanAcceptCreate && this.options.online_provider() === true) {
      capabilities.push("proposals.create");
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

  private createReadSnapshot(
    context: ExternalAgentContext,
    overview: ViewModelOverview,
  ): ExternalAgentReadSnapshot {
    const runtime = this.options.get_runtime_state();
    let syncStatus: "synced" | "syncing" | "offline" = "synced";
    if (runtime?.kind === "syncing") {
      syncStatus = "syncing";
    } else if (
      runtime?.kind === "offline"
      || runtime?.kind === "authentication_required"
      || runtime?.kind === "error"
    ) {
      syncStatus = "offline";
    }
    return externalAgentReadSnapshotSchema.parse({
      context_id: context.context_id,
      project_gid: context.project_gid,
      observed_at: nowIso(this.options.now_provider),
      sync_status: syncStatus,
      last_successful_sync_at: overview.last_successful_sync_at,
    });
  }

  private listTasks(
    input: ExternalAgentTaskListInput,
  ): ExternalAgentTaskListResponse {
    const context = this.assertReadReady();
    const overview = this.options.read_model.getOverview(context.project_gid);
    const snapshot = this.createReadSnapshot(context, overview);
    const filter = taskFilterSchema.parse(input.filter ?? { kind: "normal" });
    const filtered = filterTaskRows(overview, filter, snapshot.observed_at);
    const query = input.query?.trim().toLocaleLowerCase();
    const matched = query == null
      ? filtered
      : filtered.filter((row) => this.rowMatches(row, query));
    const limit = input.limit ?? 100;
    return externalAgentTaskListResponseSchema.parse({
      operation: "tasks.list",
      snapshot,
      ranking: overview.ranking,
      rows: matched.slice(0, limit),
    });
  }

  private rowMatches(row: ViewModelTaskRow, query: string): boolean {
    return [row.gid, row.title, row.area, row.status].some((value) =>
      value.toLocaleLowerCase().includes(query));
  }

  private getTask(taskGid: string): ExternalAgentTaskDetailResponse {
    const context = this.assertReadReady();
    const overview = this.options.read_model.getOverview(context.project_gid);
    if (!overview.tasks.some((row) => row.gid === taskGid)) {
      throw new ExternalAgentServiceError("not_found", "指定タスクが一覧キャッシュにありません。");
    }
    const detail = this.options.read_model.getTaskDetail(context.project_gid, gidSchema.parse(taskGid));
    return externalAgentTaskDetailResponseSchema.parse({
      operation: "tasks.get",
      snapshot: this.createReadSnapshot(context, overview),
      detail,
    });
  }

  private async createExternalProposal(
    input: ExternalAgentCreateInput,
  ): Promise<ExternalAgentProposalCreateResponse> {
    const digest = canonicalizeJson(input);
    const existing = this.requests.get(input.request_id);
    if (existing != null) {
      if (existing.digest !== digest) {
        throw new ExternalAgentServiceError("request_id_reused", "同じrequest_idへ別の内容を指定できません。");
      }
      const record = await existing.creation;
      if (record == null) {
        const current = this.requests.get(input.request_id);
        if (current?.kind === "failed") {
          if (current.failure.kind === "expected") {
            throw current.failure.error;
          }
          throw new ExternalAgentServiceError("unknown_result", "受理済み提案の作成結果が不明です。");
        }
        throw new ExternalAgentServiceError("unknown_result", "受理済み提案の作成結果が不明です。");
      }
      return externalAgentProposalCreateResponseSchema.parse({
        operation: "proposals.create",
        proposal: createProposalResult(record),
      });
    }
    if (this.stopped) {
      throw new ExternalAgentServiceError("unavailable", "外部連携サービスは停止済みです。");
    }
    const context = this.requireContext();
    this.assertRequestContext(
      input.instance_id,
      input.context_id,
      input.project_gid,
      context,
    );
    this.assertEnabled();
    this.options.assert_apply_ready();
    if (this.options.online_provider() !== true) {
      throw new ExternalAgentServiceError("offline", "オフライン中は提案を受け付けられません。");
    }
    if (this.requests.size >= maximumRequests) {
      throw new ExternalAgentServiceError("capacity_exceeded", "外部提案の受付上限に達しています。");
    }
    const proposalId = identifierSchema.parse(randomUUID());
    const operationId = identifierSchema.parse(randomUUID());
    const creationPromise = Promise.resolve()
      .then(() => this.options.create_baseline(this.options.lifecycle_signal))
      .then((baseline) => this.createExternalProposalRecord(
        input,
        context,
        proposalId,
        operationId,
        baseline,
      ))
      .then(
        (record) => {
          const accepted: RequestRecord = {
            kind: "accepted",
            digest,
            proposal_id: proposalId,
            operation_id: operationId,
            creation: Promise.resolve(record),
          };
          this.requests.set(input.request_id, accepted);
          return record;
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
              "提案作成中にAsana文脈が変更されました。",
              error,
            );
          }
          const failure: ExternalAgentRequestFailure = expectedError != null
            ? { kind: "expected", error: expectedError }
            : { kind: "unexpected" };
          const failed: RequestRecord = {
            kind: "failed",
            digest,
            proposal_id: proposalId,
            operation_id: operationId,
            creation: Promise.resolve(undefined),
            failure,
          };
          this.requests.set(input.request_id, failed);
          if (expectedError != null) {
            return undefined;
          }
          throw error;
        },
      );
    const requestRecord: RequestRecord = {
      digest,
      proposal_id: proposalId,
      operation_id: operationId,
      creation: creationPromise,
      kind: "pending",
    };
    this.requests.set(input.request_id, requestRecord);
    const record = await creationPromise;
    if (record == null) {
      const current = this.requests.get(input.request_id);
      if (current?.kind === "failed") {
        if (current.failure.kind === "expected") {
          throw current.failure.error;
        }
        throw new ExternalAgentServiceError("unknown_result", "受理済み提案の作成結果が不明です。");
      }
      throw new ExternalAgentServiceError("unknown_result", "受理済み提案の作成結果が不明です。");
    }
    return externalAgentProposalCreateResponseSchema.parse({
      operation: "proposals.create",
      proposal: createProposalResult(record),
    });
  }

  private createExternalProposalRecord(
    input: ExternalAgentCreateInput,
    context: ExternalAgentContext,
    proposalId: string,
    operationId: string,
    baseline: ExternalAgentBaseline,
  ): ExternalProposalRecord {
    if (this.stopped) {
      throw new ExternalAgentServiceError("unavailable", "外部連携サービスは停止済みです。");
    }
    const validatedSnapshot = baselineSnapshotSchema.parse(baseline.baseline_snapshot);
    this.assertBaselineContext(input, context, baseline);
    const baselineSnapshotHash = hashBaselineSnapshot(validatedSnapshot);
    const created = createProposal(
      input,
      baselineSnapshotHash,
      operationId,
    );
    const basic = validateProposal({
      proposal: created.proposal,
      baseline_snapshot_hash: baselineSnapshotHash,
      managed_tasks: baseline.snapshot.tasks,
      existing_areas: baseline.snapshot.areas,
      explicit_split_request_references: [],
      trusted_status_evidence: [],
    });
    const graph = validateProposalGraph({
      proposal: created.proposal,
      managed_tasks: baseline.snapshot.tasks,
      basic_validation_result: basic,
    });
    const operationValidation = graph.operations.find((candidate) =>
      candidate.operation_id === operationId);
    if (operationValidation?.kind !== "valid") {
      throw new ExternalAgentServiceError("invalid_request", "外部提案の検証に失敗しました。");
    }
    const view = createWorkflowProposalView({
      proposal_id: proposalId,
      proposal: created.proposal,
      snapshot: baseline.snapshot,
      baseline_snapshot_hash: baselineSnapshotHash,
      basic_validation: basic,
      graph_validation: graph,
      selected_operation_ids: [operationId],
    });
    const record: ExternalProposalRecord = {
      proposal_id: proposalId,
      operation_id: operationId,
      request_id: input.request_id,
      instance_id: input.instance_id,
      context_id: input.context_id,
      snapshot: baseline.snapshot,
      baseline_snapshot: validatedSnapshot,
      baseline_external_data: baseline.baseline_external_data,
      proposal: created.proposal,
      graph_validation: graph,
      selected_operation_ids: [operationId],
      view,
      revision: 1,
      state: { kind: "pending_approval" },
    };
    this.proposals.set(proposalId, record);
    this.emitChanged();
    return record;
  }

  private assertBaselineContext(
    input: ExternalAgentCreateInput,
    context: ExternalAgentContext,
    baseline: ExternalAgentBaseline,
  ): void {
    if (
      baseline.snapshot.project_gid !== context.project_gid
      || baseline.baseline_snapshot.project_gid !== context.project_gid
      || this.context?.context_id !== context.context_id
    ) {
      throw new ExternalAgentServiceError("context_changed", "提案作成中にAsana文脈が変更されました。");
    }
    if (input.area != null && !baseline.snapshot.areas.includes(input.area)) {
      throw new ExternalAgentServiceError("invalid_request", "指定した領域が現在の一覧にありません。");
    }
  }

  private getProposalStatus(
    proposalId: string,
    operationId: string,
  ): ExternalAgentProposalStatusResponse {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const parsedOperationId = identifierSchema.parse(operationId);
    const current = this.proposals.get(parsedProposalId);
    if (current != null) {
      if (current.operation_id !== parsedOperationId) {
        throw new ExternalAgentServiceError("conflict", "操作IDが提案と一致しません。");
      }
      return externalAgentProposalStatusResponseSchema.parse({
        operation: "proposals.status",
        proposal_id: parsedProposalId,
        operation_id: parsedOperationId,
        result: externalAgentProposalStatusResultSchema.parse({
          kind: "current",
          proposal: createProposalResult(current),
        }),
      });
    }
    const request = [...this.requests.values()].find((candidate) =>
      candidate.proposal_id === parsedProposalId
      && candidate.operation_id === parsedOperationId);
    if (request?.kind === "failed") {
      return externalAgentProposalStatusResponseSchema.parse({
        operation: "proposals.status",
        proposal_id: parsedProposalId,
        operation_id: parsedOperationId,
        result: {
          kind: "unknown",
          reason_code: "journal_result_unknown",
          message: "提案は受理されましたが、提案本体を作成できませんでした。",
        },
      });
    }
    const journal = this.options.get_journal(parsedProposalId, parsedOperationId);
    if (journal != null) {
      return externalAgentProposalStatusResponseSchema.parse({
        operation: "proposals.status",
        proposal_id: parsedProposalId,
        operation_id: parsedOperationId,
        result: { kind: "journal", journal },
      });
    }
    return externalAgentProposalStatusResponseSchema.parse({
      operation: "proposals.status",
      proposal_id: parsedProposalId,
      operation_id: parsedOperationId,
      result: {
        kind: "unknown",
        reason_code: "journal_not_found",
        message: "提案のメモリ状態と適用ジャーナルを確認できません。",
      },
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
      baseline_snapshot_hash: record.view.baseline_snapshot_hash,
      managed_tasks: record.snapshot.tasks,
      existing_areas: record.snapshot.areas,
      explicit_split_request_references: [],
      trusted_status_evidence: [],
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
      baseline_snapshot_hash: record.view.baseline_snapshot_hash,
      basic_validation: basic,
      graph_validation: graph,
      selected_operation_ids: [record.operation_id],
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
