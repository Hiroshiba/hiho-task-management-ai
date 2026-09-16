import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  baselineSnapshotSchema,
  canonicalizeJson,
  dependenciesSchema,
  isJsonValue,
  type Duration,
  gidSchema,
  identifierSchema,
  obsidianLinksSchema,
  taskSchema,
  type BaselineSnapshot,
  type Dependency,
  type ObsidianLink,
  type Task,
  type TaskSnapshot,
} from "../../../shared/domain";
import {
  codexGeneratedProposalSchema,
  codexResponseSchema,
  proposalOperationSchema,
  proposalSchema,
  type CodexResponse,
  type CodexGeneratedResponse,
  type Proposal,
  type ProposalOperation,
} from "../../../shared/ai";
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
  type RankingResult,
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
  AiWorkflowProposalFileError,
  AiWorkflowProposalNotFoundError,
  AiWorkflowRetryableFailureError,
  AiWorkflowSelectionError,
  AiWorkflowStateError,
  AiWorkflowSyncError,
} from "./errors";
import {
  aiWorkflowProposalFileLeaseSchema,
  type AiWorkflowProposalFileLease,
  type AiWorkflowProposalCandidate,
  type AiWorkflowProposalFileRefreshResult,
} from "./proposal-file";
import {
  aiWorkflowPreviousDigestSchema,
  aiWorkflowRetryLogEventSchema,
  aiWorkflowSafeErrorProjectionSchema,
  aiWorkflowValidationErrorsSchema,
  aiWorkflowValidationIssueSchema,
  aiWorkflowValidationDetailCodeSchema,
  aiWorkflowZodIssueCodeSchema,
  aiWorkflowMaximumRetryAttempts,
  type AiWorkflowSafeErrorCause,
  type AiWorkflowCandidateDigest,
  type AiWorkflowPreviousDigest,
  type AiWorkflowRetryLogEvent,
  type AiWorkflowSafeErrorDescription,
  type AiWorkflowSafeErrorProjection,
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
  combineDiagnosticFailures,
} from "../../diagnostic-failure";

const maximumWorkflowProposals = 32;
const maximumPromptStatusEvidenceReferences = 256;

type EvidenceSource =
  | {
      readonly kind: "user_message";
      readonly source_id: string;
      readonly text: string;
    }
  | {
      readonly kind: "task_notes";
      readonly source_id: string;
      readonly task_gid: string;
      readonly text: string;
    }
  | {
      readonly kind: "withdraw_confirmation";
      readonly source_id: string;
      readonly text: string;
      readonly target_task_gid: string;
      readonly baseline_status: TaskSnapshot["status"];
      readonly baseline_completed: boolean;
    };

type EvidenceSourceMap = ReadonlyMap<string, EvidenceSource>;

type UserMessageSourceSummary =
  | {
      readonly kind: "user_message";
      readonly source_id: string;
      readonly text: string;
    }
  | {
      readonly kind: "withdraw_confirmation";
      readonly source_id: string;
      readonly text: string;
      readonly target_task_gid: string;
      readonly baseline_status: TaskSnapshot["status"];
      readonly baseline_completed: boolean;
    };

type BoundProposalEvidence = {
  readonly proposal: Proposal;
  readonly explicit_split_request_references: readonly ExplicitSplitRequestReference[];
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
};

type PendingWithdrawConfirmation = {
  readonly target_task_gid: string;
  readonly baseline_status: TaskSnapshot["status"];
  readonly baseline_completed: boolean;
};

type CodexQuestion = CodexResponse["questions"][number];

type NoProposalResponse = Extract<CodexResponse, { readonly kind: "no_proposal" }>;

type ValidatedGeneratedResponse =
  | { readonly kind: "no_proposal"; readonly response: NoProposalResponse }
  | {
      readonly kind: "proposal";
      readonly response: Extract<CodexResponse, { readonly kind: "proposal" }>;
      readonly candidate: AiWorkflowProposalCandidate;
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
      readonly validationErrorsPath: string;
      readonly failedAttempt: number;
    };

type TurnExecutionInput = {
  readonly request: AiWorkflowTurnRequest;
  readonly signal: AbortSignal;
  readonly baseProposal: StoredProposal | undefined;
  readonly turnGeneration: number;
  readonly pendingWithdrawConfirmation: PendingWithdrawConfirmation | undefined;
  readonly logicalTurnId: string;
  readonly proposalFile: AiWorkflowProposalFileLease;
};

type TurnAttemptInput = TurnExecutionInput & {
  readonly attempt: number;
  readonly retryPromptContext: TurnRetryPromptContext;
};

type TurnExecutionResult =
  | {
      readonly kind: "succeeded";
      readonly commit: TurnCommit;
      readonly proposalFile: AiWorkflowProposalFileLease;
    }
  | {
      readonly kind: "failed";
      readonly error: unknown;
      readonly proposalFile: AiWorkflowProposalFileLease;
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
      readonly validationErrorsPath: string;
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

type ProposalFileDisposalResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

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
  onDelta(listener: CodexSessionDeltaListener): () => void;
}

/** AIターン用提案ファイルの発行と読み書きを提供する境界です。 */
export interface AiWorkflowProposalFilePort {
  createDraft(baseProposal: Proposal | undefined): AiWorkflowProposalFileLease;
  readProposal(proposalFileId: string): AiWorkflowProposalCandidate;
  inspectProposalCandidate(proposalFileId: string): AiWorkflowCandidateDigest;
  refreshDraft(
    proposalFileId: string,
    baseProposal: Proposal | undefined,
  ): AiWorkflowProposalFileRefreshResult;
  writeValidationErrors(logicalTurnId: string, errors: unknown): string;
  dispose(proposalFileId: string): void;
  disposeValidationErrors(logicalTurnId: string): void;
  disposeAll(): void;
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
  readonly proposalFileStore: AiWorkflowProposalFilePort;
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
      "onDelta",
    ].every((name) => typeof Reflect.get(value, name) === "function");
  },
  "AIセッション境界が不正です。",
);

