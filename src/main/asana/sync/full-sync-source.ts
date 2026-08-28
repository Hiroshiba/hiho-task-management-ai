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

export type AsanaFullSyncInput = z.infer<typeof fullSyncInputSchema>;
export type AsanaFullSyncResult = z.infer<typeof fullSyncResultSchema>;

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
  if (!Number.isFinite(currentModifiedAt) || !Number.isFinite(candidateModifiedAt)) {
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
    throw new Error("フル同期のタスク件数が上限を超えました。");
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

    const tasks = new Map<string, AsanaTaskResponse>();
    const subtaskGids = new Set<string>();
    const pendingTaskGids: string[] = [];
    const queuedTaskGids = new Set<string>();
    const expandedTaskGids = new Set<string>();

    for (const task of projectTasks) {
      mergeTaskResponse(tasks, task);
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
        throw new Error("フル同期の探索件数が上限を超えました。");
      }
      if (task.num_subtasks === 0) {
        continue;
      }
      const subtasks = await this.readClient.listSubtasks(task.gid, signal);
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

    const repairedSubtaskGids: string[] = [];
    const taskGids = [...tasks.keys()].sort(compareGids);
    const insertionPosition: AsanaTaskInsertionPosition = { kind: "none" };
    for (const taskGid of taskGids) {
      const task = tasks.get(taskGid);
      if (task == null) {
        throw new Error("Asanaタスクを結果へ追加できません。");
      }
      if (hasProject(task, validatedInput.project_gid)) {
        continue;
      }
      if (!subtaskGids.has(task.gid)) {
        throw new Error("専用プロジェクトに直接所属しないタスクを検出しました。");
      }
      if (!canRepairSubtaskMembership) {
        continue;
      }
      await this.writeClient.addTaskToProject(
        task.gid,
        validatedInput.project_gid,
        validatedInput.section_gids.not_started,
        insertionPosition,
        signal,
      );
      const repairedTask = await this.readClient.getTask(task.gid, signal);
      if (!hasProject(repairedTask, validatedInput.project_gid)) {
        throw new Error("サブタスクの専用プロジェクト所属を確認できません。");
      }
      tasks.set(task.gid, repairedTask);
      repairedSubtaskGids.push(task.gid);
    }

    const sortedTasks = [...tasks.values()].sort((left, right) =>
      compareGids(left.gid, right.gid));
    const sortedRepairedSubtaskGids = [...new Set(repairedSubtaskGids)].sort(compareGids);
    return fullSyncResultSchema.parse({
      project,
      sections,
      workspace_tags: workspaceTags,
      tasks: sortedTasks,
      repaired_subtask_gids: sortedRepairedSubtaskGids,
    });
  }
}
