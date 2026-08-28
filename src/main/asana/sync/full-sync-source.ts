import { z } from "zod";
import {
  asanaProjectResponseSchema,
  asanaSectionResponseSchema,
  asanaTagResponseSchema,
  asanaTaskResponseSchema,
  canonicalizeJson,
  gidSchema,
  type AsanaTaskResponse,
} from "../../../shared/domain";
import { deviceSectionGidsSchema } from "../../../shared/storage";
import { AsanaReadClient } from "../client/client";
import {
  AsanaTaskWriteClient,
  type AsanaTaskInsertionPosition,
} from "../client/task-write-client";
import { AsanaHttpError } from "../transport";

const maximumTaskCount = 10_000;

const fullSyncInputSchema = z
  .object({
    project_gid: gidSchema,
    section_gids: deviceSectionGidsSchema,
  })
  .strict();

function addSortedUniqueGidIssues(
  gids: readonly string[],
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  let previousGid: string | undefined;
  gids.forEach((gid, index) => {
    if (seen.has(gid)) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "GIDを重複して指定できません。",
      });
    }
    seen.add(gid);
    if (previousGid != null && previousGid >= gid) {
      context.addIssue({
        code: "custom",
        path: [...path, index],
        message: "GID順に並べて指定してください。",
      });
    }
    previousGid = gid;
  });
}

const fullSyncResultSchema = z
  .object({
    project: asanaProjectResponseSchema,
    sections: z.array(asanaSectionResponseSchema),
    workspace_tags: z.array(asanaTagResponseSchema),
    tasks: z.array(asanaTaskResponseSchema),
    repaired_subtask_gids: z.array(gidSchema),
  })
  .strict()
  .superRefine((result, context) => {
    addSortedUniqueGidIssues(
      result.tasks.map((task) => task.gid),
      ["tasks"],
      context,
    );
    addSortedUniqueGidIssues(
      result.repaired_subtask_gids,
      ["repaired_subtask_gids"],
      context,
    );
  });

const affectedSubtreeInputSchema = z
  .object({
    project_gid: gidSchema,
    section_gids: deviceSectionGidsSchema,
    available_section_gids: z.array(gidSchema),
    affected_task_gids: z.array(gidSchema).max(maximumTaskCount),
  })
  .strict()
  .superRefine((input, context) => {
    addSortedUniqueGidIssues(
      input.available_section_gids,
      ["available_section_gids"],
      context,
    );
    addSortedUniqueGidIssues(
      input.affected_task_gids,
      ["affected_task_gids"],
      context,
    );
  });

const affectedSubtreeResultSchema = z
  .object({
    tasks: z.array(asanaTaskResponseSchema).max(maximumTaskCount),
    missing_gids: z.array(gidSchema).max(maximumTaskCount),
    repaired_subtask_gids: z.array(gidSchema).max(maximumTaskCount),
  })
  .strict()
  .superRefine((result, context) => {
    addSortedUniqueGidIssues(
      result.tasks.map((task) => task.gid),
      ["tasks"],
      context,
    );
    addSortedUniqueGidIssues(result.missing_gids, ["missing_gids"], context);
    addSortedUniqueGidIssues(
      result.repaired_subtask_gids,
      ["repaired_subtask_gids"],
      context,
    );
    if (result.tasks.length + result.missing_gids.length > maximumTaskCount) {
      context.addIssue({
        code: "custom",
        message: "差分同期の影響件数が上限を超えています。",
      });
    }
    const taskGids = new Set(result.tasks.map((task) => task.gid));
    result.missing_gids.forEach((gid, index) => {
      if (taskGids.has(gid)) {
        context.addIssue({
          code: "custom",
          path: ["missing_gids", index],
          message: "tasksとmissing_gidsに同じGIDを指定できません。",
        });
      }
    });
  });

export type AsanaFullSyncInput = z.infer<typeof fullSyncInputSchema>;
export type AsanaFullSyncResult = z.infer<typeof fullSyncResultSchema>;
type AsanaAffectedSubtreeInput = z.infer<
  typeof affectedSubtreeInputSchema
>;
type AsanaAffectedSubtreeResult = z.infer<
  typeof affectedSubtreeResultSchema
>;

/** Asanaフル同期の入力を検証するスキーマです。 */
export const asanaFullSyncInputSchema = fullSyncInputSchema;

