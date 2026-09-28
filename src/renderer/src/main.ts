import { createApp } from "vue";
import { installErrorBoundary } from "../app/install-error-boundary";
import { useSystemTheme } from "../app/use-system-theme";
import { createMockSystemApi } from "../features/system";
import { createMockTasksApi } from "../features/tasks";
import { createMockProposalsApi } from "../features/proposals";
import { createMockSettingsApi } from "../features/settings";
import { diagnosticsApiInjectionKey, proposalsApiInjectionKey, selectFeatureApi, settingsApiInjectionKey, systemApiInjectionKey, tasksApiInjectionKey } from "../shared/api/feature-apis";
import { reportRendererError } from "../shared/logging/report-renderer-error";
import { createMockDiagnosticsApi } from "../shared/mock/diagnostics";
import { parseMockSelection } from "../shared/mock/mock-selection";
import App from "./App.vue";
import "./styles.css";
import { createTaskHubApi, taskHubApiInjectionKey } from "./task-hub";

const mockSelection = parseMockSelection(window.location.search);
const taskHubApi = await createTaskHubApi(mockSelection.features, window.taskHub);
const systemApi = selectFeatureApi("system", mockSelection.features, window.taskHub?.system, createMockSystemApi);
const diagnosticsApi = selectFeatureApi(
  "diagnostics",
  mockSelection.features,
  window.taskHub?.diagnostics,
  createMockDiagnosticsApi,
);
const mockTasksApi = mockSelection.features.has("tasks") ? createMockTasksApi() : undefined;
const tasksApi = selectFeatureApi("tasks", mockSelection.features, window.taskHub?.tasks, () => {
  if (mockTasksApi == null) throw new Error("タスクmockが生成されていません。");
  return mockTasksApi;
});
const proposalsApi = selectFeatureApi("proposals", mockSelection.features, window.taskHub?.proposals,
  () => createMockProposalsApi("confirmable", (syncedAt) => mockTasksApi?.completeReadOnlyHistorySync(syncedAt)));
const settingsApi = selectFeatureApi("settings", mockSelection.features, window.taskHub?.settings,
  () => createMockSettingsApi("ready", "idle"));
const app = createApp(App);
app.provide(taskHubApiInjectionKey, taskHubApi);
app.provide(systemApiInjectionKey, systemApi);
app.provide(diagnosticsApiInjectionKey, diagnosticsApi);
app.provide(tasksApiInjectionKey, tasksApi);
app.provide(proposalsApiInjectionKey, proposalsApi);
app.provide(settingsApiInjectionKey, settingsApi);
installErrorBoundary(app, diagnosticsApi, window);
app.onUnmount(useSystemTheme(window.matchMedia("(prefers-color-scheme: dark)"), document.documentElement));
app.mount("#app");

if (mockSelection.unknownFeatures.length > 0) {
  void reportRendererError(
    diagnosticsApi,
    new Error("未対応のmock機能名を無視しました。"),
    "warning",
  );
}
