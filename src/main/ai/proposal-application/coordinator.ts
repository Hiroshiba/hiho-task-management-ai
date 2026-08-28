import { z } from "zod";
import {
  asanaTaskResponseSchema,
  externalTaskGidSchema,
  isoDateTimeSchema,
  parseCustomExternalData,
  serializeCustomExternalData,
  type AsanaTaskResponse,
} from "../../../shared/domain";
import {
  proposalApprovalResultSchema,
  classifyProposalConflicts,
  type ProposalApprovalResult,
} from "../proposal-approval";
import {
  type Proposal,
  type ProposalGroup,
  type ProposalOperation,
} from "../../../shared/ai";
import {
  applicationJournalResultSchema,
  applicationJournalSchema,
  type ApplicationJournal,
  type ApplicationJournalResult,
  type ApplicationJournalStage,
} from "../../../shared/storage";
import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransportError,
} from "../../asana/transport";
import { AsanaReadClient } from "../../asana/client/client";
import { AsanaProposalOperationWriter } from "./operation-writer";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  asanaProposalOperationWriterResultSchema,
  asanaProposalRecoveryInputSchema,
  asanaProposalRecoveryResultSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryInput,
  type AsanaProposalRecoveryResult,
  type AsanaProposalOperationWriterInput,
  type AsanaProposalOperationWriterResult,
  type AsanaProposalWriterTemporaryRefMapping,
} from "./schemas";

type ApplicationOperationResult =
  AsanaProposalApplicationResult["operations"][number];
type ApplicationGroupResult = AsanaProposalApplicationResult["groups"][number];
type ApplicationReasonCode = ApplicationOperationResult["reason_code"];
type RecoveryReasonCode =
  AsanaProposalRecoveryResult["unresolved_journals"][number]["reason_code"];
type ApplicationOutcome = ApplicationOperationResult["outcome"];
type ApplicationGroupOutcome = ApplicationGroupResult["outcome"];
type WriterInput = AsanaProposalOperationWriterInput;
type WriterResult = AsanaProposalOperationWriterResult;
type BaselineExternal = NonNullable<WriterInput["baseline_external_data"]>;
type OperationContext = {
  readonly group: ProposalGroup;
  readonly operation: ProposalOperation;
};
type ApplicationJournalStorePort = {
  readonly create: (entry: ApplicationJournal) => void;
  readonly updateStage: (
    proposalId: string,
    operationId: string,
    stage: ApplicationJournalStage,
  ) => void;
  readonly complete: (
    proposalId: string,
    operationId: string,
    finalResult: ApplicationJournalResult,
  ) => void;
  readonly get: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
  readonly getIncomplete: () => readonly ApplicationJournal[];
};
type StorageDatabaseJournalPort = {
  readonly createApplicationJournal: (entry: ApplicationJournal) => void;
  readonly updateApplicationJournalStage: (
    proposalId: string,
    operationId: string,
    stage: ApplicationJournalStage,
  ) => void;
  readonly completeApplicationJournal: (
    proposalId: string,
    operationId: string,
    finalResult: ApplicationJournalResult,
  ) => void;
  readonly getApplicationJournal: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
  readonly getIncompleteApplicationJournals: () => readonly ApplicationJournal[];
};
type JournalPort = ApplicationJournalStorePort | StorageDatabaseJournalPort;
type RecoveryTargetValidation =
  | { readonly kind: "valid"; readonly task_gid?: string }
  | { readonly kind: "invalid" };
type PendingJournal = {
  readonly entry: ApplicationJournal;
  readonly context: OperationContext;
  readonly task_gid: string;
  readonly operationResults: Map<string, ApplicationOperationResult>;
};
type RecoveryApplicationState = {
  readonly application: AsanaProposalRecoveryInput["applications"][number];
  readonly selected: ReadonlySet<string>;
  readonly operationResults: Map<string, ApplicationOperationResult>;
};

const journalStages: readonly ApplicationJournalStage[] = [
  "started",
  "task_created",
  "attributes_applied",
  "relations_applied",
  "read_back",
  "metadata_verified",
  "ranking_recalculated",
];

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
  if (!signal.aborted) {
    return;
  }
  signal.throwIfAborted();
  throw new Error("処理が中断されました。");
}

function isKnownAsanaOperationalError(error: unknown): boolean {
  return error instanceof AsanaTransportError
    || error instanceof AsanaResponseError
    || error instanceof AsanaAuthenticationError
    || error instanceof AsanaEventsResetError
    || error instanceof AsanaHttpError
    || error instanceof AsanaPaymentRequiredError
    || error instanceof AsanaRateLimitError;
}

function normalizeJournalPort(journal: JournalPort): ApplicationJournalStorePort {
  if ("create" in journal) {
    return journal;
  }
  return {
    create: (entry) => journal.createApplicationJournal(entry),
    updateStage: (proposalId, operationId, stage) =>
      journal.updateApplicationJournalStage(proposalId, operationId, stage),
    complete: (proposalId, operationId, finalResult) =>
      journal.completeApplicationJournal(proposalId, operationId, finalResult),
    get: (proposalId, operationId) =>
      journal.getApplicationJournal(proposalId, operationId),
    getIncomplete: () => journal.getIncompleteApplicationJournals(),
  };
}

function flattenProposal(proposal: Proposal): readonly OperationContext[] {
  return proposal.groups.flatMap((group) =>
    group.operations.map((operation) => ({ group, operation })));
}

function operationMap(
  contexts: readonly OperationContext[],
): ReadonlyMap<string, OperationContext> {
  const result = new Map<string, OperationContext>();
  for (const context of contexts) {
    if (result.has(context.operation.operation_id)) {
      throw new Error("proposalのoperation_idが重複しています。");
    }
    result.set(context.operation.operation_id, context);
  }
  return result;
}

