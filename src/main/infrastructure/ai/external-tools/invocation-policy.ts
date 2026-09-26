import { isAbsolute } from "node:path";

const forbiddenArgumentNamePrefixes = [
  "auth",
  "base",
  "config",
  "cwd",
  "data",
  "domain",
  "endpoint",
  "exec",
  "file",
  "header",
  "host",
  "input",
  "module",
  "out",
  "plugin",
  "proxy",
  "request",
  "secret",
  "server",
  "token",
  "url",
  "uri",
];
const forbiddenInvocationVerbParts = [
  "add",
  "archive",
  "ban",
  "cancel",
  "clear",
  "close",
  "complete",
  "create",
  "delete",
  "destroy",
  "dispatch",
  "drop",
  "edit",
  "enable",
  "execute",
  "install",
  "invite",
  "merge",
  "modify",
  "move",
  "patch",
  "post",
  "publish",
  "put",
  "react",
  "remove",
  "rename",
  "reply",
  "run",
  "save",
  "send",
  "set",
  "subscribe",
  "truncate",
  "unsubscribe",
  "update",
  "upload",
  "upsert",
  "write",
];

type InvocationTool = {
  readonly allowed_argument_names: readonly string[];
  readonly allowed_http_methods: readonly string[];
  readonly allowed_domains: readonly string[];
};

type InvocationPolicy = {
  readonly validateInvocationArguments: (tool: InvocationTool, args: readonly string[]) => void;
};

