type SetupOperations<State, Begin, Complete, Cancel, Workspace, Project, Vault> = {
  readonly getState: () => State;
  readonly start: (signal: AbortSignal) => Promise<State>;
  readonly completeCodexAuthentication: (signal: AbortSignal) => Promise<State>;
  readonly beginAsanaAuthorization: (input: Begin, signal: AbortSignal) => Promise<State>;
  readonly completeAsanaAuthorization: (input: Complete, signal: AbortSignal) => Promise<State>;
  readonly cancelAsanaAuthorization: (input: Cancel, signal: AbortSignal) => State;
  readonly listWorkspaces: (signal: AbortSignal) => Promise<State>;
  readonly selectWorkspace: (input: Workspace, signal: AbortSignal) => Promise<State>;
  readonly selectProject: (input: Project, signal: AbortSignal) => Promise<State>;
  readonly retryResourceReconciliation: (signal: AbortSignal) => Promise<State>;
  readonly runCapabilityCheck: (signal: AbortSignal) => Promise<State>;
  readonly chooseVault: (input: Vault, signal: AbortSignal) => Promise<State>;
  readonly runFullSync: (signal: AbortSignal) => Promise<State>;
  readonly runCodexCapabilityCheck: (signal: AbortSignal) => Promise<State>;
};

type SetupIpcDependencies<
  State extends { readonly kind: string },
  Begin,
  Complete,
  Cancel,
  Workspace,
  Project,
  Vault,
> = {
  readonly setup: SetupOperations<State, Begin, Complete, Cancel, Workspace, Project, Vault>;
  readonly parseState: (value: unknown) => State;
  readonly afterTransition: (state: State) => State;
  readonly afterCodexAuthentication: (signal: AbortSignal) => Promise<void>;
  readonly afterVaultChoice: (signal: AbortSignal) => Promise<void>;
  readonly afterCodexCapability: (signal: AbortSignal) => Promise<void>;
};

/** 設定操作の保存、同期、通知を既存の順序で実行します。 */
export class SetupIpcWorkflow<
  State extends { readonly kind: string },
  Begin,
  Complete,
  Cancel,
  Workspace,
  Project,
  Vault,
> {
  public constructor(private readonly dependencies: SetupIpcDependencies<
    State, Begin, Complete, Cancel, Workspace, Project, Vault
  >) {}

  /** IPCへ公開する初回設定操作を返します。 */
  public createPort(): {
    readonly getState: () => State;
    readonly start: (signal: AbortSignal) => Promise<State>;
    readonly completeCodexAuthentication: (signal: AbortSignal) => Promise<State>;
    readonly beginAsanaAuthorization: (input: Begin, signal: AbortSignal) => Promise<State>;
    readonly completeAsanaAuthorization: (input: Complete, signal: AbortSignal) => Promise<State>;
    readonly cancelAsanaAuthorization: (input: Cancel, signal: AbortSignal) => State;
    readonly listWorkspaces: (signal: AbortSignal) => Promise<State>;
    readonly selectWorkspace: (input: Workspace, signal: AbortSignal) => Promise<State>;
    readonly selectProject: (input: Project, signal: AbortSignal) => Promise<State>;
    readonly retryResources: (signal: AbortSignal) => Promise<State>;
    readonly runCapability: (signal: AbortSignal) => Promise<State>;
    readonly chooseVault: (input: Vault, signal: AbortSignal) => Promise<State>;
    readonly runFullSync: (signal: AbortSignal) => Promise<State>;
    readonly runCodexCapability: (signal: AbortSignal) => Promise<State>;
  } {
    const { setup, afterTransition } = this.dependencies;
    return {
      getState: () => this.dependencies.parseState(setup.getState()),
      start: async (signal) => afterTransition(await setup.start(signal)),
      completeCodexAuthentication: async (signal) => {
        const state = afterTransition(await setup.completeCodexAuthentication(signal));
        if (state.kind === "ready") {
          await this.dependencies.afterCodexAuthentication(signal);
        }
        return state;
      },
      beginAsanaAuthorization: async (input, signal) =>
        afterTransition(await setup.beginAsanaAuthorization(input, signal)),
      completeAsanaAuthorization: async (input, signal) =>
        afterTransition(await setup.completeAsanaAuthorization(input, signal)),
      cancelAsanaAuthorization: (input, signal) =>
        afterTransition(setup.cancelAsanaAuthorization(input, signal)),
      listWorkspaces: async (signal) => afterTransition(await setup.listWorkspaces(signal)),
      selectWorkspace: async (input, signal) =>
        afterTransition(await setup.selectWorkspace(input, signal)),
      selectProject: async (input, signal) =>
        afterTransition(await setup.selectProject(input, signal)),
      retryResources: async (signal) =>
        afterTransition(await setup.retryResourceReconciliation(signal)),
      runCapability: async (signal) =>
        afterTransition(await setup.runCapabilityCheck(signal)),
      chooseVault: async (input, signal) => {
        const state = afterTransition(await setup.chooseVault(input, signal));
        await this.dependencies.afterVaultChoice(signal);
        return state;
      },
      runFullSync: async (signal) => afterTransition(await setup.runFullSync(signal)),
      runCodexCapability: async (signal) => {
        const state = afterTransition(await setup.runCodexCapabilityCheck(signal));
        if (state.kind === "ready") {
          await this.dependencies.afterCodexCapability(signal);
        }
        return state;
      },
    };
  }
}