const proposalFilePortSchema = z.custom<AiWorkflowProposalFilePort>(
  (value) => typeof value === "object"
    && value != null
    && [
      "createDraft",
      "readProposal",
      "inspectProposalCandidate",
      "refreshDraft",
      "writeValidationErrors",
      "dispose",
      "disposeValidationErrors",
      "disposeAll",
    ].every(
      (name) => typeof Reflect.get(value, name) === "function",
    ),
  "AI変更案ファイル境界が不正です。",
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
    && ["beginTurn", "finishTurn", "cancelTurn"].every(
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
    proposalFileStore: proposalFilePortSchema,
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

function canonicalizeGeneratedJsonSchema(schema: unknown): string {
  const serialized = JSON.stringify(schema);
  if (serialized == null) {
    throw new Error("生成された変更案スキーマをJSONへ変換できません。");
  }
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonValue(parsed)) {
    throw new Error("生成された変更案スキーマがJSON値ではありません。");
  }
  return canonicalizeJson(parsed);
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

function findBaselineTaskByGid(
  baseline: BaselineSnapshot,
  taskGid: string,
): TaskSnapshot | undefined {
  return baseline.tasks.find((task) => task.gid === taskGid);
}

function isPendingWithdrawConfirmationValid(
  snapshot: AiWorkflowSnapshot,
  pending: PendingWithdrawConfirmation,
): boolean {
  return isWithdrawConfirmationTargetCurrent(
    snapshot,
    pending.target_task_gid,
    pending.baseline_status,
    pending.baseline_completed,
  );
}

function isWithdrawConfirmationTargetCurrent(
  snapshot: AiWorkflowSnapshot,
  targetTaskGid: string,
  baselineStatus: TaskSnapshot["status"],
  baselineCompleted: boolean,
): boolean {
  const task = findTaskByGid(snapshot, targetTaskGid);
  return task != null
    && task.status === baselineStatus
    && task.completed === baselineCompleted
    && (task.status === "not_started" || task.status === "in_progress")
    && task.completed === false;
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

function isWithdrawConfirmationSourceCurrent(
  source: Extract<EvidenceSource, { readonly kind: "withdraw_confirmation" }>,
  snapshot: AiWorkflowSnapshot,
): boolean {
  return isWithdrawConfirmationTargetCurrent(
    snapshot,
    source.target_task_gid,
    source.baseline_status,
    source.baseline_completed,
  );
}

function createEvidenceSourceMap(
  turnId: string,
  message: string,
  snapshot: AiWorkflowSnapshot,
  completedEvidenceSources: ReadonlyMap<string, EvidenceSource>,
  pendingWithdrawConfirmation: PendingWithdrawConfirmation | undefined,
): {
  readonly user_message_source_id: string;
  readonly user_message_sources: readonly UserMessageSourceSummary[];
  readonly withdraw_confirmation_source_id: string | undefined;
  readonly source_map: EvidenceSourceMap;
} {
  const userMessageSourceId = createUserMessageSourceId(turnId);
  const sources = new Map<string, EvidenceSource>();
  const userMessageSources: UserMessageSourceSummary[] = [];
  for (const source of completedEvidenceSources.values()) {
    if (source.kind === "user_message") {
      sources.set(source.source_id, source);
      userMessageSources.push({
        kind: "user_message",
        source_id: source.source_id,
        text: source.text,
      });
      continue;
    }
    if (
      source.kind === "withdraw_confirmation"
      && isWithdrawConfirmationSourceCurrent(source, snapshot)
    ) {
      sources.set(source.source_id, source);
      userMessageSources.push({
        kind: "withdraw_confirmation",
        source_id: source.source_id,
        text: source.text,
        target_task_gid: source.target_task_gid,
        baseline_status: source.baseline_status,
        baseline_completed: source.baseline_completed,
      });
    }
  }
  sources.set(userMessageSourceId, {
    kind: "user_message",
    source_id: userMessageSourceId,
    text: message,
  });
  userMessageSources.push({
    kind: "user_message",
    source_id: userMessageSourceId,
    text: message,
  });
  const withdrawConfirmationSourceId = pendingWithdrawConfirmation == null
    ? undefined
    : createWithdrawConfirmationSourceId(turnId);
  if (withdrawConfirmationSourceId != null && pendingWithdrawConfirmation != null) {
    sources.set(withdrawConfirmationSourceId, {
      kind: "withdraw_confirmation",
      source_id: withdrawConfirmationSourceId,
      text: message,
      target_task_gid: pendingWithdrawConfirmation.target_task_gid,
      baseline_status: pendingWithdrawConfirmation.baseline_status,
      baseline_completed: pendingWithdrawConfirmation.baseline_completed,
    });
    userMessageSources.push({
      kind: "withdraw_confirmation",
      source_id: withdrawConfirmationSourceId,
      text: message,
      target_task_gid: pendingWithdrawConfirmation.target_task_gid,
      baseline_status: pendingWithdrawConfirmation.baseline_status,
      baseline_completed: pendingWithdrawConfirmation.baseline_completed,
    });
  }
  for (const task of snapshot.tasks) {
    const sourceId = createTaskNotesSourceId(turnId, task.gid);
    sources.set(sourceId, {
      kind: "task_notes",
      source_id: sourceId,
      task_gid: task.gid,
      text: task.notes,
    });
  }
  return {
    user_message_source_id: userMessageSourceId,
    user_message_sources: userMessageSources,
    withdraw_confirmation_source_id: withdrawConfirmationSourceId,
    source_map: sources,
  };
}

function createStatusEvidenceLocator(
  sourceId: string,
  operation: "complete" | "withdraw",
  taskGid: string,
): string {
  return `${sourceId}#${operation}:${gidSchema.parse(taskGid)}`;
}

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

type UserStatusEvidence = Extract<
  StatusOperation["status_evidence"],
  { readonly kind: "user_explicit" }
>;

type TaskNotesStatusEvidence = Extract<
  StatusOperation["status_evidence"],
  { readonly kind: "task_or_note_explicit" }
>;

type SplitTaskOperation = Extract<
  ProposalOperation,
  { readonly operation: "create_task" }
>;

type SplitTaskCreation = Extract<
  SplitTaskOperation["creation"],
  { readonly kind: "split_child" }
>;

type InheritedStatusEvidenceAlias = {
  readonly locator: string;
  readonly source_id: string;
  readonly excerpt: string;
  readonly target_task_gid: string;
  readonly allowed_operation: "complete" | "withdraw";
};

type InheritedSplitInstructionAlias = {
  readonly locator: string;
  readonly source_id: string;
  readonly excerpt: string;
  readonly parent: ProposalTarget;
};

function stripStatusEvidenceExcerpt(
  operation: StatusOperation,
): StatusOperation["status_evidence"] {
  const evidence = operation.status_evidence;
  if (evidence.kind === "user_explicit") {
    return {
      kind: "user_explicit",
      reference: {
        kind: "user_message",
        locator: evidence.reference.locator,
      },
    };
  }
  if (evidence.kind === "task_or_note_explicit") {
    if (evidence.reference.kind === "task") {
      return {
        kind: "task_or_note_explicit",
        reference: {
          kind: "task",
          locator: evidence.reference.locator,
        },
      };
    }
    return {
      kind: "task_or_note_explicit",
      reference: {
        kind: "obsidian",
        locator: evidence.reference.locator,
      },
    };
  }
  if (evidence.kind === "external_structured_status") {
    return {
      ...evidence,
      reference: {
        kind: "external_tool",
        locator: evidence.reference.locator,
      },
    };
  }
  if (evidence.kind === "external_review_explicit") {
    return {
      kind: "external_review_explicit",
      reference: {
        kind: "external_review",
        locator: evidence.reference.locator,
      },
    };
  }
  return {
    kind: "children_only_all_completed",
    reference: {
      kind: "task",
      locator: evidence.reference.locator,
    },
  };
}

function stripSplitInstructionExcerpt(
  operation: SplitTaskOperation,
): SplitTaskCreation["instruction_reference"] {
  if (operation.creation.kind !== "split_child") {
    throw new Error("分割作成の根拠を通常作成へ適用できません。");
  }
  return {
    kind: operation.creation.instruction_reference.kind,
    locator: operation.creation.instruction_reference.locator,
  };
}

function isWithdrawConfirmationEvidenceValid(
  operation: StatusOperation,
  source: Extract<EvidenceSource, { readonly kind: "withdraw_confirmation" }>,
  snapshot: AiWorkflowSnapshot,
  baseline: BaselineSnapshot,
): boolean {
  if (
    operation.operation !== "withdraw"
    || operation.target.kind !== "existing"
  ) {
    return false;
  }
  const baselineTask = findBaselineTaskByGid(baseline, operation.target.gid);
  return isWithdrawConfirmationSourceCurrent(source, snapshot)
    && operation.target.gid === source.target_task_gid
    && baselineTask != null
    && baselineTask.status === source.baseline_status
    && baselineTask.completed === source.baseline_completed;
}

function bindStatusEvidence(
  operation: StatusOperation,
  prepared: PreparedTurn,
): {
  readonly evidence: StatusOperation["status_evidence"];
  readonly trusted_reference: TrustedStatusEvidenceReference | undefined;
} {
  const evidence = operation.status_evidence;
  const invalid = {
    evidence: stripStatusEvidenceExcerpt(operation),
    trusted_reference: undefined,
  };
  if (evidence.kind === "user_explicit") {
    if (
      operation.target.kind !== "existing"
      || findTaskByGid(prepared.snapshot, operation.target.gid) == null
    ) {
      return invalid;
    }
    const source = prepared.source_map.get(evidence.reference.locator);
    if (
      source == null
      || (source.kind !== "user_message" && source.kind !== "withdraw_confirmation")
      || (
        source.kind === "withdraw_confirmation"
        && !isWithdrawConfirmationEvidenceValid(
          operation,
          source,
          prepared.snapshot,
          prepared.baseline,
        )
      )
    ) {
      return invalid;
    }
    const excerpt = verifiedSourceExcerpt(source, evidence.reference.excerpt);
    if (excerpt == null) {
      return invalid;
    }
    const locator = createStatusEvidenceLocator(
      source.source_id,
      operation.operation,
      operation.target.gid,
    );
    const reference: UserStatusEvidence["reference"] = {
      kind: "user_message",
      locator,
      excerpt,
    };
    return {
      evidence: { ...evidence, reference },
      trusted_reference: {
        kind: "user_message",
        locator,
        target_task_gid: operation.target.gid,
        allowed_operation: operation.operation,
        excerpt,
      },
    };
  }
  if (evidence.kind === "task_or_note_explicit") {
    if (
      operation.target.kind !== "existing"
      || evidence.reference.kind !== "task"
      || findTaskByGid(prepared.snapshot, operation.target.gid) == null
    ) {
      return invalid;
    }
    const source = prepared.source_map.get(evidence.reference.locator);
    if (
      source == null
      || source.kind !== "task_notes"
      || source.task_gid !== operation.target.gid
    ) {
      return invalid;
    }
    const excerpt = verifiedSourceExcerpt(source, evidence.reference.excerpt);
    if (excerpt == null) {
      return invalid;
    }
    const locator = createStatusEvidenceLocator(
      source.source_id,
      operation.operation,
      operation.target.gid,
    );
    const reference: TaskNotesStatusEvidence["reference"] = {
      kind: "task",
      locator,
      excerpt,
    };
    return {
      evidence: { ...evidence, reference },
      trusted_reference: {
        kind: "task",
        locator,
        target_task_gid: operation.target.gid,
        allowed_operation: operation.operation,
        validation_kind: "explicit_text",
        excerpt,
      },
    };
  }
  return invalid;
}

function bindSplitInstructionReference(
  operation: SplitTaskOperation,
  prepared: PreparedTurn,
): {
  readonly reference: SplitTaskCreation["instruction_reference"];
  readonly split_reference: ExplicitSplitRequestReference | undefined;
} {
  if (operation.creation.kind !== "split_child") {
    throw new Error("分割作成の根拠を通常作成へ適用できません。");
  }
  const reference = operation.creation.instruction_reference;
  const invalid = {
    reference: stripSplitInstructionExcerpt(operation),
    split_reference: undefined,
  };
  if (
    operation.creation.parent.kind === "existing"
    && findTaskByGid(prepared.snapshot, operation.creation.parent.gid) == null
  ) {
    return invalid;
  }
  const source = prepared.source_map.get(reference.locator);
  if (source == null || source.kind !== "user_message") {
    return invalid;
  }
  const excerpt = verifiedSourceExcerpt(source, reference.excerpt);
  if (excerpt == null) {
    return invalid;
  }
  const locator = createSplitInstructionLocator(
    source.source_id,
    operation.creation.parent,
  );
  return {
    reference: {
      kind: "user_message",
      locator,
      excerpt,
    },
    split_reference: {
      parent: operation.creation.parent,
      locator,
      excerpt,
    },
  };
}

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
    const bound = bindSplitInstructionReference(resolved, prepared);
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
  const bound = bindStatusEvidence(resolved, prepared);
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

function findInheritedStatusSource(
  baseProposal: StoredProposal,
  sourceMap: EvidenceSourceMap,
  snapshot: AiWorkflowSnapshot,
  baseline: BaselineSnapshot,
  operation: StatusOperation,
  reference: TrustedStatusEvidenceReference,
): InheritedStatusEvidenceAlias | undefined {
  const operationEvidence = operation.status_evidence;
  if (
    reference.kind !== "user_message"
    || operationEvidence.kind !== "user_explicit"
    || operationEvidence.reference.kind !== "user_message"
    || reference.excerpt == null
    || operationEvidence.reference.excerpt == null
  ) {
    throw new AiWorkflowError("前案の利用者明示根拠の対応が壊れています。");
  }
  const target = operation.target;
  if (
    target.kind !== "existing"
    || reference.target_task_gid !== target.gid
    || reference.allowed_operation !== operation.operation
    || reference.locator !== operationEvidence.reference.locator
    || reference.excerpt !== operationEvidence.reference.excerpt
  ) {
    throw new AiWorkflowError("前案の利用者明示根拠の対応が壊れています。");
  }
  const targetTaskGid = target.gid;
  const candidates = [...baseProposal.source_map.values()].filter(
    (source): source is Extract<
      EvidenceSource,
      { readonly kind: "user_message" | "withdraw_confirmation" }
    > => source.kind === "user_message" || source.kind === "withdraw_confirmation",
  );
  const matches = candidates.filter(
    (source) => createStatusEvidenceLocator(
      source.source_id,
      operation.operation,
      targetTaskGid,
    ) === reference.locator,
  );
  if (matches.length !== 1) {
    throw new AiWorkflowError("前案の利用者明示根拠の原文を特定できません。");
  }
  const baseSource = matches[0];
  if (baseSource == null || verifiedSourceExcerpt(baseSource, reference.excerpt) == null) {
    throw new AiWorkflowError("前案の利用者明示根拠の引用が原文にありません。");
  }
  if (
    baseSource.kind === "withdraw_confirmation"
    && !isWithdrawConfirmationEvidenceValid(
      operation,
      baseSource,
      baseProposal.snapshot,
      baseProposal.baseline,
    )
  ) {
    throw new AiWorkflowError("前案の取り下げ確認根拠が基準状態へ対応していません。");
  }
  const currentSource = sourceMap.get(baseSource.source_id);
  if (currentSource == null) {
    if (baseSource.kind === "withdraw_confirmation") {
      return undefined;
    }
    throw new AiWorkflowError("前案の利用者原文が現在のsource mapにありません。");
  }
  if (canonicalizeJson(currentSource) !== canonicalizeJson(baseSource)) {
    throw new AiWorkflowError("前案の利用者原文が現在のsource mapと一致しません。");
  }
  if (
    currentSource.kind === "withdraw_confirmation"
    && !isWithdrawConfirmationEvidenceValid(operation, currentSource, snapshot, baseline)
  ) {
    return undefined;
  }
  if (verifiedSourceExcerpt(currentSource, reference.excerpt) == null) {
    throw new AiWorkflowError("前案の利用者明示根拠の引用が現在の原文にありません。");
  }
  return {
    locator: reference.locator,
    source_id: currentSource.source_id,
    excerpt: reference.excerpt,
    target_task_gid: targetTaskGid,
    allowed_operation: operation.operation,
  };
}

function findInheritedSplitSource(
  baseProposal: StoredProposal,
  sourceMap: EvidenceSourceMap,
  operation: SplitTaskOperation,
  reference: ExplicitSplitRequestReference,
): InheritedSplitInstructionAlias {
  const creation = operation.creation;
  if (creation.kind !== "split_child") {
    throw new AiWorkflowError("前案の分割依頼根拠を通常作成へ適用できません。");
  }
  const parent = creation.parent;
  const operationReference = creation.instruction_reference;
  if (
    operationReference.kind !== "user_message"
    || operationReference.excerpt == null
    || canonicalizeJson(reference.parent) !== canonicalizeJson(parent)
    || reference.locator !== operationReference.locator
    || reference.excerpt !== operationReference.excerpt
  ) {
    throw new AiWorkflowError("前案の分割依頼根拠の対応が壊れています。");
  }
  const candidates = [...baseProposal.source_map.values()].filter(
    (source): source is Extract<EvidenceSource, { readonly kind: "user_message" }> =>
      source.kind === "user_message",
  );
  const matches = candidates.filter(
    (source) => createSplitInstructionLocator(
      source.source_id,
      parent,
    ) === reference.locator,
  );
  if (matches.length !== 1) {
    throw new AiWorkflowError("前案の分割依頼根拠の原文を特定できません。");
  }
  const baseSource = matches[0];
  if (baseSource == null || verifiedSourceExcerpt(baseSource, reference.excerpt) == null) {
    throw new AiWorkflowError("前案の分割依頼根拠の引用が原文にありません。");
  }
  const currentSource = sourceMap.get(baseSource.source_id);
  if (currentSource == null || currentSource.kind !== "user_message") {
    throw new AiWorkflowError("前案の分割依頼の利用者原文が現在のsource mapにありません。");
  }
  if (canonicalizeJson(currentSource) !== canonicalizeJson(baseSource)) {
    throw new AiWorkflowError("前案の分割依頼の利用者原文が現在のsource mapと一致しません。");
  }
  if (verifiedSourceExcerpt(currentSource, reference.excerpt) == null) {
    throw new AiWorkflowError("前案の分割依頼根拠の引用が現在の原文にありません。");
  }
  return {
    locator: reference.locator,
    source_id: currentSource.source_id,
    excerpt: reference.excerpt,
    parent,
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
  if (baseProposal == null) {
    return { status: [], split: [] };
  }
  const eligibleIds = new Set(
    eligibleOperationIds(baseProposal.proposal, baseProposal.graph_validation),
  );
  const trustedByLocator = new Map<string, TrustedStatusEvidenceReference>();
  for (const reference of baseProposal.trusted_status_evidence) {
    const key = `${reference.kind}\u0000${reference.locator}`;
    if (trustedByLocator.has(key)) {
      throw new AiWorkflowError("前案の信頼済み根拠locatorが重複しています。");
    }
    trustedByLocator.set(key, reference);
  }
  const splitByKey = new Map<string, ExplicitSplitRequestReference>();
  for (const reference of baseProposal.explicit_split_request_references) {
    const key = `${canonicalizeJson(reference.parent)}\u0000${reference.locator}\u0000${reference.excerpt}`;
    if (splitByKey.has(key)) {
      throw new AiWorkflowError("前案の分割依頼根拠が重複しています。");
    }
    splitByKey.set(key, reference);
  }
  const statusAliases = new Map<string, InheritedStatusEvidenceAlias>();
  const splitAliases = new Map<string, InheritedSplitInstructionAlias>();
  for (const group of baseProposal.proposal.groups) {
    for (const operation of group.operations) {
      if (!eligibleIds.has(operation.operation_id)) {
        continue;
      }
      if (
        (operation.operation === "complete" || operation.operation === "withdraw")
        && operation.status_evidence.kind === "user_explicit"
        && operation.status_evidence.reference.kind === "user_message"
        && operation.target.kind === "existing"
      ) {
        const trusted = trustedByLocator.get(
          `user_message\u0000${operation.status_evidence.reference.locator}`,
        );
        if (trusted == null) {
          throw new AiWorkflowError("前案の利用者明示根拠が信頼済み一覧にありません。");
        }
        const alias = findInheritedStatusSource(
          baseProposal,
          sourceMap,
          snapshot,
          baseline,
          operation,
          trusted,
        );
        if (alias != null) {
          const key = `${alias.locator}\u0000${alias.source_id}\u0000${alias.excerpt}\u0000${alias.target_task_gid}\u0000${alias.allowed_operation}`;
          if (!statusAliases.has(key)) {
            statusAliases.set(key, alias);
          }
        }
      }
      if (
        operation.operation === "create_task"
        && operation.creation.kind === "split_child"
        && operation.creation.instruction_reference.kind === "user_message"
      ) {
        const operationReference = operation.creation.instruction_reference;
        if (operationReference.excerpt == null) {
          throw new AiWorkflowError("前案の分割依頼根拠の引用がありません。");
        }
        const key = `${canonicalizeJson(operation.creation.parent)}\u0000${operationReference.locator}\u0000${operationReference.excerpt}`;
        const reference = splitByKey.get(key);
        if (reference == null) {
          throw new AiWorkflowError("前案の分割依頼根拠が信頼済み一覧にありません。");
        }
        const alias = findInheritedSplitSource(
          baseProposal,
          sourceMap,
          operation,
          reference,
        );
        const aliasKey = `${alias.locator}\u0000${alias.source_id}\u0000${alias.excerpt}\u0000${canonicalizeJson(alias.parent)}`;
        if (!splitAliases.has(aliasKey)) {
          splitAliases.set(aliasKey, alias);
        }
      }
    }
  }
  return {
    status: [...statusAliases.values()],
    split: [...splitAliases.values()],
  };
}

function createTurnPrompt(
  request: AiWorkflowTurnRequest,
  prepared: PreparedTurn,
  proposalFile: AiWorkflowProposalFileLease,
  retryContext: TurnRetryPromptContext,
): string {
  const context = aiWorkflowTurnContextSchema.parse({
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    app_version: prepared.snapshot.app_version,
    project_gid: prepared.snapshot.project_gid,
    synced_at: prepared.snapshot.synced_at,
    as_of: prepared.snapshot.as_of,
  });
  const targetTask = request.target_task_gid == null
    ? undefined
    : findTaskByGid(prepared.snapshot, request.target_task_gid);
  if (request.target_task_gid != null && targetTask == null) {
    throw new AiWorkflowError("指定された対象タスクが基準スナップショットにありません。");
  }
  const targetTaskContext = targetTask == null
    ? null
    : { gid: targetTask.gid, title: targetTask.title };
  const withdrawConfirmationSources = prepared.user_message_sources.filter(
    (source) => source.kind === "withdraw_confirmation",
  );
  const taskNotesSourceIdPattern =
    `task-notes:${prepared.user_message_source_id.slice("user-message:".length)}:<対象タスクGID>`;
  const proposalFileSchema = z.toJSONSchema(codexGeneratedProposalSchema, {
    target: "draft-07",
  });
  const correctionInstructions = retryContext.kind === "initial"
    ? []
    : [
        "前回の検証エラーを修正してください。検証エラーファイルは読み取り専用で、内容を変更・削除しないでください。記載されたJSON Pointerと型付きcodeに従い、提案ファイルだけを修正してください。",
        "検証エラーには会話本文や根拠本文を含めていません。提案ファイルの既存内容と今回のコンテキストを照合してください。",
        "<validation_errors>",
        canonicalizeJson({
          attempt: retryContext.failedAttempt,
          max_attempts: aiWorkflowMaximumRetryAttempts,
          path: retryContext.validationErrorsPath,
        }),
        "</validation_errors>",
      ];
  return [
    "TaskHubの構造化変更案だけを検討してください。",
    "変更案を返す場合は、指定された提案ファイルを完全な変更案JSONへ更新し、最終応答には発行済みproposal_file_idだけを指定してください。",
    "提案ファイルの内容が変更案の正本であり、最終応答へ変更案JSONを埋め込まないでください。",
    "提案ファイルを削除、移動、置換しないでください。アプリが事前に作成した指定パスの同じファイルへ完全なUTF-8 JSONを書き込み、書き込みを完了してファイルを閉じてから最終応答を返してください。バックグラウンドwriterや完了前の非同期書き込みを残さないでください。",
    "提案ファイルのUTF-8バイト数は256KiB以下にしてください。書き込みに失敗した場合はproposal_file_idを返さず、最終応答へkind: proposal_file_error、error_code: write_failed、messageを指定してください。",
    ...correctionInstructions,
    "<baseline_context>",
    canonicalizeJson(context),
    "</baseline_context>",
    "<proposal_file>",
    canonicalizeJson({
      proposal_file_id: proposalFile.proposal_file_id,
      proposal_file_path: proposalFile.proposal_file_path,
    }),
    "</proposal_file>",
    "<proposal_file_schema>",
    canonicalizeGeneratedJsonSchema(proposalFileSchema),
    "</proposal_file_schema>",
    "<target_task_context>",
    canonicalizeJson(targetTaskContext),
    "</target_task_context>",
    "<user_message_sources>",
    canonicalizeJson(prepared.user_message_sources),
    "</user_message_sources>",
    "<withdraw_confirmation_sources>",
    canonicalizeJson(withdrawConfirmationSources),
    "</withdraw_confirmation_sources>",
    "<task_notes_source_id_pattern>",
    canonicalizeJson({ pattern: taskNotesSourceIdPattern }),
    "</task_notes_source_id_pattern>",
    "<pending_withdraw_confirmation>",
    canonicalizeJson(prepared.pending_withdraw_confirmation ?? null),
    "</pending_withdraw_confirmation>",
    "<inherited_status_evidence_aliases>",
    canonicalizeJson(prepared.inherited_status_evidence_aliases),
    "</inherited_status_evidence_aliases>",
    "<inherited_split_instruction_aliases>",
    canonicalizeJson(prepared.inherited_split_instruction_aliases),
    "</inherited_split_instruction_aliases>",
    "<trusted_status_evidence>",
    canonicalizeJson(prepared.trusted_status_evidence),
    "</trusted_status_evidence>",
    "<current_request>",
    canonicalizeJson({
      message: request.message,
      user_message_source_id: prepared.user_message_source_id,
    }),
    "</current_request>",
  ].join("\n");
}

function createPendingWithdrawConfirmation(
  response: NoProposalResponse,
  prepared: PreparedTurn,
): PendingWithdrawConfirmation | undefined {
  if (response.questions.length !== 1) {
    return undefined;
  }
  const question = response.questions[0];
  if (question == null) {
    throw new AiWorkflowError("取り下げ確認の質問を取得できません。");
  }
  const confirmation = question.withdraw_confirmation;
  if (confirmation == null) {
    return undefined;
  }
  const task = findTaskByGid(prepared.snapshot, confirmation.target_task_gid);
  const baselineTask = findBaselineTaskByGid(
    prepared.baseline,
    confirmation.target_task_gid,
  );
  if (
    task == null
    || baselineTask == null
    || (
      task.status !== "not_started"
      && task.status !== "in_progress"
    )
    || task.completed !== false
    || baselineTask.status !== task.status
    || baselineTask.completed !== task.completed
  ) {
    return undefined;
  }
  return {
    target_task_gid: task.gid,
    baseline_status: baselineTask.status,
    baseline_completed: baselineTask.completed,
  };
}

function createPendingWithdrawConfirmationCommit(
  pending: PendingWithdrawConfirmation | undefined,
): PendingWithdrawConfirmationCommit {
  if (pending == null) {
    return { kind: "clear" };
  }
  return { kind: "set", value: pending };
}

function createRendererQuestions(
  questions: readonly CodexQuestion[],
  pending: PendingWithdrawConfirmation | undefined,
  snapshot: AiWorkflowSnapshot,
): readonly {
  readonly question_id: string;
  readonly text: string;
  readonly options?: readonly string[];
}[] {
  return questions.map((question) => {
    if (
      pending != null
      && question.withdraw_confirmation?.target_task_gid === pending.target_task_gid
    ) {
      const task = findTaskByGid(snapshot, pending.target_task_gid);
      if (task == null) {
        throw new AiWorkflowError("取り下げ確認の対象タスクが基準スナップショットにありません。");
      }
      return {
        question_id: question.question_id,
        text: `タスク「${task.title}」GID ${task.gid}を取り下げますか。`,
        options: ["はい、それでいいです", "いいえ"],
      };
    }
    const base = {
      question_id: question.question_id,
      text: question.text,
    };
    if (question.options == null) {
      return base;
    }
    return { ...base, options: [...question.options] };
  });
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

type ProposalTarget = Extract<
  ProposalOperation,
  { readonly operation: "update_title" }
>["target"];

type ProposalParentValue = Extract<
  ProposalOperation,
  { readonly operation: "set_parent" }
>["after"];

type ProposalDueValue = Extract<
  ProposalOperation,
  { readonly operation: "set_due" }
>["after"];

function projectedTemporaryGid(ref: string): string {
  return `temporary:${ref}`;
}

function projectedTargetGid(target: ProposalTarget): string {
  if (target.kind === "existing") {
    return target.gid;
  }
  return projectedTemporaryGid(target.ref);
}

function projectedParentGid(value: ProposalParentValue): string | undefined {
  if (value.kind === "absent") {
    return undefined;
  }
  return projectedTargetGid(value);
}

function withoutTaskFields(
  task: Task,
  fields: readonly string[],
): Record<string, unknown> {
  const value: Record<string, unknown> = { ...task };
  for (const field of fields) {
    delete value[field];
  }
  return value;
}

function replaceProjectedTask(
  tasks: Map<string, Task>,
  gid: string,
  update: (task: Task) => Task,
): void {
  const current = tasks.get(gid);
  if (current == null) {
    throw new AiWorkflowError(`投影対象タスク ${gid} が存在しません。`);
  }
  tasks.set(gid, taskSchema.parse(update(current)));
}

function createProjectedDependency(
  dependency: Extract<ProposalOperation, { readonly operation: "set_dependencies" }>["after"][number],
): Dependency {
  return {
    task_gid: projectedTargetGid(dependency.target),
    scope: dependency.scope,
    source: dependency.source,
  };
}

function createProjectedTask(
  operation: Extract<ProposalOperation, { readonly operation: "create_task" }>,
  snapshot: AiWorkflowSnapshot,
): Task {
  const after = operation.after;
  const base = {
    gid: projectedTemporaryGid(operation.temporary_ref),
    title: after.title,
    notes: after.notes ?? "",
    status: after.status ?? "not_started",
    importance: after.importance ?? 3,
    area: after.area ?? "未分類",
    block_state: "none",
    parent_work_mode: after.parent_work_mode ?? "unknown",
    section_gid: "temporary-section",
    completed: false,
    tags: [],
    child_gids: [],
    dependencies: (after.dependencies ?? []).map((dependency) => createProjectedDependency(dependency)),
    obsidian_links: after.obsidian_links ?? [],
    activity_anchor_on: snapshot.as_of.slice(0, 10),
  };
  const withDue = after.due == null
    ? base
    : after.due.kind === "due_on"
      ? { ...base, due_on: after.due.due_on }
      : { ...base, due_at: after.due.due_at };
  const withDuration = after.duration == null
    ? withDue
    : { ...withDue, duration: after.duration };
  const withParent = after.parent == null
    ? withDuration
    : { ...withDuration, parent_gid: projectedTargetGid(after.parent) };
  return taskSchema.parse(withParent);
}

function appendChild(tasks: Map<string, Task>, parentGid: string, childGid: string): void {
  replaceProjectedTask(tasks, parentGid, (parent) => {
    if (parent.child_gids.includes(childGid)) {
      return parent;
    }
    return { ...parent, child_gids: [...parent.child_gids, childGid] };
  });
}

function removeChild(tasks: Map<string, Task>, parentGid: string, childGid: string): void {
  replaceProjectedTask(tasks, parentGid, (parent) => ({
    ...parent,
    child_gids: parent.child_gids.filter((gid) => gid !== childGid),
  }));
}

function applyCreateRelations(
  tasks: Map<string, Task>,
  operation: Extract<ProposalOperation, { readonly operation: "create_task" }>,
): void {
  const childGid = projectedTemporaryGid(operation.temporary_ref);
  if (operation.after.parent != null) {
    appendChild(tasks, projectedTargetGid(operation.after.parent), childGid);
  }
}

function setProjectedDue(task: Task, due: ProposalDueValue): Task {
  const withoutDue = withoutTaskFields(task, ["due_on", "due_at"]);
  if (due.kind === "due_on") {
    return taskSchema.parse({ ...withoutDue, due_on: due.due_on });
  }
  return taskSchema.parse({ ...withoutDue, due_at: due.due_at });
}

function clearProjectedDue(task: Task): Task {
  return taskSchema.parse(withoutTaskFields(task, ["due_on", "due_at"]));
}

function setProjectedDuration(task: Task, duration: Duration): Task {
  return taskSchema.parse({ ...task, duration });
}

function clearProjectedDuration(task: Task): Task {
  return taskSchema.parse(withoutTaskFields(task, ["duration"]));
}

function sameObsidianLink(left: ObsidianLink, right: ObsidianLink): boolean {
  return left.vault_id === right.vault_id
    && left.path === right.path
    && left.title === right.title
    && left.confidence === right.confidence;
}

function applyProjectedOperation(
  tasks: Map<string, Task>,
  operation: Exclude<ProposalOperation, { readonly operation: "create_task" }>,
): void {
  const targetGid = projectedTargetGid(operation.target);
  switch (operation.operation) {
    case "update_title":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, title: operation.after }));
      return;
    case "update_notes":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, notes: operation.after }));
      return;
    case "set_status":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        status: operation.after,
        completed: false,
      }));
      return;
    case "set_importance":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, importance: operation.after }));
      return;
    case "set_due":
      replaceProjectedTask(tasks, targetGid, (task) => setProjectedDue(task, operation.after));
      return;
    case "clear_due":
      replaceProjectedTask(tasks, targetGid, clearProjectedDue);
      return;
    case "set_duration":
      replaceProjectedTask(tasks, targetGid, (task) =>
        setProjectedDuration(task, operation.after));
      return;
    case "clear_duration":
      replaceProjectedTask(tasks, targetGid, clearProjectedDuration);
      return;
    case "set_area":
      replaceProjectedTask(tasks, targetGid, (task) => ({ ...task, area: operation.after }));
      return;
    case "set_dependencies":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        dependencies: dependenciesSchema.parse(
          operation.after.map((dependency) => createProjectedDependency(dependency)),
        ),
      }));
      return;
    case "set_parent": {
      const current = tasks.get(targetGid);
      if (current == null) {
        throw new AiWorkflowError(`投影対象タスク ${targetGid} が存在しません。`);
      }
      if (current.parent_gid != null) {
        if (tasks.has(current.parent_gid)) {
          removeChild(tasks, current.parent_gid, targetGid);
        }
      }
      const newParentGid = projectedParentGid(operation.after);
      replaceProjectedTask(tasks, targetGid, (task) => {
        if (newParentGid == null) {
          return taskSchema.parse(withoutTaskFields(task, ["parent_gid"]));
        }
        return { ...task, parent_gid: newParentGid };
      });
      if (newParentGid != null) {
        appendChild(tasks, newParentGid, targetGid);
      }
      return;
    }
    case "set_parent_work_mode":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        parent_work_mode: operation.after,
      }));
      return;
    case "link_obsidian":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        obsidian_links: obsidianLinksSchema.parse([...task.obsidian_links, operation.after]),
      }));
      return;
    case "unlink_obsidian":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        obsidian_links: task.obsidian_links.filter(
          (link) => !sameObsidianLink(link, operation.before),
        ),
      }));
      return;
    case "complete":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        status: "completed",
        completed: true,
      }));
      return;
    case "withdraw":
      replaceProjectedTask(tasks, targetGid, (task) => ({
        ...task,
        status: "withdrawn",
        completed: true,
      }));
      return;
  }
}