/** 外部ツール引数の読取専用操作と接続先の許可を判定します。 */
export function createExternalToolInvocationPolicy(
  errorType: new (
    code: "invalid_request" | "forbidden_write_operation" | "forbidden_network",
    message: string,
    retryable: boolean,
    cause?: unknown,
  ) => Error,
  maxRequestBytes: number,
): InvocationPolicy {
  function isWindowsAbsolutePath(value: string): boolean {
    return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
  }

  function hasParentPathSegment(value: string): boolean {
    return value.split(/[\\/]/u).some((part) => part === "..");
  }

  function isFileUrl(value: string): boolean {
    return /\bfile:/iu.test(value);
  }

  function extractHttpUrls(value: string): readonly string[] {
    const startIndexes: number[] = [];
    for (const match of value.matchAll(/https?:\/\//giu)) {
      if (match.index == null) {
        throw new Error("外部URLの位置を取得できません。");
      }
      startIndexes.push(match.index);
    }
    const urls: string[] = [];
    for (const [index, start] of startIndexes.entries()) {
      const nextStart = startIndexes[index + 1];
      const end = nextStart == null ? value.length : nextStart;
      const candidate = value.slice(start, end).split(/[\s"'<>]/u)[0];
      if (candidate == null || candidate.length === 0) {
        throw new Error("外部URLを取得できません。");
      }
      urls.push(candidate);
    }
    return urls;
  }

  function isArgumentFlag(value: string): boolean {
    return value.startsWith("-");
  }

  function argumentFlagName(value: string): string | undefined {
    if (!value.startsWith("--")) {
      return undefined;
    }
    const separatorIndex = value.indexOf("=");
    if (separatorIndex < 0) {
      return value;
    }
    return value.slice(0, separatorIndex);
  }

  function containsDangerousArgumentPart(value: string): boolean {
    const normalized = value.toLowerCase();
    if (
      normalized !== "--method"
      && normalized !== "--http-method"
      && normalized.slice(2).split("-").some((part) => {
        if (forbiddenInvocationVerbParts.includes(part)) {
          return true;
        }
        return forbiddenInvocationVerbParts.some((verb) =>
          part.startsWith(verb) || part.endsWith(verb),
        );
      })
    ) {
      return true;
    }
    if (
      normalized !== "--method"
      && normalized !== "--http-method"
      && normalized.slice(2).split(/[-_=]/u).some((part) => part.startsWith("method"))
    ) {
      return true;
    }
    const parts = normalized.slice(2).split(/[-_=]/u);
    return parts.some((part) => forbiddenArgumentNamePrefixes.some((prefix) =>
      part === prefix || part.startsWith(prefix),
    ));
  }

  function readHttpMethod(args: readonly string[], index: number): string | undefined {
    const argument = args[index];
    if (argument == null) {
      throw new Error("外部ツール引数の位置が不正です。");
    }
    const normalized = argument.toLowerCase();
    let methodFlag: "--method=" | "--http-method=" | undefined;
    if (normalized.startsWith("--method=")) {
      methodFlag = "--method=";
    } else if (normalized.startsWith("--http-method=")) {
      methodFlag = "--http-method=";
    }
    if (methodFlag != null) {
      const method = argument.slice(methodFlag.length).toUpperCase();
      if (method.length === 0) {
        throw new errorType(
          "invalid_request",
          "HTTPメソッドが空です。",
          false,
        );
      }
      return method;
    }
    if (normalized === "--method" || normalized === "--http-method") {
      const method = args[index + 1];
      if (method == null || method.length === 0) {
        throw new errorType(
          "invalid_request",
          "HTTPメソッドが必要です。",
          false,
        );
      }
      return method.toUpperCase();
    }
    return undefined;
  }

  function isFlagValue(args: readonly string[], index: number): boolean {
    const previous = args[index - 1];
    return previous != null && isArgumentFlag(previous) && !previous.includes("=");
  }

  function isIndependentWriteVerb(value: string): boolean {
    if (!/^[a-z][a-z0-9._:-]*$/iu.test(value)) {
      return false;
    }
    return value.toLowerCase().split(/[._:-]/u).some((part) => {
      if (forbiddenInvocationVerbParts.includes(part)) {
        return true;
      }
      return forbiddenInvocationVerbParts.some((verb) =>
        part.startsWith(verb) || part.endsWith(verb),
      );
    });
  }

  function isReadOnlyHttpMethod(value: string): value is "GET" | "HEAD" | "OPTIONS" {
    return value === "GET" || value === "HEAD" || value === "OPTIONS";
  }

  function validateInvocationArguments(
    tool: InvocationTool,
    args: readonly string[],
  ): void {
    let totalArgumentBytes = 0;
    const allowedArgumentNames = new Set<string>(tool.allowed_argument_names);
    const allowedHttpMethods: readonly string[] = tool.allowed_http_methods;
    const allowedDomains: readonly string[] = tool.allowed_domains;
    for (const [index, argument] of args.entries()) {
      totalArgumentBytes += new TextEncoder().encode(argument).byteLength;
      if (totalArgumentBytes > maxRequestBytes) {
        throw new errorType(
          "invalid_request",
          "外部ツール要求がサイズ上限を超えました。",
          false,
        );
      }
      if (
        argument.startsWith("@")
        || isAbsolute(argument)
        || isWindowsAbsolutePath(argument)
        || isFileUrl(argument)
        || hasParentPathSegment(argument)
      ) {
        throw new errorType(
          "invalid_request",
          "外部ツール引数が不正です。",
          false,
        );
      }
      const flagName = argumentFlagName(argument);
      if (isArgumentFlag(argument) && (flagName == null || !allowedArgumentNames.has(flagName))) {
        throw new errorType(
          "invalid_request",
          "登録されていない外部ツール引数です。",
          false,
        );
      }
      if (flagName != null && containsDangerousArgumentPart(flagName)) {
        throw new errorType(
          "invalid_request",
          "危険な外部ツール引数です。",
          false,
        );
      }
      const method = readHttpMethod(args, index);
      if (method != null && (
        !isReadOnlyHttpMethod(method)
        || !allowedHttpMethods.includes(method)
      )) {
        throw new errorType(
          "forbidden_write_operation",
          "許可されていないHTTPメソッドです。",
          false,
        );
      }
      if (
        !isArgumentFlag(argument)
        && !isFlagValue(args, index)
        && isIndependentWriteVerb(argument)
      ) {
        throw new errorType(
          "forbidden_write_operation",
          "書き込み操作に見える外部ツール引数は許可されていません。",
          false,
        );
      }
      for (const urlValue of extractHttpUrls(argument)) {
        let parsed: URL;
        try {
          parsed = new URL(urlValue);
        } catch (error) {
          throw new errorType(
            "forbidden_network",
            "許可されていない外部URLです。",
            false,
            error,
          );
        }
        if (parsed.username.length > 0 || parsed.password.length > 0) {
          throw new errorType(
            "forbidden_network",
            "URLへ認証情報を指定できません。",
            false,
          );
        }
        if (!allowedDomains.includes(parsed.hostname.toLowerCase())) {
          throw new errorType(
            "forbidden_network",
            "許可されていない外部URLです。",
            false,
          );
        }
      }
    }
  }

  return { validateInvocationArguments };
}
