import { diagnosticsChannels, diagnosticsContracts, type DiagnosticsApi } from "./diagnostics";
import {
  obsidianIntegrationChannels,
  obsidianIntegrationContracts,
  type ObsidianIntegrationApi,
} from "./obsidian-integration";
import { proposalsChannels } from "./proposals-channels";
import { proposalsContracts, type ProposalsApi } from "./proposals";
import { settingsChannels, settingsContracts, type SettingsApi } from "./settings";
import { systemChannels, systemContracts, type SystemApi } from "./system";
import { tasksChannels, tasksContracts, type TasksApi } from "./tasks";

export { ipcFailureSchema, subscriptionRequestSchema } from "./common";
export { executionDtoSchema, type ExecutionDto } from "./execution";
export { proposalOperationKindSchema } from "./proposal-values";
export { setupStateSchema } from "./settings";

export const finalIpcChannels = {
  system: systemChannels,
  tasks: tasksChannels,
  settings: settingsChannels,
  proposals: proposalsChannels,
  obsidianIntegration: obsidianIntegrationChannels,
  diagnostics: diagnosticsChannels,
};

export const finalIpcContracts: {
  readonly system: typeof systemContracts;
  readonly tasks: typeof tasksContracts;
  readonly settings: typeof settingsContracts;
  readonly proposals: typeof proposalsContracts;
  readonly obsidianIntegration: typeof obsidianIntegrationContracts;
  readonly diagnostics: typeof diagnosticsContracts;
} = {
  system: systemContracts,
  tasks: tasksContracts,
  settings: settingsContracts,
  proposals: proposalsContracts,
  obsidianIntegration: obsidianIntegrationContracts,
  diagnostics: diagnosticsContracts,
};

export type FinalTaskHubApi = {
  readonly system: SystemApi;
  readonly tasks: TasksApi;
  readonly settings: SettingsApi;
  readonly proposals: ProposalsApi;
  readonly obsidianIntegration: ObsidianIntegrationApi;
  readonly diagnostics: DiagnosticsApi;
};
