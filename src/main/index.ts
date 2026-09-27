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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { autoUpdater } from "electron-updater";
import { applicationDiagnosticSchema, type ApplicationDiagnostic, type DiagnosticRecord } from "./application/diagnostics";
import type { ErrorReportContext } from "./application/common/errors/error-reporter";
import { ApplicationUpdateService, isApplicationUpdateCandidate } from "./application-update";
import { createMainRuntime, type MainRuntime } from "./bootstrap/create-main-runtime";
import type { LegacyRuntimePort } from "./bootstrap/legacy-runtime-port";
import { registerMainLifecycle } from "./bootstrap/register-main-lifecycle";
import { createMainWindowReadyWait, type MainWindowReadyWait } from "./bootstrap/main-window-readiness";
import { openAuthorizedExternalUrl, openObsidianUrl, openResolvedPath } from "./bootstrap/open-external-resource";
import { configureContentSecurityPolicy, configurePermissionPolicy, resolveRendererUrl } from "./bootstrap/renderer-environment";
import {
  diagnosticFailureDispositionFromError,
  type DiagnosticFailureDisposition,
} from "./application/common/errors/diagnostic-failure";
import { AsanaSyncRuntimeAlreadyReportedError } from "./asana/runtime";
import { getUniqueAsanaHttpStatus } from "./asana/transport";
import { resolveCodexExecutable } from "./codex/app-server";
import { IpcHandlerRegistry } from "./ipc";
import { ensureSecureUserDataDirectory } from "./local-storage-path";
import { obsidianOpenUriInputSchema } from "./domain/obsidian-uri";
import { persistentErrorLogFormatter } from "./persistent-error-log";
import { createStartupGate, type StartupGate } from "./startup-gate";
import { writeErrorReportFailure } from "./infrastructure/logging";
import {
  assertAllowedAsanaAuthorizationUrl,
  assertAllowedCodexAuthorizationUrl,
  assertAllowedExternalUrl,
  assertTrustedIpcSender,
  isApplicationUrl,
} from "./security";
import { WindowStateController } from "./window-state";

const appGetVersionChannel = "app:get-version";
const onlinePollIntervalMilliseconds = 2_000;
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;
type OnlineMonitorState =
  | { readonly kind: "stopped" }
  | {
      readonly kind: "running";
      readonly timer: ReturnType<typeof setInterval>;
      readonly lastOnline: boolean;
    };

let mainWindow: BrowserWindow | undefined;
let mainWindowRegistry: IpcHandlerRegistry | undefined;
let mainWindowStateController: WindowStateController | undefined;
let applicationUpdateService: ApplicationUpdateService | undefined;
let windowCreationPromise: Promise<void> | undefined;
let applicationStartPromise: Promise<void> | undefined;
let backgroundOperations: Promise<void> = Promise.resolve();
let onlineMonitorState: OnlineMonitorState = { kind: "stopped" };
let foregroundScheduled = false;
let onlinePollScheduled = false;
let powerMonitorRegistered = false;
let versionIpcRegistered = false;
let uncaughtExceptionMonitorRegistered = false;
const startupGate = createStartupGate();

registerUncaughtExceptionMonitor();

function recordPersistentError(
  source: ErrorReportContext["source"],
  diagnosticCode: DiagnosticRecord["code"],
  context: ErrorReportContext["context"],
  severity: ErrorReportContext["level"],
  error: unknown,
): void {
  const logger = lifecycle.getRuntime()?.reporter;
  if (logger == null) {
    writeErrorReportFailure(error, [], persistentErrorLogFormatter.redactText);
    return;
  }
  logger.reportErrorOnce(error, { source, diagnosticCode, context, level: severity });
}

