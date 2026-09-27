import { createHash, randomUUID } from "node:crypto";
import {
  baselineSnapshotSchema, canonicalizeJson, dependenciesSchema, gidSchema, identifierSchema,
  obsidianLinksSchema, taskSchema, type BaselineSnapshot, type Task, type TaskSnapshot,
} from "../../../shared/domain";
import {
  codexResponseSchema, proposalOperationSchema, proposalSchema, type CodexResponse, type Proposal,
  type ProposalOperation,
} from "../../../shared/ai";
import { ProposalWorkspace, type ProposalWorkspaceIssue, type ProposalWorkspaceValidation } from "../proposal-workspace";
import {
  aiWorkflowApprovalRequestSchema, aiWorkflowApprovalResultSchema, aiWorkflowImpactSchema,
  aiWorkflowOperationEditSchema, aiWorkflowProposalViewSchema, aiWorkflowSelectionRequestSchema,
  aiWorkflowSnapshotSchema, aiWorkflowTurnContextSchema, aiWorkflowTurnRequestSchema,
  aiWorkflowTurnResultSchema, type AiWorkflowApprovalRequest, type AiWorkflowApprovalResult,
  type AiWorkflowImpact, type AiWorkflowOperationEdit, type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest, type AiWorkflowSnapshot, type AiWorkflowTurnRequest,
  type AiWorkflowTurnResult,
} from "../../../shared/ai-workflow";
import { calculateTaskRanking } from "../../domain/ranking";
import { hashBaselineSnapshot } from "../../domain/snapshot-hash";
import { normalizeTaskGraph } from "../../domain/normalization";
import {
  createChildrenOnlyEvidenceLocator, trustedStatusEvidenceReferencesSchema, validateProposal,
  validateProposalGraph, type ExplicitSplitRequestReference, type GraphValidationResult,
  type ProposalValidationResult, type TrustedStatusEvidenceReference,
} from "../proposal-validation";
import {
  asanaProposalApplicationInputSchema, asanaProposalApplicationResultSchema,
  type AsanaProposalApplicationInput, type AsanaProposalApplicationCoordinator,
} from "../proposal-application";
import {
  CodexSessionOutputValidationError, CodexSessionSyncError, type CodexSessionDelta,
  type CodexSessionDeltaListener, type CodexSessionTurnInput, type CodexSessionTurnInputFactory,
  type CodexSessionTurnResult,
} from "../../codex/session";
import { taskctlSnapshotSchema, type TaskctlSnapshot } from "../../codex/taskctl";
import {
  AiWorkflowEditError, AiWorkflowError, AiWorkflowOfflineError, AiWorkflowProposalNotFoundError,
  AiWorkflowRetryableFailureError, AiWorkflowSelectionError, AiWorkflowStateError,
  AiWorkflowSyncError,
} from "./errors";
import {
  aiWorkflowPreviousDigestSchema, aiWorkflowCandidateDigestSchema, aiWorkflowRetryLogEventSchema,
  aiWorkflowSafeErrorProjectionSchema, aiWorkflowValidationErrorsSchema,
  aiWorkflowValidationIssueSchema, aiWorkflowValidationDetailCodeSchema,
  aiWorkflowZodIssueCodeSchema, aiWorkflowMaximumRetryAttempts, type AiWorkflowCandidateDigest,
  type AiWorkflowPreviousDigest, type AiWorkflowRetryLogEvent, type AiWorkflowValidationErrors,
  type AiWorkflowValidationIssue,
} from "./retry";
import {
  assertSelectedProposalGraphIsSafe, eligibleOperationIds, preserveSelection,
  resolveSelectedOperationIds,
} from "./selection";
import { DiagnosticFailureDispositionError } from "../../application/common/errors/diagnostic-failure";
import { redactSensitiveText } from "../../redact-sensitive-text";
import {
  createValidationErrorsDocument as buildValidationErrorsDocument,
  createRetryLogEvent as buildRetryLogEvent,
  proposalValidationIssues as collectProposalValidationIssues,
  createStructuredOutputFailure as buildStructuredOutputFailure, previousDigestFromCandidate,
  safelyLogRetryEvent,
} from "../../application/proposal-generate/retry-diagnostics";
import {
  createInheritedEvidenceAliases as collectInheritedEvidenceAliases,
  resolveInheritedStatusEvidenceAlias, resolveInheritedSplitInstructionAlias,
  selectEligibleEvidenceOperations, type InheritedStatusEvidenceAlias,
  type InheritedSplitInstructionAlias,
} from "../../application/proposal-generate/evidence-inheritance";
import { bindProposalOperationEvidence as bindOperationEvidence } from "../../application/proposal-generate/evidence-binding";
import {
  createImpactCalculator, createImpactSupport,
  normalizeTasksForRanking as normalizeRankingTasks,
} from "../../application/proposal-generate/impact-ranking";
import { executeTurnWithRetry, createAbortGuard } from "../../application/proposal-generate/turn-retry";
import { runTurnAttemptWithResources, type AttemptResourceState } from "../../application/proposal-generate/attempt-resources";
import { bindProposalEvidence as bindProposalEvidenceSources } from "../../application/proposal-generate/proposal-evidence";
import { createWorkflowProposalView as buildWorkflowProposalView } from "../../application/proposal-generate/proposal-view";
import { createApprovalPreparationInput, assertApprovalInputMatchesStored } from "../../application/proposal-generate/approval-preparation";
import { editStoredProposal, operationMap as indexProposalOperations } from "../../application/proposal-generate/proposal-edit";
import {
  createStoredProposal as buildStoredProposal,
  revalidateProposal as validateStoredProposal,
} from "../../application/proposal-generate/stored-proposal";
import {
  readWorkspaceProposal, workspaceValidationIssues,
  validateWorkspaceProposal as validateSubmittedWorkspaceProposal,
} from "../../application/proposal-generate/workspace-validation";
import { runSessionTurn } from "../../application/proposal-generate/turn-attempt";
import { ProposalStore } from "../../application/proposal-generate/proposal-store";
import { prepareTurn, createTurnInput as connectTurnInput } from "../../application/proposal-generate/turn-preparation";
import { createNoProposalCommit, createProposalCommit, commitTurn as applyTurnCommit } from "../../application/proposal-generate/turn-commit";
import { validateGeneratedResponse } from "../../application/proposal-generate/turn-response";
import { createApplicationSummary } from "../../application/proposal-generate/approval-summary";
import {
  createBaselineTaskSnapshots, createBaselineSnapshot as buildBaselineSnapshot,
  assertTaskctlSnapshotMatchesBaseline as verifyTaskctlBaseline,
} from "../../application/proposal-generate/baseline-snapshot";
import { createTrustedExternalStatusEvidenceSchema, parseWorkflowOptions } from "../../application/proposal-generate/workflow-options";
import {
  rebindInitialOperation as rebindOperationValues,
  rebindInitialProposal as rebindProposalValues,
} from "../../application/proposal-generate/rebind-before";
import { createTaskProjector } from "../../application/proposal-generate/task-projection";
import { createTurnPrompt, createPendingWithdrawConfirmation, createRendererQuestions } from "../../application/proposal-generate/turn-prompt";
import {
  createEvidenceSourceMap, rememberSuccessfulTurnEvidence,
  createTrustedStatusEvidence as collectTrustedStatusEvidence, createEvidenceLocators,
  verifiedSourceExcerpt, isPendingWithdrawConfirmationValid,
  type EvidenceSource as WorkflowEvidenceSource,
  type PendingWithdrawConfirmation as WorkflowPendingWithdrawConfirmation,
  type UserMessageSourceSummary as WorkflowUserMessageSourceSummary,
} from "../../application/proposal-generate/evidence-sources";

