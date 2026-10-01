import type {
  DeviceSettingsRecord,
  SettingsRepository,
} from "../common/ports/settings-repository";
import type { SetupState } from "../../domain/setup-state";
import { canonicalizeJson } from "../../domain";

/** 設定完了後に共有するAsanaとCodexの運用文脈です。 */
export type OperationalContext = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly workspace_name: string;
  readonly project_gid: string;
  readonly project_name: string;
  readonly section_gids: DeviceSettingsRecord["section_gids"];
  readonly tag_gids: Extract<SetupState, { kind: "resources_ready" }>["context"]["tag_gids"];
  readonly codex: Extract<SetupState, { kind: "resources_ready" }>["context"]["codex"];
};

/** 初回設定状態から運用文脈を取得します。 */
export function contextFromState(state: SetupState): OperationalContext | undefined {
  switch (state.kind) {
    case "resources_ready":
    case "asana_capability_failed":
    case "vault_choice_required":
    case "full_sync_required":
    case "codex_capability_required":
    case "ready":
      return {
        device_id: state.context.device_id,
        client_id: state.context.client_id,
        workspace_gid: state.context.workspace_gid,
        workspace_name: state.context.workspace_name,
        project_gid: state.context.project_gid,
        project_name: state.context.project_name,
        section_gids: state.context.section_gids,
        tag_gids: state.context.tag_gids,
        codex: state.context.codex,
      };
    default:
      return undefined;
  }
}

/** Asana書き込みが共有する文脈の識別子を作ります。 */
export function asanaOperationContextKey(context: OperationalContext): string {
  return canonicalizeJson({
    device_id: context.device_id,
    client_id: context.client_id,
    workspace_gid: context.workspace_gid,
    project_gid: context.project_gid,
    section_gids: context.section_gids,
    tag_gids: context.tag_gids,
  });
}

/** 初回設定状態からAsanaのOAuthクライアントIDを取得します。 */
export function clientIdFromState(state: SetupState): string | undefined {
  if ("context" in state) return state.context.client_id;
  if ("client_id" in state) return state.client_id;
  return undefined;
}

/** 初回設定状態からCodexの利用可能状態を取得します。 */
export function codexAvailabilityFromState(
  state: SetupState,
): OperationalContext["codex"] | undefined {
  if ("context" in state) return state.context.codex;
  if ("codex" in state) return state.codex;
  return undefined;
}

/** 運用文脈を持つ初回設定状態か判定します。 */
export function isContextState(state: SetupState): boolean {
  return contextFromState(state) != null;
}

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
export type ApplicationState<Settings extends DeviceSettingsRecord = DeviceSettingsRecord> =
  | { readonly kind: "unconfigured"; readonly setup_state: SetupState }
  | { readonly kind: "configured"; readonly setup_state: Extract<SetupState, { kind: "ready" }>; readonly settings: Settings };

export function readSettingsState<Settings extends DeviceSettingsRecord>(dependencies: {
  readonly readSetupState: () => SetupState;
  readonly settings: SettingsRepository<Settings>;
  readonly parseSetupState: (value: unknown) => SetupState;
  readonly parseSettings: (value: unknown) => Settings;
}): ApplicationState<Settings> {
  const setupState = dependencies.parseSetupState(dependencies.readSetupState());
  const settings = dependencies.settings.get();
  if (setupState.kind === "ready" && settings != null) {
    const validatedSettings = dependencies.parseSettings(settings);
    if (!contextMatchesSettings(setupState.context, validatedSettings)) {
      throw new Error("端末設定と初回設定状態が一致しません。");
    }
    return {
      kind: "configured",
      setup_state: setupState,
      settings: validatedSettings,
    };
  }
  return {
    kind: "unconfigured",
    setup_state: setupState,
  };
}
