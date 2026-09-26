import { z } from "zod";
import {
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  CustomExternalDataCapacityError,
  customExternalDataSchema,
  dependencySchema,
  parseCustomExternalData,
  serializeCustomExternalData,
  type AsanaTaskResponse,
  type CustomExternalData,
  type Dependency,
} from "../../../shared/domain";
import {
  createInitialCustomExternalData,
  ingestAsanaExternalData,
} from "../../domain";
import {
  proposalOperationSchema,
} from "../../../shared/ai";
import { AsanaReadClient } from "../../asana/client/client";
import { AsanaTaskWriteClient } from "../../asana/client/task-write-client";
import {
  createReadBackDelaysMilliseconds,
  waitForCreateReadBack,
} from "../../asana/create-read-back";
import { AsanaHttpError } from "../../asana/transport";
import {
  classifyCategoryTags,
} from "../../application/proposal-apply/category-tag-write";
import {
  classifyStatusOperation,
} from "../../application/proposal-apply/status-write";
import { applyNonCreateOperation } from "../../application/proposal-apply/non-create-write";
import {
  classifyExternalMetadata,
  mergeExternalPlan,
  externalOperationsForOperation,
  type ExternalMetadataDependencies,
} from "../../application/proposal-apply/external-metadata";
import {
  findObsidianLink,
  obsidianKey,
  optionalDuration,
  sameDependencies,
  sameDueProposalValue,
  sameDurationValue,
  sameObsidianLink,
} from "../../application/proposal-apply/external-value-comparison";
import {
  classifyCreateCore,
  readCreatedTaskWithProjectionRetry as retryCreateReadBack,
  type CreateReadBackDependencies,
} from "../../application/proposal-apply/create-read-back";
import { applyCreateTask } from "../../application/proposal-apply/create-task-write";
import {
  applyNativeOperation,
  requireWorkspaceTags,
} from "../../application/proposal-apply/native-operation-write";
import {
  asanaProposalOperationWriterInputSchema,
  asanaProposalOperationWriterResultSchema,
  type AsanaProposalOperationWriterInput,
  type AsanaProposalOperationWriterResult,
  type AsanaProposalWriterSectionGids,
  type AsanaProposalWriterTemporaryRefMapping,
} from "./schemas";

const unclassifiedArea = "未分類";
const importanceTagPrefix = "TaskHub/重要度/";
const areaTagPrefix = "TaskHub/領域/";

type WriterOperation = z.infer<typeof proposalOperationSchema>;
type CreateOperation = Extract<WriterOperation, { operation: "create_task" }>;
type NonCreateOperation = Exclude<WriterOperation, CreateOperation>;
type OperationTarget = NonCreateOperation["target"];
type WriterInput = AsanaProposalOperationWriterInput;
type WriterResult = AsanaProposalOperationWriterResult;
type WriterConflictReasonCode = Extract<WriterResult, { outcome: "conflict" }>["reason_code"];
type CreateReadBackObservation =
  | { readonly kind: "ready"; readonly task: AsanaTaskResponse }
  | { readonly kind: "pending"; readonly reason: "projection" }
  | {
      readonly kind: "pending";
      readonly reason: "not_found";
      readonly not_found_error: AsanaHttpError;
    }
  | {
      readonly kind: "conflict";
      readonly reason_code: Extract<
        WriterConflictReasonCode,
        "read_back_mismatch" | "external_unreadable" | "external_identity_mismatch"
      >;
    };