const maximumWorkflowProposals = 32;
const maximumPromptStatusEvidenceReferences = 256;

type EvidenceSource = WorkflowEvidenceSource<TaskSnapshot["status"]>;
type EvidenceSourceMap = ReadonlyMap<string, EvidenceSource>;
type UserMessageSourceSummary = WorkflowUserMessageSourceSummary<TaskSnapshot["status"]>;

type BoundProposalEvidence = {
  readonly proposal: Proposal;
  readonly explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
};

type PendingWithdrawConfirmation = WorkflowPendingWithdrawConfirmation<TaskSnapshot["status"]>;

type NoProposalResponse = Extract<CodexResponse, { readonly kind: "no_proposal" }>;

type PreparedTurn = {
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline: BaselineSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly taskctl_snapshot: TaskctlSnapshot;
  readonly user_message_source_id: string;
  readonly user_message_sources: readonly UserMessageSourceSummary[];
  readonly withdraw_confirmation_source_id: string | undefined;
  readonly source_map: EvidenceSourceMap;
  readonly pending_withdraw_confirmation: PendingWithdrawConfirmation | undefined;
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  readonly inherited_status_evidence_aliases: readonly InheritedStatusEvidenceAlias[];
  readonly inherited_split_instruction_aliases: readonly InheritedSplitInstructionAlias[];
};

type TurnRetryPromptContext =
  | { readonly kind: "initial" }
  | {
      readonly kind: "correction";
      readonly validationErrors: AiWorkflowValidationErrors;
      readonly failedAttempt: number;
    };

type TurnExecutionInput = {
  readonly request: AiWorkflowTurnRequest;
  readonly signal: AbortSignal;
  readonly baseProposal: StoredProposal | undefined;
  readonly turnGeneration: number;
  readonly pendingWithdrawConfirmation: PendingWithdrawConfirmation | undefined;
  readonly logicalTurnId: string;
  readonly retryProposal: Proposal | undefined;
};

type TurnAttemptInput = TurnExecutionInput & {
  readonly attempt: number;
  readonly retryPromptContext: TurnRetryPromptContext;
  readonly workspaceState: { value?: ProposalWorkspace };
};

type TurnExecutionResult =
  | { readonly kind: "succeeded"; readonly commit: TurnCommit }
  | { readonly kind: "failed"; readonly error: unknown };

type PendingWithdrawConfirmationCommit =
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly value: PendingWithdrawConfirmation };

type TurnCommit =
  | { readonly kind: "no_proposal";
      readonly result: AiWorkflowTurnResult;
      readonly pendingWithdrawConfirmation: PendingWithdrawConfirmationCommit;
      readonly prepared: PreparedTurn }
  | { readonly kind: "proposal";
      readonly result: AiWorkflowTurnResult;
      readonly pendingWithdrawConfirmation: PendingWithdrawConfirmationCommit;
      readonly storedProposal: StoredProposal;
      readonly replacingProposalId: string | undefined;
      readonly prepared: PreparedTurn };

type StoredProposal = {
  readonly proposal_id: string;
  readonly proposal: Proposal;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline: BaselineSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly basic_validation: ProposalValidationResult;
  readonly graph_validation: GraphValidationResult;
  readonly selected_operation_ids: readonly string[];
  readonly explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  readonly source_map: EvidenceSourceMap;
};

export type TrustedExternalStatusEvidence = Extract<
  TrustedStatusEvidenceReference,
  { readonly kind: "external_tool" }
>;

