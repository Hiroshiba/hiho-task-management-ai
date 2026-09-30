import { z } from "zod";
import {
  asanaTaskResponseSchema,
  canonicalizeJson,
  cleanupItemKindSchema,
  cleanupItemsSchema,
  gidSchema,
  isoDateTimeSchema,
  parseCustomExternalData,
  taskSchema,
  taskTagSchema,
} from "../domain";
import {
  createSyncStateSchema,
  createTaskReadCacheContracts,
  createTaskReadCacheSchemas,
  type TaskReadPersistenceContracts,
} from "../infrastructure/persistence";
import type {
  CleanupItemsRecord,
  ProjectMetadataRecord,
  TaskCacheDiffRecord,
  TaskCacheRecord,
  TaskReadRanking,
} from "../application/common/ports/task-read-repository";

export type SyncState = z.infer<ReturnType<typeof createSyncStateSchema>>;

/** タスク読取のSQLite保存契約を組み立てます。 */
export function createTaskReadPersistenceContracts(rankingCacheSchema: z.ZodType<TaskReadRanking>): TaskReadPersistenceContracts<
  TaskCacheRecord,
  ProjectMetadataRecord,
  TaskReadRanking,
  SyncState,
  CleanupItemsRecord,
  TaskCacheDiffRecord
> {
  const cacheSchemas = createTaskReadCacheSchemas({
    gidSchema,
    asanaTaskResponseSchema,
    taskSchema,
    taskTagSchema,
    isoDateTimeSchema,
  });
  const syncStateSchema = createSyncStateSchema(gidSchema, isoDateTimeSchema);
  return createTaskReadCacheContracts({
    gid: gidSchema,
    entry: cacheSchemas.taskCacheEntrySchema,
    entries: cacheSchemas.taskCacheEntriesSchema,
    diff: cacheSchemas.taskCacheDiffSchema,
    metadata: cacheSchemas.projectMetadataCacheSchema,
    ranking: rankingCacheSchema,
    syncState: syncStateSchema,
    cleanupItems: cleanupItemsSchema,
    cleanupKind: cleanupItemKindSchema,
    parseExternalData: parseCustomExternalData,
    canonicalize: canonicalizeJson,
  });
}
