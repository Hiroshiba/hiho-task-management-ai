import { z } from "zod";
import {
  asanaTaskResponseSchema,
  canonicalizeJson,
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
import { validateSelectedProposalGraph } from "../proposal-validation";
import {
  proposalOperationSchema,
  type Proposal,
  type ProposalGroup,
  type ProposalOperation,
} from "../../../shared/ai";
import {
  applicationJournalOperationSchema,
  applicationJournalResultSchema,
  applicationJournalPlanSchema,
  applicationJournalWithPlanSchema,
  type ApplicationJournal,
  type ApplicationJournalBaselineSource,
  type ApplicationJournalOperation,
  type ApplicationJournalPlan,
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
import {
  combineDiagnosticFailureDispositions,
  DiagnosticFailureDispositionError,
  diagnosticFailureDispositionFromError,
} from "../../diagnostic-failure";
import {
  AsanaProposalOperationWriter,
  type ProposalOperationWriteAction,
} from "./operation-writer";
import {
  asanaProposalApplicationInputSchema,
  asanaProposalApplicationResultSchema,
  asanaProposalOperationWriterResultSchema,
  asanaPostWriteSynchronizationResultSchema,
  asanaProposalRecoveryInputSchema,
  asanaProposalRecoveryResultSchema,
  applicationJournalDiagnosticSchema,
  type AsanaProposalApplicationInput,
  type AsanaProposalApplicationResult,
  type AsanaProposalRecoveryInput,
  type AsanaProposalRecoveryResult,
  type ApplicationJournalDiagnostic,
  type AsanaProposalOperationWriterInput,
  type AsanaProposalOperationWriterResult,
  type AsanaProposalWriterTemporaryRefMapping,
  type PostWriteSynchronizationResult,
} from "./schemas";

type ApplicationOperationResult =
  AsanaProposalApplicationResult["operations"][number];
type ApplicationGroupResult = AsanaProposalApplicationResult["groups"][number];
type ApprovalOperationResult = ProposalApprovalResult["operations"][number];
type ApprovalGroupResult = ProposalApprovalResult["groups"][number];
type ApplicationReasonCode = ApplicationOperationResult["reason_code"];
type RecoveryReasonCode =
  AsanaProposalRecoveryResult["unresolved_journals"][number]["reason_code"];
type ApplicationOutcome = ApplicationOperationResult["outcome"];
type ApplicationGroupOutcome = ApplicationGroupResult["outcome"];
type WriterInput = AsanaProposalOperationWriterInput;
type WriterResult = AsanaProposalOperationWriterResult;
type BaselineExternal = NonNullable<WriterInput["baseline_external_data"]>;
type RecoverySettings = Pick<
  AsanaProposalRecoveryInput["applications"][number],
  "project_gid"
  | "workspace_gid"
  | "section_gids"
  | "device_id"
  | "created_via"
  | "activity_date"
>;
type OperationContext = {
  readonly group: Pick<ProposalGroup, "group_id" | "atomic">;
  readonly operation: ProposalOperation;
};
type ApplicationJournalStorePort = {
  readonly prepare: (entries: readonly ApplicationJournal[]) => void;
  readonly recordCreatedTask: (
    proposalId: string,
    operationId: string,
    temporaryRef: string,
    taskGid: string,
  ) => void;
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
  readonly clearRecoveryCause: (proposalId: string, operationId: string) => void;
  readonly get: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
  readonly getByProposal: (proposalId: string) => readonly ApplicationJournal[];
  readonly getIncomplete: () => readonly ApplicationJournal[];
};
type ProposalApplicationDiagnostic = (
  error: unknown,
  event: ApplicationJournalDiagnostic,
) => void;
type JournalDiagnosticFields = Omit<ApplicationJournalDiagnostic, "kind">;
type OperationDiagnosticFields = Pick<
  JournalDiagnosticFields,
  | "severity"
  | "api_action"
  | "journal_stage"
  | "effect_certainty"
  | "reason_code"
  | "recovery_decision"
  | "attempt"
  | "phase"
>;
type OperationDiagnosticContext = {
  readonly journal: ApplicationJournal;
  readonly context: OperationContext;
};
type StorageDatabaseJournalPort = {
  readonly prepareApplicationJournals: (entries: readonly ApplicationJournal[]) => void;
  readonly recordApplicationJournalTaskCreated: (
    proposalId: string,
    operationId: string,
    temporaryRef: string,
    taskGid: string,
  ) => void;
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
  readonly clearApplicationJournalRecoveryCause: (
    proposalId: string,
    operationId: string,
  ) => void;
  readonly getApplicationJournal: (
    proposalId: string,
    operationId: string,
  ) => ApplicationJournal | undefined;
  readonly getApplicationJournalsByProposal: (
    proposalId: string,
  ) => readonly ApplicationJournal[];
  readonly getIncompleteApplicationJournals: () => readonly ApplicationJournal[];
};
type JournalPort = ApplicationJournalStorePort | StorageDatabaseJournalPort;
type JournalOperation = ApplicationJournalPlan["operation"];
type PlannedApplicationJournal = Extract<ApplicationJournal, { plan: ApplicationJournalPlan }>;
type PendingJournal = {
  readonly entry: PlannedApplicationJournal;
  readonly context: OperationContext;
  readonly task_gid: string;
  readonly operationResults: Map<string, ApplicationOperationResult>;
};
type ExistingJournalDisposition =
  | {
      readonly kind: "return_result";
      readonly block_group: boolean;
      readonly result: ApplicationOperationResult;
    }
  | {
      readonly kind: "resume_local_completion";
      readonly entry: PlannedApplicationJournal;
      readonly result: ApplicationOperationResult;
      readonly task_gid: string;
    }
  | {
      readonly kind: "persist_final_result";
      readonly entry: PlannedApplicationJournal;
      readonly result: ApplicationOperationResult;
      readonly task_gid: string;
    };
type RecoveryApplicationState = {
  readonly application: AsanaProposalRecoveryInput["applications"][number] | undefined;
  readonly entries: readonly PlannedRecoveryEntry[];
  readonly plannedEntries: readonly PlannedRecoveryEntry[];
  readonly settings: RecoverySettings;
  readonly mappings: Map<string, string>;
  readonly blockedGroupIds: ReadonlySet<string>;
  readonly selected: Set<string>;
  readonly operationResults: Map<string, ApplicationOperationResult>;
};
type PlannedRecoveryEntry = {
  readonly journal: PlannedApplicationJournal;
  readonly context: OperationContext;
};
type RecoveryPendingJournal = {
  readonly entry: PlannedRecoveryEntry;
  readonly task_gid: string;
};

function hasApplicationJournalPlan(
  journal: ApplicationJournal,
): journal is PlannedApplicationJournal {
  return journal.plan != null;
}

const journalStages: readonly ApplicationJournalStage[] = [
  "prepared",
  "write_started",
  "task_created",
  "attributes_applied",
  "relations_applied",
  "read_back",
  "metadata_verified",
  "ranking_recalculated",
];

function effectCertaintyForJournalStage(
  stage: ApplicationJournalStage,
): OperationDiagnosticFields["effect_certainty"] {
  if (stage === "prepared") {
    return "none";
  }
  if (journalStages.indexOf(stage) >= journalStages.indexOf("read_back")) {
    return "confirmed";
  }
  return "possible";
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
  if ("prepare" in journal) {
    return journal;
  }
  return {
    prepare: (entries) => journal.prepareApplicationJournals(entries),
    recordCreatedTask: (proposalId, operationId, temporaryRef, taskGid) =>
      journal.recordApplicationJournalTaskCreated(
        proposalId,
        operationId,
        temporaryRef,
        taskGid,
      ),
    updateStage: (proposalId, operationId, stage) =>
      journal.updateApplicationJournalStage(proposalId, operationId, stage),
    complete: (proposalId, operationId, finalResult) =>
      journal.completeApplicationJournal(proposalId, operationId, finalResult),
    clearRecoveryCause: (proposalId, operationId) =>
      journal.clearApplicationJournalRecoveryCause(proposalId, operationId),
    get: (proposalId, operationId) =>
      journal.getApplicationJournal(proposalId, operationId),
    getByProposal: (proposalId) =>
      journal.getApplicationJournalsByProposal(proposalId),
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

function collectApplicableOperationIds(
  contexts: readonly OperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  approvalOperations: ReadonlyMap<string, ApprovalOperationResult>,
  approvalGroups: ReadonlyMap<string, ApprovalGroupResult>,
): readonly string[] {
  const operationIds: string[] = [];
  for (const context of contexts) {
    if (!selectedOperationIds.has(context.operation.operation_id)) {
      continue;
    }
    const classification = approvalOperations.get(context.operation.operation_id);
    if (classification == null) {
      throw new Error("承認競合結果の操作がありません。");
    }
    const group = approvalGroups.get(context.group.group_id);
    if (group == null) {
      throw new Error("承認競合結果のグループがありません。");
    }
    if (classification.kind === "applicable" && group.applicable) {
      operationIds.push(context.operation.operation_id);
    }
  }
  return operationIds;
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

function operationTemporaryReferences(
  operation: ProposalOperation,
): readonly string[] {
  const references = new Set<string>();
  const addTarget = (
    target:
      | { readonly kind: "existing"; readonly gid: string }
      | { readonly kind: "temporary"; readonly ref: string }
      | undefined,
  ): void => {
    if (target?.kind === "temporary") {
      references.add(target.ref);
    }
  };
  if (operation.operation === "create_task") {
    addTarget(operation.after.parent);
    for (const dependency of operation.after.dependencies ?? []) {
      addTarget(dependency.target);
    }
  } else {
    addTarget(operation.target);
    if (operation.operation === "set_dependencies") {
      for (const dependency of [...operation.before, ...operation.after]) {
        addTarget(dependency.target);
      }
    }
    if (operation.operation === "set_parent") {
      addTarget(operation.before.kind === "absent" ? undefined : operation.before);
      addTarget(operation.after.kind === "absent" ? undefined : operation.after);
    }
  }
  return [...references].sort();
}

function operationTargetForJournal(
  operation: ProposalOperation,
  uuids: ReadonlyMap<string, string>,
): ApplicationJournal["target"] {
  if (operation.operation === "create_task") {
    const uuid = uuids.get(operation.operation_id);
    if (uuid == null) {
      throw new Error("create_taskの事前発行UUIDがありません。");
    }
    return { kind: "new_task", uuid };
  }
  if (operation.target.kind === "existing") {
    return { kind: "task", gid: operation.target.gid };
  }
  return { kind: "temporary", ref: operation.target.ref };
}

function journalOperationForProposalOperation(
  operation: ProposalOperation,
  uuids: ReadonlyMap<string, string>,
): JournalOperation {
  if (operation.operation === "create_task") {
    const uuid = uuids.get(operation.operation_id);
    if (uuid == null) {
      throw new Error("create_taskの事前発行UUIDがありません。");
    }
    return applicationJournalOperationSchema.parse({
      operation: "create_task",
      operation_id: operation.operation_id,
      target: { kind: "new_task", uuid },
      temporary_ref: operation.temporary_ref,
      expected_before: operation.before,
      expected_after: operation.after,
    });
  }
  const operationTarget = operation.target.kind === "existing"
    ? { kind: "existing", gid: operation.target.gid }
    : { kind: "temporary", ref: operation.target.ref };
  return applicationJournalOperationSchema.parse({
    operation: operation.operation,
    operation_id: operation.operation_id,
    target: operationTarget,
    expected_before: operation.before,
    expected_after: operation.after,
  });
}

function proposalOperationForJournalOperation(
  operation: ApplicationJournalOperation,
): ProposalOperation {
  const common = {
    operation_id: operation.operation_id,
    baseline_snapshot_hash: "0".repeat(64),
    reason: "保存済み復旧計画",
    confidence: 1,
    evidence_refs: [{ kind: "user_message", locator: "recovery-plan" }],
  };
  if (operation.operation === "create_task") {
    const creation = operation.expected_after.parent == null
      ? { kind: "single_task" }
      : {
          kind: "split_child",
          parent: operation.expected_after.parent,
          instruction_reference: {
            kind: "user_message" as const,
            locator: "recovery-plan",
          },
        };
    return proposalOperationSchema.parse({
      ...common,
      operation: "create_task",
      basis: creation.kind === "split_child" ? "explicit" : "inferred",
      temporary_ref: operation.temporary_ref,
      creation,
      before: operation.expected_before,
      after: operation.expected_after,
    });
  }
  if (operation.operation === "complete" || operation.operation === "withdraw") {
    return proposalOperationSchema.parse({
      ...common,
      operation: operation.operation,
      basis: "explicit",
      target: operation.target,
      before: operation.expected_before,
      after: operation.expected_after,
      status_evidence: {
        kind: "user_explicit",
        reference: { kind: "user_message", locator: "recovery-plan" },
      },
    });
  }
  return proposalOperationSchema.parse({
    ...common,
    operation: operation.operation,
    basis: "inferred",
    target: operation.target,
    before: operation.expected_before,
    after: operation.expected_after,
  });
}

function journalOperationsMatch(
  left: ApplicationJournalOperation,
  right: ApplicationJournalOperation,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function issueCreateUuids(
  contexts: readonly OperationContext[],
  selectedOperationIds: ReadonlySet<string>,
  uuidGenerator: ProposalApplicationUuidGenerator,
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  const seen = new Set<string>();
  const createContexts = contexts
    .filter((context) =>
      selectedOperationIds.has(context.operation.operation_id)
      && context.operation.operation === "create_task")
    .sort(compareOperationContexts);
  for (const context of createContexts) {
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
      || !operationUsesCustomExternalData(context.operation)
    ) {
      continue;
    }
    const gid = targetGid(context.operation, mappings);
    if (gid != null && !baselines.has(gid)) {
      throw new Error("選択操作の適用基準外部データがありません。");
    }
  }
}

function operationUsesCustomExternalData(operation: ProposalOperation): boolean {
  return operation.operation !== "create_task"
    && operation.operation !== "complete"
    && operation.operation !== "withdraw";
}

function baselineSourceForOperation(
  proposalId: string,
  context: OperationContext,
  contexts: readonly OperationContext[],
  applicableOperationIds: ReadonlySet<string>,
  mappings: ReadonlyMap<string, string>,
  baselines: ReadonlyMap<string, BaselineExternal>,
  journal: ApplicationJournalStorePort,
): ApplicationJournalBaselineSource {
  const operation = context.operation;
  if (!operationUsesCustomExternalData(operation)) {
    return { kind: "not_used" };
  }
  if (operation.operation === "create_task") {
    throw new Error("create_taskから既存タスクのbaseline sourceを構築できません。");
  }
  const target = operation.target;
  if (target.kind === "temporary") {
    const createContext = contexts.find(
      (candidate) => candidate.operation.operation === "create_task"
        && candidate.operation.temporary_ref === target.ref,
    );
    if (createContext != null) {
      const createJournal = journal.get(proposalId, createContext.operation.operation_id);
      if (
        applicableOperationIds.has(createContext.operation.operation_id)
        || (createJournal != null && hasApplicationJournalPlan(createJournal))
      ) {
        return {
          kind: "created_task",
          create_operation_id: createContext.operation.operation_id,
          temporary_ref: target.ref,
        };
      }
    }
  }
  const taskGid = targetGid(operation, mappings);
  if (taskGid == null) {
    throw new Error("適用基準の対象task GIDを解決できません。");
  }
  const baseline = baselines.get(taskGid);
  if (baseline == null) {
    throw new Error("選択操作の適用基準外部データがありません。");
  }
  const parsed = parseCustomExternalData(baseline.data);
  if (parsed.kind !== "valid") {
    throw new Error("適用基準のCustom external dataがvalidではありません。");
  }
  if (
    externalTaskGidSchema.parse(baseline.gid) !== baseline.gid
    || baseline.gid !== `TaskHub:v1:task:${parsed.data.id}`
    || serializeCustomExternalData(parsed.data) !== baseline.data
  ) {
    throw new Error("適用基準のCustom external data識別子または形式が不正です。");
  }
  return {
    kind: "stored",
    external_gid: baseline.gid,
    data: parsed.data,
  };
}

function createWriterInput(
  context: OperationContext,
  settings: RecoverySettings,
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
    if (
      context.operation.operation !== "complete"
      && context.operation.operation !== "withdraw"
    ) {
      throw new Error("この操作には適用基準外部データが必要です。");
    }
    return {
      ...common,
      operation: context.operation,
    };
  }
  return {
    ...common,
    operation: context.operation,
    baseline_external_data: baseline,
  };
}

function baselineFromJournalPlan(
  writer: AsanaProposalOperationWriter,
  entry: PlannedRecoveryEntry,
  plannedEntries: readonly PlannedRecoveryEntry[],
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
): BaselineExternal | undefined {
  const source = entry.journal.plan.baseline_source;
  if (source.kind === "not_used") {
    return undefined;
  }
  if (source.kind === "stored") {
    return {
      gid: source.external_gid,
      data: serializeCustomExternalData(source.data),
    };
  }
  const createEntry = plannedEntries.find(
    (candidate) => candidate.journal.operation_id === source.create_operation_id,
  );
  if (
    createEntry == null
    || createEntry.journal.proposal_id !== entry.journal.proposal_id
    || createEntry.context.operation.operation !== "create_task"
    || createEntry.context.operation.temporary_ref !== source.temporary_ref
  ) {
    throw new Error("Custom external dataの作成元復旧計画が一致しません。");
  }
  const createUuid = createEntry.journal.plan.create_uuid;
  if (createUuid == null) {
    throw new Error("Custom external dataの作成元UUIDがありません。");
  }
  const createInput = createWriterInput(
    createEntry.context,
    settings,
    mappings,
    undefined,
    createUuid,
    undefined,
  );
  return writer.createInitialExternalBaseline(createInput);
}

function validateMemoryBaselineSource(
  writer: AsanaProposalOperationWriter,
  application: AsanaProposalRecoveryInput["applications"][number] | undefined,
  entry: PlannedRecoveryEntry,
  plannedEntries: readonly PlannedRecoveryEntry[],
  settings: RecoverySettings,
  mappings: ReadonlyMap<string, string>,
): void {
  if (application == null) {
    return;
  }
  let taskGid: string | undefined;
  if (entry.journal.plan.baseline_source.kind === "stored") {
    taskGid = targetGid(entry.context.operation, mappings);
  } else if (entry.journal.plan.baseline_source.kind === "created_task") {
    taskGid = mappings.get(entry.journal.plan.baseline_source.temporary_ref);
  }
  if (taskGid == null) {
    return;
  }
  const memoryBaseline = baselineExternalMap(application.baseline_external_data).get(taskGid);
  if (memoryBaseline == null) {
    return;
  }
  const plannedBaseline = baselineFromJournalPlan(
    writer,
    entry,
    plannedEntries,
    settings,
    mappings,
  );
  if (
    plannedBaseline == null
    || memoryBaseline.gid !== plannedBaseline.gid
    || memoryBaseline.data !== plannedBaseline.data
  ) {
    throw new Error("復旧計画と再開コンテキストのCustom external data baselineが一致しません。");
  }
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
  entry: PlannedApplicationJournal,
  result: WriterResult,
  onStagePersisted: (stage: ApplicationJournalStage) => void,
): PlannedApplicationJournal | undefined {
  if (result.outcome === "conflict") {
    if (result.side_effect === "possible") {
      return undefined;
    }
    journal.complete(entry.proposal_id, entry.operation_id, "not_applied");
    return undefined;
  }
  let stage = entry.stage;
  for (const targetStage of ["read_back", "metadata_verified"] as const) {
    if (journalStages.indexOf(targetStage) <= journalStages.indexOf(stage)) {
      continue;
    }
    journal.updateStage(entry.proposal_id, entry.operation_id, targetStage);
    stage = targetStage;
    onStagePersisted(stage);
  }
  return { ...entry, stage };
}

async function finalizePendingJournals(
  pending: readonly PendingJournal[],
  journal: ApplicationJournalStorePort,
  postApply: ProposalApplicationPostApply,
  reportDiagnostic: (
    error: unknown,
    fields: JournalDiagnosticFields,
  ) => DiagnosticFailureDispositionError,
  signal: AbortSignal,
): Promise<void> {
  if (pending.length === 0) {
    return;
  }
  const requiredTaskGids = sortedUniqueTaskGids(
    pending.map((item) => item.task_gid),
  );
  let synchronization: PostWriteSynchronizationResult;
  try {
    synchronization = asanaPostWriteSynchronizationResultSchema.parse(
      await postApply(requiredTaskGids, signal),
    );
  } catch (error: unknown) {
    if (error instanceof DiagnosticFailureDispositionError) {
      throw error;
    }
    let receipt: DiagnosticFailureDispositionError | undefined;
    for (const item of pending) {
      receipt = reportDiagnostic(error, {
        severity: "error",
        proposal_id: item.entry.proposal_id,
        operation_id: item.entry.operation_id,
        operation_kind: item.context.operation.operation,
        api_action: "post_apply",
        journal_stage: item.entry.stage,
        effect_certainty: "confirmed",
        task_gid: item.task_gid,
        reason_code: "local_resync_required",
        recovery_decision: "local_sync_pending",
        attempt: 1,
        phase: "post_apply",
      });
    }
    if (receipt == null) {
      throw new Error("適用後同期の診断receiptがありません。");
    }
    throw receipt;
  }
  if (synchronization.kind === "recovery_required") {
    for (const item of pending) {
      reportDiagnostic(
        new Error("外部状態は確定しましたが、ローカル同期を完了できませんでした。"),
        {
          severity: "warning",
          proposal_id: item.entry.proposal_id,
          operation_id: item.entry.operation_id,
          operation_kind: item.context.operation.operation,
          api_action: "post_apply",
          journal_stage: item.entry.stage,
          effect_certainty: "confirmed",
          task_gid: item.task_gid,
          reason_code: "local_resync_required",
          recovery_decision: "local_sync_pending",
          attempt: 1,
          phase: "post_apply",
        },
      );
      item.operationResults.set(
        item.context.operation.operation_id,
        unknownOperationResult(item.context, "local_resync_required", item.task_gid),
      );
    }
    return;
  }
  for (const item of pending) {
    let journalStage: ApplicationJournalStage = item.entry.stage;
    try {
      advanceJournal(
        journal,
        item.entry,
        "ranking_recalculated",
        (stage) => {
          journalStage = stage;
        },
      );
      journal.complete(item.entry.proposal_id, item.entry.operation_id, "applied");
    } catch (error: unknown) {
      const receipt = reportDiagnostic(error, {
        severity: "error",
        proposal_id: item.entry.proposal_id,
        operation_id: item.entry.operation_id,
        operation_kind: item.context.operation.operation,
        api_action: "post_apply",
        journal_stage: journalStage,
        effect_certainty: "confirmed",
        task_gid: item.task_gid,
        reason_code: "recovery_required",
        recovery_decision: "unresolved",
        attempt: 1,
        phase: "journal",
      });
      throw receipt;
    }
  }
}

function advanceJournal(
  journal: ApplicationJournalStorePort,
  entry: ApplicationJournal,
  targetStage: ApplicationJournalStage,
  onStagePersisted: (stage: ApplicationJournalStage) => void,
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
    onStagePersisted(stage);
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

function validateAtomicSelection(
  proposal: Proposal,
  selectedOperationIds: ReadonlySet<string>,
): void {
  for (const group of proposal.groups) {
    if (!group.atomic) {
      continue;
    }
    const selectedCount = group.operations.filter((operation) =>
      selectedOperationIds.has(operation.operation_id)).length;
    if (selectedCount > 0 && selectedCount !== group.operations.length) {
      throw new Error(`atomicグループ ${group.group_id} の操作を部分選択できません。`);
    }
  }
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

function compareOperationContexts(
  left: OperationContext,
  right: OperationContext,
): number {
  if (left.operation.operation_id < right.operation.operation_id) {
    return -1;
  }
  if (left.operation.operation_id > right.operation.operation_id) {
    return 1;
  }
  return 0;
}

function sortedUniqueTaskGids(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  });
}

function createTaskTemporaryReferences(
  operation: ProposalOperation,
): readonly string[] {
  if (operation.operation !== "create_task") {
    throw new Error("create_task以外から一時参照の依存関係を取得できません。");
  }
  const references = new Set<string>();
  if (operation.after.parent?.kind === "temporary") {
    references.add(operation.after.parent.ref);
  }
  for (const dependency of operation.after.dependencies ?? []) {
    if (dependency.target.kind === "temporary") {
      references.add(dependency.target.ref);
    }
  }
  return [...references].sort();
}

function orderCreateTaskContexts(
  contexts: readonly OperationContext[],
  mappings: ReadonlyMap<string, string>,
): readonly OperationContext[] {
  const contextByTemporaryRef = new Map<string, OperationContext>();
  const contextByOperationId = new Map<string, OperationContext>();
  const dependentOperationIds = new Map<string, Set<string>>();
  const dependencyCounts = new Map<string, number>();
  for (const context of contexts) {
    if (context.operation.operation !== "create_task") {
      throw new Error("create_task以外を作成順に含められません。");
    }
    if (contextByTemporaryRef.has(context.operation.temporary_ref)) {
      throw new Error("create_taskのtemporary_refが重複しています。");
    }
    if (contextByOperationId.has(context.operation.operation_id)) {
      throw new Error("create_taskのoperation_idが重複しています。");
    }
    contextByTemporaryRef.set(context.operation.temporary_ref, context);
    contextByOperationId.set(context.operation.operation_id, context);
    dependentOperationIds.set(context.operation.operation_id, new Set());
    dependencyCounts.set(context.operation.operation_id, 0);
  }

  for (const context of contexts) {
    for (const temporaryRef of createTaskTemporaryReferences(context.operation)) {
      const dependency = contextByTemporaryRef.get(temporaryRef);
      if (dependency == null) {
        if (mappings.has(temporaryRef)) {
          continue;
        }
        throw new Error("create_taskが参照するtemporary_refを解決できません。");
      }
      const dependents = dependentOperationIds.get(
        dependency.operation.operation_id,
      );
      const dependencyCount = dependencyCounts.get(
        context.operation.operation_id,
      );
      if (dependents == null || dependencyCount == null) {
        throw new Error("create_taskの一時参照グラフが不正です。");
      }
      if (dependents.has(context.operation.operation_id)) {
        continue;
      }
      dependents.add(context.operation.operation_id);
      dependencyCounts.set(context.operation.operation_id, dependencyCount + 1);
    }
  }

  const ready = contexts
    .filter((context) => dependencyCounts.get(context.operation.operation_id) === 0)
    .sort(compareOperationContexts);
  const ordered: OperationContext[] = [];
  while (ready.length > 0) {
    const context = ready.shift();
    if (context == null) {
      throw new Error("create_taskの作成順を取得できません。");
    }
    ordered.push(context);
    const dependents = dependentOperationIds.get(context.operation.operation_id);
    if (dependents == null) {
      throw new Error("create_taskの一時参照グラフが不正です。");
    }
    for (const dependentOperationId of [...dependents].sort()) {
      const dependent = contextByOperationId.get(dependentOperationId);
      const dependencyCount = dependencyCounts.get(dependentOperationId);
      if (dependent == null || dependencyCount == null || dependencyCount < 1) {
        throw new Error("create_taskの一時参照グラフが不正です。");
      }
      const remainingCount = dependencyCount - 1;
      dependencyCounts.set(dependentOperationId, remainingCount);
      if (remainingCount === 0) {
        ready.push(dependent);
        ready.sort(compareOperationContexts);
      }
    }
  }
  if (ordered.length !== contexts.length) {
    throw new Error("create_taskの一時参照関係が循環しています。");
  }
  return ordered;
}

function orderApplicableContexts(
  contexts: readonly OperationContext[],
  mappings: ReadonlyMap<string, string>,
): readonly OperationContext[] {
  const createContexts = contexts.filter(
    (context) => context.operation.operation === "create_task",
  );
  const remainingContexts = contexts
    .filter((context) => context.operation.operation !== "create_task")
    .sort((left, right) => {
      const phaseDifference = operationPhase(left.operation)
        - operationPhase(right.operation);
      if (phaseDifference !== 0) {
        return phaseDifference;
      }
      return compareOperationContexts(left, right);
    });
  return [
    ...orderCreateTaskContexts(createContexts, mappings),
    ...remainingContexts,
  ];
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
  context: OperationContext,
  target: ApplicationJournal["target"],
  groupOrder: number,
  operationOrder: number,
  settings: AsanaProposalApplicationInput,
  mappings: ReadonlyMap<string, string>,
  baselineSource: ApplicationJournalBaselineSource,
  uuids: ReadonlyMap<string, string>,
  startedAt: string,
): PlannedApplicationJournal {
  const operation = context.operation;
  const journalOperation = journalOperationForProposalOperation(operation, uuids);
  const plan = applicationJournalPlanSchema.parse({
    group_id: context.group.group_id,
    group_order: groupOrder,
    operation_order: operationOrder,
    atomic: context.group.atomic,
    project_gid: settings.project_gid,
    workspace_gid: settings.workspace_gid,
    section_gids: settings.section_gids,
    device_id: settings.device_id,
    created_via: settings.created_via,
    activity_date: settings.activity_date,
    temporary_ref_to_gid: mappingArray(mappings),
    baseline_source: baselineSource,
    operation: journalOperation,
    ...(operation.operation === "create_task"
      ? { create_uuid: uuids.get(operation.operation_id) }
      : {}),
  });
  return applicationJournalWithPlanSchema.parse({
    proposal_id: proposalId,
    operation_id: operation.operation_id,
    target,
    started_at: isoDateTimeSchema.parse(startedAt),
    stage: "prepared",
    plan,
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
  mappings: ReadonlyMap<string, string>,
): ExistingJournalDisposition {
  let taskGid: string | undefined;
  if (journal.target.kind === "task") {
    taskGid = journal.target.gid;
  } else if (
    journal.target.kind === "new_task"
    && context.operation.operation === "create_task"
  ) {
    taskGid = mappings.get(context.operation.temporary_ref);
  } else if (journal.target.kind === "temporary") {
    let operationTemporaryRef: string | undefined;
    if (context.operation.operation === "create_task") {
      operationTemporaryRef = context.operation.temporary_ref;
    } else if (context.operation.target.kind === "temporary") {
      operationTemporaryRef = context.operation.target.ref;
    }
    if (operationTemporaryRef === journal.target.ref) {
      taskGid = mappings.get(journal.target.ref);
    }
  }
  if (journal.final_result === "applied") {
    const result = taskGid == null
      ? unknownOperationResult(context, "recovery_required", undefined)
      : createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        taskGid,
      );
    return { kind: "return_result", block_group: taskGid == null, result };
  }
  if (journal.final_result != null) {
    const result = journal.final_result === "not_applied"
      ? createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "not_applied",
        "external_api_failed",
        taskGid,
      )
      : unknownOperationResult(context, "recovery_required", taskGid);
    return { kind: "return_result", block_group: true, result };
  }
  if (journal.stage === "prepared") {
    return {
      kind: "return_result",
      block_group: true,
      result: createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "not_applied",
        "external_api_failed",
        taskGid,
      ),
    };
  }
  if (
    (journal.stage === "read_back" || journal.stage === "metadata_verified")
    && hasApplicationJournalPlan(journal)
    && taskGid != null
  ) {
    return {
      kind: "resume_local_completion",
      entry: journal,
      result: createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        taskGid,
      ),
      task_gid: taskGid,
    };
  }
  if (
    journal.stage === "ranking_recalculated"
    && hasApplicationJournalPlan(journal)
    && taskGid != null
  ) {
    return {
      kind: "persist_final_result",
      entry: journal,
      result: createOperationResult(
        context.group.group_id,
        context.operation.operation_id,
        "already_applied",
        "already_applied",
        taskGid,
      ),
      task_gid: taskGid,
    };
  }
  return {
    kind: "return_result",
    block_group: true,
    result: unknownOperationResult(context, "recovery_required", taskGid),
  };
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

function recoverySettingsFromPlan(plan: ApplicationJournalPlan): RecoverySettings {
  return {
    project_gid: plan.project_gid,
    workspace_gid: plan.workspace_gid,
    section_gids: plan.section_gids,
    device_id: plan.device_id,
    created_via: plan.created_via,
    activity_date: plan.activity_date,
  };
}

function sameRecoverySettings(
  left: RecoverySettings,
  right: RecoverySettings,
): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function createRecoveryApplicationResult(
  proposalId: string,
  entries: readonly PlannedRecoveryEntry[],
  selectedOperationIds: ReadonlySet<string>,
  operationResults: ReadonlyMap<string, ApplicationOperationResult>,
): AsanaProposalApplicationResult {
  const groupsById = new Map<string, {
    readonly group: Pick<ProposalGroup, "group_id" | "atomic">;
    readonly group_order: number;
    readonly operations: ApplicationOperationResult[];
    readonly operation_ids: string[];
  }>();
  const sortedEntries = [...entries].sort((left, right) =>
    left.journal.plan.operation_order - right.journal.plan.operation_order);
  for (const entry of sortedEntries) {
    const operationId = entry.context.operation.operation_id;
    if (!selectedOperationIds.has(operationId)) {
      continue;
    }
    const result = operationResults.get(operationId);
    if (result == null) {
      throw new Error("復旧操作の結果がありません。");
    }
    const current = groupsById.get(entry.context.group.group_id);
    if (current == null) {
      groupsById.set(entry.context.group.group_id, {
        group: entry.context.group,
        group_order: entry.journal.plan.group_order,
        operations: [result],
        operation_ids: [operationId],
      });
      continue;
    }
    current.operations.push(result);
    current.operation_ids.push(operationId);
  }
  const groups = [...groupsById.values()]
    .sort((left, right) => left.group_order - right.group_order)
    .map((group) => ({
      group_id: group.group.group_id,
      atomic: group.group.atomic,
      operation_ids: group.operation_ids,
      outcome: applicationGroupOutcome(group.operations),
    }));
  const operations = [...operationResults.entries()]
    .filter(([operationId]) => selectedOperationIds.has(operationId))
    .sort(([left], [right]) => {
      const leftEntry = sortedEntries.find(
        (entry) => entry.context.operation.operation_id === left,
      );
      const rightEntry = sortedEntries.find(
        (entry) => entry.context.operation.operation_id === right,
      );
      if (leftEntry == null || rightEntry == null) {
        throw new Error("復旧操作の順序が見つかりません。");
      }
      return leftEntry.journal.plan.operation_order
        - rightEntry.journal.plan.operation_order;
    })
    .map(([, result]) => result);
  if (operations.length === 0 || groups.length === 0) {
    throw new Error("復旧対象の操作がありません。");
  }
  return asanaProposalApplicationResultSchema.parse({
    proposal_id: proposalId,
    outcome: applicationResultOutcome(groups),
    operations,
    groups,
  });
}

/** 承認済み変更案の適用と起動時復旧を管理します。 */
export class AsanaProposalApplicationCoordinator {
  private readonly readClient: AsanaReadClient;
  private readonly writer: AsanaProposalOperationWriter;
  private readonly journal: ApplicationJournalStorePort;
  private readonly uuidGenerator: ProposalApplicationUuidGenerator;
  private readonly timestampProvider: ProposalApplicationTimestampProvider;
  private readonly postApply: ProposalApplicationPostApply;
  private readonly diagnostic: ProposalApplicationDiagnostic;

  public constructor(
    readClient: AsanaReadClient,
    writer: AsanaProposalOperationWriter,
    journal: JournalPort,
    uuidGenerator: ProposalApplicationUuidGenerator,
    timestampProvider: ProposalApplicationTimestampProvider,
    postApply: ProposalApplicationPostApply,
    diagnostic: ProposalApplicationDiagnostic,
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
    this.diagnostic = diagnostic;
  }

  /** 承認済み変更案を作成・属性・関係の順で適用します。 */
  public async apply(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    try {
      return await this.applyValidated(input, signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof DiagnosticFailureDispositionError) {
        throw error;
      }
      const parsedInput = asanaProposalApplicationInputSchema.safeParse(input);
      throw this.escapeFailure(error, {
        severity: "error",
        ...(parsedInput.success ? { proposal_id: parsedInput.data.proposal_id } : {}),
        api_action: "journal_plan",
        effect_certainty: "none",
        reason_code: "application_failed",
        recovery_decision: "failed",
        attempt: 1,
        phase: "application",
      });
    }
  }

  private async applyValidated(
    input: AsanaProposalApplicationInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalApplicationResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const validatedInput = asanaProposalApplicationInputSchema.parse(input);
    const contexts = flattenProposal(validatedInput.approval_input.proposal);
    const contextMap = operationMap(contexts);
    const selected = selectedOperationSet(validatedInput);
    validateAtomicSelection(validatedInput.approval_input.proposal, selected);
    const mappings = temporaryMappingMap(
      validatedInput.approval_input.journal_task_mappings,
    );
    const existingJournals = new Map<string, ApplicationJournal>();
    for (const journal of this.journal.getByProposal(validatedInput.proposal_id)) {
      if (existingJournals.has(journal.operation_id)) {
        throw new Error("同じproposalの適用ジャーナルが重複しています。");
      }
      existingJournals.set(journal.operation_id, journal);
      if (hasApplicationJournalPlan(journal)) {
        for (const mapping of journal.plan.temporary_ref_to_gid) {
          addTemporaryMapping(mappings, mapping.temporary_ref, mapping.task_gid);
        }
      }
    }
    const approvalInput = {
      ...validatedInput.approval_input,
      journal_task_mappings: mappingArray(mappings),
    };
    const approval = proposalApprovalResultSchema.parse(
      classifyProposalConflicts(approvalInput),
    );
    const approvalOperations = approvalOperationMap(approval);
    const approvalGroups = approvalGroupMap(approval);
    const applicableOperationIds = collectApplicableOperationIds(
      contexts,
      selected,
      approvalOperations,
      approvalGroups,
    );
    const graphSafety = validateSelectedProposalGraph({
      proposal: validatedInput.approval_input.proposal,
      managed_tasks: validatedInput.approval_input.current_tasks,
      selected_operation_ids: [...applicableOperationIds],
      temporary_ref_mappings: mappingArray(mappings),
    });
    if (graphSafety.kind === "unsafe") {
      throw new Error(
        "競合分類後の実適用操作だけでは依存関係または親子関係に新しい循環が生じます。",
      );
    }
    const operationIdsToProcess = new Set(applicableOperationIds);
    for (const operationId of selected) {
      if (existingJournals.has(operationId)) {
        operationIdsToProcess.add(operationId);
      }
    }
    const applicable = operationIdsToProcess;
    const newApplicable = new Set(
      applicableOperationIds.filter(
        (operationId) => !existingJournals.has(operationId),
      ),
    );
    const uuids = issueCreateUuids(contexts, newApplicable, this.uuidGenerator);
    const baselines = baselineExternalMap(validatedInput.baseline_external_data);
    const newSelected = new Set(
      [...selected].filter((operationId) => !existingJournals.has(operationId)),
    );
    validateBaselineCoverage(contexts, newSelected, mappings, baselines);
    const operationResults = new Map<string, ApplicationOperationResult>();
    const operationGroupsBlocked = new Set<string>();
    const failedTemporaryRefs = new Set<string>();
    const pendingJournals: PendingJournal[] = [];

    for (const context of contexts) {
      if (!selected.has(context.operation.operation_id)) {
        continue;
      }
      if (existingJournals.has(context.operation.operation_id)) {
        continue;
      }
      const classification = approvalOperations.get(context.operation.operation_id);
      if (classification == null) {
        throw new Error("承認競合結果の操作がありません。");
      }
      if (classification.kind === "conflict") {
        this.reportJournalEvent(
          new Error("承認時点の外部状態と一致しないため、この操作を適用しませんでした。"),
          {
            severity: "warning",
            proposal_id: validatedInput.proposal_id,
            operation_id: context.operation.operation_id,
            operation_kind: context.operation.operation,
            api_action: "journal_plan",
            effect_certainty: "none",
            task_gid: targetGid(context.operation, mappings),
            reason_code: "approval_conflict",
            recovery_decision: "not_applied",
            attempt: 1,
            phase: "validation",
          },
        );
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
        this.reportJournalEvent(
          new Error("atomic group内に適用できない操作があるため、この操作を適用しませんでした。"),
          {
            severity: "warning",
            proposal_id: validatedInput.proposal_id,
            operation_id: context.operation.operation_id,
            operation_kind: context.operation.operation,
            api_action: "journal_plan",
            effect_certainty: "none",
            task_gid: targetGid(context.operation, mappings),
            reason_code: "atomic_group_blocked",
            recovery_decision: "not_applied",
            attempt: 1,
            phase: "validation",
          },
        );
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
    const applicableContexts = orderApplicableContexts(
      contexts.filter((context) =>
        applicable.has(context.operation.operation_id)),
      mappings,
    );
    const groupOrders = new Map<string, number>();
    validatedInput.approval_input.proposal.groups.forEach((group, index) => {
      groupOrders.set(group.group_id, index);
    });
    const preparedEntries = new Map<string, PlannedApplicationJournal>();
    const entriesToPrepare: ApplicationJournal[] = [];
    applicableContexts.forEach((context, operationOrder) => {
      const existingJournal = existingJournals.get(context.operation.operation_id);
      if (existingJournal != null) {
        return;
      }
      const groupOrder = groupOrders.get(context.group.group_id);
      if (groupOrder == null) {
        throw new Error("復旧計画のグループ順が見つかりません。");
      }
      const baselineSource = baselineSourceForOperation(
        validatedInput.proposal_id,
        context,
        contexts,
        applicable,
        mappings,
        baselines,
        this.journal,
      );
      const entry = journalEntry(
        validatedInput.proposal_id,
        context,
        operationTargetForJournal(context.operation, uuids),
        groupOrder,
        operationOrder,
        validatedInput,
        mappings,
        baselineSource,
        uuids,
        this.timestampProvider(),
      );
      preparedEntries.set(context.operation.operation_id, entry);
      entriesToPrepare.push(entry);
    });
    if (entriesToPrepare.length > 0) {
      this.journal.prepare(entriesToPrepare);
    }

    for (const context of applicableContexts) {
      throwIfAborted(signal);
      if (operationResults.has(context.operation.operation_id)) {
        continue;
      }
      const temporaryRef = temporaryTargetRef(context.operation);
      if (
        temporaryRef != null
        && failedTemporaryRefs.has(temporaryRef)
        && !existingJournals.has(context.operation.operation_id)
      ) {
        this.reportJournalEvent(
          new Error("一時参照元の操作が完了していないため、この操作を適用しませんでした。"),
          {
            severity: "warning",
            proposal_id: validatedInput.proposal_id,
            operation_id: context.operation.operation_id,
            operation_kind: context.operation.operation,
            api_action: "journal_plan",
            effect_certainty: "none",
            task_gid: targetGid(context.operation, mappings),
            reason_code: "external_api_failed",
            recovery_decision: "not_applied",
            attempt: 1,
            phase: "application",
          },
        );
        operationResults.set(
          context.operation.operation_id,
          createOperationResult(
            context.group.group_id,
            context.operation.operation_id,
            "not_applied",
            "external_api_failed",
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
      const existingJournal = existingJournals.get(context.operation.operation_id);
      if (existingJournal != null) {
        const disposition = resultForExistingJournal(
          context,
          existingJournal,
          mappings,
        );
        operationResults.set(context.operation.operation_id, disposition.result);
        if (disposition.kind === "resume_local_completion") {
          pendingJournals.push({
            entry: disposition.entry,
            context,
            task_gid: disposition.task_gid,
            operationResults,
          });
        } else if (disposition.kind === "persist_final_result") {
          try {
            this.journal.complete(
              disposition.entry.proposal_id,
              disposition.entry.operation_id,
              finalJournalResult("applied"),
            );
          } catch (error: unknown) {
            const receipt = this.reportOperationEventOnce(
              error,
              { journal: disposition.entry, context },
              {
                severity: "error",
                api_action: "post_apply",
                journal_stage: "ranking_recalculated",
                effect_certainty: "confirmed",
                reason_code: "recovery_required",
                recovery_decision: "unresolved",
                attempt: 1,
                phase: "journal",
              },
              disposition.task_gid,
            );
            throw receipt;
          }
        } else if (disposition.block_group && context.group.atomic) {
          operationGroupsBlocked.add(context.group.group_id);
          markAtomicGroupBlocked(
            contexts,
            selected,
            context.group.group_id,
            operationResults,
            mappings,
          );
        }
        if (
          disposition.kind === "return_result"
          && context.operation.operation === "create_task"
          && disposition.result.outcome !== "already_applied"
        ) {
          failedTemporaryRefs.add(context.operation.temporary_ref);
        }
        continue;
      }

      const entry = preparedEntries.get(context.operation.operation_id);
      if (entry == null) {
        throw new Error("prepared済み適用ジャーナルが見つかりません。");
      }
      const taskGid = targetGid(context.operation, mappings);
      const baseline = taskGid == null ? undefined : baselines.get(taskGid);
      if (
        context.operation.operation !== "create_task"
        && operationUsesCustomExternalData(context.operation)
        && baseline == null
      ) {
        throw new Error("承認時のCustom external data baselineがありません。");
      }
      const createUuid = context.operation.operation === "create_task"
        ? uuids.get(context.operation.operation_id)
        : undefined;
      if (context.operation.operation === "create_task") {
        if (createUuid == null) {
          throw new Error("create_taskの復旧UUIDがありません。");
        }
        let projectTasks: readonly AsanaTaskResponse[];
        try {
          projectTasks = await this.readClient.listProjectTasks(
            validatedInput.project_gid,
            signal,
          );
        } catch (error: unknown) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          const receipt = this.reportJournalEvent(error, {
            severity: "error",
            proposal_id: entry.proposal_id,
            operation_id: entry.operation_id,
            operation_kind: context.operation.operation,
            api_action: "read_project_tasks",
            journal_stage: "prepared",
            effect_certainty: "none",
            reason_code: "external_api_failed",
            recovery_decision: "resume",
            attempt: 1,
            phase: "preflight",
          });
          throw receipt;
        }
        const matches = matchingExternalTasks(uniqueTaskMap(projectTasks), createUuid);
        if (matches.length > 0) {
          this.reportJournalEvent(
            new Error("作成UUIDが既存タスクと一致したため、重複作成を行いませんでした。"),
            {
              severity: "warning",
              proposal_id: entry.proposal_id,
              operation_id: entry.operation_id,
              operation_kind: context.operation.operation,
              api_action: "read_project_tasks",
              journal_stage: "prepared",
              effect_certainty: "none",
              reason_code: "external_id_collision",
              recovery_decision: "external_id_collision",
              attempt: 1,
              phase: "preflight",
            },
          );
          this.journal.complete(
            entry.proposal_id,
            entry.operation_id,
            finalJournalResult("not_applied"),
          );
          operationResults.set(
            context.operation.operation_id,
            createOperationResult(
              context.group.group_id,
              context.operation.operation_id,
              "not_applied",
              "external_id_collision",
              undefined,
            ),
          );
          failedTemporaryRefs.add(context.operation.temporary_ref);
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
      const writerInput = createWriterInput(
        context,
        validatedInput,
        mappings,
        baseline,
        createUuid,
        undefined,
      );
      let entryForProgress = entry;
      let writeAttemptCount = 0;
      let lastWriteAction: ProposalOperationWriteAction | undefined;
      let createdTaskGid: string | undefined;
      let observedEffectCertainty: OperationDiagnosticFields["effect_certainty"] = "none";
      const currentEffectCertainty = (): OperationDiagnosticFields["effect_certainty"] => {
        if (createdTaskGid != null || observedEffectCertainty === "confirmed") {
          return "confirmed";
        }
        if (writeAttemptCount === 0) {
          return "none";
        }
        return "possible";
      };
      const onWriteAttempt = (action: ProposalOperationWriteAction): void => {
        if (writeAttemptCount === 0) {
          try {
            this.journal.updateStage(
              entry.proposal_id,
              entry.operation_id,
              "write_started",
            );
          } catch (error: unknown) {
            const receipt = this.reportOperationEventOnce(
              error,
              { journal: entryForProgress, context },
              {
                severity: "error",
                api_action: action,
                journal_stage: entryForProgress.stage,
                effect_certainty: observedEffectCertainty,
                reason_code: "external_api_failed",
                recovery_decision: "failed",
                attempt: 1,
                phase: "journal",
              },
              createdTaskGid ?? taskGid,
            );
            throw receipt;
          }
          entryForProgress = { ...entryForProgress, stage: "write_started" };
        }
        writeAttemptCount += 1;
        lastWriteAction = action;
        if (observedEffectCertainty !== "confirmed") {
          observedEffectCertainty = "possible";
        }
      };
      const onCreateTaskCreated = (operationId: string, taskGid: string): void => {
        if (operationId !== context.operation.operation_id) {
          throw new Error("作成済みタスク通知のoperation_idが一致しません。");
        }
        if (context.operation.operation !== "create_task") {
          throw new Error("create_task以外へ作成済みタスク通知を渡せません。");
        }
        createdTaskGid = taskGid;
        observedEffectCertainty = "confirmed";
        try {
          addTemporaryMapping(mappings, context.operation.temporary_ref, taskGid);
          this.journal.recordCreatedTask(
            entry.proposal_id,
            entry.operation_id,
            context.operation.temporary_ref,
            taskGid,
          );
        } catch (error: unknown) {
          const receipt = this.reportOperationEventOnce(
            error,
            { journal: entryForProgress, context },
            {
              severity: "error",
              api_action: lastWriteAction ?? "create_task",
              journal_stage: entryForProgress.stage,
              effect_certainty: "confirmed",
              reason_code: "recovery_required",
              recovery_decision: "unresolved",
              attempt: Math.max(1, writeAttemptCount),
              phase: "journal",
            },
            createdTaskGid,
          );
          throw receipt;
        }
        entryForProgress = { ...entryForProgress, stage: "task_created" };
      };
      let rawWriterResult: WriterResult;
      try {
        rawWriterResult = context.operation.operation === "create_task"
          ? await this.writer.applyWithCreateTaskCallback(
              writerInput,
              signal,
              onCreateTaskCreated,
              onWriteAttempt,
            )
          : await this.writer.applyWithWriteAttemptCallback(
              writerInput,
              signal,
              onWriteAttempt,
            );
      } catch (error) {
        if (signal.aborted) {
          signal.throwIfAborted();
          throw error;
        }
        if (context.operation.operation === "create_task") {
          failedTemporaryRefs.add(context.operation.temporary_ref);
        }
        const certainty = currentEffectCertainty();
        const reasonCode = certainty === "none"
          ? "external_api_failed"
          : "recovery_required";
        let phase: OperationDiagnosticFields["phase"];
        if (createdTaskGid != null && lastWriteAction === "create_task") {
          phase = "read_back";
        } else if (certainty === "none") {
          phase = "preflight";
        } else {
          phase = "external_write";
        }
        const receipt = this.reportOperationEventOnce(error, { journal: entryForProgress, context }, {
          severity: "error",
          api_action: lastWriteAction ?? "operation_writer",
          journal_stage: entryForProgress.stage,
          effect_certainty: certainty,
          reason_code: reasonCode,
          recovery_decision: certainty === "none" ? "resume" : "unresolved",
          attempt: Math.max(1, writeAttemptCount),
          phase,
        }, createdTaskGid ?? taskGid);
        if (!isKnownAsanaOperationalError(error)) {
          throw receipt;
        }
        operationResults.set(
          context.operation.operation_id,
          certainty === "none"
            ? createOperationResult(
              context.group.group_id,
              context.operation.operation_id,
              "not_applied",
              "external_api_failed",
              createdTaskGid ?? taskGid,
            )
            : unknownOperationResult(
              context,
              "recovery_required",
              createdTaskGid ?? taskGid,
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
      const parsedWriterResult = asanaProposalOperationWriterResultSchema.safeParse(
        rawWriterResult,
      );
      if (
        parsedWriterResult.success
        && parsedWriterResult.data.outcome !== "conflict"
      ) {
        observedEffectCertainty = "confirmed";
      }
      let writerResult: WriterResult;
      try {
        writerResult = validateWriterResult(context, rawWriterResult, taskGid);
      } catch (error: unknown) {
        const certainty = observedEffectCertainty;
        const receipt = this.reportOperationEventOnce(error, { journal: entryForProgress, context }, {
          severity: "error",
          api_action: lastWriteAction ?? "operation_writer",
          journal_stage: entryForProgress.stage,
          effect_certainty: certainty,
          reason_code: certainty === "none" ? "external_api_failed" : "recovery_required",
          recovery_decision: certainty === "none" ? "failed" : "unresolved",
          attempt: Math.max(1, writeAttemptCount),
          phase: "read_back",
        }, createdTaskGid ?? (parsedWriterResult.success
          ? parsedWriterResult.data.task_gid
          : taskGid));
        throw receipt;
      }
      if (writerResult.outcome === "conflict") {
        const certainty = writerResult.side_effect === "possible"
          ? "possible"
          : "none";
        this.reportJournalEvent(
          new Error("適用前後の外部状態を照合した結果、操作を確定できませんでした。"),
          {
            severity: certainty === "possible" ? "error" : "warning",
            proposal_id: entry.proposal_id,
            operation_id: entry.operation_id,
            operation_kind: context.operation.operation,
            api_action: lastWriteAction ?? "operation_writer",
            journal_stage: entryForProgress.stage,
            effect_certainty: certainty,
            task_gid: writerResult.task_gid,
            reason_code: writerResult.reason_code,
            recovery_decision: certainty === "possible" ? "unresolved" : "not_applied",
            attempt: Math.max(1, writeAttemptCount),
            phase: certainty === "possible" ? "external_write" : "preflight",
          },
        );
      }
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
        createdTaskGid = writerResult.task_gid;
        observedEffectCertainty = "confirmed";
        try {
          addTemporaryMapping(
            mappings,
            context.operation.temporary_ref,
            writerResult.task_gid,
          );
          const createdBaselineInput = createWriterInput(
            context,
            validatedInput,
            mappings,
            undefined,
            createUuid,
            undefined,
          );
          baselines.set(
            writerResult.task_gid,
            this.writer.createInitialExternalBaseline(createdBaselineInput),
          );
        } catch (error: unknown) {
          const receipt = this.reportOperationEventOnce(
            error,
            { journal: entryForProgress, context },
            {
              severity: "error",
              api_action: lastWriteAction ?? "create_task",
              journal_stage: entryForProgress.stage,
              effect_certainty: "confirmed",
              reason_code: "recovery_required",
              recovery_decision: "unresolved",
              attempt: Math.max(1, writeAttemptCount),
              phase: "journal",
            },
            createdTaskGid,
          );
          throw receipt;
        }
      }
      let metadataEntry: PlannedApplicationJournal | undefined;
      try {
        metadataEntry = recordJournalResultBeforeRanking(
          this.journal,
          entryForProgress,
          writerResult,
          (stage) => {
            entryForProgress = applicationJournalWithPlanSchema.parse({
              ...entryForProgress,
              stage,
            });
          },
        );
      } catch (error: unknown) {
        const certainty = writerResult.outcome === "conflict"
          ? writerResult.side_effect
          : "confirmed";
        const receipt = this.reportOperationEventOnce(error, { journal: entryForProgress, context }, {
          severity: "error",
          api_action: lastWriteAction ?? "operation_writer",
          journal_stage: entryForProgress.stage,
          effect_certainty: certainty,
          reason_code: certainty === "none" ? "external_api_failed" : "recovery_required",
          recovery_decision: certainty === "none" ? "failed" : "unresolved",
          attempt: Math.max(1, writeAttemptCount),
          phase: "journal",
        }, createdTaskGid ?? writerResult.task_gid);
        throw receipt;
      }
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
      (error, fields) => this.reportJournalEvent(error, fields),
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
    try {
      return await this.recoverValidated(input, signal);
    } catch (error: unknown) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof DiagnosticFailureDispositionError) {
        throw error;
      }
      let incomplete: readonly ApplicationJournal[];
      try {
        incomplete = this.journal.getIncomplete();
      } catch (diagnosticError: unknown) {
        throw new DiagnosticFailureDispositionError(
          combineDiagnosticFailureDispositions(
            diagnosticFailureDispositionFromError(error),
            [diagnosticFailureDispositionFromError(diagnosticError)],
          ),
        );
      }
      if (incomplete.length === 0) {
        throw this.reportEscapedError(error, {
          severity: "error",
          api_action: "journal_plan",
          effect_certainty: "possible",
          reason_code: "recovery_failed",
          recovery_decision: "failed",
          attempt: 1,
          phase: "recovery",
        });
      }
      let receipt: DiagnosticFailureDispositionError | undefined;
      for (const journal of incomplete) {
        receipt = this.reportJournalEvent(error, {
          severity: "error",
          proposal_id: journal.proposal_id,
          operation_id: journal.operation_id,
          ...(hasApplicationJournalPlan(journal)
            ? { operation_kind: journal.plan.operation.operation }
            : {}),
          api_action: "journal_plan",
          journal_stage: journal.stage,
          effect_certainty: effectCertaintyForJournalStage(journal.stage),
          ...(journal.target.kind === "task" ? { task_gid: journal.target.gid } : {}),
          reason_code: "recovery_failed",
          recovery_decision: "failed",
          attempt: 1,
          phase: "recovery",
        });
      }
      if (receipt == null) {
        throw new Error("復旧失敗の診断receiptがありません。");
      }
      throw receipt;
    }
  }

  private async recoverValidated(
    input: AsanaProposalRecoveryInput,
    signal: AbortSignal,
  ): Promise<AsanaProposalRecoveryResult> {
    validateAbortSignal(signal);
    throwIfAborted(signal);
    const validatedInput = asanaProposalRecoveryInputSchema.parse(input);
    const applicationsByProposal = new Map<
      string,
      AsanaProposalRecoveryInput["applications"][number]
    >();
    for (const application of validatedInput.applications) {
      applicationsByProposal.set(application.proposal_id, application);
    }
    const incomplete = this.journal.getIncomplete();
    for (const journal of incomplete) {
      this.reportJournalEvent(
        new Error("未完了のAI適用ジャーナルの復旧を開始しました。"),
        {
          severity: "warning",
          proposal_id: journal.proposal_id,
          operation_id: journal.operation_id,
          ...(hasApplicationJournalPlan(journal)
            ? { operation_kind: journal.plan.operation.operation }
            : {}),
          api_action: "journal_plan",
          journal_stage: journal.stage,
          effect_certainty: effectCertaintyForJournalStage(journal.stage),
          ...(journal.target.kind === "task" ? { task_gid: journal.target.gid } : {}),
          reason_code: "recovery_started",
          recovery_decision: "inspect",
          attempt: 1,
          phase: "recovery",
        },
      );
    }
    const plannedJournalsByProposal = new Map<string, PlannedApplicationJournal[]>();
    const unresolved: AsanaProposalRecoveryResult["unresolved_journals"] = [];
    const unresolvedKeys = new Set<string>();
    const addUnresolved = (
      journal: ApplicationJournal,
      reasonCode: RecoveryReasonCode,
      taskGid: string | undefined,
    ): void => {
      const key = `${journal.proposal_id}\u0000${journal.operation_id}`;
      if (unresolvedKeys.has(key)) {
        return;
      }
      unresolvedKeys.add(key);
      unresolved.push(incompleteJournalResult(journal, reasonCode, taskGid));
    };
    for (const journal of incomplete) {
      if (!hasApplicationJournalPlan(journal)) {
        continue;
      }
      if (journal.final_result === "unknown") {
        const operation = journal.plan.operation;
        const createdTaskGid = operation.operation === "create_task"
          ? journal.plan.temporary_ref_to_gid.find(
            (mapping) => mapping.temporary_ref === operation.temporary_ref,
          )?.task_gid
          : undefined;
        const taskGid = journal.target.kind === "task"
          ? journal.target.gid
          : createdTaskGid;
        const effectCertainty = effectCertaintyForJournalStage(journal.stage);
        addUnresolved(journal, "recovery_required", taskGid);
        this.reportJournalEvent(
          new Error("既にunknownの適用ジャーナルは外部操作を再開せず未確定として扱います。"),
          {
            severity: "error",
            proposal_id: journal.proposal_id,
            operation_id: journal.operation_id,
            operation_kind: journal.plan.operation.operation,
            api_action: "journal_plan",
            journal_stage: journal.stage,
            effect_certainty: effectCertainty,
            ...(taskGid == null ? {} : { task_gid: taskGid }),
            reason_code: "recovery_required",
            recovery_decision: "unresolved",
            attempt: 1,
            phase: "recovery",
          },
        );
      }
      const journals = plannedJournalsByProposal.get(journal.proposal_id) ?? [];
      journals.push(journal);
      plannedJournalsByProposal.set(journal.proposal_id, journals);
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
    const readTask = async (
      taskGid: string,
    ): Promise<AsanaTaskResponse | undefined> => {
      try {
        return asanaTaskResponseSchema.parse(
          await this.readClient.getTask(taskGid, signal),
        );
      } catch (error) {
        if (error instanceof AsanaHttpError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    };
    for (const journal of incomplete) {
      throwIfAborted(signal);
      if (hasApplicationJournalPlan(journal)) {
        continue;
      }
      if (journal.final_result == null) {
        this.journal.complete(
          journal.proposal_id,
          journal.operation_id,
          finalJournalResult("unknown"),
        );
      }
      const reasonCode = journal.stage === "legacy_unresolved"
        && journal.recovery_reason === "journal_target_mismatch"
        ? "journal_target_mismatch"
        : "recovery_context_missing";
      addUnresolved(journal, reasonCode, undefined);
      this.reportJournalEvent(
        journal.stage === "legacy_unresolved"
          && journal.recovery_cause != null
          ? journal.recovery_cause
          : new Error("旧形式のAI適用ジャーナルには安全な復旧計画がありません。"),
        {
          severity: "error",
          proposal_id: journal.proposal_id,
          operation_id: journal.operation_id,
          api_action: "journal_plan",
          journal_stage: journal.stage,
          effect_certainty: "possible",
          ...(journal.target.kind === "task" ? { task_gid: journal.target.gid } : {}),
          reason_code: reasonCode,
          recovery_decision: "unresolved",
          attempt: 1,
          phase: "recovery",
        },
      );
      this.journal.clearRecoveryCause(journal.proposal_id, journal.operation_id);
    }

    const applicationStates: RecoveryApplicationState[] = [];
    for (const [proposalId] of plannedJournalsByProposal) {
      throwIfAborted(signal);
      const mappings = new Map<string, string>();
      const entries: PlannedRecoveryEntry[] = [];
      const plannedEntries: PlannedRecoveryEntry[] = [];
      const operationIds = new Set<string>();
      const operationOrders = new Set<number>();
      const groupDefinitions = new Map<string, { readonly order: number; readonly atomic: boolean }>();
      const groupOrders = new Map<number, string>();
      const blockedGroupIds = new Set<string>();
      let settings: RecoverySettings | undefined;
      const allProposalJournals = this.journal.getByProposal(proposalId);
      for (const journal of allProposalJournals) {
        if (!hasApplicationJournalPlan(journal)) {
          continue;
        }
        for (const mapping of journal.plan.temporary_ref_to_gid) {
          addTemporaryMapping(mappings, mapping.temporary_ref, mapping.task_gid);
        }
      }
      for (const journal of allProposalJournals) {
        if (!hasApplicationJournalPlan(journal)) {
          continue;
        }
        const plan = journal.plan;
        if (journal.operation_id !== plan.operation.operation_id) {
          throw new Error("適用ジャーナルと復旧計画の操作IDが一致しません。");
        }
        if (operationIds.has(journal.operation_id)) {
          throw new Error("同じ適用ジャーナルを重複して復旧できません。");
        }
        if (operationOrders.has(plan.operation_order)) {
          throw new Error("復旧計画のoperation_orderが重複しています。");
        }
        operationIds.add(journal.operation_id);
        operationOrders.add(plan.operation_order);
        const existingGroup = groupDefinitions.get(plan.group_id);
        if (
          existingGroup != null
          && (
            existingGroup.order !== plan.group_order
            || existingGroup.atomic !== plan.atomic
          )
        ) {
          throw new Error("復旧計画のグループ定義が一致しません。");
        }
        const existingGroupOrder = groupOrders.get(plan.group_order);
        if (existingGroupOrder != null && existingGroupOrder !== plan.group_id) {
          throw new Error("復旧計画のグループ順が重複しています。");
        }
        groupDefinitions.set(plan.group_id, {
          order: plan.group_order,
          atomic: plan.atomic,
        });
        groupOrders.set(plan.group_order, plan.group_id);
        const currentSettings = recoverySettingsFromPlan(plan);
        if (settings == null) {
          settings = currentSettings;
        } else if (!sameRecoverySettings(settings, currentSettings)) {
          throw new Error("同じproposalの復旧計画設定が一致しません。");
        }
        for (const mapping of plan.temporary_ref_to_gid) {
          addTemporaryMapping(mappings, mapping.temporary_ref, mapping.task_gid);
        }
        const context: OperationContext = {
          group: {
            group_id: plan.group_id,
            atomic: plan.atomic,
          },
          operation: proposalOperationForJournalOperation(plan.operation),
        };
        const plannedEntry = { journal, context };
        plannedEntries.push(plannedEntry);
        if (journal.final_result == null) {
          entries.push(plannedEntry);
        }
        if (
          plan.atomic
          && journal.final_result != null
          && journal.final_result !== "applied"
        ) {
          blockedGroupIds.add(plan.group_id);
        }
      }
      if (settings == null) {
        throw new Error("復旧計画の設定がありません。");
      }
      const application = applicationsByProposal.get(proposalId);
      if (application != null) {
        const applicationSettings: RecoverySettings = {
          project_gid: application.project_gid,
          workspace_gid: application.workspace_gid,
          section_gids: application.section_gids,
          device_id: application.device_id,
          created_via: application.created_via,
          activity_date: application.activity_date,
        };
        if (!sameRecoverySettings(settings, applicationSettings)) {
          throw new Error("復旧計画と再開コンテキストの設定が一致しません。");
        }
        const memoryContexts = operationMap(flattenProposal(application.proposal));
        const memoryContextsForOrder: OperationContext[] = [];
        const memoryGroupOrders = new Map<string, number>();
        application.proposal.groups.forEach((group, index) => {
          memoryGroupOrders.set(group.group_id, index);
        });
        for (const entry of plannedEntries) {
          const memoryContext = memoryContexts.get(entry.context.operation.operation_id);
          if (memoryContext == null) {
            throw new Error("復旧計画の操作が再開コンテキストにありません。");
          }
          if (
            memoryContext.group.group_id !== entry.context.group.group_id
            || memoryContext.group.atomic !== entry.context.group.atomic
          ) {
            throw new Error("復旧計画と再開コンテキストのグループが一致しません。");
          }
          if (memoryGroupOrders.get(memoryContext.group.group_id) !== entry.journal.plan.group_order) {
            throw new Error("復旧計画と再開コンテキストのグループ順が一致しません。");
          }
          memoryContextsForOrder.push(memoryContext);
          const uuids = new Map<string, string>();
          if (entry.journal.plan.operation.operation === "create_task") {
            const createUuid = entry.journal.plan.create_uuid;
            if (createUuid == null) {
              throw new Error("復旧計画の作成UUIDがありません。");
            }
            uuids.set(entry.context.operation.operation_id, createUuid);
          }
          const memoryOperation = journalOperationForProposalOperation(
            memoryContext.operation,
            uuids,
          );
          if (!journalOperationsMatch(memoryOperation, entry.journal.plan.operation)) {
            throw new Error("復旧計画と再開コンテキストの操作が一致しません。");
          }
        }
        const orderedMemoryContexts = orderApplicableContexts(
          memoryContextsForOrder,
          mappings,
        );
        const orderedPlanOperationIds = [...plannedEntries]
          .sort((left, right) =>
            left.journal.plan.operation_order - right.journal.plan.operation_order)
          .map((entry) => entry.context.operation.operation_id);
        const orderedMemoryOperationIds = orderedMemoryContexts.map(
          (context) => context.operation.operation_id,
        );
        if (
          orderedPlanOperationIds.length !== orderedMemoryOperationIds.length
          || orderedPlanOperationIds.some(
            (operationId, index) => operationId !== orderedMemoryOperationIds[index],
          )
        ) {
          throw new Error("復旧計画と再開コンテキストの操作順が一致しません。");
        }
      }
      const operationResults = new Map<string, ApplicationOperationResult>();
      for (const entry of plannedEntries) {
        validateMemoryBaselineSource(
          this.writer,
          application,
          entry,
          plannedEntries,
          settings,
          mappings,
        );
      }
      applicationStates.push({
        application,
        entries,
        plannedEntries,
        settings,
        mappings,
        blockedGroupIds,
        selected: new Set(),
        operationResults,
      });
    }

    const pendingJournals: {
      readonly state: RecoveryApplicationState;
      readonly pending: RecoveryPendingJournal;
    }[] = [];
    for (const state of applicationStates) {
      const stageByOperation = new Map<string, ApplicationJournalStage>();
      const observedEffectByOperation = new Map<
        string,
        OperationDiagnosticFields["effect_certainty"]
      >();
      for (const entry of state.entries) {
        stageByOperation.set(entry.journal.operation_id, entry.journal.stage);
        observedEffectByOperation.set(
          entry.journal.operation_id,
          effectCertaintyForJournalStage(entry.journal.stage),
        );
      }
      const blockedGroups = new Set(state.blockedGroupIds);
      const statePending: RecoveryPendingJournal[] = [];
      const markUnresolved = (
        entry: PlannedRecoveryEntry,
        reasonCode: RecoveryReasonCode,
        taskGid: string | undefined,
      ): void => {
        const stage = stageByOperation.get(entry.journal.operation_id);
        if (stage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        const effectCertainty = observedEffectByOperation.get(
          entry.journal.operation_id,
        );
        if (effectCertainty == null) {
          throw new Error("復旧対象の外部作用確度がありません。");
        }
        try {
          this.journal.complete(
            entry.journal.proposal_id,
            entry.journal.operation_id,
            finalJournalResult("unknown"),
          );
        } catch (error: unknown) {
          const receipt = this.reportOperationEventOnce(
            error,
            entry,
            {
              severity: "error",
              api_action: "journal_plan",
              journal_stage: stage,
              effect_certainty: effectCertainty,
              reason_code: "recovery_failed",
              recovery_decision: "failed",
              attempt: 1,
              phase: "journal",
            },
            taskGid,
          );
          throw receipt;
        }
        addUnresolved(entry.journal, reasonCode, taskGid);
        this.reportOperationEvent(
          new Error("復旧時に外部状態を確定できず、要整理項目にしました。"),
          entry,
          {
            severity: "error",
            api_action: "journal_plan",
            journal_stage: stage,
            effect_certainty: effectCertainty,
            reason_code: reasonCode,
            recovery_decision: "unresolved",
            attempt: 1,
            phase: "recovery",
          },
          taskGid,
        );
        if (entry.context.group.atomic) {
          blockedGroups.add(entry.context.group.group_id);
        }
      };
      const completeNotApplied = (
        entry: PlannedRecoveryEntry,
        reasonCode:
          | "atomic_group_blocked"
          | "external_id_collision"
          | "writer_conflict"
          | "external_api_failed"
          | "task_not_found",
        taskGid: string | undefined,
      ): void => {
        const stage = stageByOperation.get(entry.journal.operation_id);
        if (stage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        this.journal.complete(
          entry.journal.proposal_id,
          entry.journal.operation_id,
          finalJournalResult("not_applied"),
        );
        state.selected.add(entry.context.operation.operation_id);
        state.operationResults.set(
          entry.context.operation.operation_id,
          createOperationResult(
            entry.context.group.group_id,
            entry.context.operation.operation_id,
            "not_applied",
            reasonCode,
            taskGid,
          ),
        );
        this.reportOperationEvent(
          new Error("復旧時に外部変更が未適用と確定したため、再送せず完了しました。"),
          entry,
          {
            severity: "warning",
            api_action: "journal_plan",
            journal_stage: stage,
            effect_certainty: "none",
            reason_code: reasonCode,
            recovery_decision: "not_applied",
            attempt: 1,
            phase: "recovery",
          },
          taskGid,
        );
        if (entry.context.group.atomic) {
          blockedGroups.add(entry.context.group.group_id);
        }
      };
      const updateStage = (
        entry: PlannedRecoveryEntry,
        targetStage: ApplicationJournalStage,
      ): void => {
        const currentStage = stageByOperation.get(entry.journal.operation_id);
        if (currentStage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        const currentIndex = journalStages.indexOf(currentStage);
        const targetIndex = journalStages.indexOf(targetStage);
        if (currentIndex < 0 || targetIndex < 0) {
          throw new Error("復旧対象の適用段階が不正です。");
        }
        if (targetIndex < currentIndex) {
          throw new Error("復旧対象の適用段階を後退させられません。");
        }
        for (let index = currentIndex + 1; index <= targetIndex; index += 1) {
          const stage = journalStages[index];
          if (stage == null) {
            throw new Error("復旧対象の適用段階が見つかりません。");
          }
          this.journal.updateStage(
            entry.journal.proposal_id,
            entry.journal.operation_id,
            stage,
          );
          stageByOperation.set(entry.journal.operation_id, stage);
        }
      };
      const finishKnown = (
        entry: PlannedRecoveryEntry,
        result: ApplicationOperationResult,
        taskGid: string,
        apiAction: OperationDiagnosticFields["api_action"],
        attempt: number,
      ): void => {
        if (stageByOperation.get(entry.journal.operation_id) == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        observedEffectByOperation.set(entry.journal.operation_id, "confirmed");
        state.selected.add(entry.context.operation.operation_id);
        state.operationResults.set(entry.context.operation.operation_id, result);
        try {
          const stage = stageByOperation.get(entry.journal.operation_id);
          if (stage == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          const stageIndex = journalStages.indexOf(stage);
          const readBackIndex = journalStages.indexOf("read_back");
          const metadataIndex = journalStages.indexOf("metadata_verified");
          const rankingIndex = journalStages.indexOf("ranking_recalculated");
          if (stageIndex < readBackIndex) {
            updateStage(entry, "read_back");
          }
          const currentStage = stageByOperation.get(entry.journal.operation_id);
          if (currentStage == null) {
            throw new Error("復旧後の適用段階がありません。");
          }
          if (journalStages.indexOf(currentStage) < metadataIndex) {
            updateStage(entry, "metadata_verified");
          }
          const updatedStage = stageByOperation.get(entry.journal.operation_id);
          if (updatedStage == null) {
            throw new Error("復旧後の適用段階がありません。");
          }
          if (journalStages.indexOf(updatedStage) < rankingIndex) {
            statePending.push({
              entry: {
                ...entry,
                journal: applicationJournalWithPlanSchema.parse({
                  ...entry.journal,
                  stage: updatedStage,
                }),
              },
              task_gid: taskGid,
            });
          } else {
            this.journal.complete(
              entry.journal.proposal_id,
              entry.journal.operation_id,
              finalJournalResult("applied"),
            );
          }
        } catch (error: unknown) {
          const stage = stageByOperation.get(entry.journal.operation_id)
            ?? entry.journal.stage;
          const receipt = this.reportOperationEventOnce(
            error,
            entry,
            {
              severity: "error",
              api_action: apiAction,
              journal_stage: stage,
              effect_certainty: "confirmed",
              reason_code: "recovery_required",
              recovery_decision: "unresolved",
              attempt,
              phase: "journal",
            },
            taskGid,
          );
          throw receipt;
        }
      };
      for (const entry of state.entries) {
        throwIfAborted(signal);
        const operationId = entry.context.operation.operation_id;
        const currentStage = stageByOperation.get(operationId);
        if (currentStage == null) {
          throw new Error("復旧対象の適用段階がありません。");
        }
        const currentStageIndex = journalStages.indexOf(currentStage);
        if (currentStageIndex < 0) {
          throw new Error("復旧対象の適用段階が不正です。");
        }
        let createdTaskGid: string | undefined;
        if (entry.context.operation.operation === "create_task") {
          createdTaskGid = state.mappings.get(entry.context.operation.temporary_ref);
        }
        const taskGidForResult = (): string | undefined => {
          if (entry.context.operation.operation === "create_task") {
            return createdTaskGid
              ?? state.mappings.get(entry.context.operation.temporary_ref);
          }
          return targetGid(entry.context.operation, state.mappings);
        };
        let writeAttemptCount = 0;
        let lastWriteAction: ProposalOperationWriteAction | undefined;
        const onWriteAttempt = (action: ProposalOperationWriteAction): void => {
          const current = stageByOperation.get(operationId);
          if (current == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          if (current === "prepared") {
            try {
              updateStage(entry, "write_started");
            } catch (error: unknown) {
              const stage = stageByOperation.get(operationId);
              if (stage == null) {
                throw error;
              }
              const receipt = this.reportOperationEventOnce(
                error,
                entry,
                {
                  severity: "error",
                  api_action: action,
                  journal_stage: stage,
                  effect_certainty: observedEffectByOperation.get(operationId)
                    ?? "none",
                  reason_code: "recovery_required",
                  recovery_decision: "failed",
                  attempt: 1,
                  phase: "journal",
                },
                taskGidForResult(),
              );
              throw receipt;
            }
          }
          const stage = stageByOperation.get(operationId);
          if (stage == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          writeAttemptCount += 1;
          lastWriteAction = action;
          if (observedEffectByOperation.get(operationId) !== "confirmed") {
            observedEffectByOperation.set(operationId, "possible");
          }
          this.reportOperationEvent(
            new Error("復旧可能な外部操作を限定再開します。"),
            entry,
            {
              severity: "warning",
              api_action: action,
              journal_stage: stage,
              effect_certainty: observedEffectByOperation.get(operationId)
                ?? "none",
              reason_code: "recovery_required",
              recovery_decision: "resume",
              attempt: writeAttemptCount,
              phase: "external_write",
            },
            taskGidForResult(),
          );
        };
        const reportRecoveryError = (
          error: unknown,
          apiAction:
            | ProposalOperationWriteAction
            | "operation_writer"
            | "read_task"
            | "read_project_tasks",
          phase: OperationDiagnosticFields["phase"],
        ): DiagnosticFailureDispositionError => {
          const stage = stageByOperation.get(operationId);
          if (stage == null) {
            throw new Error("復旧対象の適用段階がありません。");
          }
          const effectCertainty = observedEffectByOperation.get(operationId);
          if (effectCertainty == null) {
            throw new Error("復旧対象の外部作用確度がありません。");
          }
          return this.reportOperationEventOnce(
            error,
            entry,
            {
              severity: "error",
              api_action: apiAction,
              journal_stage: stage,
              effect_certainty: effectCertainty,
              reason_code: effectCertainty === "none"
                ? "external_api_failed"
                : "recovery_required",
              recovery_decision: effectCertainty === "none"
                ? "failed"
                : "unresolved",
              attempt: Math.max(1, writeAttemptCount),
              phase,
            },
            taskGidForResult(),
          );
        };
        if (
          currentStage === "read_back"
          || currentStage === "metadata_verified"
          || currentStage === "ranking_recalculated"
        ) {
          const taskGid = taskGidForResult();
          if (taskGid == null) {
            markUnresolved(entry, "recovery_required", taskGid);
            continue;
          }
          finishKnown(
            entry,
            createOperationResult(
              entry.context.group.group_id,
              operationId,
              "already_applied",
              "already_applied",
              taskGid,
            ),
            taskGid,
            currentStage === "ranking_recalculated" ? "post_apply" : "read_task",
            1,
          );
          continue;
        }
        if (blockedGroups.has(entry.context.group.group_id)) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "atomic_group_blocked", taskGidForResult());
          } else {
            markUnresolved(entry, "recovery_required", taskGidForResult());
          }
          continue;
        }
        const missingTemporaryReference = operationTemporaryReferences(
          entry.context.operation,
        ).find((temporaryRef) => !state.mappings.has(temporaryRef));
        if (missingTemporaryReference != null) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "task_not_found", taskGidForResult());
          } else {
            markUnresolved(entry, "recovery_required", taskGidForResult());
          }
          continue;
        }

        if (entry.context.operation.operation === "create_task") {
          const operation = entry.context.operation;
          const createUuid = entry.journal.plan.create_uuid;
          if (createUuid == null || operation.operation !== "create_task") {
            throw new Error("create_taskの復旧UUIDがありません。");
          }
          let existingTask: AsanaTaskResponse | undefined;
          const mappedGid = state.mappings.get(operation.temporary_ref);
          if (currentStage === "prepared") {
            let matches: readonly AsanaTaskResponse[];
            try {
              const tasks = await loadProjectTasks(state.settings.project_gid);
              matches = matchingExternalTasks(tasks, createUuid);
            } catch (error) {
              if (signal.aborted) {
                signal.throwIfAborted();
                throw error;
              }
              throw reportRecoveryError(error, "read_project_tasks", "preflight");
            }
            if (matches.length > 0) {
              completeNotApplied(entry, "external_id_collision", undefined);
              continue;
            }
            if (mappedGid != null) {
              throw new Error("prepared create_taskに作成済みGID対応が残っています。");
            }
          } else if (mappedGid != null) {
            try {
              existingTask = await readTask(mappedGid);
            } catch (error) {
              if (signal.aborted) {
                signal.throwIfAborted();
                throw error;
              }
              throw reportRecoveryError(error, "read_task", "read_back");
            }
            if (existingTask == null) {
              markUnresolved(entry, "task_not_found", mappedGid);
              continue;
            }
          } else {
            let matches: readonly AsanaTaskResponse[];
            try {
              const tasks = await loadProjectTasks(state.settings.project_gid);
              matches = matchingExternalTasks(tasks, createUuid);
            } catch (error) {
              if (signal.aborted) {
                signal.throwIfAborted();
                throw error;
              }
              throw reportRecoveryError(error, "read_project_tasks", "read_back");
            }
            if (matches.length > 1) {
              markUnresolved(entry, "duplicate_external_id", undefined);
              continue;
            }
            existingTask = matches[0];
            if (existingTask == null) {
              markUnresolved(entry, "task_not_found", undefined);
              continue;
            }
            if (existingTask != null) {
              createdTaskGid = existingTask.gid;
              observedEffectByOperation.set(operationId, "confirmed");
              try {
                addTemporaryMapping(state.mappings, operation.temporary_ref, existingTask.gid);
                this.journal.recordCreatedTask(
                  entry.journal.proposal_id,
                  entry.journal.operation_id,
                  operation.temporary_ref,
                  existingTask.gid,
                );
              } catch (error: unknown) {
                const stage = stageByOperation.get(operationId);
                if (stage == null) {
                  throw error;
                }
                const receipt = this.reportOperationEventOnce(
                  error,
                  entry,
                  {
                    severity: "error",
                    api_action: "read_project_tasks",
                    journal_stage: stage,
                    effect_certainty: "confirmed",
                    reason_code: "recovery_required",
                    recovery_decision: "unresolved",
                    attempt: 1,
                    phase: "journal",
                  },
                  createdTaskGid,
                );
                throw receipt;
              }
              const stage = stageByOperation.get(operationId);
              if (stage == null) {
                throw new Error("復旧対象の適用段階がありません。");
              }
              stageByOperation.set(
                operationId,
                stage === "write_started" ? "task_created" : stage,
              );
              this.reportOperationEvent(
                new Error("作成UUIDと一致するタスクが一件だけ見つかり、復旧対象として結び付けました。"),
                entry,
                {
                  severity: "warning",
                  api_action: "read_project_tasks",
                  journal_stage: stageByOperation.get(entry.journal.operation_id)
                    ?? currentStage,
                  effect_certainty: "confirmed",
                  reason_code: "recovery_required",
                  recovery_decision: "resume",
                  attempt: 1,
                  phase: "read_back",
                },
                existingTask.gid,
              );
            }
          }
          const stageBeforeWrite = stageByOperation.get(entry.journal.operation_id);
          if (stageBeforeWrite == null) {
            throw new Error("create_taskの復旧段階がありません。");
          }
          const writerInput = createWriterInput(
            entry.context,
            state.settings,
            state.mappings,
            undefined,
            createUuid,
            existingTask,
          );
          let rawWriterResult: WriterResult;
          try {
          if (journalStages.indexOf(stageBeforeWrite) >= journalStages.indexOf("read_back")) {
              if (existingTask == null) {
                markUnresolved(entry, "task_not_found", undefined);
                continue;
              }
              const inspection = await this.writer.inspectRecovery(writerInput, signal);
              if (inspection.core_state !== "after" || inspection.metadata_state !== "after") {
                markUnresolved(entry, "recovery_required", existingTask.gid);
                continue;
              }
              finishKnown(
                entry,
                createOperationResult(
                  entry.context.group.group_id,
                  operationId,
                  "already_applied",
                  "already_applied",
                  inspection.task.gid,
                ),
                inspection.task.gid,
                "read_task",
                1,
              );
              continue;
            }
              rawWriterResult = await this.writer.applyWithCreateTaskCallback(
              writerInput,
              signal,
              (createdOperationId, taskGid) => {
                if (createdOperationId !== operationId) {
                  throw new Error("作成済みタスク通知のoperation_idが一致しません。");
                }
                createdTaskGid = taskGid;
                observedEffectByOperation.set(operationId, "confirmed");
                try {
                  addTemporaryMapping(state.mappings, operation.temporary_ref, taskGid);
                  this.journal.recordCreatedTask(
                    entry.journal.proposal_id,
                    entry.journal.operation_id,
                    operation.temporary_ref,
                    taskGid,
                  );
                } catch (error: unknown) {
                  const stage = stageByOperation.get(operationId);
                  if (stage == null) {
                    throw error;
                  }
                  const receipt = this.reportOperationEventOnce(
                    error,
                    entry,
                    {
                      severity: "error",
                      api_action: lastWriteAction ?? "create_task",
                      journal_stage: stage,
                      effect_certainty: "confirmed",
                      reason_code: "recovery_required",
                      recovery_decision: "unresolved",
                      attempt: Math.max(1, writeAttemptCount),
                      phase: "journal",
                    },
                    createdTaskGid,
                  );
                  throw receipt;
                }
                const stage = stageByOperation.get(operationId);
                if (stage == null) {
                  throw new Error("復旧対象の適用段階がありません。");
                }
                stageByOperation.set(
                  operationId,
                  stage === "write_started" ? "task_created" : stage,
                );
              },
              onWriteAttempt,
            );
          } catch (error) {
            if (signal.aborted) {
              signal.throwIfAborted();
              throw error;
            }
            throw reportRecoveryError(
              error,
              lastWriteAction ?? "operation_writer",
              journalStages.indexOf(stageBeforeWrite) >= journalStages.indexOf("read_back")
                ? "read_back"
                : "external_write",
            );
          }
          const expectedTaskGid = existingTask?.gid;
          const parsedWriterResult = asanaProposalOperationWriterResultSchema.safeParse(
            rawWriterResult,
          );
          if (
            parsedWriterResult.success
            && parsedWriterResult.data.outcome !== "conflict"
          ) {
            observedEffectByOperation.set(operationId, "confirmed");
          }
          let writerResult: WriterResult;
          try {
            writerResult = validateWriterResult(
              entry.context,
              rawWriterResult,
              expectedTaskGid,
            );
          } catch (error: unknown) {
            throw reportRecoveryError(
              error,
              lastWriteAction ?? "create_task",
              "read_back",
            );
          }
          if (writerResult.outcome === "conflict") {
            markUnresolved(
              entry,
              "recovery_required",
              createdTaskGid ?? writerResult.task_gid,
            );
            continue;
          }
          createdTaskGid = writerResult.task_gid;
          observedEffectByOperation.set(operationId, "confirmed");
          try {
            addTemporaryMapping(
              state.mappings,
              operation.temporary_ref,
              writerResult.task_gid,
            );
          } catch (error: unknown) {
            throw reportRecoveryError(
              error,
              lastWriteAction ?? "create_task",
              "journal",
            );
          }
          finishKnown(
            entry,
            writerResultToApplicationResult(entry.context, writerResult),
            writerResult.task_gid,
            lastWriteAction ?? "create_task",
            Math.max(1, writeAttemptCount),
          );
          continue;
        }

        const taskGid = targetGid(entry.context.operation, state.mappings);
        if (taskGid == null) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "task_not_found", undefined);
          } else {
            markUnresolved(entry, "recovery_required", undefined);
          }
          continue;
        }
        let task: AsanaTaskResponse | undefined;
        try {
          task = await readTask(taskGid);
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          throw reportRecoveryError(error, "read_task", "read_back");
        }
        if (task == null) {
          if (currentStage === "prepared") {
            completeNotApplied(entry, "task_not_found", taskGid);
          } else {
            markUnresolved(entry, "task_not_found", taskGid);
          }
          continue;
        }
        const baseline = baselineFromJournalPlan(
          this.writer,
          entry,
          state.plannedEntries,
          state.settings,
          state.mappings,
        );
        const writerInput = createWriterInput(
          entry.context,
          state.settings,
          state.mappings,
          baseline,
          undefined,
          undefined,
        );
        let inspection: Awaited<ReturnType<AsanaProposalOperationWriter["inspectRecovery"]>>;
        try {
          inspection = await this.writer.inspectRecovery(writerInput, signal);
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          throw reportRecoveryError(error, "operation_writer", "read_back");
        }
        if (
          inspection.core_state === "after"
          && inspection.metadata_state === "after"
        ) {
          finishKnown(
            entry,
            createOperationResult(
              entry.context.group.group_id,
              operationId,
              "already_applied",
              "already_applied",
              taskGid,
            ),
            taskGid,
            "read_task",
            1,
          );
          continue;
        }
        if (
          inspection.core_state === "conflict"
          || inspection.metadata_state === "conflict"
          || currentStageIndex >= journalStages.indexOf("read_back")
        ) {
          markUnresolved(entry, "recovery_required", taskGid);
          continue;
        }
        let rawWriterResult: WriterResult;
        try {
          rawWriterResult = await this.writer.applyWithWriteAttemptCallback(
            writerInput,
            signal,
            onWriteAttempt,
          );
        } catch (error) {
          if (signal.aborted) {
            signal.throwIfAborted();
            throw error;
          }
          throw reportRecoveryError(
            error,
            lastWriteAction ?? "operation_writer",
            "external_write",
          );
        }
        const parsedWriterResult = asanaProposalOperationWriterResultSchema.safeParse(
          rawWriterResult,
        );
        if (
          parsedWriterResult.success
          && parsedWriterResult.data.outcome !== "conflict"
        ) {
          observedEffectByOperation.set(operationId, "confirmed");
        }
        let writerResult: WriterResult;
        try {
          writerResult = validateWriterResult(entry.context, rawWriterResult, taskGid);
        } catch (error: unknown) {
          throw reportRecoveryError(
            error,
            lastWriteAction ?? "operation_writer",
            "read_back",
          );
        }
        if (writerResult.outcome === "conflict") {
          if (writerResult.side_effect === "none" && currentStageIndex < journalStages.indexOf("read_back")) {
            completeNotApplied(entry, "writer_conflict", taskGid);
          } else {
            markUnresolved(entry, "recovery_required", taskGid);
          }
          continue;
        }
        finishKnown(
          entry,
          writerResultToApplicationResult(entry.context, writerResult),
          taskGid,
          lastWriteAction ?? "operation_writer",
          Math.max(1, writeAttemptCount),
        );
      }
      for (const pending of statePending) {
        pendingJournals.push({ state, pending });
      }
    }

    if (pendingJournals.length > 0) {
      const requiredTaskGids = sortedUniqueTaskGids(
        pendingJournals.map(({ pending }) => pending.task_gid),
      );
      let synchronization: PostWriteSynchronizationResult;
      try {
        synchronization = asanaPostWriteSynchronizationResultSchema.parse(
          await this.postApply(requiredTaskGids, signal),
        );
      } catch (error: unknown) {
        if (error instanceof DiagnosticFailureDispositionError) {
          throw error;
        }
        let receipt: DiagnosticFailureDispositionError | undefined;
        for (const { pending } of pendingJournals) {
          receipt = this.reportOperationEvent(
            error,
            pending.entry,
            {
              severity: "error",
              api_action: "post_apply",
              journal_stage: pending.entry.journal.stage,
              effect_certainty: "confirmed",
              reason_code: "local_resync_required",
              recovery_decision: "local_sync_pending",
              attempt: 1,
              phase: "post_apply",
            },
            pending.task_gid,
          );
        }
        if (receipt == null) {
          throw new Error("復旧後同期の診断receiptがありません。");
        }
        throw receipt;
      }
      if (synchronization.kind === "recovery_required") {
        for (const { state, pending } of pendingJournals) {
          this.reportOperationEvent(
            new Error("外部状態は確定しましたが、ローカル同期の再開が必要です。"),
            pending.entry,
            {
              severity: "warning",
              api_action: "post_apply",
              journal_stage: pending.entry.journal.stage,
              effect_certainty: "confirmed",
              reason_code: "local_resync_required",
              recovery_decision: "local_sync_pending",
              attempt: 1,
              phase: "post_apply",
            },
            pending.task_gid,
          );
          state.selected.add(pending.entry.context.operation.operation_id);
          state.operationResults.set(
            pending.entry.context.operation.operation_id,
            unknownOperationResult(
              pending.entry.context,
              "local_resync_required",
              pending.task_gid,
            ),
          );
        }
      } else {
        for (const { pending } of pendingJournals) {
          let journalStage: ApplicationJournalStage = pending.entry.journal.stage;
          try {
            advanceJournal(
              this.journal,
              pending.entry.journal,
              "ranking_recalculated",
              (stage) => {
                journalStage = stage;
              },
            );
            this.journal.complete(
              pending.entry.journal.proposal_id,
              pending.entry.journal.operation_id,
              finalJournalResult("applied"),
            );
          } catch (error: unknown) {
            const receipt = this.reportOperationEventOnce(
              error,
              pending.entry,
              {
                severity: "error",
                api_action: "post_apply",
                journal_stage: journalStage,
                effect_certainty: "confirmed",
                reason_code: "recovery_required",
                recovery_decision: "unresolved",
                attempt: 1,
                phase: "journal",
              },
              pending.task_gid,
            );
            throw receipt;
          }
        }
      }
    }
    const applications: AsanaProposalApplicationResult[] = [];
    for (const state of applicationStates) {
      if (state.selected.size === 0) {
        continue;
      }
      if (state.application == null) {
        applications.push(
          createRecoveryApplicationResult(
            state.entries[0]?.journal.proposal_id ?? "",
            state.entries,
            state.selected,
            state.operationResults,
          ),
        );
      } else {
        applications.push(
          createApplicationResult(
            state.application.proposal_id,
            state.application.proposal,
            state.selected,
            state.operationResults,
          ),
        );
      }
    }
    return asanaProposalRecoveryResultSchema.parse({
      applications,
      unresolved_journals: unresolved,
    });
  }

  private reportJournalEvent(
    error: unknown,
    fields: JournalDiagnosticFields,
  ): DiagnosticFailureDispositionError {
    try {
      const event = applicationJournalDiagnosticSchema.parse({
        kind: "application_journal",
        ...fields,
      });
      this.diagnostic(error, event);
      return new DiagnosticFailureDispositionError({
        kind: "recorded_only",
        recorded_error: error,
        response_error: error instanceof DiagnosticFailureDispositionError
          ? error.disposition.response_error
          : error,
      });
    } catch (diagnosticError: unknown) {
      if (diagnosticError instanceof DiagnosticFailureDispositionError) {
        throw diagnosticError;
      }
      throw new DiagnosticFailureDispositionError(
        combineDiagnosticFailureDispositions(
          diagnosticFailureDispositionFromError(error),
          [diagnosticFailureDispositionFromError(diagnosticError)],
        ),
      );
    }
  }

  private reportOperationEvent(
    error: unknown,
    entry: OperationDiagnosticContext,
    fields: OperationDiagnosticFields,
    taskGid: string | undefined,
  ): DiagnosticFailureDispositionError {
    return this.reportJournalEvent(error, {
      ...fields,
      proposal_id: entry.journal.proposal_id,
      operation_id: entry.journal.operation_id,
      operation_kind: entry.context.operation.operation,
      ...(taskGid == null ? {} : { task_gid: taskGid }),
    });
  }

  private reportOperationEventOnce(
    error: unknown,
    entry: OperationDiagnosticContext,
    fields: OperationDiagnosticFields,
    taskGid: string | undefined,
  ): DiagnosticFailureDispositionError {
    if (error instanceof DiagnosticFailureDispositionError) {
      return error;
    }
    return this.reportOperationEvent(error, entry, fields, taskGid);
  }

  private reportEscapedError(
    error: unknown,
    fields: JournalDiagnosticFields,
  ): DiagnosticFailureDispositionError {
    if (error instanceof DiagnosticFailureDispositionError) {
      return error;
    }
    return this.reportJournalEvent(error, fields);
  }

  private escapeFailure(
    error: unknown,
    fields: JournalDiagnosticFields,
  ): DiagnosticFailureDispositionError {
    if (error instanceof DiagnosticFailureDispositionError) {
      return error;
    }
    return this.reportJournalEvent(error, fields);
  }
}

export type ProposalApplicationUuidGenerator = () => string;
export type ProposalApplicationTimestampProvider = () => string;

/** 適用後の同期と順位再計算を実行します。 */
export type ProposalApplicationPostApply = (
  requiredTaskGids: readonly string[],
  signal: AbortSignal,
) => Promise<PostWriteSynchronizationResult>;
