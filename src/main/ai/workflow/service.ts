import { createHash, randomUUID } from "node:crypto";
import {
  baselineSnapshotSchema,
  canonicalizeJson,
  dependenciesSchema,
  gidSchema,
  identifierSchema,
  obsidianLinksSchema,
  taskSchema,
  type BaselineSnapshot,
  type Task,
  type TaskSnapshot,
} from "../../../shared/domain";
import {
  codexResponseSchema,
  proposalOperationSchema,
  proposalSchema,
  type CodexResponse,
  type Proposal,
  type ProposalOperation,
} from "../../../shared/ai";
import {
  ProposalWorkspace,
  type ProposalWorkspaceValidation,
} from "../proposal-workspace";
import {
  aiWorkflowApprovalRequestSchema,
  aiWorkflowApprovalResultSchema,
  aiWorkflowImpactSchema,
  aiWorkflowOperationEditSchema,
  aiWorkflowProposalViewSchema,
  aiWorkflowSelectionRequestSchema,
  aiWorkflowSnapshotSchema,
  aiWorkflowTurnContextSchema,
  aiWorkflowTurnRequestSchema,
  aiWorkflowTurnResultSchema,
  type AiWorkflowApprovalRequest,
  type AiWorkflowApprovalResult,
  type AiWorkflowImpact,
  type AiWorkflowOperationEdit,
  type AiWorkflowProposalView,
  type AiWorkflowSelectionRequest,
  type AiWorkflowSnapshot,
  type AiWorkflowTurnRequest,
  type AiWorkflowTurnResult,
} from "../../../shared/ai-workflow";
import {
  calculateTaskRanking,
  type RankingTask,
} from "../../domain/ranking";
import { hashBaselineSnapshot } from "../../domain/snapshot-hash";
import {
  normalizeTaskGraph,
} from "../../domain/normalization";
import {
  createChildrenOnlyEvidenceLocator,
  trustedStatusEvidenceReferencesSchema,
  validateProposal,
  validateProposalGraph,
  type ExplicitSplitRequestReference,
  type GraphValidationResult,
  type ProposalValidationResult,
  type TrustedStatusEvidenceReference,
} from "../proposal-validation";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationCoordinator,
} from "../proposal-application";
import {
  CodexSessionOutputValidationError,
  CodexSessionSyncError,
  type CodexSessionDelta,
  type CodexSessionDeltaListener,
  type CodexSessionTurnInput,
  type CodexSessionTurnInputFactory,
  type CodexSessionTurnResult,
} from "../../codex/session";
import { taskctlSnapshotSchema, type TaskctlSnapshot } from "../../codex/taskctl";
import {
  AiWorkflowEditError,
  AiWorkflowError,
  AiWorkflowOfflineError,
  AiWorkflowProposalNotFoundError,
  AiWorkflowRetryableFailureError,
  AiWorkflowSelectionError,
  AiWorkflowStateError,
  AiWorkflowSyncError,
} from "./errors";
import {
  aiWorkflowPreviousDigestSchema,
  aiWorkflowCandidateDigestSchema,
  aiWorkflowRetryLogEventSchema,
  aiWorkflowSafeErrorProjectionSchema,
  aiWorkflowValidationErrorsSchema,
  aiWorkflowValidationIssueSchema,
  aiWorkflowValidationDetailCodeSchema,
  aiWorkflowZodIssueCodeSchema,
  aiWorkflowMaximumRetryAttempts,
  type AiWorkflowCandidateDigest,
  type AiWorkflowPreviousDigest,
  type AiWorkflowRetryLogEvent,
  type AiWorkflowValidationErrors,
  type AiWorkflowValidationIssue,
} from "./retry";
import {
  assertSelectedProposalGraphIsSafe,
  eligibleOperationIds,
  preserveSelection,
  resolveSelectedOperationIds,
} from "./selection";
import {
  DiagnosticFailureDispositionError,
} from "../../diagnostic-failure";
import { redactSensitiveText } from "../../redact-sensitive-text";
import {
  createValidationErrorsDocument as buildValidationErrorsDocument,
  createRetryLogEvent as buildRetryLogEvent,
  proposalValidationIssues as collectProposalValidationIssues,
  createStructuredOutputFailure as buildStructuredOutputFailure,
  previousDigestFromCandidate,
} from "../../application/proposal-generate/retry-diagnostics";
import {
  createInheritedEvidenceAliases as collectInheritedEvidenceAliases,
  type InheritedStatusEvidenceAlias,
  type InheritedSplitInstructionAlias,
  type EligibleEvidenceOperation,
} from "../../application/proposal-generate/evidence-inheritance";
import {
  bindStatusEvidence,
  bindSplitInstructionReference,
} from "../../application/proposal-generate/evidence-binding";
import { createImpactCalculator, normalizeTasksForRanking as normalizeRankingTasks } from "../../application/proposal-generate/impact-ranking";
import { executeTurnWithRetry } from "../../application/proposal-generate/turn-retry";
import { runTurnAttemptWithResources, type AttemptResourceState } from "../../application/proposal-generate/attempt-resources";
import { bindProposalEvidence as bindProposalEvidenceSources } from "../../application/proposal-generate/proposal-evidence";
import { sanitizeProposalForRenderer, toWorkflowValidation } from "../../application/proposal-generate/proposal-view";
import { createApprovalPreparationInput, assertApprovalInputMatchesStored } from "../../application/proposal-generate/approval-preparation";
import { editStoredProposal } from "../../application/proposal-generate/proposal-edit";
import { createStoredProposal as buildStoredProposal, revalidateProposal as validateStoredProposal } from "../../application/proposal-generate/stored-proposal";
import { readWorkspaceProposal, workspaceValidationIssues } from "../../application/proposal-generate/workspace-validation";
import { validateGeneratedResponse } from "../../application/proposal-generate/turn-response";
import { createApplicationSummary } from "../../application/proposal-generate/approval-summary";
import { createBaselineTaskSnapshots } from "../../application/proposal-generate/baseline-snapshot";
import { createTrustedExternalStatusEvidenceSchema, parseWorkflowOptions } from "../../application/proposal-generate/workflow-options";
import { rebindBeforeValue } from "../../application/proposal-generate/rebind-before";
import { createTaskProjector, projectedTemporaryGid, projectedTargetGid } from "../../application/proposal-generate/task-projection";
import {
  createTurnPrompt,
  createPendingWithdrawConfirmation,
  createRendererQuestions,
} from "../../application/proposal-generate/turn-prompt";
import {
  createEvidenceSourceMap,
  rememberSuccessfulTurnEvidence,
  isPendingWithdrawConfirmationValid,
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

type ValidatedGeneratedResponse =
  | { readonly kind: "no_proposal"; readonly response: NoProposalResponse }
  | {
      readonly kind: "proposal";
      readonly response: Extract<CodexResponse, { readonly kind: "proposal" }>;
    };

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
  | {
      readonly kind: "succeeded";
      readonly commit: TurnCommit;
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
    };

type PreparedTurnState =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly value: PreparedTurn };

