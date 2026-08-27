import { app, BrowserWindow, ipcMain, session, shell } from "electron";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  assertAllowedExternalUrl,
  assertTrustedIpcSender,
  isApplicationUrl,
} from "./security";

const appGetVersionChannel = "app:get-version";
const developmentRendererUrl = process.env.ELECTRON_RENDERER_URL;
let mainWindow: BrowserWindow | undefined;

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

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

function configureWindowSecurity(window: BrowserWindow, rendererUrl: string): void {
  window.webContents.on("will-navigate", (event, requestedUrl) => {
    if (!isApplicationUrl(requestedUrl, rendererUrl)) {
      event.preventDefault();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const externalUrl = assertAllowedExternalUrl(url);
      shell.openExternal(externalUrl.href).catch((error: unknown) => {
        console.error("外部URLを開けませんでした。", error);
      });
    } catch (error: unknown) {
      console.error("外部URLを開けませんでした。", error);
    }
    return { action: "deny" };
  });
}

function registerIpcHandlers(rendererUrl: string): void {
  ipcMain.handle(appGetVersionChannel, (event, payload: unknown): Promise<string> => {
    z.undefined().parse(payload);

    if (mainWindow == null) {
      throw new Error("メインウィンドウが初期化されていません。");
    }

    assertTrustedIpcSender(event, mainWindow.webContents, rendererUrl);
    return Promise.resolve(app.getVersion());
  });
}

async function createMainWindow(): Promise<void> {
  const rendererUrl = getRendererUrl();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: join(__dirname, "../preload/index.mjs"),
    },
  });

  mainWindow = window;
  configureWindowSecurity(window, rendererUrl);
  window.once("ready-to-show", () => {
    window.show();
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  if (app.isPackaged) {
    await window.loadFile(fileURLToPath(rendererUrl));
  } else {
    await window.loadURL(rendererUrl);
  }
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  configureContentSecurityPolicy();
  const rendererUrl = getRendererUrl();
  registerIpcHandlers(rendererUrl);
  await createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}

void bootstrap().catch((error: unknown) => {
  console.error("アプリケーションの起動に失敗しました。", error);
  app.quit();
});
