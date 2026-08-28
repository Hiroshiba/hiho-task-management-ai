/** workspace/bin/taskctlへ固定配置する依存なしNodeクライアントです。 */
export const taskctlClientScript = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 512 * 1024;
const maxJsonDepth = 24;
const maxSearchCharacters = 200;
const maxListResults = 1000;
const maxGraphTasks = 10000;
const maxGraphRelations = 20000;
const maxAreas = 500;
const requestTimeoutMilliseconds = 6000;
const clientErrorCodes = new Set(["invalid_request", "execution_timeout", "client_error"]);
const errorCodes = new Set([
  "client_error",
  "invalid_request",
  "capability_invalid",
  "connection_limit",
  "broker_stopped",
  "snapshot_unavailable",
  "snapshot_invalid",
  "task_not_found",
  "result_limit",
  "response_too_large",
  "execution_timeout",
  "protocol_error",
]);

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonDepth(value, depth) {
  const stack = [{ value, depth }];
  let deepest = depth;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      throw invalid("taskctl JSON検証の状態が不正です。");
    }
    if (frame.value === null || typeof frame.value !== "object") {
      deepest = Math.max(deepest, frame.depth);
      continue;
    }
    deepest = Math.max(deepest, frame.depth);
    const childDepth = frame.depth + 1;
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        stack.push({ value: item, depth: childDepth });
      }
      continue;
    }
    for (const item of Object.values(frame.value)) {
      stack.push({ value: item, depth: childDepth });
    }
  }
  return deepest;
}

function invalid(message) {
  const error = new Error(message);
  error.code = "invalid_request";
  return error;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) {
    return false;
  }
  const expected = new Set(keys);
  const actual = Object.keys(value);
  return actual.length === expected.size && actual.every((key) => expected.has(key));
}

function parseCommand(args) {
  if (args.length === 2 && args[0] === "list" && args[1] === "--json") {
    return { command: "list", format: "json" };
  }
  if (args.length === 3 && args[0] === "get" && args[2] === "--json") {
    const gid = args[1];
    if (typeof gid !== "string" || gid.length === 0 || gid.trim() !== gid || /\s/u.test(gid)) {
      throw invalid("タスクGIDが不正です。");
    }
    return { command: "get", gid, format: "json" };
  }
  if (args.length === 2 && args[0] === "rank" && args[1] === "--json") {
    return { command: "rank", format: "json" };
  }
  if (args.length === 2 && args[0] === "graph" && args[1] === "--json") {
    return { command: "graph", format: "json" };
  }
  if (args.length === 2 && args[0] === "areas" && args[1] === "--json") {
    return { command: "areas", format: "json" };
  }
  if (
    args.length === 4
    && args[0] === "search-local"
    && args[1] === "--query"
    && args[3] === "--json"
  ) {
    const query = args[2];
    if (typeof query !== "string" || query.length === 0 || Array.from(query).length > maxSearchCharacters) {
      throw invalid("検索文字列が不正です。");
    }
    return { command: "search-local", query, format: "json" };
  }
  throw invalid("taskctlで許可されていない引数です。");
}

function assertOwned(stats, label) {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw invalid(label + "の所有者を確認できません。");
  }
}

function verifyConnectionInfoFile(filePath) {
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw invalid("taskctl接続情報が想定外のファイルです。");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    throw invalid("taskctl接続情報の権限が不正です。");
  }
  assertOwned(stats, "taskctl接続情報");
}

function verifyUnixSocket(socketPath) {
  if (process.platform === "win32") {
    return;
  }
  const root = path.parse(socketPath).root;
  let current = root;
  const parts = path.relative(root, socketPath).split(path.sep).filter((part) => part.length > 0);
  for (const part of parts) {
    current = path.join(current, part);
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw invalid("taskctlソケットの親にシンボリックリンクを指定できません。");
    }
    if (current === socketPath) {
      if (!stats.isSocket() || (stats.mode & 0o777) !== 0o600) {
        throw invalid("taskctlソケットが不正です。");
      }
      assertOwned(stats, "taskctlソケット");
    }
  }
}

function readConnectionInfo() {
  const filePath = path.join(__dirname, "..", "tmp", "taskctl-connection.json");
  verifyConnectionInfoFile(filePath);
  const raw = fs.readFileSync(filePath, "utf8");
  if (Buffer.byteLength(raw, "utf8") > maxRequestBytes) {
    throw invalid("taskctl接続情報がサイズ上限を超えています。");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid("taskctl接続情報が不正です。");
  }
  if (
    !isPlainObject(value)
    || Object.keys(value).length !== 3
    || value.version !== 1
    || typeof value.socketPath !== "string"
    || value.socketPath.length === 0
    || !path.isAbsolute(value.socketPath)
    || value.socketPath.includes("\u0000")
    || typeof value.capability !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.capability)
  ) {
    throw invalid("taskctl接続情報が不正です。");
  }
  verifyUnixSocket(value.socketPath);
  return value;
}