function approvalOperationMap(
  approval: ProposalApprovalResult,
): ReadonlyMap<string, ProposalApprovalResult["operations"][number]> {
  const result = new Map<string, ProposalApprovalResult["operations"][number]>();
  for (const operation of approval.operations) {
    if (result.has(operation.operation_id)) {
      throw new Error("承認競合結果のoperation_idが重複しています。");
    }
    result.set(operation.operation_id, operation);
  }
  return result;
}

function approvalGroupMap(
  approval: ProposalApprovalResult,
): ReadonlyMap<string, ProposalApprovalResult["groups"][number]> {
  const result = new Map<string, ProposalApprovalResult["groups"][number]>();
  for (const group of approval.groups) {
    if (result.has(group.group_id)) {
      throw new Error("承認競合結果のgroup_idが重複しています。");
    }
    result.set(group.group_id, group);
  }
  return result;
}

function temporaryMappingMap(
  mappings: readonly AsanaProposalWriterTemporaryRefMapping[],
): Map<string, string> {
  const result = new Map<string, string>();
  const gids = new Set<string>();
  for (const mapping of mappings) {
    if (result.has(mapping.temporary_ref) || gids.has(mapping.task_gid)) {
      throw new Error("temporary_ref対応が重複しています。");
    }
    result.set(mapping.temporary_ref, mapping.task_gid);
    gids.add(mapping.task_gid);
  }
  return result;
}

function mappingArray(
  mappings: ReadonlyMap<string, string>,
): AsanaProposalWriterTemporaryRefMapping[] {
  return [...mappings.entries()]
    .sort((left, right) => {
      if (left[0] < right[0]) {
        return -1;
      }
      if (left[0] > right[0]) {
        return 1;
      }
      return 0;
    })
    .map(([temporary_ref, task_gid]) => ({ temporary_ref, task_gid }));
}

function addTemporaryMapping(
  mappings: Map<string, string>,
  temporaryRef: string,
  taskGid: string,
): void {
  const current = mappings.get(temporaryRef);
  if (current != null && current !== taskGid) {
    throw new Error("temporary_refの対応先が変化しました。");
  }
  for (const [ref, gid] of mappings) {
    if (ref !== temporaryRef && gid === taskGid) {
      throw new Error("同じタスクGIDへ複数のtemporary_refを対応できません。");
    }
  }
  mappings.set(temporaryRef, taskGid);
}

function targetGid(
  operation: ProposalOperation,
  mappings: ReadonlyMap<string, string>,
): string | undefined {
  if (operation.operation === "create_task") {
    return mappings.get(operation.temporary_ref);
  }
  if (operation.target.kind === "existing") {
    return operation.target.gid;
  }
  return mappings.get(operation.target.ref);
}

function temporaryTargetRef(operation: ProposalOperation): string | undefined {
  if (operation.operation === "create_task") {
    return undefined;
  }
  return operation.target.kind === "temporary" ? operation.target.ref : undefined;
}

function operationTargetForJournal(
  operation: ProposalOperation,
  mappings: ReadonlyMap<string, string>,
  uuids: ReadonlyMap<string, string>,
): ApplicationJournal["target"] {
  if (operation.operation === "create_task") {
    const uuid = uuids.get(operation.operation_id);
    if (uuid == null) {
      throw new Error("create_taskの事前発行UUIDがありません。");
    }
    return { kind: "new_task", uuid };
  }
  const gid = targetGid(operation, mappings);
  if (gid == null) {
    throw new Error("適用対象のtemporary_refを解決できません。");
  }
  return { kind: "task", gid };
}

function issueCreateUuids(
  contexts: readonly OperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  uuidGenerator: ProposalApplicationUuidGenerator,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const seen = new Set<string>();
  for (const context of contexts) {
    if (
      !selectedOperationIds.has(context.operation.operation_id)
      || context.operation.operation !== "create_task"
    ) {
      continue;
    }
    const uuid = z.uuid().parse(uuidGenerator());
    if (seen.has(uuid)) {
      throw new Error("作成UUIDが重複しています。");
    }
    seen.add(uuid);
    result.set(context.operation.operation_id, uuid);
  }
  return result;
}

function baselineExternalMap(
  entries: AsanaProposalApplicationInput["baseline_external_data"],
): Map<string, BaselineExternal> {
  const result = new Map<string, BaselineExternal>();
  for (const entry of entries) {
    if (result.has(entry.task_gid)) {
      throw new Error("適用基準外部データのタスクGIDが重複しています。");
    }
    result.set(entry.task_gid, entry.external);
  }
  return result;
}

function requireBaselineExternalFromTask(
  task: AsanaTaskResponse,
): BaselineExternal {
  if (task.external == null) {
    throw new Error("適用対象タスクのCustom external dataがありません。");
  }
  const parsed = parseCustomExternalData(task.external.data);
  if (parsed.kind !== "valid") {
    throw new Error("適用対象タスクのCustom external dataがvalidではありません。");
  }
  const expectedGid = `TaskHub:v1:task:${parsed.data.id}`;
  if (
    externalTaskGidSchema.parse(task.external.gid) !== task.external.gid
    || expectedGid !== task.external.gid
    || serializeCustomExternalData(parsed.data) !== task.external.data
  ) {
    throw new Error("適用対象タスクのCustom external dataの形式が不正です。");
  }
  return task.external;
}

function validateBaselineCoverage(
  contexts: readonly OperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, BaselineExternal>,
): void {
  for (const context of contexts) {
    if (
      !selectedOperationIds.has(context.operation.operation_id)
      || context.operation.operation === "create_task"
    ) {
      continue;
    }
    const gid = targetGid(context.operation, mappings);
    if (gid != null && !baselines.has(gid)) {
      throw new Error("選択操作の適用基準外部データがありません。");
    }
  }
}