type PendingWithdrawConfirmationCommit =
  | { readonly kind: "clear" }
  | { readonly kind: "set"; readonly value: PendingWithdrawConfirmation };

type TurnCommit =
  | {
      readonly kind: "no_proposal";
      readonly result: AiWorkflowTurnResult;
      readonly pendingWithdrawConfirmation: PendingWithdrawConfirmationCommit;
      readonly prepared: PreparedTurn;
    }
  | {
      readonly kind: "proposal";
      readonly result: AiWorkflowTurnResult;
      readonly pendingWithdrawConfirmation: PendingWithdrawConfirmationCommit;
      readonly storedProposal: StoredProposal;
      readonly replacingProposalId: string | undefined;
      readonly prepared: PreparedTurn;
    };

type RetryEventLogResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type AiWorkflowLifecycle =
  | { readonly kind: "active" }
  | { readonly kind: "disposed" };

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
export type AiWorkflowSnapshotProvider = (
  signal: AbortSignal,
) => AiWorkflowSnapshot | PromiseLike<AiWorkflowSnapshot>;

/** ターン中のtaskctl参照状態を供給する関数の型です。 */
export type AiWorkflowTaskctlSnapshotProvider = (
  signal: AbortSignal,
) => TaskctlSnapshot | PromiseLike<TaskctlSnapshot>;

/** 提案基準に対応するCustom external dataを供給する関数の型です。 */
export type AiWorkflowBaselineExternalDataProvider = (
  baseline: BaselineSnapshot,
  signal: AbortSignal,
) => AsanaProposalApplicationInput["baseline_external_data"]
  | PromiseLike<AsanaProposalApplicationInput["baseline_external_data"]>;

