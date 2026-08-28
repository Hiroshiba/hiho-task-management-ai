import { isAbsolute } from "node:path";
import { z } from "zod";

const connectionInfoPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "contextctl接続情報のパスは絶対パスで指定してください。")
  .refine((value) => !value.includes("\0"), "contextctl接続情報のパスにNUL文字を指定できません。")
  .refine(
    (value) => ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint != null && (
        codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
      );
    }),
    "contextctl接続情報のパスに制御文字を指定できません。",
  );

/** 外部ツールブローカーへ接続する依存なしcontextctlスクリプトを生成します。 */
export function createContextctlClientScript(connectionInfoPath: string): string {
  const validatedPath = connectionInfoPathSchema.parse(connectionInfoPath);
  const serializedPath = JSON.stringify(validatedPath);
  if (serializedPath == null) {
    throw new Error("contextctl接続情報のパスをJSON化できません。");
  }
  return String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const connectionInfoPath = ${serializedPath};
const protocolVersion = 1;
const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 1200000;
const maxJsonDepth = 24;
const maxArguments = 32;
const maxArgumentBytes = 4096;
const maxOutputRecords = 10000;
const requestTimeoutMilliseconds = 35000;
const errorCodes = new Set([
  "invalid_request",
  "capability_invalid",
  "tool_not_registered",
  "forbidden_subcommand",
  "forbidden_write_operation",
  "forbidden_network",
  "tool_not_found",
  "tool_execution_failed",
  "execution_timeout",
  "output_too_large",
  "invalid_output",
  "invalid_utf8",
  "credential_unavailable",
  "broker_unavailable",
  "broker_stopped",
  "broker_start_failed",
  "broker_stop_failed",
  "ipc_unavailable",
  "response_too_large",
  "registry_conflict",
  "permission_denied",
  "aborted",
  "internal_error",
]);

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid_request";
  return error;
}

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value, maximumDepth) {
  const stack = [{ value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      return false;
    }
    if (frame.depth > maximumDepth) {
      return false;
    }
    if (frame.value === null || typeof frame.value === "string" || typeof frame.value === "boolean") {
      if (typeof frame.value === "string" && hasControlCharacter(frame.value)) {
        return false;
      }
      continue;
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        return false;
      }
      continue;
    }
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item, depth: frame.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(frame.value)) {
      return false;
    }
    for (const [key, item] of Object.entries(frame.value)) {
      if (hasControlCharacter(key)) {
        return false;
      }
      stack.push({ value: item, depth: frame.depth + 1 });
    }
  }
  return true;
}

function jsonDepth(value, depth, maximumDepth) {
  const stack = [{ value, depth }];
  let deepest = depth;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame == null) {
      return maximumDepth + 1;
    }
    deepest = Math.max(deepest, frame.depth);
    if (frame.depth > maximumDepth) {
      return deepest;
    }
    if (typeof frame.value !== "object" || frame.value === null) {
      continue;
    }
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item, depth: frame.depth + 1 });
      }
      continue;
    }
    for (const item of Object.values(frame.value)) {
      stack.push({ value: item, depth: frame.depth + 1 });
    }
  }
  return deepest;
}

const readOnlyCommandHeads = new Set([
  "fetch",
  "find",
  "get",
  "history",
  "inspect",
  "list",
  "lookup",
  "message",
  "query",
  "read",
  "resolve",
  "search",
  "show",
  "status",
  "thread",
  "view",
]);
const forbiddenCommandParts = new Set([
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
]);

const forbiddenInvocationVerbParts = new Set([...forbiddenCommandParts, "save"]);
const forbiddenArgumentFlagParts = new Set([...forbiddenInvocationVerbParts]);

function isReadOnlyCommand(value) {
  const parts = value.toLowerCase().split(/[._:-]/u);
  const firstPart = parts[0];
  if (firstPart == null || !readOnlyCommandHeads.has(firstPart) || parts.some((part) => part.length === 0)) {
    return false;
  }
  return parts.slice(1).every((part) => {
    for (const forbiddenPart of forbiddenCommandParts) {
      if (part === forbiddenPart || part.startsWith(forbiddenPart)) {
        return false;
      }
    }
    return true;
  });
}

function isWindowsAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function hasParentPathSegment(value) {
  return value.split(/[\\/]/u).some((part) => part === "..");
}

function isSafeArgument(argument) {
  if (
    argument.startsWith("@")
    || path.isAbsolute(argument)
    || isWindowsAbsolutePath(argument)
    || /\bfile:/iu.test(argument)
    || hasParentPathSegment(argument)
  ) {
    return false;
  }
  if (!argument.startsWith("-")) {
    return true;
  }
  if (!argument.startsWith("--")) {
    return false;
  }
  const separatorIndex = argument.indexOf("=");
  const flagName = separatorIndex < 0 ? argument : argument.slice(0, separatorIndex);
  const normalizedFlagName = flagName.slice(2).toLowerCase();
  if (
    flagName !== "--method"
    && flagName !== "--http-method"
    && normalizedFlagName.split("-").some((part) => {
      if (forbiddenArgumentFlagParts.has(part)) {
        return true;
      }
      return [...forbiddenArgumentFlagParts].some((verb) =>
        part.startsWith(verb) || part.endsWith(verb),
      );
    })
  ) {
    return false;
  }
  if (
    flagName !== "--method"
    && flagName !== "--http-method"
    && normalizedFlagName.split("-").some((part) => part.startsWith("method"))
  ) {
    return false;
  }
  const dangerousPrefixes = [
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
    "output",
    "password",
    "plugin",
    "proxy",
    "request",
    "secret",
    "server",
    "token",
    "url",
    "uri",
  ];
  return flagName.slice(2).toLowerCase().split("-").every((part) =>
    dangerousPrefixes.every((prefix) => part !== prefix && !part.startsWith(prefix)),
  );
}

function isArgumentFlag(value) {
  return value.startsWith("-");
}

function isFlagValue(args, index) {
  const previous = args[index - 1];
  return previous != null && isArgumentFlag(previous) && !previous.includes("=");
}

function readHttpMethod(args, index) {
  const argument = args[index];
  if (typeof argument !== "string") {
    throw invalid("contextctlのHTTPメソッド位置が不正です。");
  }
  const normalized = argument.toLowerCase();
  let methodFlag;
  if (normalized.startsWith("--method=")) {
    methodFlag = "--method=";
  } else if (normalized.startsWith("--http-method=")) {
    methodFlag = "--http-method=";
  }
  if (methodFlag != null) {
    const method = argument.slice(methodFlag.length);
    if (method.length === 0) {
      throw invalid("contextctlのHTTPメソッドが空です。");
    }
    return method.toUpperCase();
  }
  if (normalized === "--method" || normalized === "--http-method") {
    const method = args[index + 1];
    if (method == null || method.length === 0) {
      throw invalid("contextctlのHTTPメソッドが必要です。");
    }
    return method.toUpperCase();
  }
  return undefined;
}

function isIndependentWriteVerb(value) {
  if (!/^[a-z][a-z0-9._:-]*$/iu.test(value)) {
    return false;
  }
  return value.toLowerCase().split(/[._:-]/u).some((part) => {
    if (forbiddenInvocationVerbParts.has(part)) {
      return true;
    }
    return [...forbiddenInvocationVerbParts].some((verb) =>
      part.startsWith(verb) || part.endsWith(verb),
    );
  });
}

function validateInvocationArguments(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const method = readHttpMethod(args, index);
    if (method != null && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      throw invalid("contextctlで許可されていないHTTPメソッドです。");
    }
    if (
      !isArgumentFlag(argument)
      && !isFlagValue(args, index)
      && isIndependentWriteVerb(argument)
    ) {
      throw invalid("contextctlで書き込み操作に見える引数は許可されていません。");
    }
  }
}

function isEndpoint(value) {
  return (
    typeof value === "string"
    && !hasControlCharacter(value)
    && (process.platform === "win32"
      ? /^\\\\\.\\pipe\\taskhub-contextctl-[0-9a-f]{24}$/u.test(value)
      : path.isAbsolute(value))
  );
}