/** Asanaフル同期の収集結果を検証するスキーマです。 */
export const asanaFullSyncResultSchema = fullSyncResultSchema;

function compareGids(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function hasProject(
  task: AsanaTaskResponse,
  projectGid: string,
): boolean {
  return task.projects.some((project) => project.gid === projectGid);
}

function selectTaskResponse(
  current: AsanaTaskResponse,
  candidate: AsanaTaskResponse,
): AsanaTaskResponse {
  const currentModifiedAt = Date.parse(current.modified_at);
  const candidateModifiedAt = Date.parse(candidate.modified_at);
  if (
    !Number.isFinite(currentModifiedAt)
    || !Number.isFinite(candidateModifiedAt)
  ) {
    throw new Error("Asanaタスクのmodified_atを比較できません。");
  }
  if (currentModifiedAt === candidateModifiedAt) {
    if (canonicalizeJson(current) !== canonicalizeJson(candidate)) {
      throw new Error("同じmodified_atのAsanaタスク応答が一致しません。");
    }
    return current;
  }
  return candidateModifiedAt > currentModifiedAt ? candidate : current;
}

function mergeTaskResponse(
  tasks: Map<string, AsanaTaskResponse>,
  candidate: AsanaTaskResponse,
): AsanaTaskResponse {
  const current = tasks.get(candidate.gid);
  const selected = current == null
    ? candidate
    : selectTaskResponse(current, candidate);
  tasks.set(candidate.gid, selected);
  if (tasks.size > maximumTaskCount) {
    throw new Error("Asanaタスク件数が上限を超えました。");
  }
  return selected;
}

function assertSubtasksBelongToTask(
  task: AsanaTaskResponse,
  subtasks: readonly AsanaTaskResponse[],
): void {
  if (subtasks.length !== task.num_subtasks) {
    throw new Error("Asanaサブタスクの取得件数がnum_subtasksと一致しません。");
  }
  const seenSubtaskGids = new Set<string>();
  for (const subtask of subtasks) {
    if (seenSubtaskGids.has(subtask.gid)) {
      throw new Error("Asanaサブタスク一覧に同じGIDが重複しています。");
    }
    seenSubtaskGids.add(subtask.gid);
    if (subtask.parent == null) {
      throw new Error("Asanaサブタスクの親参照を取得できません。");
    }
    if (subtask.parent.gid !== task.gid) {
      throw new Error("Asanaサブタスクの親参照が探索対象と一致しません。");
    }
  }
}

type CollectedTaskTree = {
  readonly tasks: Map<string, AsanaTaskResponse>;
  readonly subtask_gids: Set<string>;
};

async function collectTaskTree(
  readClient: AsanaReadClient,
  rootTasks: readonly AsanaTaskResponse[],
  signal: AbortSignal,
): Promise<CollectedTaskTree> {
  const tasks = new Map<string, AsanaTaskResponse>();
  const subtaskGids = new Set<string>();
  const pendingTaskGids: string[] = [];
  const queuedTaskGids = new Set<string>();
  const expandedTaskGids = new Set<string>();

  for (const rootTask of rootTasks) {
    const task = mergeTaskResponse(
      tasks,
      asanaTaskResponseSchema.parse(rootTask),
    );
    if (!queuedTaskGids.has(task.gid)) {
      queuedTaskGids.add(task.gid);
      pendingTaskGids.push(task.gid);
    }
  }

  while (pendingTaskGids.length > 0) {
    const taskGid = pendingTaskGids.shift();
    if (taskGid == null) {
      throw new Error("Asanaタスク探索キューの進行を確認できません。");
    }
    if (expandedTaskGids.has(taskGid)) {
      continue;
    }
    const task = tasks.get(taskGid);
    if (task == null) {
      throw new Error("Asanaタスク探索対象を取得できません。");
    }
    expandedTaskGids.add(taskGid);
    if (expandedTaskGids.size > maximumTaskCount) {
      throw new Error("Asanaタスクの探索件数が上限を超えました。");
    }
    if (task.num_subtasks === 0) {
      continue;
    }
    const subtasks = await readClient.listSubtasks(task.gid, signal);
    assertSubtasksBelongToTask(task, subtasks);
    for (const subtask of subtasks) {
      subtaskGids.add(subtask.gid);
      const selectedSubtask = mergeTaskResponse(tasks, subtask);
      if (
        selectedSubtask === subtask
        && selectedSubtask.num_subtasks > 0
        && expandedTaskGids.delete(subtask.gid)
      ) {
        pendingTaskGids.push(subtask.gid);
      }
      if (
        !queuedTaskGids.has(subtask.gid)
        && !expandedTaskGids.has(subtask.gid)
      ) {
        queuedTaskGids.add(subtask.gid);
        pendingTaskGids.push(subtask.gid);
      }
    }
  }
  return { tasks, subtask_gids: subtaskGids };
}

async function repairSubtaskMemberships(
  readClient: AsanaReadClient,
  writeClient: AsanaTaskWriteClient,
  tasks: Map<string, AsanaTaskResponse>,
  subtaskGids: ReadonlySet<string>,
  projectGid: string,
  sectionGid: string,
  repairEnabled: boolean,
  signal: AbortSignal,
): Promise<readonly string[]> {
  const repairedSubtaskGids: string[] = [];
  const insertionPosition: AsanaTaskInsertionPosition = { kind: "none" };
  for (const taskGid of [...tasks.keys()].sort(compareGids)) {
    const task = tasks.get(taskGid);
    if (task == null) {
      throw new Error("Asanaタスクを専用プロジェクト所属確認へ追加できません。");
    }
    if (hasProject(task, projectGid)) {
      continue;
    }
    if (!subtaskGids.has(task.gid)) {
      throw new Error("専用プロジェクトに直接所属しないタスクを検出しました。");
    }
    if (!repairEnabled) {
      continue;
    }
    await writeClient.addTaskToProject(
      task.gid,
      projectGid,
      sectionGid,
      insertionPosition,
      signal,
    );
    const repairedTask = await readClient.getTask(task.gid, signal);
    if (repairedTask.gid !== task.gid) {
      throw new Error("再取得したサブタスクGIDが対象と一致しません。");
    }
    if (!hasProject(repairedTask, projectGid)) {
      throw new Error("サブタスクの専用プロジェクト所属を確認できません。");
    }
    tasks.set(task.gid, asanaTaskResponseSchema.parse(repairedTask));
    repairedSubtaskGids.push(task.gid);
  }
  return [...new Set(repairedSubtaskGids)].sort(compareGids);
}

type FetchedAffectedTasks = {
  readonly tasks: Map<string, AsanaTaskResponse>;
  readonly missing_gids: Set<string>;
};

async function fetchAffectedTasksAndAncestors(
  readClient: AsanaReadClient,
  affectedTaskGids: readonly string[],
  projectGid: string,
  signal: AbortSignal,
): Promise<FetchedAffectedTasks> {
  const tasks = new Map<string, AsanaTaskResponse>();
  const missingGids = new Set<string>();
  const pendingTaskGids = [...affectedTaskGids];
  const requestedTaskGids = new Set(affectedTaskGids);
  while (pendingTaskGids.length > 0) {
    const taskGid = pendingTaskGids.shift();
    if (taskGid == null) {
      throw new Error("Asana影響タスク取得キューを進行できません。");
    }
    let task: AsanaTaskResponse;
    try {
      task = await readClient.getTask(taskGid, signal);
    } catch (error) {
      if (error instanceof AsanaHttpError && error.status === 404) {
        missingGids.add(taskGid);
        continue;
      }
      throw error;
    }
    if (task.gid !== taskGid) {
      throw new Error("Asanaタスクの取得GIDが要求と一致しません。");
    }
    const parsedTask = asanaTaskResponseSchema.parse(task);
    tasks.set(parsedTask.gid, parsedTask);
    if (
      hasProject(parsedTask, projectGid)
      || parsedTask.parent == null
      || requestedTaskGids.has(parsedTask.parent.gid)
    ) {
      continue;
    }
    requestedTaskGids.add(parsedTask.parent.gid);
    if (requestedTaskGids.size > maximumTaskCount) {
      throw new Error("差分同期の影響件数が上限を超えました。");
    }
    pendingTaskGids.push(parsedTask.parent.gid);
  }
  return { tasks, missing_gids: missingGids };
}

/** Asanaからフル同期用の生スナップショットを収集します。 */
export class AsanaFullSyncSource {
  private readonly readClient: AsanaReadClient;
  private readonly writeClient: AsanaTaskWriteClient;

  public constructor(
    readClient: AsanaReadClient,
    writeClient: AsanaTaskWriteClient,
  ) {
    this.readClient = readClient;
    this.writeClient = writeClient;
  }

  /** 差分同期で影響したタスクと子孫を収集して所属を整合化します。 */
  public async collectAffectedSubtrees(
    input: AsanaAffectedSubtreeInput,
    signal: AbortSignal,
  ): Promise<AsanaAffectedSubtreeResult> {
    const validatedInput = affectedSubtreeInputSchema.parse(input);
    const fetched = await fetchAffectedTasksAndAncestors(
      this.readClient,
      validatedInput.affected_task_gids,
      validatedInput.project_gid,
      signal,
    );
    const includedTaskGids = new Set(
      [...fetched.tasks.values()]
        .filter((task) => hasProject(task, validatedInput.project_gid))
        .map((task) => task.gid),
    );
    let includedTaskFound = true;
    while (includedTaskFound) {
      includedTaskFound = false;
      for (const task of fetched.tasks.values()) {
        if (
          includedTaskGids.has(task.gid)
          || task.parent == null
          || !includedTaskGids.has(task.parent.gid)
        ) {
          continue;
        }
        includedTaskGids.add(task.gid);
        includedTaskFound = true;
      }
    }

    const rootTasks: AsanaTaskResponse[] = [];
    for (const task of fetched.tasks.values()) {
      if (includedTaskGids.has(task.gid)) {
        rootTasks.push(task);
      } else {
        fetched.missing_gids.add(task.gid);
      }
    }
    const collection = await collectTaskTree(
      this.readClient,
      rootTasks,
      signal,
    );
    const availableSectionGids = new Set(
      validatedInput.available_section_gids,
    );
    const canRepairSubtaskMembership = Object.values(
      validatedInput.section_gids,
    ).every((sectionGid) => availableSectionGids.has(sectionGid));
    const repairedSubtaskGids = await repairSubtaskMemberships(
      this.readClient,
      this.writeClient,
      collection.tasks,
      collection.subtask_gids,
      validatedInput.project_gid,
      validatedInput.section_gids.not_started,
      canRepairSubtaskMembership,
      signal,
    );
    return affectedSubtreeResultSchema.parse({
      tasks: [...collection.tasks.values()].sort((left, right) =>
        compareGids(left.gid, right.gid)),
      missing_gids: [...fetched.missing_gids].sort(compareGids),
      repaired_subtask_gids: repairedSubtaskGids,
    });
  }

  /** 指定プロジェクトのフル同期用データを収集します。 */
  public async collect(
    input: AsanaFullSyncInput,
    signal: AbortSignal,
  ): Promise<AsanaFullSyncResult> {
    const validatedInput = fullSyncInputSchema.parse(input);
    const project = await this.readClient.getProject(
      validatedInput.project_gid,
      signal,
    );
    if (project.gid !== validatedInput.project_gid) {
      throw new Error("取得したAsanaプロジェクトが入力と一致しません。");
    }
    const projectTasks = await this.readClient.listProjectTasks(
      validatedInput.project_gid,
      signal,
    );
    const sections = await this.readClient.listProjectSections(
      validatedInput.project_gid,
      signal,
    );
    const availableSectionGids = new Set(
      sections.map((section) => section.gid),
    );
    const canRepairSubtaskMembership = Object.values(
      validatedInput.section_gids,
    ).every((sectionGid) => availableSectionGids.has(sectionGid));
    const workspaceTags = await this.readClient.listWorkspaceTags(
      project.workspace.gid,
      signal,
    );
    const collection = await collectTaskTree(
      this.readClient,
      projectTasks,
      signal,
    );
    const repairedSubtaskGids = await repairSubtaskMemberships(
      this.readClient,
      this.writeClient,
      collection.tasks,
      collection.subtask_gids,
      validatedInput.project_gid,
      validatedInput.section_gids.not_started,
      canRepairSubtaskMembership,
      signal,
    );
    const sortedTasks = [...collection.tasks.values()].sort((left, right) =>
      compareGids(left.gid, right.gid));
    return fullSyncResultSchema.parse({
      project,
      sections,
      workspace_tags: workspaceTags,
      tasks: sortedTasks,
      repaired_subtask_gids: repairedSubtaskGids,
    });
  }
}
