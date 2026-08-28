import {
  CustomExternalDataCapacityError,
  serializeCustomExternalData,
  asanaTaskResponseSchema,
  identifierSchema,
  type AsanaTaskResponse,
  type CustomExternalData,
  type Dependency,
  type TaskStatus,
} from "../../shared/domain";
import {
  ingestAsanaExternalData,
  mergeCustomExternalData,
} from "../domain";
import {
  proposalOperationSchema,
  type ProposalOperation,
} from "../../shared/ai";
import {
  AsanaProposalOperationWriter,
  asanaProposalOperationWriterResultSchema,
  asanaPostWriteSynchronizationResultSchema,
  type AsanaProposalOperationWriterInput,
  type AsanaProposalOperationWriterResult,
  type PostWriteSynchronizationResult,
} from "../ai/proposal-application";
import { AsanaReadClient } from "../asana/client/client";
import {
  AsanaTaskWriteClient,
  type AsanaTaskInsertionPosition,
  type AsanaTaskUpdate,
} from "../asana/client/task-write-client";
import { AsanaRequestAbortedError } from "../asana/scheduler";
import {
  AsanaAuthenticationError,
  AsanaEventsResetError,
  AsanaHttpError,
  AsanaPaymentRequiredError,
  AsanaRateLimitError,
  AsanaResponseError,
  AsanaTransportError,
} from "../asana/transport";
import {
  AsanaOAuthHttpError,
  AsanaOAuthResponseError,
  AsanaOAuthTransportError,
} from "../auth/asana-oauth";
import {
  asanaGuiEditInputSchema,
  asanaGuiEditResultSchema,
  asanaGuiEditRelationGraphValidationResultSchema,
  type AsanaGuiEditInput,
  type AsanaGuiEditOperation,
  type AsanaGuiEditParentValue,
  type AsanaGuiEditResult,
  type AsanaGuiEditSectionGids,
  type AsanaGuiEditRelationGraphValidationResult,
} from "./schemas";

type WriterResult = AsanaProposalOperationWriterResult;
type BaselineExternal = NonNullable<
  AsanaProposalOperationWriterInput["baseline_external_data"]
>;
type ParsedBaselineExternal = {
  readonly response: BaselineExternal;
  readonly data: CustomExternalData;
};
type ExternalBaselineResult =
  | { readonly kind: "valid"; readonly value: ParsedBaselineExternal }
  | {
      readonly kind: "conflict";
      readonly reason_code: "external_unreadable" | "external_identity_mismatch";
    };
type ExternalOperation = Exclude<
  AsanaGuiEditOperation,
  | { readonly kind: "complete" }
  | { readonly kind: "withdraw" }
>;
type ProposalGuiOperation = Exclude<
  AsanaGuiEditOperation,
  { readonly kind: "mark_activity" }
>;
type ProposalDependency = Extract<
  ProposalOperation,
  { operation: "set_dependencies" }
>["before"][number];
type ProposalParent = Extract<
  ProposalOperation,
  { operation: "set_parent" }
>["before"];
type ProposalDue = Extract<
  ProposalOperation,
  { operation: "set_due" }
>["before"];
type AsanaGuiEditReadClient = Pick<AsanaReadClient, "getTask">;
type AsanaGuiEditStatusWriteClient = Pick<
  AsanaTaskWriteClient,
  "addTaskToProject" | "addTaskToSection" | "updateTask"
>;
type GuiPostWriteDisposition =
  | { readonly kind: "preserve" }
  | {
      readonly kind: "recovery_required";
      readonly write_outcome: Extract<
        AsanaGuiEditResult,
        { readonly outcome: "recovery_required" }
      >["write_outcome"];
    };
export type AsanaGuiEditRelationGraphValidationRequest =
  | {
      readonly kind: "dependencies";
      readonly task_gid: string;
      readonly dependencies: readonly Dependency[];
    }
  | {
      readonly kind: "parent";
      readonly task_gid: string;
      readonly parent_gid: string | null;
    };

const operationSnapshotHash = "0000000000000000000000000000000000000000000000000000000000000000";
const operationReason = "GUIによる直接編集";
const operationEvidenceLocator = "gui-edit";
const importanceTagPrefix = "TaskHub/重要度/";
const areaTagPrefix = "TaskHub/領域/";
const unclassifiedArea = "未分類";

