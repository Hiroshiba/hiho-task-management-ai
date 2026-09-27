import type { App } from "electron";
import type { MainRuntime } from "./create-main-runtime";

type ShutdownState =
  | { readonly kind: "running" }
  | { readonly kind: "stopping" }
  | { readonly kind: "stopped" };

type MainLifecycleHooks = {
  readonly bootstrap: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly flushWindowState: () => void;
  readonly installUpdateOnQuit: (quit: () => void) => boolean;
  readonly showSecondInstance: () => void;
  readonly reportBootstrapFailure: (error: unknown) => void;
  readonly reportStopFailure: (error: unknown) => void;
};

/** Electronライフサイクルの状態とMainRuntimeの参照を管理します。 */
export interface MainLifecycleRegistration {
  isRunning(): boolean;
  getRuntime(): MainRuntime | undefined;
  setRuntime(runtime: MainRuntime): void;
}

/** Electronの単一起動、終了、再起動時の処理順を登録します。 */
export function registerMainLifecycle(
  app: App,
  hooks: MainLifecycleHooks,
): MainLifecycleRegistration {
  let state: ShutdownState = { kind: "running" };
  let runtime: MainRuntime | undefined;

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
      if (hooks.installUpdateOnQuit(() => app.quit())) {
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
    getRuntime: () => runtime,
    setRuntime: (createdRuntime) => {
      if (runtime != null) {
        throw new Error("MainRuntimeは既に初期化されています。");
      }
      runtime = createdRuntime;
    },
  };
}
