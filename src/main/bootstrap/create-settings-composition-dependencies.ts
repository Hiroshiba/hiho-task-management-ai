import { z } from "zod";
import {
  AsanaCapabilityCheckError,
  AsanaOAuthCoordinator,
  AsanaOAuthOutOfBandAuthenticationInProgressError,
  AsanaOAuthOutOfBandAuthorizationIdMismatchError,
  AsanaOAuthOutOfBandNotPendingError,
  asanaOAuthCoordinatorResultSchema,
  asanaSetupResourceCoordinatorResultSchema,
  capabilityCheckResultSchema,
  hasRestAsanaHttpError,
  oauthOutOfBandBeginResultSchema,
  oauthOutOfBandStateSchema,
  type AsanaCommunicationRuntime,
  type AsanaSyncCoordinatorResult,
} from "../infrastructure/asana";
import { deviceSettingsSchema, type DeviceSettings, type SqliteSettingsRepository, type SqliteVaultMappingRepository, type SetupCheckpointStore } from "../infrastructure/persistence";
import { identifierSchema } from "../domain";
import { vaultMappingSchema } from "../domain/obsidian-contracts";
import { settingsContracts } from "../../shared/ipc-contracts/settings";
import {
  contextFromState,
  type SetupFullSyncInput,
  type SetupOrchestrator,
} from "../application/settings";
import { ObsidianIntegrationWorkflow } from "../application/obsidian-integration";
import { validateAbortSignal, throwIfAborted } from "../application/common/abort-signal";
import { setupStateSchema, setupSchemas, type SetupState } from "./setup-contracts";
import type { ApplicationOptions } from "./main-runtime-options";
import type { SettingsCompositionDependencies } from "./create-settings-runtime";

class UnreachableError extends Error {}
type AsanaReauthenticationCompleteInput = z.output<typeof settingsContracts.completeAsanaReauthentication.request>;
const serviceErrorDiagnostic = { kind: "service", severity: "error" } as const;

export type SettingsCompositionHost = {
  readonly options: ApplicationOptions;
  readonly settingsRepository: SqliteSettingsRepository<DeviceSettings>;
  readonly checkpoint: SetupCheckpointStore;
  readonly asana: AsanaCommunicationRuntime;
  readonly oauth: AsanaOAuthCoordinator;
  readonly vaultMappingRepository: SqliteVaultMappingRepository;
  readonly obsidian: ObsidianIntegrationWorkflow;
  readonly codexHealth: SettingsCompositionDependencies["setupPorts"]["codex"];
  readonly operationQueue: AsanaCommunicationRuntime["operationQueue"];
  readonly operationalContext: {
    readonly requireConfiguredSettings: () => DeviceSettings;
    readonly configureAsanaFromSettings: (settings: DeviceSettings | undefined) => void;
    readonly configureFromState: (state: SetupState) => void;
  };
  readonly externalAgent: { readonly expireForContextChange: () => void };
  readonly configuredCodexRuntime: {
    readonly afterSetupTransition: (authenticationRequired: boolean) => void;
    readonly verifyConfiguredCapabilities: (signal: AbortSignal) => Promise<void>;
    readonly refreshThreadIfReady: (signal: AbortSignal) => Promise<void>;
  };
  readonly startupRuntime: {
    readonly isReadyActivated: () => boolean;
    readonly activateReady: (signal: AbortSignal) => Promise<void>;
  };
  readonly setup: () => SetupOrchestrator;
  readonly requireTaskReadRuntime: () => {
    readonly runSetupFullSync: (input: SetupFullSyncInput, signal: AbortSignal) => Promise<void>;
    readonly synchronizeReauthentication: (signal: AbortSignal) => Promise<AsanaSyncCoordinatorResult>;
  };
};

