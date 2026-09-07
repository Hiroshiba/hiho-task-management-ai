import type {
  BrowserWindow,
  Display,
  Event,
  Input,
  Rectangle,
} from "electron";
import { z } from "zod";
import {
  captureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
  readSecurePersistentTextFile,
  writeSecurePersistentTextFileAtomically,
} from "./local-storage-path";

const windowStateVersion = 1;
const windowStateSaveDebounceMilliseconds = 150;

const windowBoundsSchema = z
  .object({
    x: z.number().finite().int(),
    y: z.number().finite().int(),
    width: z.number().finite().int().positive(),
    height: z.number().finite().int().positive(),
  })
  .strict();

const normalWindowModeSchema = z.enum(["normal", "maximized"]);

const windowStateSchema = z.discriminatedUnion("mode", [
  z
    .object({
      version: z.literal(windowStateVersion),
      mode: z.literal("normal"),
      bounds: windowBoundsSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(windowStateVersion),
      mode: z.literal("maximized"),
      bounds: windowBoundsSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(windowStateVersion),
      mode: z.literal("fullscreen"),
      restore_mode: normalWindowModeSchema,
      bounds: windowBoundsSchema,
    })
    .strict(),
]);

type WindowState = z.infer<typeof windowStateSchema>;
type NormalWindowMode = z.infer<typeof normalWindowModeSchema>;

function serializeWindowState(state: WindowState): string {
  return JSON.stringify(windowStateSchema.parse(state));
}

function parseWindowState(serialized: string): WindowState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error("ウィンドウ状態のJSONが不正です。", { cause: error });
  }
  try {
    return windowStateSchema.parse(parsed);
  } catch (error) {
    throw new Error("ウィンドウ状態の内容が不正です。", { cause: error });
  }
}

function intersectionArea(left: Rectangle, right: Rectangle): number {
  const width = Math.min(left.x + left.width, right.x + right.width)
    - Math.max(left.x, right.x);
  const height = Math.min(left.y + left.height, right.y + right.height)
    - Math.max(left.y, right.y);
  if (width <= 0 || height <= 0) {
    return 0;
  }
  return width * height;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function displayForBounds(
  bounds: Rectangle,
  displays: readonly Display[],
): Display {
  if (displays.length === 0) {
    throw new Error("表示領域が見つかりません。");
  }
  let selected = displays[0];
  if (selected == null) {
    throw new Error("表示領域を選択できません。");
  }
  let selectedArea = intersectionArea(bounds, selected.workArea);
  for (const display of displays.slice(1)) {
    const area = intersectionArea(bounds, display.workArea);
    if (area > selectedArea) {
      selected = display;
      selectedArea = area;
    }
  }
  return selected;
}

function constrainBounds(
  bounds: Rectangle,
  display: Display,
): Rectangle {
  const workArea = display.workArea;
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const minimumX = workArea.x;
  const maximumX = workArea.x + workArea.width - width;
  const minimumY = workArea.y;
  const maximumY = workArea.y + workArea.height - height;
  return {
    x: clamp(bounds.x, minimumX, maximumX),
    y: clamp(bounds.y, minimumY, maximumY),
    width,
    height,
  };
}

function constrainWindowState(
  state: WindowState,
  displays: readonly Display[],
): WindowState {
  const display = displayForBounds(state.bounds, displays);
  const bounds = constrainBounds(state.bounds, display);
  return windowStateSchema.parse({ ...state, bounds });
}

/** ウィンドウ状態を安全なJSONとして保存・読み込みします。 */
export class WindowStateStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = normalizeSecurePersistentFilePath(filePath);
    captureSecurePersistentFile(this.filePath, "ウィンドウ状態");
  }

  /** 保存済みウィンドウ状態を検証して読み出します。 */
  public load(): WindowState | undefined {
    const serialized = readSecurePersistentTextFile(this.filePath, "ウィンドウ状態");
    if (serialized == null) {
      return undefined;
    }
    return parseWindowState(serialized);
  }

  /** ウィンドウ状態を原子的に保存します。 */
  public save(state: WindowState): void {
    writeSecurePersistentTextFileAtomically(
      this.filePath,
      serializeWindowState(state),
      "ウィンドウ状態",
    );
  }
}