function isCurrentUser(stats) {
  if (process.platform === "win32") {
    return true;
  }
  return typeof process.getuid === "function" && stats.uid === process.getuid();
}

function verifyNoSymlinkPath(targetPath) {
  const normalizedPath = path.resolve(targetPath);
  const rootPath = path.parse(normalizedPath).root;
  let currentPath = rootPath;
  for (const part of path.relative(rootPath, normalizedPath).split(path.sep).filter((item) => item.length > 0)) {
    currentPath = path.join(currentPath, part);
    const stats = fs.lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw invalid("contextctl接続先にシンボリックリンクを指定できません。");
    }
  }
}

function verifyConnectionInfoFile() {
  verifyNoSymlinkPath(connectionInfoPath);
  const stats = fs.lstatSync(connectionInfoPath);
  if (
    stats.isSymbolicLink()
    || !stats.isFile()
    || (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600)
    || !isCurrentUser(stats)
  ) {
    throw invalid("contextctl接続情報の権限が不正です。");
  }
}

function verifyEndpoint(endpoint) {
  if (process.platform === "win32") {
    if (!/^\\\\\.\\pipe\\taskhub-contextctl-[0-9a-f]{24}$/u.test(endpoint)) {
      throw invalid("contextctl IPC接続先が不正です。");
    }
    return;
  }
  verifyNoSymlinkPath(endpoint);
  const stats = fs.lstatSync(endpoint);
  if (
    stats.isSymbolicLink()
    || !stats.isSocket()
    || (stats.mode & 0o777) !== 0o600
    || !isCurrentUser(stats)
  ) {
    throw invalid("contextctl IPC接続先の権限が不正です。");
  }
}

function parseArguments(args) {
  if (args.length < 3 || args[args.length - 1] !== "--json") {
    throw invalid("contextctlで許可されていない引数です。");
  }
  const commandArguments = args.slice(0, -1);
  const toolId = commandArguments[0];
  const subcommand = commandArguments[1];
  const toolArguments = commandArguments.slice(2);
  if (
    typeof toolId !== "string"
    || !/^[a-z][a-z0-9._-]{0,63}$/u.test(toolId)
    || typeof subcommand !== "string"
    || !/^[a-z][a-z0-9._:-]{0,63}$/u.test(subcommand)
    || !isReadOnlyCommand(subcommand)
    || toolArguments.length > maxArguments
  ) {
    throw invalid("contextctlのツール指定が不正です。");
  }
  for (const argument of toolArguments) {
    if (
      typeof argument !== "string"
      || argument.length === 0
      || hasControlCharacter(argument)
      || Buffer.byteLength(argument, "utf8") > maxArgumentBytes
      || !isSafeArgument(argument)
    ) {
      throw invalid("contextctlの引数が不正です。");
    }
  }
  validateInvocationArguments(toolArguments);
  return { tool_id: toolId, subcommand, args: toolArguments };
}

function readConnectionInfo() {
  let raw;
  try {
    verifyConnectionInfoFile();
    raw = fs.readFileSync(connectionInfoPath, "utf8");
  } catch {
    throw invalid("contextctl接続情報を読み取れません。");
  }
  if (Buffer.byteLength(raw, "utf8") > maxRequestBytes) {
    throw invalid("contextctl接続情報がサイズ上限を超えています。");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid("contextctl接続情報のJSONが不正です。");
  }
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 3
    || value.version !== protocolVersion
    || !isEndpoint(value.endpoint)
    || typeof value.capability !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.capability)
  ) {
    throw invalid("contextctl接続情報が不正です。");
  }
  return value;
}

