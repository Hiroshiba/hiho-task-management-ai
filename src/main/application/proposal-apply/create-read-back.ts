import { categoryTags, resolveWorkspaceTag } from "./category-tag-write";
import { expectedStatus } from "./status-write";

type Tag = { readonly gid: string; readonly name: string };
type Target = { readonly kind: "existing"; readonly gid: string }
  | { readonly kind: "temporary"; readonly ref: string };
type Due = { readonly kind: "absent" }
  | { readonly kind: "due_on"; readonly due_on: string }
  | { readonly kind: "due_at"; readonly due_at: string };
type Status = "not_started" | "in_progress";
type SectionGids = {
  readonly not_started: string;
  readonly in_progress: string;
  readonly completed: string;
  readonly withdrawn: string;
};
type CreateOperation = {
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
  readonly section_gids: SectionGids;
};
export type CreateTask<TTag extends Tag> = {
  readonly name: string;
  readonly notes: string;
  readonly completed: boolean;
  readonly external: { readonly gid: string; readonly data: string } | null;
  readonly memberships: readonly {
    readonly project: { readonly gid: string };
    readonly section: { readonly gid: string } | null;
  }[];
  readonly tags: readonly TTag[];
};
type FieldClassification = "before" | "partial" | "after" | "conflict";
type ExternalRead<TData> =
  | { readonly kind: "valid"; readonly value: { readonly response: { readonly gid: string }; readonly data: TData } }
  | { readonly kind: "conflict"; readonly reason_code: "external_unreadable" | "external_identity_mismatch" };
type CreateObservation<TTask> =
  | { readonly kind: "ready"; readonly task: TTask }
  | { readonly kind: "pending"; readonly reason: "projection" }
  | { readonly kind: "conflict"; readonly reason_code: "read_back_mismatch" | "external_unreadable" | "external_identity_mismatch" };

export type CreateReadBackDependencies<TTask extends CreateTask<TTag>, TTag extends Tag, TData> = {
  readonly importanceTagPrefix: string;
  readonly areaTagPrefix: string;
  readonly unclassifiedArea: string;
  readonly importanceTagName: (value: number) => string;
  readonly areaTagName: (value: string) => string;
  readonly taskDueValue: (task: TTask) => Due;
  readonly sameDueValue: (left: Due, right: Due) => boolean;
  readonly resolveTargetGid: (target: Target, mappings: ReadonlyMap<string, string>) => string;
  readonly taskParentGid: (task: TTask) => string | null;
  readonly readCurrentExternal: (task: TTask) => ExternalRead<TData>;
  readonly sameExternalData: (left: TData, right: TData) => boolean;
};

function classifyCreateStaticFields<TTask extends CreateTask<TTag>, TTag extends Tag, TData>(
  task: TTask,
  input: CreateInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly TTag[],
  dependencies: CreateReadBackDependencies<TTask, TTag, TData>,
): FieldClassification {
  if (
    task.name !== operation.after.title
    || task.notes !== (operation.after.notes ?? "")
    || !dependencies.sameDueValue(
      dependencies.taskDueValue(task),
      operation.after.due ?? { kind: "absent" },
    )
  ) {
    return "conflict";
  }
  const importTag = resolveWorkspaceTag(
    dependencies.importanceTagName(operation.after.importance ?? 3),
    tags,
  );
  const areaTag = resolveWorkspaceTag(
    dependencies.areaTagName(operation.after.area ?? dependencies.unclassifiedArea),
    tags,
  );
  const importTags = categoryTags(task, dependencies.importanceTagPrefix);
  const areaTags = categoryTags(task, dependencies.areaTagPrefix);
  const importState: FieldClassification = importTags.length === 0
    ? "before"
    : importTags.length === 1
        && importTags[0]?.gid === importTag.gid
        && importTags[0]?.name === importTag.name
      ? "after"
      : "conflict";
  const areaState: FieldClassification = areaTags.length === 0
    ? "before"
    : areaTags.length === 1
        && areaTags[0]?.gid === areaTag.gid
        && areaTags[0]?.name === areaTag.name
      ? "after"
      : "conflict";
  const expectedParent = operation.after.parent == null
    ? null
    : dependencies.resolveTargetGid(operation.after.parent, mappings);
  const currentParent = dependencies.taskParentGid(task);
  const parentState: FieldClassification = currentParent === expectedParent
    ? "after"
    : currentParent == null && expectedParent != null
      ? "before"
      : "conflict";
  const states = [importState, areaState, parentState];
  if (states.some((state) => state === "conflict")) {
    return "conflict";
  }
  if (states.every((state) => state === "after")) {
    return "after";
  }
  if (states.every((state) => state === "before")) {
    return "before";
  }
  return "partial";
}

