import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
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
  type ProposalWorkspaceIssue,
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
  type NormalizationTask,
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
  type AsanaProposalApplicationResult,
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
import { createSafeErrorProjection } from "../../application/proposal-generate/retry-error-projection";
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
import { createImpactCalculator } from "../../application/proposal-generate/impact-ranking";
import { createTaskProjector, projectedTemporaryGid, projectedTargetGid } from "../../application/proposal-generate/task-projection";
import {
  createTurnPrompt,
  createPendingWithdrawConfirmation,
  createRendererQuestions,
} from "../../application/proposal-generate/turn-prompt";
import {
  createEvidenceSourceMap,
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

type WorkflowValidation = {
  readonly operations: readonly {
    readonly kind: "valid" | "invalid";
    readonly group_id: string;
    readonly operation_id: string;
    readonly errors?: readonly { readonly code: string; readonly message: string }[];
  }[];
  readonly groups: readonly {
    readonly group_id: string;
    readonly atomic: boolean;
    readonly applicable: boolean;
    readonly operation_ids: readonly string[];
  }[];
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

type AttemptResourceState =
  | { readonly kind: "inactive" }
  | { readonly kind: "collector_active"; readonly attemptId: string }
  | {
      readonly kind: "collector_active_snapshot_frozen";
      readonly attemptId: string;
    }
  | { readonly kind: "snapshot_frozen"; readonly attemptId: string };

type AttemptExecution =
  | { readonly kind: "succeeded"; readonly commit: TurnCommit }
  | { readonly kind: "failed"; readonly error: unknown };

type TurnRetryState =
  | { readonly kind: "initial" }
  | {
      readonly kind: "pending";
      readonly failure: AiWorkflowRetryableFailureError;
      readonly previousDigest: AiWorkflowPreviousDigest;
      readonly validationErrors: AiWorkflowValidationErrors;
      readonly retryProposal: Proposal | undefined;
      readonly failedAttempt: number;
    };

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

const sessionPortSchema = z.custom<AiWorkflowSessionPort>(
  (value) => {
    if (typeof value !== "object" || value == null) {
      return false;
    }
    return [
      "startTurnWithPreparation",
      "freezeTaskctlSnapshot",
      "releaseTaskctlSnapshot",
      "activateProposalWorkspace",
      "onDelta",
    ].every((name) => typeof Reflect.get(value, name) === "function");
  },
  "AIセッション境界が不正です。",
);

const snapshotProviderSchema = z.custom<AiWorkflowSnapshotProvider>(
  (value) => typeof value === "function",
  "AIスナップショット供給関数が必要です。",
);

const taskctlSnapshotProviderSchema = z.custom<AiWorkflowTaskctlSnapshotProvider>(
  (value) => typeof value === "function",
  "taskctlスナップショット供給関数が必要です。",
);

const baselineExternalDataProviderSchema = z.custom<AiWorkflowBaselineExternalDataProvider>(
  (value) => typeof value === "function",
  "基準Custom external data供給関数が必要です。",
);

const externalStatusEvidenceCollectorSchema = z.custom<
  AiWorkflowExternalStatusEvidenceCollector
>(
  (value) => typeof value === "object"
    && value != null
    && ["beginTurn", "snapshotTurn", "finishTurn", "cancelTurn"].every(
      (name) => typeof Reflect.get(value, name) === "function",
    ),
  "外部状態根拠収集境界が必要です。",
);

const trustedExternalStatusEvidenceSchema = z
  .array(
    z
      .object({
        kind: z.literal("external_tool"),
        locator: z.string().refine((value) => value.trim().length > 0, {
          message: "外部状態根拠locatorを空にできません。",
        }),
        target_task_gid: gidSchema,
        status: z.enum(["closed", "completed", "cancelled"]),
      })
      .strict(),
  )
  .max(256)
  .superRefine((references, context) => {
    const seen = new Set<string>();
    references.forEach((reference, index) => {
      if (seen.has(reference.locator)) {
        context.addIssue({
          code: "custom",
          path: [index, "locator"],
          message: "外部状態根拠locatorを重複指定できません。",
        });
        return;
      }
      seen.add(reference.locator);
    });
  });

const applicationCoordinatorSchema = z.custom<
  Pick<AsanaProposalApplicationCoordinator, "apply">
>(
  (value) => typeof value === "object"
    && value != null
    && typeof Reflect.get(value, "apply") === "function",
  "Asana適用コーディネータが必要です。",
);

const approvalInputProviderSchema = z.custom<AiWorkflowApprovalInputProvider>(
  (value) => typeof value === "function",
  "承認入力供給関数が必要です。",
);

const onlineStateProviderSchema = z.custom<AiWorkflowOnlineStateProvider>(
  (value) => typeof value === "function",
  "オンライン状態供給関数が必要です。",
);

const retryEventLoggerSchema = z.custom<AiWorkflowOptions["logRetryEvent"]>(
  (value) => typeof value === "function",
  "AI変更案の再試行ログ関数が必要です。",
);

const aiWorkflowOptionsSchema = z
  .object({
    sessionId: identifierSchema,
    session: sessionPortSchema,
    snapshotProvider: snapshotProviderSchema,
    taskctlSnapshotProvider: taskctlSnapshotProviderSchema,
    baselineExternalDataProvider: baselineExternalDataProviderSchema,
    externalStatusEvidenceCollector: externalStatusEvidenceCollectorSchema,
    applicationCoordinator: applicationCoordinatorSchema,
    prepareApprovalInput: approvalInputProviderSchema,
    isOnline: onlineStateProviderSchema,
    logRetryEvent: retryEventLoggerSchema,
  })
  .strict();

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

function createTaskSnapshot(task: Task): TaskSnapshot {
  const base = {
    gid: task.gid,
    title: task.title,
    notes: task.notes,
    status: task.status,
    importance: task.importance,
    area: task.area,
    block_state: task.block_state,
    parent_work_mode: task.parent_work_mode,
    section_gid: task.section_gid,
    completed: task.completed,
    tags: task.tags,
    child_gids: task.child_gids,
    dependencies: task.dependencies,
    obsidian_links: task.obsidian_links,
    activity_anchor_on: task.activity_anchor_on,
  };
  const withDue = task.due_on != null
    ? { ...base, due_on: task.due_on }
    : task.due_at != null
      ? { ...base, due_at: task.due_at }
      : base;
  const withDuration = task.duration == null
    ? withDue
    : { ...withDue, duration: task.duration };
  if (task.parent_gid != null) {
    return { ...withDuration, parent_gid: task.parent_gid };
  }
  return withDuration;
}

function createBaselineTaskSnapshots(tasks: readonly Task[]): TaskSnapshot[] {
  return tasks
    .map(createTaskSnapshot)
    .sort((left, right) => compareStrings(left.gid, right.gid));
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
  const splitReferences = new Map<string, ExplicitSplitRequestReference>();
  const trustedReferences = new Map<string, TrustedStatusEvidenceReference>();
  const failures: {
    readonly issue: AiWorkflowValidationIssue;
    readonly error: unknown;
  }[] = [];
  for (const reference of prepared.trusted_status_evidence) {
    trustedReferences.set(`${reference.kind}\u0000${reference.locator}`, reference);
  }
  const groups = proposal.groups.map((group, groupIndex) => ({
    ...group,
    operations: group.operations.map((operation, operationIndex) => {
      let bound: ReturnType<typeof bindProposalOperationEvidence>;
      try {
        bound = bindProposalOperationEvidence(operation, prepared);
      } catch (error: unknown) {
        failures.push({
          issue: aiWorkflowValidationIssueSchema.parse({
            phase: "evidence_binding",
            code: "evidence_binding_invalid",
            json_pointer: `/groups/${groupIndex}/operations/${operationIndex}`,
            group_id: group.group_id,
            operation_id: operation.operation_id,
          }),
          error,
        });
        return operation;
      }
      if (bound.split_reference != null) {
        const reference = bound.split_reference;
        const parent = reference.parent.kind === "existing"
          ? `existing:${reference.parent.gid}`
          : `temporary:${reference.parent.ref}`;
        splitReferences.set(
          `${parent}\u0000${reference.locator}\u0000${reference.excerpt}`,
          reference,
        );
      }
      if (bound.trusted_reference != null) {
        const reference = bound.trusted_reference;
        trustedReferences.set(`${reference.kind}\u0000${reference.locator}`, reference);
      }
      return bound.operation;
    }),
  }));
  if (failures.length > 0) {
    const firstFailure = failures[0];
    if (firstFailure == null) {
      throw new Error("根拠検証エラーを取得できません。");
    }
    throw new AiWorkflowRetryableFailureError(
      failures.map((failure) => failure.issue),
      candidateDigest,
      "reuse_lease",
      new AggregateError(
        failures.map((failure) => failure.error),
        "変更案の根拠を現在の会話へ結び付けられません。",
        { cause: firstFailure.error },
      ),
    );
  }
  return {
    proposal: proposalSchema.parse({ ...proposal, groups }),
    explicit_split_request_references: [...splitReferences.values()],
    trusted_status_evidence: trustedStatusEvidenceReferencesSchema.parse(
      [...trustedReferences.values()],
    ),
  };
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
  let before: unknown = reboundEvidence.before;
  switch (reboundEvidence.operation) {
    case "update_title":
      before = task.title;
      break;
    case "update_notes":
      before = task.notes;
      break;
    case "set_status":
    case "complete":
    case "withdraw":
      if (reboundEvidence.operation === "set_status"
        || task.status === "not_started" || task.status === "in_progress") {
        before = task.status;
      }
      break;
    case "set_importance":
      before = task.importance;
      break;
    case "set_due":
    case "clear_due":
      if (task.due_on != null) {
        before = { kind: "due_on", due_on: task.due_on };
      } else if (task.due_at != null) {
        before = { kind: "due_at", due_at: task.due_at };
      } else if (reboundEvidence.operation === "set_due") {
        before = { kind: "absent" };
      }
      break;
    case "set_duration":
    case "clear_duration":
      if (task.duration != null) {
        before = task.duration;
      } else if (reboundEvidence.operation === "set_duration") {
        before = { kind: "absent" };
      }
      break;
    case "set_area":
      before = task.area;
      break;
    case "set_dependencies":
      before = task.dependencies.map((dependency) => ({
        target: { kind: "existing", gid: dependency.task_gid },
        scope: dependency.scope,
        source: dependency.source,
      }));
      break;
    case "set_parent":
      before = task.parent_gid == null
        ? { kind: "absent" }
        : { kind: "existing", gid: task.parent_gid };
      break;
    case "set_parent_work_mode":
      before = task.parent_work_mode;
      break;
    case "link_obsidian":
      break;
    case "unlink_obsidian":
      before = task.obsidian_links.find((link) =>
        link.vault_id === reboundEvidence.before.vault_id
        && link.path === reboundEvidence.before.path) ?? reboundEvidence.before;
      break;
  }
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

function readWorkspaceProposal(workspace: ProposalWorkspace): Proposal {
  const status = workspace.getStatus();
  let offset = 0;
  let content = "";
  while (true) {
    const chunk = workspace.read({
      workspace_id: status.workspace_id,
      revision: status.revision,
      target: { kind: "proposal" },
      offset,
    });
    content += chunk.content;
    if (chunk.next_offset == null) {
      return proposalSchema.parse(JSON.parse(content));
    }
    offset = chunk.next_offset;
  }
}

function workspaceValidationIssues(
  issues: readonly AiWorkflowValidationIssue[],
): ProposalWorkspaceIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    json_pointer: issue.json_pointer,
    message: `変更案の検証に失敗しました。${issue.validator_code ?? issue.code}`,
    ...(issue.group_id == null ? {} : { group_id: issue.group_id }),
    ...(issue.operation_id == null ? {} : { operation_id: issue.operation_id }),
  }));
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