function createWriterInput(
  context: OperationContext,
  settings: AsanaProposalApplicationInput | AsanaProposalRecoveryInput["applications"][number],
  mappings: ReadonlyMap<string, string>,
  baseline: BaselineExternal | undefined,
  createUuid: string | undefined,
  existingTask: AsanaTaskResponse | undefined,
): WriterInput {
  const common = {
    project_gid: settings.project_gid,
    workspace_gid: settings.workspace_gid,
    section_gids: settings.section_gids,
    device_id: settings.device_id,
    created_via: settings.created_via,
    activity_date: settings.activity_date,
    temporary_ref_to_gid: mappingArray(mappings),
  };
  if (context.operation.operation === "create_task") {
    if (createUuid == null) {
      throw new Error("create_taskの作成UUIDがありません。");
    }
    return {
      ...common,
      operation: context.operation,
      create_external_id: createUuid,
      ...(existingTask == null ? {} : { existing_task: existingTask }),
    };
  }
  if (baseline == null) {
    throw new Error("create_task以外の適用基準外部データがありません。");
  }
  return {
    ...common,
    operation: context.operation,
    baseline_external_data: baseline,
  };
}

function createOperationResult(
  groupId: string,
  operationId: string,
  outcome: ApplicationOutcome,
  reasonCode: ApplicationReasonCode,
  taskGid: string | undefined,
): ApplicationOperationResult {
  if (taskGid == null) {
    return {
      group_id: groupId,
      operation_id: operationId,
      outcome,
      reason_code: reasonCode,
    };
  }
  return {
    group_id: groupId,
    operation_id: operationId,
    task_gid: taskGid,
    outcome,
    reason_code: reasonCode,
  };
}

function validateWriterResult(
  context: OperationContext,
  result: WriterResult,
  expectedTaskGid: string | undefined,
): WriterResult {
  const parsed = asanaProposalOperationWriterResultSchema.parse(result);
  if (parsed.operation_id !== context.operation.operation_id) {
    throw new Error("writerのoperation_idが一致しません。");
  }
  if (expectedTaskGid != null && parsed.task_gid !== expectedTaskGid) {
    throw new Error("writerの対象GIDが一致しません。");
  }
  return parsed;
}

function writerResultToApplicationResult(
  context: OperationContext,
  result: WriterResult,
): ApplicationOperationResult {
  switch (result.outcome) {
    case "applied":
      return createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "applied",
        "applied",
        result.task_gid,
      );
    case "already_applied":
      return createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        result.task_gid,
      );
    case "conflict":
      if (result.side_effect === "possible") {
        return unknownOperationResult(context, "recovery_required", result.task_gid);
      }
      return createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "not_applied",
        "writer_conflict",
        result.task_gid,
      );
  }
}

function recordJournalResultBeforeRanking(
  journal: ApplicationJournalStorePort,
  entry: ApplicationJournal,
  result: WriterResult,
): ApplicationJournal | undefined {
  if (result.outcome === "conflict") {
    if (result.side_effect === "possible") {
      return undefined;
    }
    journal.complete(entry.proposal_id, entry.operation_id, "not_applied");
    return undefined;
  }
  advanceJournal(journal, entry, "metadata_verified");
  return { ...entry, stage: "metadata_verified" };
}

async function finalizePendingJournals(
  pending: readonly PendingJournal[],
  journal: ApplicationJournalStorePort,
  postApply: ProposalApplicationPostApply,
  signal: AbortSignal,
): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  try {
    throwIfAborted(signal);
    await postApply(signal);
    throwIfAborted(signal);
  } catch (error) {
    if (signal.aborted) {
      signal.throwIfAborted();
      throw error;
    }
    if (!isKnownAsanaOperationalError(error)) {
      throw error;
    }
    for (const item of pending) {
      item.operationResults.set(
        item.context.operation.operation_id,
        unknownOperationResult(item.context, "recovery_required", item.task_gid),
      );
    }
    return;
  }
  for (const item of pending) {
    advanceJournal(journal, item.entry, "ranking_recalculated");
    journal.complete(item.entry.proposal_id, item.entry.operation_id, "applied");
  }
}

function advanceJournal(
  journal: ApplicationJournalStorePort,
  entry: ApplicationJournal,
  targetStage: ApplicationJournalStage,
): void {
  const currentIndex = journalStages.indexOf(entry.stage);
  const targetIndex = journalStages.indexOf(targetStage);
  if (currentIndex < 0 || targetIndex < 0) {
    throw new Error("適用ジャーナルの段階が不正です。");
  }
  if (targetIndex < currentIndex) {
    throw new Error("適用ジャーナルの段階を後退させられません。");
  }
  for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
    const stage = journalStages[index];
    if (stage == null) {
      throw new Error("適用ジャーナルの段階が見つかりません。");
    }
    journal.updateStage(entry.proposal_id, entry.operation_id, stage);
  }
}

function applicationGroupOutcome(
  operations: readonly ApplicationOperationResult[],
): ApplicationGroupOutcome {
  const hasUnknown = operations.some((operation) => operation.outcome === "unknown");
  const hasApplied = operations.some((operation) => operation.outcome === "applied");
  const hasAlreadyApplied = operations.some(
    (operation) => operation.outcome === "already_applied",
  );
  const hasNotApplied = operations.some(
    (operation) => operation.outcome === "not_applied",
  );
  if (hasUnknown && !hasApplied && !hasAlreadyApplied) {
    return "unknown";
  }
  if (hasUnknown || (hasNotApplied && (hasApplied || hasAlreadyApplied))) {
    return "partially_applied";
  }
  if (hasNotApplied) {
    return "not_applied";
  }
  if (hasApplied) {
    return "applied";
  }
  return "already_applied";
}