/** ターン単位で外部ツールの構造化状態記録を収集する境界です。 */
export interface AiWorkflowExternalStatusEvidenceCollector {
  beginTurn(turnId: string, signal: AbortSignal): void | PromiseLike<void>;
  snapshotTurn(
    turnId: string,
    signal: AbortSignal,
  ): readonly TrustedExternalStatusEvidence[];
  finishTurn(
    turnId: string,
    signal: AbortSignal,
  ): readonly TrustedExternalStatusEvidence[]
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
export type AiWorkflowApprovalInputProvider = (
  input: ApprovalPreparationInput,
  signal: AbortSignal,
) => AsanaProposalApplicationInput | PromiseLike<AsanaProposalApplicationInput>;

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

function throwIfAborted(signal: AbortSignal): void {
  validateAbortSignal(signal);
  if (signal.aborted) {
    throw new AiWorkflowError("AIワークフローが中断されました。");
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

/** 同期済みタスクをキー順の基準スナップショットへ変換します。 */
export function createBaselineSnapshot(
  snapshot: AiWorkflowSnapshot,
): BaselineSnapshot {
  const validated = aiWorkflowSnapshotSchema.parse(snapshot);
  return baselineSnapshotSchema.parse({
    app_version: validated.app_version,
    project_gid: validated.project_gid,
    as_of: validated.as_of,
    tasks: createBaselineTaskSnapshots(validated.tasks),
  });
}

function findTaskByGid(
  snapshot: AiWorkflowSnapshot,
  taskGid: string,
): Task | undefined {
  return snapshot.tasks.find((task) => task.gid === taskGid);
}

function allChildrenAreCompleted(
  task: Task,
  tasksByGid: ReadonlyMap<string, Task>,
): boolean {
  if (task.parent_work_mode !== "children_only" || task.child_gids.length === 0) {
    return false;
  }
  return task.child_gids.every((childGid) => {
    const child = tasksByGid.get(childGid);
    return child != null && child.status === "completed";
  });
}

function createUserMessageSourceId(turnId: string): string {
  return `user-message:${identifierSchema.parse(turnId)}`;
}

function createTaskNotesSourceId(turnId: string, taskGid: string): string {
  return `task-notes:${identifierSchema.parse(turnId)}:${gidSchema.parse(taskGid)}`;
}

function createWithdrawConfirmationSourceId(turnId: string): string {
  return `withdraw-confirmation:${identifierSchema.parse(turnId)}`;
}

function createStatusEvidenceLocator(
  sourceId: string,
  operation: "complete" | "withdraw",
  taskGid: string,
): string {
  return `${sourceId}#${operation}:${gidSchema.parse(taskGid)}`;
}

type ProposalTarget = Extract<
  ProposalOperation,
  { readonly operation: "update_title" }
>["target"];

function createSplitInstructionLocator(
  sourceId: string,
  parent: ProposalTarget,
): string {
  const parentKey = parent.kind === "existing"
    ? `gid:${gidSchema.parse(parent.gid)}`
    : `ref:${identifierSchema.parse(parent.ref)}`;
  return `${sourceId}#split-parent:${parentKey}`;
}

function verifiedSourceExcerpt(
  source: EvidenceSource,
  excerpt: string | undefined,
): string | undefined {
  if (excerpt == null || excerpt.trim().length === 0 || !source.text.includes(excerpt)) {
    return undefined;
  }
  return excerpt;
}

function createTrustedStatusEvidence(
  snapshot: AiWorkflowSnapshot,
  externalEvidence: readonly TrustedExternalStatusEvidence[],
): readonly TrustedStatusEvidenceReference[] {
  const tasksByGid = new Map(snapshot.tasks.map((task) => [task.gid, task]));
  const promptReferences: TrustedStatusEvidenceReference[] = [];
  const sortedTasks = [...snapshot.tasks].sort((left, right) =>
    compareStrings(left.gid, right.gid));
  for (const task of sortedTasks) {
    if (allChildrenAreCompleted(task, tasksByGid)) {
      promptReferences.push({
        kind: "task",
        locator: createChildrenOnlyEvidenceLocator(task.gid),
        target_task_gid: task.gid,
        allowed_operation: "complete",
        validation_kind: "children_only_all_completed",
      });
    }
  }
  const references = [
    ...promptReferences.slice(0, maximumPromptStatusEvidenceReferences),
    ...externalEvidence,
  ];
  return trustedStatusEvidenceReferencesSchema.parse(references);
}

type StatusOperation = Extract<
  ProposalOperation,
  { readonly operation: "complete" | "withdraw" }
>;

type SplitTaskOperation = Extract<
  ProposalOperation,
  { readonly operation: "create_task" }
>;

function resolveInheritedStatusEvidence(
  operation: StatusOperation,
  prepared: PreparedTurn,
): StatusOperation {
  const evidence = operation.status_evidence;
  if (evidence.kind !== "user_explicit" || evidence.reference.kind !== "user_message") {
    return operation;
  }
  if (operation.target.kind !== "existing") {
    return operation;
  }
  const targetTaskGid = operation.target.gid;
  const alias = prepared.inherited_status_evidence_aliases.find(
    (candidate) => candidate.locator === evidence.reference.locator
      && candidate.excerpt === evidence.reference.excerpt
      && candidate.target_task_gid === targetTaskGid
      && candidate.allowed_operation === operation.operation,
  );
  if (alias == null) {
    return operation;
  }
  return {
    ...operation,
    status_evidence: {
      ...evidence,
      reference: {
        ...evidence.reference,
        locator: alias.source_id,
        excerpt: alias.excerpt,
      },
    },
  };
}

function resolveInheritedSplitInstructionReference(
  operation: SplitTaskOperation,
  prepared: PreparedTurn,
): SplitTaskOperation {
  if (operation.creation.kind !== "split_child") {
    return operation;
  }
  const parent = operation.creation.parent;
  const reference = operation.creation.instruction_reference;
  const alias = prepared.inherited_split_instruction_aliases.find(
    (candidate) => candidate.locator === reference.locator
      && candidate.excerpt === reference.excerpt
      && canonicalizeJson(candidate.parent) === canonicalizeJson(parent),
  );
  if (alias == null) {
    return operation;
  }
  return {
    ...operation,
    creation: {
      ...operation.creation,
      instruction_reference: {
        ...reference,
        locator: alias.source_id,
        excerpt: alias.excerpt,
      },
    },
  };
}

function bindProposalOperationEvidence(
  operation: ProposalOperation,
  prepared: PreparedTurn,
): {
  readonly operation: ProposalOperation;
  readonly split_reference: ExplicitSplitRequestReference | undefined;
  readonly trusted_reference: TrustedStatusEvidenceReference | undefined;
} {
  if (operation.operation === "create_task") {
    const resolved = resolveInheritedSplitInstructionReference(operation, prepared);
    if (resolved.creation.kind !== "split_child") {
      return {
        operation,
        split_reference: undefined,
        trusted_reference: undefined,
      };
    }
    const bound = bindSplitInstructionReference(resolved.creation, prepared, {
      createStatusEvidenceLocator,
      createSplitInstructionLocator,
      verifiedSourceExcerpt,
    });
    return {
      operation: proposalOperationSchema.parse({
        ...resolved,
        creation: {
          ...resolved.creation,
          instruction_reference: bound.reference,
        },
      }),
      split_reference: bound.split_reference,
      trusted_reference: undefined,
    };
  }
  if (operation.operation !== "complete" && operation.operation !== "withdraw") {
    return {
      operation,
      split_reference: undefined,
      trusted_reference: undefined,
    };
  }
  const resolved = resolveInheritedStatusEvidence(operation, prepared);
  const bound = bindStatusEvidence(resolved, prepared, {
    createStatusEvidenceLocator,
    createSplitInstructionLocator,
    verifiedSourceExcerpt,
  });
  return {
    operation: proposalOperationSchema.parse({
      ...resolved,
      status_evidence: bound.evidence,
    }),
    split_reference: undefined,
    trusted_reference: bound.trusted_reference,
  };
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

function createInheritedEvidenceAliases(
  baseProposal: StoredProposal | undefined,
  sourceMap: EvidenceSourceMap,
  snapshot: AiWorkflowSnapshot,
  baseline: BaselineSnapshot,
): {
  readonly status: readonly InheritedStatusEvidenceAlias[];
  readonly split: readonly InheritedSplitInstructionAlias[];
} {
  const eligibleIds = baseProposal == null
    ? new Set<string>()
    : new Set(eligibleOperationIds(baseProposal.proposal, baseProposal.graph_validation));
  const eligibleOperations: EligibleEvidenceOperation[] = [];
  if (baseProposal != null) {
    for (const group of baseProposal.proposal.groups) {
      for (const operation of group.operations) {
        if (!eligibleIds.has(operation.operation_id)) continue;
        if ((operation.operation === "complete" || operation.operation === "withdraw")
          && operation.status_evidence.kind === "user_explicit"
          && operation.status_evidence.reference.kind === "user_message"
          && operation.target.kind === "existing") {
          eligibleOperations.push({ kind: "status", operation: {
            operation: operation.operation,
            target: operation.target,
            status_evidence: operation.status_evidence,
          } });
        }
        if (operation.operation === "create_task"
          && operation.creation.kind === "split_child"
          && operation.creation.instruction_reference.kind === "user_message") {
          eligibleOperations.push({ kind: "split", creation: {
            kind: "split_child",
            parent: operation.creation.parent,
            instruction_reference: operation.creation.instruction_reference,
          } });
        }
      }
    }
  }
  return collectInheritedEvidenceAliases(baseProposal, sourceMap, snapshot, baseline,
    eligibleOperations, {
      canonicalizeJson,
      createStatusEvidenceLocator,
      createSplitInstructionLocator,
      verifiedSourceExcerpt,
      WorkflowError: AiWorkflowError,
    });
}

function rebindInitialOperation(
  operation: ProposalOperation,
  prepared: PreparedTurn,
  previous: StoredProposal | undefined,
): ProposalOperation {
  const baseline_snapshot_hash = prepared.baseline_snapshot_hash;
  if (operation.operation === "create_task") {
    return proposalOperationSchema.parse(resolveInheritedSplitInstructionReference({
      ...operation,
      baseline_snapshot_hash,
    }, prepared));
  }
  const reboundEvidence = operation.operation === "complete" || operation.operation === "withdraw"
    ? resolveInheritedStatusEvidence(operation, prepared)
    : operation;
  if (reboundEvidence.target.kind !== "existing") {
    return proposalOperationSchema.parse({ ...reboundEvidence, baseline_snapshot_hash });
  }
  const task = findTaskByGid(prepared.snapshot, reboundEvidence.target.gid);
  if (task == null) {
    return proposalOperationSchema.parse({ ...reboundEvidence, baseline_snapshot_hash });
  }
  const before = rebindBeforeValue(reboundEvidence, task);
  let rebound = proposalOperationSchema.parse({
    ...reboundEvidence,
    baseline_snapshot_hash,
    before,
  });
  if (
    previous != null
    && (rebound.operation === "complete" || rebound.operation === "withdraw")
    && rebound.status_evidence.kind === "task_or_note_explicit"
    && rebound.status_evidence.reference.kind === "task"
  ) {
    const reference = rebound.status_evidence.reference;
    const statusOperation = rebound.operation;
    const previousSource = [...previous.source_map.values()].find((source) =>
      source.kind === "task_notes"
      && source.task_gid === task.gid
      && createStatusEvidenceLocator(source.source_id, statusOperation, task.gid)
        === reference.locator);
    const currentSource = prepared.source_map.get(
      createTaskNotesSourceId(
        prepared.user_message_source_id.slice("user-message:".length),
        task.gid,
      ),
    );
    if (
      previousSource?.kind === "task_notes"
      && currentSource?.kind === "task_notes"
      && verifiedSourceExcerpt(previousSource, reference.excerpt) != null
      && verifiedSourceExcerpt(currentSource, reference.excerpt) != null
    ) {
      rebound = proposalOperationSchema.parse({
        ...rebound,
        status_evidence: {
          ...rebound.status_evidence,
          reference: { ...reference, locator: currentSource.source_id },
        },
      });
    }
  }
  return rebound;
}

function rebindInitialProposal(
  proposal: Proposal | undefined,
  prepared: PreparedTurn,
  previous: StoredProposal | undefined,
): Proposal | undefined {
  if (proposal == null) {
    return undefined;
  }
  return proposalSchema.parse({
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map((operation) =>
        rebindInitialOperation(operation, prepared, previous)),
    })),
  });
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
  const durationIssues = proposal.groups.flatMap((group, groupIndex) =>
    group.operations.flatMap((operation, operationIndex) =>
      operation.operation === "create_task" && operation.after.duration == null
        ? [{
            code: "create_task_duration_required",
            json_pointer: `/groups/${groupIndex}/operations/${operationIndex}/after/duration`,
            message: "新規タスクの所要時間を指定してください。",
            group_id: group.group_id,
            operation_id: operation.operation_id,
          }]
        : []));
  if (durationIssues.length > 0) {
    return { kind: "invalid", issues: durationIssues };
  }
  let bound: BoundProposalEvidence;
  try {
    bound = bindProposalEvidence(proposal, prepared, workspaceCandidateDigest(proposal));
  } catch (error: unknown) {
    if (error instanceof AiWorkflowRetryableFailureError) {
      return { kind: "invalid", issues: workspaceValidationIssues(error.issues) };
    }
    throw error;
  }
  const stored = createStoredProposal("workspace-validation", bound, prepared);
  const issues = proposalValidationIssues(stored);
  return issues.length === 0
    ? { kind: "valid", proposal: bound.proposal, value: null }
    : { kind: "invalid", issues: workspaceValidationIssues(issues) };
}

function createPendingWithdrawConfirmationCommit(
  pending: PendingWithdrawConfirmation | undefined,
): PendingWithdrawConfirmationCommit {
  if (pending == null) {
    return { kind: "clear" };
  }
  return { kind: "set", value: pending };
}

function assertTaskctlSnapshotMatchesBaseline(
  snapshot: AiWorkflowSnapshot,
  baseline: BaselineSnapshot,
  taskctlSnapshot: TaskctlSnapshot,
): void {
  if (
    taskctlSnapshot.sync.kind !== "synced"
    || taskctlSnapshot.sync.synced_at !== snapshot.synced_at
  ) {
    throw new AiWorkflowSyncError(new Error("taskctlの同期時点が基準スナップショットと一致しません。"));
  }
  const taskctlBaseline = baselineSnapshotSchema.parse({
    app_version: snapshot.app_version,
    project_gid: snapshot.project_gid,
    as_of: snapshot.as_of,
    tasks: createBaselineTaskSnapshots(taskctlSnapshot.tasks),
  });
  if (
    canonicalizeJson(taskctlBaseline.tasks)
    !== canonicalizeJson(baseline.tasks)
  ) {
    throw new AiWorkflowSyncError(new Error("taskctlのタスク状態が基準スナップショットと一致しません。"));
  }
}

function operationMap(proposal: Proposal): Map<string, ProposalOperation> {
  const operations = new Map<string, ProposalOperation>();
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (operations.has(operation.operation_id)) {
        throw new AiWorkflowError("変更案のoperation_idが重複しています。");
      }
      operations.set(operation.operation_id, operation);
    }
  }
  return operations;
}

