import { z } from "zod";
import {
  AsanaReauthenticationRuntime,
  SetupIpcWorkflow,
  SetupOrchestrator,
  resolveDeviceId,
  type OperationalContext,
} from "../application/settings";
import { settingsContracts } from "../../shared/ipc-contracts/settings";
import type { AsanaSyncCoordinatorResult } from "../infrastructure/asana";
import type { DeviceSettings, SqliteSettingsRepository, SetupCheckpointStore } from "../infrastructure/persistence";
import type { SetupState } from "../domain/setup-state";
import type { SettingsHandlerWorkflows } from "../ipc/handlers/settings";

type AsanaReauthenticationCompleteInput = z.output<typeof settingsContracts.completeAsanaReauthentication.request>;
type AsanaReauthenticationCancelInput = z.output<typeof settingsContracts.cancelAsanaReauthentication.request>;
type AsanaAuthenticationState = Extract<
  z.output<typeof settingsContracts.getAsanaAuthenticationState.response>,
  { kind: "ok" }
>["value"];
type ReauthenticationCompositionOptions = ConstructorParameters<typeof AsanaReauthenticationRuntime<
  DeviceSettings,
  AsanaReauthenticationCompleteInput,
  AsanaReauthenticationCancelInput,
  AsanaAuthenticationState,
  AsanaSyncCoordinatorResult
>>[0];
type SetupIpcCompositionOptions = ConstructorParameters<typeof SetupIpcWorkflow<
  SetupState,
  Parameters<SetupOrchestrator["beginAsanaAuthorization"]>[0],
  Parameters<SetupOrchestrator["completeAsanaAuthorization"]>[0],
  Parameters<SetupOrchestrator["cancelAsanaAuthorization"]>[0],
  Parameters<SetupOrchestrator["selectWorkspace"]>[0],
  Parameters<SetupOrchestrator["selectProject"]>[0],
  Parameters<SetupOrchestrator["chooseVault"]>[0]
>>[0];

export type SettingsCompositionDependencies = {
  readonly settingsRepository: SqliteSettingsRepository<DeviceSettings>;
  readonly checkpoint: SetupCheckpointStore;
  readonly parseState: (value: unknown) => SetupState;
  readonly contextFromState: (state: SetupState) => OperationalContext | undefined;
  readonly parseId: (value: unknown) => string;
  readonly setupPorts: Omit<ConstructorParameters<typeof SetupOrchestrator>[0], "device_id">;
} & ReauthenticationCompositionOptions & Omit<SetupIpcCompositionOptions, "setup" | "parseState">;

/** 初回設定とAsana再認証のworkflowを接続します。 */
export function createSettingsRuntime(
  host: SettingsCompositionDependencies,
  createId: () => string,
): SettingsHandlerWorkflows & {
  readonly setupWorkflow: SetupOrchestrator;
  readonly reauthenticationWorkflow: AsanaReauthenticationRuntime<
    DeviceSettings,
    AsanaReauthenticationCompleteInput,
    AsanaReauthenticationCancelInput,
    AsanaAuthenticationState,
    AsanaSyncCoordinatorResult
  >;
} {
  const setup = new SetupOrchestrator({
    device_id: resolveDeviceId({
      settings: host.settingsRepository,
      loadCheckpoint: () => host.checkpoint.load(),
      parseState: host.parseState,
      contextFromState: host.contextFromState,
      createId,
      parseId: host.parseId,
    }),
    ...host.setupPorts,
  });
  const reauthentication = new AsanaReauthenticationRuntime({
    requireSettings: host.requireSettings,
    validateAbortSignal: host.validateAbortSignal,
    throwIfAborted: host.throwIfAborted,
    parseCompleteInput: host.parseCompleteInput,
    parseCancelInput: host.parseCancelInput,
    readOAuthState: host.readOAuthState,
    beginOAuth: host.beginOAuth,
    completeOAuth: host.completeOAuth,
    cancelOAuth: host.cancelOAuth,
    parseAuthenticationState: host.parseAuthenticationState,
    createInProgressError: host.createInProgressError,
    createAuthorizationIdMismatchError: host.createAuthorizationIdMismatchError,
    createNotPendingError: host.createNotPendingError,
    invalidatePendingMutations: host.invalidatePendingMutations,
    expireExternalAgent: host.expireExternalAgent,
    enqueueContextChange: host.enqueueContextChange,
    configureAsana: host.configureAsana,
    synchronize: host.synchronize,
    restoreContext: host.restoreContext,
  });
  const setupIpc = new SetupIpcWorkflow({
    setup,
    parseState: host.parseState,
    afterTransition: host.afterTransition,
    afterCodexAuthentication: host.afterCodexAuthentication,
    afterVaultChoice: host.afterVaultChoice,
    afterCodexCapability: host.afterCodexCapability,
  });
  return {
    setup: setupIpc.createPort(),
    asana: reauthentication.createPort(),
    setupWorkflow: setup,
    reauthenticationWorkflow: reauthentication,
  };
}
