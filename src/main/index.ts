import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  session,
  shell,
} from "electron";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import type { DiagnosticRecord } from "./application/diagnostics";
import { TaskHubApplication } from "./application/service";
import { resolveCodexExecutable } from "./codex/app-server";
import { IpcHandlerRegistry } from "./ipc";
import { ensureSecureUserDataDirectory } from "./local-storage-path";
import { obsidianOpenUriInputSchema } from "./obsidian/obsidian-uri";
import {
  PersistentErrorLog,
  type PersistentErrorLogContext,
  type PersistentErrorLogSource,
  writePersistentErrorLogFailure,
} from "./persistent-error-log";
import {
  assertAllowedAsanaAuthorizationUrl,
  assertAllowedCodexAuthorizationUrl,
  assertAllowedExternalUrl,
  assertTrustedIpcSender,
  isApplicationUrl,
} from "./security";

const appGetVersionChannel = "app:get-version";
const onlinePollIntervalMilliseconds = 2_000;
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;
const resolvedAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "解決済みパスは絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "解決済みパスにNUL文字を指定できません。");

type ShutdownState =
  | { readonly kind: "running" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stopped" };

type OnlineMonitorState =
  | { readonly kind: "stopped" }
  | {
      readonly kind: "running";
      readonly timer: ReturnType<typeof setInterval>;
      readonly lastOnline: boolean;
    };

let mainWindow: BrowserWindow | undefined;
let mainWindowRegistry: IpcHandlerRegistry | undefined;
let taskHubApplication: TaskHubApplication | undefined;
let lifecycleController: AbortController | undefined;
let windowCreationPromise: Promise<void> | undefined;
let backgroundOperations: Promise<void> = Promise.resolve();
let shutdownState: ShutdownState = { kind: "running" };
let onlineMonitorState: OnlineMonitorState = { kind: "stopped" };
let foregroundScheduled = false;
let onlinePollScheduled = false;
let powerMonitorRegistered = false;
let versionIpcRegistered = false;
let persistentErrorLog: PersistentErrorLog | undefined;
let uncaughtExceptionMonitorRegistered = false;

registerUncaughtExceptionMonitor();
const singleInstanceLockAcquired = app.requestSingleInstanceLock();

function createPersistentErrorLog(): PersistentErrorLog | undefined {
  try {
    return new PersistentErrorLog(app.getPath("logs"));
  } catch (error) {
    writePersistentErrorLogFailure(error);
    return undefined;
  }
}

function getPersistentErrorLog(): PersistentErrorLog | undefined {
  const logger = persistentErrorLog;
  if (logger != null) {
    return logger;
  }
  const createdLogger = createPersistentErrorLog();
  persistentErrorLog = createdLogger;
  if (createdLogger != null) {
    registerUncaughtExceptionMonitor();
  }
  return createdLogger;
}

function recordPersistentError(
  source: PersistentErrorLogSource,
  diagnosticCode: DiagnosticRecord["code"],
  context: PersistentErrorLogContext,
  error: unknown,
): void {
  const logger = getPersistentErrorLog();
  if (logger == null) {
    return;
  }
  logger.record(source, diagnosticCode, context, error);
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
      error,
    );
  });
  uncaughtExceptionMonitorRegistered = true;
}

function recordDiagnostic(
  code: DiagnosticRecord["code"],
  severity: DiagnosticRecord["severity"],
): void {
  const application = taskHubApplication;
  if (application == null) {
    console.error("診断情報を記録できませんでした。");
    return;
  }
  try {
    application.recordDiagnostic(code, severity);
  } catch (error) {
    recordPersistentError("main", "storage.error", "diagnostic_storage", error);
    console.error("診断情報を記録できませんでした。");
  }
}

function recordServiceDiagnostic(error: unknown, channel: string): void {
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
    case "application_journal":
      diagnosticCode = "proposal.application";
      break;
    case "ipc":
    case "sync_state_listener":
    case "ai_status_listener":
      diagnosticCode = "ipc.error";
      break;
    default:
      diagnosticCode = "app.error";
  }
  recordPersistentError("service", diagnosticCode, "service_diagnostic", error);
  recordDiagnostic(diagnosticCode, "error");
}

function getRendererUrl(): string {
  if (app.isPackaged) {
    return pathToFileURL(join(__dirname, "../renderer/index.html")).href;
  }

  if (developmentRendererUrl == null) {
    throw new Error("開発用Renderer URLが設定されていません。");
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(developmentRendererUrl);
  } catch (error) {
    throw new Error("開発用Renderer URLが不正です。", { cause: error });
  }
  if (
    parsedUrl.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)
  ) {
    throw new Error("開発用Renderer URLはローカルHTTP URLでなければなりません。");
  }

  return parsedUrl.href;
}

function getContentSecurityPolicy(): string {
  if (app.isPackaged) {
    return [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:* http://[::1]:* ws://[::1]:*",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function configureContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [getContentSecurityPolicy()],
      },
    });
  });
}