function projectTasks(
  snapshot: AiWorkflowSnapshot,
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
): RankingTask[] {
  const tasks = new Map<string, Task>();
  for (const task of snapshot.tasks) {
    if (tasks.has(task.gid)) {
      throw new AiWorkflowError(`投影元タスク ${task.gid} が重複しています。`);
    }
    tasks.set(task.gid, task);
  }

  const selectedCreates = proposal.groups.flatMap((group) =>
    group.operations.filter(
      (operation): operation is Extract<ProposalOperation, { readonly operation: "create_task" }> =>
        operation.operation === "create_task"
        && selectedOperationIds.has(operation.operation_id),
    ));
  for (const operation of selectedCreates) {
    const gid = projectedTemporaryGid(operation.temporary_ref);
    if (tasks.has(gid)) {
      throw new AiWorkflowError(`投影先GID ${gid} が重複しています。`);
    }
    tasks.set(gid, createProjectedTask(operation, snapshot));
  }
  for (const operation of selectedCreates) {
    applyCreateRelations(tasks, operation);
  }

  for (const group of proposal.groups) {
    for (const operation of group.operations) {
      if (
        operation.operation !== "create_task"
        && selectedOperationIds.has(operation.operation_id)
      ) {
        applyProjectedOperation(tasks, operation);
      }
    }
  }
  return normalizeTasksForRanking(
    [...tasks.values()].sort((left, right) => compareStrings(left.gid, right.gid)),
  );
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

function createRankMap(result: RankingResult): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const task of result.ranked_tasks) {
    if (ranks.has(task.gid)) {
      throw new AiWorkflowError(`順位結果のGID ${task.gid} が重複しています。`);
    }
    ranks.set(task.gid, task.rank);
  }
  return ranks;
}

