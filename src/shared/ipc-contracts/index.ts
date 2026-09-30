import { diagnosticsChannels, diagnosticsContracts, type DiagnosticsApi } from "./diagnostics";
import { githubIntegrationChannels, githubIntegrationContracts, type GithubIntegrationApi } from "./github-integration";
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
export { githubIntegrationStatusSchema } from "./github-integration";
export { proposalOperationKindSchema } from "./proposal-values";
export { setupStateSchema } from "./settings";

export const finalIpcChannels = {
  system: systemChannels,
  tasks: tasksChannels,
  settings: settingsChannels,
  proposals: proposalsChannels,
  obsidianIntegration: obsidianIntegrationChannels,
  githubIntegration: githubIntegrationChannels,
  diagnostics: diagnosticsChannels,
};

export const finalIpcContracts: {
  readonly system: typeof systemContracts;
  readonly tasks: typeof tasksContracts;
  readonly settings: typeof settingsContracts;
  readonly proposals: typeof proposalsContracts;
  readonly obsidianIntegration: typeof obsidianIntegrationContracts;
  readonly githubIntegration: typeof githubIntegrationContracts;
  readonly diagnostics: typeof diagnosticsContracts;
} = {
  system: systemContracts,
  tasks: tasksContracts,
  settings: settingsContracts,
  proposals: proposalsContracts,
  obsidianIntegration: obsidianIntegrationContracts,
  githubIntegration: githubIntegrationContracts,
  diagnostics: diagnosticsContracts,
};

export type FinalTaskHubApi = {
  readonly system: SystemApi;
  readonly tasks: TasksApi;
  readonly settings: SettingsApi;
  readonly proposals: ProposalsApi;
  readonly obsidianIntegration: ObsidianIntegrationApi;
  readonly githubIntegration: GithubIntegrationApi;
  readonly diagnostics: DiagnosticsApi;
};