function normalModeForWindow(window: BrowserWindow): NormalWindowMode {
  return window.isMaximized() ? "maximized" : "normal";
}

function stateWithMode(
  mode: NormalWindowMode,
  bounds: Rectangle,
): WindowState {
  return windowStateSchema.parse({
    version: windowStateVersion,
    mode,
    bounds,
  });
}

function normalModeForState(state: WindowState): NormalWindowMode {
  switch (state.mode) {
    case "normal":
      return "normal";
    case "maximized":
      return "maximized";
    case "fullscreen":
      return state.restore_mode;
  }
}

function fullscreenState(
  restoreMode: NormalWindowMode,
  bounds: Rectangle,
): WindowState {
  return windowStateSchema.parse({
    version: windowStateVersion,
    mode: "fullscreen",
    restore_mode: restoreMode,
    bounds,
  });
}

/** BrowserWindowの状態を保存し、指定されたショートカットを処理します。 */
export class WindowStateController {
  private readonly window: BrowserWindow;
  private readonly store: WindowStateStore;
  private readonly displaysProvider: () => readonly Display[];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private currentWindowState: WindowState;
  private fullscreenTransition: "entering" | "leaving" | undefined;

  public constructor(
    window: BrowserWindow,
    store: WindowStateStore,
    displaysProvider: () => readonly Display[],
    initialState: WindowState | undefined,
  ) {
    this.window = window;
    this.store = store;
    this.displaysProvider = displaysProvider;
    this.currentWindowState = initialState
      ?? stateWithMode("normal", { ...window.getBounds() });
  }

  /** 保存済み状態をウィンドウへ復元します。 */
  public restore(initialState: WindowState | undefined): void {
    if (initialState == null) {
      return;
    }
    const state = constrainWindowState(initialState, this.displaysProvider());
    this.currentWindowState = state;
    this.fullscreenTransition = state.mode === "fullscreen" ? "entering" : undefined;
    this.window.setBounds(state.bounds);
    switch (state.mode) {
      case "normal":
        return;
      case "maximized":
        this.window.maximize();
        return;
      case "fullscreen":
        if (state.restore_mode === "maximized") {
          this.window.maximize();
        }
        this.window.setFullScreen(true);
        return;
    }
  }

  /** BrowserWindowの状態保存とショートカット処理を開始します。 */
  public attach(): void {
    this.window.on("move", this.handleBoundsChanged);
    this.window.on("resize", this.handleBoundsChanged);
    this.window.on("maximize", this.handleMaximize);
    this.window.on("unmaximize", this.handleUnmaximize);
    this.window.on("enter-full-screen", this.handleEnterFullScreen);
    this.window.on("leave-full-screen", this.handleLeaveFullScreen);
    this.window.on("close", this.handleClose);
    this.window.once("closed", this.handleClosed);
    this.window.webContents.on("before-input-event", this.handleBeforeInputEvent);
  }

  /** 保留中のウィンドウ状態を直ちに保存します。 */
  public flush(): void {
    this.clearSaveTimer();
    if (this.disposed || this.window.isDestroyed()) {
      return;
    }
    this.store.save(this.currentWindowState);
  }

  private readonly handleBoundsChanged = (): void => {
    if (this.canCaptureNormalBounds()) {
      this.currentWindowState = stateWithMode(
        normalModeForState(this.currentWindowState),
        { ...this.window.getBounds() },
      );
    }
    this.scheduleSave();
  };