function registerUncaughtExceptionMonitor(): void {
  if (uncaughtExceptionMonitorRegistered) {
    return;
  }
  process.on("uncaughtExceptionMonitor", (error) => {
    recordPersistentError(
      "uncaught_exception",
      "app.error",
      "uncaught_exception",
      "error",
      error,
    );
  });
  uncaughtExceptionMonitorRegistered = true;
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
  const application = lifecycle.getRuntime()?.legacy;
  if (application == null) {
    console.error("診断情報を記録できませんでした。");
    return;
  }
  try {
    application.recordDiagnostic(code, severity, resolvedMetadata);
  } catch (error) {
    recordPersistentError("main", "storage.error", "diagnostic_storage", "error", error);
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

function mainDiagnosticFailureDisposition(
  error: unknown,
): DiagnosticFailureDisposition {
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

function createApplicationRuntime(): MainRuntime {
  const userDataPath = ensureSecureUserDataDirectory(app.getPath("userData"));
  return createMainRuntime({
    userDataPath,
    secretStoragePath: join(userDataPath, "secret-storage.json"),
    checkpointPath: join(userDataPath, "setup-checkpoint.json"),
    logsPath: app.getPath("logs"),
    loggerFormatter: persistentErrorLogFormatter,
    system: {
      getVersion: () => app.getVersion(),
      waitForStartup: (signal) => startupGate.waitForStartup(signal),
      getUpdateState: () => requireApplicationUpdateService().getState(),
      onUpdateState: (listener) => requireApplicationUpdateService().onState(listener),
    },
    legacy: {
      user_data_path: userDataPath,
      app_version: app.getVersion(),
      codex_executable: resolveCodexExecutable(),
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
        await ensureMainWindow(
          getRendererUrl(),
          runtime,
          startupGate,
        );
        if (!showAndFocusMainWindow()) {
          throw new Error("TaskHubメインウィンドウを表示できません。");
        }
      },
    },
  });
}

function requireApplicationUpdateService(): ApplicationUpdateService {
  const service = applicationUpdateService;
  if (service == null) {
    throw new Error("アプリ本体の更新サービスが初期化されていません。");
  }
  return service;
}

function configureWindowSecurity(window: BrowserWindow, rendererUrl: string): void {
  window.webContents.on("will-navigate", (event, requestedUrl) => {
    if (!isApplicationUrl(requestedUrl, rendererUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on("will-redirect", (event, requestedUrl) => {
    if (!isApplicationUrl(requestedUrl, rendererUrl)) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const externalUrl = assertAllowedExternalUrl(url);
      void shell.openExternal(externalUrl.href).catch((error) => {
        recordPersistentError("main", "app.error", "external_url", "error", error);
        recordDiagnostic("app.error", "error", undefined, error);
      });
    } catch (error) {
      recordPersistentError("main", "app.error", "external_url", "error", error);
      recordDiagnostic("app.error", "error", undefined, error);
    }
    return { action: "deny" };
  });
}

function registerVersionIpcHandler(rendererUrl: string): void {
  ipcMain.handle(appGetVersionChannel, (event, payload: unknown): string => {
    try {
      z.undefined().parse(payload);

      const window = mainWindow;
      if (window == null) {
        throw new Error("メインウィンドウが初期化されていません。");
      }

      assertTrustedIpcSender(event, window.webContents, rendererUrl);
      return app.getVersion();
    } catch (error) {
      recordPersistentError("ipc", "ipc.error", "ipc_diagnostic", "error", error);
      throw error;
    }
  });
  versionIpcRegistered = true;
}

function disposeMainWindowRegistry(registry: IpcHandlerRegistry): void {
  try {
    registry.dispose();
  } catch (error) {
    recordPersistentError("main", "ipc.error", "registry_dispose", "error", error);
    recordDiagnostic("ipc.error", "error", undefined, error);
  }
  if (mainWindowRegistry === registry) {
    mainWindowRegistry = undefined;
  }
}

function enqueueBackgroundOperation(
  operation: () => Promise<void>,
  failureCode: DiagnosticRecord["code"],
): void {
  backgroundOperations = backgroundOperations.then(async () => {
    const controller = lifecycle.getRuntime();
    if (
      !lifecycle.isRunning()
      || controller == null
      || controller.signal.aborted
    ) {
      return;
    }
    try {
      await operation();
    } catch (error) {
      if (error instanceof AsanaSyncRuntimeAlreadyReportedError) {
        return;
      }
      const disposition = diagnosticFailureDispositionFromError(error);
      switch (disposition.kind) {
        case "recorded_only":
          return;
        case "unrecorded_only":
        case "recorded_and_unrecorded":
          recordPersistentError(
            "main",
            failureCode,
            "background_operation",
            "error",
            disposition.unrecorded_error,
          );
          if (!controller.signal.aborted) {
            recordDiagnostic(failureCode, "error", undefined, disposition.unrecorded_error);
          }
          return;
      }
    }
  });
}

function scheduleForegroundSync(): void {
  if (
    foregroundScheduled
    || !lifecycle.isRunning()
    || !startupGate.isReady()
  ) {
    return;
  }
  foregroundScheduled = true;
  enqueueBackgroundOperation(async () => {
    try {
      const application = lifecycle.getRuntime()?.legacy;
      const controller = lifecycle.getRuntime();
      if (application == null || controller == null) {
        throw new Error("アプリケーションが初期化されていません。");
      }
      if (application.getState().kind !== "configured") {
        return;
      }
      await application.onForeground(controller.signal);
    } finally {
      foregroundScheduled = false;
    }
  }, "sync.failed");
}

function updateOnlineMonitorState(
  monitor: Extract<OnlineMonitorState, { readonly kind: "running" }>,
  lastOnline: boolean,
): void {
  const activeMonitor = onlineMonitorState;
  if (
    activeMonitor.kind === "running"
    && activeMonitor.timer === monitor.timer
  ) {
    onlineMonitorState = {
      kind: "running",
      timer: monitor.timer,
      lastOnline,
    };
  }
}

function scheduleOnlinePoll(): void {
  if (
    onlinePollScheduled
    || !lifecycle.isRunning()
    || !startupGate.isReady()
  ) {
    return;
  }
  onlinePollScheduled = true;
  enqueueBackgroundOperation(async () => {
    try {
      const monitor = onlineMonitorState;
      const application = lifecycle.getRuntime()?.legacy;
      if (monitor.kind !== "running" || application == null) {
        return;
      }
      const currentOnline = net.isOnline();
      if (currentOnline === monitor.lastOnline) {
        return;
      }
      const applicationConfigured = application.getState().kind === "configured";
      if (!currentOnline) {
        if (applicationConfigured) {
          application.setOnline(false);
        }
        updateOnlineMonitorState(monitor, false);
        return;
      }
      if (!applicationConfigured) {
        updateOnlineMonitorState(monitor, true);
        return;
      }
      try {
        await application.onOnline();
      } catch (error) {
        try {
          application.setOnline(false);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "オンライン復帰失敗後の状態復元に失敗しました。",
          );
        }
        throw error;
      }
      updateOnlineMonitorState(monitor, true);
    } finally {
      onlinePollScheduled = false;
    }
  }, "sync.failed");
}

function startOperationalEventMonitoring(): void {
  if (onlineMonitorState.kind !== "stopped" || powerMonitorRegistered) {
    throw new Error("運用イベント監視は重複開始できません。");
  }
  const timer = setInterval(scheduleOnlinePoll, onlinePollIntervalMilliseconds);
  onlineMonitorState = {
    kind: "running",
    timer,
    lastOnline: net.isOnline(),
  };
  powerMonitor.on("resume", scheduleForegroundSync);
  powerMonitorRegistered = true;
}

function stopOperationalEventMonitoring(): void {
  const monitor = onlineMonitorState;
  if (monitor.kind === "running") {
    clearInterval(monitor.timer);
    onlineMonitorState = { kind: "stopped" };
  }
  if (powerMonitorRegistered) {
    powerMonitor.removeListener("resume", scheduleForegroundSync);
    powerMonitorRegistered = false;
  }
}

function showAndFocusMainWindow(): boolean {
  if (!lifecycle.isRunning()) {
    return false;
  }
  const window = mainWindow;
  if (window == null || window.isDestroyed()) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  window.focus();
  return true;
}

async function createMainWindow(
  rendererUrl: string,
  runtime: MainRuntime,
  gate: StartupGate,
): Promise<void> {
  const signal = runtime.signal;
  if (!lifecycle.isRunning() || signal.aborted) {
    return;
  }
  const windowStateStore = runtime.createWindowStateStore();
  const savedWindowState = windowStateStore.load();
  const window = new BrowserWindow({
    show: false,
    icon: app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(__dirname, "../../build/icon.png"),
    webPreferences: {
      devTools: !app.isPackaged,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/index.cjs"),
    },
  });
  const windowStateController = new WindowStateController(
    window,
    windowStateStore,
    () => {
      const primaryDisplay = screen.getPrimaryDisplay();
      return [
        primaryDisplay,
        ...screen.getAllDisplays().filter((display) => display.id !== primaryDisplay.id),
      ];
    },
    savedWindowState,
  );
  const updateService = requireApplicationUpdateService();
  const registry = new IpcHandlerRegistry({
    rendererWebContents: window.webContents,
    rendererUrl,
    ports: {
      ...runtime.legacy.getIpcPorts(),
      readModel: runtime.legacy.taskRead,
      sync: runtime.legacy.taskRead,
      appUpdate: updateService,
    },
    startupGate: gate,
    diagnostic: {
      record: (error) => {
        recordPersistentError("ipc", "ipc.error", "ipc_diagnostic", "error", error);
        recordDiagnostic("ipc.error", "error", undefined, error);
      },
    },
  });

  mainWindow = window;
  mainWindowStateController = windowStateController;
  mainWindowRegistry = registry;
  let readyToShow: MainWindowReadyWait | undefined;
  try {
    configureWindowSecurity(window, rendererUrl);
    registry.register(ipcMain);
    windowStateController.attach();
    windowStateController.restore(savedWindowState);
    window.on("focus", scheduleForegroundSync);
    window.on("close", (event) => {
      if (process.platform === "darwin" && lifecycle.isRunning()) {
        event.preventDefault();
        window.hide();
        return;
      }
      disposeMainWindowRegistry(registry);
    });
    window.once("closed", () => {
      if (mainWindowStateController === windowStateController) {
        mainWindowStateController = undefined;
      }
      if (mainWindow === window) {
        mainWindow = undefined;
      }
    });
    readyToShow = createMainWindowReadyWait(window, signal, showAndFocusMainWindow);
    const loadPromise = Promise.resolve().then(() => app.isPackaged
      ? window.loadFile(
        fileURLToPath(rendererUrl),
        { search: new URL(rendererUrl).search },
      )
      : window.loadURL(rendererUrl));
    await Promise.all([loadPromise, readyToShow.promise]);
  } catch (error) {
    readyToShow?.reject(error);
    disposeMainWindowRegistry(registry);
    if (mainWindowStateController === windowStateController) {
      mainWindowStateController = undefined;
    }
    if (mainWindow === window) {
      mainWindow = undefined;
    }
    if (!window.isDestroyed()) {
      window.destroy();
    }
    if (signal.aborted || !lifecycle.isRunning()) {
      return;
    }
    throw error;
  }
}

function ensureMainWindow(
  rendererUrl: string,
  runtime: MainRuntime,
  gate: StartupGate,
): Promise<void> {
  const signal = runtime.signal;
  if (!lifecycle.isRunning() || signal.aborted) {
    return Promise.resolve();
  }
  if (mainWindow != null && !mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  if (windowCreationPromise != null) {
    return windowCreationPromise;
  }
  windowCreationPromise = createMainWindow(
    rendererUrl,
    runtime,
    gate,
  ).finally(() => {
    windowCreationPromise = undefined;
  });
  return windowCreationPromise;
}

function yieldToRenderer(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function startApplication(
  application: LegacyRuntimePort,
  signal: AbortSignal,
): Promise<void> {
  try {
    await application.start(signal);
    if (signal.aborted || !lifecycle.isRunning()) {
      startupGate.markStopped();
      return;
    }
    startOperationalEventMonitoring();
    startupGate.markReady();
  } catch (error) {
    if (signal.aborted || !lifecycle.isRunning()) {
      startupGate.markStopped();
      return;
    }
    const disposition = mainDiagnosticFailureDisposition(error);
    switch (disposition.kind) {
      case "recorded_only":
        break;
      case "unrecorded_only":
      case "recorded_and_unrecorded":
        recordPersistentError(
          "main",
          "app.error",
          "bootstrap",
          "error",
          disposition.unrecorded_error,
        );
        recordDiagnostic("app.error", "error", undefined, disposition.unrecorded_error);
        break;
    }
    console.error("アプリケーションの起動に失敗しました。");
    startupGate.markFailed(disposition.response_error);
  }
}

async function stopApplication(): Promise<void> {
  const runtime = lifecycle.getRuntime();
  runtime?.abort();
  startupGate.markStopped();
  stopOperationalEventMonitoring();
  const registry = mainWindowRegistry;
  if (registry != null) {
    disposeMainWindowRegistry(registry);
  }
  if (versionIpcRegistered) {
    try {
      ipcMain.removeHandler(appGetVersionChannel);
    } catch (error) {
      recordPersistentError("main", "ipc.error", "application_stop", "error", error);
      recordDiagnostic("ipc.error", "error", undefined, error);
    }
    versionIpcRegistered = false;
  }
  const errors: unknown[] = [];
  const startPromise = applicationStartPromise;
  if (startPromise != null) {
    try {
      await startPromise;
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await backgroundOperations;
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
            recordPersistentError(
              "main",
              "app.error",
              "application_stop",
              "error",
              disposition.unrecorded_error,
            );
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
  const application = runtime.legacy;
  const updateService = new ApplicationUpdateService(
    autoUpdater,
    app.getVersion(),
    isApplicationUpdateCandidate(
      app.isPackaged,
      process.platform,
      process.arch,
      app.getVersion(),
      process.resourcesPath,
    ),
    process.platform,
    process.resourcesPath,
    runtime.createApplicationUpdateAttemptStore(),
    (error) => {
      recordPersistentError("main", "app.error", "application_update", "error", error);
    },
  );
  applicationUpdateService = updateService;
  registerVersionIpcHandler(rendererUrl);
  app.on("activate", () => {
    if (!showAndFocusMainWindow() && BrowserWindow.getAllWindows().length === 0) {
      void ensureMainWindow(
        rendererUrl,
        runtime,
        startupGate,
      ).catch((error) => {
        if (runtime.signal.aborted || !lifecycle.isRunning()) {
          return;
        }
        recordPersistentError("main", "app.error", "main_window", "error", error);
        recordDiagnostic("app.error", "error", undefined, error);
      });
    }
  });
  await ensureMainWindow(
    rendererUrl,
    runtime,
    startupGate,
  );
  await yieldToRenderer();
  if (runtime.signal.aborted || !lifecycle.isRunning()) {
    return;
  }
  updateService.start();
  applicationStartPromise = startApplication(application, runtime.signal);
  await applicationStartPromise;
}

const lifecycle = registerMainLifecycle(app, {
  bootstrap,
  stop: stopApplication,
  flushWindowState: () => mainWindowStateController?.flush(),
  installUpdateOnQuit: (quit) => applicationUpdateService?.installOnQuit(quit) === true,
  showSecondInstance: showAndFocusMainWindow,
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