function toWorkflowValidation(
  result: ProposalValidationResult | GraphValidationResult,
): WorkflowValidation {
  return {
    operations: result.operations.map((operation) => {
      if (operation.kind === "valid") {
        return {
          kind: "valid",
          group_id: operation.group_id,
          operation_id: operation.operation_id,
        };
      }
      return {
        kind: "invalid",
        group_id: operation.group_id,
        operation_id: operation.operation_id,
        errors: operation.errors.map((error) => ({
          code: error.code,
          message: error.message,
        })),
      };
    }),
    groups: result.groups.map((group) => ({
      group_id: group.group_id,
      atomic: group.atomic,
      applicable: group.applicable,
      operation_ids: [...group.operation_ids],
    })),
  };
}

function sanitizeEvidenceReference(reference: {
  readonly kind: string;
  readonly locator: string;
  readonly excerpt?: string | undefined;
}, includeExcerpt: boolean): Record<string, string> {
  const base = { kind: reference.kind, locator: reference.locator };
  if (!includeExcerpt || reference.excerpt == null) {
    return base;
  }
  return { ...base, excerpt: reference.excerpt };
}

function sanitizeProposalOperation(operation: ProposalOperation): ProposalOperation {
  const candidate: Record<string, unknown> = {
    ...operation,
    evidence_refs: operation.evidence_refs.map((reference) =>
      sanitizeEvidenceReference(reference, reference.kind === "external_review")),
  };
  if (operation.operation === "create_task" && operation.creation.kind === "split_child") {
    candidate.creation = {
      ...operation.creation,
      instruction_reference: sanitizeEvidenceReference(
        operation.creation.instruction_reference,
        true,
      ),
    };
  }
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    candidate.status_evidence = {
      ...operation.status_evidence,
      reference: sanitizeEvidenceReference(
        operation.status_evidence.reference,
        operation.status_evidence.kind === "user_explicit"
          || (
            operation.status_evidence.kind === "task_or_note_explicit"
            && operation.status_evidence.reference.kind === "task"
          )
          || operation.status_evidence.kind === "external_review_explicit",
      ),
    };
  }
  return proposalOperationSchema.parse(candidate);
}