/** 初回設定とAsana再認証が使用するportを組み立てます。 */
export function createSettingsCompositionDependencies(
  host: SettingsCompositionHost,
): SettingsCompositionDependencies {
    return {
      settingsRepository: host.settingsRepository,
      checkpoint: host.checkpoint,
      parseState: (value: unknown) => setupStateSchema.parse(value),
      contextFromState,
      parseId: (value: unknown) => identifierSchema.parse(value),
      setupPorts: {
        codex: {
          detectCli: (signal: AbortSignal) => host.codexHealth.detectCli(signal),
          getAuthenticationState: (signal: AbortSignal) => host.codexHealth.getAuthenticationState(signal),
          completeAuthentication: (signal: AbortSignal) => host.codexHealth.completeAuthentication(signal),
          checkCapabilities: (signal: AbortSignal) => host.codexHealth.checkCapabilities(signal),
        },
        oauth: {
          beginInitialOutOfBandAuthorization: (input: Parameters<AsanaOAuthCoordinator["beginInitialOutOfBandAuthorization"]>[0], signal: AbortSignal) =>
            host.oauth.beginInitialOutOfBandAuthorization(input, signal),
          completeOutOfBandAuthorization: async (input: Parameters<AsanaOAuthCoordinator["completeOutOfBandAuthorization"]>[0], signal: AbortSignal) => {
            const result = await host.oauth.completeOutOfBandAuthorization(input, signal);
            host.asana.setTokenProvider(result.client_id);
            return result;
          },
          cancelOutOfBandAuthorization: (input: Parameters<AsanaOAuthCoordinator["cancelOutOfBandAuthorization"]>[0]) =>
            host.oauth.cancelOutOfBandAuthorization(input),
          getOutOfBandState: () => host.oauth.getOutOfBandState(),
        },
        asana: host.asana.setupClient,
        resources: host.asana.setupResources,
        capability: host.asana.setupCapability,
        reportCapabilityFailure: (error: unknown) =>
          host.options.diagnostic(error, "setup", serviceErrorDiagnostic),
        database: {
          saveDeviceSettings: (value: DeviceSettings) => host.settingsRepository.save(value),
          getDeviceSettings: () => host.settingsRepository.get(),
          saveVaultMapping: (value: Parameters<SqliteVaultMappingRepository["saveVaultMapping"]>[0]) =>
            host.vaultMappingRepository.saveVaultMapping(value),
          getVaultMappings: () => host.vaultMappingRepository.getVaultMappings(),
        },
        checkpoint: host.checkpoint,
        fullSync: (input: SetupFullSyncInput, signal: AbortSignal) => host.requireTaskReadRuntime().runSetupFullSync(input, signal),
        contracts: {
          validation: setupSchemas.validation,
          parseDeviceSettings: (value: unknown) => deviceSettingsSchema.parse(value),
          parseVaultMapping: (value: unknown) => vaultMappingSchema.parse(value),
          parseOAuthBeginResult: (value: unknown) => oauthOutOfBandBeginResultSchema.parse(value),
          parseOAuthCompleteResult: (value: unknown) => asanaOAuthCoordinatorResultSchema.parse(value),
          parseOAuthState: (value: unknown) => oauthOutOfBandStateSchema.parse(value),
          createOAuthInProgressError: () => new AsanaOAuthOutOfBandAuthenticationInProgressError(),
          createOAuthIdMismatchError: () => new AsanaOAuthOutOfBandAuthorizationIdMismatchError(),
          parseResourceResult: (value: unknown) => asanaSetupResourceCoordinatorResultSchema.parse(value),
          parseCapabilityResult: (value: unknown) => capabilityCheckResultSchema.parse(value),
          isCapabilityError: (error: unknown): error is AsanaCapabilityCheckError => error instanceof AsanaCapabilityCheckError,
          hasRestAsanaHttpError,
          validateVaultPath: (mapping: Parameters<ObsidianIntegrationWorkflow["validateMapping"]>[0], signal: AbortSignal) =>
            host.obsidian.validateMapping(mapping, signal),
        },
      },
      validateAbortSignal,
      throwIfAborted,
      requireSettings: () => host.operationalContext.requireConfiguredSettings(),
      parseCompleteInput: (input: unknown) =>
        settingsContracts.completeAsanaReauthentication.request.parse(input),
      parseCancelInput: (input: unknown) =>
        settingsContracts.cancelAsanaReauthentication.request.parse(input),
      readOAuthState: () => oauthOutOfBandStateSchema.parse(host.oauth.getOutOfBandState()),
      beginOAuth: async (clientId: string, signal: AbortSignal) => oauthOutOfBandBeginResultSchema.parse(
        await host.oauth.beginOutOfBandReauthentication({ client_id: clientId }, signal),
      ),
      completeOAuth: async (input: AsanaReauthenticationCompleteInput, signal: AbortSignal) =>
        asanaOAuthCoordinatorResultSchema.parse(
          await host.oauth.completeOutOfBandAuthorization(input, signal),
        ),
      cancelOAuth: (authorizationId: string) =>
        host.oauth.cancelOutOfBandAuthorization({ authorization_id: authorizationId }),
      parseAuthenticationState: (state: unknown) => {
        const response = settingsContracts.getAsanaAuthenticationState.response.parse({ kind: "ok", value: state });
        if (response.kind !== "ok") {
          throw new UnreachableError("Asana認証状態の応答形式が不正です。");
        }
        return response.value;
      },
      createInProgressError: () => new AsanaOAuthOutOfBandAuthenticationInProgressError(),
      createAuthorizationIdMismatchError: () =>
        new AsanaOAuthOutOfBandAuthorizationIdMismatchError(),
      createNotPendingError: () => new AsanaOAuthOutOfBandNotPendingError(),
      invalidatePendingMutations: () => host.operationQueue.invalidatePendingMutations("context_changed"),
      expireExternalAgent: () => host.externalAgent.expireForContextChange(),
      enqueueContextChange: (signal: AbortSignal, run: (operationSignal: AbortSignal) => Promise<void>) =>
        host.operationQueue.enqueue({
          priority: "user",
          kind: "context_change",
          signal,
          run: (context) => run(context.signal),
        }),
      configureAsana: (settings: DeviceSettings) => host.operationalContext.configureAsanaFromSettings(settings),
      synchronize: (signal: AbortSignal) => host.requireTaskReadRuntime().synchronizeReauthentication(signal),
      restoreContext: () => host.operationalContext.configureFromState(host.setup().getState()),
      afterTransition: (state: SetupState): SetupState => {
        const validatedState = setupStateSchema.parse(state);
        host.operationalContext.configureAsanaFromSettings(host.settingsRepository.get());
        host.operationalContext.configureFromState(validatedState);
        host.configuredCodexRuntime.afterSetupTransition(
          validatedState.kind === "codex_authentication_required",
        );
        return validatedState;
      },
      afterCodexAuthentication: async (signal: AbortSignal): Promise<void> => {
        if (!host.startupRuntime.isReadyActivated()) {
          await host.startupRuntime.activateReady(signal);
        } else {
          await host.configuredCodexRuntime.verifyConfiguredCapabilities(signal);
        }
      },
      afterVaultChoice: (signal: AbortSignal) => host.configuredCodexRuntime.refreshThreadIfReady(signal),
      afterCodexCapability: (signal: AbortSignal) => host.startupRuntime.activateReady(signal),
    };
}
