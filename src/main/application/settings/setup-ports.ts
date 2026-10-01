import type {
  SetupAsanaAuthorizationBeginInput,
  SetupAsanaAuthorizationCancelInput,
  SetupAsanaAuthorizationCompleteInput,
  SetupCodexAvailability,
  SetupCodexAuthenticationState,
  SetupFullSyncInput,
  SetupProject,
  SetupProjectSelectionInput,
  SetupState,
  SetupVaultChoiceInput,
  SetupWorkspace,
  SetupWorkspaceSelectionInput,
  SetupTagGids,
} from "../../domain/setup-state";
import type { DeviceSettingsRecord } from "../common/ports/settings-repository";
import type { ResourceResult } from "./setup-asana-resources";

type VaultMapping = Extract<SetupVaultChoiceInput, { readonly kind: "configure" }>["mapping"];

export type SetupCodexPort = {
  readonly detectCli: (signal: AbortSignal) => Promise<SetupCodexAvailability>;
  readonly getAuthenticationState: (signal: AbortSignal) => Promise<SetupCodexAuthenticationState>;
  readonly completeAuthentication: (signal: AbortSignal) => Promise<SetupCodexAuthenticationState>;
  readonly checkCapabilities: (signal: AbortSignal) => Promise<SetupCodexAvailability>;
};

export type SetupOAuthPort = {
  readonly beginInitialOutOfBandAuthorization: (
    input: SetupAsanaAuthorizationBeginInput,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly completeOutOfBandAuthorization: (
    input: SetupAsanaAuthorizationCompleteInput,
    signal: AbortSignal,
  ) => Promise<unknown>;
  readonly cancelOutOfBandAuthorization: (input: SetupAsanaAuthorizationCancelInput) => void;
  readonly getOutOfBandState: () => unknown;
};

export type SetupAsanaPort = {
  readonly listCurrentUserWorkspaces: (signal: AbortSignal) => Promise<readonly unknown[]>;
  readonly listWorkspaceProjects: (workspaceGid: string, signal: AbortSignal) => Promise<readonly unknown[]>;
  readonly createProject: (
    workspaceGid: string,
    name: string,
    signal: AbortSignal,
  ) => Promise<{
    readonly gid: string;
    readonly name: string;
    readonly workspace: { readonly gid: string };
  }>;
};

export type SetupResourcePort = {
  readonly coordinate: (
    input: {
      readonly workspace_gid: string;
      readonly project_gid: string;
      readonly configured_section_gids?: DeviceSettingsRecord["section_gids"];
    },
    signal: AbortSignal,
  ) => Promise<ResourceResult>;
};

export type SetupCapabilityResult =
  | { readonly kind: "ready"; readonly test_task_gid: string }
  | { readonly kind: "failed"; readonly reason_code: string };

export type SetupCapabilityPort = {
  readonly check: (
    input: {
      readonly project_gid: string;
      readonly section_gids: {
        readonly not_started: string;
        readonly in_progress: string;
        readonly withdrawn: string;
      };
      readonly tag_gid: string;
    },
    signal: AbortSignal,
  ) => Promise<SetupCapabilityResult>;
};

export type SetupCapabilityFailureReporter = (error: unknown) => void;

export type SetupDatabasePort = {
  readonly saveDeviceSettings: (settings: DeviceSettingsRecord) => void;
  readonly getDeviceSettings: () => DeviceSettingsRecord | undefined;
  readonly saveVaultMapping: (mapping: VaultMapping) => void;
  readonly getVaultMappings: () => readonly VaultMapping[];
};

export type SetupCheckpointPort = {
  readonly load: () => SetupState | undefined;
  readonly save: (state: SetupState) => void;
};

export type SetupFullSyncPort = (input: SetupFullSyncInput, signal: AbortSignal) => Promise<void>;

export type SetupValidationPort = {
  readonly parseId: (value: unknown) => string;
  readonly parseState: (value: unknown) => SetupState;
  readonly parseCodexAvailability: (value: unknown) => SetupCodexAvailability;
  readonly parseCodexAuthenticationState: (value: unknown) => SetupCodexAuthenticationState;
  readonly parseAsanaAuthorizationBeginInput: (value: unknown) => SetupAsanaAuthorizationBeginInput;
  readonly parseAsanaAuthorizationCompleteInput: (value: unknown) => SetupAsanaAuthorizationCompleteInput;
  readonly parseAsanaAuthorizationCancelInput: (value: unknown) => SetupAsanaAuthorizationCancelInput;
  readonly parseWorkspace: (value: unknown) => SetupWorkspace;
  readonly parseWorkspaceSelectionInput: (value: unknown) => SetupWorkspaceSelectionInput;
  readonly parseProject: (value: unknown) => SetupProject;
  readonly parseProjectReference: (value: unknown) => SetupProject;
  readonly parseProjectSelectionInput: (value: unknown) => SetupProjectSelectionInput;
  readonly parseVaultChoiceInput: (value: unknown) => SetupVaultChoiceInput;
  readonly parseFullSyncInput: (value: unknown) => SetupFullSyncInput;
  readonly parseTagGids: (value: unknown) => SetupTagGids;
};

type OAuthState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "opening" | "authorization_pending" | "completing" | "expired" | "cancelled";
      readonly authorization_id: string;
      readonly expires_at: string;
    };

export type SetupRuntimeContracts = {
  readonly validation: SetupValidationPort;
  readonly parseDeviceSettings: (value: unknown) => DeviceSettingsRecord;
  readonly parseVaultMapping: (value: unknown) => VaultMapping;
  readonly parseOAuthBeginResult: (value: unknown) => { readonly authorization_id: string; readonly expires_at: string };
  readonly parseOAuthCompleteResult: (value: unknown) => { readonly kind: string; readonly client_id: string };
  readonly parseOAuthState: (value: unknown) => OAuthState;
  readonly createOAuthInProgressError: () => Error;
  readonly createOAuthIdMismatchError: () => Error;
  readonly parseResourceResult: (value: unknown) => ResourceResult;
  readonly parseCapabilityResult: (value: unknown) => SetupCapabilityResult;
  readonly isCapabilityError: (error: unknown) => error is { readonly result: SetupCapabilityResult };
  readonly hasRestAsanaHttpError: (error: unknown) => boolean;
  readonly validateVaultPath: (
    mapping: VaultMapping,
    signal: AbortSignal,
  ) => Promise<{ readonly vault_id: string; readonly real_path: string }>;
};

export type SetupOrchestratorOptions = {
  readonly device_id: string;
  readonly codex: SetupCodexPort;
  readonly oauth: SetupOAuthPort;
  readonly asana: SetupAsanaPort;
  readonly resources: SetupResourcePort;
  readonly capability: SetupCapabilityPort;
  readonly reportCapabilityFailure: SetupCapabilityFailureReporter;
  readonly database: SetupDatabasePort;
  readonly checkpoint: SetupCheckpointPort;
  readonly fullSync: SetupFullSyncPort;
  readonly contracts: SetupRuntimeContracts;
};