function validateResponse(value, expectedToolId) {
  if (!isPlainObject(value)) {
    throw invalid("contextctl応答が不正です。");
  }
  if (jsonDepth(value, 0, maxJsonDepth) > maxJsonDepth) {
    throw invalid("contextctl応答のJSON深度が上限を超えています。");
  }
  if (value.ok === true) {
    if (
      Object.keys(value).length !== 3
      || typeof value.tool_id !== "string"
      || !/^[a-z][a-z0-9._-]{0,63}$/u.test(value.tool_id)
      || value.tool_id !== expectedToolId
      || !isPlainObject(value.output)
      || (value.output.format === "json" && (Object.keys(value.output).length !== 2 || !isJsonValue(value.output.value, maxJsonDepth)))
      || (value.output.format === "jsonl" && (Object.keys(value.output).length !== 2 || !Array.isArray(value.output.values) || value.output.values.length === 0 || value.output.values.length > maxOutputRecords || !value.output.values.every((item) => isJsonValue(item, maxJsonDepth))))
      || (value.output.format !== "json" && value.output.format !== "jsonl")
    ) {
      throw invalid("contextctl成功応答が不正です。");
    }
    return value;
  }
  if (
    value.ok !== false
    || Object.keys(value).length !== 2
    || !isPlainObject(value.error)
    || Object.keys(value.error).length !== 2
    || typeof value.error.code !== "string"
    || !errorCodes.has(value.error.code)
    || typeof value.error.message !== "string"
    || value.error.message.length === 0
    || value.error.message.length > 120
  ) {
    throw invalid("contextctlエラー応答が不正です。");
  }
  return value;
}

function request(connectionInfo, command) {
  const requestValue = {
    version: protocolVersion,
    capability: connectionInfo.capability,
    ...command,
  };
  const serialized = JSON.stringify(requestValue);
  if (Buffer.byteLength(serialized, "utf8") > maxRequestBytes || jsonDepth(requestValue, 0, maxJsonDepth) > maxJsonDepth) {
    throw invalid("contextctl要求がサイズまたは深度の上限を超えています。");
  }
  try {
    verifyEndpoint(connectionInfo.endpoint);
  } catch (error) {
    if (error != null && typeof error === "object" && error.code === "invalid_request") {
      throw error;
    }
    throw invalid("contextctl IPC接続先を確認できません。");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connectionInfo.endpoint);
    let buffer = Buffer.alloc(0);
    let finished = false;
    const finish = (error, value) => {
      if (finished) {
        return;
      }
      finished = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(value);
    };
    socket.setTimeout(requestTimeoutMilliseconds, () => {
      const error = invalid("contextctl応答が時間内に返りませんでした。");
      error.code = "execution_timeout";
      finish(error);
    });
    socket.once("error", () => {
      finish(invalid("contextctlブローカーへ接続できません。"));
    });
    socket.once("close", () => {
      if (!finished) {
        finish(invalid("contextctlブローカーが応答前に終了しました。"));
      }
    });
    socket.on("data", (chunk) => {
      if (finished) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > maxResponseBytes) {
        finish(invalid("contextctl応答がサイズ上限を超えています。"));
        return;
      }
      const newlineIndex = buffer.indexOf(10);
      if (newlineIndex < 0 || buffer.byteLength > newlineIndex + 1 || buffer.indexOf(10, newlineIndex + 1) >= 0) {
        if (newlineIndex >= 0 && buffer.byteLength > newlineIndex + 1) {
          finish(invalid("contextctl応答が一行ではありません。"));
        }
        return;
      }
      let line;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newlineIndex));
      } catch {
        finish(invalid("contextctl応答の文字コードが不正です。"));
        return;
      }
      let value;
      try {
        value = JSON.parse(line);
        finish(undefined, validateResponse(value, command.tool_id));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("connect", () => {
      socket.end(serialized + "\n");
    });
  });
}

function printFailure(error) {
  const code = error != null && typeof error.code === "string" && error.code === "execution_timeout"
    ? "execution_timeout"
    : "invalid_request";
  const response = {
    ok: false,
    error: {
      code,
      message: "contextctl要求に失敗しました。",
    },
  };
  process.stdout.write(JSON.stringify(response) + "\n");
  process.exitCode = 1;
}

async function main() {
  try {
    const command = parseArguments(process.argv.slice(2));
    const connectionInfo = readConnectionInfo();
    const response = await request(connectionInfo, command);
    process.stdout.write(JSON.stringify(response) + "\n");
    if (!response.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    printFailure(error);
  }
}

void main();
`;
}