function sanitizeProposalForRenderer(proposal: Proposal): Proposal {
  return proposalSchema.parse({
    ...proposal,
    groups: proposal.groups.map((group) => ({
      ...group,
      operations: group.operations.map(sanitizeProposalOperation),
    })),
  });
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

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
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
  const normalizationTasks: NormalizationTask[] = tasks.map((task) => {
    const base = {
      gid: task.gid,
      status: task.status,
      dependencies: task.dependencies,
      child_gids: task.child_gids,
      parent_work_mode: task.parent_work_mode,
    };
    if (task.parent_gid == null) {
      return base;
    }
    return { ...base, parent_gid: task.parent_gid };
  });
  const normalized = normalizeTaskGraph({ tasks: normalizationTasks });
  const normalizedByGid = new Map(normalized.tasks.map((task) => [task.gid, task]));
  return tasks.map((task) => {
    const state = normalizedByGid.get(task.gid);
    if (state == null) {
      throw new AiWorkflowError(`順位計算用のタスク ${task.gid} を正規化できません。`);
    }
    return {
      ...task,
      block_state: state.block_state,
      dependency_cycle: state.dependency_cycle,
      parent_cycle: state.parent_cycle,
      completion_confirmation: state.completion_confirmation,
    };
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
): {
  readonly basic: ProposalValidationResult;
  readonly graph: GraphValidationResult;
} {
  const basic = validateProposal({
    proposal,
    baseline_snapshot_hash: stored.baseline_snapshot_hash,
    managed_tasks: stored.snapshot.tasks,
    existing_areas: stored.snapshot.areas,
    explicit_split_request_references: [...stored.explicit_split_request_references],
    trusted_status_evidence: [...stored.trusted_status_evidence],
  });
  const graph = validateProposalGraph({
    proposal,
    managed_tasks: stored.snapshot.tasks,
    basic_validation_result: basic,
  });
  return { basic, graph };
}

function createStoredProposal(
  proposalId: string,
  bound: BoundProposalEvidence,
  prepared: PreparedTurn,
): StoredProposal {
  const basic = validateProposal({
    proposal: bound.proposal,
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    managed_tasks: prepared.snapshot.tasks,
    existing_areas: prepared.snapshot.areas,
    explicit_split_request_references: [...bound.explicit_split_request_references],
    trusted_status_evidence: [...bound.trusted_status_evidence],
  });
  const graph = validateProposalGraph({
    proposal: bound.proposal,
    managed_tasks: prepared.snapshot.tasks,
    basic_validation_result: basic,
  });
  return {
    proposal_id: proposalId,
    proposal: bound.proposal,
    snapshot: prepared.snapshot,
    baseline: prepared.baseline,
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    baseline_external_data: prepared.baseline_external_data,
    basic_validation: basic,
    graph_validation: graph,
    selected_operation_ids: eligibleOperationIds(bound.proposal, graph),
    explicit_split_request_references: [...bound.explicit_split_request_references],
    trusted_status_evidence: [...bound.trusted_status_evidence],
    source_map: prepared.source_map,
  };
}

function rememberSuccessfulTurnEvidence(
  completedEvidenceSources: Map<string, EvidenceSource>,
  prepared: PreparedTurn,
): void {
  const source = prepared.source_map.get(prepared.user_message_source_id);
  if (source == null || source.kind !== "user_message") {
    throw new Error("成功したターンのユーザー原文を取得できません。");
  }
  const confirmationSourceId = prepared.withdraw_confirmation_source_id;
  if (confirmationSourceId == null) {
    completedEvidenceSources.set(source.source_id, source);
    return;
  }
  const confirmationSource = prepared.source_map.get(confirmationSourceId);
  if (
    confirmationSource == null
    || confirmationSource.kind !== "withdraw_confirmation"
  ) {
    throw new Error("成功したターンの確認原文を取得できません。");
  }
  completedEvidenceSources.set(source.source_id, source);
  completedEvidenceSources.set(confirmationSource.source_id, confirmationSource);
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
    proposal: sanitizeProposalForRenderer(input.proposal),
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

function createApplicationSummary(
  result: AsanaProposalApplicationResult,
): AiWorkflowApprovalResult["application"] {
  const operations = result.operations.map((operation) => {
    const base = {
      group_id: operation.group_id,
      operation_id: operation.operation_id,
      outcome: operation.outcome,
      reason_code: operation.reason_code,
    };
    if (operation.task_gid == null) {
      return base;
    }
    return { ...base, task_gid: operation.task_gid };
  });
  const groups = result.groups.map((group) => ({
    group_id: group.group_id,
    atomic: group.atomic,
    outcome: group.outcome,
    operation_ids: [...group.operation_ids],
  }));
  return {
    outcome: result.outcome,
    operations,
    groups,
  };
}

function sameSortedIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSorted = [...left].sort(compareStrings);
  const rightSorted = [...right].sort(compareStrings);
  return sameStringArray(leftSorted, rightSorted);
}

function jsonPointer(path: readonly PropertyKey[]): string {
  const secretLikeFieldName = /(?:password|token|secret|credential|authorization|api[_-]?key)/iu;
  const segments = path.map((segment) => {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0) {
      return String(segment);
    }
    if (
      typeof segment !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/u.test(segment)
      || secretLikeFieldName.test(segment)
    ) {
      return "unknown_field";
    }
    return segment.replaceAll("~", "~0").replaceAll("/", "~1");
  });
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}

function zodIssueCode(code: string): string {
  const parsed = aiWorkflowZodIssueCodeSchema.safeParse(code);
  return parsed.success ? parsed.data : "other";
}

function createStructuredOutputFailure(
  error: CodexSessionOutputValidationError,
  candidateDigest: AiWorkflowCandidateDigest,
): AiWorkflowRetryableFailureError {
  const cause = error.cause;
  const issues = cause instanceof z.ZodError
    ? cause.issues.map((issue) => aiWorkflowValidationIssueSchema.parse({
        phase: "structured_output",
        code: "structured_output_invalid",
        json_pointer: jsonPointer(issue.path),
        validator_code: zodIssueCode(issue.code),
      }))
    : [];
  return new AiWorkflowRetryableFailureError(
    issues.length === 0
      ? [aiWorkflowValidationIssueSchema.parse({
          phase: "structured_output",
          code: "structured_output_invalid",
          json_pointer: "",
        })]
      : issues,
    candidateDigest,
    "reuse_lease",
    error,
  );
}

function previousDigestFromCandidate(
  digest: AiWorkflowCandidateDigest,
): AiWorkflowPreviousDigest {
  return digest.kind === "available"
    ? { kind: "available", sha256: digest.sha256 }
    : { kind: "unavailable", reason: "candidate_unavailable" };
}

function isCandidateUnchanged(
  digest: AiWorkflowCandidateDigest,
  previousDigest: AiWorkflowPreviousDigest,
): boolean {
  return digest.kind === "available"
    && previousDigest.kind === "available"
    && digest.sha256 === previousDigest.sha256;
}

function requirePreparedTurn(state: PreparedTurnState): PreparedTurn {
  switch (state.kind) {
    case "ready":
      return state.value;
    case "pending":
      throw new AiWorkflowSyncError(new Error("同期後の基準値が作成されませんでした。"));
  }
}

function createValidationErrorsDocument(
  attempt: number,
  failure: AiWorkflowRetryableFailureError,
  previousDigest: AiWorkflowPreviousDigest,
): AiWorkflowValidationErrors {
  const fingerprint = createHash("sha256")
    .update(canonicalizeJson(failure.issues))
    .digest("hex");
  return aiWorkflowValidationErrorsSchema.parse({
    attempt,
    max_attempts: aiWorkflowMaximumRetryAttempts,
    candidate_sha256: failure.candidateDigest,
    previous_sha256: previousDigest,
    candidate_unchanged: isCandidateUnchanged(
      failure.candidateDigest,
      previousDigest,
    ),
    error_fingerprint: fingerprint,
    errors: failure.issues,
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
  const primaryIssue = failure.issues[0];
  if (primaryIssue == null) {
    throw new Error("再試行ログに検証エラーがありません。");
  }
  return aiWorkflowRetryLogEventSchema.parse({
    severity,
    session_id: sessionId,
    logical_turn_id: logicalTurnId,
    attempt,
    max_attempts: aiWorkflowMaximumRetryAttempts,
    phase: primaryIssue.phase,
    code: primaryIssue.code,
    candidate_sha256: failure.candidateDigest,
    previous_sha256: previousDigest,
    candidate_unchanged: isCandidateUnchanged(
      failure.candidateDigest,
      previousDigest,
    ),
    error_fingerprint: createHash("sha256")
      .update(canonicalizeJson(failure.issues))
      .digest("hex"),
    json_pointers: failure.issues.map((issue) => issue.json_pointer),
    retry_decision: retryDecision,
    cause: createSafeErrorProjection(failure, {
      projectionSchema: aiWorkflowSafeErrorProjectionSchema,
      isRetryableFailure: (error) => error instanceof AiWorkflowRetryableFailureError,
      isOutputValidationFailure: (error) => error instanceof CodexSessionOutputValidationError,
      redactSensitiveText,
    }),
  });
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

function proposalValidationIssues(stored: StoredProposal): AiWorkflowValidationIssue[] {
  const operationLocations = new Map<
    string,
    { readonly groupIndex: number; readonly operationIndex: number }
  >();
  for (const [groupIndex, group] of stored.proposal.groups.entries()) {
    for (const [operationIndex, operation] of group.operations.entries()) {
      operationLocations.set(operation.operation_id, { groupIndex, operationIndex });
    }
  }
  const issues: AiWorkflowValidationIssue[] = [];
  for (const operation of stored.basic_validation.operations) {
    if (operation.kind !== "invalid") {
      continue;
    }
    const location = operationLocations.get(operation.operation_id);
    if (location == null) {
      throw new Error("基本検証結果のoperation_idが変更案にありません。");
    }
    for (const error of operation.errors) {
      issues.push(aiWorkflowValidationIssueSchema.parse({
        phase: "basic_validation",
        code: "proposal_basic_validation_failed",
        json_pointer: `/groups/${location.groupIndex}/operations/${location.operationIndex}`,
        group_id: operation.group_id,
        operation_id: operation.operation_id,
        validator_code: aiWorkflowValidationDetailCodeSchema.parse(error.code),
      }));
    }
  }
  for (const operation of stored.graph_validation.operations) {
    if (operation.kind !== "invalid") {
      continue;
    }
    const location = operationLocations.get(operation.operation_id);
    if (location == null) {
      throw new Error("グラフ検証結果のoperation_idが変更案にありません。");
    }
    for (const error of operation.errors) {
      issues.push(aiWorkflowValidationIssueSchema.parse({
        phase: "graph_validation",
        code: "proposal_graph_validation_failed",
        json_pointer: `/groups/${location.groupIndex}/operations/${location.operationIndex}`,
        group_id: operation.group_id,
        operation_id: operation.operation_id,
        validator_code: aiWorkflowValidationDetailCodeSchema.parse(error.code),
      }));
    }
  }
  for (const [groupIndex, group] of stored.basic_validation.groups.entries()) {
    if (!group.applicable) {
      issues.push(aiWorkflowValidationIssueSchema.parse({
        phase: "applyability",
        code: "proposal_group_not_applicable",
        json_pointer: `/groups/${groupIndex}`,
        group_id: group.group_id,
      }));
    }
  }
  for (const [groupIndex, group] of stored.graph_validation.groups.entries()) {
    if (!group.applicable) {
      issues.push(aiWorkflowValidationIssueSchema.parse({
        phase: "applyability",
        code: "proposal_group_not_applicable",
        json_pointer: `/groups/${groupIndex}`,
        group_id: group.group_id,
      }));
    }
  }
  return issues;
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
    this.options = aiWorkflowOptionsSchema.parse(options);
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

  private async executeTurn(
    input: TurnExecutionInput,
  ): Promise<TurnExecutionResult> {
    let retryState: TurnRetryState = { kind: "initial" };
    try {
      for (let attempt = 1; attempt <= aiWorkflowMaximumRetryAttempts; attempt += 1) {
        throwIfAborted(input.signal);
        if (retryState.kind === "pending") {
          const logResult = safelyLogRetryEvent(
            this.options.logRetryEvent,
            createRetryLogEvent(
              "warning",
              this.options.sessionId,
              input.logicalTurnId,
              attempt,
              retryState.failure,
              retryState.previousDigest,
              "retry",
            ),
          );
          if (logResult.kind === "failed") {
            throw new AggregateError(
              [retryState.failure, logResult.error],
              "訂正再試行の警告を記録できませんでした。",
              { cause: retryState.failure },
            );
          }
        }
        const retryPromptContext: TurnRetryPromptContext = retryState.kind === "initial"
          ? { kind: "initial" }
          : {
              kind: "correction",
              validationErrors: retryState.validationErrors,
              failedAttempt: retryState.failedAttempt,
            };
        const workspaceState: { value?: ProposalWorkspace } = {};
        try {
          const commit = await this.executeTurnAttempt({
            ...input,
            retryProposal: retryState.kind === "pending"
              ? retryState.retryProposal
              : input.retryProposal,
            attempt,
            retryPromptContext,
            workspaceState,
          });
          return { kind: "succeeded", commit };
        } catch (error: unknown) {
          const responseError = error instanceof DiagnosticFailureDispositionError
            ? error.disposition.response_error
            : error;
          if (responseError instanceof CodexSessionSyncError) {
            if (error instanceof DiagnosticFailureDispositionError) {
              throw error;
            }
            throw new AiWorkflowSyncError(error);
          }
          const classification = this.classifyRetryFailure(error);
          if (classification.kind === "not_retryable") {
            throw error;
          }
          const failure = classification.failure;
          const previousDigest: AiWorkflowPreviousDigest = retryState.kind === "initial"
            ? aiWorkflowPreviousDigestSchema.parse({
                kind: "unavailable",
                reason: "not_available",
              })
            : previousDigestFromCandidate(retryState.failure.candidateDigest);
          const validationErrors = createValidationErrorsDocument(
            attempt,
            failure,
            previousDigest,
          );
          if (attempt === aiWorkflowMaximumRetryAttempts) {
            const logResult = safelyLogRetryEvent(
              this.options.logRetryEvent,
              createRetryLogEvent(
                "error",
                this.options.sessionId,
                input.logicalTurnId,
                attempt,
                failure,
                previousDigest,
                "stop",
              ),
            );
            const finalFailure = new AiWorkflowError(
              "AI変更案の訂正を3回の試行で完了できませんでした。",
              failure,
            );
            if (logResult.kind === "failed") {
              throw new AggregateError(
                [finalFailure, logResult.error],
                "AI変更案の最終検証失敗を記録できませんでした。",
                { cause: finalFailure },
              );
            }
            throw new DiagnosticFailureDispositionError({
              kind: "recorded_only",
              recorded_error: finalFailure,
              response_error: finalFailure,
            });
          }
          const workspace = workspaceState.value;
          let retryProposal: Proposal | undefined;
          if (workspace != null && workspace.getStatus().completion === "structurally_complete") {
            retryProposal = readWorkspaceProposal(workspace);
          } else if (retryState.kind === "pending") {
            retryProposal = retryState.retryProposal;
          } else {
            retryProposal = input.retryProposal;
          }
          retryState = {
            kind: "pending",
            failure,
            previousDigest,
            validationErrors,
            retryProposal,
            failedAttempt: attempt,
          };
        }
      }
      throw new Error("再試行上限を超えてAI変更案の試行が継続しました。");
    } catch (error: unknown) {
      return { kind: "failed", error };
    }
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

  private async executeTurnAttempt(
    input: TurnAttemptInput,
  ): Promise<TurnCommit> {
    let resources: AttemptResourceState = { kind: "inactive" };
    let execution: AttemptExecution;
    try {
      execution = {
        kind: "succeeded",
        commit: await this.performTurnAttempt(input, (nextResources) => {
          resources = nextResources;
        }),
      };
    } catch (error: unknown) {
      execution = { kind: "failed", error };
    }
    const cleanupErrors = await this.releaseAttemptResources(resources);
    if (execution.kind === "failed") {
      if (cleanupErrors.length === 0) {
        throw execution.error;
      }
      throw new AiWorkflowError(
        "AIターンの失敗後にターン資源を解放できませんでした。",
        new AggregateError(
          [execution.error, ...cleanupErrors],
          "AIターンとターン資源の解放に失敗しました。",
          { cause: execution.error },
        ),
      );
    }
    if (cleanupErrors.length === 1) {
      const cleanupError = cleanupErrors[0];
      if (cleanupError == null) {
        throw new Error("ターン資源の解放エラーを取得できません。");
      }
      throw new AiWorkflowError("AIターン資源を解放できませんでした。", cleanupError);
    }
    if (cleanupErrors.length > 1) {
      const cleanupError = cleanupErrors[0];
      if (cleanupError == null) {
        throw new Error("ターン資源の解放エラーを取得できません。");
      }
      throw new AggregateError(
        cleanupErrors,
        "ターン資源の解放に失敗しました。",
        { cause: cleanupError },
      );
    }
    return execution.commit;
  }

  private async releaseAttemptResources(
    resources: AttemptResourceState,
  ): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (
      resources.kind === "collector_active"
      || resources.kind === "collector_active_snapshot_frozen"
    ) {
      try {
        await this.options.externalStatusEvidenceCollector.cancelTurn(
          resources.attemptId,
        );
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (
      resources.kind === "snapshot_frozen"
      || resources.kind === "collector_active_snapshot_frozen"
    ) {
      try {
        this.options.session.releaseTaskctlSnapshot();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    return errors;
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
    let validatedResponse: ValidatedGeneratedResponse;
    if (generatedResponse.kind === "proposal") {
      const status = workspace.getStatus();
      if (
        generatedResponse.workspace_id !== status.workspace_id
        || generatedResponse.revision !== status.revision
        || status.state !== "submitted"
      ) {
        throw new AiWorkflowRetryableFailureError(
          [aiWorkflowValidationIssueSchema.parse({
            phase: "proposal_workspace",
            code: generatedResponse.workspace_id !== status.workspace_id
              || generatedResponse.revision !== status.revision
              ? "proposal_workspace_reference_mismatch"
              : "proposal_workspace_not_submitted",
            json_pointer: generatedResponse.workspace_id !== status.workspace_id
              ? "/workspace_id"
              : "/revision",
          })],
          aiWorkflowCandidateDigestSchema.parse({ kind: "unavailable", reason: "not_staged" }),
          "reuse_lease",
          new AiWorkflowError("AI変更案ワークスペースの提出と最終応答が一致しません。"),
        );
      }
      const proposal = readWorkspaceProposal(workspace);
      const response = codexResponseSchema.parse({
        kind: generatedResponse.kind,
        message: generatedResponse.message,
        questions: generatedResponse.questions,
        proposal,
      });
      if (response.kind !== "proposal") {
        throw new Error("ワークスペース応答が提案応答へ変換されませんでした。");
      }
      validatedResponse = { kind: "proposal", response };
    } else {
      if (workspace.getStatus().state === "submitted") {
        throw new AiWorkflowRetryableFailureError(
          [aiWorkflowValidationIssueSchema.parse({
            phase: "proposal_workspace",
            code: "proposal_workspace_response_mismatch",
            json_pointer: "/kind",
          })],
          workspaceCandidateDigest(readWorkspaceProposal(workspace)),
          "reuse_lease",
          new AiWorkflowError("提出済みワークスペースに提案なし応答を指定できません。"),
        );
      }
      const response = codexResponseSchema.parse(generatedResponse);
      if (response.kind !== "no_proposal") {
        throw new Error("提案なし応答が提案なし応答として検証されませんでした。");
      }
      validatedResponse = { kind: "no_proposal", response };
    }
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
    const operations = operationMap(stored.proposal);
    const currentOperation = operations.get(request.operation_id);
    if (currentOperation == null) {
      throw new AiWorkflowEditError("指定した操作が変更案にありません。");
    }
    const editedEvidence = {
      kind: "user_message",
      locator: request.evidence_locator,
    };
    const candidateOperation = {
      ...currentOperation,
      after: request.after,
      basis: "explicit",
      confidence: 1,
      evidence_refs: [...currentOperation.evidence_refs, editedEvidence],
    };
    let validatedOperation: ProposalOperation;
    try {
      validatedOperation = proposalOperationSchema.parse(candidateOperation);
    } catch (error: unknown) {
      throw new AiWorkflowEditError("操作種別に許可されない編集値です。", error);
    }
    const editedProposal = proposalSchema.parse({
      ...stored.proposal,
      groups: stored.proposal.groups.map((group) => ({
        ...group,
        operations: group.operations.map((operation) =>
          operation.operation_id === request.operation_id ? validatedOperation : operation),
      })),
    });
    const validation = revalidateProposal(editedProposal, stored);
    const selectedOperationIds = preserveSelection(
      editedProposal,
      validation.graph,
      stored.selected_operation_ids,
    );
    try {
      assertSelectedProposalGraphIsSafe({
        proposal: editedProposal,
        snapshot: stored.snapshot,
        graph_validation: validation.graph,
      }, selectedOperationIds);
    } catch (error: unknown) {
      throw new AiWorkflowEditError(
        "編集後の選択操作を依存・親子グラフへ投影できません。",
        error,
      );
    }
    const updated: StoredProposal = {
      ...stored,
      proposal: editedProposal,
      basic_validation: validation.basic,
      graph_validation: validation.graph,
      selected_operation_ids: [...selectedOperationIds],
    };
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
      {
        proposal_id: stored.proposal_id,
        proposal: stored.proposal,
        baseline_snapshot: stored.baseline,
        baseline_snapshot_hash: stored.baseline_snapshot_hash,
        baseline_external_data: stored.baseline_external_data,
        existing_areas: stored.snapshot.areas,
        graph_validation_result: stored.graph_validation,
        selected_operation_ids: selectedOperationIds,
        explicit_split_request_references: [...stored.explicit_split_request_references],
        trusted_status_evidence: [...stored.trusted_status_evidence],
        created_via: "codex",
      },
      signal,
    );
    const validatedInput = asanaProposalApplicationInputSchema.parse(approvalInput);
    if (canonicalizeJson(validatedInput.approval_input.proposal)
      !== canonicalizeJson(stored.proposal)) {
      throw new AiWorkflowError("承認入力の変更案が保持中の変更案と一致しません。");
    }
    if (
      canonicalizeJson(
        createBaselineTaskSnapshots(validatedInput.approval_input.baseline_tasks),
      ) !== canonicalizeJson(stored.baseline.tasks)
    ) {
      throw new AiWorkflowError("承認入力の基準タスクが保持中の基準値と一致しません。");
    }
    if (!sameSortedIds(validatedInput.approval_input.selected_operation_ids, selectedOperationIds)) {
      throw new AiWorkflowError("承認入力の選択操作が一致しません。");
    }
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
