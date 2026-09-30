import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  screen,
  session,
  shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { DiagnosticRecord } from "./infrastructure/persistence";
import type { ErrorReportContext } from "./application/common/errors/error-reporter";
import { createMainRuntime, type MainRuntime } from "./bootstrap/create-main-runtime";
import { registerMainLifecycle } from "./bootstrap/register-main-lifecycle";
import { MainWindowRuntime } from "./bootstrap/main-window-runtime";
import { OperationalEventRuntime } from "./bootstrap/operational-event-runtime";
import { openAuthorizedExternalUrl, openObsidianUrl, openResolvedPath } from "./bootstrap/open-external-resource";
import { configureContentSecurityPolicy, configurePermissionPolicy, resolveRendererUrl } from "./bootstrap/renderer-environment";
import {
  diagnosticFailureDispositionFromError,
  type DiagnosticFailureDisposition,
} from "./application/common/errors/diagnostic-failure";
import { AsanaSyncRuntimeAlreadyReportedError } from "./infrastructure/asana";
import { getUniqueAsanaHttpStatus } from "./infrastructure/asana";
import { obsidianOpenUriInputSchema } from "./domain/obsidian-uri";
import { redactSensitiveText, writeErrorReportFailure } from "./infrastructure/logging";
import {
  assertAllowedAsanaAuthorizationUrl,
  assertAllowedCodexAuthorizationUrl,
  assertTrustedIpcSender,
  isApplicationUrl,
} from "./bootstrap/security";

const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;
const applicationDiagnosticSchema = z.object({
  kind: z.literal("service"),
  severity: z.enum(["warning", "error"]),
}).strict();
type ApplicationDiagnostic = z.infer<typeof applicationDiagnosticSchema>;

