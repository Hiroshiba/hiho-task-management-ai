import {
  asanaSnapshotNormalizationInputSchema,
  ingestAsanaExternalData,
  normalizeAsanaSnapshot,
  type SnapshotNormalizationInput,
  type SnapshotNormalizationResult,
} from "../../domain";
import type {
  ProjectMetadataRecord,
  TaskCacheRecord,
  TaskReadSyncState,
} from "../../application/common/ports/task-read-repository";
import { compareStrings, sortedTasks } from "./sync-normalization";

type AsanaTaskResponse = SnapshotNormalizationInput["tasks"][number];
type ProjectMetadataSource = Omit<ProjectMetadataRecord, "cached_at">;

/** Asanaのプロジェクト情報を保存前の形式へ正規化します。 */
export function createProjectMetadataSource(
  project: ProjectMetadataRecord["project"],
  sections: readonly ProjectMetadataRecord["sections"][number][],
  tags: readonly ProjectMetadataRecord["tags"][number][],
): ProjectMetadataSource {
  return {
    project: {
      gid: project.gid,
      ...(project.name == null ? {} : { name: project.name }),
    },
    sections: [...sections]
      .map((section) => ({ gid: section.gid, name: section.name }))
      .sort((left, right) => compareStrings(left.gid, right.gid)),
    tags: [...tags]
      .map((tag) => ({ gid: tag.gid, name: tag.name }))
      .sort((left, right) => compareStrings(left.gid, right.gid)),
  };
}

/** Asanaのプロジェクト情報を保存形式で検証します。 */
export function createProjectMetadataCache(
  source: ProjectMetadataSource,
  cachedAt: string,
  parseMetadata: (value: unknown) => ProjectMetadataRecord,
): ProjectMetadataRecord {
  return parseMetadata({
    ...source,
    cached_at: cachedAt,
  });
}

/** 差分を保存済みAsanaタスクへ統合します。 */
export function mergeDeltaTasks(
  baseTasks: readonly AsanaTaskResponse[],
  result: {
    readonly missing_gids: readonly string[];
    readonly upsert: readonly AsanaTaskResponse[];
  },
): AsanaTaskResponse[] {
  const tasks = new Map<string, AsanaTaskResponse>();
  for (const task of baseTasks) {
    const parsedTask = asanaSnapshotNormalizationInputSchema.shape.tasks.element.parse(task);
    tasks.set(parsedTask.gid, parsedTask);
  }
  for (const gid of result.missing_gids) {
    tasks.delete(gid);
  }
  for (const task of result.upsert) {
    const parsedTask = asanaSnapshotNormalizationInputSchema.shape.tasks.element.parse(task);
    if (parsedTask.gid !== task.gid) {
      throw new Error("差分同期タスクのGIDを確認できません。");
    }
    tasks.set(parsedTask.gid, parsedTask);
  }
  return sortedTasks([...tasks.values()]);
}

function buildCustomExternalDataCache(
  task: AsanaTaskResponse,
): TaskCacheRecord["custom_external_data"] {
  if (task.external == null) {
    return undefined;
  }
  const ingestion = ingestAsanaExternalData(task);
  switch (ingestion.kind) {
    case "missing":
      throw new Error("外部データの取込結果がAsana応答と一致しません。");
    case "valid":
      return { status: "valid", raw: task.external.data };
    case "broken":
      return { status: "broken", raw: task.external.data };
    case "identity_mismatch":
      return undefined;
    case "unknown_version":
      return {
        status: "unknown_version",
        raw: task.external.data,
        schema: ingestion.schema,
      };
  }
}

/** 正規化結果とAsana応答を保存用タスクキャッシュへ対応付けます。 */
export function createTaskCacheEntries(
  rawTasks: readonly AsanaTaskResponse[],
  normalization: SnapshotNormalizationResult,
  cachedAt: string,
  parseEntries: (value: unknown) => readonly TaskCacheRecord[],
): readonly TaskCacheRecord[] {
  const normalizedByGid = new Map(
    normalization.tasks.map((task) => [task.gid, task]),
  );
  const entries = sortedTasks(rawTasks).map((rawTask) => {
    const task = normalizedByGid.get(rawTask.gid);
    if (task == null) {
      throw new Error("正規化済みタスクをキャッシュへ対応付けできません。");
    }
    const customExternalData = buildCustomExternalDataCache(rawTask);
    const entry = {
      gid: rawTask.gid,
      asana_response: rawTask,
      task,
      cached_at: cachedAt,
      ...(customExternalData == null
        ? {}
        : { custom_external_data: customExternalData }),
    };
    return entry;
  });
  return parseEntries(entries);
}

/** 保存用の同期状態を作成します。 */
export function createSyncState(
  projectGid: string,
  eventsToken: string | undefined,
  lastFullSyncedAt: string | undefined,
  syncedAt: string,
  parseSyncState: (value: unknown) => TaskReadSyncState,
): TaskReadSyncState {
  return parseSyncState({
    project_gid: projectGid,
    ...(eventsToken == null ? {} : { events_token: eventsToken }),
    last_successful_sync_at: syncedAt,
    ...(lastFullSyncedAt == null
      ? {}
      : { last_full_sync_at: lastFullSyncedAt }),
  });
}

/** Asana応答と前回状態から同期スナップショットを正規化します。 */
export function normalizeSnapshot(
  projectGid: string,
  sectionGids: SnapshotNormalizationInput["section_gids"],
  rawTasks: readonly AsanaTaskResponse[],
  previousTasks: readonly SnapshotNormalizationResult["tasks"][number][],
  activityBaselineTasks: readonly SnapshotNormalizationResult["tasks"][number][],
  inaccessibleGids: readonly string[],
  activityDate: string,
): SnapshotNormalizationResult {
  return normalizeAsanaSnapshot({
    project_gid: projectGid,
    section_gids: sectionGids,
    activity_date: activityDate,
    tasks: sortedTasks(rawTasks),
    previous_tasks: [...previousTasks],
    activity_baseline_tasks: [...activityBaselineTasks],
    inaccessible_gids: [...inaccessibleGids],
  });
}
