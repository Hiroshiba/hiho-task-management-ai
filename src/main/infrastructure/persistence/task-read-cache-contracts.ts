import { z } from "zod";
import { gidSchema, taskSchema } from "../../domain";
import type {
  TaskReadCleanupItem,
  TaskReadEntry,
  TaskReadMetadata,
  TaskReadRanking,
  TaskReadSyncState,
  TaskNormalizationBaseline,
} from "../../application/common/ports/task-read-repository";
import type { TaskReadPersistenceContracts } from "./task-read-repository";

type Parser<Value> = { readonly parse: (value: unknown) => Value };
type ExternalDataResult =
  | { readonly kind: "valid"; readonly status: "valid" }
  | { readonly kind: "broken"; readonly status: "broken" }
  | { readonly kind: "unknown_version"; readonly status: "unknown_version"; readonly schema: number };

const normalizationBaselineEntrySchema = z.object({
  gid: gidSchema,
  previous: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("present"), task: taskSchema }).strict(),
    z.object({ kind: z.literal("status_unavailable"), task: taskSchema }).strict(),
    z.object({ kind: z.literal("absent") }).strict(),
  ]),
}).strict().superRefine((entry, context) => {
  if (entry.previous.kind !== "absent" && entry.previous.task.gid !== entry.gid) {
    context.addIssue({
      code: "custom",
      path: ["previous", "task", "gid"],
      message: "正規化基準タスクのGIDが保存対象と一致しません。",
    });
  }
});

const normalizationBaselineSchema: z.ZodType<TaskNormalizationBaseline> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("pending"),
    entries: z.array(normalizationBaselineEntrySchema).superRefine((entries, context) => {
      const seen = new Set<string>();
      entries.forEach((entry, index) => {
        if (seen.has(entry.gid)) {
          context.addIssue({
            code: "custom",
            path: [index, "gid"],
            message: "同じGIDの正規化基準を重複して保存できません。",
          });
        }
        seen.add(entry.gid);
      });
    }),
  }).strict(),
]);

type TaskReadCacheSchemas<
  Entry extends TaskReadEntry,
  Metadata extends TaskReadMetadata,
  Ranking extends TaskReadRanking,
  SyncState extends TaskReadSyncState,
  CleanupItems extends TaskReadCleanupItem[],
  Diff extends { readonly upsert: readonly Entry[]; readonly missing_gids: readonly string[] },
> = {
  readonly gid: Parser<string>;
  readonly entry: Parser<Entry>;
  readonly entries: Parser<readonly Entry[]>;
  readonly diff: Parser<Diff>;
  readonly metadata: Parser<Metadata>;
  readonly ranking: Parser<Ranking>;
  readonly syncState: Parser<SyncState>;
  readonly cleanupItems: Parser<CleanupItems>;
  readonly cleanupKind: z.ZodType<string>;
  readonly parseExternalData: (raw: string) => ExternalDataResult;
  readonly canonicalize: (value: unknown) => string;
};

/** 読取キャッシュの保存値と外部データの整合性を検証する契約を作ります。 */
export function createTaskReadCacheContracts<
  Entry extends TaskReadEntry,
  Metadata extends TaskReadMetadata,
  Ranking extends TaskReadRanking,
  SyncState extends TaskReadSyncState,
  CleanupItems extends TaskReadCleanupItem[],
  Diff extends { readonly upsert: readonly Entry[]; readonly missing_gids: readonly string[] },
>(
  schemas: TaskReadCacheSchemas<Entry, Metadata, Ranking, SyncState, CleanupItems, Diff>,
): TaskReadPersistenceContracts<Entry, Metadata, Ranking, SyncState, CleanupItems, Diff> {
  const cleanupKindsSchema = z.array(schemas.cleanupKind)
    .min(1, "置換対象の要整理種別を一つ以上指定してください。")
    .superRefine((kinds, context) => {
      const seen = new Set<string>();
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
  const parseEntry = (value: unknown): Entry => {
    const entry = schemas.entry.parse(value);
    const externalData = entry.custom_external_data;
    if (externalData != null) {
      const parsed = schemas.parseExternalData(externalData.raw);
      if (parsed.status !== externalData.status) {
        throw new Error("Custom external dataのキャッシュ状態がrawの解析結果と一致しません。");
      }
      if (externalData.status === "unknown_version"
        && (parsed.kind !== "unknown_version" || parsed.schema !== externalData.schema)) {
        throw new Error("Custom external dataのschema versionがrawの解析結果と一致しません。");
      }
    }
    return entry;
  };
  return {
    parseGid: (value) => schemas.gid.parse(value),
    parseEntry,
    parseEntries: (value) => schemas.entries.parse(value),
    parseDiff: (value) => schemas.diff.parse(value),
    parseMetadata: (value) => schemas.metadata.parse(value),
    parseRanking: (value) => schemas.ranking.parse(value),
    parseSyncState: (value) => schemas.syncState.parse(value),
    parseNormalizationBaseline: (value) => normalizationBaselineSchema.parse(value),
    parseCleanupItems: (value) => schemas.cleanupItems.parse(value),
    parseCleanupKinds: (value) => cleanupKindsSchema.parse(value),
    canonicalize: schemas.canonicalize,
  };
}
