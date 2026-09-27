/** 秘密情報を含まない端末設定の形です。 */
export type DeviceSettingsRecord = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly project_gid: string;
  readonly section_gids: {
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  };
};

/** 端末設定の保存と取得に使うportです。 */
export type SettingsRepository<Settings extends DeviceSettingsRecord> = {
  readonly save: (settings: Settings) => void;
  readonly get: () => Settings | undefined;
  readonly clear: () => void;
};