/** オンライン接続状態を提供する関数です。 */
export type AsanaGuiEditOnlineStateProvider = () => boolean;

/** GUI編集の関係グラフ検証を提供する関数です。 */
export type AsanaGuiEditRelationGraphValidator = (
  request: AsanaGuiEditRelationGraphValidationRequest,
  signal: AbortSignal,
) => Promise<AsanaGuiEditRelationGraphValidationResult>;

/** GUI編集の操作IDを発行する関数です。 */
export type AsanaGuiEditOperationIdProvider = () => string;

function isKnownAsanaOperationalError(error: unknown): boolean {
  return error instanceof AsanaTransportError
    || error instanceof AsanaResponseError
    || error instanceof AsanaAuthenticationError
    || error instanceof AsanaEventsResetError
    || error instanceof AsanaHttpError
    || error instanceof AsanaPaymentRequiredError
    || error instanceof AsanaRateLimitError
    || error instanceof AsanaRequestAbortedError
    || error instanceof AsanaOAuthTransportError
    || error instanceof AsanaOAuthResponseError
    || error instanceof AsanaOAuthHttpError;
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

function baselineExternal(
  task: AsanaTaskResponse,
): ExternalBaselineResult {
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
    value: {
      response: {
        gid: task.external.gid,
        data: task.external.data,
      },
      data: ingestion.data,
    },
  };
}

function statusFromTask(
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGids: AsanaGuiEditSectionGids,
): TaskStatus {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    throw new Error("対象タスクの専用プロジェクト所属を一意に確認できません。");
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    throw new Error("対象タスクの状態セクションを確認できません。");
  }
  const statuses: readonly [TaskStatus, string, boolean][] = [
    ["not_started", sectionGids.not_started, false],
    ["in_progress", sectionGids.in_progress, false],
    ["completed", sectionGids.completed, true],
    ["withdrawn", sectionGids.withdrawn, true],
  ];
  const matched = statuses.find(
    (status) => status[1] === membership.section?.gid,
  );
  if (matched == null) {
    throw new Error("対象タスクの状態セクションが不正です。");
  }
  if (matched[2] !== task.completed) {
    throw new Error("対象タスクの状態セクションと完了フラグが一致しません。");
  }
  return matched[0];
}

function importanceFromTask(task: AsanaTaskResponse): number {
  const tags = task.tags.filter((tag) => tag.name.startsWith(importanceTagPrefix));
  if (tags.length === 0) {
    return 3;
  }
  const values = tags.map((tag) => {
    const value = Number(tag.name.slice(importanceTagPrefix.length));
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error("重要度タグ名が不正です。");
    }
    return value;
  });
  return Math.max(...values);
}

function areaFromTask(task: AsanaTaskResponse): string {
  const tags = task.tags.filter((tag) => tag.name.startsWith(areaTagPrefix));
  if (tags.length !== 1) {
    return unclassifiedArea;
  }
  const tag = tags[0];
  if (tag == null) {
    throw new Error("領域タグを取得できません。");
  }
  const area = tag.name.slice(areaTagPrefix.length);
  if (area.trim().length === 0) {
    throw new Error("領域タグ名が不正です。");
  }
  return area;
}

