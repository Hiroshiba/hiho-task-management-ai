import { z } from "zod";
import {
  maximumGroupOperations,
  maximumProposalGroups,
  maximumProposalOperations,
  maximumProposalWorkspaceArgumentBytes,
  maximumProposalWorkspaceResponseBytes,
  proposalSchema,
  proposalWorkspaceBatchSchema,
  proposalWorkspaceDiffSchema,
  proposalWorkspaceReadSchema,
  proposalWorkspaceSubmitSchema,
  type Proposal,
  type ProposalOperation,
  type ProposalWorkspaceBatch,
  type ProposalWorkspaceDiff,
  type ProposalWorkspaceEdit,
  type ProposalWorkspaceRead,
  type ProposalWorkspaceSubmit,
} from "../../../shared/ai";
import { identifierSchema, snapshotHashSchema } from "../../../shared/domain";

type DraftGroup = {
  group_id: string;
  atomic: boolean;
  operations: ProposalOperation[];
};

type Draft = {
  title?: string;
  groups: DraftGroup[];
};

type GroupState = { atomic: boolean; index: number };
type OperationState = {
  group_id: string;
  index: number;
  operation: ProposalOperation;
};

type SemanticChange =
  | { kind: "title"; before?: string; after?: string }
  | { kind: "group"; group_id: string; before?: GroupState; after?: GroupState }
  | {
      kind: "operation";
      operation_id: string;
      before?: OperationState;
      after?: OperationState;
    };

type RevisionChanges = {
  revision: number;
  changes: SemanticChange[];
};

export type ProposalWorkspaceIssue = {
  code: string;
  json_pointer: string;
  message: string;
  group_id?: string;
  operation_id?: string;
};

export type ProposalWorkspaceStatus = {
  workspace_id: string;
  baseline_snapshot_hash: string;
  revision: number;
  state: "draft" | "submitted";
  completion: "incomplete" | "structurally_complete";
  issues: ProposalWorkspaceIssue[];
};

export type ProposalWorkspaceChunk = {
  workspace_id: string;
  revision: number;
  offset: number;
  content: string;
  next_offset?: number;
  from_revision?: number;
};

export type ProposalWorkspaceValidation<T> =
  | { kind: "valid"; proposal: Proposal; value: T }
  | { kind: "invalid"; issues: ProposalWorkspaceIssue[] };

export type ProposalWorkspaceSubmission<T> =
  | { kind: "submitted"; revision: number; proposal: Proposal; value: T }
  | { kind: "invalid"; revision: number; issues: ProposalWorkspaceIssue[] };

export type ProposalWorkspaceValidationResult<T> =
  | { kind: "valid"; revision: number; proposal: Proposal; value: T }
  | { kind: "invalid"; revision: number; issues: ProposalWorkspaceIssue[] };

export type ProposalWorkspaceConflictCode =
  | "workspace_mismatch"
  | "revision_mismatch"
  | "edit_batch_id_reused"
  | "state_mismatch";

/** ワークスペースの競合を呼び出し側で分類するためのエラーです。 */
export class ProposalWorkspaceConflictError extends Error {
  readonly code: ProposalWorkspaceConflictCode;

  constructor(code: ProposalWorkspaceConflictCode, message: string) {
    super(message);
    this.name = "ProposalWorkspaceConflictError";
    this.code = code;
  }
}

/** ワークスペースへの利用者入力を拒否したことを表します。 */
export class ProposalWorkspaceInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProposalWorkspaceInputError";
  }
}

/** 意味編集の利用者入力を拒否したことを表します。 */
export class ProposalWorkspaceEditError extends ProposalWorkspaceInputError {
  constructor(message: string) {
    super(message);
    this.name = "ProposalWorkspaceEditError";
  }
}

export type ProposalWorkspaceOptions = {
  workspace_id: string;
  baseline_snapshot_hash: string;
  initial_proposal?: Proposal;
};

const workspaceOptionsSchema = z.object({
  workspace_id: identifierSchema,
  baseline_snapshot_hash: snapshotHashSchema,
  initial_proposal: proposalSchema.optional(),
}).strict();