/** Asana適用前に再取得状態を準備する入力です。 */
export type ApprovalPreparationInput = {
  readonly proposal_id: string;
  readonly proposal: Proposal;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly baseline_external_data: AsanaProposalApplicationInput["baseline_external_data"];
  readonly existing_areas: readonly string[];
  readonly graph_validation_result: GraphValidationResult;
  readonly selected_operation_ids: readonly string[];
  readonly explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
  readonly created_via: string;
};

/** AIターンへ渡す同期済み状態を供給する関数の型です。 */
export type AiWorkflowSnapshotProvider = (signal: AbortSignal) =>
  AiWorkflowSnapshot | PromiseLike<AiWorkflowSnapshot>;

/** ターン中のtaskctl参照状態を供給する関数の型です。 */
export type AiWorkflowTaskctlSnapshotProvider = (signal: AbortSignal) =>
  TaskctlSnapshot | PromiseLike<TaskctlSnapshot>;

/** 提案基準に対応するCustom external dataを供給する関数の型です。 */
export type AiWorkflowBaselineExternalDataProvider = (baseline: BaselineSnapshot, signal: AbortSignal) =>
  AsanaProposalApplicationInput["baseline_external_data"]
  | PromiseLike<AsanaProposalApplicationInput["baseline_external_data"]>;

/** ターン単位で外部ツールの構造化状態記録を収集する境界です。 */
export interface AiWorkflowExternalStatusEvidenceCollector {
  beginTurn(turnId: string, signal: AbortSignal): void | PromiseLike<void>;
  snapshotTurn(turnId: string, signal: AbortSignal): readonly TrustedExternalStatusEvidence[];
  finishTurn(turnId: string, signal: AbortSignal): readonly TrustedExternalStatusEvidence[]
    | PromiseLike<readonly TrustedExternalStatusEvidence[]>;
  cancelTurn(turnId: string): void | PromiseLike<void>;
}

/** AIセッションのターン開始と差分購読を利用する境界です。 */
export interface AiWorkflowSessionPort {
  startTurnWithPreparation(
    prepareInput: CodexSessionTurnInputFactory,
    signal: AbortSignal,
  ): Promise<CodexSessionTurnResult>;
  freezeTaskctlSnapshot(snapshot: TaskctlSnapshot): void;
  releaseTaskctlSnapshot(): void;
  activateProposalWorkspace(
    workspace: ProposalWorkspace,
    validate: (proposal: Proposal) => ProposalWorkspaceValidation<null>,
  ): void;
  onDelta(listener: CodexSessionDeltaListener): () => void;
}

/** 最新状態を再取得してAsana適用入力を作る関数の型です。 */
export type AiWorkflowApprovalInputProvider = (input: ApprovalPreparationInput, signal: AbortSignal) =>
  AsanaProposalApplicationInput | PromiseLike<AsanaProposalApplicationInput>;

/** オンライン接続の有無を返す関数の型です。 */
export type AiWorkflowOnlineStateProvider = () => boolean;

/** AIワークフローの依存境界を検証する入力型です。 */
export interface AiWorkflowOptions {
  readonly sessionId: string;
  readonly session: AiWorkflowSessionPort;
  readonly snapshotProvider: AiWorkflowSnapshotProvider;
  readonly taskctlSnapshotProvider: AiWorkflowTaskctlSnapshotProvider;
  readonly baselineExternalDataProvider: AiWorkflowBaselineExternalDataProvider;
  readonly externalStatusEvidenceCollector: AiWorkflowExternalStatusEvidenceCollector;
  readonly applicationCoordinator: Pick<AsanaProposalApplicationCoordinator, "apply">;
  readonly prepareApprovalInput: AiWorkflowApprovalInputProvider;
  readonly isOnline: AiWorkflowOnlineStateProvider;
  readonly logRetryEvent: (event: AiWorkflowRetryLogEvent) => void;
}

const trustedExternalStatusEvidenceSchema = createTrustedExternalStatusEvidenceSchema(gidSchema);

const throwIfAborted = createAbortGuard(AiWorkflowError);

/** 同期済みタスクをキー順の基準スナップショットへ変換します。 */
export function createBaselineSnapshot(snapshot: AiWorkflowSnapshot): BaselineSnapshot {
  return buildBaselineSnapshot(snapshot, {
    parseSnapshot: (value) => aiWorkflowSnapshotSchema.parse(value),
    parseBaseline: (value) => baselineSnapshotSchema.parse(value),
  });
}

const {
  createUserMessageSourceId,
  createTaskNotesSourceId,
  createWithdrawConfirmationSourceId,
  createStatusEvidenceLocator,
  createSplitInstructionLocator,
} = createEvidenceLocators({
  validateIdentifier: (value) => identifierSchema.parse(value),
  validateGid: (value) => gidSchema.parse(value),
});

function createTrustedStatusEvidence(
  snapshot: AiWorkflowSnapshot,
  externalEvidence: readonly TrustedExternalStatusEvidence[],
): readonly TrustedStatusEvidenceReference[] {
  return collectTrustedStatusEvidence(snapshot, externalEvidence, {
    createChildrenOnlyEvidenceLocator,
    parseReferences: (value) => trustedStatusEvidenceReferencesSchema.parse(value),
    maximumPromptReferences: maximumPromptStatusEvidenceReferences,
  });
}