function dueFromTask(
  task: AsanaTaskResponse,
): ProposalDue {
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

function proposalDependencies(
  dependencies: readonly Dependency[],
): ProposalDependency[] {
  return dependencies.map((dependency) => ({
    target: { kind: "existing", gid: dependency.task_gid },
    scope: dependency.scope,
    source: dependency.source,
  }));
}

function proposalParent(
  task: AsanaTaskResponse,
): ProposalParent {
  return task.parent == null
    ? { kind: "absent" }
    : { kind: "existing", gid: task.parent.gid };
}

function proposalOperationInput(
  input: AsanaGuiEditInput,
  operationId: string,
): Record<string, unknown> {
  return {
    operation_id: operationId,
    baseline_snapshot_hash: operationSnapshotHash,
    reason: operationReason,
    basis: "explicit",
    confidence: 1,
    evidence_refs: [{ kind: "user_message", locator: operationEvidenceLocator }],
    target: { kind: "existing", gid: input.task_gid },
  };
}

function parseProposalOperation(
  value: Record<string, unknown>,
): ProposalOperation {
  return proposalOperationSchema.parse(value);
}

function statusOperation(
  input: AsanaGuiEditInput,
  operationId: string,
  before: TaskStatus,
  after: TaskStatus,
): ProposalOperation {
  const common = proposalOperationInput(input, operationId);
  if (after === "completed") {
    if (before !== "not_started" && before !== "in_progress") {
      throw new Error("完了操作の対象状態が不正です。");
    }
    return parseProposalOperation({
      ...common,
      operation: "complete",
      before,
      after: "completed",
      basis: "explicit",
      status_evidence: {
        kind: "user_explicit",
        reference: { kind: "user_message", locator: operationEvidenceLocator },
      },
    });
  }
  if (after === "withdrawn") {
    if (before !== "not_started" && before !== "in_progress") {
      throw new Error("取り下げ操作の対象状態が不正です。");
    }
    return parseProposalOperation({
      ...common,
      operation: "withdraw",
      before,
      after: "withdrawn",
      basis: "explicit",
      status_evidence: {
        kind: "user_explicit",
        reference: { kind: "user_message", locator: operationEvidenceLocator },
      },
    });
  }
  return parseProposalOperation({
    ...common,
    operation: "set_status",
    before,
    after,
  });
}

function buildProposalOperation(
  input: AsanaGuiEditInput,
  operationId: string,
  external: ParsedBaselineExternal | undefined,
  operation: ProposalGuiOperation,
): ProposalOperation {
  const common = proposalOperationInput(input, operationId);
  const task = input.baseline_task;
  switch (operation.kind) {
    case "update_title":
      return parseProposalOperation({
        ...common,
        operation: "update_title",
        before: task.name,
        after: operation.value,
      });
    case "update_notes":
      return parseProposalOperation({
        ...common,
        operation: "update_notes",
        before: task.notes,
        after: operation.value,
      });
    case "set_status":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        operation.value,
      );
    case "complete":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        "completed",
      );
    case "withdraw":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        "withdrawn",
      );
    case "restore":
      return statusOperation(
        input,
        operationId,
        statusFromTask(task, input.project_gid, input.section_gids),
        operation.value,
      );
    case "set_importance":
      return parseProposalOperation({
        ...common,
        operation: "set_importance",
        before: importanceFromTask(task),
        after: operation.value,
      });
    case "set_due":
      return parseProposalOperation({
        ...common,
        operation: "set_due",
        before: dueFromTask(task),
        after: operation.value,
      });
    case "clear_due":
      return parseProposalOperation({
        ...common,
        operation: "clear_due",
        before: dueFromTask(task),
        after: { kind: "absent" },
      });
    case "set_area":
      return parseProposalOperation({
        ...common,
        operation: "set_area",
        before: areaFromTask(task),
        after: operation.value,
      });
    case "set_dependencies":
      if (external == null) {
        throw new Error("依存関係操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "set_dependencies",
        before: proposalDependencies(external.data.dependencies),
        after: proposalDependencies(operation.value),
      });
    case "set_parent":
      return parseProposalOperation({
        ...common,
        operation: "set_parent",
        before: proposalParent(task),
        after: operation.value,
      });
    case "set_parent_work_mode":
      if (external == null) {
        throw new Error("親作業モード操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "set_parent_work_mode",
        before: external.data.parent_work_mode,
        after: operation.value,
      });
    case "link_obsidian":
      if (external == null) {
        throw new Error("Obsidianリンク操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "link_obsidian",
        before: { kind: "absent" },
        after: operation.value,
      });
    case "unlink_obsidian":
      if (external == null) {
        throw new Error("Obsidianリンク操作にはCustom external dataが必要です。");
      }
      return parseProposalOperation({
        ...common,
        operation: "unlink_obsidian",
        before: operation.value,
        after: { kind: "absent" },
      });
  }
}

function operationUsesExternalData(
  operation: AsanaGuiEditOperation,
): operation is ExternalOperation {
  if (operation.kind === "complete" || operation.kind === "withdraw") {
    return false;
  }
  if (operation.kind === "set_status") {
    return operation.value !== "completed" && operation.value !== "withdrawn";
  }
  return true;
}

