import {
  AsanaReauthenticationRuntime,
  SetupIpcWorkflow,
  SetupOrchestrator,
  resolveDeviceId,
} from "../application/settings";
import type { SettingsHandlerWorkflows } from "../ipc/handlers/settings";
import type { LegacyRuntimePort } from "./legacy-runtime-port";

/** 初回設定とAsana再認証のworkflowを接続します。 */
export function createSettingsRuntime(
  legacy: LegacyRuntimePort,
  createId: () => string,
): SettingsHandlerWorkflows {
  const host = legacy.getSettingsCompositionDependencies();
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
  legacy.attachSettingsRuntime(setup, reauthentication);
  const setupIpc = new SetupIpcWorkflow({
    setup,
    parseState: host.parseState,
    afterTransition: host.afterTransition,
    afterCodexAuthentication: host.afterCodexAuthentication,
    afterVaultChoice: host.afterVaultChoice,
    runExternalToolConfiguration: host.runExternalToolConfiguration,
    afterExternalToolChoice: host.afterExternalToolChoice,
    afterCodexCapability: host.afterCodexCapability,
  });
  return { setup: setupIpc.createPort(), asana: reauthentication.createPort() };
}