function bindProposalOperationEvidence(
  operation: ProposalOperation,
  prepared: PreparedTurn,
): {
  readonly operation: ProposalOperation;
  readonly split_reference: ExplicitSplitRequestReference | undefined;
  readonly trusted_reference: TrustedStatusEvidenceReference | undefined;
} {
  return bindOperationEvidence(operation, prepared, {
    resolveSplit: (value) => value.operation === "create_task"
      ? resolveInheritedSplitInstructionAlias(value, prepared.inherited_split_instruction_aliases,
          canonicalizeJson) : value,
    resolveStatus: (value) => value.operation === "complete" || value.operation === "withdraw"
      ? resolveInheritedStatusEvidenceAlias(value, prepared.inherited_status_evidence_aliases) : value,
    parseOperation: (value) => proposalOperationSchema.parse(value),
    createStatusEvidenceLocator,
    createSplitInstructionLocator,
    verifiedSourceExcerpt,
  });
}

function bindProposalEvidence(
  proposal: Proposal,
  prepared: PreparedTurn,
  candidateDigest: AiWorkflowCandidateDigest,
): BoundProposalEvidence {
  return bindProposalEvidenceSources(proposal, prepared, candidateDigest, {
    bindOperation: bindProposalOperationEvidence,
    parseIssue: (value) => aiWorkflowValidationIssueSchema.parse(value),
    parseProposal: (value) => proposalSchema.parse(value),
    parseTrustedReferences: (value) => trustedStatusEvidenceReferencesSchema.parse(value),
    createRetryableFailure: (issues, digest, cause) =>
      new AiWorkflowRetryableFailureError(issues, digest, "reuse_lease", cause),
  });
}

function rebindInitialOperation(
  operation: ProposalOperation,
  prepared: PreparedTurn,
  previous: StoredProposal | undefined,
): ProposalOperation {
  return rebindOperationValues(operation, prepared, previous, {
    resolveCreate: (value) => value.operation === "create_task"
      ? proposalOperationSchema.parse(resolveInheritedSplitInstructionAlias({
          ...value, baseline_snapshot_hash: prepared.baseline_snapshot_hash,
        }, prepared.inherited_split_instruction_aliases, canonicalizeJson)) : value,
    resolveStatus: (value) => value.operation === "complete" || value.operation === "withdraw"
      ? resolveInheritedStatusEvidenceAlias(value, prepared.inherited_status_evidence_aliases) : value,
    parseOperation: (value) => proposalOperationSchema.parse(value),
    createStatusEvidenceLocator,
    createTaskNotesSourceId,
    verifiedSourceExcerpt,
  });
}

function rebindInitialProposal(
  proposal: Proposal | undefined,
  prepared: PreparedTurn,
  previous: StoredProposal | undefined,
): Proposal | undefined {
  return rebindProposalValues<ProposalOperation, Proposal>(proposal,
    (operation) => rebindInitialOperation(operation, prepared, previous),
    (value) => proposalSchema.parse(value));
}

function workspaceCandidateDigest(proposal: Proposal): AiWorkflowCandidateDigest {
  return aiWorkflowCandidateDigestSchema.parse({
    kind: "available",
    sha256: createHash("sha256").update(canonicalizeJson(proposal)).digest("hex"),
  });
}

function validateWorkspaceProposal(
  proposal: Proposal,
  prepared: PreparedTurn,
): ProposalWorkspaceValidation<null> {
  return validateSubmittedWorkspaceProposal<
    ProposalOperation,
    Proposal,
    PreparedTurn,
    AiWorkflowCandidateDigest,
    BoundProposalEvidence,
    StoredProposal,
    AiWorkflowValidationIssue,
    ProposalWorkspaceIssue,
    AiWorkflowRetryableFailureError
  >(proposal, prepared, {
    createTaskDuration: (operation) => {
      if (operation.operation !== "create_task") {
        throw new Error("新規タスク以外の所要時間を検証できません。");
      }
      return operation.after.duration;
    },
    createCandidateDigest: workspaceCandidateDigest,
    bindProposalEvidence,
    createStoredProposal,
    proposalValidationIssues,
    workspaceValidationIssues,
    isRetryableFailure: (error): error is AiWorkflowRetryableFailureError =>
      error instanceof AiWorkflowRetryableFailureError,
  });
}

/** 選択済み変更案をアプリ側順位計算へ投影して影響を返します。 */
export function calculateWorkflowImpact(
  snapshot: AiWorkflowSnapshot,
  proposal: Proposal,
  selectedOperationIds: readonly string[],
): AiWorkflowImpact {
  const support = createImpactSupport({
    normalizeTasks: (tasks: readonly Task[]) =>
      normalizeRankingTasks<Task, ReturnType<typeof normalizeTaskGraph>["tasks"][number]>(
        tasks, { normalizeTaskGraph, WorkflowError: AiWorkflowError }),
    projectTaskValues: createTaskProjector({
      parseTask: (value) => taskSchema.parse(value),
      parseDependencies: (value) => dependenciesSchema.parse(value),
      parseObsidianLinks: (value) => obsidianLinksSchema.parse(value),
      WorkflowError: AiWorkflowError,
    }),
    WorkflowError: AiWorkflowError,
  });
  const calculate = createImpactCalculator({
    snapshotSchema: aiWorkflowSnapshotSchema,
    proposalSchema,
    identifierSchema,
    parseImpact: (value) => aiWorkflowImpactSchema.parse(value),
    ...support,
    calculateTaskRanking,
    SelectionError: AiWorkflowSelectionError,
  });
  return calculate(snapshot, proposal, selectedOperationIds);
}

function createStoredProposal(
  proposalId: string,
  bound: BoundProposalEvidence,
  prepared: PreparedTurn,
): StoredProposal {
  return buildStoredProposal(proposalId, bound, prepared, {
    validateBasic: validateProposal,
    validateGraph: validateProposalGraph,
    eligibleOperationIds,
  });
}