function requireGroup(draft: Draft, groupId: string): DraftGroup {
  const group = draft.groups.find((candidate) => candidate.group_id === groupId);
  if (group == null) {
    throw new ProposalWorkspaceEditError(`group_id ${groupId} がワークスペースにありません。`);
  }
  return group;
}

function requireOperation(
  draft: Draft,
  operationId: string,
): { group: DraftGroup; index: number; operation: ProposalOperation } {
  for (const group of draft.groups) {
    const index = group.operations.findIndex(
      (candidate) => candidate.operation_id === operationId,
    );
    if (index >= 0) {
      const operation = group.operations[index];
      if (operation == null) {
        throw new Error(`operation_id ${operationId} の位置が不正です。`);
      }
      return { group, index, operation };
    }
  }
  throw new ProposalWorkspaceEditError(`operation_id ${operationId} がワークスペースにありません。`);
}

function insertionIndex<T>(
  values: readonly T[],
  beforeId: string | undefined,
  getId: (value: T) => string,
): number {
  if (beforeId == null) {
    return values.length;
  }
  const index = values.findIndex((value) => getId(value) === beforeId);
  if (index < 0) {
    throw new ProposalWorkspaceEditError(`挿入位置のID ${beforeId} が対象にありません。`);
  }
  return index;
}

function applyEdit(draft: Draft, edit: ProposalWorkspaceEdit): void {
  switch (edit.kind) {
    case "set_title":
      draft.title = edit.title;
      return;
    case "insert_group": {
      if (draft.groups.some((group) => group.group_id === edit.group_id)) {
        throw new ProposalWorkspaceEditError(`group_id ${edit.group_id} が重複しています。`);
      }
      const index = insertionIndex(
        draft.groups,
        edit.before_group_id,
        (group) => group.group_id,
      );
      draft.groups.splice(index, 0, {
        group_id: edit.group_id,
        atomic: edit.atomic,
        operations: [],
      });
      return;
    }
    case "set_group_atomic":
      requireGroup(draft, edit.group_id).atomic = edit.atomic;
      return;
    case "move_group": {
      const index = draft.groups.findIndex((group) => group.group_id === edit.group_id);
      if (index < 0) {
        throw new ProposalWorkspaceEditError(`group_id ${edit.group_id} がワークスペースにありません。`);
      }
      const moved = draft.groups.splice(index, 1)[0];
      if (moved == null) {
        throw new Error(`group_id ${edit.group_id} の位置が不正です。`);
      }
      const destination = insertionIndex(
        draft.groups,
        edit.before_group_id,
        (group) => group.group_id,
      );
      draft.groups.splice(destination, 0, moved);
      return;
    }
    case "remove_group": {
      const index = draft.groups.findIndex((group) => group.group_id === edit.group_id);
      if (index < 0) {
        throw new ProposalWorkspaceEditError(`group_id ${edit.group_id} がワークスペースにありません。`);
      }
      draft.groups.splice(index, 1);
      return;
    }
    case "insert_operation": {
      const group = requireGroup(draft, edit.group_id);
      const index = insertionIndex(
        group.operations,
        edit.before_operation_id,
        (operation) => operation.operation_id,
      );
      group.operations.splice(index, 0, edit.operation);
      return;
    }
    case "replace_operation": {
      if (edit.operation.operation_id !== edit.operation_id) {
        throw new ProposalWorkspaceEditError("操作の置換でoperation_idを変更できません。");
      }
      const location = requireOperation(draft, edit.operation_id);
      location.group.operations[location.index] = edit.operation;
      return;
    }
    case "move_operation": {
      const location = requireOperation(draft, edit.operation_id);
      const destinationGroup = requireGroup(draft, edit.group_id);
      location.group.operations.splice(location.index, 1);
      const destination = insertionIndex(
        destinationGroup.operations,
        edit.before_operation_id,
        (operation) => operation.operation_id,
      );
      destinationGroup.operations.splice(destination, 0, location.operation);
      return;
    }
    case "remove_operation": {
      const location = requireOperation(draft, edit.operation_id);
      location.group.operations.splice(location.index, 1);
      return;
    }
    case "replace_all":
      draft.title = edit.proposal.title;
      draft.groups = structuredClone(edit.proposal.groups);
      return;
  }
}