function projectTasks(
  snapshot: AiWorkflowSnapshot,
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
): RankingTask[] {
  const projectTaskValues = createTaskProjector({
    parseTask: (value) => taskSchema.parse(value),
    parseDependencies: (value) => dependenciesSchema.parse(value),
    parseObsidianLinks: (value) => obsidianLinksSchema.parse(value),
    WorkflowError: AiWorkflowError,
  });
  return normalizeTasksForRanking(projectTaskValues(snapshot, proposal, selectedOperationIds));
}

function normalizeTasksForRanking(tasks: readonly Task[]): RankingTask[] {
  return normalizeRankingTasks<Task, ReturnType<typeof normalizeTaskGraph>["tasks"][number]>(tasks, {
    normalizeTaskGraph,
    WorkflowError: AiWorkflowError,
  });
}

function collectDirectTargetGids(
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const gids = new Set<string>();
  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (!selectedOperationIds.has(operation.operation_id)) {
        continue;
      }
      if (operation.operation === "create_task") {
        gids.add(projectedTemporaryGid(operation.temporary_ref));
      } else {
        gids.add(projectedTargetGid(operation.target));
      }
    }
  }
  return gids;
}

/** 選択済み変更案をアプリ側順位計算へ投影して影響を返します。 */
export function calculateWorkflowImpact(
  snapshot: AiWorkflowSnapshot,
  proposal: Proposal,
  selectedOperationIds: readonly string[],
): AiWorkflowImpact {
  const calculate = createImpactCalculator({
    snapshotSchema: aiWorkflowSnapshotSchema,
    proposalSchema,
    identifierSchema,
    parseImpact: (value) => aiWorkflowImpactSchema.parse(value),
    operationMap,
    normalizeTasksForRanking,
    projectTasks,
    calculateTaskRanking,
    collectDirectTargetGids,
    SelectionError: AiWorkflowSelectionError,
  });
  return calculate(snapshot, proposal, selectedOperationIds);
}