/** 作成タスクの属性と状態が適用前後のどちらにあるか判定します。 */
export function classifyCreateCore<TTask extends CreateTask<TTag>, TTag extends Tag, TData>(
  task: TTask,
  input: CreateInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly TTag[],
  dependencies: CreateReadBackDependencies<TTask, TTag, TData>,
): FieldClassification {
  const staticState = classifyCreateStaticFields(
    task,
    input,
    operation,
    mappings,
    tags,
    dependencies,
  );
  if (staticState === "conflict") {
    return "conflict";
  }
  const status = expectedStatus(
    operation.after.status ?? "not_started",
    input.section_gids,
  );
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === input.project_gid,
  );
  if (memberships.length !== 1) {
    return "conflict";
  }
  const membership = memberships[0];
  if (membership == null || membership.section == null) {
    return "conflict";
  }
  const statusState: FieldClassification =
    membership.section.gid === status.section_gid
    && task.completed === status.completed
      ? "after"
      : membership.section.gid === status.section_gid
          && !task.completed
          && status.completed
        ? "partial"
        : "conflict";
  const states = [staticState, statusState];
  if (states.some((state) => state === "conflict")) {
    return "conflict";
  }
  if (states.every((state) => state === "after")) {
    return "after";
  }
  if (states.every((state) => state === "before")) {
    return "before";
  }
  return "partial";
}

/** 作成タスクの読戻しで反映待ちと競合を判定します。 */
export function classifyCreateReadBack<TTask extends CreateTask<TTag>, TTag extends Tag, TData>(
  task: TTask,
  input: CreateInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly TTag[],
  expectedExternal: { readonly gid: string; readonly data: TData },
  dependencies: CreateReadBackDependencies<TTask, TTag, TData>,
): CreateObservation<TTask> {
  const staticState = classifyCreateStaticFields(
    task,
    input,
    operation,
    mappings,
    tags,
    dependencies,
  );
  if (staticState === "conflict") {
    return { kind: "conflict", reason_code: "read_back_mismatch" };
  }
  if (task.completed) {
    return { kind: "conflict", reason_code: "read_back_mismatch" };
  }
  const status = expectedStatus(
    operation.after.status ?? "not_started",
    input.section_gids,
  );
  const externalPending = task.external == null;
  if (!externalPending) {
    const currentExternal = dependencies.readCurrentExternal(task);
    if (currentExternal.kind === "conflict") {
      return currentExternal;
    }
    if (currentExternal.value.response.gid !== expectedExternal.gid) {
      return { kind: "conflict", reason_code: "external_identity_mismatch" };
    }
    if (!dependencies.sameExternalData(currentExternal.value.data, expectedExternal.data)) {
      return { kind: "conflict", reason_code: "read_back_mismatch" };
    }
  }
  const memberships = task.memberships.filter(
    (membership) => membership.project.gid === input.project_gid,
  );
  if (memberships.length > 1) {
    return { kind: "conflict", reason_code: "read_back_mismatch" };
  }
  if (memberships.length === 0) {
    return { kind: "pending", reason: "projection" };
  }
  const membership = memberships[0];
  if (membership == null) {
    throw new Error("作成タスクのプロジェクト所属を取得できません。");
  }
  if (membership.section == null) {
    return { kind: "pending", reason: "projection" };
  }
  if (membership.section.gid !== status.section_gid) {
    return { kind: "conflict", reason_code: "read_back_mismatch" };
  }
  if (externalPending) {
    return { kind: "pending", reason: "projection" };
  }
  return { kind: "ready", task };
}

type RetryObservation<TTask, TError> =
  | CreateObservation<TTask>
  | { readonly kind: "pending"; readonly reason: "not_found"; readonly not_found_error: TError };

/** 作成タスクの投影待ちを定めた回数だけ読み戻します。 */
export async function readCreatedTaskWithProjectionRetry<
  TTask extends CreateTask<TTag>,
  TTag extends Tag,
  TData,
  TError,
>(
  input: CreateInput,
  operation: CreateOperation,
  mappings: ReadonlyMap<string, string>,
  tags: readonly TTag[],
  expectedExternal: { readonly gid: string; readonly data: TData },
  readTask: () => Promise<
    | { readonly kind: "task"; readonly task: TTask }
    | { readonly kind: "not_found"; readonly error: TError }
  >,
  delays: readonly number[],
  wait: (milliseconds: number) => Promise<void>,
  dependencies: CreateReadBackDependencies<TTask, TTag, TData>,
): Promise<RetryObservation<TTask, TError>> {
  let pendingReason: "projection" | "not_found" = "projection";
  let notFoundError: TError | undefined;
  for (
    let observationIndex = 0;
    observationIndex <= delays.length;
    observationIndex += 1
  ) {
    if (observationIndex > 0) {
      const delay = delays[observationIndex - 1];
      if (delay == null) {
        throw new Error("作成タスクの読み戻し待機時間を取得できません。");
      }
      await wait(delay);
    }
    const read = await readTask();
    const observation: RetryObservation<TTask, TError> = read.kind === "not_found"
      ? {
          kind: "pending",
          reason: "not_found",
          not_found_error: read.error,
        }
      : classifyCreateReadBack(
          read.task,
          input,
          operation,
          mappings,
          tags,
          expectedExternal,
          dependencies,
        );
    if (read.kind === "not_found") {
      notFoundError = read.error;
    }
    if (observation.kind !== "pending") {
      return observation;
    }
    pendingReason = observation.reason;
  }
  if (pendingReason === "not_found") {
    if (notFoundError == null) {
      throw new Error("作成タスクの読み戻し失敗原因がありません。");
    }
    return {
      kind: "pending",
      reason: "not_found",
      not_found_error: notFoundError,
    };
  }
  return { kind: "pending", reason: pendingReason };
}