type RankPresence = "ranked" | "excluded" | "not_present";

function createRankPresenceMap(result: RankingResult): Map<string, RankPresence> {
  const states = new Map<string, RankPresence>();
  for (const task of result.ranked_tasks) {
    states.set(task.gid, "ranked");
  }
  for (const task of result.excluded_tasks) {
    if (states.has(task.gid)) {
      throw new AiWorkflowError(`順位結果のGID ${task.gid} が重複しています。`);
    }
    states.set(task.gid, "excluded");
  }
  return states;
}

function createRankChange(
  gid: string,
  before: number | undefined,
  after: number | undefined,
  beforeState: RankPresence,
  afterState: RankPresence,
): {
  readonly task_gid: string;
  readonly before_state: RankPresence;
  readonly before_rank?: number;
  readonly after_state: RankPresence;
  readonly after_rank?: number;
} {
  const base = { task_gid: gid, before_state: beforeState, after_state: afterState };
  const withBefore = before == null ? base : { ...base, before_rank: before };
  return after == null ? withBefore : { ...withBefore, after_rank: after };
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
  const validatedSnapshot = aiWorkflowSnapshotSchema.parse(snapshot);
  const validatedProposal = proposalSchema.parse(proposal);
  const validatedSelection = z
    .array(identifierSchema)
    .max(256)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            path: [index],
            message: "同じ操作を重複指定できません。",
          });
        }
        seen.add(value);
      }
    })
    .parse(selectedOperationIds);
  const availableOperations = operationMap(validatedProposal);
  for (const operationId of validatedSelection) {
    if (!availableOperations.has(operationId)) {
      throw new AiWorkflowSelectionError(`指定した操作 ${operationId} が存在しません。`);
    }
  }
  const selected = new Set(validatedSelection);
  const baselineRanking = calculateTaskRanking({
    app_version: validatedSnapshot.app_version,
    as_of: validatedSnapshot.as_of,
    tasks: normalizeTasksForRanking(validatedSnapshot.tasks),
  });
  const projectedRanking = calculateTaskRanking({
    app_version: validatedSnapshot.app_version,
    as_of: validatedSnapshot.as_of,
    tasks: projectTasks(validatedSnapshot, validatedProposal, selected),
  });
  const beforeRanks = createRankMap(baselineRanking);
  const afterRanks = createRankMap(projectedRanking);
  const beforeStates = createRankPresenceMap(baselineRanking);
  const afterStates = createRankPresenceMap(projectedRanking);
  const directTargetGids = collectDirectTargetGids(validatedProposal, selected);
  const gids = new Set([
    ...beforeRanks.keys(),
    ...afterRanks.keys(),
    ...beforeStates.keys(),
    ...afterStates.keys(),
    ...directTargetGids,
  ]);
  const changes = [...gids]
    .sort(compareStrings)
    .flatMap((gid) => {
      const before = beforeRanks.get(gid);
      const after = afterRanks.get(gid);
      const beforeState = beforeStates.get(gid) ?? "not_present";
      const afterState = afterStates.get(gid) ?? "not_present";
      if (
        before === after
        && beforeState === afterState
        && !directTargetGids.has(gid)
      ) {
        return [];
      }
      if (
        before == null
        && after == null
        && beforeState === afterState
        && !directTargetGids.has(gid)
      ) {
        return [];
      }
      return [createRankChange(gid, before, after, beforeState, afterState)];
    });
  return aiWorkflowImpactSchema.parse({
    impacted_task_count: changes.length,
    impacted_task_gids: changes.map((change) => change.task_gid),
    rank_changes: changes,
  });
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