export type WorkflowProposalViewInput = {
  readonly proposal_id: string;
  readonly proposal: Proposal;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly basic_validation: ProposalValidationResult;
  readonly graph_validation: GraphValidationResult;
  readonly selected_operation_ids: readonly string[];
};

/** 保持中の提案と検証結果をRenderer向け表示値へ変換します。 */
export function createWorkflowProposalView(
  input: WorkflowProposalViewInput,
): AiWorkflowProposalView {
  return buildWorkflowProposalView(input, {
    parseIdentifier: (value) => identifierSchema.parse(value),
    parseProposal: (value) => proposalSchema.parse(value),
    parseOperation: (value) => proposalOperationSchema.parse(value),
    calculateImpact: calculateWorkflowImpact,
    parseView: (value) => aiWorkflowProposalViewSchema.parse(value),
  });
}

function zodIssueCode(code: string): string {
  const parsed = aiWorkflowZodIssueCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "other";
}

function createStructuredOutputFailure(
  error: CodexSessionOutputValidationError,
  candidateDigest: AiWorkflowCandidateDigest,
): AiWorkflowRetryableFailureError {
  return buildStructuredOutputFailure(error, candidateDigest, {
    parseIssue: (value) => aiWorkflowValidationIssueSchema.parse(value),
    parseZodIssueCode: zodIssueCode,
    createFailure: (issues, digest, cause) =>
      new AiWorkflowRetryableFailureError(issues, digest, "reuse_lease", cause),
  });
}

const retryDiagnosticDependencies = {
  hashIssues: (issues: readonly unknown[]) => createHash("sha256")
    .update(canonicalizeJson(issues)).digest("hex"),
  parseValidationErrors: (value: unknown) => aiWorkflowValidationErrorsSchema.parse(value),
  parseRetryLogEvent: (value: unknown) => aiWorkflowRetryLogEventSchema.parse(value),
  maximumRetryAttempts: aiWorkflowMaximumRetryAttempts,
  errorProjection: {
    projectionSchema: aiWorkflowSafeErrorProjectionSchema,
    isRetryableFailure: (error: unknown) => error instanceof AiWorkflowRetryableFailureError,
    isOutputValidationFailure: (error: unknown) => error instanceof CodexSessionOutputValidationError,
    redactSensitiveText,
  },
};

function createValidationErrorsDocument(
  attempt: number,
  failure: AiWorkflowRetryableFailureError,
  previousDigest: AiWorkflowPreviousDigest,
): AiWorkflowValidationErrors {
  return buildValidationErrorsDocument(attempt, failure, previousDigest,
    retryDiagnosticDependencies);
}

function createRetryLogEvent(
  severity: "warning" | "error",
  sessionId: string,
  logicalTurnId: string,
  attempt: number,
  failure: AiWorkflowRetryableFailureError,
  previousDigest: AiWorkflowPreviousDigest,
  retryDecision: "retry" | "stop",
): AiWorkflowRetryLogEvent {
  return buildRetryLogEvent(severity, sessionId, logicalTurnId, attempt, failure,
    previousDigest, retryDecision, retryDiagnosticDependencies);
}

function proposalValidationIssues(stored: StoredProposal): AiWorkflowValidationIssue[] {
  return collectProposalValidationIssues(stored, {
    parseIssue: (value) => aiWorkflowValidationIssueSchema.parse(value),
    parseDetailCode: (value) => aiWorkflowValidationDetailCodeSchema.parse(value),
  });
}

/** AI変更案をメモリ上で検証、選択、承認するサービスです。 */
export class AiWorkflowService {
  private readonly options: AiWorkflowOptions;
  private readonly proposals = new ProposalStore<StoredProposal, AiWorkflowProposalView, AiWorkflowSelectionRequest>(
    maximumWorkflowProposals,
    (value) => identifierSchema.parse(value),
    AiWorkflowProposalNotFoundError,
    AiWorkflowError,
    AiWorkflowStateError,
    {
      parseRequest: (value) => aiWorkflowSelectionRequestSchema.parse(value),
      resolveSelected: resolveSelectedOperationIds,
      assertGraphSafe: assertSelectedProposalGraphIsSafe,
      createView: createWorkflowProposalView,
    },
  );
  private readonly completedEvidenceSources = new Map<string, EvidenceSource>();
  private readonly deltaListeners = new Set<CodexSessionDeltaListener>();
  private readonly removeSessionDelta: () => void;
  private listenerErrorCount = 0;
  private lifecycle: "active" | "disposed" = "active";
  private pendingWithdrawConfirmation: PendingWithdrawConfirmation | undefined;
  private sessionGeneration = 0;

  public constructor(options: AiWorkflowOptions) {
    this.options = parseWorkflowOptions(options, identifierSchema);
    this.removeSessionDelta = this.options.session.onDelta((delta) => {
      this.emitDelta(delta);
    });
  }

  /** CodexのagentMessage差分を購読します。 */
  public onDelta(listener: CodexSessionDeltaListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("差分購読関数が必要です。");
    }
    if (this.lifecycle === "disposed") {
      throw new AiWorkflowStateError("AIワークフローは終了しています。");
    }
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** 新しいCodexセッション開始時に保留中の取り下げ確認を破棄します。 */
  public resetPendingWithdrawConfirmation(): void {
    this.sessionGeneration += 1;
    this.pendingWithdrawConfirmation = undefined;
  }

