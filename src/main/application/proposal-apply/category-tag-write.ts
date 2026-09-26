type Tag = {
  readonly gid: string;
  readonly name: string;
};

type TaggedTask<TTag extends Tag> = {
  readonly tags: readonly TTag[];
};

export type CategoryTagTransition =
  | {
      readonly kind: "operation";
      readonly prefix: string;
      readonly before_name: string;
      readonly after_name: string;
      readonly default_before: string | number;
      readonly before_value: string | number;
      readonly after_value: string | number;
    }
  | {
      readonly kind: "created_task";
      readonly prefix: string;
      readonly after_name: string;
    };

type FieldClassification = "before" | "partial" | "after" | "conflict";

type CategoryWriteResult<TReason extends string> =
  | { readonly kind: "completed"; readonly changed: boolean }
  | {
      readonly kind: "conflict";
      readonly side_effect: "none" | "possible";
      readonly reason_code?: TReason;
    };

function validateTaskTags<TTag extends Tag>(task: TaggedTask<TTag>): void {
  const seen = new Set<string>();
  for (const tag of task.tags) {
    if (seen.has(tag.gid)) {
      throw new Error("対象タスクのタグGIDが重複しています。");
    }
    seen.add(tag.gid);
  }
}

/** タスクに付いたカテゴリタグを抽出します。 */
export function categoryTags<TTag extends Tag>(
  task: TaggedTask<TTag>,
  prefix: string,
): readonly TTag[] {
  validateTaskTags(task);
  return task.tags.filter((tag) => tag.name.startsWith(prefix));
}

/** ワークスペース内のカテゴリタグを名前から解決します。 */
export function resolveWorkspaceTag<TTag extends Tag>(
  name: string,
  tags: readonly TTag[],
): TTag {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length !== 1) {
    throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
  }
  const match = matches[0];
  if (match == null) {
    throw new Error("対象タグをワークスペースタグへ解決できません。");
  }
  return match;
}

function optionalWorkspaceTag<TTag extends Tag>(
  name: string,
  tags: readonly TTag[],
): TTag | undefined {
  const matches = tags.filter((tag) => tag.name === name);
  if (matches.length > 1) {
    throw new Error("対象タグ名をワークスペースタグへ一意に解決できません。");
  }
  return matches[0];
}

/** カテゴリタグが変更前後のどちらの状態にあるか判定します。 */
export function classifyCategoryTags<TTag extends Tag>(
  task: TaggedTask<TTag>,
  prefix: string,
  beforeName: string,
  afterName: string,
  defaultBefore: string | number,
  beforeValue: string | number,
  afterValue: string | number,
  tags: readonly TTag[],
): FieldClassification {
  const current = categoryTags(task, prefix);
  const beforeTag = optionalWorkspaceTag(beforeName, tags);
  const afterTag = resolveWorkspaceTag(afterName, tags);
  const beforeIsDefault = beforeValue === defaultBefore && current.length === 0;
  const beforeTagIsExact = beforeTag != null
    && current.length === 1
    && current[0]?.gid === beforeTag.gid
    && current[0]?.name === beforeTag.name;
  const beforeExact = beforeIsDefault || beforeTagIsExact;
  const afterExact = current.length === 1
    && current[0]?.gid === afterTag.gid
    && current[0]?.name === afterTag.name;
  if (beforeValue === afterValue && beforeExact) {
    return "after";
  }
  if (afterExact) {
    return "after";
  }
  if (beforeExact) {
    return "before";
  }
  if (
    beforeTag != null
    && current.length === 2
    && current.some((tag) => tag.gid === beforeTag.gid && tag.name === beforeTag.name)
    && current.some((tag) => tag.gid === afterTag.gid && tag.name === afterTag.name)
  ) {
    return "partial";
  }
  return "conflict";
}