function nonRegressingActivityDate(
  activityDate: string,
  external: ParsedBaselineExternal | undefined,
): string {
  if (external == null || external.data.activity_anchor_on <= activityDate) {
    return activityDate;
  }
  return external.data.activity_anchor_on;
}

function resultFromWriter(
  input: AsanaGuiEditInput,
  operationId: string,
  result: WriterResult,
): AsanaGuiEditResult {
  if (result.operation_id !== operationId) {
    throw new Error("writerのoperation_idがGUI編集操作と一致しません。");
  }
  if (result.task_gid !== input.task_gid) {
    throw new Error("writerの対象GIDがGUI編集対象と一致しません。");
  }
  switch (result.outcome) {
    case "applied":
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: result.task_gid,
        outcome: "applied",
        reason_code: "applied",
      });
    case "already_applied":
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: result.task_gid,
        outcome: "already_applied",
        reason_code: "already_applied",
      });
    case "conflict":
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: result.task_gid,
        outcome: "conflict",
        reason_code: result.reason_code,
        side_effect: result.side_effect,
      });
  }
}

function postWriteDisposition(
  result: AsanaGuiEditResult,
): GuiPostWriteDisposition {
  switch (result.outcome) {
    case "applied":
      return { kind: "recovery_required", write_outcome: "applied" };
    case "already_applied":
      return { kind: "recovery_required", write_outcome: "already_applied" };
    case "conflict":
      return result.side_effect === "possible"
        ? { kind: "recovery_required", write_outcome: "unknown" }
        : { kind: "preserve" };
    case "rejected":
      return { kind: "preserve" };
    case "recovery_required":
      throw new Error("GUI編集の再同期要求結果を再処理できません。");
  }
}

type StatusMembershipSnapshot =
  | { readonly kind: "absent" }
  | { readonly kind: "present"; readonly section_gid: string | null };
type StatusSnapshot = {
  readonly completed: boolean;
  readonly membership: StatusMembershipSnapshot;
};
type StatusDefinition = {
  readonly section_gid: string;
  readonly completed: boolean;
};

function statusSnapshot(
  task: AsanaTaskResponse,
  projectGid: string,
): StatusSnapshot {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length > 1) {
    throw new Error("対象タスクの専用プロジェクト所属が重複しています。");
  }
  const membership = memberships[0];
  if (membership == null) {
    return { completed: task.completed, membership: { kind: "absent" } };
  }
  return {
    completed: task.completed,
    membership: {
      kind: "present",
      section_gid: membership.section == null ? null : membership.section.gid,
    },
  };
}

function sameStatusSnapshot(
  left: StatusSnapshot,
  right: StatusSnapshot,
): boolean {
  if (left.completed !== right.completed) {
    return false;
  }
  if (left.membership.kind !== right.membership.kind) {
    return false;
  }
  if (left.membership.kind === "present" && right.membership.kind === "present") {
    return left.membership.section_gid === right.membership.section_gid;
  }
  return true;
}

function statusDefinition(
  status: TaskStatus,
  sectionGids: AsanaGuiEditSectionGids,
): StatusDefinition {
  const definitions: readonly [TaskStatus, StatusDefinition][] = [
    ["not_started", { section_gid: sectionGids.not_started, completed: false }],
    ["in_progress", { section_gid: sectionGids.in_progress, completed: false }],
    ["completed", { section_gid: sectionGids.completed, completed: true }],
    ["withdrawn", { section_gid: sectionGids.withdrawn, completed: true }],
  ];
  const definition = definitions.find((entry) => entry[0] === status);
  if (definition == null) {
    throw new Error("指定状態の定義がありません。");
  }
  return definition[1];
}

function statusNeedsRepair(
  task: AsanaTaskResponse,
  projectGid: string,
  sectionGids: AsanaGuiEditSectionGids,
): boolean {
  const snapshot = statusSnapshot(task, projectGid);
  if (snapshot.membership.kind === "absent") {
    return true;
  }
  if (snapshot.membership.section_gid == null) {
    return true;
  }
  const knownSections = new Set(Object.values(sectionGids));
  if (!knownSections.has(snapshot.membership.section_gid)) {
    return true;
  }
  const expectedCompleted =
    snapshot.membership.section_gid === sectionGids.completed
    || snapshot.membership.section_gid === sectionGids.withdrawn;
  return snapshot.completed !== expectedCompleted;
}