function assertDraftIdentity(draft: Draft): void {
  if (draft.groups.length > maximumProposalGroups) {
    throw new ProposalWorkspaceEditError(`グループ数は${maximumProposalGroups}件までです。`);
  }
  const groupIds = new Set<string>();
  const operationIds = new Set<string>();
  const temporaryRefs = new Set<string>();
  let operationCount = 0;
  for (const group of draft.groups) {
    if (groupIds.has(group.group_id)) {
      throw new ProposalWorkspaceEditError(`group_id ${group.group_id} が重複しています。`);
    }
    groupIds.add(group.group_id);
    if (group.operations.length > maximumGroupOperations) {
      throw new ProposalWorkspaceEditError(`グループ内の操作数は${maximumGroupOperations}件までです。`);
    }
    operationCount += group.operations.length;
    for (const operation of group.operations) {
      if (operationIds.has(operation.operation_id)) {
        throw new ProposalWorkspaceEditError(`operation_id ${operation.operation_id} が重複しています。`);
      }
      operationIds.add(operation.operation_id);
      if (operation.operation === "create_task") {
        if (temporaryRefs.has(operation.temporary_ref)) {
          throw new ProposalWorkspaceEditError(`temporary_ref ${operation.temporary_ref} が重複しています。`);
        }
        temporaryRefs.add(operation.temporary_ref);
      }
    }
  }
  if (operationCount > maximumProposalOperations) {
    throw new ProposalWorkspaceEditError(`変更案全体の操作数は${maximumProposalOperations}件までです。`);
  }
}

function jsonPointer(path: readonly PropertyKey[]): string {
  return path
    .map((item) => `/${String(item).replaceAll("~", "~0").replaceAll("/", "~1")}`)
    .join("");
}

function proposalIssues(draft: Draft, baselineHash: string): ProposalWorkspaceIssue[] {
  const result = proposalSchema.safeParse(draft);
  const issues: ProposalWorkspaceIssue[] = result.success
    ? []
    : result.error.issues.map((issue) => ({
        code: "proposal_schema_invalid",
        json_pointer: jsonPointer(issue.path),
        message: issue.message,
      }));
  for (const [groupIndex, group] of draft.groups.entries()) {
    for (const [operationIndex, operation] of group.operations.entries()) {
      if (operation.baseline_snapshot_hash !== baselineHash) {
        issues.push({
          code: "baseline_snapshot_mismatch",
          json_pointer: `/groups/${groupIndex}/operations/${operationIndex}/baseline_snapshot_hash`,
          message: "操作の基準スナップショットがワークスペースと一致しません。",
          group_id: group.group_id,
          operation_id: operation.operation_id,
        });
      }
    }
  }
  return issues;
}

function groupStates(draft: Draft): Map<string, GroupState> {
  return new Map(draft.groups.map((group, index) => [
    group.group_id,
    { atomic: group.atomic, index },
  ]));
}

function operationStates(draft: Draft): Map<string, OperationState> {
  const states = new Map<string, OperationState>();
  for (const group of draft.groups) {
    group.operations.forEach((operation, index) => {
      states.set(operation.operation_id, {
        group_id: group.group_id,
        index,
        operation,
      });
    });
  }
  return states;
}

function changed<T>(before: T | undefined, after: T | undefined): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