function configurePermissionPolicy(): void {
  const applicationSession = session.defaultSession;
  applicationSession.setPermissionCheckHandler(() => false);
  applicationSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      void webContents;
      void permission;
      callback(false);
    },
  );
  applicationSession.setDevicePermissionHandler(() => false);
}

async function openAuthorizedExternalUrl(
  rawUrl: string,
  signal: AbortSignal,
  validate: (value: string) => URL,
): Promise<void> {
  signal.throwIfAborted();
  const validatedUrl = validate(rawUrl);
  await shell.openExternal(validatedUrl.href);
  signal.throwIfAborted();
}

async function openResolvedPath(
  rawPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const absolutePath = resolvedAbsolutePathSchema.parse(rawPath);
  const result = await shell.openPath(absolutePath);
  if (result !== "") {
    throw new Error("ローカルパスを開けませんでした。");
  }
  signal.throwIfAborted();
}

function validateObsidianOpenUri(rawUri: string): URL {
  const parsedUrl = new URL(rawUri);
  if (
    parsedUrl.protocol !== "obsidian:"
    || parsedUrl.host !== "open"
    || parsedUrl.username !== ""
    || parsedUrl.password !== ""
    || parsedUrl.port !== ""
    || parsedUrl.pathname !== ""
    || parsedUrl.hash !== ""
  ) {
    throw new Error("Obsidian URIが不正です。");
  }
  const entries = [...parsedUrl.searchParams.entries()];
  const keys = new Set(entries.map(([key]) => key));
  if (
    entries.length !== 2
    || keys.size !== 2
    || !keys.has("vault")
    || !keys.has("file")
  ) {
    throw new Error("Obsidian URIのqueryが不正です。");
  }
  const vaultValues = parsedUrl.searchParams.getAll("vault");
  const fileValues = parsedUrl.searchParams.getAll("file");
  if (vaultValues.length !== 1 || fileValues.length !== 1) {
    throw new Error("Obsidian URIのqueryが重複しています。");
  }
  const vaultId = vaultValues[0];
  const relativePath = fileValues[0];
  if (vaultId == null || relativePath == null) {
    throw new Error("Obsidian URIのquery値が不正です。");
  }
  obsidianOpenUriInputSchema.parse({
    vault_id: vaultId,
    relative_path: relativePath,
  });
  return parsedUrl;
}

async function openObsidianUrl(
  rawUrl: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const validatedUrl = validateObsidianOpenUri(rawUrl);
  await shell.openExternal(validatedUrl.href);
  signal.throwIfAborted();
}

function createTaskHubApplication(controller: AbortController): TaskHubApplication {
  const userDataPath = ensureSecureUserDataDirectory(app.getPath("userData"));
  return new TaskHubApplication({
    user_data_path: userDataPath,
    database_path: join(userDataPath, "taskhub.sqlite3"),
    secret_storage_path: join(userDataPath, "secret-storage.json"),
    checkpoint_path: join(userDataPath, "setup-checkpoint.json"),
    app_version: app.getVersion(),
    codex_executable: resolveCodexExecutable(),
    read_only_vault_paths: [],
    lifecycle_signal: controller.signal,
    online_provider: () => net.isOnline(),
    now_provider: () => new Date(),
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
      openObsidianUrl(obsidianUrl, signal),
    open_path: (absolutePath, signal) => openResolvedPath(absolutePath, signal),
    notify_unexpected_error: (error) => {
      recordPersistentError("service", "app.error", "service_diagnostic", error);
      recordDiagnostic("app.error", "error");
    },
    diagnostic: recordServiceDiagnostic,
  });
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
        recordPersistentError("main", "app.error", "external_url", error);
        recordDiagnostic("app.error", "error");
      });
    } catch (error) {
      recordPersistentError("main", "app.error", "external_url", error);
      recordDiagnostic("app.error", "error");
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
      recordPersistentError("ipc", "ipc.error", "ipc_diagnostic", error);
      throw error;
    }
  });
  versionIpcRegistered = true;
}

function disposeMainWindowRegistry(registry: IpcHandlerRegistry): void {
  try {
    registry.dispose();
  } catch (error) {
    recordPersistentError("main", "ipc.error", "registry_dispose", error);
    recordDiagnostic("ipc.error", "error");
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
    const controller = lifecycleController;
    if (
      shutdownState.kind !== "running"
      || controller == null
      || controller.signal.aborted
    ) {
      return;
    }
    try {
      await operation();
    } catch (error) {
      recordPersistentError("main", failureCode, "background_operation", error);
      if (!controller.signal.aborted) {
        recordDiagnostic(failureCode, "error");
      }
    }
  });
}