  /** 同期後の基準値を固定してCodexターンを実行します。 */
  public async startTurn(
    input: AiWorkflowTurnRequest,
    signal: AbortSignal,
  ): Promise<AiWorkflowTurnResult> {
    if (this.lifecycle === "disposed") {
      throw new AiWorkflowStateError("AIワークフローは終了しています。");
    }
    const request = aiWorkflowTurnRequestSchema.parse(input);
    const baseProposal = request.base_proposal_id == null
      ? undefined
      : this.proposals.getStoredProposal(request.base_proposal_id);
    throwIfAborted(signal);
    this.proposals.assertProposalCapacity(request.base_proposal_id);
    const turnGeneration = this.sessionGeneration;
    const pendingWithdrawConfirmation = this.pendingWithdrawConfirmation;
    const logicalTurnId = identifierSchema.parse(randomUUID());
    const execution = await this.executeTurn({
      request,
      signal,
      baseProposal,
      turnGeneration,
      pendingWithdrawConfirmation,
      logicalTurnId,
      retryProposal: undefined,
    });
    if (execution.kind === "failed") {
      throw execution.error;
    }
    return this.commitTurn(execution.commit);
  }

  private async executeTurn(input: TurnExecutionInput): Promise<TurnExecutionResult> {
    return executeTurnWithRetry<
      TurnExecutionInput,
      TurnCommit,
      Proposal,
      ProposalWorkspace,
      AiWorkflowRetryableFailureError,
      AiWorkflowCandidateDigest,
      AiWorkflowPreviousDigest,
      AiWorkflowValidationErrors
    >(input, {
      maximumRetryAttempts: aiWorkflowMaximumRetryAttempts,
      throwIfAborted,
      logRetryEvent: (severity, logicalTurnId, attempt, failure, previousDigest, decision) =>
        safelyLogRetryEvent(this.options.logRetryEvent, createRetryLogEvent(severity,
          this.options.sessionId, logicalTurnId, attempt, failure, previousDigest, decision)),
      executeAttempt: (attempt) => this.executeTurnAttempt(attempt),
      responseError: (error) => error instanceof DiagnosticFailureDispositionError
        ? error.disposition.response_error : error,
      isDisposition: (error) => error instanceof DiagnosticFailureDispositionError,
      isSyncError: (error) => error instanceof CodexSessionSyncError,
      makeSyncError: (error) => new AiWorkflowSyncError(error),
      classifyRetryFailure: (error) => this.classifyRetryFailure(error),
      initialPreviousDigest: () => aiWorkflowPreviousDigestSchema.parse({
        kind: "unavailable", reason: "not_available",
      }),
      previousDigestFromCandidate,
      createValidationErrorsDocument,
      makeFinalFailure: (failure) => new AiWorkflowError(
        "AI変更案の訂正を3回の試行で完了できませんでした。", failure),
      makeRecordedFailure: (error) => new DiagnosticFailureDispositionError({
        kind: "recorded_only", recorded_error: error, response_error: error,
      }),
      readRetryProposal: (workspace) => workspace.getStatus().completion === "structurally_complete"
        ? readWorkspaceProposal(workspace, (value) => proposalSchema.parse(value)) : undefined,
    });
  }

  private classifyRetryFailure(
    error: unknown,
  ):
    | { readonly kind: "retryable"; readonly failure: AiWorkflowRetryableFailureError }
    | { readonly kind: "not_retryable" } {
    if (error instanceof AiWorkflowRetryableFailureError) {
      return { kind: "retryable", failure: error };
    }
    if (!(error instanceof CodexSessionOutputValidationError)) {
      return { kind: "not_retryable" };
    }
    return {
      kind: "retryable",
      failure: createStructuredOutputFailure(
        error,
        aiWorkflowCandidateDigestSchema.parse({
          kind: "unavailable",
          reason: "not_staged",
        }),
      ),
    };
  }

  private async executeTurnAttempt(input: TurnAttemptInput): Promise<TurnCommit> {
    return runTurnAttemptWithResources(input, {
      performTurnAttempt: (attempt, updateResources) => this.performTurnAttempt(attempt, updateResources),
      cancelTurn: (attemptId) => this.options.externalStatusEvidenceCollector.cancelTurn(attemptId),
      releaseTaskctlSnapshot: () => this.options.session.releaseTaskctlSnapshot(),
      WorkflowError: AiWorkflowError,
    });
  }

