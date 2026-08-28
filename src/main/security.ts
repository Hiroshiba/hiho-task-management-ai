import type { IpcMainInvokeEvent, WebContents } from "electron";

const allowedAsanaExternalHosts = new Set(["app.asana.com", "asana.com"]);
const allowedAsanaAuthorizationHosts = new Set(["app.asana.com"]);
const allowedCodexAuthorizationHosts = new Set([
  "auth.openai.com",
  "chatgpt.com",
  "www.chatgpt.com",
]);

function assertAllowedHttpsUrl(
  rawUrl: string,
  allowedHosts: ReadonlySet<string>,
  failureMessage: string,
): URL {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch (error) {
    throw new Error("外部URLが不正です。", { cause: error });
  }

  if (
    parsedUrl.protocol !== "https:"
    || (parsedUrl.port !== "" && parsedUrl.port !== "443")
    || parsedUrl.username !== ""
    || parsedUrl.password !== ""
    || !allowedHosts.has(parsedUrl.hostname)
  ) {
    throw new Error(failureMessage);
  }

  return parsedUrl;
}

/** 外部URLが許可されたHTTPS URLであることを検証します。 */
export function assertAllowedExternalUrl(rawUrl: string): URL {
  return assertAllowedHttpsUrl(
    rawUrl,
    allowedAsanaExternalHosts,
    "外部URLは許可されたAsanaのHTTPS URLだけを指定できます。",
  );
}

/** Asana認可URLが許可されたHTTPS URLであることを検証します。 */
export function assertAllowedAsanaAuthorizationUrl(rawUrl: string): URL {
  return assertAllowedHttpsUrl(
    rawUrl,
    allowedAsanaAuthorizationHosts,
    "Asana認可URLは許可されたHTTPSホストだけを指定できます。",
  );
}

/** Codex認可URLが許可されたHTTPS URLであることを検証します。 */
export function assertAllowedCodexAuthorizationUrl(rawUrl: string): URL {
  return assertAllowedHttpsUrl(
    rawUrl,
    allowedCodexAuthorizationHosts,
    "Codex認可URLは許可されたHTTPSホストだけを指定できます。",
  );
}

/** RendererのURLがアプリ自身のURLであることを検証します。 */
export function isApplicationUrl(rawUrl: string, rendererUrl: string): boolean {
  let parsedUrl: URL;
  let expectedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
    expectedUrl = new URL(rendererUrl);
  } catch {
    return false;
  }

  if (expectedUrl.protocol === "file:") {
    return parsedUrl.href === expectedUrl.href;
  }

  return parsedUrl.origin === expectedUrl.origin;
}

/** IPCの送信元がメインウィンドウ自身であることを検証します。 */
export function assertTrustedIpcSender(
  event: IpcMainInvokeEvent,
  expectedWebContents: WebContents,
  rendererUrl: string,
): void {
  if (
    event.sender !== expectedWebContents ||
    event.senderFrame !== event.sender.mainFrame ||
    !isApplicationUrl(event.senderFrame.url, rendererUrl)
  ) {
    throw new Error("不正なIPC送信元です。");
  }
}