function semanticChanges(before: Draft, after: Draft): SemanticChange[] {
  const changes: SemanticChange[] = [];
  if (changed(before.title, after.title)) {
    changes.push({
      kind: "title",
      ...(before.title == null ? {} : { before: before.title }),
      ...(after.title == null ? {} : { after: after.title }),
    });
  }
  const oldGroups = groupStates(before);
  const newGroups = groupStates(after);
  for (const groupId of new Set([...oldGroups.keys(), ...newGroups.keys()])) {
    const oldState = oldGroups.get(groupId);
    const newState = newGroups.get(groupId);
    if (changed(oldState, newState)) {
      changes.push({
        kind: "group",
        group_id: groupId,
        ...(oldState == null ? {} : { before: oldState }),
        ...(newState == null ? {} : { after: newState }),
      });
    }
  }
  const oldOperations = operationStates(before);
  const newOperations = operationStates(after);
  for (const operationId of new Set([...oldOperations.keys(), ...newOperations.keys()])) {
    const oldState = oldOperations.get(operationId);
    const newState = newOperations.get(operationId);
    if (changed(oldState, newState)) {
      changes.push({
        kind: "operation",
        operation_id: operationId,
        ...(oldState == null ? {} : { before: oldState }),
        ...(newState == null ? {} : { after: newState }),
      });
    }
  }
  return changes;
}

function mergeChanges(
  history: readonly RevisionChanges[],
  fromRevision: number,
): SemanticChange[] {
  const changes = new Map<string, SemanticChange>();
  for (const entry of history) {
    if (entry.revision <= fromRevision) {
      continue;
    }
    for (const change of entry.changes) {
      const key = change.kind === "title"
        ? "title"
        : `${change.kind}\u0000${change.kind === "group" ? change.group_id : change.operation_id}`;
      const previous = changes.get(key);
      if (previous == null) {
        changes.set(key, change);
        continue;
      }
      if (previous.kind === "title" && change.kind === "title") {
        changes.set(key, {
          kind: "title",
          ...(previous.before == null ? {} : { before: previous.before }),
          ...(change.after == null ? {} : { after: change.after }),
        });
      } else if (previous.kind === "group" && change.kind === "group") {
        changes.set(key, {
          kind: "group",
          group_id: change.group_id,
          ...(previous.before == null ? {} : { before: previous.before }),
          ...(change.after == null ? {} : { after: change.after }),
        });
      } else if (previous.kind === "operation" && change.kind === "operation") {
        changes.set(key, {
          kind: "operation",
          operation_id: change.operation_id,
          ...(previous.before == null ? {} : { before: previous.before }),
          ...(change.after == null ? {} : { after: change.after }),
        });
      } else {
        throw new Error("意味差分の種類が一致しません。");
      }
    }
  }
  return [...changes.values()].filter((change) => changed(change.before, change.after));
}

function assertStringBoundary(value: string, offset: number): void {
  if (offset > value.length) {
    throw new ProposalWorkspaceInputError("読み取り開始位置が内容の末尾を超えています。");
  }
  const previous = value.charCodeAt(offset - 1);
  const current = value.charCodeAt(offset);
  if (
    previous >= 0xd800 && previous <= 0xdbff
    && current >= 0xdc00 && current <= 0xdfff
  ) {
    throw new ProposalWorkspaceInputError("読み取り開始位置が文字の途中です。");
  }
}