  private async performTurnAttempt(
    input: TurnAttemptInput,
    updateResources: (resources: AttemptResourceState) => void,
  ): Promise<TurnCommit> {
    const {
      request,
      signal,
      baseProposal,
      turnGeneration,
      pendingWithdrawConfirmation,
      logicalTurnId,
      retryProposal,
      attempt,
      retryPromptContext,
      workspaceState,
    } = input;
    const attemptId = identifierSchema.parse(randomUUID());
    const { prepared: turnPrepared, response: generatedResponse, workspace } = await runSessionTurn<
      AiWorkflowSnapshot,
      TrustedStatusEvidenceReference,
      PreparedTurn,
      ProposalWorkspace,
      CodexSessionTurnInput,
      CodexSessionTurnResult["response"],
      TrustedExternalStatusEvidence
    >({ attemptId, signal, workspaceState }, {
      beginTurn: (id, currentSignal) =>
        this.options.externalStatusEvidenceCollector.beginTurn(id, currentSignal),
      startTurn: (factory, currentSignal) =>
        this.options.session.startTurnWithPreparation(factory, currentSignal),
      createTurnInput: async (turnSignal, markPrepared) => {
        const prepared: PreparedTurn = await prepareTurn({
          signal: turnSignal,
          message: request.message,
          logicalTurnId,
          turnGeneration,
          sessionGeneration: this.sessionGeneration,
          pendingWithdrawConfirmation,
          completedEvidenceSources: this.completedEvidenceSources,
        }, {
          snapshotProvider: (currentSignal) => this.options.snapshotProvider(currentSignal),
          parseSnapshot: (value) => aiWorkflowSnapshotSchema.parse(value),
          createBaselineSnapshot,
          hashBaselineSnapshot,
          baselineExternalDataProvider: (baseline, currentSignal) =>
            this.options.baselineExternalDataProvider(baseline, currentSignal),
          parseBaselineExternalData: (value) => asanaProposalApplicationInputSchema
            .shape.baseline_external_data.parse(value),
          taskctlSnapshotProvider: (currentSignal) => this.options.taskctlSnapshotProvider(currentSignal),
          parseTaskctlSnapshot: (value) => taskctlSnapshotSchema.parse(value),
          assertTaskctlSnapshotMatchesBaseline: (snapshot, baseline, taskctlSnapshot) =>
            verifyTaskctlBaseline(snapshot, baseline, taskctlSnapshot, {
              parseBaselineSnapshot: (value) => baselineSnapshotSchema.parse(value),
              canonicalizeJson,
              SyncError: AiWorkflowSyncError,
            }),
          isPendingWithdrawConfirmationValid,
          createEvidenceSourceMap: (turnId, message, snapshot, completed, pending) =>
            createEvidenceSourceMap(turnId, message, snapshot, completed, pending,
              createUserMessageSourceId, createTaskNotesSourceId,
              createWithdrawConfirmationSourceId),
          createInheritedEvidenceAliases: (sourceMap, snapshot, baseline) =>
            collectInheritedEvidenceAliases(baseProposal, sourceMap, snapshot, baseline, {
              eligibleOperations: (stored) => selectEligibleEvidenceOperations(stored.proposal,
                new Set(eligibleOperationIds(stored.proposal, stored.graph_validation))),
              canonicalizeJson,
              createStatusEvidenceLocator,
              createSplitInstructionLocator,
              verifiedSourceExcerpt,
              WorkflowError: AiWorkflowError,
            }),
          createTrustedStatusEvidence: (snapshot) => createTrustedStatusEvidence(snapshot, []),
        });
        return connectTurnInput({
          prepared,
          proposal: retryProposal ?? baseProposal?.proposal,
          request,
          retryPromptContext,
          attemptId,
          signal,
          markPrepared,
          updateResources,
        }, {
          rebindInitialProposal: (proposal, currentPrepared) =>
            rebindInitialProposal(proposal, currentPrepared, baseProposal),
          createWorkspace: (baselineHash, initialProposal) => new ProposalWorkspace({
            workspace_id: identifierSchema.parse(randomUUID()),
            baseline_snapshot_hash: baselineHash,
            ...(initialProposal == null ? {} : { initial_proposal: initialProposal }),
          }),
          freezeTaskctlSnapshot: (snapshot: TaskctlSnapshot) =>
            this.options.session.freezeTaskctlSnapshot(snapshot),
          activateProposalWorkspace: (workspace, validate) =>
            this.options.session.activateProposalWorkspace(workspace, validate),
          snapshotExternalEvidence: (id, currentSignal) =>
            this.options.externalStatusEvidenceCollector.snapshotTurn(id, currentSignal),
          parseExternalEvidence: (value) => trustedExternalStatusEvidenceSchema.parse(value),
          createTrustedStatusEvidence,
          validateWorkspaceProposal,
          createTurnPrompt: (currentRequest, currentPrepared, workspace, context) =>
            createTurnPrompt(currentRequest, currentPrepared, workspace, context, {
              parseContext: (value) => aiWorkflowTurnContextSchema.parse(value),
              canonicalizeJson,
              maximumRetryAttempts: aiWorkflowMaximumRetryAttempts,
              WorkflowError: AiWorkflowError,
            }),
        });
      },
      finishTurn: (id, currentSignal) =>
        this.options.externalStatusEvidenceCollector.finishTurn(id, currentSignal),
      parseExternalEvidence: (value) => trustedExternalStatusEvidenceSchema.parse(value),
      createTrustedStatusEvidence,
      updateResources,
      SyncError: AiWorkflowSyncError,
      StateError: AiWorkflowStateError,
    });
    const validatedResponse = validateGeneratedResponse<
      Proposal,
      Extract<CodexResponse, { readonly kind: "proposal" }>,
      NoProposalResponse,
      CodexSessionTurnResult["response"],
      AiWorkflowValidationIssue,
      AiWorkflowCandidateDigest
    >(
      generatedResponse,
      workspace,
      {
        readProposal: () => readWorkspaceProposal(workspace, (value) => proposalSchema.parse(value)),
        parseResponse: (value) => codexResponseSchema.parse(value),
        parseIssue: (value) => aiWorkflowValidationIssueSchema.parse(value),
        notStagedDigest: () => aiWorkflowCandidateDigestSchema.parse({
          kind: "unavailable", reason: "not_staged",
        }),
        candidateDigest: workspaceCandidateDigest,
        makeFailure: (issues, digest, cause) =>
          new AiWorkflowRetryableFailureError(issues, digest, "reuse_lease", cause),
        WorkflowError: AiWorkflowError,
      },
    );
    if (turnGeneration !== this.sessionGeneration) {
      throw new AiWorkflowStateError("AIセッションが切り替わったため、AIターンを破棄しました。");
    }
    if (validatedResponse.kind === "no_proposal") {
      return createNoProposalCommit(validatedResponse.response, turnPrepared, attempt, {
        createPendingWithdrawConfirmation: (response, prepared) =>
          createPendingWithdrawConfirmation(response, prepared, AiWorkflowError),
        createRendererQuestions: (questions, pending, prepared) =>
          createRendererQuestions(questions, pending, prepared.snapshot, AiWorkflowError),
        parseTurnResult: (value) => aiWorkflowTurnResultSchema.parse(value),
      });
    }
    return createProposalCommit(
      validatedResponse.response,
      turnPrepared,
      attempt,
      request.base_proposal_id,
      {
        candidateDigest: workspaceCandidateDigest,
        parseProposal: (value) => proposalSchema.parse(value),
        bindProposalEvidence,
        createProposalId: () => identifierSchema.parse(randomUUID()),
        createStoredProposal,
        proposalValidationIssues,
        makeValidationFailure: (issues, digest) => new AiWorkflowRetryableFailureError(
          issues,
          digest,
          "reuse_lease",
          new AiWorkflowError("基本検証またはグラフ検証が変更案を適用可能と判定しませんでした。"),
        ),
        createProposalView: createWorkflowProposalView,
        createRendererQuestions: (questions, prepared) =>
          createRendererQuestions(questions, undefined, prepared.snapshot, AiWorkflowError),
        parseTurnResult: (value) => aiWorkflowTurnResultSchema.parse(value),
      },
    );
  }