function revalidateProposal(
  proposal: Proposal,
  stored: StoredProposal,
): { readonly basic: ProposalValidationResult; readonly graph: GraphValidationResult } {
  return validateStoredProposal(proposal, stored, {
    validateBasic: validateProposal,
    validateGraph: validateProposalGraph,
  });
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
  const selected = [...input.selected_operation_ids];
  return aiWorkflowProposalViewSchema.parse({
    proposal_id: identifierSchema.parse(input.proposal_id),
    baseline_snapshot_hash: input.baseline_snapshot_hash,
    proposal: sanitizeProposalForRenderer(input.proposal,
      (value) => proposalSchema.parse(value), (value) => proposalOperationSchema.parse(value)),
    basic_validation: toWorkflowValidation(input.basic_validation),
    graph_validation: toWorkflowValidation(input.graph_validation),
    selected_operation_ids: selected,
    impact: calculateWorkflowImpact(input.snapshot, input.proposal, selected),
  });
}

function createProposalView(stored: StoredProposal): AiWorkflowProposalView {
  return createWorkflowProposalView({
    proposal_id: stored.proposal_id,
    proposal: stored.proposal,
    snapshot: stored.snapshot,
    baseline_snapshot_hash: stored.baseline_snapshot_hash,
    basic_validation: stored.basic_validation,
    graph_validation: stored.graph_validation,
    selected_operation_ids: stored.selected_operation_ids,
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

function hashValidationIssues(issues: readonly unknown[]): string {
  return createHash("sha256").update(canonicalizeJson(issues)).digest("hex");
}

function createValidationErrorsDocument(
  attempt: number,
  failure: AiWorkflowRetryableFailureError,
  previousDigest: AiWorkflowPreviousDigest,
): AiWorkflowValidationErrors {
  return buildValidationErrorsDocument(attempt, failure, previousDigest, {
    hashIssues: hashValidationIssues,
    parseValidationErrors: (value) => aiWorkflowValidationErrorsSchema.parse(value),
    parseRetryLogEvent: (value) => aiWorkflowRetryLogEventSchema.parse(value),
    maximumRetryAttempts: aiWorkflowMaximumRetryAttempts,
    errorProjection: {
      projectionSchema: aiWorkflowSafeErrorProjectionSchema,
      isRetryableFailure: (error) => error instanceof AiWorkflowRetryableFailureError,
      isOutputValidationFailure: (error) => error instanceof CodexSessionOutputValidationError,
      redactSensitiveText,
    },
  });
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
    previousDigest, retryDecision, {
      hashIssues: hashValidationIssues,
      parseValidationErrors: (value) => aiWorkflowValidationErrorsSchema.parse(value),
      parseRetryLogEvent: (value) => aiWorkflowRetryLogEventSchema.parse(value),
      maximumRetryAttempts: aiWorkflowMaximumRetryAttempts,
      errorProjection: {
        projectionSchema: aiWorkflowSafeErrorProjectionSchema,
        isRetryableFailure: (error) => error instanceof AiWorkflowRetryableFailureError,
        isOutputValidationFailure: (error) => error instanceof CodexSessionOutputValidationError,
        redactSensitiveText,
      },
    });
}

function proposalValidationIssues(stored: StoredProposal): AiWorkflowValidationIssue[] {
  return collectProposalValidationIssues(stored, {
    parseIssue: (value) => aiWorkflowValidationIssueSchema.parse(value),
    parseDetailCode: (value) => aiWorkflowValidationDetailCodeSchema.parse(value),
  });
}

function requirePreparedTurn(state: PreparedTurnState): PreparedTurn {
  switch (state.kind) {
    case "ready":
      return state.value;
    case "pending":
      throw new AiWorkflowSyncError(new Error("同期後の基準値が作成されませんでした。"));
  }
}

function safelyLogRetryEvent(
  logRetryEvent: AiWorkflowOptions["logRetryEvent"],
  event: AiWorkflowRetryLogEvent,
): RetryEventLogResult {
  try {
    logRetryEvent(event);
    return { kind: "succeeded" };
  } catch (error: unknown) {
    return { kind: "failed", error };
  }
}

/** AI変更案をメモリ上で検証、選択、承認するサービスです。 */
export class AiWorkflowService {
  private readonly options: AiWorkflowOptions;
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly completedEvidenceSources = new Map<string, EvidenceSource>();
  private readonly deltaListeners = new Set<CodexSessionDeltaListener>();
  private readonly removeSessionDelta: () => void;
  private listenerErrorCount = 0;
  private lifecycle: AiWorkflowLifecycle = { kind: "active" };
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
    if (this.lifecycle.kind === "disposed") {
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
    if (this.lifecycle.kind === "disposed") {
      throw new AiWorkflowStateError("AIワークフローは終了しています。");
    }
    const request = aiWorkflowTurnRequestSchema.parse(input);
    const baseProposal = request.base_proposal_id == null
      ? undefined
      : this.getStoredProposal(request.base_proposal_id);
    throwIfAborted(signal);
    this.assertProposalCapacity(request.base_proposal_id);
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
    let preparedState: PreparedTurnState = { kind: "pending" };
    await this.options.externalStatusEvidenceCollector.beginTurn(attemptId, signal);
    updateResources({ kind: "collector_active", attemptId });
    const sessionTurnResult = await this.options.session.startTurnWithPreparation(
      async (turnSignal): Promise<CodexSessionTurnInput> => {
        try {
          const rawSnapshot = await this.options.snapshotProvider(turnSignal);
          const snapshot = aiWorkflowSnapshotSchema.parse(rawSnapshot);
          const baseline = createBaselineSnapshot(snapshot);
          const baselineSnapshotHash = hashBaselineSnapshot(baseline);
          const baselineExternalData = await this.options.baselineExternalDataProvider(
            baseline,
            turnSignal,
          );
          const validatedBaselineExternalData = asanaProposalApplicationInputSchema
            .shape.baseline_external_data.parse(baselineExternalData);
          const rawTaskctlSnapshot = await this.options.taskctlSnapshotProvider(turnSignal);
          const taskctlSnapshot = taskctlSnapshotSchema.parse(rawTaskctlSnapshot);
          assertTaskctlSnapshotMatchesBaseline(snapshot, baseline, taskctlSnapshot);
          const pendingForTurn = turnGeneration === this.sessionGeneration
            && pendingWithdrawConfirmation != null
            && isPendingWithdrawConfirmationValid(snapshot, pendingWithdrawConfirmation)
            ? pendingWithdrawConfirmation
            : undefined;
          const sources = createEvidenceSourceMap(
            logicalTurnId,
            request.message,
            snapshot,
            this.completedEvidenceSources,
            pendingForTurn,
            createUserMessageSourceId,
            createTaskNotesSourceId,
            createWithdrawConfirmationSourceId,
          );
          const inheritedAliases = createInheritedEvidenceAliases(
            baseProposal,
            sources.source_map,
            snapshot,
            baseline,
          );
          const prepared: PreparedTurn = {
            snapshot,
            baseline,
            baseline_snapshot_hash: baselineSnapshotHash,
            baseline_external_data: validatedBaselineExternalData,
            taskctl_snapshot: taskctlSnapshot,
            user_message_source_id: sources.user_message_source_id,
            user_message_sources: sources.user_message_sources,
            withdraw_confirmation_source_id: sources.withdraw_confirmation_source_id,
            source_map: sources.source_map,
            pending_withdraw_confirmation: pendingForTurn,
            trusted_status_evidence: createTrustedStatusEvidence(snapshot, []),
            inherited_status_evidence_aliases: inheritedAliases.status,
            inherited_split_instruction_aliases: inheritedAliases.split,
          };
          const initialProposal = rebindInitialProposal(
            retryProposal ?? baseProposal?.proposal,
            prepared,
            baseProposal,
          );
          const workspace = new ProposalWorkspace({
            workspace_id: identifierSchema.parse(randomUUID()),
            baseline_snapshot_hash: baselineSnapshotHash,
            ...(initialProposal == null ? {} : { initial_proposal: initialProposal }),
          });
          this.options.session.freezeTaskctlSnapshot(taskctlSnapshot);
          updateResources({
            kind: "collector_active_snapshot_frozen",
            attemptId,
          });
          preparedState = { kind: "ready", value: prepared };
          workspaceState.value = workspace;
          this.options.session.activateProposalWorkspace(workspace, (proposal) => {
            const externalEvidence = trustedExternalStatusEvidenceSchema.parse(
              this.options.externalStatusEvidenceCollector.snapshotTurn(attemptId, signal),
            );
            return validateWorkspaceProposal(proposal, {
              ...prepared,
              trusted_status_evidence: createTrustedStatusEvidence(snapshot, externalEvidence),
            });
          });
          return [{
            type: "text",
            text: createTurnPrompt(
              request,
              prepared,
              workspace,
              retryPromptContext,
              {
                parseContext: (value) => aiWorkflowTurnContextSchema.parse(value),
                canonicalizeJson,
                maximumRetryAttempts: aiWorkflowMaximumRetryAttempts,
                WorkflowError: AiWorkflowError,
              },
            ),
          }];
        } catch (error: unknown) {
          if (error instanceof AiWorkflowSyncError) {
            throw error;
          }
          throw new AiWorkflowSyncError(error);
        }
      },
      signal,
    );
    const prepared = requirePreparedTurn(preparedState);
    const externalEvidence = trustedExternalStatusEvidenceSchema.parse(
      await this.options.externalStatusEvidenceCollector.finishTurn(attemptId, signal),
    );
    updateResources({ kind: "snapshot_frozen", attemptId });
    const turnPrepared = {
      ...prepared,
      trusted_status_evidence: createTrustedStatusEvidence(
        prepared.snapshot,
        externalEvidence,
      ),
    };
    const generatedResponse = sessionTurnResult.response;
    const workspace = workspaceState.value;
    if (workspace == null) {
      throw new AiWorkflowStateError("AI変更案ワークスペースが作成されませんでした。");
    }
    const validatedResponse: ValidatedGeneratedResponse = validateGeneratedResponse<
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
      const response = validatedResponse.response;
      const pending = createPendingWithdrawConfirmation(response, turnPrepared, AiWorkflowError);
      const result = aiWorkflowTurnResultSchema.parse({
        kind: "no_proposal",
        message: response.message,
        questions: createRendererQuestions(
          response.questions,
          pending,
          turnPrepared.snapshot,
          AiWorkflowError,
        ),
        pending_proposal_action: response.pending_proposal_action,
        retry_count: attempt - 1,
      });
      return {
        kind: "no_proposal",
        result,
        pendingWithdrawConfirmation: createPendingWithdrawConfirmationCommit(pending),
        prepared: turnPrepared,
      };
    }
    const { response } = validatedResponse;
    const candidateDigest = workspaceCandidateDigest(response.proposal);
    const bound = bindProposalEvidence(
      proposalSchema.parse(response.proposal),
      turnPrepared,
      candidateDigest,
    );
    const proposalId = identifierSchema.parse(randomUUID());
    const stored = createStoredProposal(proposalId, bound, turnPrepared);
    const validationIssues = proposalValidationIssues(stored);
    if (validationIssues.length > 0) {
      throw new AiWorkflowRetryableFailureError(
        validationIssues,
        candidateDigest,
        "reuse_lease",
        new AiWorkflowError("基本検証またはグラフ検証が変更案を適用可能と判定しませんでした。"),
      );
    }
    const view = createProposalView(stored);
    const result = aiWorkflowTurnResultSchema.parse({
      kind: "proposal",
      message: response.message,
      questions: createRendererQuestions(
        response.questions,
        undefined,
        turnPrepared.snapshot,
        AiWorkflowError,
      ),
      proposal: view,
      retry_count: attempt - 1,
    });
    return {
      kind: "proposal",
      result,
      pendingWithdrawConfirmation: { kind: "clear" },
      storedProposal: stored,
      replacingProposalId: request.base_proposal_id,
      prepared: turnPrepared,
    };
  }

  private commitTurn(commit: TurnCommit): AiWorkflowTurnResult {
    switch (commit.kind) {
      case "no_proposal":
        rememberSuccessfulTurnEvidence(
          this.completedEvidenceSources,
          commit.prepared,
        );
        break;
      case "proposal":
        this.storeProposal(commit.storedProposal, commit.replacingProposalId);
        rememberSuccessfulTurnEvidence(
          this.completedEvidenceSources,
          commit.prepared,
        );
        break;
    }
    switch (commit.pendingWithdrawConfirmation.kind) {
      case "clear":
        this.pendingWithdrawConfirmation = undefined;
        break;
      case "set":
        this.pendingWithdrawConfirmation = commit.pendingWithdrawConfirmation.value;
        break;
    }
    return commit.result;
  }

  /** 保持中の変更案を取得してRenderer向けDTOへ変換します。 */
  public getProposal(proposalId: string): AiWorkflowProposalView {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const stored = this.proposals.get(parsedProposalId);
    if (stored == null) {
      throw new AiWorkflowProposalNotFoundError();
    }
    return createProposalView(stored);
  }

  /** 変更案の選択状態を更新してRenderer向けDTOを返します。 */
  public select(input: AiWorkflowSelectionRequest): AiWorkflowProposalView {
    const request = aiWorkflowSelectionRequestSchema.parse(input);
    const stored = this.getStoredProposal(request.proposal_id);
    const selectedOperationIds = resolveSelectedOperationIds(stored, request.selection);
    assertSelectedProposalGraphIsSafe(stored, selectedOperationIds);
    const updated: StoredProposal = {
      ...stored,
      selected_operation_ids: [...selectedOperationIds],
    };
    this.proposals.set(stored.proposal_id, updated);
    return createProposalView(updated);
  }

  /** 変更案の操作後値だけを利用者編集して再検証します。 */
  public editOperation(input: AiWorkflowOperationEdit): AiWorkflowProposalView {
    const request = aiWorkflowOperationEditSchema.parse(input);
    const stored = this.getStoredProposal(request.proposal_id);
    const edited = editStoredProposal(request, stored, {
      operationMap,
      parseOperation: (value) => proposalOperationSchema.parse(value),
      parseProposal: (value) => proposalSchema.parse(value),
      revalidate: revalidateProposal,
      preserveSelection,
      assertGraphSafe: assertSelectedProposalGraphIsSafe,
      EditError: AiWorkflowEditError,
    });
    const updated: StoredProposal = { ...stored, ...edited };
    this.proposals.set(updated.proposal_id, updated);
    return createProposalView(updated);
  }

  /** 変更案をメモリから破棄します。 */
  public rejectProposal(proposalId: string): void {
    const parsedProposalId = identifierSchema.parse(proposalId);
    if (!this.proposals.delete(parsedProposalId)) {
      throw new AiWorkflowProposalNotFoundError();
    }
  }

  /** オンライン再取得後に選択済み変更案をAsanaへ適用します。 */
  public async approve(
    input: AiWorkflowApprovalRequest,
    signal: AbortSignal,
  ): Promise<AiWorkflowApprovalResult> {
    const request = aiWorkflowApprovalRequestSchema.parse(input);
    throwIfAborted(signal);
    const stored = this.getStoredProposal(request.proposal_id);
    const selectedOperationIds = resolveSelectedOperationIds(stored, request.selection);
    assertSelectedProposalGraphIsSafe(stored, selectedOperationIds);
    if (this.options.isOnline() !== true) {
      throw new AiWorkflowOfflineError();
    }
    const approvalInput = await this.options.prepareApprovalInput(
      createApprovalPreparationInput(stored, selectedOperationIds),
      signal,
    );
    const validatedInput = asanaProposalApplicationInputSchema.parse(approvalInput);
    assertApprovalInputMatchesStored(validatedInput, stored, selectedOperationIds, {
      canonicalizeJson,
      createBaselineTaskSnapshots,
      WorkflowError: AiWorkflowError,
    });
    if (this.options.isOnline() !== true) {
      throw new AiWorkflowOfflineError();
    }
    const application = asanaProposalApplicationResultSchema.parse(
      await this.options.applicationCoordinator.apply(validatedInput, signal),
    );
    if (application.proposal_id !== stored.proposal_id) {
      throw new AiWorkflowError("適用結果の変更案IDが一致しません。");
    }
    const result = aiWorkflowApprovalResultSchema.parse({
      proposal_id: stored.proposal_id,
      application: createApplicationSummary(application),
    });
    this.proposals.delete(stored.proposal_id);
    return result;
  }

  /** AIワークフローの購読と保持中変更案を終了時に破棄します。 */
  public dispose(): void {
    if (this.lifecycle.kind === "disposed") {
      return;
    }
    this.removeSessionDelta();
    this.options.session.releaseTaskctlSnapshot();
    this.deltaListeners.clear();
    this.proposals.clear();
    this.completedEvidenceSources.clear();
    this.pendingWithdrawConfirmation = undefined;
    this.sessionGeneration += 1;
    this.lifecycle = { kind: "disposed" };
  }

  private getStoredProposal(proposalId: string): StoredProposal {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const stored = this.proposals.get(parsedProposalId);
    if (stored == null) {
      throw new AiWorkflowProposalNotFoundError();
    }
    return stored;
  }

  private storeProposal(stored: StoredProposal, replacingProposalId: string | undefined): void {
    if (this.proposals.has(stored.proposal_id)) {
      throw new AiWorkflowError("同じ変更案IDを重複して保持できません。");
    }
    this.assertProposalCapacity(replacingProposalId);
    this.proposals.set(stored.proposal_id, stored);
  }

  private assertProposalCapacity(replacingProposalId: string | undefined): void {
    if (
      this.proposals.size >= maximumWorkflowProposals
      && (replacingProposalId == null || !this.proposals.has(replacingProposalId))
    ) {
      throw new AiWorkflowStateError(
        "保持中の変更案が上限に達しています。新しい変更案を作る前に既存案を承認または却下してください。",
      );
    }
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
