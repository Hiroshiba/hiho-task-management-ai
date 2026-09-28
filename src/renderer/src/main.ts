import { createApp } from "vue";
import { createFeatureApiRegistry } from "../app/feature-api-registry";
import { installErrorBoundary } from "../app/install-error-boundary";
import { useSystemTheme } from "../app/use-system-theme";
import { diagnosticsApiInjectionKey, githubIntegrationApiInjectionKey, obsidianIntegrationApiInjectionKey, proposalsApiInjectionKey, settingsApiInjectionKey, systemApiInjectionKey, tasksApiInjectionKey } from "../shared/api/feature-apis";
import { reportRendererError } from "../shared/logging/report-renderer-error";
import { parseMockSelection } from "../shared/mock/mock-selection";
import App from "../app/App.vue";
import "./styles.css";

function mountApp(): void {
  const mockSelection = parseMockSelection(window.location.search);
  const featureApis = createFeatureApiRegistry(mockSelection.features, window.taskHub);
  const app = createApp(App);
  app.provide(systemApiInjectionKey, featureApis.system);
  app.provide(diagnosticsApiInjectionKey, featureApis.diagnostics);
  app.provide(tasksApiInjectionKey, featureApis.tasks);
  app.provide(proposalsApiInjectionKey, featureApis.proposals);
  app.provide(settingsApiInjectionKey, featureApis.settings);
  app.provide(obsidianIntegrationApiInjectionKey, featureApis.obsidianIntegration);
  app.provide(githubIntegrationApiInjectionKey, featureApis.githubIntegration);
  installErrorBoundary(app, featureApis.diagnostics, window);
  app.onUnmount(useSystemTheme(window.matchMedia("(prefers-color-scheme: dark)"), document.documentElement));
  app.mount("#app");

  if (mockSelection.unknownFeatures.length > 0) {
    void reportRendererError(
      featureApis.diagnostics,
      new Error(`未対応のmock機能名を無視しました: ${mockSelection.unknownFeatures.join(", ")}`),
      "warning",
    );
  }
}

mountApp();