function classifyCategoryTransition<TTag extends Tag>(
  task: TaggedTask<TTag>,
  transition: CategoryTagTransition,
  tags: readonly TTag[],
): FieldClassification {
  if (transition.kind === "operation") {
    return classifyCategoryTags(
      task,
      transition.prefix,
      transition.before_name,
      transition.after_name,
      transition.default_before,
      transition.before_value,
      transition.after_value,
      tags,
    );
  }
  const current = categoryTags(task, transition.prefix);
  const desired = resolveWorkspaceTag(transition.after_name, tags);
  if (
    current.length === 1
    && current[0]?.gid === desired.gid
    && current[0]?.name === desired.name
  ) {
    return "after";
  }
  return current.length === 0 ? "before" : "conflict";
}

/** カテゴリタグを追加、読戻し、旧タグ削除の順で適用します。 */
export async function applyCategoryTag<TTag extends Tag, TTask extends TaggedTask<TTag>, TReason extends string>(
  transition: CategoryTagTransition,
  tags: readonly TTag[],
  readTask: () => Promise<TTask>,
  addTaskTag: (tagGid: string) => Promise<unknown>,
  removeTaskTag: (tagGid: string) => Promise<unknown>,
  beforeWrite: (task: TTask) => TReason | undefined,
  onWriteAttempt: (action: "add_task_tag" | "remove_task_tag") => void,
): Promise<CategoryWriteResult<TReason>> {
  const desired = resolveWorkspaceTag(transition.after_name, tags);
  let changed = false;
  let current = await readTask();
  let state = classifyCategoryTransition(current, transition, tags);
  if (state === "conflict") {
    return { kind: "conflict", side_effect: "none" };
  }
  if (state === "after") {
    return { kind: "completed", changed };
  }
  const currentTags = categoryTags(current, transition.prefix);
  if (!currentTags.some((tag) => tag.gid === desired.gid && tag.name === desired.name)) {
    const guardReason = beforeWrite(current);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    onWriteAttempt("add_task_tag");
    await addTaskTag(desired.gid);
    changed = true;
    current = await readTask();
    state = classifyCategoryTransition(current, transition, tags);
    if (state === "conflict" || state === "before") {
      return { kind: "conflict", side_effect: "possible" };
    }
    if (state === "after") {
      return { kind: "completed", changed };
    }
  }
  current = await readTask();
  state = classifyCategoryTransition(current, transition, tags);
  if (state === "after") {
    return { kind: "completed", changed };
  }
  if (state !== "partial") {
    return { kind: "conflict", side_effect: changed ? "possible" : "none" };
  }
  const obsolete = categoryTags(current, transition.prefix).filter(
    (tag) => tag.gid !== desired.gid,
  );
  for (const tag of obsolete) {
    current = await readTask();
    state = classifyCategoryTransition(current, transition, tags);
    if (state === "after") {
      return { kind: "completed", changed };
    }
    if (state !== "partial") {
      return { kind: "conflict", side_effect: changed ? "possible" : "none" };
    }
    const currentObsolete = categoryTags(current, transition.prefix).find(
      (candidate) => candidate.gid === tag.gid,
    );
    if (currentObsolete == null) {
      return { kind: "conflict", side_effect: changed ? "possible" : "none" };
    }
    const guardReason = beforeWrite(current);
    if (guardReason != null) {
      return {
        kind: "conflict",
        side_effect: changed ? "possible" : "none",
        reason_code: guardReason,
      };
    }
    onWriteAttempt("remove_task_tag");
    await removeTaskTag(currentObsolete.gid);
    changed = true;
    current = await readTask();
    state = classifyCategoryTransition(current, transition, tags);
    if (state !== "after" && state !== "partial") {
      return { kind: "conflict", side_effect: "possible" };
    }
  }
  current = await readTask();
  return classifyCategoryTransition(current, transition, tags) === "after"
    ? { kind: "completed", changed }
    : { kind: "conflict", side_effect: changed ? "possible" : "none" };
}
