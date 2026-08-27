import { gidSchema } from "../../shared/domain";
import { syncStateSchema, type SyncState } from "../../shared/storage";
import type { SqliteDatabase } from "./types";

interface SyncStateRow {
  readonly project_gid: string;
  readonly events_token: string | null;
  readonly last_successful_sync_at: string | null;
  readonly last_full_sync_at: string | null;
}

function rowToSyncState(row: SyncStateRow): SyncState {
  return syncStateSchema.parse({
    project_gid: row.project_gid,
    ...(row.events_token == null ? {} : { events_token: row.events_token }),
    ...(row.last_successful_sync_at == null
      ? {}
      : { last_successful_sync_at: row.last_successful_sync_at }),
    ...(row.last_full_sync_at == null
      ? {}
      : { last_full_sync_at: row.last_full_sync_at }),
  });
}

/** 同期状態のSQLite操作を提供します。 */
export class SyncStateStore {
  private readonly saveStatement;
  private readonly selectAllStatement;
  private readonly selectOneStatement;

  public constructor(private readonly database: SqliteDatabase) {
    this.saveStatement = database.prepare<
      [string, string | null, string | null, string | null],
      unknown
    >(
      `INSERT INTO sync_state (project_gid, events_token, last_successful_sync_at, last_full_sync_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_gid) DO UPDATE SET
         events_token = excluded.events_token,
         last_successful_sync_at = excluded.last_successful_sync_at,
         last_full_sync_at = excluded.last_full_sync_at`,
    );
    this.selectAllStatement = database.prepare<[], SyncStateRow>(
      "SELECT project_gid, events_token, last_successful_sync_at, last_full_sync_at FROM sync_state ORDER BY project_gid",
    );
    this.selectOneStatement = database.prepare<[string], SyncStateRow>(
      "SELECT project_gid, events_token, last_successful_sync_at, last_full_sync_at FROM sync_state WHERE project_gid = ?",
    );
  }

  /** 同期状態を保存します。 */
  public save(state: SyncState): void {
    const validatedState = syncStateSchema.parse(state);
    this.saveStatement.run(
      validatedState.project_gid,
      validatedState.events_token == null ? null : validatedState.events_token,
      validatedState.last_successful_sync_at == null
        ? null
        : validatedState.last_successful_sync_at,
      validatedState.last_full_sync_at == null ? null : validatedState.last_full_sync_at,
    );
  }

  /** GIDで同期状態を読み出します。 */
  public get(projectGid: string): SyncState | undefined {
    const validatedProjectGid = gidSchema.parse(projectGid);
    const row = this.selectOneStatement.get(validatedProjectGid);
    if (row == null) {
      return undefined;
    }
    return rowToSyncState(row);
  }

  /** 同期状態を全件読み出します。 */
  public getAll(): readonly SyncState[] {
    return this.selectAllStatement.all().map(rowToSyncState);
  }
}
