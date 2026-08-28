import { randomUUID } from "node:crypto";
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
  type Dependency,
  type ObsidianLink,
  type Task,
  type TaskSnapshot,
} from "../../../shared/domain";
import {
  codexResponseSchema,
  proposalOperationSchema,
  proposalSchema,
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
  type AiWorkflowSelection,
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
  createObsidianEvidenceLocator,
  createTaskEvidenceLocator,
  trustedStatusEvidenceReferencesSchema,
  validateProposal,
  validateProposalGraph,
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
  AiWorkflowSelectionError,
  AiWorkflowStateError,
  AiWorkflowSyncError,
} from "./errors";

const maximumWorkflowProposals = 32;

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

type ValidationOperation = {
  readonly kind: "valid" | "invalid";
  readonly group_id: string;
  readonly operation_id: string;
  readonly errors?: readonly { readonly code: string; readonly message: string }[];
};

type ValidationGroup = {
  readonly group_id: string;
  readonly atomic: boolean;
  readonly applicable: boolean;
  readonly operation_ids: readonly string[];
};

type PreparedTurn = {
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline: BaselineSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly taskctl_snapshot: TaskctlSnapshot;
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
};

type StoredProposal = {
  readonly proposal_id: string;
  readonly proposal: Proposal;
  readonly snapshot: AiWorkflowSnapshot;
  readonly baseline: BaselineSnapshot;
  readonly baseline_snapshot_hash: string;
  readonly basic_validation: ProposalValidationResult;
  readonly graph_validation: GraphValidationResult;
  readonly selected_operation_ids: readonly string[];
  readonly explicit_split_request_locators: readonly string[];
  readonly trusted_status_evidence: readonly TrustedStatusEvidenceReference[];
};

export type TrustedExternalStatusEvidence = Extract<
  TrustedStatusEvidenceReference,
  { readonly kind: "external_tool" }
>;

/** Asana適用前に再取得状態を準備する入力です。 */
export type ApprovalPreparationInput = {
  readonly proposal: Proposal;
  readonly baseline_snapshot: BaselineSnapshot;
  readonly graph_validation_result: GraphValidationResult;
  readonly selected_operation_ids: readonly string[];
};

/** AIターンへ渡す同期済み状態を供給する関数の型です。 */
export type AiWorkflowSnapshotProvider = (
  signal: AbortSignal,
) => AiWorkflowSnapshot | PromiseLike<AiWorkflowSnapshot>;

/** ターン中のtaskctl参照状態を供給する関数の型です。 */
export type AiWorkflowTaskctlSnapshotProvider = (
  signal: AbortSignal,
) => TaskctlSnapshot | PromiseLike<TaskctlSnapshot>;

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

/** 最新状態を再取得してAsana適用入力を作る関数の型です。 */
export type AiWorkflowApprovalInputProvider = (
  input: ApprovalPreparationInput,
  signal: AbortSignal,
) => AsanaProposalApplicationInput | PromiseLike<AsanaProposalApplicationInput>;

/** オンライン接続の有無を返す関数の型です。 */
export type AiWorkflowOnlineStateProvider = () => boolean;