function applicationResultOutcome(
  groups: readonly ApplicationGroupResult[],
): ApplicationGroupOutcome {
  const hasUnknown = groups.some((group) => group.outcome === "unknown");
  const hasApplied = groups.some((group) => group.outcome === "applied");
  const hasAlreadyApplied = groups.some(
    (group) => group.outcome === "already_applied",
  );
  const hasPartiallyApplied = groups.some(
    (group) => group.outcome === "partially_applied",
  );
  const hasNotApplied = groups.some(
    (group) => group.outcome === "not_applied",
  );
  const hasAppliedFact = hasApplied || hasAlreadyApplied || hasPartiallyApplied;
  if (hasUnknown && !hasAppliedFact) {
    return "unknown";
  }
  if (hasUnknown || hasPartiallyApplied || (hasNotApplied && hasAppliedFact)) {
    return "partially_applied";
  }
  if (hasNotApplied) {
    return "not_applied";
  }
  if (hasApplied) {
    return "applied";
  }
  return "already_applied";
}

function createApplicationResult(
  proposalId: string,
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
  operationResults: ReadonlyMap<string, ApplicationOperationResult>,
): AsanaProposalApplicationResult {
  const operations: ApplicationOperationResult[] = [];
  const groups: ApplicationGroupResult[] = [];
  for (const group of proposal.groups) {
    const selected = group.operations.filter((operation) =>
      selectedOperationIds.has(operation.operation_id));
    if (selected.length === 0) {
      continue;
    }
    const groupOperations: ApplicationOperationResult[] = [];
    for (const operation of selected) {
      const result = operationResults.get(operation.operation_id);
      if (result == null) {
        throw new Error("適用操作の結果がありません。");
      }
      operations.push(result);
      groupOperations.push(result);
    }
    groups.push({
      group_id: group.group_id,
      atomic: group.atomic,
      operation_ids: selected.map((operation) => operation.operation_id),
      outcome: applicationGroupOutcome(groupOperations),
    });
  }
  if (operations.length === 0 || groups.length === 0) {
    throw new Error("適用対象の操作がありません。");
  }
  return asanaProposalApplicationResultSchema.parse({
    proposal_id: proposalId,
    outcome: applicationResultOutcome(groups),
    operations,
    groups,
  });
}

function selectedOperationSet(
  input: AsanaProposalApplicationInput,
): ReadonlySet<string> {
  return new Set(input.approval_input.selected_operation_ids);
}

function operationPhase(operation: ProposalOperation): number {
  if (operation.operation === "create_task") {
    return 0;
  }
  switch (operation.operation) {
    case "set_dependencies":
    case "set_parent":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
      return 2;
    default:
      return 1;
  }
}

function markAtomicGroupBlocked(
  contexts: readonly OperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  groupId: string,
  operationResults: Map<string, ApplicationOperationResult>,
  mappings: ReadonlyMap<string, string>,
): void {
  for (const context of contexts) {
    if (
      context.group.group_id !== groupId
      || !selectedOperationIds.has(context.operation.operation_id)
      || operationResults.has(context.operation.operation_id)
    ) {
      continue;
    }
    operationResults.set(
      context.operation.operation_id,
      createOperationResult(
        groupId,
        context.operation.operation_id,
        "not_applied",
        "atomic_group_blocked",
        targetGid(context.operation, mappings),
      ),
    );
  }
}

function journalEntry(
  proposalId: string,
  operationId: string,
  target: ApplicationJournal["target"],
  startedAt: string,
): ApplicationJournal {
  return applicationJournalSchema.parse({
    proposal_id: proposalId,
    operation_id: operationId,
    target,
    started_at: isoDateTimeSchema.parse(startedAt),
    stage: "started",
  });
}

function finalJournalResult(value: ApplicationJournalResult): ApplicationJournalResult {
  return applicationJournalResultSchema.parse(value);
}

function expectedExternalGid(uuid: string): string {
  return externalTaskGidSchema.parse(`TaskHub:v1:task:${uuid}`);
}

function resultForExistingJournal(
  context: OperationContext,
  journal: ApplicationJournal,
): ApplicationOperationResult {
  if (journal.final_result === "applied" && journal.target.kind === "task") {
    return createOperationResult(
      context.group.group_id,
      context.operation.operation_id,
      "already_applied",
      "already_applied",
      journal.target.gid,
    );
  }
  return unknownOperationResult(
    context,
    "recovery_required",
    journal.target.kind === "task" ? journal.target.gid : undefined,
  );
}

function uniqueTaskMap(
  tasks: readonly AsanaTaskResponse[],
): ReadonlyMap<string, AsanaTaskResponse> {
  const result = new Map<string, AsanaTaskResponse>();
  for (const task of tasks) {
    const parsedTask = asanaTaskResponseSchema.parse(task);
    if (result.has(parsedTask.gid)) {
      throw new Error("Asanaタスク一覧のGIDが重複しています。");
    }
    result.set(parsedTask.gid, parsedTask);
  }
  return result;
}

function externalTaskMatchesUuid(task: AsanaTaskResponse, uuid: string): boolean {
  const external = task.external;
  return external != null && external.gid === expectedExternalGid(uuid);
}

function matchingExternalTasks(
  tasks: ReadonlyMap<string, AsanaTaskResponse>,
  uuid: string,
): readonly AsanaTaskResponse[] {
  return [...tasks.values()].filter((task) => externalTaskMatchesUuid(task, uuid));
}

function findOperationContext(
  contexts: ReadonlyMap<string, OperationContext>,
  operationId: string,
): OperationContext | undefined {
  return contexts.get(operationId);
}