function chunk(
  value: unknown,
  metadata: Omit<ProposalWorkspaceChunk, "content" | "offset" | "next_offset">,
  offset: number,
): ProposalWorkspaceChunk {
  const serialized = JSON.stringify(value);
  if (serialized == null) {
    throw new Error("読み取り内容をJSONへ変換できません。");
  }
  assertStringBoundary(serialized, offset);
  let low = offset;
  let high = serialized.length;
  while (low < high) {
    let middle = Math.ceil((low + high) / 2);
    if (
      middle < serialized.length
      && serialized.charCodeAt(middle - 1) >= 0xd800
      && serialized.charCodeAt(middle - 1) <= 0xdbff
    ) {
      middle -= 1;
    }
    if (middle <= low) {
      high = low;
      continue;
    }
    const candidate = {
      ...metadata,
      offset,
      content: serialized.slice(offset, middle),
      ...(middle < serialized.length ? { next_offset: middle } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maximumProposalWorkspaceResponseBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low === offset && offset < serialized.length) {
    throw new Error("読み取り応答の上限内に内容を収められません。");
  }
  return {
    ...metadata,
    offset,
    content: serialized.slice(offset, low),
    ...(low < serialized.length ? { next_offset: low } : {}),
  };
}

/** 固定した基準へ結び付けた変更案をメモリ内で編集します。 */
export class ProposalWorkspace {
  readonly workspaceId: string;
  readonly baselineSnapshotHash: string;
  private draft: Draft;
  private revision = 0;
  private state: "draft" | "submitted" = "draft";
  private readonly batches = new Map<string, { content: string; status: ProposalWorkspaceStatus }>();
  private readonly history: RevisionChanges[] = [];

  constructor(options: ProposalWorkspaceOptions) {
    const parsed = workspaceOptionsSchema.parse(options);
    this.workspaceId = parsed.workspace_id;
    this.baselineSnapshotHash = parsed.baseline_snapshot_hash;
    this.draft = parsed.initial_proposal == null
      ? { groups: [] }
      : structuredClone(parsed.initial_proposal);
    assertDraftIdentity(this.draft);
  }

  private assertWorkspaceId(workspaceId: string): void {
    if (workspaceId !== this.workspaceId) {
      throw new ProposalWorkspaceConflictError(
        "workspace_mismatch",
        "ワークスペースIDが現在のワークスペースと一致しません。",
      );
    }
  }

  private assertDraft(): void {
    if (this.state !== "draft") {
      throw new ProposalWorkspaceConflictError(
        "state_mismatch",
        "提出済みワークスペースは編集・検証・再提出できません。",
      );
    }
  }

  private assertRevision(revision: number): void {
    if (revision !== this.revision) {
      throw new ProposalWorkspaceConflictError(
        "revision_mismatch",
        "ワークスペースの改訂番号が一致しません。",
      );
    }
  }

  /** 現在の改訂番号と完成状態を返します。 */
  getStatus(): ProposalWorkspaceStatus {
    const issues = proposalIssues(this.draft, this.baselineSnapshotHash);
    return {
      workspace_id: this.workspaceId,
      baseline_snapshot_hash: this.baselineSnapshotHash,
      revision: this.revision,
      state: this.state,
      completion: issues.length === 0 ? "structurally_complete" : "incomplete",
      issues,
    };
  }

  /** 意味編集バッチを原子的に適用します。 */
  applyBatch(input: ProposalWorkspaceBatch): ProposalWorkspaceStatus {
    const parsed = proposalWorkspaceBatchSchema.parse(input);
    if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > maximumProposalWorkspaceArgumentBytes) {
      throw new ProposalWorkspaceEditError("編集バッチが128 KiBの上限を超えています。");
    }
    this.assertWorkspaceId(parsed.workspace_id);
    const content = JSON.stringify(parsed);
    const previousBatch = this.batches.get(parsed.edit_batch_id);
    if (previousBatch != null) {
      if (previousBatch.content !== content) {
        throw new ProposalWorkspaceConflictError(
          "edit_batch_id_reused",
          "同じedit_batch_idに異なる編集内容を指定できません。",
        );
      }
      return structuredClone(previousBatch.status);
    }
    this.assertDraft();
    this.assertRevision(parsed.expected_revision);
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("ワークスペースの改訂番号が上限に達しました。");
    }
    const next = structuredClone(this.draft);
    for (const edit of parsed.edits) {
      applyEdit(next, edit);
    }
    assertDraftIdentity(next);
    const changes = semanticChanges(this.draft, next);
    this.draft = next;
    this.revision += 1;
    this.history.push({ revision: this.revision, changes });
    const status = this.getStatus();
    this.batches.set(parsed.edit_batch_id, { content, status });
    return structuredClone(status);
  }

  /** 現在の改訂番号に結び付けて必要部分を読み取ります。 */
  read(input: ProposalWorkspaceRead): ProposalWorkspaceChunk {
    const parsed = proposalWorkspaceReadSchema.parse(input);
    this.assertWorkspaceId(parsed.workspace_id);
    this.assertRevision(parsed.revision);
    let value: unknown;
    switch (parsed.target.kind) {
      case "summary":
        value = {
          ...this.getStatus(),
          title: this.draft.title,
          groups: this.draft.groups.map((group) => ({
            group_id: group.group_id,
            atomic: group.atomic,
            operation_ids: group.operations.map((operation) => operation.operation_id),
          })),
        };
        break;
      case "proposal":
        value = this.draft;
        break;
      case "group":
        value = requireGroup(this.draft, parsed.target.group_id);
        break;
      case "operation":
        value = requireOperation(this.draft, parsed.target.operation_id).operation;
        break;
    }
    return chunk(value, {
      workspace_id: this.workspaceId,
      revision: this.revision,
    }, parsed.offset ?? 0);
  }

  /** 指定した改訂番号からの意味差分を返します。 */
  diff(input: ProposalWorkspaceDiff): ProposalWorkspaceChunk {
    const parsed = proposalWorkspaceDiffSchema.parse(input);
    this.assertWorkspaceId(parsed.workspace_id);
    this.assertRevision(parsed.revision);
    if (parsed.from_revision > this.revision) {
      throw new ProposalWorkspaceInputError("差分の開始改訂番号が現在の改訂番号を超えています。");
    }
    return chunk(mergeChanges(this.history, parsed.from_revision), {
      workspace_id: this.workspaceId,
      revision: this.revision,
      from_revision: parsed.from_revision,
    }, parsed.offset ?? 0);
  }

  /** 完成案を変更せずに検証します。 */
  validate<T>(
    input: ProposalWorkspaceSubmit,
    validate: (proposal: Proposal) => ProposalWorkspaceValidation<T>,
  ): ProposalWorkspaceValidationResult<T> {
    const parsed = proposalWorkspaceSubmitSchema.parse(input);
    this.assertWorkspaceId(parsed.workspace_id);
    this.assertDraft();
    this.assertRevision(parsed.expected_revision);
    const issues = proposalIssues(this.draft, this.baselineSnapshotHash);
    if (issues.length > 0) {
      return { kind: "invalid", revision: this.revision, issues };
    }
    const proposal = proposalSchema.parse(structuredClone(this.draft));
    const validation = validate(structuredClone(proposal));
    if (validation.kind === "invalid") {
      if (validation.issues.length === 0) {
        throw new Error("意味検証の失敗には検証エラーを指定してください。");
      }
      return { kind: "invalid", revision: this.revision, issues: validation.issues };
    }
    const validatedProposal = proposalSchema.parse(validation.proposal);
    const validatedIssues = proposalIssues(validatedProposal, this.baselineSnapshotHash);
    if (validatedIssues.length > 0) {
      throw new Error("提出検証の結果がワークスペースの基準と一致しません。");
    }
    if (
      validatedProposal.title !== proposal.title
      || validatedProposal.groups.length !== proposal.groups.length
    ) {
      throw new Error("提出検証で変更案のタイトルまたはグループ数が変更されました。");
    }
    for (const [groupIndex, group] of proposal.groups.entries()) {
      const validatedGroup = validatedProposal.groups[groupIndex];
      if (
        validatedGroup?.group_id !== group.group_id
        || validatedGroup.atomic !== group.atomic
        || validatedGroup.operations.length !== group.operations.length
      ) {
        throw new Error("提出検証でグループまたは操作のIDが変更されました。");
      }
      for (const [operationIndex, operation] of group.operations.entries()) {
        const validatedOperation = validatedGroup.operations[operationIndex];
        if (
          validatedOperation?.operation_id !== operation.operation_id
          || validatedOperation.operation !== operation.operation
        ) {
          throw new Error("提出検証でグループまたは操作のIDが変更されました。");
        }
      }
    }
    return {
      kind: "valid",
      revision: this.revision,
      proposal: validatedProposal,
      value: validation.value,
    };
  }

  /** 完成案を検証して提出済みとして封印します。 */
  submit<T>(
    input: ProposalWorkspaceSubmit,
    validate: (proposal: Proposal) => ProposalWorkspaceValidation<T>,
  ): ProposalWorkspaceSubmission<T> {
    const result = this.validate(input, validate);
    if (result.kind === "invalid") {
      return result;
    }
    this.state = "submitted";
    return {
      kind: "submitted",
      revision: result.revision,
      proposal: result.proposal,
      value: result.value,
    };
  }
}
