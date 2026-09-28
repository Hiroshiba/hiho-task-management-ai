import type { App } from "vue";
import type { DiagnosticsApi } from "../../shared/ipc-contracts/diagnostics";
import { reportRendererError } from "../shared/logging/report-renderer-error";

/** 全体の未処理例外をMainの診断ログへ送ります。 */
export function installErrorBoundary(app: App, diagnostics: DiagnosticsApi, target: Window): void {
  app.config.errorHandler = (error): void => {
    void reportRendererError(diagnostics, error, "error");
  };

  const onError = (event: ErrorEvent): void => {
    void reportRendererError(diagnostics, event.error, "error");
  };
  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    void reportRendererError(diagnostics, event.reason, "error");
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);
  app.onUnmount(() => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
  });
}