function addRetryFailureCause(
  failure: AiWorkflowRetryableFailureError,
  issue: AiWorkflowValidationIssue,
  secondaryError: unknown,
  message: string,
): AiWorkflowRetryableFailureError {
  return new AiWorkflowRetryableFailureError(
    [issue, ...failure.issues],
    failure.candidateDigest,
    failure.recoveryAction,
    new AggregateError(
      [failure, secondaryError],
      message,
      { cause: failure },
    ),
  );
}

function safeErrorDescription(error: unknown): AiWorkflowSafeErrorDescription {
  if (error instanceof AiWorkflowRetryableFailureError) {
    return "AI変更案の検証に失敗しました。";
  }
  if (error instanceof CodexSessionOutputValidationError) {
    return "Codexの構造化出力を検証できませんでした。";
  }
  if (error instanceof AiWorkflowProposalFileError) {
    return "AI変更案ファイルを安全に処理できませんでした。";
  }
  if (error instanceof AggregateError) {
    return "複数の処理に失敗しました。";
  }
  if (error instanceof z.ZodError) {
    return "構造化データの検証に失敗しました。";
  }
  if (error instanceof Error) {
    return "処理に失敗しました。";
  }
  return "Error以外の値が例外として送出されました。";
}

function safeNonErrorName(error: unknown): string {
  if (error == null) {
    return "Nullish";
  }
  if (typeof error === "object") {
    return "Object";
  }
  if (typeof error === "function") {
    return "Function";
  }
  return typeof error;
}

const safeErrorConstructorNameSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u);

function safeErrorName(error: Error): string {
  const prototype: unknown = Object.getPrototypeOf(error);
  if (typeof prototype !== "object" || prototype == null) {
    return "Error";
  }
  const constructor: unknown = Reflect.get(prototype, "constructor");
  if (typeof constructor !== "function") {
    return "Error";
  }
  const parsedName = safeErrorConstructorNameSchema.safeParse(
    Reflect.get(constructor, "name"),
  );
  return parsedName.success ? parsedName.data : "Error";
}

function safeStackFrames(error: Error): string[] {
  if (typeof error.stack !== "string") {
    return [];
  }
  return error.stack
    .split(/\r?\n/u)
    .filter((frame) => /^\s+at\s/u.test(frame));
}

function createSafeErrorProjection(error: unknown): AiWorkflowSafeErrorProjection {
  const nodeIds = new WeakMap<object, string>();
  let nextNodeNumber = 1;
  function project(value: unknown): AiWorkflowSafeErrorProjection {
    if ((typeof value === "object" && value != null) || typeof value === "function") {
      if (nodeIds.has(value)) {
        const existingNodeId = nodeIds.get(value);
        if (existingNodeId == null) {
          throw new Error("再試行ログの原因参照を取得できません。");
        }
        return { kind: "reference", node_id: existingNodeId };
      }
      const nodeId = `error-${nextNodeNumber}`;
      nextNodeNumber += 1;
      nodeIds.set(value, nodeId);
      return projectDetail(value, nodeId);
    }
    const nodeId = `error-${nextNodeNumber}`;
    nextNodeNumber += 1;
    return projectDetail(value, nodeId);
  }
  function projectDetail(
    value: unknown,
    nodeId: string,
  ): AiWorkflowSafeErrorProjection {
    const isError = value instanceof Error;
    const cause: AiWorkflowSafeErrorCause = isError && Object.hasOwn(value, "cause")
      ? { kind: "present", value: project(value.cause) }
      : { kind: "absent" };
    const aggregateErrors = value instanceof AggregateError
      ? Array.from(value.errors, (nestedError) => project(nestedError))
      : [];
    return {
      kind: "error",
      node_id: nodeId,
      error_name: isError ? safeErrorName(value) : safeNonErrorName(value),
      description: safeErrorDescription(value),
      stack_frames: isError ? safeStackFrames(value) : [],
      cause,
      aggregate_errors: aggregateErrors,
    };
  }
  return aiWorkflowSafeErrorProjectionSchema.parse(project(error));
}

