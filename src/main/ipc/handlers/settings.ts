import type { z } from "zod";
import { settingsContracts } from "../../../shared/ipc-contracts/settings";
import { createContractHandler, type ContractHandler, type IpcSuccessValue } from "./contract-handler";

type MaybePromise<Value> = Value | PromiseLike<Value>;
type Request<Contract extends { readonly request: z.ZodType }> = z.output<Contract["request"]>;
type SetupState = IpcSuccessValue<typeof settingsContracts.getState.response>;
type AuthenticationState = IpcSuccessValue<typeof settingsContracts.getAsanaAuthenticationState.response>;
type ReauthenticationResult = IpcSuccessValue<typeof settingsContracts.completeAsanaReauthentication.response>;
type ReauthenticationSourceResult = Pick<ReauthenticationResult, "synced_at" | "performed_mode" | "normalization_notifications"> & {
  readonly application_result: {
    readonly operations: readonly { readonly outcome: "applied" | "already_applied" | "conflict" }[];
  };
  readonly remaining_plan: {
    readonly status_write_task_gids: readonly string[];
    readonly external_write_task_gids: readonly string[];
    readonly tag_write_task_gids: readonly string[];
  };
  readonly critical_errors: readonly unknown[];
  readonly cleanup_items: readonly unknown[];
};
export type SettingsHandlers = {
  readonly [Name in keyof typeof settingsContracts]: ContractHandler<(typeof settingsContracts)[Name]>;
};

/** 初回設定とAsana再認証の公開操作です。 */
export interface SettingsHandlerWorkflows {
  readonly setup: {
    getState(): MaybePromise<SetupState>;
    start(signal: AbortSignal): MaybePromise<SetupState>;
    completeCodexAuthentication(signal: AbortSignal): MaybePromise<SetupState>;
    beginAsanaAuthorization(
      input: Request<typeof settingsContracts.beginAsanaAuthorization>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    completeAsanaAuthorization(
      input: Request<typeof settingsContracts.completeAsanaAuthorization>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    cancelAsanaAuthorization(
      input: Request<typeof settingsContracts.cancelAsanaAuthorization>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    listWorkspaces(signal: AbortSignal): MaybePromise<SetupState>;
    selectWorkspace(
      input: Request<typeof settingsContracts.selectWorkspace>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    selectProject(
      input: Request<typeof settingsContracts.selectProject>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    retryResources(signal: AbortSignal): MaybePromise<SetupState>;
    runCapability(signal: AbortSignal): MaybePromise<SetupState>;
    chooseVault(
      input: Request<typeof settingsContracts.chooseVault>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    chooseExternalTool(
      input: Request<typeof settingsContracts.chooseExternalTool>,
      signal: AbortSignal,
    ): MaybePromise<SetupState>;
    runFullSync(signal: AbortSignal): MaybePromise<SetupState>;
    runCodexCapability(signal: AbortSignal): MaybePromise<SetupState>;
  };
  readonly asana: {
    getAuthenticationState(): MaybePromise<AuthenticationState>;
    beginReauthentication(signal: AbortSignal): MaybePromise<AuthenticationState>;
    completeReauthentication(
      input: Request<typeof settingsContracts.completeAsanaReauthentication>,
      signal: AbortSignal,
    ): MaybePromise<ReauthenticationSourceResult>;
    cancelReauthentication(
      input: Request<typeof settingsContracts.cancelAsanaReauthentication>,
      signal: AbortSignal,
    ): MaybePromise<AuthenticationState>;
  };
}

/** settingsのuse caseに対応するIPC handlerを作成します。 */
export function createSettingsHandlers(workflows: SettingsHandlerWorkflows): SettingsHandlers {
  const { setup, asana } = workflows;
  return {
    getState: createContractHandler(settingsContracts.getState, () => setup.getState()),
    start: createContractHandler(settingsContracts.start, (_request, signal) => setup.start(signal)),
    completeCodexAuthentication: createContractHandler(
      settingsContracts.completeCodexAuthentication,
      (_request, signal) => setup.completeCodexAuthentication(signal),
    ),
    beginAsanaAuthorization: createContractHandler(
      settingsContracts.beginAsanaAuthorization,
      (request, signal) => setup.beginAsanaAuthorization(request, signal),
    ),
    completeAsanaAuthorization: createContractHandler(
      settingsContracts.completeAsanaAuthorization,
      (request, signal) => setup.completeAsanaAuthorization(request, signal),
    ),
    cancelAsanaAuthorization: createContractHandler(
      settingsContracts.cancelAsanaAuthorization,
      (request, signal) => setup.cancelAsanaAuthorization(request, signal),
    ),
    listWorkspaces: createContractHandler(
      settingsContracts.listWorkspaces,
      (_request, signal) => setup.listWorkspaces(signal),
    ),
    selectWorkspace: createContractHandler(
      settingsContracts.selectWorkspace,
      (request, signal) => setup.selectWorkspace(request, signal),
    ),
    selectProject: createContractHandler(
      settingsContracts.selectProject,
      (request, signal) => setup.selectProject(request, signal),
    ),
    retryResources: createContractHandler(
      settingsContracts.retryResources,
      (_request, signal) => setup.retryResources(signal),
    ),
    runCapability: createContractHandler(
      settingsContracts.runCapability,
      (_request, signal) => setup.runCapability(signal),
    ),
    chooseVault: createContractHandler(
      settingsContracts.chooseVault,
      (request, signal) => setup.chooseVault(request, signal),
    ),
    chooseExternalTool: createContractHandler(
      settingsContracts.chooseExternalTool,
      (request, signal) => setup.chooseExternalTool(request, signal),
    ),
    runFullSync: createContractHandler(
      settingsContracts.runFullSync,
      (_request, signal) => setup.runFullSync(signal),
    ),
    runCodexCapability: createContractHandler(
      settingsContracts.runCodexCapability,
      (_request, signal) => setup.runCodexCapability(signal),
    ),
    getAsanaAuthenticationState: createContractHandler(
      settingsContracts.getAsanaAuthenticationState,
      () => asana.getAuthenticationState(),
    ),
    beginAsanaReauthentication: createContractHandler(
      settingsContracts.beginAsanaReauthentication,
      (_request, signal) => asana.beginReauthentication(signal),
    ),
    completeAsanaReauthentication: createContractHandler(
      settingsContracts.completeAsanaReauthentication,
      async (request, signal) => {
        const result = await asana.completeReauthentication(request, signal);
        return {
          synced_at: result.synced_at,
          performed_mode: result.performed_mode,
          normalization_notifications: result.normalization_notifications,
          conflict_count: result.application_result.operations.filter((operation) => operation.outcome === "conflict").length,
          remaining_write_count: result.remaining_plan.status_write_task_gids.length
            + result.remaining_plan.external_write_task_gids.length
            + result.remaining_plan.tag_write_task_gids.length,
          critical_error_count: result.critical_errors.length,
          cleanup_count: result.cleanup_items.length,
        };
      },
    ),
    cancelAsanaReauthentication: createContractHandler(
      settingsContracts.cancelAsanaReauthentication,
      (request, signal) => asana.cancelReauthentication(request, signal),
    ),
  };
}
