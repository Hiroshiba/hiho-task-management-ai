import {
  cleanupItemsCacheSchema,
  type CleanupItemsCache,
} from "../../shared/storage";
import { parseStorageJson, serializeStorageJson } from "./json";
import type { SqliteDatabase } from "./types";

interface CleanupItemsCacheRow {
  readonly cache_key: number;
  readonly cleanup_items_json: string;
}

function rowToCleanupItems(row: CleanupItemsCacheRow): CleanupItemsCache {
  if (row.cache_key !== 1) {
    throw new Error("要整理キャッシュのキーが不正です。");
  }
  return parseStorageJson(row.cleanup_items_json, cleanupItemsCacheSchema);
}

/** 要整理項目キャッシュのSQLite操作を提供します。 */
export class CleanupItemsCacheStore {
  private readonly saveStatement;
  private readonly selectStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.saveStatement = database.prepare<[number, string], unknown>(
      `INSERT INTO cleanup_items_cache (cache_key, cleanup_items_json)
       VALUES (?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         cleanup_items_json = excluded.cleanup_items_json`,
    );
    this.selectStatement = database.prepare<[], CleanupItemsCacheRow>(
      "SELECT cache_key, cleanup_items_json FROM cleanup_items_cache WHERE cache_key = 1",
    );
  }

  /** 要整理項目キャッシュを保存します。 */
  public save(items: CleanupItemsCache): void {
    const validatedItems = cleanupItemsCacheSchema.parse(items);
    this.saveStatement.run(1, serializeStorageJson(validatedItems));
  }

  /** 要整理項目キャッシュを読み出します。 */
  public get(): CleanupItemsCache | undefined {
    const row = this.selectStatement.get();
    if (row == null) {
      return undefined;
    }
    return rowToCleanupItems(row);
  }
}