function unknownOperationResult(
  context: OperationContext,
  reasonCode: ApplicationReasonCode,
  taskGid: string | undefined,
): ApplicationOperationResult {
  return createOperationResult(
    context.group.group_id,
    context.operation.operation_id,
    "unknown",
    reasonCode,
    taskGid,
  );
}

function incompleteJournalResult(
  journal: ApplicationJournal,
  reasonCode: RecoveryReasonCode,
  taskGid: string | undefined,
): AsanaProposalRecoveryResult["unresolved_journals"][number] {
  if (taskGid == null) {
    return {
      proposal_id: journal.proposal_id,
      operation_id: journal.operation_id,
      outcome: "unknown",
      reason_code: reasonCode,
    };
  }
  return {
    proposal_id: journal.proposal_id,
    operation_id: journal.operation_id,
    task_gid: taskGid,
    outcome: "unknown",
    reason_code: reasonCode,
  };
}

function validateRecoveryJournalTarget(
  journal: ApplicationJournal,
  operation: ProposalOperation,
  mappings: ReadonlyMap<string, string>,
): RecoveryTargetValidation {
  if (operation.operation === "create_task") {
    if (journal.target.kind !== "new_task") {
      return { kind: "invalid" };
    }
    return { kind: "valid" };
  }
  if (journal.target.kind !== "task") {
    return { kind: "invalid" };
  }
  const resolved = targetGid(operation, mappings);
  if (resolved == null || resolved !== journal.target.gid) {
    return { kind: "invalid" };
  }
  return { kind: "valid", task_gid: resolved };
}

/** 承認済み変更案の適用と起動時復旧を管理します。 */
export class AsanaProposalApplicationCoordinator {
  private readonly readClient: AsanaReadClient;
  private readonly writer: AsanaProposalOperationWriter;
  private readonly journal: ApplicationJournalStorePort;
  private readonly uuidGenerator: ProposalApplicationUuidGenerator;
  private readonly timestampProvider: ProposalApplicationTimestampProvider;
  private readonly postApply: ProposalApplicationPostApply;

  public constructor(
    readClient: AsanaReadClient,
    writer: AsanaProposalOperationWriter,
    journal: JournalPort,
    uuidGenerator: ProposalApplicationUuidGenerator,
    timestampProvider: ProposalApplicationTimestampProvider,
    postApply: ProposalApplicationPostApply,
  ) {
    if (typeof postApply !== "function") {
      throw new TypeError("適用後同期・順位再計算コールバックが必要です。");
    }
    this.readClient = readClient;
    this.writer = writer;
    this.journal = normalizeJournalPort(journal);
    this.uuidGenerator = uuidGenerator;
    this.timestampProvider = timestampProvider;
    this.postApply = postApply;
  }