  private readonly scheduleSave = (): void => {
    if (this.disposed || this.window.isDestroyed()) {
      return;
    }
    this.clearSaveTimer();
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, windowStateSaveDebounceMilliseconds);
  };

  private readonly handleMaximize = (): void => {
    if (
      this.fullscreenTransition === "entering"
      || this.window.isFullScreen()
      || this.currentWindowState.mode === "fullscreen"
    ) {
      return;
    }
    this.currentWindowState = stateWithMode("maximized", this.currentWindowState.bounds);
    this.scheduleSave();
  };

  private readonly handleUnmaximize = (): void => {
    if (
      this.fullscreenTransition === "entering"
      || this.window.isFullScreen()
      || this.currentWindowState.mode === "fullscreen"
    ) {
      return;
    }
    this.currentWindowState = stateWithMode("normal", this.currentWindowState.bounds);
    this.scheduleSave();
  };

  private readonly handleEnterFullScreen = (): void => {
    if (this.currentWindowState.mode !== "fullscreen") {
      this.currentWindowState = fullscreenState(
        normalModeForState(this.currentWindowState),
        this.currentWindowState.bounds,
      );
    }
    this.fullscreenTransition = undefined;
    this.scheduleSave();
  };

  private readonly handleLeaveFullScreen = (): void => {
    if (this.currentWindowState.mode !== "fullscreen") {
      throw new Error("全画面解除時のウィンドウ状態が不正です。");
    }
    const restoreMode = this.currentWindowState.restore_mode;
    this.currentWindowState = stateWithMode(
      restoreMode,
      this.currentWindowState.bounds,
    );
    this.fullscreenTransition = undefined;
    if (restoreMode === "maximized" && !this.window.isMaximized()) {
      this.window.maximize();
    }
    this.scheduleSave();
  };

  private readonly handleClose = (): void => {
    this.flush();
  };

  private readonly handleClosed = (): void => {
    this.disposed = true;
    this.clearSaveTimer();
  };

  private readonly handleBeforeInputEvent = (
    event: Event,
    input: Input,
  ): void => {
    if (
      !this.window.isFocused()
      || input.type !== "keyDown"
      || input.isAutoRepeat
      || input.isComposing
    ) {
      return;
    }
    if (this.isMaximizeShortcut(input)) {
      if (this.toggleMaximize()) {
        event.preventDefault();
      }
      return;
    }
    if (this.isFullscreenShortcut(input) && this.toggleFullscreen()) {
      event.preventDefault();
    }
  };

  private isMaximizeShortcut(input: Input): boolean {
    const commandOrControl = process.platform === "darwin"
      ? input.meta && !input.control
      : input.control && !input.meta;
    return (
      commandOrControl
      && input.shift
      && !input.alt
      && input.code === "KeyM"
    );
  }

  private isFullscreenShortcut(input: Input): boolean {
    if (process.platform === "darwin") {
      return (
        input.control
        && input.meta
        && !input.shift
        && !input.alt
        && input.code === "KeyF"
      );
    }
    return (
      !input.control
      && !input.meta
      && !input.alt
      && !input.shift
      && input.code === "F11"
    );
  }

  private toggleMaximize(): boolean {
    if (this.currentWindowState.mode === "fullscreen" || this.window.isFullScreen()) {
      return false;
    }
    if (this.window.isMaximized()) {
      this.window.unmaximize();
    } else {
      this.window.maximize();
    }
    return true;
  }

  private toggleFullscreen(): boolean {
    if (this.fullscreenTransition != null) {
      return true;
    }
    if (!this.window.isFullScreen() && !this.window.isFullScreenable()) {
      return false;
    }
    if (this.window.isFullScreen()) {
      if (this.currentWindowState.mode !== "fullscreen") {
        throw new Error("全画面解除時のウィンドウ状態が不正です。");
      }
      this.fullscreenTransition = "leaving";
      this.window.setFullScreen(false);
      return true;
    }
    this.currentWindowState = fullscreenState(
      normalModeForWindow(this.window),
      this.currentWindowState.bounds,
    );
    this.fullscreenTransition = "entering";
    this.window.setFullScreen(true);
    return true;
  }

  private canCaptureNormalBounds(): boolean {
    return (
      !this.window.isMinimized()
      && this.window.isVisible()
      && !this.window.isMaximized()
      && !this.window.isFullScreen()
      && this.currentWindowState.mode !== "fullscreen"
      && this.fullscreenTransition == null
    );
  }

  private clearSaveTimer(): void {
    if (this.saveTimer == null) {
      return;
    }
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }
}