  private commitTurn(commit: TurnCommit): AiWorkflowTurnResult {
    return applyTurnCommit(commit, {
      storeProposal: (stored, replacingId) => this.proposals.storeProposal(stored, replacingId),
      rememberSuccessfulTurnEvidence: (prepared) =>
        rememberSuccessfulTurnEvidence(this.completedEvidenceSources, prepared),
      setPendingWithdrawConfirmation: (value) => {
        this.pendingWithdrawConfirmation = value;
      },
    });
  }

  /** 保持中の変更案を取得してRenderer向けDTOへ変換します。 */
  public getProposal(proposalId: string): AiWorkflowProposalView {
    return this.proposals.getProposal(proposalId);
  }

  /** 変更案の選択状態を更新してRenderer向けDTOを返します。 */
  public select(input: AiWorkflowSelectionRequest): AiWorkflowProposalView {
    return this.proposals.select(input);
  }

  /** 変更案の操作後値だけを利用者編集して再検証します。 */
  public editOperation(input: AiWorkflowOperationEdit): AiWorkflowProposalView {
    const request = aiWorkflowOperationEditSchema.parse(input);
    const stored = this.proposals.getStoredProposal(request.proposal_id);
    const edited = editStoredProposal(request, stored, {
      operationMap: (proposal) => indexProposalOperations(proposal, AiWorkflowError),
      parseOperation: (value) => proposalOperationSchema.parse(value),
      parseProposal: (value) => proposalSchema.parse(value),
      revalidate: (proposal, current) => validateStoredProposal(proposal, current, {
        validateBasic: validateProposal,
        validateGraph: validateProposalGraph,
      }),
      preserveSelection,
      assertGraphSafe: assertSelectedProposalGraphIsSafe,
      EditError: AiWorkflowEditError,
    });
    const updated: StoredProposal = { ...stored, ...edited };
    this.proposals.set(updated.proposal_id, updated);
    return createWorkflowProposalView(updated);
  }

  /** 変更案をメモリから破棄します。 */
  public rejectProposal(proposalId: string): void {
    this.proposals.rejectProposal(proposalId);
  }

  /** オンライン再取得後に選択済み変更案をAsanaへ適用します。 */
  public async approve(
    input: AiWorkflowApprovalRequest,
    signal: AbortSignal,
  ): Promise<AiWorkflowApprovalResult> {
    return this.proposals.approve(input, signal, {
      parseRequest: (value) => aiWorkflowApprovalRequestSchema.parse(value),
      throwIfAborted,
      resolveSelection: (stored, selection) => resolveSelectedOperationIds(stored, selection),
      assertGraphSafe: assertSelectedProposalGraphIsSafe,
      isOnline: () => this.options.isOnline(),
      OfflineError: AiWorkflowOfflineError,
      createPreparationInput: createApprovalPreparationInput,
      prepareApprovalInput: (prepared: ApprovalPreparationInput, currentSignal) =>
        this.options.prepareApprovalInput(prepared, currentSignal),
      parseApprovalInput: (value) => asanaProposalApplicationInputSchema.parse(value),
      assertApprovalInputMatchesStored: (validated, stored, selected) =>
        assertApprovalInputMatchesStored(validated, stored, selected, {
          canonicalizeJson,
          createBaselineTaskSnapshots,
          WorkflowError: AiWorkflowError,
        }),
      apply: (validated, currentSignal) =>
        this.options.applicationCoordinator.apply(validated, currentSignal),
      parseApplication: (value) => asanaProposalApplicationResultSchema.parse(value),
      createResult: (stored, application) => aiWorkflowApprovalResultSchema.parse({
        proposal_id: stored.proposal_id,
        application: createApplicationSummary(application),
      }),
    });
  }

  /** AIワークフローの購読と保持中変更案を終了時に破棄します。 */
  public dispose(): void {
    if (this.lifecycle === "disposed") {
      return;
    }
    this.removeSessionDelta();
    this.options.session.releaseTaskctlSnapshot();
    this.deltaListeners.clear();
    this.proposals.clear();
    this.completedEvidenceSources.clear();
    this.pendingWithdrawConfirmation = undefined;
    this.sessionGeneration += 1;
    this.lifecycle = "disposed";
  }

  private emitDelta(delta: CodexSessionDelta): void {
    for (const listener of this.deltaListeners) {
      const result = listener(delta);
      if (result != null) {
        void Promise.resolve(result).catch((error: unknown) => {
          this.listenerErrorCount = Math.min(this.listenerErrorCount + 1, 256);
          return error;
        });
      }
    }
  }
}