function validateResponse(value, expectedCommand) {
  if (
    !isPlainObject(value)
    || typeof value.ok !== "boolean"
    || !isPlainObject(value.sync)
  ) {
    throw invalid("taskctl応答が不正です。");
  }
  if (value.sync.kind === "synced") {
    if (!hasExactKeys(value.sync, ["kind", "synced_at"]) || typeof value.sync.synced_at !== "string") {
      throw invalid("taskctl応答の同期状態が不正です。");
    }
  } else if (value.sync.kind !== "unavailable" || Object.keys(value.sync).length !== 1) {
    throw invalid("taskctl応答の同期状態が不正です。");
  }
  if (value.ok) {
    if (
      !hasExactKeys(value, ["ok", "command", "sync", "data"])
      || value.command !== expectedCommand
      || !isPlainObject(value.data)
    ) {
      throw invalid("taskctl成功応答が不正です。");
    }
    const expectedDataKeys = {
      list: ["tasks"],
      get: ["task"],
      rank: ["ranking"],
      graph: ["tasks", "dependencies", "parent_relations"],
      areas: ["areas"],
      "search-local": ["query", "tasks"],
    }[expectedCommand];
    if (expectedDataKeys === undefined || !hasExactKeys(value.data, expectedDataKeys)) {
      throw invalid("taskctl成功応答の内容が不正です。");
    }
    if (expectedCommand === "search-local" && typeof value.data.query !== "string") {
      throw invalid("taskctl検索応答の検索文字列が不正です。");
    }
    if (["list", "graph", "search-local"].includes(expectedCommand) && !Array.isArray(value.data.tasks)) {
      throw invalid("taskctl応答のタスク配列が不正です。");
    }
    if (["list", "search-local"].includes(expectedCommand) && value.data.tasks.length > maxListResults) {
      throw invalid("taskctl応答の件数が上限を超えています。");
    }
    if (expectedCommand === "graph" && (!Array.isArray(value.data.dependencies) || !Array.isArray(value.data.parent_relations))) {
      throw invalid("taskctlグラフ応答の辺が不正です。");
    }
    if (expectedCommand === "graph" && (value.data.tasks.length > maxGraphTasks || value.data.dependencies.length > maxGraphTasks || value.data.parent_relations.length > maxGraphRelations)) {
      throw invalid("taskctlグラフ応答の件数が上限を超えています。");
    }
    if (expectedCommand === "areas" && (!Array.isArray(value.data.areas) || value.data.areas.length > maxAreas)) {
      throw invalid("taskctl領域応答が不正です。");
    }
    if (expectedCommand === "get" && !isPlainObject(value.data.task)) {
      throw invalid("taskctlタスク応答が不正です。");
    }
    if (expectedCommand === "rank" && !isPlainObject(value.data.ranking)) {
      throw invalid("taskctl順位応答が不正です。");
    }
    return value;
  }
  if (
    !hasExactKeys(value, ["ok", "error", "sync"])
    || !isPlainObject(value.error)
    || !hasExactKeys(value.error, ["code", "message"])
    || typeof value.error.code !== "string"
    || !errorCodes.has(value.error.code)
    || typeof value.error.message !== "string"
    || value.error.message.length === 0
    || value.error.message.length > 200
  ) {
    throw invalid("taskctlエラー応答が不正です。");
  }
  return value;
}

function request(connectionInfo, command) {
  const request = {
    version: 1,
    capability: connectionInfo.capability,
    ...command,
  };
  const serialized = JSON.stringify(request);
  if (Buffer.byteLength(serialized, "utf8") > maxRequestBytes || jsonDepth(request, 0) > maxJsonDepth) {
    throw invalid("taskctl要求がサイズまたは深度の上限を超えています。");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(connectionInfo.socketPath);
    let buffer = Buffer.alloc(0);
    let finished = false;
    const finish = (error, value) => {
      if (finished) {
        return;
      }
      finished = true;
      socket.removeAllListeners();
      if (error !== undefined) {
        socket.destroy();
        reject(error);
        return;
      }
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(requestTimeoutMilliseconds, () => {
      const error = invalid("taskctl応答が時間内に返りませんでした。");
      error.code = "execution_timeout";
      finish(error);
    });
    socket.once("error", () => {
      finish(invalid("taskctlブローカーへ接続できません。"));
    });
    socket.once("close", () => {
      if (!finished) {
        finish(invalid("taskctlブローカーが応答前に終了しました。"));
      }
    });
    socket.on("data", (chunk) => {
      if (finished) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > maxResponseBytes) {
        finish(invalid("taskctl応答がサイズ上限を超えています。"));
        return;
      }
      const newlineIndex = buffer.indexOf(10);
      if (newlineIndex < 0) {
        return;
      }
      if (buffer.byteLength > newlineIndex + 1 || buffer.indexOf(10, newlineIndex + 1) >= 0) {
        finish(invalid("taskctl応答が一行ではありません。"));
        return;
      }
      let line;
      try {
        line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newlineIndex));
      } catch {
        finish(invalid("taskctl応答の文字コードが不正です。"));
        return;
      }
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        finish(invalid("taskctl応答のJSONが不正です。"));
        return;
      }
      try {
        if (jsonDepth(value, 0) > maxJsonDepth) {
          throw invalid("taskctl応答のJSON深度が上限を超えています。");
        }
        finish(undefined, validateResponse(value, command.command));
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
  const code = error != null
    && typeof error.code === "string"
    && clientErrorCodes.has(error.code)
    ? error.code
    : "client_error";
  const response = {
    ok: false,
    error: { code, message: "taskctl要求に失敗しました。" },
    sync: { kind: "unavailable" },
  };
  process.stdout.write(JSON.stringify(response) + "\n");
  process.exitCode = 1;
}

async function main() {
  try {
    const command = parseCommand(process.argv.slice(2));
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