  /** 承認済み変更案を作成・属性・関係の順で適用します。 */
  public async apply(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const validatedInput = asanaProposalApplicationInputSchema.parse(input);
    const approval = proposalApprovalResultSchema.parse(
      classifyProposalConflicts(validatedInput.approval_input),
    );
    const contexts = flattenProposal(validatedInput.approval_input.proposal);
    const contextMap = operationMap(contexts);
    const selected = selectedOperationSet(validatedInput);
    const approvalOperations = approvalOperationMap(approval);
    const approvalGroups = approvalGroupMap(approval);
    const mappings = temporaryMappingMap(
      validatedInput.approval_input.journal_task_mappings,
    );
    const uuids = issueCreateUuids(contexts, selected, this.uuidGenerator);
    const baselines = baselineExternalMap(validatedInput.baseline_external_data);
    validateBaselineCoverage(contexts, selected, mappings, baselines);
    const operationResults = new Map<string, ApplicationOperationResult>();
    const operationGroupsBlocked = new Set<string>();
    const failedTemporaryRefs = new Set<string>();
    const pendingJournals: PendingJournal[] = [];

    for (const context of contexts) {
      if (!selected.has(context.operation.operation_id)) {
        continue;
      }
      const classification = approvalOperations.get(context.operation.operation_id);
      if (classification == null) {
        throw new Error("承認競合結果の操作がありません。");
      }
      if (classification.kind === "conflict") {
        operationResults.set(
          context.operation.operation_id,
          createOperationResult(
            context.group.group_id,
            context.operation.operation_id,
            "not_applied",
            "approval_conflict",
            targetGid(context.operation, mappings),
          ),
        );
        continue;
      }
      const group = approvalGroups.get(context.group.group_id);
      if (group == null) {
        throw new Error("承認競合結果のグループがありません。");
      }
      if (classification.kind === "already_applied") {
        operationResults.set(
          context.operation.operation_id,
          createOperationResult(
            context.group.group_id,
            context.operation.operation_id,
            "already_applied",
            "already_applied",
            targetGid(context.operation, mappings),
          ),
        );
      } else if (!group.applicable) {
        operationGroupsBlocked.add(context.group.group_id);
        operationResults.set(
          context.operation.operation_id,
          createOperationResult(
          context.group.group_id,
          context.operation.operation_id,
          "not_applied",
          "atomic_group_blocked",
          targetGid(context.operation, mappings),
          ),
        );
      }
    }
    const applicableContexts = contexts
      .filter((context) => {
        if (!selected.has(context.operation.operation_id)) {
          return false;
        }
        const classification = approvalOperations.get(context.operation.operation_id);
        const group = approvalGroups.get(context.group.group_id);
        return classification?.kind === "applicable"
          && group?.applicable === true
          && !operationGroupsBlocked.has(context.group.group_id);
      })
      .sort((left, right) => {
        return operationPhase(left.operation) - operationPhase(right.operation);
      });

    for (const context of applicableContexts) {
      throwIfAborted(signal);
      if (operationResults.has(context.operation.operation_id)) {
        continue;
      }
      const temporaryRef = temporaryTargetRef(context.operation);
      if (temporaryRef != null && failedTemporaryRefs.has(temporaryRef)) {
        operationResults.set(
          context.operation.operation_id,
          unknownOperationResult(
            context,
            "recovery_required",
            targetGid(context.operation, mappings),
          ),
        );
        if (context.group.atomic) {
          operationGroupsBlocked.add(context.group.group_id);
          markAtomicGroupBlocked(
            contexts,
            selected,
            context.group.group_id,
            operationResults,
            mappings,
          );
        }
        continue;
      }
      const existingJournal = this.journal.get(
        validatedInput.proposal_id,
        context.operation.operation_id,
      );
      if (existingJournal != null) {
        operationResults.set(
          context.operation.operation_id,
          resultForExistingJournal(context, existingJournal),
        );
        if (context.group.atomic) {
          operationGroupsBlocked.add(context.group.group_id);
          markAtomicGroupBlocked(
            contexts,
            selected,
            context.group.group_id,
            operationResults,
            mappings,
          );
        }
        continue;
      }

      const taskGid = targetGid(context.operation, mappings);
      let baseline = taskGid == null ? undefined : baselines.get(taskGid);
      if (context.operation.operation !== "create_task" && taskGid != null && baseline == null) {
        const task = asanaTaskResponseSchema.parse(
          await this.readClient.getTask(taskGid, signal),
        );
        baseline = requireBaselineExternalFromTask(task);
        baselines.set(taskGid, baseline);
      }
      const createUuid = context.operation.operation === "create_task"
        ? uuids.get(context.operation.operation_id)
        : undefined;
      const writerInput = createWriterInput(
        context,
        validatedInput,
        mappings,
        baseline,
        createUuid,
        undefined,
      );
      const target = operationTargetForJournal(context.operation, mappings, uuids);
      const entry = journalEntry(
        validatedInput.proposal_id,
        context.operation.operation_id,
        target,
        this.timestampProvider(),
      );
      this.journal.create(entry);

      let rawWriterResult: WriterResult;
      try {
        rawWriterResult = await this.writer.apply(writerInput, signal);
      } catch (error) {
        if (signal.aborted) {
          signal.throwIfAborted();
          throw error;
        }
        if (!isKnownAsanaOperationalError(error)) {
          throw error;
        }
        if (context.operation.operation === "create_task") {
          failedTemporaryRefs.add(context.operation.temporary_ref);
        }
        operationResults.set(
          context.operation.operation_id,
          unknownOperationResult(context, "recovery_required", taskGid),
        );
        if (context.group.atomic) {
          operationGroupsBlocked.add(context.group.group_id);
          markAtomicGroupBlocked(
            contexts,
            selected,
            context.group.group_id,
            operationResults,
            mappings,
          );
        }
        continue;
      }
      const writerResult = validateWriterResult(
        context,
        rawWriterResult,
        taskGid,
      );
      if (
        context.operation.operation === "create_task"
        && writerResult.outcome === "conflict"
      ) {
        failedTemporaryRefs.add(context.operation.temporary_ref);
      }
      if (
        context.operation.operation === "create_task"
        && writerResult.outcome !== "conflict"
      ) {
        try {
          const createdTask = asanaTaskResponseSchema.parse(
            await this.readClient.getTask(writerResult.task_gid, signal),
          );
          const createdExternal = requireBaselineExternalFromTask(createdTask);
          addTemporaryMapping(
            mappings,
            context.operation.temporary_ref,
            writerResult.task_gid,
          );
          baselines.set(writerResult.task_gid, createdExternal);
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          if (!isKnownAsanaOperationalError(error)) {
            throw error;
          }
          failedTemporaryRefs.add(context.operation.temporary_ref);
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(
              context,
              "recovery_required",
              writerResult.task_gid,
            ),
          );
          if (context.group.atomic) {
            operationGroupsBlocked.add(context.group.group_id);
            markAtomicGroupBlocked(
              contexts,
              selected,
              context.group.group_id,
              operationResults,
              mappings,
            );
          }
          continue;
        }
      }
      const metadataEntry = recordJournalResultBeforeRanking(
        this.journal,
        entry,
        writerResult,
      );
      operationResults.set(
        context.operation.operation_id,
        writerResultToApplicationResult(context, writerResult),
      );
      if (writerResult.outcome === "conflict" && context.group.atomic) {
        operationGroupsBlocked.add(context.group.group_id);
        markAtomicGroupBlocked(
          contexts,
          selected,
          context.group.group_id,
          operationResults,
          mappings,
        );
      }
      if (metadataEntry != null) {
        pendingJournals.push({
          entry: metadataEntry,
          context,
          task_gid: writerResult.task_gid,
          operationResults,
        });
      }
    }

    for (const context of contexts) {
      if (
        selected.has(context.operation.operation_id)
        && !operationResults.has(context.operation.operation_id)
      ) {
        const taskGid = targetGid(context.operation, mappings);
        operationResults.set(
          context.operation.operation_id,
          createOperationResult(
            context.group.group_id,
            context.operation.operation_id,
            "not_applied",
            operationGroupsBlocked.has(context.group.group_id)
              ? "atomic_group_blocked"
              : "writer_conflict",
            taskGid,
          ),
        );
      }
    }

