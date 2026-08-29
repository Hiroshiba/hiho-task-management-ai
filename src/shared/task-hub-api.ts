import type {
  IpcAiApprovalInput,
  IpcAiApprovalResult,
  IpcAiEditInput,
  IpcAiNewSessionResult,
  IpcAiStatus,
  IpcAiProposalView,
  IpcAiSelectionInput,
  IpcAiTurnInput,
  IpcAiTurnResult,
  IpcCodexDelta,
  IpcFailure,
  IpcGuiEditInput,
  IpcGuiEditResult,
  IpcObsidianNoteSummary,
  IpcObsidianPathResult,
  IpcObsidianSearchResult,
  IpcObsidianVaultList,
  IpcObsidianVaultResult,
  IpcReadModelOverview,
  IpcReadModelTaskDetail,
  IpcSetupAsanaAuthorizationBeginInput,
  IpcSetupAsanaAuthorizationCancelInput,
  IpcSetupAsanaAuthorizationCompleteInput,
  IpcSetupExternalToolChoiceInput,
  IpcSetupProjectSelectionInput,
  IpcSetupState,
  IpcSetupVaultChoiceInput,
  IpcSetupWorkspaceSelectionInput,
  IpcSyncResult,
  IpcSyncStateEvent,
} from "./ipc";

type IpcResult<T> = Promise<
  { readonly kind: "ok"; readonly value: T }
  | IpcFailure
>;

type IpcSubscription<T> = (listener: (value: T) => void) => () => void;

/** Rendererへ公開する最小の業務操作APIです。 */
export interface TaskHubApi {
  readonly app: {
    readonly getVersion: () => Promise<string>;
  };
  readonly asana: {
    readonly reauthenticateOAuth: () => IpcResult<IpcSyncResult>;
  };
  readonly readModel: {
    readonly getOverview: () => IpcResult<IpcReadModelOverview>;
    readonly getTaskDetail: (taskGid: string) => IpcResult<IpcReadModelTaskDetail>;
  };
  readonly sync: {
    readonly getState: () => IpcResult<IpcSyncStateEvent>;
    readonly run: (input: { readonly mode: "full" | "delta" }) => IpcResult<IpcSyncResult>;
    readonly onState: IpcSubscription<IpcSyncStateEvent>;
  };
  readonly setup: {
    readonly getState: () => IpcResult<IpcSetupState>;
    readonly start: () => IpcResult<IpcSetupState>;
    readonly completeCodexAuthentication: () => IpcResult<IpcSetupState>;
    readonly beginAsanaAuthorization: (
      input: IpcSetupAsanaAuthorizationBeginInput,
    ) => IpcResult<IpcSetupState>;
    readonly completeAsanaAuthorization: (
      input: IpcSetupAsanaAuthorizationCompleteInput,
    ) => IpcResult<IpcSetupState>;
    readonly cancelAsanaAuthorization: (
      input: IpcSetupAsanaAuthorizationCancelInput,
    ) => IpcResult<IpcSetupState>;
    readonly listWorkspaces: () => IpcResult<IpcSetupState>;
    readonly selectWorkspace: (input: IpcSetupWorkspaceSelectionInput) => IpcResult<IpcSetupState>;
    readonly selectProject: (input: IpcSetupProjectSelectionInput) => IpcResult<IpcSetupState>;
    readonly retryResources: () => IpcResult<IpcSetupState>;
    readonly runCapability: () => IpcResult<IpcSetupState>;
    readonly chooseVault: (input: IpcSetupVaultChoiceInput) => IpcResult<IpcSetupState>;
    readonly chooseExternalTool: (input: IpcSetupExternalToolChoiceInput) => IpcResult<IpcSetupState>;
    readonly runFullSync: () => IpcResult<IpcSetupState>;
    readonly runCodexCapability: () => IpcResult<IpcSetupState>;
  };
  readonly gui: {
    readonly apply: (input: IpcGuiEditInput) => IpcResult<IpcGuiEditResult>;
  };
  readonly ai: {
    readonly getStatus: () => IpcResult<IpcAiStatus>;
    readonly startNewSession: () => IpcResult<IpcAiNewSessionResult>;
    readonly startTurn: (input: IpcAiTurnInput) => IpcResult<IpcAiTurnResult>;
    readonly getProposal: (proposalId: string) => IpcResult<IpcAiProposalView>;
    readonly select: (input: IpcAiSelectionInput) => IpcResult<IpcAiProposalView>;
    readonly editOperation: (input: IpcAiEditInput) => IpcResult<IpcAiProposalView>;
    readonly reject: (proposalId: string) => IpcResult<{ readonly completed: true }>;
    readonly approve: (input: IpcAiApprovalInput) => IpcResult<IpcAiApprovalResult>;
    readonly onDelta: IpcSubscription<IpcCodexDelta>;
    readonly onStatus: IpcSubscription<IpcAiStatus>;
  };
  readonly obsidian: {
    readonly listVaults: () => IpcResult<IpcObsidianVaultList>;
    readonly validateVault: (vaultId: string) => IpcResult<IpcObsidianVaultResult>;
    readonly listNotes: (vaultId: string) => IpcResult<readonly IpcObsidianNoteSummary[]>;
    readonly resolvePath: (input: { readonly vault_id: string; readonly relative_path: string }) => IpcResult<IpcObsidianPathResult>;
    readonly noteExists: (input: { readonly vault_id: string; readonly relative_path: string }) => IpcResult<IpcObsidianPathResult>;
    readonly search: (input: { readonly vault_id: string; readonly query: string }) => IpcResult<readonly IpcObsidianSearchResult[]>;
    readonly openNote: (input: { readonly vault_id: string; readonly relative_path: string }) => IpcResult<{ readonly completed: true }>;
  };
}

declare global {
  interface Window {
    readonly taskHub: TaskHubApi;
  }
}