function scheduleForegroundSync(): void {
  if (foregroundScheduled || shutdownState.kind !== "running") {
    return;
  }
  foregroundScheduled = true;
  enqueueBackgroundOperation(async () => {
    try {
      const application = taskHubApplication;
      const controller = lifecycleController;
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
  if (onlinePollScheduled || shutdownState.kind !== "running") {
    return;
  }
  onlinePollScheduled = true;
  enqueueBackgroundOperation(async () => {
    try {
      const monitor = onlineMonitorState;
      const application = taskHubApplication;
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
  if (shutdownState.kind !== "running") {
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
  application: TaskHubApplication,
): Promise<void> {
  if (shutdownState.kind !== "running") {
    return;
  }
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
  const registry = new IpcHandlerRegistry({
    rendererWebContents: window.webContents,
    rendererUrl,
    ports: application.getIpcPorts(),
    diagnostic: {
      record: (error) => {
        recordPersistentError("ipc", "ipc.error", "ipc_diagnostic", error);
        recordDiagnostic("ipc.error", "error");
      },
    },
  });

  mainWindow = window;
  mainWindowRegistry = registry;
  try {
    configureWindowSecurity(window, rendererUrl);
    registry.register(ipcMain);
    window.once("ready-to-show", () => {
      if (!window.isDestroyed()) {
        showAndFocusMainWindow();
      }
    });
    window.on("focus", scheduleForegroundSync);
    window.on("close", (event) => {
      if (process.platform === "darwin" && shutdownState.kind === "running") {
        event.preventDefault();
        window.hide();
        return;
      }
      disposeMainWindowRegistry(registry);
    });
    window.once("closed", () => {
      if (mainWindow === window) {
        mainWindow = undefined;
      }
    });
    if (app.isPackaged) {
      await window.loadFile(fileURLToPath(rendererUrl));
    } else {
      await window.loadURL(rendererUrl);
    }
  } catch (error) {
    disposeMainWindowRegistry(registry);
    if (mainWindow === window) {
      mainWindow = undefined;
    }
    if (!window.isDestroyed()) {
      window.destroy();
    }
    throw error;
  }
}

function ensureMainWindow(
  rendererUrl: string,
  application: TaskHubApplication,
): Promise<void> {
  if (shutdownState.kind !== "running") {
    return Promise.resolve();
  }
  if (mainWindow != null && !mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  if (windowCreationPromise != null) {
    return windowCreationPromise;
  }
  windowCreationPromise = createMainWindow(rendererUrl, application).finally(() => {
    windowCreationPromise = undefined;
  });
  return windowCreationPromise;
}

async function stopApplication(): Promise<void> {
  lifecycleController?.abort();
  stopOperationalEventMonitoring();
  const registry = mainWindowRegistry;
  if (registry != null) {
    disposeMainWindowRegistry(registry);
  }
  if (versionIpcRegistered) {
    try {
      ipcMain.removeHandler(appGetVersionChannel);
    } catch (error) {
      recordPersistentError("main", "ipc.error", "application_stop", error);
      recordDiagnostic("ipc.error", "error");
    }
    versionIpcRegistered = false;
  }
  await backgroundOperations;
  const application = taskHubApplication;
  if (application != null) {
    try {
      await application.stop();
    } catch (error) {
      recordPersistentError("main", "app.error", "application_stop", error);
      recordDiagnostic("app.error", "error");
      console.error("アプリケーションの停止に失敗しました。");
    }
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  configureContentSecurityPolicy();
  configurePermissionPolicy();
  const rendererUrl = getRendererUrl();
  const controller = new AbortController();
  lifecycleController = controller;
  const application = createTaskHubApplication(controller);
  taskHubApplication = application;
  await application.start(controller.signal);
  registerVersionIpcHandler(rendererUrl);
  startOperationalEventMonitoring();
  await ensureMainWindow(rendererUrl, application);

  app.on("activate", () => {
    if (!showAndFocusMainWindow() && BrowserWindow.getAllWindows().length === 0) {
      void ensureMainWindow(rendererUrl, application).catch((error) => {
        recordPersistentError("main", "app.error", "main_window", error);
        recordDiagnostic("app.error", "error");
      });
    }
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (shutdownState.kind === "stopped") {
    return;
  }
  event.preventDefault();
  if (shutdownState.kind === "stopping") {
    return;
  }
  shutdownState = { kind: "stopping" };
  void stopApplication().then(() => {
    shutdownState = { kind: "stopped" };
    app.quit();
  }).catch((error) => {
    recordPersistentError("main", "app.error", "application_quit", error);
    recordDiagnostic("app.error", "error");
    console.error("アプリケーションの停止に失敗しました。");
    shutdownState = { kind: "stopped" };
    app.quit();
  });
});

if (!singleInstanceLockAcquired) {
  shutdownState = { kind: "stopped" };
  app.quit();
} else {
  app.on("second-instance", showAndFocusMainWindow);
  void bootstrap().catch((error) => {
    recordPersistentError("main", "app.error", "bootstrap", error);
    recordDiagnostic("app.error", "error");
    console.error("アプリケーションの起動に失敗しました。");
    app.quit();
  });
}
