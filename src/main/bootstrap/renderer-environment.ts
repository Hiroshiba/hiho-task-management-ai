import type { Session } from "electron";
import { pathToFileURL } from "node:url";

interface RendererUrlOptions {
  readonly packaged: boolean;
  readonly rendererIndexPath: string;
  readonly developmentUrl: string | undefined;
  readonly arguments: readonly string[];
}

/** 実行環境に応じたRendererのURLを解決します。 */
export function resolveRendererUrl(options: RendererUrlOptions): string {
  let rendererUrl: string;
  if (options.packaged) {
    rendererUrl = pathToFileURL(options.rendererIndexPath).href;
  } else {
    if (options.developmentUrl == null) {
      throw new Error("開発用Renderer URLが設定されていません。");
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(options.developmentUrl);
    } catch (error) {
      throw new Error("開発用Renderer URLが不正です。", { cause: error });
    }
    if (
      parsedUrl.protocol !== "http:"
      || !["localhost", "127.0.0.1", "[::1]"].includes(parsedUrl.hostname)
    ) {
      throw new Error("開発用Renderer URLはローカルHTTP URLでなければなりません。");
    }
    rendererUrl = parsedUrl.href;
  }

  const mockArgumentPrefix = "--mock=";
  const mockArguments = options.arguments
    .filter((argument) => argument.startsWith(mockArgumentPrefix))
    .map((argument) => argument.slice(mockArgumentPrefix.length));
  if (mockArguments.length === 0) {
    return rendererUrl;
  }
  const parsedUrl = new URL(rendererUrl);
  for (const mockArgument of mockArguments) {
    parsedUrl.searchParams.append("mock", mockArgument);
  }
  return parsedUrl.href;
}

function getContentSecurityPolicy(packaged: boolean): string {
  if (packaged) {
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

/** Renderer応答へContent Security Policyを設定します。 */
export function configureContentSecurityPolicy(applicationSession: Session, packaged: boolean): void {
  applicationSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [getContentSecurityPolicy(packaged)],
      },
    });
  });
}

/** Rendererの権限要求を拒否する方針を設定します。 */
export function configurePermissionPolicy(applicationSession: Session): void {
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
