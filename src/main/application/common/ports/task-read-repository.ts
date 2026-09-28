import type { RankingScoreBreakdown, RankingTieBreak } from "../../../domain";

type TaskReadTieBreak = Omit<RankingTieBreak, "effective_due_at"> & {
  readonly effective_due_at?: string | undefined;
};

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

/** 読取に必要な順位結果の構造です。 */
export type TaskReadRanking = {
  readonly app_version: string;
  readonly calculated_at: string;
  readonly ranked_tasks: readonly {
    readonly gid: string;
    readonly rank: number;
    readonly detail: { readonly text: string; readonly exclusion_reasons: readonly { readonly code: string }[] };
    readonly score_breakdown: RankingScoreBreakdown;
    readonly release_target_gids: readonly string[];
    readonly reason_chips: readonly string[];
    readonly tie_break: TaskReadTieBreak;
  }[];
  readonly excluded_tasks: readonly {
    readonly gid: string;
    readonly exclusion_reasons: readonly { readonly code: string }[];
    readonly detail: { readonly text: string; readonly exclusion_reasons: readonly { readonly code: string }[] };
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
  saveSyncSnapshot(
    entries: readonly Entry[],
    metadata: Metadata,
    ranking: Ranking,
    syncState: SyncState,
    cleanupItems: CleanupItems,
  ): void;
}
