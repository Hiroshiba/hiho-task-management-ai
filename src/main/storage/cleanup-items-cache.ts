import {
  canonicalizeJson,
  cleanupItemKindSchema,
  cleanupItemsSchema,
  type CleanupItemKind,
} from "../../shared/domain";
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

const cleanupItemKindsSchema = cleanupItemKindSchema
  .array()
  .min(1, "置換対象の要整理種別を一つ以上指定してください。")
  .superRefine((kinds, context) => {
    const seen = new Set<CleanupItemKind>();
    kinds.forEach((kind, index) => {
      if (seen.has(kind)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "同じ要整理種別を重複して指定できません。",
        });
      }
      seen.add(kind);
    });
  });

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 要整理項目を内容で重複排除し、決定的な順序へ整列します。 */
export function aggregateCleanupItems(
  items: readonly CleanupItemsCache[number][],
): CleanupItemsCache {
  const byValue = new Map<string, CleanupItemsCache[number]>();
  for (const item of cleanupItemsSchema.parse(items)) {
    byValue.set(canonicalizeJson(item), item);
  }
  return cleanupItemsCacheSchema.parse(
    [...byValue.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([, item]) => item),
  );
}

/** 指定種別を置換し、それ以外の要整理項目と統合します。 */
export function replaceCleanupItemsByKinds(
  existingItems: readonly CleanupItemsCache[number][],
  kinds: readonly CleanupItemKind[],
  replacementItems: readonly CleanupItemsCache[number][],
): CleanupItemsCache {
  const validatedExistingItems = cleanupItemsCacheSchema.parse(existingItems);
  const validatedKinds = cleanupItemKindsSchema.parse(kinds);
  const validatedReplacementItems = cleanupItemsCacheSchema.parse(
    replacementItems,
  );
  const replacementKindSet = new Set(validatedKinds);
  validatedReplacementItems.forEach((item, index) => {
    if (!replacementKindSet.has(item.kind)) {
      throw new Error(
        `置換項目 ${index} の要整理種別 ${item.kind} は置換対象に含まれていません。`,
      );
    }
  });
  return aggregateCleanupItems([
    ...validatedExistingItems.filter(
      (item) => !replacementKindSet.has(item.kind),
    ),
    ...validatedReplacementItems,
  ]);
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
