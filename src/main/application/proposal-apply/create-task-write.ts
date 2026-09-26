import { applyCategoryTag } from "./category-tag-write";
import {
  classifyCreateCore,
  type CreateReadBackDependencies,
  type CreateTask,
} from "./create-read-back";
import { applyStatus, expectedStatus } from "./status-write";

type Tag = { readonly gid: string; readonly name: string };
type Target = { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };
type Due = { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type Status = "not_started" | "in_progress";
type SectionGids = {
  readonly not_started: string;
  readonly in_progress: string;
  readonly completed: string;
  readonly withdrawn: string;
};
type CreateOperation = {
  readonly operation_id: string;
  readonly temporary_ref: string;
  readonly after: {
    readonly title: string;
    readonly notes?: string | undefined;
    readonly due?: Due | undefined;
    readonly status?: Status | undefined;
    readonly importance?: number | undefined;
    readonly area?: string | undefined;
    readonly parent?: Target | undefined;
  };
};
type CreateInput = {
  readonly project_gid: string;
  readonly workspace_gid: string;
  readonly section_gids: SectionGids;
  readonly existing_task?: unknown;
};
type WriteTask<TTag extends Tag> = CreateTask<TTag> & { readonly gid: string };
type ExpectedExternal<TData> = { readonly gid: string; readonly data: TData };
type ConflictReason =
  | "baseline_changed" | "read_back_mismatch" | "external_unreadable"
  | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded";
type CoreWriteResult =
  | { readonly kind: "completed"; readonly changed: boolean }
  | { readonly kind: "conflict"; readonly side_effect: "none" | "possible"; readonly reason_code?: ConflictReason };
type ReadBackObservation<TTask, TError> =
  | { readonly kind: "ready"; readonly task: TTask }
  | { readonly kind: "pending"; readonly reason: "projection" }
  | { readonly kind: "pending"; readonly reason: "not_found"; readonly not_found_error: TError }
  | { readonly kind: "conflict"; readonly reason_code: "read_back_mismatch" | "external_unreadable" | "external_identity_mismatch" };
type CreationInput = {
  readonly project_gid: string;
  readonly section_gid: string;
  readonly title: string;
  readonly completed: boolean;
  readonly external: { readonly gid: string; readonly data: string };
  readonly notes?: string | undefined;
  readonly due_on?: string | undefined;
  readonly due_at?: string | undefined;
};
type WriteAction =
  | "create_task" | "update_task" | "add_task_to_project" | "add_task_to_section"
  | "add_task_tag" | "remove_task_tag" | "set_task_parent" | "clear_task_parent";

export type CreateTaskWriteDependencies<
  TInput extends CreateInput,
  TOperation extends CreateOperation,
  TTask extends WriteTask<TTag>,
  TTag extends Tag,
  TData,
  TError,
  TResult,
> = {
  readonly readBackDependencies: CreateReadBackDependencies<TTask, TTag, TData>;
  readonly createExternalState: (input: TInput, operation: TOperation, mappings: ReadonlyMap<string, string>) => ExpectedExternal<TData>;
  readonly fetchWorkspaceTags: (workspaceGid: string, signal: AbortSignal) => Promise<readonly TTag[]>;
  readonly parseExistingTask: (task: unknown) => TTask;
  readonly readCreatedTaskWithProjectionRetry: (taskGid: string, input: TInput, operation: TOperation, mappings: ReadonlyMap<string, string>, tags: readonly TTag[], expectedExternal: ExpectedExternal<TData>, signal: AbortSignal) => Promise<ReadBackObservation<TTask, TError>>;
  readonly createTaskNotFoundError: (taskGid: string, cause: TError) => Error;
  readonly createConflictResult: (operationId: string, taskGid: string, reason: ConflictReason, sideEffect: "none" | "possible") => TResult;
  readonly externalConflictResult: (operationId: string, taskGid: string, reason: "external_unreadable" | "external_identity_mismatch" | "merge_conflict" | "external_capacity_exceeded", sideEffect: "none" | "possible") => TResult;
  readonly createResult: (operationId: string, taskGid: string, outcome: "applied" | "already_applied", reason: "applied" | "already_applied") => TResult;
  readonly expectedExternalWriteGuard: (expected: ExpectedExternal<TData>) => (task: TTask) => ConflictReason | undefined;
  readonly readTask: (taskGid: string, signal: AbortSignal) => Promise<TTask>;
  readonly taskExternalMatches: (task: TTask, expected: ExpectedExternal<TData>) => boolean;
  readonly readCurrentExternal: (task: TTask) => { readonly kind: "valid"; readonly value: { readonly response: { readonly gid: string } } } | { readonly kind: "conflict"; readonly reason_code: "external_unreadable" | "external_identity_mismatch" };
  readonly serializeExternal: (data: TData) => string;
  readonly createTask: (input: CreationInput, signal: AbortSignal) => Promise<{ readonly gid: string }>;
  readonly addTaskTag: (taskGid: string, tagGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly removeTaskTag: (taskGid: string, tagGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly addTaskToSection: (taskGid: string, sectionGid: string, signal: AbortSignal) => Promise<unknown>;
  readonly updateCompleted: (taskGid: string, completed: boolean, signal: AbortSignal) => Promise<unknown>;
  readonly resolveTargetGid: (target: Target, mappings: ReadonlyMap<string, string>) => string;
  readonly taskParentGid: (task: TTask) => string | null;
  readonly setTaskParent: (taskGid: string, parentGid: string, signal: AbortSignal) => Promise<unknown>;
};

/** 作成操作の既存タスク照合と新規作成を適用します。 */
export async function applyCreateTask<
  TInput extends CreateInput,
  TOperation extends CreateOperation,
  TTask extends WriteTask<TTag>,
  TTag extends Tag,
  TData,
  TError,
  TResult,
>(
  input: TInput,
  operation: TOperation,
  mappings: ReadonlyMap<string, string>,
  signal: AbortSignal,
  onCreateTaskCreated: (operationId: string, taskGid: string) => void,
  onWriteAttempt: (action: WriteAction) => void,
  dependencies: CreateTaskWriteDependencies<TInput, TOperation, TTask, TTag, TData, TError, TResult>,
): Promise<TResult> {
  const expectedExternal = dependencies.createExternalState(input, operation, mappings);
  const tags = await dependencies.fetchWorkspaceTags(input.workspace_gid, signal);
  const mappedTaskGid = mappings.get(operation.temporary_ref);
  let recoveryTaskGid = mappedTaskGid;
  if (input.existing_task != null) {
    const existingReference = dependencies.parseExistingTask(input.existing_task);
    if (mappedTaskGid != null && existingReference.gid !== mappedTaskGid) {
      throw new Error("create_taskの復旧対象GIDがtemporary_ref対応と一致しません。");
    }
    recoveryTaskGid = existingReference.gid;
  }
  if (recoveryTaskGid != null) {
    const existingReadBack = await dependencies.readCreatedTaskWithProjectionRetry(
      recoveryTaskGid,
      input,
      operation,
      mappings,
      tags,
      expectedExternal,
      signal,
    );
    if (existingReadBack.kind === "pending") {
      if (existingReadBack.reason === "not_found") {
        throw dependencies.createTaskNotFoundError(
          recoveryTaskGid,
          existingReadBack.not_found_error,
        );
      }
      return dependencies.createConflictResult(
        operation.operation_id,
        recoveryTaskGid,
        "read_back_mismatch",
        "possible",
      );
    }
    if (existingReadBack.kind === "conflict") {
      return dependencies.createConflictResult(
        operation.operation_id,
        recoveryTaskGid,
        existingReadBack.reason_code,
        "possible",
      );
    }
    const existing = existingReadBack.task;
    const coreState = classifyCreateCore(
      existing, input, operation, mappings, tags, dependencies.readBackDependencies,
    );
    if (coreState === "conflict") {
      return dependencies.createConflictResult(
        operation.operation_id,
        existing.gid,
        "read_back_mismatch",
        "possible",
      );
    }
    if (coreState === "after") {
      return dependencies.createResult(operation.operation_id, existing.gid, "already_applied", "already_applied");
    }
    const attributes = await applyCreateAttributes(
      existing.gid,
      input,
      operation,
      mappings,
      tags,
      dependencies.expectedExternalWriteGuard(expectedExternal),
      onWriteAttempt,
      signal,
      dependencies,
    );
    if (attributes.kind === "conflict") {
      return dependencies.createConflictResult(
        operation.operation_id,
        existing.gid,
        "read_back_mismatch",
        "possible",
      );
    }
    const readBack = await dependencies.readTask(existing.gid, signal);
    if (
      classifyCreateCore(
        readBack, input, operation, mappings, tags, dependencies.readBackDependencies,
      ) !== "after"
      || !dependencies.taskExternalMatches(readBack, expectedExternal)
    ) {
      return dependencies.createConflictResult(
        operation.operation_id,
        existing.gid,
        "read_back_mismatch",
        "possible",
      );
    }
    return dependencies.createResult(operation.operation_id, existing.gid, "applied", "applied");
  }

  const creationInput: CreationInput = {
    project_gid: input.project_gid,
    section_gid: expectedStatus(
      operation.after.status ?? "not_started",
      input.section_gids,
    ).section_gid,
    title: operation.after.title,
    completed: false,
    external: {
      gid: expectedExternal.gid,
      data: dependencies.serializeExternal(expectedExternal.data),
    },
    ...(operation.after.notes != null ? { notes: operation.after.notes } : {}),
    ...(operation.after.due?.kind === "due_on"
      ? { due_on: operation.after.due.due_on }
      : {}),
    ...(operation.after.due?.kind === "due_at"
      ? { due_at: operation.after.due.due_at }
      : {}),
  };
  onWriteAttempt("create_task");
  const createdTaskReference = await dependencies.createTask(
    creationInput,
    signal,
  );
  onCreateTaskCreated(operation.operation_id, createdTaskReference.gid);
  const createdReadBack = await dependencies.readCreatedTaskWithProjectionRetry(
    createdTaskReference.gid,
    input,
    operation,
    mappings,
    tags,
    expectedExternal,
    signal,
  );
  if (createdReadBack.kind === "pending") {
    if (createdReadBack.reason === "not_found") {
      throw dependencies.createTaskNotFoundError(
        createdTaskReference.gid,
        createdReadBack.not_found_error,
      );
    }
    return dependencies.createConflictResult(
      operation.operation_id,
      createdTaskReference.gid,
      "read_back_mismatch",
      "possible",
    );
  }
  if (createdReadBack.kind === "conflict") {
    return dependencies.createConflictResult(
      operation.operation_id,
      createdTaskReference.gid,
      createdReadBack.reason_code,
      "possible",
    );
  }
  const created = createdReadBack.task;
  const createdExternal = dependencies.readCurrentExternal(created);
  if (createdExternal.kind === "conflict") {
    return dependencies.externalConflictResult(
      operation.operation_id,
      created.gid,
      createdExternal.reason_code,
      "possible",
    );
  }
  if (createdExternal.value.response.gid !== expectedExternal.gid) {
    return dependencies.externalConflictResult(
      operation.operation_id,
      created.gid,
      "external_identity_mismatch",
      "possible",
    );
  }
  const attributes = await applyCreateAttributes(
    created.gid,
    input,
    operation,
    mappings,
    tags,
    dependencies.expectedExternalWriteGuard(expectedExternal),
    onWriteAttempt,
    signal,
    dependencies,
  );
  if (attributes.kind === "conflict") {
    return dependencies.createConflictResult(
      operation.operation_id,
      created.gid,
      "read_back_mismatch",
      "possible",
    );
  }
  const readBack = await dependencies.readTask(created.gid, signal);
  if (
    classifyCreateCore(
      readBack, input, operation, mappings, tags, dependencies.readBackDependencies,
    ) !== "after"
    || !dependencies.taskExternalMatches(readBack, expectedExternal)
  ) {
    return dependencies.createConflictResult(
      operation.operation_id,
      created.gid,
      "read_back_mismatch",
      "possible",
    );
  }
  return dependencies.createResult(
    operation.operation_id,
    created.gid,
    "applied",
    "applied",
  );
}

async function applyCreateAttributes<
  TInput extends CreateInput,
  TOperation extends CreateOperation,
  TTask extends WriteTask<TTag>,
  TTag extends Tag,
  TData,
  TError,
  TResult,
>(
  taskGid: string,
  input: TInput,
  operation: TOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly TTag[],
  beforeWrite: (task: TTask) => ConflictReason | undefined,
  onWriteAttempt: (action: WriteAction) => void,
  signal: AbortSignal,
  dependencies: CreateTaskWriteDependencies<TInput, TOperation, TTask, TTag, TData, TError, TResult>,
): Promise<CoreWriteResult> {
  let task = await dependencies.readTask(taskGid, signal);
  if (classifyCreateCore(
    task, input, operation, mappings, tags, dependencies.readBackDependencies,
  ) === "conflict") {
    return { kind: "conflict", side_effect: "none" };
  }
  let changed = false;
  const importanceResult = await applyCategoryTag(
    {
      kind: "created_task",
      prefix: dependencies.readBackDependencies.importanceTagPrefix,
      after_name: dependencies.readBackDependencies.importanceTagName(operation.after.importance ?? 3),
    },
    tags,
    async () => await dependencies.readTask(taskGid, signal),
    (tagGid) => dependencies.addTaskTag(taskGid, tagGid, signal),
    (tagGid) => dependencies.removeTaskTag(taskGid, tagGid, signal),
    beforeWrite,
    onWriteAttempt,
  );
  if (importanceResult.kind === "conflict") {
    return {
      kind: "conflict",
      side_effect: importanceResult.side_effect === "possible" || changed
        ? "possible"
        : "none",
    };
  }
  changed = changed || importanceResult.changed;
  const areaResult = await applyCategoryTag(
    {
      kind: "created_task",
      prefix: dependencies.readBackDependencies.areaTagPrefix,
      after_name: dependencies.readBackDependencies.areaTagName(operation.after.area ?? dependencies.readBackDependencies.unclassifiedArea),
    },
    tags,
    async () => await dependencies.readTask(taskGid, signal),
    (tagGid) => dependencies.addTaskTag(taskGid, tagGid, signal),
    (tagGid) => dependencies.removeTaskTag(taskGid, tagGid, signal),
    beforeWrite,
    onWriteAttempt,
  );
  if (areaResult.kind === "conflict") {
    return {
      kind: "conflict",
      side_effect: areaResult.side_effect === "possible" || changed
        ? "possible"
        : "none",
    };
  }
  changed = changed || areaResult.changed;
  const statusResult = await applyStatus(
    input.project_gid,
    expectedStatus("not_started", input.section_gids),
    expectedStatus(operation.after.status ?? "not_started", input.section_gids),
    async () => await dependencies.readTask(taskGid, signal),
    (sectionGid) => dependencies.addTaskToSection(taskGid, sectionGid, signal),
    (completed) => dependencies.updateCompleted(taskGid, completed, signal),
    beforeWrite,
    onWriteAttempt,
  );
  if (statusResult.kind === "conflict") {
    return {
      kind: "conflict",
      side_effect: statusResult.side_effect === "possible" || changed
        ? "possible"
        : "none",
    };
  }
  changed = changed || statusResult.changed;
  const desiredParent = operation.after.parent == null
    ? null
    : dependencies.resolveTargetGid(operation.after.parent, mappings);
  task = await dependencies.readTask(taskGid, signal);
  const currentParent = dependencies.taskParentGid(task);
  if (currentParent !== desiredParent) {
    if (currentParent != null || desiredParent == null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
      };
    }
    const guardReason = beforeWrite(task);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    onWriteAttempt("set_task_parent");
    await dependencies.setTaskParent(taskGid, desiredParent, signal);
    changed = true;
    task = await dependencies.readTask(taskGid, signal);
    if (dependencies.taskParentGid(task) !== desiredParent) {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  return { kind: "completed", changed };
}
