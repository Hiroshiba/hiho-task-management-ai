import type {
  RankingExclusionReason,
  RankingDetail,
  RankingScoreBreakdown,
  RankingTieBreak,
  SnapshotNormalizationInput,
  SnapshotNormalizationResult,
} from "../../../domain";

type TaskReadTieBreak = Omit<RankingTieBreak, "effective_due_at"> & {
  readonly effective_due_at?: string | undefined;
};

type TaskReadRankingDetail = Omit<
  Pick<RankingDetail, "exclusion_reasons" | "tie_break" | "reason_chips" | "text">,
  "tie_break"
> & { readonly tie_break: TaskReadTieBreak };

/** 読取と同期で使用する保存済みタスクの最小構造です。 */
export type TaskReadTask = {
  readonly gid: string;
  readonly title: string;
  readonly notes: string;
  readonly status: "not_started" | "in_progress" | "completed" | "withdrawn";
  readonly importance: number;
  readonly duration?: {
    readonly value: number;
    readonly unit: "minute" | "hour" | "day" | "week" | "month";
  } | undefined;
  readonly due_on?: string | undefined;
  readonly due_at?: string | undefined;
  readonly area: string;
  readonly block_state: "none" | "partial" | "full";
  readonly section_gid: string;
  readonly parent_work_mode: "children_only" | "has_own_work" | "unknown";
  readonly activity_anchor_on: string;
  readonly dependencies: readonly {
    readonly task_gid: string;
    readonly scope: "partial" | "full";
    readonly source: string;
  }[];
  readonly child_gids: readonly string[];
  readonly parent_gid?: string | undefined;
  readonly obsidian_links: readonly {
    readonly vault_id: string;
    readonly path: string;
    readonly title: string;
    readonly confidence: number;
  }[];
};

/** 読取に必要なAsanaレスポンスだけを表します。 */
export type TaskReadEntry = {
  readonly gid: string;
  readonly task: TaskReadTask;
  readonly cached_at: string;
  readonly custom_external_data?:
    | { readonly status: "valid" | "broken"; readonly raw: string }
    | { readonly status: "unknown_version"; readonly raw: string; readonly schema: number }
    | undefined;
  readonly asana_response: {
    readonly permalink_url: string;
    readonly projects: readonly { readonly gid: string }[];
    readonly memberships: readonly { readonly project: { readonly gid: string } }[];
  };
};

/** 同期結果をSQLiteへ保存するタスクキャッシュです。 */
export type TaskCacheRecord = Omit<TaskReadEntry, "asana_response" | "task"> & {
  readonly asana_response: SnapshotNormalizationInput["tasks"][number];
  readonly task: SnapshotNormalizationResult["tasks"][number];
};

/** 同期結果をSQLiteへ保存するプロジェクト情報です。 */
export type ProjectMetadataRecord = {
  readonly project: { readonly gid: string; readonly name?: string | undefined };
  readonly sections: readonly { readonly gid: string; readonly name: string }[];
  readonly tags: readonly { readonly gid: string; readonly name: string }[];
  readonly cached_at: string;
};

/** 同期結果をSQLiteへ保存する要整理項目です。 */
export type CleanupItemsRecord = SnapshotNormalizationResult["cleanup_items"];

/** 同期で適用するタスクキャッシュ差分です。 */
export type TaskCacheDiffRecord = {
  readonly upsert: readonly TaskCacheRecord[];
  readonly missing_gids: readonly string[];
};

/** 未適用の正規化より前に保存されていたタスクを表します。 */
export type TaskNormalizationBaseline =
  | { readonly kind: "none" }
  | {
      readonly kind: "pending";
      readonly entries: readonly {
        readonly gid: string;
        readonly previous:
          | { readonly kind: "present"; readonly task: TaskCacheRecord["task"] }
          | { readonly kind: "status_unavailable"; readonly task: TaskCacheRecord["task"] }
          | { readonly kind: "absent" };
      }[];
    };

/** 保存と公開に共通する順位キャッシュの構造です。 */
export type TaskReadRanking = {
  readonly app_version: string;
  readonly calculated_at: string;
  readonly ranked_tasks: readonly {
    readonly gid: string;
    readonly rank: number;
    readonly detail: TaskReadRankingDetail;
    readonly score_breakdown: RankingScoreBreakdown;
    readonly release_target_gids: readonly string[];
    readonly reason_chips: readonly string[];
    readonly tie_break: TaskReadTieBreak;
  }[];
  readonly excluded_tasks: readonly {
    readonly gid: string;
    readonly exclusion_reasons: readonly RankingExclusionReason[];
    readonly detail: TaskReadRankingDetail;
    readonly score_breakdown?: RankingScoreBreakdown | undefined;
    readonly release_target_gids: readonly string[];
    readonly reason_chips: readonly string[];
    readonly tie_break: TaskReadTieBreak;
  }[];
};

/** 読取に必要な保存済みプロジェクト情報です。 */
export type TaskReadMetadata = {
  readonly project: { readonly gid: string };
  readonly sections: readonly { readonly gid: string; readonly name: string }[];
  readonly tags: readonly { readonly name: string }[];
  readonly cached_at: string;
};

/** 読取に必要な保存済み同期状態です。 */
export type TaskReadSyncState = {
  readonly project_gid: string;
  readonly events_token?: string | undefined;
  readonly last_successful_sync_at?: string | undefined;
  readonly last_full_sync_at?: string | undefined;
};

/** 読取に必要な要整理項目です。 */
export type TaskReadCleanupItem = {
  readonly kind: string;
  readonly message: string;
  readonly task_gid?: string | undefined;
  readonly related_task_gids?: readonly string[] | undefined;
};

/** 同一SQLite接続上の読取キャッシュを参照するポートです。 */
export interface TaskReadRepository<
  Entry extends TaskReadEntry,
  Metadata extends TaskReadMetadata,
  Ranking extends TaskReadRanking,
  SyncState extends TaskReadSyncState,
  CleanupItem extends TaskReadCleanupItem,
> {
  getTaskCache(): readonly Entry[];
  getProjectMetadataCache(projectGid: string): Metadata | undefined;
  getRankingCache(): Ranking | undefined;
  getSyncState(projectGid: string): SyncState | undefined;
  getCleanupItems(): readonly CleanupItem[] | undefined;
}

/** 要整理項目の読取と種類別置換だけを公開します。 */
export interface CleanupItemsRepository<CleanupItems extends TaskReadCleanupItem[]> {
  getCleanupItems(): CleanupItems | undefined;
  replaceCleanupItemsByKinds(
    kinds: readonly ("proposal_conflict" | "broken_vault_link")[],
    replacementItems: CleanupItems,
  ): CleanupItems;
}

/** Asana同期スナップショットを同じSQLite接続へ保存するポートです。 */
export interface TaskSyncRepository<
  Entry extends TaskReadEntry,
  Metadata extends TaskReadMetadata,
  Ranking extends TaskReadRanking,
  SyncState extends TaskReadSyncState,
  CleanupItems extends TaskReadCleanupItem[],
> extends TaskReadRepository<Entry, Metadata, Ranking, SyncState, CleanupItems[number]> {
  getNormalizationBaseline(projectGid: string): TaskNormalizationBaseline;
  saveSyncSnapshot(
    entries: readonly Entry[],
    metadata: Metadata,
    ranking: Ranking,
    syncState: SyncState,
    cleanupItems: CleanupItems,
    normalizationBaseline: TaskNormalizationBaseline,
  ): void;
}