function combineTurnExecutionAndDisposalFailures(
  executionError: unknown,
  disposalError: unknown,
): DiagnosticFailureDispositionError {
  return combineDiagnosticFailures([executionError, disposalError]);
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
    cause: createSafeErrorProjection(failure),
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
    const proposalFile = aiWorkflowProposalFileLeaseSchema.parse(
      this.options.proposalFileStore.createDraft(baseProposal?.proposal),
    );
    const execution = await this.executeTurn({
      request,
      signal,
      baseProposal,
      turnGeneration,
      pendingWithdrawConfirmation,
      logicalTurnId,
      proposalFile,
    });
    const disposal = this.disposeTurnFilesSafely(
      execution.proposalFile.proposal_file_id,
      logicalTurnId,
    );
    if (execution.kind === "failed") {
      if (disposal.kind === "failed") {
        throw combineTurnExecutionAndDisposalFailures(
          execution.error,
          disposal.error,
        );
      }
      throw execution.error;
    }
    if (disposal.kind === "failed") {
      throw new DiagnosticFailureDispositionError({
        kind: "unrecorded_only",
        unrecorded_error: disposal.error,
        response_error: disposal.error,
      });
    }
    return this.commitTurn(execution.commit);
  }

  private async executeTurn(
    input: TurnExecutionInput,
  ): Promise<TurnExecutionResult> {
    let proposalFile = input.proposalFile;
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
              validationErrorsPath: retryState.validationErrorsPath,
              failedAttempt: retryState.failedAttempt,
            };
        try {
          const commit = await this.executeTurnAttempt({
            ...input,
            proposalFile,
            attempt,
            retryPromptContext,
          });
          return { kind: "succeeded", commit, proposalFile };
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
          const classification = this.classifyRetryFailure(error, proposalFile);
          if (classification.kind === "not_retryable") {
            throw error;
          }
          let failure = classification.failure;
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
          const writeResult = this.writeValidationErrorsSafely(
            input.logicalTurnId,
            validationErrors,
          );
          const writeFailure = writeResult.kind === "failed"
            ? addRetryFailureCause(
                failure,
                aiWorkflowValidationIssueSchema.parse({
                  phase: "proposal_file",
                  code: "validation_errors_write_failed",
                  json_pointer: "",
                }),
                writeResult.error,
                "検証エラーファイルを書き込めませんでした。",
              )
            : failure;
          if (attempt === aiWorkflowMaximumRetryAttempts) {
            const logResult = safelyLogRetryEvent(
              this.options.logRetryEvent,
              createRetryLogEvent(
                "error",
                this.options.sessionId,
                input.logicalTurnId,
                attempt,
                writeFailure,
                previousDigest,
                "stop",
              ),
            );
            const finalFailure = new AiWorkflowError(
              "AI変更案の訂正を3回の試行で完了できませんでした。",
              writeFailure,
            );
            const recordedFinalFailure = logResult.kind === "succeeded"
              ? new DiagnosticFailureDispositionError({
                  kind: "recorded_only",
                  recorded_error: finalFailure,
                  response_error: finalFailure,
                })
              : finalFailure;
            const secondaryErrors = [
              ...(writeResult.kind === "failed" ? [writeResult.error] : []),
              ...(logResult.kind === "failed" ? [logResult.error] : []),
            ];
            if (secondaryErrors.length > 0) {
              if (logResult.kind === "succeeded") {
                throw combineDiagnosticFailures([
                  recordedFinalFailure,
                  ...secondaryErrors,
                ]);
              }
              throw new AggregateError(
                [recordedFinalFailure, ...secondaryErrors],
                "AI変更案の最終検証失敗と後処理に失敗しました。",
                { cause: recordedFinalFailure },
              );
            }
            throw recordedFinalFailure;
          }
          if (writeResult.kind === "failed") {
            const logResult = safelyLogRetryEvent(
              this.options.logRetryEvent,
              createRetryLogEvent(
                "error",
                this.options.sessionId,
                input.logicalTurnId,
                attempt,
                writeFailure,
                previousDigest,
                "stop",
              ),
            );
            const validationWriteFailure = new AggregateError(
              [
                writeFailure,
                ...(logResult.kind === "failed" ? [logResult.error] : []),
              ],
              "AI変更案の検証失敗をAI向けファイルへ保存できませんでした。",
              { cause: writeFailure },
            );
            if (logResult.kind === "succeeded") {
              throw new DiagnosticFailureDispositionError({
                kind: "recorded_only",
                recorded_error: validationWriteFailure,
                response_error: validationWriteFailure,
              });
            }
            throw validationWriteFailure;
          }
          if (failure.recoveryAction === "fresh_lease") {
            const refreshed = this.options.proposalFileStore.refreshDraft(
              proposalFile.proposal_file_id,
              input.baseProposal?.proposal,
            );
            switch (refreshed.kind) {
              case "refreshed":
                proposalFile = aiWorkflowProposalFileLeaseSchema.parse(refreshed.lease);
                break;
              case "refreshed_with_boundary_error": {
                proposalFile = aiWorkflowProposalFileLeaseSchema.parse(refreshed.lease);
                failure = addRetryFailureCause(
                  failure,
                  aiWorkflowValidationIssueSchema.parse({
                    phase: "proposal_file",
                    code: "proposal_file_boundary_violation",
                    json_pointer: "",
                  }),
                  refreshed.error,
                  "変更案ファイル再発行時に境界違反を検出しました。",
                );
                break;
              }
              case "blocked":
                {
                  const recoveryFailure = addRetryFailureCause(
                    failure,
                    aiWorkflowValidationIssueSchema.parse({
                      phase: "proposal_file",
                      code: "proposal_file_boundary_violation",
                      json_pointer: "",
                    }),
                    refreshed.error,
                    "変更案ファイルを安全に再発行できませんでした。",
                  );
                  const logResult = safelyLogRetryEvent(
                    this.options.logRetryEvent,
                    createRetryLogEvent(
                      "error",
                      this.options.sessionId,
                      input.logicalTurnId,
                      attempt,
                      recoveryFailure,
                      previousDigest,
                      "stop",
                    ),
                  );
                  const recoveryErrors = [
                    recoveryFailure,
                    ...(logResult.kind === "failed" ? [logResult.error] : []),
                  ];
                  const recoveryFailureWithLogResult = new AggregateError(
                    recoveryErrors,
                    "変更案ファイルの再発行と検証失敗の回復に失敗しました。",
                    { cause: recoveryFailure },
                  );
                  if (logResult.kind === "succeeded") {
                    throw new DiagnosticFailureDispositionError({
                      kind: "recorded_only",
                      recorded_error: recoveryFailureWithLogResult,
                      response_error: recoveryFailureWithLogResult,
                    });
                  }
                  throw recoveryFailureWithLogResult;
                }
            }
          }
          const validationErrorsPath = writeResult.path;
          retryState = {
            kind: "pending",
            failure,
            previousDigest,
            validationErrorsPath,
            failedAttempt: attempt,
          };
        }
      }
      throw new Error("再試行上限を超えてAI変更案の試行が継続しました。");
    } catch (error: unknown) {
      return { kind: "failed", error, proposalFile };
    }
  }

  private classifyRetryFailure(
    error: unknown,
    proposalFile: AiWorkflowProposalFileLease,
  ):
    | { readonly kind: "retryable"; readonly failure: AiWorkflowRetryableFailureError }
    | { readonly kind: "not_retryable" } {
    if (error instanceof AiWorkflowRetryableFailureError) {
      return { kind: "retryable", failure: error };
    }
    if (!(error instanceof CodexSessionOutputValidationError)) {
      return { kind: "not_retryable" };
    }
    try {
      return {
        kind: "retryable",
        failure: createStructuredOutputFailure(
          error,
          this.options.proposalFileStore.inspectProposalCandidate(
            proposalFile.proposal_file_id,
          ),
        ),
      };
    } catch (inspectionError: unknown) {
      if (!(inspectionError instanceof AiWorkflowRetryableFailureError)) {
        throw inspectionError;
      }
      const outputFailure = createStructuredOutputFailure(error, inspectionError.candidateDigest);
      return {
        kind: "retryable",
        failure: new AiWorkflowRetryableFailureError(
          [...outputFailure.issues, ...inspectionError.issues],
          inspectionError.candidateDigest,
          inspectionError.recoveryAction,
          new AggregateError(
            [error, inspectionError],
            "構造化出力と提案ファイルの検証に失敗しました。",
            { cause: error },
          ),
        ),
      };
    }
  }

  private writeValidationErrorsSafely(
    logicalTurnId: string,
    errors: AiWorkflowValidationErrors,
  ):
    | { readonly kind: "written"; readonly path: string }
    | { readonly kind: "failed"; readonly error: unknown } {
    try {
      return {
        kind: "written",
        path: this.options.proposalFileStore.writeValidationErrors(
          logicalTurnId,
          errors,
        ),
      };
    } catch (error: unknown) {
      return { kind: "failed", error };
    }
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
      proposalFile,
      attempt,
      retryPromptContext,
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
          this.options.session.freezeTaskctlSnapshot(taskctlSnapshot);
          updateResources({
            kind: "collector_active_snapshot_frozen",
            attemptId,
          });
          preparedState = { kind: "ready", value: prepared };
          return [{
            type: "text",
            text: createTurnPrompt(
              request,
              prepared,
              proposalFile,
              retryPromptContext,
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
    if (generatedResponse.kind === "proposal_file_error") {
      const failure = this.proposalFileWriteFailure(proposalFile, generatedResponse);
      throw failure;
    }
    let validatedResponse: ValidatedGeneratedResponse;
    if (generatedResponse.kind === "proposal") {
      const candidate = this.readProposalFile(
        generatedResponse.proposal_file_id,
        proposalFile,
      );
      const response = codexResponseSchema.parse({
        kind: generatedResponse.kind,
        message: generatedResponse.message,
        questions: generatedResponse.questions,
        proposal: candidate.proposal,
      });
      if (response.kind !== "proposal") {
        throw new Error("提案ファイル応答が提案応答へ変換されませんでした。");
      }
      validatedResponse = { kind: "proposal", response, candidate };
    } else {
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
      const pending = createPendingWithdrawConfirmation(response, turnPrepared);
      const result = aiWorkflowTurnResultSchema.parse({
        kind: "no_proposal",
        message: response.message,
        questions: createRendererQuestions(
          response.questions,
          pending,
          turnPrepared.snapshot,
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
    const { response, candidate } = validatedResponse;
    const bound = bindProposalEvidence(
      proposalSchema.parse(response.proposal),
      turnPrepared,
      candidate.candidate_digest,
    );
    const proposalId = identifierSchema.parse(randomUUID());
    const stored = createStoredProposal(proposalId, bound, turnPrepared);
    const validationIssues = proposalValidationIssues(stored);
    if (validationIssues.length > 0) {
      throw new AiWorkflowRetryableFailureError(
        validationIssues,
        candidate.candidate_digest,
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

  private proposalFileWriteFailure(
    proposalFile: AiWorkflowProposalFileLease,
    response: Extract<CodexGeneratedResponse, { readonly kind: "proposal_file_error" }>,
  ): AiWorkflowRetryableFailureError {
    const issue = aiWorkflowValidationIssueSchema.parse({
      phase: "proposal_file",
      code: "proposal_file_write_failed",
      json_pointer: "/error_code",
    });
    try {
      return new AiWorkflowRetryableFailureError(
        [issue],
        this.options.proposalFileStore.inspectProposalCandidate(
          proposalFile.proposal_file_id,
        ),
        "fresh_lease",
        new AiWorkflowProposalFileError(
          "AI変更案ファイルへの書き込みに失敗しました。",
          new Error(response.error_code),
        ),
      );
    } catch (error: unknown) {
      if (!(error instanceof AiWorkflowRetryableFailureError)) {
        throw error;
      }
      return new AiWorkflowRetryableFailureError(
        [issue, ...error.issues],
        error.candidateDigest,
        "fresh_lease",
        new AggregateError(
          [new AiWorkflowProposalFileError(
            "AI変更案ファイルへの書き込みに失敗しました。",
            new Error(response.error_code),
          ), error],
          "変更案ファイルの書き込み失敗と候補ファイル確認に失敗しました。",
        ),
      );
    }
  }

  private disposeTurnFilesSafely(
    proposalFileId: string,
    logicalTurnId: string,
  ): ProposalFileDisposalResult {
    const errors: unknown[] = [];
    try {
      this.options.proposalFileStore.dispose(proposalFileId);
    } catch (error: unknown) {
      errors.push(error);
    }
    try {
      this.options.proposalFileStore.disposeValidationErrors(logicalTurnId);
    } catch (error: unknown) {
      errors.push(error);
    }
    if (errors.length === 0) {
      return { kind: "succeeded" };
    }
    if (errors.length === 1) {
      const error = errors[0];
      if (error == null) {
        return {
          kind: "failed",
          error: new Error("AIターンファイルの破棄エラーを取得できません。"),
        };
      }
      return { kind: "failed", error };
    }
    const primaryError = errors[0];
    if (primaryError == null) {
      return {
        kind: "failed",
        error: new Error("AIターンファイルの破棄エラーを取得できません。"),
      };
    }
    return {
      kind: "failed",
      error: new AggregateError(
        errors,
        "提案ファイルと検証エラーファイルの破棄に失敗しました。",
        { cause: primaryError },
      ),
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

  private readProposalFile(
    proposalFileId: string,
    expectedProposalFile: AiWorkflowProposalFileLease,
  ): AiWorkflowProposalCandidate {
    if (proposalFileId !== expectedProposalFile.proposal_file_id) {
      const issue = aiWorkflowValidationIssueSchema.parse({
        phase: "proposal_file",
        code: "proposal_file_id_mismatch",
        json_pointer: "/proposal_file_id",
      });
      let inspection:
        | { readonly kind: "inspected"; readonly digest: AiWorkflowCandidateDigest }
        | { readonly kind: "failed"; readonly error: unknown };
      try {
        inspection = {
          kind: "inspected",
          digest: this.options.proposalFileStore.inspectProposalCandidate(
            expectedProposalFile.proposal_file_id,
          ),
        };
      } catch (error: unknown) {
        inspection = { kind: "failed", error };
      }
      if (inspection.kind === "failed") {
        if (!(inspection.error instanceof AiWorkflowRetryableFailureError)) {
          throw inspection.error;
        }
        throw new AiWorkflowRetryableFailureError(
          [issue, ...inspection.error.issues],
          inspection.error.candidateDigest,
          "fresh_lease",
          new AggregateError(
            [
              new AiWorkflowProposalFileError(
                "AI応答の変更案ファイルIDが今回のAIターンへ発行したIDと一致しません。",
              ),
              inspection.error,
            ],
            "変更案ファイルIDの不一致と発行済みファイルの確認に失敗しました。",
          ),
        );
      }
      throw new AiWorkflowRetryableFailureError(
        [issue],
        inspection.digest,
        "fresh_lease",
        new AiWorkflowProposalFileError(
          "AI応答の変更案ファイルIDが今回のAIターンへ発行したIDと一致しません。",
        ),
      );
    }
    return this.options.proposalFileStore.readProposal(proposalFileId);
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
    this.options.proposalFileStore.disposeAll();
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
