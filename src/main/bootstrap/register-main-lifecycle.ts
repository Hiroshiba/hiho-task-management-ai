import type { App } from "electron";
import type { ApplicationUpdateService } from "./application-update-service";
import type { MainRuntime } from "./create-main-runtime";
import { createStartupGate, type StartupGate } from "./startup-gate";

type ShutdownState =
  | { readonly kind: "running" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stopped" };

type MainLifecycleHooks = {
  readonly bootstrap: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly flushWindowState: () => void;
  readonly showSecondInstance: () => void;
  readonly reportUncaughtException: (error: Error) => void;
  readonly reportBootstrapFailure: (error: unknown) => void;
  readonly reportStopFailure: (error: unknown) => void;
};

/** Electronライフサイクルの状態とMainRuntimeの参照を管理します。 */
export interface MainLifecycleRegistration {
  isRunning(): boolean;
  readonly startupGate: StartupGate;
  getRuntime(): MainRuntime | undefined;
  setRuntime(runtime: MainRuntime): void;
  getUpdateService(): ApplicationUpdateService | undefined;
  setUpdateService(service: ApplicationUpdateService): void;
  startApplication(start: () => Promise<void>): Promise<void>;
  waitForApplicationStart(): Promise<void>;
}

/** Electronの単一起動、終了、再起動時の処理順を登録します。 */
export function registerMainLifecycle(
  app: App,
  hooks: MainLifecycleHooks,
): MainLifecycleRegistration {
  let state: ShutdownState = { kind: "running" };
  let runtime: MainRuntime | undefined;
  let applicationUpdateService: ApplicationUpdateService | undefined;
  let applicationStartPromise: Promise<void> | undefined;
  const startupGate = createStartupGate();
  const reportUncaughtException = (error: Error): void => hooks.reportUncaughtException(error);
  process.on("uncaughtExceptionMonitor", reportUncaughtException);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", (event) => {
    if (state.kind === "stopped") {
      return;
    }
    event.preventDefault();
    if (state.kind === "stopping") {
      return;
    }
    hooks.flushWindowState();
    state = { kind: "stopping" };
    void hooks.stop().then(() => {
      state = { kind: "stopped" };
      if (applicationUpdateService?.installOnQuit(() => app.quit()) === true) {
        return;
      }
      app.quit();
    }).catch((error) => {
      hooks.reportStopFailure(error);
      state = { kind: "stopped" };
      app.quit();
    });
  });

  app.on("will-quit", () => {
    process.removeListener("uncaughtExceptionMonitor", reportUncaughtException);
    applicationUpdateService?.dispose();
    runtime?.closeLateFiles();
  });

  if (!app.requestSingleInstanceLock()) {
    state = { kind: "stopped" };
    app.quit();
  } else {
    app.on("second-instance", hooks.showSecondInstance);
    void hooks.bootstrap().catch((error) => {
      hooks.reportBootstrapFailure(error);
      app.quit();
    });
  }

  return {
    isRunning: () => state.kind === "running",
    startupGate,
    getRuntime: () => runtime,
    setRuntime: (createdRuntime) => {
      if (runtime != null) {
        throw new Error("MainRuntimeは既に初期化されています。");
      }
      runtime = createdRuntime;
    },
    getUpdateService: () => applicationUpdateService,
    setUpdateService: (service) => {
      if (applicationUpdateService != null) {
        throw new Error("アプリ本体の更新サービスは既に初期化されています。");
      }
      applicationUpdateService = service;
    },
    startApplication: (start) => {
      if (applicationStartPromise != null) {
        throw new Error("アプリケーションの起動は既に開始されています。");
      }
      applicationStartPromise = start();
      return applicationStartPromise;
    },
    waitForApplicationStart: async () => {
      if (applicationStartPromise != null) {
        await applicationStartPromise;
      }
    },
  };
}