function registerMain(): void {
  function recordPersistentError(
    source: ErrorReportContext["source"],
    diagnosticCode: DiagnosticRecord["code"],
    context: ErrorReportContext["context"],
    severity: ErrorReportContext["level"],
    error: unknown,
  ): string {
    const logger = lifecycle.getRuntime()?.reporter;
    if (logger == null) {
      const errorId = randomUUID();
      writeErrorReportFailure(new Error(`エラーID: ${errorId}`, { cause: error }), lifecycle.getRuntime()?.knownSecrets() ?? [], redactSensitiveText);
      return errorId;
    }
    return logger.reportErrorOnce(error, { source, diagnosticCode, context, level: severity });
  }

  function recordDiagnostic(
    code: DiagnosticRecord["code"],
    severity: DiagnosticRecord["severity"],
    metadata?: Pick<
      DiagnosticRecord,
      "asana_gid" | "operation_id" | "proposal_id" | "http_status"
    >,
    error?: unknown,
  ): void {
    const httpStatus = error == null ? undefined : getUniqueAsanaHttpStatus(error);
    let resolvedMetadata = metadata;
    if (resolvedMetadata == null) {
      if (httpStatus != null) {
        resolvedMetadata = { http_status: httpStatus };
      }
    } else if (resolvedMetadata.http_status == null && httpStatus != null) {
      resolvedMetadata = { ...resolvedMetadata, http_status: httpStatus };
    }
    const runtime = lifecycle.getRuntime();
    if (runtime == null) {
      console.error("診断情報を記録できませんでした。");
      return;
    }
    try {
      runtime.recordDiagnostic(code, severity, resolvedMetadata);
    } catch (diagnosticError) {
      recordPersistentError("main", "storage.error", "diagnostic_storage", "error", diagnosticError);
      console.error("診断情報を記録できませんでした。");
    }
  }

  function recordServiceDiagnostic(
    error: unknown,
    channel: string,
    rawDiagnostic: ApplicationDiagnostic,
  ): void {
    const diagnostic = applicationDiagnosticSchema.parse(rawDiagnostic);
    let diagnosticCode: DiagnosticRecord["code"];
    switch (channel) {
      case "sync":
      case "display_order":
        diagnosticCode = "sync.failed";
        break;
      case "codex":
        diagnosticCode = "codex.status";
        break;
      case "external_tools":
        diagnosticCode = "external_tools.status";
        break;
      case "proposal_application":
        diagnosticCode = "proposal.application";
        break;
      case "ipc":
      case "sync_state_listener":
      case "ai_status_listener":
      case "ai_delta_listener":
        diagnosticCode = "ipc.error";
        break;
      default:
        diagnosticCode = "app.error";
    }
    recordPersistentError(
      "service",
      diagnosticCode,
      "service_diagnostic",
      diagnostic.severity,
      new Error(JSON.stringify(diagnostic), { cause: error }),
    );
    recordDiagnostic(diagnosticCode, diagnostic.severity, undefined, error);
  }

  function mainDiagnosticFailureDisposition(error: unknown): DiagnosticFailureDisposition {
    if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
      return {
        kind: "recorded_only",
        recorded_error: error,
        response_error: error.cause,
      };
    }
    return diagnosticFailureDispositionFromError(error);
  }

  function getRendererUrl(): string {
    return resolveRendererUrl({
      packaged: app.isPackaged,
      rendererIndexPath: join(__dirname, "../renderer/index.html"),
      developmentUrl: developmentRendererUrl,
      arguments: process.argv,
    });
  }

  function forwardUnhandledError(error: unknown): void {
    queueMicrotask(() => {
      throw error;
    });
  }

  const operationalEvents = new OperationalEventRuntime({
    powerMonitor,
    isOnline: () => net.isOnline(),
    isRunning: () => lifecycle.isRunning(),
    getRuntime: () => lifecycle.getRuntime(),
    isStartupReady: () => lifecycle.startupGate.isReady(),
    reportPersistentError: (code, error) => {
      recordPersistentError("main", code, "background_operation", "error", error);
    },
    recordDiagnostic: (code, error) => recordDiagnostic(code, "error", undefined, error),
  });
  const windows = new MainWindowRuntime({
    app,
    ipcMain,
    screen,
    shell,
    isRunning: () => lifecycle.isRunning(),
    scheduleForegroundSync: operationalEvents.scheduleForegroundSync,
    reportPersistentError: (context, error) => {
      const code = context === "registry_dispose" ? "ipc.error" : "app.error";
      recordPersistentError("main", code, context, "error", error);
    },
    recordDiagnostic: (code, error) => recordDiagnostic(code, "error", undefined, error),
  });

  function createApplicationRuntime(): MainRuntime {
    return createMainRuntime({
      userDataPath: app.getPath("userData"),
      logsPath: app.getPath("logs"),
      update: {
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
      },
      ipcSecurity: {
        assertTrustedSender: assertTrustedIpcSender,
        isApplicationUrl,
      },
      system: {
        getVersion: () => app.getVersion(),
        waitForStartup: (signal) => lifecycle.startupGate.waitForStartup(signal),
        getUpdateState: () => requireApplicationUpdateService().getState(),
        onUpdateState: (listener) => requireApplicationUpdateService().onState(listener),
      },
      composition: {
        app_version: app.getVersion(),
        read_only_vault_paths: [],
        online_provider: () => net.isOnline(),
        open_authorization_url: (authorizationUrl, signal) =>
          openAuthorizedExternalUrl(
            authorizationUrl,
            signal,
            assertAllowedAsanaAuthorizationUrl,
          ),
        open_codex_authorization_url: (authorizationUrl, signal) =>
          openAuthorizedExternalUrl(
            authorizationUrl,
            signal,
            assertAllowedCodexAuthorizationUrl,
          ),
        open_obsidian_url: (obsidianUrl, signal) =>
          openObsidianUrl(obsidianUrl, signal, (vaultId, relativePath) => {
            obsidianOpenUriInputSchema.parse({ vault_id: vaultId, relative_path: relativePath });
          }),
        open_path: (absolutePath, signal) => openResolvedPath(absolutePath, signal),
        diagnostic: recordServiceDiagnostic,
        unhandled_error_forwarder: forwardUnhandledError,
        open_external_agent_review: async () => {
          const runtime = lifecycle.getRuntime();
          if (runtime == null) {
            throw new Error("TaskHubアプリケーションが初期化されていません。");
          }
          await windows.ensure(getRendererUrl(), runtime);
          if (!windows.showAndFocus()) {
            throw new Error("TaskHubメインウィンドウを表示できません。");
          }
        },
      },
    });
  }

  function requireApplicationUpdateService() {
    const service = lifecycle.getUpdateService();
    if (service == null) {
      throw new Error("アプリ本体の更新サービスが初期化されていません。");
    }
    return service;
  }

  function yieldToRenderer(): Promise<void> {
    return new Promise((resolve) => {
      setImmediate(resolve);
    });
  }

  async function startApplication(application: MainRuntime, signal: AbortSignal): Promise<void> {
    try {
      await application.start(signal);
      if (signal.aborted || !lifecycle.isRunning()) {
        lifecycle.startupGate.markStopped();
        return;
      }
      operationalEvents.start();
      lifecycle.startupGate.markReady();
    } catch (error) {
      if (signal.aborted || !lifecycle.isRunning()) {
        lifecycle.startupGate.markStopped();
        return;
      }
      const disposition = mainDiagnosticFailureDisposition(error);
      switch (disposition.kind) {
        case "recorded_only":
          break;
        case "unrecorded_only":
        case "recorded_and_unrecorded":
          recordPersistentError("main", "app.error", "bootstrap", "error", disposition.unrecorded_error);
          recordDiagnostic("app.error", "error", undefined, disposition.unrecorded_error);
          break;
      }
      console.error("アプリケーションの起動に失敗しました。");
      lifecycle.startupGate.markFailed(disposition.response_error);
    }
  }

  async function stopApplication(): Promise<void> {
    const runtime = lifecycle.getRuntime();
    runtime?.abort();
    lifecycle.startupGate.markStopped();
    const errors: unknown[] = [];
    try {
      await windows.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await lifecycle.waitForApplicationStart();
    } catch (error) {
      errors.push(error);
    }
    try {
      await operationalEvents.stop();
    } catch (error) {
      errors.push(error);
    }
    if (runtime != null) {
      try {
        await runtime.dispose();
      } catch (error) {
        if (!(error instanceof AsanaSyncRuntimeAlreadyReportedError)) {
          const disposition = diagnosticFailureDispositionFromError(error);
          switch (disposition.kind) {
            case "recorded_only":
              break;
            case "unrecorded_only":
            case "recorded_and_unrecorded":
              recordPersistentError("main", "app.error", "application_stop", "error", disposition.unrecorded_error);
              recordDiagnostic("app.error", "error", undefined, disposition.unrecorded_error);
              break;
          }
        }
        console.error("アプリケーションの停止に失敗しました。");
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "アプリケーションの終了処理に複数の失敗がありました。", {
        cause: errors[0],
      });
    }
  }

  async function bootstrap(): Promise<void> {
    await app.whenReady();
    if (!lifecycle.isRunning()) {
      return;
    }
    Menu.setApplicationMenu(null);
    configureContentSecurityPolicy(session.defaultSession, app.isPackaged);
    configurePermissionPolicy(session.defaultSession);
    const rendererUrl = getRendererUrl();
    const runtime = createApplicationRuntime();
    lifecycle.setRuntime(runtime);
    const updateService = runtime.createApplicationUpdateService(
      (error) => recordPersistentError("main", "app.error", "application_update", "error", error),
    );
    lifecycle.setUpdateService(updateService);
    const onActivate = (): void => {
      if (!windows.showAndFocus() && BrowserWindow.getAllWindows().length === 0) {
        void windows.ensure(rendererUrl, runtime).catch((error) => {
          if (runtime.signal.aborted || !lifecycle.isRunning()) {
            return;
          }
          recordPersistentError("main", "app.error", "main_window", "error", error);
          recordDiagnostic("app.error", "error", undefined, error);
        });
      }
    };
    app.on("activate", onActivate);
    app.once("will-quit", () => app.removeListener("activate", onActivate));
    await windows.ensure(rendererUrl, runtime);
    await yieldToRenderer();
    if (runtime.signal.aborted || !lifecycle.isRunning()) {
      return;
    }
    updateService.start();
    await lifecycle.startApplication(() => startApplication(runtime, runtime.signal));
  }

  const lifecycle = registerMainLifecycle(app, {
    bootstrap,
    stop: stopApplication,
    flushWindowState: () => windows.flush(),
    showSecondInstance: () => { windows.showAndFocus(); },
    reportUncaughtException: (error) => {
      recordPersistentError("uncaught_exception", "app.error", "uncaught_exception", "error", error);
    },
    reportStopFailure: (error) => {
      recordPersistentError("main", "app.error", "application_quit", "error", error);
      recordDiagnostic("app.error", "error", undefined, error);
      console.error("アプリケーションの停止に失敗しました。");
    },
    reportBootstrapFailure: (error) => {
      const disposition = mainDiagnosticFailureDisposition(error);
      if (disposition.kind !== "recorded_only") {
        recordPersistentError("main", "app.error", "bootstrap", "error", disposition.unrecorded_error);
        recordDiagnostic("app.error", "error", undefined, disposition.unrecorded_error);
      }
      console.error("アプリケーションの起動に失敗しました。");
    },
  });
}

registerMain();