type SectionGids = AsanaProposalWriterSectionGids;
type TemporaryRefMapping = AsanaProposalWriterTemporaryRefMapping;
type AsanaTag = z.infer<typeof asanaTagResponseSchema>;
type ExternalResponse = NonNullable<AsanaTaskResponse["external"]>;
type BaselineExternalInput = NonNullable<WriterInput["baseline_external_data"]>;
type ParentValue = string | null;
type DueValue =
  | { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type CurrentExternal = {
  readonly response: ExternalResponse;
  readonly data: CustomExternalData;
};
type ExternalReadResult =
  | { readonly kind: "valid"; readonly value: CurrentExternal }
  | {
      readonly kind: "conflict";
      readonly reason_code: "external_unreadable" | "external_identity_mismatch";
    };
type FieldClassification = "before" | "partial" | "after" | "conflict";
/** 作成済みタスクが読み戻せないことを表します。 */
export class CreateTaskNotFoundError extends Error {
  public readonly taskGid: string;

  public constructor(taskGid: string, cause: AsanaHttpError) {
    super("作成済みタスクを読み戻せません。", { cause });
    this.name = "CreateTaskNotFoundError";
    this.taskGid = taskGid;
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

function createResult(
  operationId: string,
  taskGid: string,
  outcome: "applied" | "already_applied",
  reasonCode: "applied" | "already_applied",
): WriterResult {
  return asanaProposalOperationWriterResultSchema.parse({
    operation_id: operationId,
    task_gid: taskGid,
    outcome,
    reason_code: reasonCode,
  });
}

function createConflictResult(
  operationId: string,
  taskGid: string,
  reasonCode: WriterConflictReasonCode,
  sideEffect: "none" | "possible",
): WriterResult {
  return asanaProposalOperationWriterResultSchema.parse({
    operation_id: operationId,
    task_gid: taskGid,
    outcome: "conflict",
    reason_code: reasonCode,
    side_effect: sideEffect,
  });
}

function parseTask(task: unknown, expectedGid: string | undefined): AsanaTaskResponse {
  const parsedTask = asanaTaskResponseSchema.parse(task);
  if (expectedGid != null && parsedTask.gid !== expectedGid) {
    throw new Error("AsanaタスクのGIDが対象と一致しません。");
  }
  return parsedTask;
}

function createMappingMap(
  mappings: readonly TemporaryRefMapping[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const mapping of mappings) {
    if (result.has(mapping.temporary_ref)) {
      throw new Error("temporary_ref対応が重複しています。");
    }
    result.set(mapping.temporary_ref, mapping.task_gid);
  }
  return result;
}

function resolveTargetGid(
  target: OperationTarget,
  mappings: ReadonlyMap<string, string>,
): string {
  if (target.kind === "existing") {
    return target.gid;
  }
  const gid = mappings.get(target.ref);
  if (gid == null) {
    throw new Error("temporary_refをタスクGIDへ解決できません。");
  }
  return gid;
}

function resolveParentGid(
  value: Extract<WriterOperation, { operation: "set_parent" }>["before"],
  mappings: ReadonlyMap<string, string>,
): ParentValue {
  if (value.kind === "absent") {
    return null;
  }
  return resolveTargetGid(value, mappings);
}

function resolveDependencies(
  dependencies: readonly Extract<WriterOperation, { operation: "set_dependencies" }>["before"][number][],
  mappings: ReadonlyMap<string, string>,
): readonly Dependency[] {
  return dependencies.map((dependency) => dependencySchema.parse({
    task_gid: resolveTargetGid(dependency.target, mappings),
    scope: dependency.scope,
    source: dependency.source,
  }));
}

function taskDueValue(task: AsanaTaskResponse): DueValue {
  if (task.due_on != null && task.due_at != null) {
    throw new Error("対象タスクの期限形式が不正です。");
  }
  if (task.due_on != null) {
    return { kind: "due_on", due_on: task.due_on };
  }
  if (task.due_at != null) {
    return { kind: "due_at", due_at: task.due_at };
  }
  return { kind: "absent" };
}

function sameDueValue(left: DueValue, right: DueValue): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function taskParentGid(task: AsanaTaskResponse): ParentValue {
  return task.parent == null ? null : task.parent.gid;
}

function taskHasProject(task: AsanaTaskResponse, projectGid: string): boolean {
  return task.projects.some((project) => project.gid === projectGid)
    || task.memberships.some((membership) => membership.project.gid === projectGid);
}

function workspaceTagsFromResponse(
  tags: readonly z.infer<typeof asanaTagResponseSchema>[],
): readonly AsanaTag[] {
  const result: AsanaTag[] = [];
  const seenGids = new Set<string>();
  for (const tag of tags) {
    const parsed = asanaTagResponseSchema.parse(tag);
    if (seenGids.has(parsed.gid)) {
      throw new Error("ワークスペースタグGIDが重複しています。");
    }
    seenGids.add(parsed.gid);
    result.push(parsed);
  }
  return result;
}

function importanceTagName(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("重要度が不正です。");
  }
  return `${importanceTagPrefix}${value}`;
}

function areaTagName(value: string): string {
  return `${areaTagPrefix}${value}`;
}

function parseBaselineExternal(
  external: BaselineExternalInput,
): { readonly response: ExternalResponse; readonly data: CustomExternalData } {
  const parsed = parseCustomExternalData(external.data);
  if (parsed.kind !== "valid") {
    throw new Error("baselineのCustom external dataがvalidではありません。");
  }
  customExternalDataSchema.parse(parsed.data);
  return {
    response: { gid: external.gid, data: external.data },
    data: parsed.data,
  };
}

function readCurrentExternal(task: AsanaTaskResponse): ExternalReadResult {
  if (task.external == null) {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  const ingestion = ingestAsanaExternalData(task);
  if (ingestion.kind === "identity_mismatch") {
    return { kind: "conflict", reason_code: "external_identity_mismatch" };
  }
  if (ingestion.kind !== "valid") {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  if (serializeCustomExternalData(ingestion.data) !== task.external.data) {
    return { kind: "conflict", reason_code: "external_unreadable" };
  }
  return {
    kind: "valid",
    value: { response: task.external, data: ingestion.data },
  };
}

function sameExternalData(left: CustomExternalData, right: CustomExternalData): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

type ExpectedExternal = {
  readonly gid: string;
  readonly data: CustomExternalData;
};

export type ProposalOperationCreatedTaskCallback = (
  operationId: string,
  taskGid: string,
) => void;
export type ProposalOperationWriteAttemptCallback = (
  action: ProposalOperationWriteAction,
) => void;
export type ProposalOperationWriteAction =
  | "create_task"
  | "update_task"
  | "add_task_to_project"
  | "add_task_to_section"
  | "add_task_tag"
  | "remove_task_tag"
  | "set_task_parent"
  | "clear_task_parent";
export type ProposalOperationRecoveryState = FieldClassification;
export type ProposalOperationRecoveryInspection = {
  readonly core_state: ProposalOperationRecoveryState;
  readonly metadata_state: ProposalOperationRecoveryState;
  readonly task: AsanaTaskResponse;
};
type CoreWriteResult =
  | { readonly kind: "completed"; readonly changed: boolean }
  | {
      readonly kind: "conflict";
      readonly side_effect: "none" | "possible";
      readonly reason_code?: WriterConflictReasonCode;
    };
type OperationWriteGuard = (
  task: AsanaTaskResponse,
) => WriterConflictReasonCode | undefined;

function classifyValue<T>(
  current: T,
  before: T,
  after: T,
  equal: (left: T, right: T) => boolean,
): FieldClassification {
  if (equal(current, before)) {
    return "before";
  }
  if (equal(current, after)) {
    return "after";
  }
  return "conflict";
}

function sameParentValue(left: ParentValue, right: ParentValue): boolean {
  return left === right;
}

function externalMetadataDependencies(): ExternalMetadataDependencies {
  return {
    canonicalizeJson,
    sameDueProposalValue: (left, right) => sameDueProposalValue(left, right, canonicalizeJson),
    optionalDuration,
    sameDurationValue: (left, right) => sameDurationValue(left, right, canonicalizeJson),
    resolveDependencies,
    sameDependencies: (left, right) => sameDependencies(left, right, canonicalizeJson),
    resolveParentGid,
    sameParentValue,
    findObsidianLink,
    sameObsidianLink: (left, right) => sameObsidianLink(left, right, canonicalizeJson),
    obsidianKey,
    classifyValue,
  };
}

function operationUsesExternalData(operation: NonCreateOperation): boolean {
  switch (operation.operation) {
    case "complete":
    case "withdraw":
      return false;
    default:
      return true;
  }
}

function operationTarget(operation: NonCreateOperation): OperationTarget {
  return operation.target;
}

function classifyOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGids: SectionGids,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[] | undefined,
): FieldClassification {
  switch (operation.operation) {
    case "update_title":
      return classifyValue(task.name, operation.before, operation.after, (left, right) => left === right);
    case "update_notes":
      return classifyValue(task.notes, operation.before, operation.after, (left, right) => left === right);
    case "set_status":
    case "complete":
    case "withdraw": {
      return classifyStatusOperation(operation, task, projectGid, sectionGids);
    }
    case "set_importance": {
      const workspaceTags = requireWorkspaceTags(tags);
      return classifyCategoryTags(
        task,
        importanceTagPrefix,
        importanceTagName(operation.before),
        importanceTagName(operation.after),
        3,
        operation.before,
        operation.after,
        workspaceTags,
      );
    }
    case "set_due": {
      const current = taskDueValue(task);
      return classifyValue(
        current, operation.before, operation.after,
        (left, right) => sameDueProposalValue(left, right, canonicalizeJson),
      );
    }
    case "clear_due": {
      const current = taskDueValue(task);
      return classifyValue(
        current,
        operation.before,
        { kind: "absent" },
        (left, right) => sameDueProposalValue(left, right, canonicalizeJson),
      );
    }
    case "set_area": {
      const workspaceTags = requireWorkspaceTags(tags);
      return classifyCategoryTags(
        task,
        areaTagPrefix,
        areaTagName(operation.before),
        areaTagName(operation.after),
        unclassifiedArea,
        operation.before,
        operation.after,
        workspaceTags,
      );
    }
    case "set_parent": {
      const current = taskParentGid(task);
      const before = resolveParentGid(operation.before, mappings);
      const after = resolveParentGid(operation.after, mappings);
      return classifyValue(current, before, after, sameParentValue);
    }
    case "set_duration":
    case "clear_duration":
    case "set_dependencies":
    case "set_parent_work_mode":
    case "link_obsidian":
    case "unlink_obsidian":
      return "after";
  }
  throw new Error("未対応のAsana操作です。");
}

function validateCurrentExternal(
  result: ExternalReadResult,
  baseline: { readonly response: ExternalResponse; readonly data: CustomExternalData },
): ExternalReadResult {
  if (result.kind === "conflict") {
    return result;
  }
  if (result.value.response.gid !== baseline.response.gid) {
    return { kind: "conflict", reason_code: "external_identity_mismatch" };
  }
  return result;
}

function createExternalState(
  input: WriterInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
): ExpectedExternal {
  const externalId = input.create_external_id;
  if (externalId == null) {
    throw new Error("create_taskには事前発行UUIDが必要です。");
  }
  const status = operation.after.status ?? "not_started";
  const initialized = createInitialCustomExternalData({
    id: externalId,
    activity_anchor_on: input.activity_date,
    last_active_status: status,
    device_id: input.device_id,
    created_via: input.created_via,
  });
  const parsed = parseCustomExternalData(initialized.data);
  if (parsed.kind !== "valid") {
    throw new Error("Custom external dataの初期化結果が不正です。");
  }
  const data = customExternalDataSchema.parse({
    ...parsed.data,
    parent_work_mode: operation.after.parent_work_mode ?? "unknown",
    dependencies: operation.after.dependencies == null
      ? []
      : resolveDependencies(operation.after.dependencies, mappings),
    obsidian_links: operation.after.obsidian_links ?? [],
    ...(operation.after.duration == null ? {} : { duration: operation.after.duration }),
  });
  return {
    gid: initialized.gid,
    data,
  };
}

function taskExternalMatches(
  task: AsanaTaskResponse,
  expected: ExpectedExternal,
): boolean {
  const current = readCurrentExternal(task);
  return current.kind === "valid"
    && current.value.response.gid === expected.gid
    && sameExternalData(current.value.data, expected.data);
}

function expectedExternalWriteGuard(expected: ExpectedExternal): OperationWriteGuard {
  return (task) => {
    const current = readCurrentExternal(task);
    if (current.kind === "conflict") {
      return current.reason_code;
    }
    if (current.value.response.gid !== expected.gid) {
      return "external_identity_mismatch";
    }
    return sameExternalData(current.value.data, expected.data)
      ? undefined
      : "merge_conflict";
  };
}

function createReadBackDependencies(): CreateReadBackDependencies<
  AsanaTaskResponse,
  AsanaTag,
  CustomExternalData
> {
  return {
    importanceTagPrefix,
    areaTagPrefix,
    unclassifiedArea,
    importanceTagName,
    areaTagName,
    taskDueValue,
    sameDueValue,
    resolveTargetGid,
    taskParentGid,
    readCurrentExternal,
    sameExternalData,
  };
}

async function readCreatedTaskWithProjectionRetry(
  readClient: AsanaReadClient,
  taskGid: string,
  input: WriterInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[],
  expectedExternal: ExpectedExternal,
  signal: AbortSignal,
): Promise<CreateReadBackObservation> {
  return retryCreateReadBack(
    input,
    operation,
    mappings,
    tags,
    expectedExternal,
    async () => {
      try {
        return {
          kind: "task",
          task: parseTask(await readClient.getTask(taskGid, signal), taskGid),
        };
      } catch (error: unknown) {
        if (!(error instanceof AsanaHttpError) || error.status !== 404) {
          throw error;
        }
        return { kind: "not_found", error };
      }
    },
    createReadBackDelaysMilliseconds,
    (milliseconds) => waitForCreateReadBack(milliseconds, signal),
    createReadBackDependencies(),
  );
}

async function fetchWorkspaceTags(
  readClient: AsanaReadClient,
  workspaceGid: string,
  signal: AbortSignal,
): Promise<readonly AsanaTag[]> {
  const tags = await readClient.listWorkspaceTags(workspaceGid, signal);
  return workspaceTagsFromResponse(tags);
}

async function applyNonCreateAsanaOperation(
  operation: NonCreateOperation,
  task: AsanaTaskResponse,
  input: WriterInput,
  mappings: ReadonlyMap<string, string>,
  tags: readonly AsanaTag[] | undefined,
  readClient: AsanaReadClient,
  writeClient: AsanaTaskWriteClient,
  beforeWrite: OperationWriteGuard,
  onWriteAttempt: ProposalOperationWriteAttemptCallback,
  signal: AbortSignal,
): Promise<CoreWriteResult> {
  return applyNativeOperation(operation, task, input, mappings, tags, beforeWrite, onWriteAttempt, signal, {
    readTask: async (taskGid, readSignal) => parseTask(await readClient.getTask(taskGid, readSignal), taskGid),
    updateTask: (taskGid, update, writeSignal) => writeClient.updateTask(taskGid, update, writeSignal),
    addTaskToSection: (taskGid, sectionGid, writeSignal) => writeClient.addTaskToSection(
      taskGid, sectionGid, { kind: "none" }, writeSignal,
    ),
    addTaskTag: (taskGid, tagGid, writeSignal) => writeClient.addTaskTag(taskGid, tagGid, writeSignal),
    removeTaskTag: (taskGid, tagGid, writeSignal) => writeClient.removeTaskTag(taskGid, tagGid, writeSignal),
    clearTaskParent: (taskGid, writeSignal) => writeClient.clearTaskParent(taskGid, writeSignal),
    setTaskParent: (taskGid, parentGid, writeSignal) => writeClient.setTaskParent(taskGid, parentGid, writeSignal),
    taskDueValue,
    sameDueValue,
    taskParentGid,
    resolveParentGid,
    importanceTagPrefix,
    areaTagPrefix,
    unclassifiedArea,
    importanceTagName,
    areaTagName,
  });
}

function externalConflictResult(
  operationId: string,
  taskGid: string,
  reasonCode: "external_unreadable" | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded",
  sideEffect: "none" | "possible",
): WriterResult {
  return createConflictResult(operationId, taskGid, reasonCode, sideEffect);
}

/** 承認済みAI変更操作をAsanaへ適用します。 */
export class AsanaProposalOperationWriter {
  private readonly readClient: AsanaReadClient;
  private readonly writeClient: AsanaTaskWriteClient;

  public constructor(
    readClient: AsanaReadClient,
    writeClient: AsanaTaskWriteClient,
  ) {
    this.readClient = readClient;
    this.writeClient = writeClient;
  }

  /** 承認済みの単一AI変更操作を適用します。 */
  public async apply(
    input: WriterInput,
    signal: AbortSignal,
  ): Promise<WriterResult> {
    return this.applyInternal(input, signal, () => {}, () => {});
  }

  /** 外部書込開始通知を指定して承認済みAI変更操作を適用します。 */
  public async applyWithWriteAttemptCallback(
    input: WriterInput,
    signal: AbortSignal,
    onWriteAttempt: ProposalOperationWriteAttemptCallback,
  ): Promise<WriterResult> {
    return this.applyInternal(input, signal, () => {}, onWriteAttempt);
  }

  /** 作成タスクのGIDを外部属性更新前に通知して操作を適用します。 */
  public async applyWithCreateTaskCallback(
    input: WriterInput,
    signal: AbortSignal,
    onCreateTaskCreated: ProposalOperationCreatedTaskCallback,
    onWriteAttempt: ProposalOperationWriteAttemptCallback,
  ): Promise<WriterResult> {
    if (typeof onCreateTaskCreated !== "function") {
      throw new TypeError("作成タスクGID通知コールバックが必要です。");
    }
    return this.applyInternal(input, signal, onCreateTaskCreated, onWriteAttempt);
  }

  /** 作成操作から承認済みの初期Custom external dataを再構成します。 */
  public createInitialExternalBaseline(input: WriterInput): BaselineExternalInput {
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    if (validatedInput.operation.operation !== "create_task") {
      throw new Error("create_task以外から初期Custom external dataを再構成できません。");
    }
    const expected = createExternalState(
      validatedInput,
      validatedInput.operation,
      createMappingMap(validatedInput.temporary_ref_to_gid),
    );
    return {
      gid: expected.gid,
      data: serializeCustomExternalData(expected.data),
    };
  }

  /** 保存済み復旧計画の外部状態を読み取り、操作前後を判定します。 */
  public async inspectRecovery(
    input: WriterInput,
    signal: AbortSignal,
  ): Promise<ProposalOperationRecoveryInspection> {
    validateAbortSignal(signal);
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    const mappings = createMappingMap(validatedInput.temporary_ref_to_gid);
    if (validatedInput.operation.operation === "create_task") {
      if (validatedInput.existing_task == null) {
        throw new Error("create_taskの復旧対象タスクがありません。");
      }
      const task = parseTask(validatedInput.existing_task, undefined);
      const expectedExternal = createExternalState(
        validatedInput,
        validatedInput.operation,
        mappings,
      );
      const tags = await fetchWorkspaceTags(
        this.readClient,
        validatedInput.workspace_gid,
        signal,
      );
      return {
        core_state: classifyCreateCore(
          task,
          validatedInput,
          validatedInput.operation,
          mappings,
          tags,
          createReadBackDependencies(),
        ),
        metadata_state: taskExternalMatches(task, expectedExternal)
          ? "after"
          : "conflict",
        task,
      };
    }
    const taskGid = resolveTargetGid(
      operationTarget(validatedInput.operation),
      mappings,
    );
    const task = parseTask(
      await this.readClient.getTask(taskGid, signal),
      taskGid,
    );
    if (!taskHasProject(task, validatedInput.project_gid)) {
      return { core_state: "conflict", metadata_state: "conflict", task };
    }
    const baselineExternal = validatedInput.baseline_external_data == null
      ? undefined
      : parseBaselineExternal(validatedInput.baseline_external_data);
    if (operationUsesExternalData(validatedInput.operation) && baselineExternal == null) {
      throw new Error("この操作にはbaseline外部データが必要です。");
    }
    let currentExternal: CurrentExternal | undefined;
    let metadataState: FieldClassification = "after";
    if (operationUsesExternalData(validatedInput.operation)) {
      if (baselineExternal == null) {
        throw new Error("この操作にはbaseline外部データが必要です。");
      }
      const currentExternalResult = validateCurrentExternal(
        readCurrentExternal(task),
        baselineExternal,
      );
      if (currentExternalResult.kind === "conflict") {
        metadataState = "conflict";
      } else {
        currentExternal = currentExternalResult.value;
        metadataState = classifyExternalMetadata(
          validatedInput.operation,
          baselineExternal.data,
          currentExternal.data,
          mappings,
          validatedInput.activity_date,
          externalMetadataDependencies(),
        );
      }
    }
    const requiresTags = validatedInput.operation.operation === "set_importance"
      || validatedInput.operation.operation === "set_area";
    const tags = requiresTags
      ? await fetchWorkspaceTags(this.readClient, validatedInput.workspace_gid, signal)
      : undefined;
    const classification = classifyOperation(
      validatedInput.operation,
      task,
      validatedInput.project_gid,
      validatedInput.section_gids,
      mappings,
      tags,
    );
    return {
      core_state: classification,
      metadata_state: metadataState,
      task,
    };
  }

  private async applyInternal(
    input: WriterInput,
    signal: AbortSignal,
    onCreateTaskCreated: ProposalOperationCreatedTaskCallback,
    onWriteAttempt: ProposalOperationWriteAttemptCallback,
  ): Promise<WriterResult> {
    validateAbortSignal(signal);
    const validatedInput = asanaProposalOperationWriterInputSchema.parse(input);
    const mappings = createMappingMap(validatedInput.temporary_ref_to_gid);
    if (validatedInput.operation.operation === "create_task") {
      return this.applyCreate(
        validatedInput,
        mappings,
        signal,
        onCreateTaskCreated,
        onWriteAttempt,
      );
    }
    return this.applyNonCreate(validatedInput, mappings, signal, onWriteAttempt);
  }

  private async applyCreate(
    input: WriterInput,
    mappings: ReadonlyMap<string, string>,
    signal: AbortSignal,
    onCreateTaskCreated: ProposalOperationCreatedTaskCallback,
    onWriteAttempt: ProposalOperationWriteAttemptCallback,
  ): Promise<WriterResult> {
    if (input.operation.operation !== "create_task") {
      throw new Error("create_task以外の操作を作成処理へ渡せません。");
    }
    return applyCreateTask(input, input.operation, mappings, signal, onCreateTaskCreated, onWriteAttempt, {
      readBackDependencies: createReadBackDependencies(),
      createExternalState,
      fetchWorkspaceTags: (workspaceGid, readSignal) => fetchWorkspaceTags(
        this.readClient, workspaceGid, readSignal,
      ),
      parseExistingTask: (task) => parseTask(task, undefined),
      readCreatedTaskWithProjectionRetry: (taskGid, currentInput, operation, currentMappings, tags, expectedExternal, readSignal) =>
        readCreatedTaskWithProjectionRetry(
          this.readClient, taskGid, currentInput, operation, currentMappings, tags,
          expectedExternal, readSignal,
        ),
      createTaskNotFoundError: (taskGid, cause) => new CreateTaskNotFoundError(taskGid, cause),
      createConflictResult,
      externalConflictResult,
      createResult,
      expectedExternalWriteGuard,
      readTask: async (taskGid, readSignal) => parseTask(
        await this.readClient.getTask(taskGid, readSignal), taskGid,
      ),
      taskExternalMatches,
      readCurrentExternal,
      serializeExternal: serializeCustomExternalData,
      createTask: (creationInput, writeSignal) => this.writeClient.createTask(creationInput, writeSignal),
      addTaskTag: (taskGid, tagGid, writeSignal) => this.writeClient.addTaskTag(taskGid, tagGid, writeSignal),
      removeTaskTag: (taskGid, tagGid, writeSignal) => this.writeClient.removeTaskTag(taskGid, tagGid, writeSignal),
      addTaskToSection: (taskGid, sectionGid, writeSignal) => this.writeClient.addTaskToSection(
        taskGid, sectionGid, { kind: "none" }, writeSignal,
      ),
      updateCompleted: (taskGid, completed, writeSignal) => this.writeClient.updateTask(
        taskGid, { kind: "completed", value: completed }, writeSignal,
      ),
      resolveTargetGid,
      taskParentGid,
      setTaskParent: (taskGid, parentGid, writeSignal) => this.writeClient.setTaskParent(
        taskGid, parentGid, writeSignal,
      ),
    });
  }

  private async applyNonCreate(
    input: WriterInput,
    mappings: ReadonlyMap<string, string>,
    signal: AbortSignal,
    onWriteAttempt: ProposalOperationWriteAttemptCallback,
  ): Promise<WriterResult> {
    if (input.operation.operation === "create_task") {
      throw new Error("create_taskを非作成処理へ渡せません。");
    }
    return applyNonCreateOperation(input, input.operation, mappings, signal, onWriteAttempt, {
      readTask: async (taskGid, readSignal) => parseTask(
        await this.readClient.getTask(taskGid, readSignal),
        taskGid,
      ),
      fetchWorkspaceTags: (workspaceGid, readSignal) => fetchWorkspaceTags(
        this.readClient,
        workspaceGid,
        readSignal,
      ),
      targetGid: (operation, currentMappings) => resolveTargetGid(
        operationTarget(operation),
        currentMappings,
      ),
      taskHasProject,
      createConflictResult,
      externalConflictResult,
      createResult,
      parseBaselineExternal,
      operationUsesExternalData,
      classifyOperation: (operation, task, currentInput, currentMappings, tags) =>
        classifyOperation(
          operation,
          task,
          currentInput.project_gid,
          currentInput.section_gids,
          currentMappings,
          tags,
        ),
      externalOperationsForOperation: (operation, baseline, currentMappings, activityDate) =>
        externalOperationsForOperation(
          operation,
          baseline,
          currentMappings,
          activityDate,
          externalMetadataDependencies(),
        ),
      readCurrentExternal,
      validateCurrentExternal,
      classifyExternalMetadata: (operation, baseline, current, currentMappings, activityDate) =>
        classifyExternalMetadata(
          operation,
          baseline,
          current,
          currentMappings,
          activityDate,
          externalMetadataDependencies(),
        ),
      applyAsanaOperation: (
        operation, task, currentInput, currentMappings, tags, beforeWrite, callback, writeSignal,
      ) => applyNonCreateAsanaOperation(
        operation,
        task,
        currentInput,
        currentMappings,
        tags,
        this.readClient,
        this.writeClient,
        beforeWrite,
        callback,
        writeSignal,
      ),
      mergeExternalPlan: (baseline, current, operations, lastWriter) => mergeExternalPlan(
        baseline,
        current,
        operations,
        lastWriter,
        serializeCustomExternalData,
        (error) => error instanceof CustomExternalDataCapacityError,
      ),
      writeExternalData: (taskGid, gid, data, writeSignal) => this.writeClient.updateTask(
        taskGid,
        { kind: "external", value: { gid, data } },
        writeSignal,
      ),
    });
  }
}
