import {
  rankingCacheSchema,
  type RankingCache,
} from "../../shared/storage";
import { parseStorageJson, serializeStorageJson } from "./json";
import type { SqliteDatabase } from "./types";

interface RankingCacheRow {
  readonly cache_key: number;
  readonly app_version: string;
  readonly calculated_at: string;
  readonly ranked_tasks_json: string;
  readonly excluded_tasks_json: string;
}

function rowToRankingCache(row: RankingCacheRow): RankingCache {
  if (row.cache_key !== 1) {
    throw new Error("順位キャッシュのキーが不正です。");
  }
  return rankingCacheSchema.parse({
    app_version: row.app_version,
    calculated_at: row.calculated_at,
    ranked_tasks: parseStorageJson(
      row.ranked_tasks_json,
      rankingCacheSchema.shape.ranked_tasks,
    ),
    excluded_tasks: parseStorageJson(
      row.excluded_tasks_json,
      rankingCacheSchema.shape.excluded_tasks,
    ),
  });
}

/** 順位キャッシュのSQLite操作を提供します。 */
export class RankingCacheStore {
  private readonly saveStatement;
  private readonly selectStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.saveStatement = database.prepare<
      [number, string, string, string, string],
      unknown
    >(
      `INSERT INTO ranking_cache (cache_key, app_version, calculated_at, ranked_tasks_json, excluded_tasks_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET
         app_version = excluded.app_version,
         calculated_at = excluded.calculated_at,
         ranked_tasks_json = excluded.ranked_tasks_json,
         excluded_tasks_json = excluded.excluded_tasks_json`,
    );
    this.selectStatement = database.prepare<[], RankingCacheRow>(
      "SELECT cache_key, app_version, calculated_at, ranked_tasks_json, excluded_tasks_json FROM ranking_cache WHERE cache_key = 1",
    );
  }

  /** 順位キャッシュを保存します。 */
  public save(cache: RankingCache): void {
    const validatedCache = rankingCacheSchema.parse(cache);
    this.saveStatement.run(
      1,
      validatedCache.app_version,
      validatedCache.calculated_at,
      serializeStorageJson(validatedCache.ranked_tasks),
      serializeStorageJson(validatedCache.excluded_tasks),
    );
  }

  /** 順位キャッシュを読み出します。 */
  public get(): RankingCache | undefined {
    const row = this.selectStatement.get();
    if (row == null) {
      return undefined;
    }
    return rowToRankingCache(row);
  }
}