function matchesStatus(
  task: AsanaTaskResponse,
  projectGid: string,
  definition: StatusDefinition,
): boolean {
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === projectGid,
  );
  if (memberships.length !== 1) {
    return false;
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    return false;
  }
  return (
    membership.section.gid === definition.section_gid
    && task.completed === definition.completed
  );
}

function relationRequest(
  input: AsanaGuiEditInput,
): AsanaGuiEditRelationGraphValidationRequest | undefined {
  switch (input.operation.kind) {
    case "set_dependencies":
      return {
        kind: "dependencies",
        task_gid: input.task_gid,
        dependencies: input.operation.value,
      };
    case "set_parent": {
      const parent: AsanaGuiEditParentValue = input.operation.value;
      return {
        kind: "parent",
        task_gid: input.task_gid,
        parent_gid: parent.kind === "absent" ? null : parent.gid,
      };
    }
    default:
      return undefined;
  }
}

function statusTargetForOperation(
  operation: AsanaGuiEditOperation,
): TaskStatus | undefined {
  switch (operation.kind) {
    case "set_status":
      return operation.value;
    case "complete":
      return "completed";
    case "withdraw":
      return "withdrawn";
    case "restore":
      return operation.value;
    default:
      return undefined;
  }
}

/** GUI直接編集後に差分同期と順位再計算を呼び出す関数です。 */
export type AsanaGuiEditPostApply = (
  signal: AbortSignal,
) => Promise<PostWriteSynchronizationResult>;

/** オンラインのGUI直接編集をAsanaへ反映します。 */
export class AsanaGuiEditService {
  private readonly writer: AsanaProposalOperationWriter;
  private readonly postApply: AsanaGuiEditPostApply;
  private readonly onlineStateProvider: AsanaGuiEditOnlineStateProvider;
  private readonly relationGraphValidator: AsanaGuiEditRelationGraphValidator;
  private readonly readClient: AsanaGuiEditReadClient;
  private readonly statusWriteClient: AsanaGuiEditStatusWriteClient;
  private readonly operationIdProvider: AsanaGuiEditOperationIdProvider;

  public constructor(
    writer: AsanaProposalOperationWriter,
    postApply: AsanaGuiEditPostApply,
    onlineStateProvider: AsanaGuiEditOnlineStateProvider,
    relationGraphValidator: AsanaGuiEditRelationGraphValidator,
    readClient: AsanaGuiEditReadClient,
    statusWriteClient: AsanaGuiEditStatusWriteClient,
    operationIdProvider: AsanaGuiEditOperationIdProvider,
  ) {
    if (typeof postApply !== "function") {
      throw new TypeError("GUI編集後の同期・順位再計算関数が必要です。");
    }
    if (typeof onlineStateProvider !== "function") {
      throw new TypeError("オンライン状態関数が必要です。");
    }
    if (typeof relationGraphValidator !== "function") {
      throw new TypeError("関係グラフ検証関数が必要です。");
    }
    if (typeof readClient?.getTask !== "function") {
      throw new TypeError("Asana読み取りクライアントが必要です。");
    }
    if (
      typeof statusWriteClient?.addTaskToProject !== "function"
      || typeof statusWriteClient?.addTaskToSection !== "function"
      || typeof statusWriteClient?.updateTask !== "function"
    ) {
      throw new TypeError("Asana状態書き込みクライアントが必要です。");
    }
    if (typeof operationIdProvider !== "function") {
      throw new TypeError("GUI操作ID発行関数が必要です。");
    }
    this.writer = writer;
    this.postApply = postApply;
    this.onlineStateProvider = onlineStateProvider;
    this.relationGraphValidator = relationGraphValidator;
    this.readClient = readClient;
    this.statusWriteClient = statusWriteClient;
    this.operationIdProvider = operationIdProvider;
  }

