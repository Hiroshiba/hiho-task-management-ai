import type { FinalTaskHubApi } from "../../shared/ipc-contracts";
import { createMockGithubIntegrationApi } from "../features/github-integration";
import { createMockObsidianIntegrationApi } from "../features/obsidian-integration";
import { createMockProposalsApi } from "../features/proposals";
import { createMockSettingsApi } from "../features/settings";
import { createMockSystemApi } from "../features/system";
import { createMockTasksApi } from "../features/tasks";
import { createMockDiagnosticsApi } from "../shared/mock/diagnostics";
import type { MockFeatureName } from "../shared/mock/mock-selection";

type MockApiFactories = {
  readonly [Name in keyof FinalTaskHubApi]: () => FinalTaskHubApi[Name];
};

function selectFeatureApi<Name extends keyof FinalTaskHubApi>(
  name: Name,
  selectedFeatures: ReadonlySet<MockFeatureName>,
  nativeApi: FinalTaskHubApi | undefined,
  mockFactories: MockApiFactories,
): FinalTaskHubApi[Name] {
  if (selectedFeatures.has(name)) {
    return mockFactories[name]();
  }
  if (nativeApi == null) {
    throw new Error(
      `Webフロントでは機能「${name}」のAPIを利用できません。mock=${name}またはmock=allを指定してください。`,
    );
  }
  return nativeApi[name];
}

/** アプリ起動時に機能ごとの実APIとmock APIを選びます。 */
export function createFeatureApiRegistry(
  selectedFeatures: ReadonlySet<MockFeatureName>,
  nativeApi: FinalTaskHubApi | undefined,
): FinalTaskHubApi {
  let mockTasksApi: ReturnType<typeof createMockTasksApi> | undefined;
  const mockFactories = {
    system: createMockSystemApi,
    tasks: () => {
      mockTasksApi ??= createMockTasksApi();
      return mockTasksApi;
    },
    settings: () => createMockSettingsApi("ready", "idle", (syncedAt) => {
      mockTasksApi?.completeExternalSync(syncedAt);
    }),
    proposals: () => createMockProposalsApi("confirmable", (syncedAt) => {
      mockTasksApi?.completeExternalSync(syncedAt);
    }, (operations, syncedAt) => {
      mockTasksApi?.applyProposalOperations(operations, syncedAt);
    }),
    obsidianIntegration: createMockObsidianIntegrationApi,
    githubIntegration: createMockGithubIntegrationApi,
    diagnostics: createMockDiagnosticsApi,
  } satisfies MockApiFactories;

  return {
    system: selectFeatureApi("system", selectedFeatures, nativeApi, mockFactories),
    tasks: selectFeatureApi("tasks", selectedFeatures, nativeApi, mockFactories),
    settings: selectFeatureApi("settings", selectedFeatures, nativeApi, mockFactories),
    proposals: selectFeatureApi("proposals", selectedFeatures, nativeApi, mockFactories),
    obsidianIntegration: selectFeatureApi("obsidianIntegration", selectedFeatures, nativeApi, mockFactories),
    githubIntegration: selectFeatureApi("githubIntegration", selectedFeatures, nativeApi, mockFactories),
    diagnostics: selectFeatureApi("diagnostics", selectedFeatures, nativeApi, mockFactories),
  };
}
