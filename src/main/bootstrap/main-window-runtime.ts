import type { App, BrowserWindow as BrowserWindowType, IpcMain, Screen, Shell, WebContents } from "electron";
import { BrowserWindow } from "electron";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MainRuntime } from "./create-main-runtime";
import { createMainWindowReadyWait, type MainWindowReadyWait } from "./main-window-readiness";
import { assertAllowedExternalUrl, isApplicationUrl } from "./security";
import { WindowStateController } from "./window-state-controller";

type MainWindowDependencies = {
  readonly app: App;
  readonly ipcMain: IpcMain;
  readonly screen: Screen;
  readonly shell: Shell;
  readonly isRunning: () => boolean;
  readonly scheduleForegroundSync: () => void;
  readonly reportPersistentError: (context: "external_url" | "registry_dispose", error: unknown) => void;
  readonly recordDiagnostic: (code: "app.error" | "ipc.error", error: unknown) => void;
};

/** メインウィンドウの生成、再表示、状態保存を管理します。 */
export class MainWindowRuntime {
  private mainWindow: BrowserWindowType | undefined;
  private mainWindowStateController: WindowStateController | undefined;
  private windowCreationPromise: Promise<void> | undefined;
  private stopped = false;

  public constructor(private readonly dependencies: MainWindowDependencies) {}

  /** 存在するメインウィンドウを表示して前面へ移します。 */
  public showAndFocus(): boolean {
    if (this.stopped || !this.dependencies.isRunning()) {
      return false;
    }
    const window = this.mainWindow;
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

  /** メインウィンドウがなければ生成し、表示完了まで待ちます。 */
  public ensure(rendererUrl: string, runtime: MainRuntime): Promise<void> {
    if (this.stopped || !this.dependencies.isRunning() || runtime.signal.aborted) {
      return Promise.resolve();
    }
    if (this.mainWindow != null && !this.mainWindow.isDestroyed()) {
      return Promise.resolve();
    }
    if (this.windowCreationPromise != null) {
      return this.windowCreationPromise;
    }
    this.windowCreationPromise = this.create(rendererUrl, runtime).finally(() => {
      this.windowCreationPromise = undefined;
    });
    return this.windowCreationPromise;
  }

  /** 保留中のウィンドウ状態を保存します。 */
  public flush(): void {
    this.mainWindowStateController?.flush();
  }

  /** IPC接続とウィンドウを終了し、生成中の処理を待ちます。 */
  public async stop(): Promise<void> {
    this.stopped = true;
    const window = this.mainWindow;
    if (window != null && !window.isDestroyed()) {
      window.destroy();
    }
    await this.windowCreationPromise;
  }

  private configureSecurity(window: BrowserWindowType, rendererUrl: string): void {
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
        void this.dependencies.shell.openExternal(externalUrl.href).catch((error) => {
          this.dependencies.reportPersistentError("external_url", error);
          this.dependencies.recordDiagnostic("app.error", error);
        });
      } catch (error) {
        this.dependencies.reportPersistentError("external_url", error);
        this.dependencies.recordDiagnostic("app.error", error);
      }
      return { action: "deny" };
    });
  }

  private detach(runtime: MainRuntime, webContents: WebContents): void {
    try {
      runtime.detachWindow(webContents);
    } catch (error) {
      this.dependencies.reportPersistentError("registry_dispose", error);
      this.dependencies.recordDiagnostic("ipc.error", error);
    }
  }

  private async create(rendererUrl: string, runtime: MainRuntime): Promise<void> {
    const signal = runtime.signal;
    if (this.stopped || !this.dependencies.isRunning() || signal.aborted) {
      return;
    }
    const windowStateStore = runtime.createWindowStateStore();
    const savedWindowState = windowStateStore.load();
    const window = new BrowserWindow({
      show: false,
      icon: this.dependencies.app.isPackaged
        ? join(process.resourcesPath, "icon.png")
        : join(__dirname, "../../build/icon.png"),
      webPreferences: {
        devTools: !this.dependencies.app.isPackaged,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        preload: join(__dirname, "../preload/index.cjs"),
      },
    });
    const windowWebContents = window.webContents;
    const windowStateController = new WindowStateController(
      window,
      windowStateStore,
      () => {
        const primaryDisplay = this.dependencies.screen.getPrimaryDisplay();
        return [
          primaryDisplay,
          ...this.dependencies.screen.getAllDisplays().filter((display) => display.id !== primaryDisplay.id),
        ];
      },
      savedWindowState,
    );
    this.mainWindow = window;
    this.mainWindowStateController = windowStateController;
    window.once("closed", () => {
      this.detach(runtime, windowWebContents);
      window.removeListener("focus", this.dependencies.scheduleForegroundSync);
      if (this.mainWindowStateController === windowStateController) {
        this.mainWindowStateController = undefined;
      }
      if (this.mainWindow === window) {
        this.mainWindow = undefined;
      }
    });
    let readyToShow: MainWindowReadyWait | undefined;
    try {
      this.configureSecurity(window, rendererUrl);
      runtime.attachWindow(this.dependencies.ipcMain, windowWebContents, rendererUrl);
      windowStateController.attach();
      windowStateController.restore(savedWindowState);
      window.on("focus", this.dependencies.scheduleForegroundSync);
      window.on("close", (event) => {
        if (process.platform === "darwin" && this.dependencies.isRunning()) {
          event.preventDefault();
          window.hide();
          return;
        }
      });
      readyToShow = createMainWindowReadyWait(window, signal, () => this.showAndFocus());
      const loadPromise = Promise.resolve().then(() => this.dependencies.app.isPackaged
        ? window.loadFile(
          fileURLToPath(rendererUrl),
          { search: new URL(rendererUrl).search },
        )
        : window.loadURL(rendererUrl));
      await Promise.all([loadPromise, readyToShow.promise]);
    } catch (error) {
      readyToShow?.reject(error);
      if (!window.isDestroyed()) {
        window.destroy();
      }
      if (signal.aborted || this.stopped || !this.dependencies.isRunning()) {
        return;
      }
      throw error;
    }
  }
}