  /** GUI編集要求を検証してオンライン時だけAsanaへ反映します。 */
  public async apply(
    input: AsanaGuiEditInput,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    validateAbortSignal(signal);
    signal.throwIfAborted();
    const validatedInput = asanaGuiEditInputSchema.parse(input);
    const operationId = this.nextOperationId();
    const online = this.onlineStateProvider();
    if (typeof online !== "boolean") {
      throw new TypeError("オンライン状態関数は真偽値を返してください。");
    }
    if (!online) {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: validatedInput.task_gid,
        outcome: "rejected",
        reason_code: "offline",
      });
    }
    const statusTarget = statusTargetForOperation(validatedInput.operation);
    if (
      statusTarget != null
      && statusNeedsRepair(
        validatedInput.baseline_task,
        validatedInput.project_gid,
        validatedInput.section_gids,
      )
    ) {
      return this.applyStatusRepair(
        validatedInput,
        operationId,
        statusTarget,
        signal,
      );
    }
    const externalResult = baselineExternal(validatedInput.baseline_task);
    const requiresExternal = operationUsesExternalData(validatedInput.operation);
    if (requiresExternal && externalResult.kind === "conflict") {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: validatedInput.task_gid,
        outcome: "conflict",
        reason_code: externalResult.reason_code,
        side_effect: "none",
      });
    }
    const external = externalResult.kind === "valid"
      ? externalResult.value
      : undefined;
    const relation = relationRequest(validatedInput);
    if (relation != null) {
      const relationResult = asanaGuiEditRelationGraphValidationResultSchema.parse(
        await this.relationGraphValidator(relation, signal),
      );
      if (relationResult.kind === "conflict") {
        return asanaGuiEditResultSchema.parse({
          operation_id: operationId,
          task_gid: validatedInput.task_gid,
          outcome: "conflict",
          reason_code: "relationship_cycle",
          side_effect: "none",
        });
      }
    }
    if (validatedInput.operation.kind === "mark_activity") {
      if (external == null) {
        throw new Error("活動記録操作にはCustom external dataが必要です。");
      }
      return this.applyMarkActivity(
        validatedInput,
        operationId,
        external,
        signal,
      );
    }
    const operation = buildProposalOperation(
      validatedInput,
      operationId,
      external,
      validatedInput.operation,
    );
    const writerInput: AsanaProposalOperationWriterInput = {
      operation,
      project_gid: validatedInput.project_gid,
      workspace_gid: validatedInput.workspace_gid,
      section_gids: validatedInput.section_gids,
      device_id: validatedInput.device_id,
      created_via: validatedInput.created_via,
      activity_date: nonRegressingActivityDate(
        validatedInput.activity_date,
        external,
      ),
      temporary_ref_to_gid: [],
      ...(requiresExternal && external != null
        ? { baseline_external_data: external.response }
        : {}),
    };
    return this.applyWriter(writerInput, validatedInput, operationId, signal);
  }

  private async applyMarkActivity(
    input: AsanaGuiEditInput,
    operationId: string,
    baseline: ParsedBaselineExternal,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    const result = await this.writeActivityAnchor(
      input,
      operationId,
      baseline,
      signal,
    );
    if (result.outcome === "recovery_required") {
      return result;
    }
    return this.finalizePostWriteResult(result, signal);
  }

  private async writeActivityAnchor(
    input: AsanaGuiEditInput,
    operationId: string,
    baseline: ParsedBaselineExternal,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    const currentTask = asanaTaskResponseSchema.parse(
      await this.readClient.getTask(input.task_gid, signal),
    );
    if (currentTask.gid !== input.task_gid) {
      throw new Error("取得したAsanaタスクGIDが活動記録対象と一致しません。");
    }
    const projectMemberships = currentTask.memberships.filter(
      (membership) => membership.project.gid === input.project_gid,
    );
    if (projectMemberships.length !== 1) {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "conflict",
        reason_code: "baseline_changed",
        side_effect: "none",
      });
    }
    const currentResult = baselineExternal(currentTask);
    if (currentResult.kind === "conflict") {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "conflict",
        reason_code: currentResult.reason_code,
        side_effect: "none",
      });
    }
    const current = currentResult.value;
    if (
      current.response.gid !== baseline.response.gid ||
      current.data.id !== baseline.data.id
    ) {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "conflict",
        reason_code: "external_identity_mismatch",
        side_effect: "none",
      });
    }
    if (current.data.activity_anchor_on >= input.activity_date) {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "already_applied",
        reason_code: "already_applied",
      });
    }
    let merged: ReturnType<typeof mergeCustomExternalData>;
    try {
      merged = mergeCustomExternalData({
        baseline: {
          ...baseline.data,
          activity_anchor_on: current.data.activity_anchor_on,
        },
        current: current.data,
        operations: [
          {
            operation: "set_activity_anchor_on",
            before: current.data.activity_anchor_on,
            after: input.activity_date,
          },
        ],
        last_writer: input.device_id,
      });
    } catch (error: unknown) {
      if (error instanceof CustomExternalDataCapacityError) {
        return asanaGuiEditResultSchema.parse({
          operation_id: operationId,
          task_gid: input.task_gid,
          outcome: "conflict",
          reason_code: "external_capacity_exceeded",
          side_effect: "none",
        });
      }
      throw error;
    }
    if (merged.kind === "conflict") {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "conflict",
        reason_code: "merge_conflict",
        side_effect: "none",
      });
    }
    if (merged.kind === "already_applied") {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "already_applied",
        reason_code: "already_applied",
      });
    }
    let serialized: string;
    try {
      serialized = serializeCustomExternalData(merged.data);
    } catch (error: unknown) {
      if (error instanceof CustomExternalDataCapacityError) {
        return asanaGuiEditResultSchema.parse({
          operation_id: operationId,
          task_gid: input.task_gid,
          outcome: "conflict",
          reason_code: "external_capacity_exceeded",
          side_effect: "none",
        });
      }
      throw error;
    }
    try {
      await this.statusWriteClient.updateTask(
        input.task_gid,
        {
          kind: "external",
          value: { gid: current.response.gid, data: serialized },
        },
        signal,
      );
      const readBackTask = asanaTaskResponseSchema.parse(
        await this.readClient.getTask(input.task_gid, signal),
      );
      if (readBackTask.gid !== input.task_gid) {
        throw new Error("読み戻したAsanaタスクGIDが活動記録対象と一致しません。");
      }
      const readBackResult = baselineExternal(readBackTask);
      const matches =
        readBackResult.kind === "valid" &&
        readBackResult.value.response.gid === current.response.gid &&
        readBackResult.value.data.id === current.data.id &&
        readBackResult.value.data.activity_anchor_on >= input.activity_date;
      return matches
        ? asanaGuiEditResultSchema.parse({
            operation_id: operationId,
            task_gid: input.task_gid,
            outcome: "applied",
            reason_code: "applied",
          })
        : asanaGuiEditResultSchema.parse({
            operation_id: operationId,
            task_gid: input.task_gid,
            outcome: "conflict",
            reason_code: "read_back_mismatch",
            side_effect: "possible",
          });
    } catch (error: unknown) {
      return this.resolvePossibleWriteError(
        error,
        input.task_gid,
        operationId,
        signal,
      );
    }
  }

  private nextOperationId(): string {
    return identifierSchema.parse(this.operationIdProvider());
  }

  private async applyWriter(
    writerInput: AsanaProposalOperationWriterInput,
    input: AsanaGuiEditInput,
    operationId: string,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    let writerResult: WriterResult;
    try {
      writerResult = asanaProposalOperationWriterResultSchema.parse(
        await this.writer.apply(writerInput, signal),
      );
    } catch (error: unknown) {
      return this.resolvePossibleWriteError(
        error,
        input.task_gid,
        operationId,
        signal,
      );
    }
    let result: AsanaGuiEditResult;
    try {
      result = resultFromWriter(input, operationId, writerResult);
    } catch (error: unknown) {
      return this.rethrowUnexpectedAfterPostApply(error, signal);
    }
    return this.finalizePostWriteResult(result, signal);
  }

  private async applyStatusRepair(
    input: AsanaGuiEditInput,
    operationId: string,
    targetStatus: TaskStatus,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    const baseline = statusSnapshot(input.baseline_task, input.project_gid);
    const current = asanaTaskResponseSchema.parse(
      await this.readClient.getTask(input.task_gid, signal),
    );
    if (!sameStatusSnapshot(baseline, statusSnapshot(current, input.project_gid))) {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: input.task_gid,
        outcome: "conflict",
        reason_code: "baseline_changed",
        side_effect: "none",
      });
    }
    const definition = statusDefinition(targetStatus, input.section_gids);
    const currentMemberships = current.memberships.filter(
      (membership) => membership.project.gid === input.project_gid,
    );
    if (currentMemberships.length > 1) {
      throw new Error("状態修復対象の専用プロジェクト所属が重複しています。");
    }
    const currentMembership = currentMemberships[0];
    let attempted = false;
    try {
      if (currentMembership == null) {
        attempted = true;
        const position: AsanaTaskInsertionPosition = { kind: "none" };
        await this.statusWriteClient.addTaskToProject(
          input.task_gid,
          input.project_gid,
          definition.section_gid,
          position,
          signal,
        );
      } else if (
        currentMembership.section == null
        || currentMembership.section.gid !== definition.section_gid
      ) {
        attempted = true;
        const position: AsanaTaskInsertionPosition = { kind: "none" };
        await this.statusWriteClient.addTaskToSection(
          input.task_gid,
          definition.section_gid,
          position,
          signal,
        );
      }
      if (current.completed !== definition.completed) {
        attempted = true;
        const update: AsanaTaskUpdate = {
          kind: "completed",
          value: definition.completed,
        };
        await this.statusWriteClient.updateTask(input.task_gid, update, signal);
      }
      const readBack = asanaTaskResponseSchema.parse(
        await this.readClient.getTask(input.task_gid, signal),
      );
      const result = matchesStatus(readBack, input.project_gid, definition)
        ? asanaGuiEditResultSchema.parse({
            operation_id: operationId,
            task_gid: input.task_gid,
            outcome: attempted ? "applied" : "already_applied",
            reason_code: attempted ? "applied" : "already_applied",
          })
        : asanaGuiEditResultSchema.parse({
            operation_id: operationId,
            task_gid: input.task_gid,
            outcome: "conflict",
            reason_code: "read_back_mismatch",
            side_effect: "possible",
          });
      if (attempted) {
        return this.finalizePostWriteResult(result, signal);
      }
      return result;
    } catch (error: unknown) {
      if (attempted) {
        return this.resolvePossibleWriteError(
          error,
          input.task_gid,
          operationId,
          signal,
        );
      }
      throw error;
    }
  }

  private async finalizePostWriteResult(
    result: AsanaGuiEditResult,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    const synchronization = asanaPostWriteSynchronizationResultSchema.parse(
      await this.postApply(signal),
    );
    if (synchronization.kind === "synchronized") {
      return result;
    }
    const disposition = postWriteDisposition(result);
    if (disposition.kind === "preserve") {
      return result;
    }
    return asanaGuiEditResultSchema.parse({
      operation_id: result.operation_id,
      task_gid: result.task_gid,
      outcome: "recovery_required",
      reason_code: "local_resync_required",
      write_outcome: disposition.write_outcome,
      sync_error_code: synchronization.error_code,
    });
  }

  private async resolvePossibleWriteError(
    error: unknown,
    taskGid: string,
    operationId: string,
    signal: AbortSignal,
  ): Promise<AsanaGuiEditResult> {
    const synchronization = await this.synchronizeAfterWriteError(error, signal);
    if (
      synchronization.kind === "recovery_required"
      && (signal.aborted || isKnownAsanaOperationalError(error))
    ) {
      return asanaGuiEditResultSchema.parse({
        operation_id: operationId,
        task_gid: taskGid,
        outcome: "recovery_required",
        reason_code: "local_resync_required",
        write_outcome: "unknown",
        sync_error_code: synchronization.error_code,
      });
    }
    throw error;
  }

  private async rethrowUnexpectedAfterPostApply(
    error: unknown,
    signal: AbortSignal,
  ): Promise<never> {
    await this.synchronizeAfterWriteError(error, signal);
    throw error;
  }

  private async synchronizeAfterWriteError(
    error: unknown,
    signal: AbortSignal,
  ): Promise<PostWriteSynchronizationResult> {
    try {
      return asanaPostWriteSynchronizationResultSchema.parse(
        await this.postApply(signal),
      );
    } catch (postApplyError: unknown) {
      throw new AggregateError(
        [error, postApplyError],
        "GUI編集後の同期と順位再計算に失敗しました。",
        { cause: error },
      );
    }
  }
}
