import type {
  DeviceSettingsRecord,
  SettingsRepository,
} from "../../application/common/ports/settings-repository";
import type { SqliteConnection } from "./sqlite-connection";

type DeviceSettingsRow = {
  readonly settings_key: number;
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly project_gid: string;
  readonly not_started_section_gid: string;
  readonly in_progress_section_gid: string;
  readonly completed_section_gid: string;
  readonly withdrawn_section_gid: string;
};

/** 端末設定を既存のSQLite接続へ保存します。 */
export class SqliteSettingsRepository<Settings extends DeviceSettingsRecord>
implements SettingsRepository<Settings> {
  private readonly clearStatement;
  private readonly saveStatement;
  private readonly selectStatement;

  public constructor(
    database: SqliteConnection,
    private readonly parseSettings: (value: unknown) => Settings,
  ) {
    this.clearStatement = database.prepare<[], unknown>(
      "DELETE FROM device_settings WHERE settings_key = 1",
    );
    this.saveStatement = database.prepare<
      [number, string, string, string, string, string, string, string, string],
      unknown
    >(
      `INSERT INTO device_settings
         (settings_key, device_id, client_id, workspace_gid, project_gid, not_started_section_gid, in_progress_section_gid, completed_section_gid, withdrawn_section_gid)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(settings_key) DO UPDATE SET
         device_id = excluded.device_id,
         client_id = excluded.client_id,
         workspace_gid = excluded.workspace_gid,
         project_gid = excluded.project_gid,
         not_started_section_gid = excluded.not_started_section_gid,
         in_progress_section_gid = excluded.in_progress_section_gid,
         completed_section_gid = excluded.completed_section_gid,
         withdrawn_section_gid = excluded.withdrawn_section_gid`,
    );
    this.selectStatement = database.prepare<[], DeviceSettingsRow>(
      "SELECT settings_key, device_id, client_id, workspace_gid, project_gid, not_started_section_gid, in_progress_section_gid, completed_section_gid, withdrawn_section_gid FROM device_settings WHERE settings_key = 1",
    );
  }

  /** 端末設定を保存します。 */
  public save(settings: Settings): void {
    const validated = this.parseSettings(settings);
    this.saveStatement.run(
      1,
      validated.device_id,
      validated.client_id,
      validated.workspace_gid,
      validated.project_gid,
      validated.section_gids.not_started,
      validated.section_gids.in_progress,
      validated.section_gids.completed,
      validated.section_gids.withdrawn,
    );
  }

  /** 端末設定を読み出します。 */
  public get(): Settings | undefined {
    const row = this.selectStatement.get();
    if (row == null) {
      return undefined;
    }
    if (row.settings_key !== 1) {
      throw new Error("端末設定のキーが不正です。");
    }
    return this.parseSettings({
      device_id: row.device_id,
      client_id: row.client_id,
      workspace_gid: row.workspace_gid,
      project_gid: row.project_gid,
      section_gids: {
        not_started: row.not_started_section_gid,
        in_progress: row.in_progress_section_gid,
        completed: row.completed_section_gid,
        withdrawn: row.withdrawn_section_gid,
      },
    });
  }

  /** 端末設定を削除します。 */
  public clear(): void {
    this.clearStatement.run();
  }
}
