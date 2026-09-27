import type {
  DeviceSettingsRecord,
  SettingsRepository,
} from "../common/ports/settings-repository";

type ConfiguredContext = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly project_gid: string;
  readonly section_gids: DeviceSettingsRecord["section_gids"];
};

/** 保存済み設定と運用文脈が同じ対象を指すか調べます。 */
export function contextMatchesSettings(
  context: ConfiguredContext,
  settings: DeviceSettingsRecord,
): boolean {
  return context.device_id === settings.device_id
    && context.client_id === settings.client_id
    && context.workspace_gid === settings.workspace_gid
    && context.project_gid === settings.project_gid
    && context.section_gids.not_started === settings.section_gids.not_started
    && context.section_gids.in_progress === settings.section_gids.in_progress
    && context.section_gids.completed === settings.section_gids.completed
    && context.section_gids.withdrawn === settings.section_gids.withdrawn;
}

/** 保存済み設定または初回設定から端末IDを求めます。 */
export function resolveDeviceId<State extends { readonly kind: string }>(dependencies: {
  readonly settings: SettingsRepository<DeviceSettingsRecord>;
  readonly loadCheckpoint: () => State | undefined;
  readonly parseState: (value: unknown) => State;
  readonly contextFromState: (state: State) => { readonly device_id: string } | undefined;
  readonly createId: () => string;
  readonly parseId: (value: unknown) => string;
}): string {
  const settings = dependencies.settings.get();
  if (settings != null) {
    return dependencies.parseId(settings.device_id);
  }
  const checkpointState = dependencies.loadCheckpoint();
  if (checkpointState != null) {
    const context = dependencies.contextFromState(dependencies.parseState(checkpointState));
    if (context != null) {
      return dependencies.parseId(context.device_id);
    }
  }
  return dependencies.parseId(dependencies.createId());
}

/** 初回設定と端末設定から公開する設定状態を生成します。 */
export function readSettingsState<
  State extends { readonly kind: string },
  Settings extends DeviceSettingsRecord,
  ApplicationState,
>(dependencies: {
  readonly readSetupState: () => State;
  readonly settings: SettingsRepository<Settings>;
  readonly parseSetupState: (value: unknown) => State;
  readonly parseSettings: (value: unknown) => Settings;
  readonly parseApplicationState: (value: unknown) => ApplicationState;
}): ApplicationState {
  const setupState = dependencies.parseSetupState(dependencies.readSetupState());
  const settings = dependencies.settings.get();
  if (setupState.kind === "ready" && settings != null) {
    return dependencies.parseApplicationState({
      kind: "configured",
      setup_state: setupState,
      settings: dependencies.parseSettings(settings),
    });
  }
  return dependencies.parseApplicationState({
    kind: "unconfigured",
    setup_state: setupState,
  });
}