/** AIワークフローの依存境界を検証する入力型です。 */
export interface AiWorkflowOptions {
  readonly session: AiWorkflowSessionPort;
  readonly snapshotProvider: AiWorkflowSnapshotProvider;
  readonly taskctlSnapshotProvider: AiWorkflowTaskctlSnapshotProvider;
  readonly externalStatusEvidenceCollector: AiWorkflowExternalStatusEvidenceCollector;
  readonly applicationCoordinator: Pick<AsanaProposalApplicationCoordinator, "apply">;
  readonly prepareApprovalInput: AiWorkflowApprovalInputProvider;
  readonly isOnline: AiWorkflowOnlineStateProvider;
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

const snapshotProviderSchema = z.custom<AiWorkflowSnapshotProvider>(
  (value) => typeof value === "function",
  "AIスナップショット供給関数が必要です。",
);

const taskctlSnapshotProviderSchema = z.custom<AiWorkflowTaskctlSnapshotProvider>(
  (value) => typeof value === "function",
  "taskctlスナップショット供給関数が必要です。",
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

const aiWorkflowOptionsSchema = z
  .object({
    session: sessionPortSchema,
    snapshotProvider: snapshotProviderSchema,
    taskctlSnapshotProvider: taskctlSnapshotProviderSchema,
    externalStatusEvidenceCollector: externalStatusEvidenceCollectorSchema,
    applicationCoordinator: applicationCoordinatorSchema,
    prepareApprovalInput: approvalInputProviderSchema,
    isOnline: onlineStateProviderSchema,
  })
  .strict();

async function cancelExternalStatusEvidenceCollection(
  collector: AiWorkflowExternalStatusEvidenceCollector,
  turnId: string,
  turnError: unknown,
): Promise<void> {
  try {
    await collector.cancelTurn(turnId);
  } catch (cancellationError: unknown) {
    const cleanupError = new AiWorkflowError(
      "外部状態根拠のターン記録を破棄できませんでした。",
      cancellationError,
    );
    if (turnError == null) {
      throw cleanupError;
    }
    throw new AiWorkflowError(
      "AIターンの失敗後に外部状態根拠の記録も破棄できませんでした。",
      new AggregateError([turnError, cleanupError]),
    );
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
  if (task.parent_gid != null) {
    return { ...withDue, parent_gid: task.parent_gid };
  }
  return withDue;
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

function createTrustedStatusEvidence(
  snapshot: AiWorkflowSnapshot,
  userMessageLocator: string,
  externalEvidence: readonly TrustedExternalStatusEvidence[],
): readonly TrustedStatusEvidenceReference[] {
  const references: TrustedStatusEvidenceReference[] = [{
    kind: "user_message",
    locator: userMessageLocator,
  }];
  const obsidianLocators = new Set<string>();
  for (const task of snapshot.tasks) {
    references.push({
      kind: "task",
      locator: createTaskEvidenceLocator(task.gid),
    });
    for (const link of task.obsidian_links) {
      obsidianLocators.add(createObsidianEvidenceLocator(link.vault_id, link.path));
    }
  }
  for (const locator of [...obsidianLocators].sort(compareStrings)) {
    references.push({ kind: "obsidian", locator });
  }
  references.push(...externalEvidence);
  return trustedStatusEvidenceReferencesSchema.parse(references);
}

function createTurnPrompt(
  request: AiWorkflowTurnRequest,
  prepared: PreparedTurn,
): string {
  const userMessageReferences = prepared.trusted_status_evidence.filter(
    (reference) => reference.kind === "user_message",
  );
  const userMessageReference = userMessageReferences[0];
  if (userMessageReference == null || userMessageReferences.length !== 1) {
    throw new AiWorkflowError("利用者メッセージの信頼済み根拠を一意に特定できません。");
  }
  const context = aiWorkflowTurnContextSchema.parse({
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    app_version: prepared.snapshot.app_version,
    project_gid: prepared.snapshot.project_gid,
    synced_at: prepared.snapshot.synced_at,
    as_of: prepared.snapshot.as_of,
  });
  const serializedContext = canonicalizeJson(context);
  return [
    "TaskHubの構造化変更案だけを検討してください。",
    `基準コンテキスト: ${serializedContext}`,
    "全操作へ同じbaseline_snapshot_hashを設定し、推測は明示してください。",
    "taskctlは読み取り専用で必要な詳細を確認できます。承認前に外部へ書き込まないでください。",
    `利用者要求の信頼済み根拠locator: ${userMessageReference.locator}`,
    "タスク根拠locatorはtask:<GID>だけを使用してください。対象タスク自身のGIDだけが検証されます。",
    "Obsidian根拠locatorはobsidian:<vault_id>:<path>だけを使用してください。対象タスクに登録済みのリンクだけが検証されます。",
    "外部ツールの構造化状態は、当該ターンの応答が返したevidence locator、status、target_task_gidだけを根拠に使用してください。",
    `明示された分割依頼locator: ${canonicalizeJson(request.explicit_split_request_locators)}`,
    `利用者要求: ${request.message}`,
  ].join("\n");
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
}): Record<string, string> {
  return { kind: reference.kind, locator: reference.locator };
}

function sanitizeProposalOperation(operation: ProposalOperation): ProposalOperation {
  const candidate: Record<string, unknown> = {
    ...operation,
    evidence_refs: operation.evidence_refs.map((reference) =>
      sanitizeEvidenceReference(reference)),
  };
  if (operation.operation === "create_task" && operation.creation.kind === "split_child") {
    candidate.creation = {
      ...operation.creation,
      instruction_reference: sanitizeEvidenceReference(operation.creation.instruction_reference),
    };
  }
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    candidate.status_evidence = {
      ...operation.status_evidence,
      reference: sanitizeEvidenceReference(operation.status_evidence.reference),
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

function groupMap(proposal: Proposal): Map<string, Proposal["groups"][number]> {
  const groups = new Map<string, Proposal["groups"][number]>();
  for (const group of proposal.groups) {
    if (groups.has(group.group_id)) {
      throw new AiWorkflowError("変更案のgroup_idが重複しています。");
    }
    groups.set(group.group_id, group);
  }
  return groups;
}

function validationOperationMap(
  result: ProposalValidationResult | GraphValidationResult,
): Map<string, ValidationOperation> {
  const map = new Map<string, ValidationOperation>();
  for (const operation of result.operations) {
    map.set(operation.operation_id, operation);
  }
  return map;
}

function validationGroupMap(
  result: ProposalValidationResult | GraphValidationResult,
): Map<string, ValidationGroup> {
  const map = new Map<string, ValidationGroup>();
  for (const group of result.groups) {
    map.set(group.group_id, group);
  }
  return map;
}

function eligibleOperationIds(
  proposal: Proposal,
  graphValidation: GraphValidationResult,
): readonly string[] {
  const operationResults = validationOperationMap(graphValidation);
  const groupResults = validationGroupMap(graphValidation);
  const selected: string[] = [];
  for (const group of proposal.groups) {
    const validationGroup = groupResults.get(group.group_id);
    if (validationGroup == null || !validationGroup.applicable) {
      continue;
    }
    for (const operation of group.operations) {
      const validation = operationResults.get(operation.operation_id);
      if (validation?.kind === "valid") {
        selected.push(operation.operation_id);
      }
    }
  }
  return selected;
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
  const withParent = after.parent == null
    ? withDue
    : { ...withDue, parent_gid: projectedTargetGid(after.parent) };
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

function resolveSelectedOperationIds(
  stored: StoredProposal,
  selection: AiWorkflowSelection,
): readonly string[] {
  const operationResults = validationOperationMap(stored.graph_validation);
  const groupResults = validationGroupMap(stored.graph_validation);
  const groups = groupMap(stored.proposal);
  const operations = operationMap(stored.proposal);
  const selected = new Set<string>();

  if (selection.kind === "all") {
    for (const operationId of eligibleOperationIds(stored.proposal, stored.graph_validation)) {
      selected.add(operationId);
    }
  } else if (selection.kind === "groups") {
    for (const groupId of selection.group_ids) {
      const group = groups.get(groupId);
      const validationGroup = groupResults.get(groupId);
      if (group == null || validationGroup == null) {
        throw new AiWorkflowSelectionError(`指定したグループ ${groupId} が存在しません。`);
      }
      if (!validationGroup.applicable) {
        throw new AiWorkflowSelectionError(`グループ ${groupId} は適用可能ではありません。`);
      }
      for (const operation of group.operations) {
        const validation = operationResults.get(operation.operation_id);
        if (validation?.kind === "valid") {
          selected.add(operation.operation_id);
        } else if (group.atomic) {
          throw new AiWorkflowSelectionError(`グループ ${groupId} に無効な操作があります。`);
        }
      }
    }
  } else {
    for (const operationId of selection.operation_ids) {
      const operation = operations.get(operationId);
      const validation = operationResults.get(operationId);
      if (operation == null || validation == null) {
        throw new AiWorkflowSelectionError(`指定した操作 ${operationId} が存在しません。`);
      }
      if (validation.kind !== "valid") {
        throw new AiWorkflowSelectionError(`操作 ${operationId} は適用可能ではありません。`);
      }
      const group = groups.get(validation.group_id);
      const validationGroup = groupResults.get(validation.group_id);
      if (group == null || validationGroup == null) {
        throw new AiWorkflowSelectionError(`操作 ${operationId} のグループが存在しません。`);
      }
      if (group.atomic) {
        if (!validationGroup.applicable) {
          throw new AiWorkflowSelectionError(`atomicグループ ${group.group_id} は適用可能ではありません。`);
        }
        for (const member of group.operations) {
          if (operationResults.get(member.operation_id)?.kind !== "valid") {
            throw new AiWorkflowSelectionError(`atomicグループ ${group.group_id} に無効な操作があります。`);
          }
          selected.add(member.operation_id);
        }
      } else {
        selected.add(operationId);
      }
    }
  }

  if (selected.size === 0) {
    throw new AiWorkflowSelectionError("適用可能な操作が選択されていません。");
  }
  const selectedCreates = new Set(
    [...selected]
      .map((operationId) => operations.get(operationId))
      .filter(
        (operation): operation is Extract<ProposalOperation, { readonly operation: "create_task" }> =>
          operation?.operation === "create_task",
      )
      .map((operation) => operation.temporary_ref),
  );
  for (const operationId of selected) {
    const operation = operations.get(operationId);
    if (operation == null) {
      throw new AiWorkflowSelectionError(`指定した操作 ${operationId} が存在しません。`);
    }
    const temporaryRefs = collectTemporaryReferences(operation);
    for (const temporaryRef of temporaryRefs) {
      if (!selectedCreates.has(temporaryRef)) {
        throw new AiWorkflowSelectionError(`一時参照 ${temporaryRef} の作成操作が選択されていません。`);
      }
    }
  }
  return stored.proposal.groups.flatMap((group) =>
    group.operations
      .filter((operation) => selected.has(operation.operation_id))
      .map((operation) => operation.operation_id),
  );
}

function collectTemporaryReferences(operation: ProposalOperation): readonly string[] {
  const references: string[] = [];
  const addTarget = (target: ProposalTarget): void => {
    if (target.kind === "temporary") {
      references.push(target.ref);
    }
  };
  if (operation.operation === "create_task") {
    if (operation.creation.kind === "split_child") {
      addTarget(operation.creation.parent);
    }
    if (operation.after.parent != null) {
      addTarget(operation.after.parent);
    }
    for (const dependency of operation.after.dependencies ?? []) {
      addTarget(dependency.target);
    }
    return references;
  }
  addTarget(operation.target);
  if (operation.operation === "set_dependencies") {
    for (const dependency of operation.before) {
      addTarget(dependency.target);
    }
    for (const dependency of operation.after) {
      addTarget(dependency.target);
    }
  }
  if (operation.operation === "set_parent") {
    if (operation.before.kind !== "absent") {
      addTarget(operation.before);
    }
    if (operation.after.kind !== "absent") {
      addTarget(operation.after);
    }
  }
  return references;
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
    explicit_split_request_locators: [...stored.explicit_split_request_locators],
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
  proposal: Proposal,
  prepared: PreparedTurn,
  explicitSplitRequestLocators: readonly string[],
): StoredProposal {
  const basic = validateProposal({
    proposal,
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    managed_tasks: prepared.snapshot.tasks,
    existing_areas: prepared.snapshot.areas,
    explicit_split_request_locators: [...explicitSplitRequestLocators],
    trusted_status_evidence: [...prepared.trusted_status_evidence],
  });
  const graph = validateProposalGraph({
    proposal,
    managed_tasks: prepared.snapshot.tasks,
    basic_validation_result: basic,
  });
  return {
    proposal_id: proposalId,
    proposal,
    snapshot: prepared.snapshot,
    baseline: prepared.baseline,
    baseline_snapshot_hash: prepared.baseline_snapshot_hash,
    basic_validation: basic,
    graph_validation: graph,
    selected_operation_ids: eligibleOperationIds(proposal, graph),
    explicit_split_request_locators: [...explicitSplitRequestLocators],
    trusted_status_evidence: [...prepared.trusted_status_evidence],
  };
}

function createProposalView(stored: StoredProposal): AiWorkflowProposalView {
  const selected = [...stored.selected_operation_ids];
  const view = {
    proposal_id: stored.proposal_id,
    baseline_snapshot_hash: stored.baseline_snapshot_hash,
    proposal: sanitizeProposalForRenderer(stored.proposal),
    basic_validation: toWorkflowValidation(stored.basic_validation),
    graph_validation: toWorkflowValidation(stored.graph_validation),
    selected_operation_ids: selected,
    impact: calculateWorkflowImpact(stored.snapshot, stored.proposal, selected),
  };
  return aiWorkflowProposalViewSchema.parse(view);
}

function preserveSelection(
  proposal: Proposal,
  graphValidation: GraphValidationResult,
  previousOperationIds: readonly string[],
): readonly string[] {
  const previous = new Set(previousOperationIds);
  const operationResults = validationOperationMap(graphValidation);
  const groupResults = validationGroupMap(graphValidation);
  const selected = new Set<string>();
  for (const group of proposal.groups) {
    const groupValidation = groupResults.get(group.group_id);
    if (groupValidation == null || !groupValidation.applicable) {
      continue;
    }
    const validMembers = group.operations.filter(
      (operation) => operationResults.get(operation.operation_id)?.kind === "valid",
    );
    if (group.atomic) {
      const selectedMember = validMembers.some((operation) => previous.has(operation.operation_id));
      if (selectedMember && validMembers.length === group.operations.length) {
        for (const operation of validMembers) {
          selected.add(operation.operation_id);
        }
      }
      continue;
    }
    for (const operation of validMembers) {
      if (previous.has(operation.operation_id)) {
        selected.add(operation.operation_id);
      }
    }
  }
  return proposal.groups.flatMap((group) =>
    group.operations
      .filter((operation) => selected.has(operation.operation_id))
      .map((operation) => operation.operation_id),
  );
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

/** AI変更案をメモリ上で検証、選択、承認するサービスです。 */
export class AiWorkflowService {
  private readonly options: AiWorkflowOptions;
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly deltaListeners = new Set<CodexSessionDeltaListener>();
  private readonly removeSessionDelta: () => void;
  private listenerErrorCount = 0;
  private disposed = false;

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
    if (this.disposed) {
      throw new AiWorkflowStateError("AIワークフローは終了しています。");
    }
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** 同期後の基準値を固定してCodexターンを実行します。 */
  public async startTurn(
    input: AiWorkflowTurnRequest,
    signal: AbortSignal,
  ): Promise<AiWorkflowTurnResult> {
    if (this.disposed) {
      throw new AiWorkflowStateError("AIワークフローは終了しています。");
    }
    const request = aiWorkflowTurnRequestSchema.parse(input);
    throwIfAborted(signal);
    let retryCount = 0;
    while (retryCount <= 1) {
      let prepared: PreparedTurn | undefined;
      let snapshotFrozen = false;
      const turnId = identifierSchema.parse(randomUUID());
      const userMessageLocator = `user-message:${turnId}`;
      let evidenceCollectionActive = false;
      let turnError: unknown;
      try {
        await this.options.externalStatusEvidenceCollector.beginTurn(turnId, signal);
        evidenceCollectionActive = true;
        const turnResult = await this.options.session.startTurnWithPreparation(
          async (turnSignal): Promise<CodexSessionTurnInput> => {
            try {
              const rawSnapshot = await this.options.snapshotProvider(turnSignal);
              const snapshot = aiWorkflowSnapshotSchema.parse(rawSnapshot);
              const baseline = createBaselineSnapshot(snapshot);
              const baselineSnapshotHash = hashBaselineSnapshot(baseline);
              const rawTaskctlSnapshot = await this.options.taskctlSnapshotProvider(turnSignal);
              const taskctlSnapshot = taskctlSnapshotSchema.parse(rawTaskctlSnapshot);
              assertTaskctlSnapshotMatchesBaseline(snapshot, baseline, taskctlSnapshot);
              prepared = {
                snapshot,
                baseline,
                baseline_snapshot_hash: baselineSnapshotHash,
                taskctl_snapshot: taskctlSnapshot,
                trusted_status_evidence: createTrustedStatusEvidence(
                  snapshot,
                  userMessageLocator,
                  [],
                ),
              };
              this.options.session.freezeTaskctlSnapshot(taskctlSnapshot);
              snapshotFrozen = true;
              return [{
                type: "text",
                text: createTurnPrompt(request, prepared),
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
        if (prepared == null) {
          throw new AiWorkflowSyncError(new Error("同期後の基準値が作成されませんでした。"));
        }
        const externalEvidence = trustedExternalStatusEvidenceSchema.parse(
          await this.options.externalStatusEvidenceCollector.finishTurn(
            turnId,
            signal,
          ),
        );
        evidenceCollectionActive = false;
        prepared = {
          ...prepared,
          trusted_status_evidence: createTrustedStatusEvidence(
            prepared.snapshot,
            userMessageLocator,
            externalEvidence,
          ),
        };
        const response = codexResponseSchema.parse(turnResult.response);
        if (response.kind === "no_proposal") {
          return aiWorkflowTurnResultSchema.parse({
            kind: "no_proposal",
            message: response.message,
            questions: response.questions,
            retry_count: retryCount,
          });
        }
        const proposalId = identifierSchema.parse(randomUUID());
        const stored = createStoredProposal(
          proposalId,
          proposalSchema.parse(response.proposal),
          prepared,
          request.explicit_split_request_locators,
        );
        this.storeProposal(stored);
        const view = createProposalView(stored);
        return aiWorkflowTurnResultSchema.parse({
          kind: "proposal",
          message: response.message,
          questions: response.questions,
          proposal: view,
          retry_count: retryCount,
        });
      } catch (error: unknown) {
        turnError = error;
        if (error instanceof CodexSessionOutputValidationError && retryCount === 0) {
          retryCount += 1;
          continue;
        }
        if (error instanceof CodexSessionSyncError) {
          throw new AiWorkflowSyncError(error);
        }
        throw error;
      } finally {
        if (evidenceCollectionActive) {
          await cancelExternalStatusEvidenceCollection(
            this.options.externalStatusEvidenceCollector,
            turnId,
            turnError,
          );
        }
        if (snapshotFrozen) {
          this.options.session.releaseTaskctlSnapshot();
        }
      }
    }
    throw new AiWorkflowError("構造化出力の再試行に失敗しました。");
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
    const updated: StoredProposal = {
      ...stored,
      proposal: editedProposal,
      basic_validation: validation.basic,
      graph_validation: validation.graph,
      selected_operation_ids: preserveSelection(
        editedProposal,
        validation.graph,
        stored.selected_operation_ids,
      ),
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
    if (this.options.isOnline() !== true) {
      throw new AiWorkflowOfflineError();
    }
    const approvalInput = await this.options.prepareApprovalInput(
      {
        proposal: stored.proposal,
        baseline_snapshot: stored.baseline,
        graph_validation_result: stored.graph_validation,
        selected_operation_ids: selectedOperationIds,
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
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeSessionDelta();
    this.deltaListeners.clear();
    this.proposals.clear();
    this.options.session.releaseTaskctlSnapshot();
  }

  private getStoredProposal(proposalId: string): StoredProposal {
    const parsedProposalId = identifierSchema.parse(proposalId);
    const stored = this.proposals.get(parsedProposalId);
    if (stored == null) {
      throw new AiWorkflowProposalNotFoundError();
    }
    return stored;
  }

  private storeProposal(stored: StoredProposal): void {
    if (this.proposals.size >= maximumWorkflowProposals) {
      const oldest = this.proposals.keys().next().value;
      if (oldest == null) {
        throw new AiWorkflowError("変更案の保持領域を確認できません。");
      }
      this.proposals.delete(oldest);
    }
    this.proposals.set(stored.proposal_id, stored);
    if (this.proposals.size > maximumWorkflowProposals) {
      throw new AiWorkflowError("変更案の保持上限を超えました。");
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