    await finalizePendingJournals(
      pendingJournals,
      this.journal,
      this.postApply,
      signal,
    );
    if (contextMap.size === 0) {
      throw new Error("proposalに操作がありません。");
    }
    return createApplicationResult(
      validatedInput.proposal_id,
      validatedInput.approval_input.proposal,
      selected,
      operationResults,
    );
  }

  /** 未完了適用ジャーナルをAsanaの実状態と照合して復旧します。 */
  public async recover(
    input: AsanaProposalRecoveryInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalRecoveryResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const validatedInput = asanaProposalRecoveryInputSchema.parse(input);
    const contextsByProposal = new Map<
      string,
      AsanaProposalRecoveryInput["applications"][number]
    >();
    for (const application of validatedInput.applications) {
      contextsByProposal.set(application.proposal_id, application);
    }
    const incomplete = this.journal.getIncomplete();
    const journalsByProposal = new Map<string, ApplicationJournal[]>();
    const contextlessJournals: ApplicationJournal[] = [];
    const unresolved: AsanaProposalRecoveryResult["unresolved_journals"] = [];
    for (const journal of incomplete) {
      const context = contextsByProposal.get(journal.proposal_id);
      if (context == null) {
        contextlessJournals.push(journal);
        continue;
      }
      const journals = journalsByProposal.get(journal.proposal_id) ?? [];
      journals.push(journal);
      journalsByProposal.set(journal.proposal_id, journals);
    }

    const taskLists = new Map<string, Promise<ReadonlyMap<string, AsanaTaskResponse>>>();
    const configuredProjectGids = new Set(validatedInput.project_gids ?? []);
    for (const application of validatedInput.applications) {
      configuredProjectGids.add(application.project_gid);
    }
    const loadProjectTasks = (
      projectGid: string,
    ): Promise<ReadonlyMap<string, AsanaTaskResponse>> => {
      const cached = taskLists.get(projectGid);
      if (cached != null) {
        return cached;
      }
      const promise = this.readClient
        .listProjectTasks(projectGid, signal)
        .then((tasks) => uniqueTaskMap(tasks));
      taskLists.set(projectGid, promise);
      return promise;
    };
    const sortedConfiguredProjectGids = [...configuredProjectGids].sort();
    for (const journal of contextlessJournals) {
      throwIfAborted(signal);
      if (journal.target.kind === "new_task") {
        const matchesByGid = new Map<string, AsanaTaskResponse>();
        for (const projectGid of sortedConfiguredProjectGids) {
          const tasks = await loadProjectTasks(projectGid);
          for (const task of matchingExternalTasks(tasks, journal.target.uuid)) {
            matchesByGid.set(task.gid, task);
          }
        }
        const matches = [...matchesByGid.values()];
        const reasonCode: RecoveryReasonCode = matches.length > 1
          ? "duplicate_external_id"
          : "recovery_context_missing";
        const taskGid = matches.length === 1 ? matches[0]?.gid : undefined;
        this.journal.complete(
          journal.proposal_id,
          journal.operation_id,
          finalJournalResult("unknown"),
        );
        unresolved.push(incompleteJournalResult(journal, reasonCode, taskGid));
        continue;
      }
      let task: AsanaTaskResponse | undefined;
      for (const projectGid of sortedConfiguredProjectGids) {
        const tasks = await loadProjectTasks(projectGid);
        task = tasks.get(journal.target.gid);
        if (task != null) {
          break;
        }
      }
      if (task == null) {
        try {
          task = asanaTaskResponseSchema.parse(
            await this.readClient.getTask(journal.target.gid, signal),
          );
        } catch (error) {
          if (!(error instanceof AsanaHttpError) || error.status !== 404) {
            throw error;
          }
        }
      }
      const reasonCode: RecoveryReasonCode = task == null
        ? "task_not_found"
        : "recovery_context_missing";
      this.journal.complete(
        journal.proposal_id,
        journal.operation_id,
        finalJournalResult("unknown"),
      );
      unresolved.push(
        incompleteJournalResult(journal, reasonCode, task?.gid),
      );
    }

    const applicationStates: RecoveryApplicationState[] = [];
    const pendingJournals: PendingJournal[] = [];
    for (const application of validatedInput.applications) {
      throwIfAborted(signal);
      const journals = journalsByProposal.get(application.proposal_id);
      if (journals == null || journals.length === 0) {
        continue;
      }
      const contexts = [...flattenProposal(application.proposal)].sort((left, right) =>
        operationPhase(left.operation) - operationPhase(right.operation));
      const contextMap = operationMap(contexts);
      const projectTasks = await loadProjectTasks(application.project_gid);
      const mappings = new Map<string, string>();
      const foundCreateTasks = new Map<string, AsanaTaskResponse>();
      const operationResults = new Map<string, ApplicationOperationResult>();
      const journalByOperation = new Map<string, ApplicationJournal>();
      const baselines = baselineExternalMap(application.baseline_external_data);
      const failedTemporaryRefs = new Set<string>();
      for (const journal of journals) {
        if (journalByOperation.has(journal.operation_id)) {
          throw new Error("同じ適用ジャーナルを重複して復旧できません。");
        }
        journalByOperation.set(journal.operation_id, journal);
        const context = findOperationContext(contextMap, journal.operation_id);
        if (context == null) {
          this.journal.complete(
            journal.proposal_id,
            journal.operation_id,
            finalJournalResult("unknown"),
          );
          unresolved.push(
            incompleteJournalResult(journal, "recovery_context_missing", undefined),
          );
          continue;
        }
        if (context.operation.operation !== "create_task") {
          continue;
        }
        if (
          journal.target.kind !== "new_task"
          || journal.target.uuid.length === 0
        ) {
          this.journal.complete(
            journal.proposal_id,
            journal.operation_id,
            finalJournalResult("unknown"),
          );
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "journal_target_mismatch", undefined),
          );
          continue;
        }
        const matches = matchingExternalTasks(projectTasks, journal.target.uuid);
        if (matches.length === 0) {
          this.journal.complete(
            journal.proposal_id,
            journal.operation_id,
            finalJournalResult("unknown"),
          );
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "task_not_found", undefined),
          );
          continue;
        }
        if (matches.length > 1) {
          this.journal.complete(
            journal.proposal_id,
            journal.operation_id,
            finalJournalResult("unknown"),
          );
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "duplicate_external_id", undefined),
          );
          continue;
        }
        const existingTask = matches[0];
        if (existingTask == null) {
          throw new Error("UUID走査結果のタスクがありません。");
        }
        addTemporaryMapping(
          mappings,
          context.operation.temporary_ref,
          existingTask.gid,
        );
        foundCreateTasks.set(context.operation.operation_id, existingTask);
      }

      for (const context of contexts) {
        const journal = journalByOperation.get(context.operation.operation_id);
        if (journal == null || operationResults.has(context.operation.operation_id)) {
          continue;
        }
        throwIfAborted(signal);
        const temporaryRef = temporaryTargetRef(context.operation);
        if (temporaryRef != null && failedTemporaryRefs.has(temporaryRef)) {
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(
              context,
              "recovery_required",
              targetGid(context.operation, mappings),
            ),
          );
          continue;
        }
        const createTask = context.operation.operation === "create_task"
          ? foundCreateTasks.get(context.operation.operation_id)
          : undefined;
        const targetValidation = validateRecoveryJournalTarget(
          journal,
          context.operation,
          mappings,
        );
        if (targetValidation.kind === "invalid") {
          this.journal.complete(
            journal.proposal_id,
            journal.operation_id,
            finalJournalResult("unknown"),
          );
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "journal_target_mismatch", undefined),
          );
          continue;
        }
        const taskGid = targetValidation.task_gid;
        if (context.operation.operation === "create_task" && createTask == null) {
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "recovery_required", undefined),
          );
          continue;
        }
        let fetchedTask: AsanaTaskResponse | undefined;
        if (context.operation.operation !== "create_task" && taskGid != null) {
          try {
            fetchedTask = asanaTaskResponseSchema.parse(
              await this.readClient.getTask(taskGid, signal),
            );
          } catch (error) {
            if (error instanceof AsanaHttpError && error.status === 404) {
              this.journal.complete(
                journal.proposal_id,
                journal.operation_id,
                finalJournalResult("unknown"),
              );
              operationResults.set(
                context.operation.operation_id,
                unknownOperationResult(context, "task_not_found", taskGid),
              );
              continue;
            }
            throw error;
          }
        }
        let baseline = taskGid == null ? undefined : baselines.get(taskGid);
        if (
          baseline == null
          && taskGid != null
          && context.operation.operation !== "create_task"
          && context.operation.target.kind === "temporary"
        ) {
          if (fetchedTask == null) {
            throw new Error("一時参照先タスクの再取得結果がありません。");
          }
          baseline = requireBaselineExternalFromTask(fetchedTask);
          baselines.set(taskGid, baseline);
        }
        const createUuid = context.operation.operation === "create_task"
          ? journal.target.kind === "new_task" ? journal.target.uuid : undefined
          : undefined;
        if (context.operation.operation !== "create_task" && baseline == null) {
          this.journal.complete(
            journal.proposal_id,
            journal.operation_id,
            finalJournalResult("unknown"),
          );
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "recovery_context_missing", taskGid),
          );
          continue;
        }
        const writerInput = createWriterInput(
          context,
          application,
          mappings,
          baseline,
          createUuid,
          createTask,
        );
        let rawWriterResult: WriterResult;
        try {
          rawWriterResult = await this.writer.apply(writerInput, signal);
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          if (!isKnownAsanaOperationalError(error)) {
            throw error;
          }
          if (context.operation.operation === "create_task") {
            failedTemporaryRefs.add(context.operation.temporary_ref);
          }
          operationResults.set(
            context.operation.operation_id,
            unknownOperationResult(context, "recovery_required", taskGid),
          );
          continue;
        }
        const expectedTaskGid = createTask == null ? taskGid : createTask.gid;
        const writerResult = validateWriterResult(
          context,
          rawWriterResult,
          expectedTaskGid,
        );
        if (
          context.operation.operation === "create_task"
          && writerResult.outcome === "conflict"
        ) {
          failedTemporaryRefs.add(context.operation.temporary_ref);
        }
        const recoveredCreateConflict = context.operation.operation === "create_task"
          && createTask != null
          && writerResult.outcome === "conflict";
        const metadataEntry = recoveredCreateConflict
          ? undefined
          : recordJournalResultBeforeRanking(
            this.journal,
            journal,
            writerResult,
          );
        operationResults.set(
          context.operation.operation_id,
          recoveredCreateConflict
            ? unknownOperationResult(context, "recovery_required", writerResult.task_gid)
            : writerResultToApplicationResult(context, writerResult),
        );
        if (
          context.operation.operation === "create_task"
          && writerResult.outcome !== "conflict"
        ) {
          addTemporaryMapping(
            mappings,
            context.operation.temporary_ref,
            writerResult.task_gid,
          );
        }
        if (metadataEntry != null) {
          pendingJournals.push({
            entry: metadataEntry,
            context,
            task_gid: writerResult.task_gid,
            operationResults,
          });
        }
      }
      const selected = new Set(operationResults.keys());
      if (selected.size > 0) {
        applicationStates.push({ application, selected, operationResults });
      }
    }
    await finalizePendingJournals(
      pendingJournals,
      this.journal,
      this.postApply,
      signal,
    );
    const applications: AsanaProposalApplicationResult[] = [];
    for (const state of applicationStates) {
      applications.push(
        createApplicationResult(
          state.application.proposal_id,
          state.application.proposal,
          state.selected,
          state.operationResults,
        ),
      );
    }
    return asanaProposalRecoveryResultSchema.parse({
      applications,
      unresolved_journals: unresolved,
    });
  }
}

export type ProposalApplicationUuidGenerator = () => string;
export type ProposalApplicationTimestampProvider = () => string;

/** 適用後の同期と順位再計算を実行します。 */
export type ProposalApplicationPostApply = (signal: AbortSignal) => Promise<void>;
