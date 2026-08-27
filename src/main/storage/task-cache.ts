import {
  asanaTaskResponseSchema,
  gidSchema,
  parseCustomExternalData,
  taskSchema,
} from "../../shared/domain";
import {
  customExternalDataCacheSchema,
  taskCacheDiffSchema,
  taskCacheEntriesSchema,
  taskCacheEntrySchema,
  type CustomExternalDataCache,
  type TaskCacheDiff,
  type TaskCacheEntry,
} from "../../shared/storage";
import { parseStorageJson, serializeStorageJson } from "./json";
import type { SqliteDatabase } from "./types";

interface TaskCacheRow {
  readonly gid: string;
  readonly asana_response_json: string;
  readonly task_json: string;
  readonly custom_external_data_json: string | null;
  readonly cached_at: string;
}

function validateCustomExternalDataCache(value: CustomExternalDataCache): void {
  const parsed = parseCustomExternalData(value.raw);
  if (parsed.status !== value.status) {
    throw new Error("Custom external dataのキャッシュ状態がrawの解析結果と一致しません。");
  }
  if (value.status === "unknown_version") {
    if (parsed.kind !== "unknown_version" || parsed.schema !== value.schema) {
      throw new Error("Custom external dataのschema versionがrawの解析結果と一致しません。");
    }
  }
}

function validateTaskCacheEntry(entry: TaskCacheEntry): TaskCacheEntry {
  if (entry.custom_external_data != null) {
    validateCustomExternalDataCache(entry.custom_external_data);
  }
  return entry;
}

function rowToTaskCacheEntry(row: TaskCacheRow): TaskCacheEntry {
  const entry = {
    gid: row.gid,
    asana_response: parseStorageJson(row.asana_response_json, asanaTaskResponseSchema),
    task: parseStorageJson(row.task_json, taskSchema),
    cached_at: row.cached_at,
  };
  if (row.custom_external_data_json == null) {
    return validateTaskCacheEntry(taskCacheEntrySchema.parse(entry));
  }

  return validateTaskCacheEntry(taskCacheEntrySchema.parse({
    ...entry,
    custom_external_data: parseStorageJson(
      row.custom_external_data_json,
      customExternalDataCacheSchema,
    ),
  }));
}

/** タスクキャッシュのSQLite操作を提供します。 */
export class TaskCacheStore {
  private readonly deleteAllStatement;
  private readonly deleteByGidStatement;
  private readonly insertStatement;
  private readonly upsertStatement;
  private readonly selectAllStatement;
  private readonly selectOneStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.deleteAllStatement = database.prepare<[], unknown>("DELETE FROM task_cache");
    this.deleteByGidStatement = database.prepare<[string], unknown>(
      "DELETE FROM task_cache WHERE gid = ?",
    );
    this.insertStatement = database.prepare<
      [string, string, string, string | null, string],
      unknown
    >(
      "INSERT INTO task_cache (gid, asana_response_json, task_json, custom_external_data_json, cached_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.upsertStatement = database.prepare<
      [string, string, string, string | null, string],
      unknown
    >(
      `INSERT INTO task_cache (gid, asana_response_json, task_json, custom_external_data_json, cached_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(gid) DO UPDATE SET
         asana_response_json = excluded.asana_response_json,
         task_json = excluded.task_json,
         custom_external_data_json = excluded.custom_external_data_json,
         cached_at = excluded.cached_at`,
    );
    this.selectAllStatement = database.prepare<[], TaskCacheRow>(
      "SELECT gid, asana_response_json, task_json, custom_external_data_json, cached_at FROM task_cache ORDER BY gid",
    );
    this.selectOneStatement = database.prepare<[string], TaskCacheRow>(
      "SELECT gid, asana_response_json, task_json, custom_external_data_json, cached_at FROM task_cache WHERE gid = ?",
    );
  }

  /** タスクキャッシュを一つのトランザクションで全件置換します。 */
  public replace(entries: readonly TaskCacheEntry[]): void {
    const validatedEntries = taskCacheEntriesSchema.parse(entries).map(validateTaskCacheEntry);
    const replace = this.database.transaction((records: TaskCacheEntry[]) => {
      this.deleteAllStatement.run();
      records.forEach((entry) => {
        const externalData = entry.custom_external_data == null
          ? null
          : serializeStorageJson(entry.custom_external_data);
        this.insertStatement.run(
          entry.gid,
          serializeStorageJson(entry.asana_response),
          serializeStorageJson(entry.task),
          externalData,
          entry.cached_at,
        );
      });
    });
    replace(validatedEntries);
  }

  /** タスクキャッシュの差分を一つのトランザクションで適用します。 */
  public applyDiff(diff: TaskCacheDiff): void {
    const validatedDiff = taskCacheDiffSchema.parse(diff);
    const validatedEntries = validatedDiff.upsert.map(validateTaskCacheEntry);
    const diffToApply: TaskCacheDiff = {
      upsert: validatedEntries,
      missing_gids: validatedDiff.missing_gids,
    };
    const apply = this.database.transaction((records: TaskCacheDiff) => {
      records.upsert.forEach((entry) => {
        const externalData = entry.custom_external_data == null
          ? null
          : serializeStorageJson(entry.custom_external_data);
        this.upsertStatement.run(
          entry.gid,
          serializeStorageJson(entry.asana_response),
          serializeStorageJson(entry.task),
          externalData,
          entry.cached_at,
        );
      });
      records.missing_gids.forEach((gid) => {
        this.deleteByGidStatement.run(gid);
      });
    });
    apply(diffToApply);
  }

  /** タスクキャッシュを全件読み出します。 */
  public getAll(): readonly TaskCacheEntry[] {
    return this.selectAllStatement.all().map(rowToTaskCacheEntry);
  }

  /** GIDでタスクキャッシュを一件読み出します。 */
  public get(gid: string): TaskCacheEntry | undefined {
    const validatedGid = gidSchema.parse(gid);
    const row = this.selectOneStatement.get(validatedGid);
    if (row == null) {
      return undefined;
    }
    return rowToTaskCacheEntry(row);
  }
}
