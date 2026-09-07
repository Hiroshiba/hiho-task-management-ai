import { z } from "zod";
import {
  externalAgentMaxRequestBytes,
  externalAgentMaxResponseBytes,
  externalAgentProtocolVersion,
  externalAgentRequestTimeoutMilliseconds,
  externalAgentUnixSocketMaxBytes,
} from "./transport-schemas";

const absolutePathSchema = z.string().min(1).refine((value) => {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}, "絶対パスが必要です。");

export type ExternalAgentLaunchTarget = {
  readonly mode: "wsl" | "native";
  readonly executablePath: string;
  readonly clientPath: string;
};

function bashLiteral(value: string): string {
  absolutePathSchema.parse(value);
  if (hasControlCharacters(value)) {
    throw new Error("外部連携のパスに制御文字を指定できません。");
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function jsonLiteral(value: string): string {
  absolutePathSchema.parse(value);
  if (hasControlCharacters(value)) {
    throw new Error("外部連携のパスに制御文字を指定できません。");
  }
  return JSON.stringify(value);
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code != null && ((code >= 0 && code <= 31) || (code >= 127 && code <= 159))) {
      return true;
    }
  }
  return false;
}

/** 外部連携クライアントの自己完結したNodeスクリプトを生成します。 */
export function createExternalAgentClientScript(connectionInfoPath: string): string {
  const serializedPath = jsonLiteral(connectionInfoPath);
  return String.raw`"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");

const connectionInfoPath = ${serializedPath};
const protocolVersion = ${externalAgentProtocolVersion};
const maxRequestBytes = ${externalAgentMaxRequestBytes};
const maxResponseBytes = ${externalAgentMaxResponseBytes};
const requestTimeoutMilliseconds = ${externalAgentRequestTimeoutMilliseconds};

function writeFailure(code, message) {
  process.stderr.write("taskhub external agent: " + message + "\n");
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  process.exitCode = 1;
}

function isWindowsPipe(value) {
  return typeof value === "string" && /^\\\\\.\\pipe\\taskhub-agent-[0-9a-f]{32}$/u.test(value);
}

function isUnixSocket(value) {
  return typeof value === "string" && /^\/(?:private\/)?tmp\/taskhub-agent-[0-9]+-[0-9a-f]{24}\/bridge\.sock$/u.test(value) && Buffer.byteLength(value, "utf8") <= ${externalAgentUnixSocketMaxBytes};
}

function isDescriptor(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 4
    && value.version === protocolVersion
    && (isWindowsPipe(value.endpoint) || isUnixSocket(value.endpoint))
    && typeof value.capability === "string"
    && /^[0-9a-f]{64}$/u.test(value.capability)
    && typeof value.instanceId === "string"
    && /^[0-9a-f]{32}$/u.test(value.instanceId);
}

function verifyDescriptorFile() {
  const stats = fs.lstatSync(connectionInfoPath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("接続情報ファイルが不正です。");
  }
  if (process.platform !== "win32" && (stats.mode & 0o777) !== 0o600) {
    throw new Error("接続情報ファイルの権限が不正です。");
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error("接続情報ファイルの所有者が不正です。");
  }
  if (stats.size > maxRequestBytes) {
    throw new Error("接続情報ファイルが大きすぎます。");
  }
  const raw = fs.readFileSync(connectionInfoPath);
  if (raw.byteLength > maxRequestBytes) {
    throw new Error("接続情報ファイルが大きすぎます。");
  }
  const descriptor = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!isDescriptor(descriptor)) {
    throw new Error("接続情報の形式が不正です。");
  }
  return descriptor;
}

function readRequest(command) {
  if (command === "agent-info") {
    return Promise.resolve({ operation: "agent-info" });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      process.stdin.destroy();
      reject(new Error("要求の読み込みが時間内に完了しませんでした。"));
    }, requestTimeoutMilliseconds);
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    process.stdin.on("data", (chunk) => {
      if (settled) {
        return;
      }
      bytes += chunk.byteLength;
      if (bytes > maxRequestBytes) {
        fail(new Error("要求がサイズ上限を超えています。"));
        process.stdin.destroy();
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.once("error", (error) => {
      fail(new Error("要求を読み込めません。", { cause: error }));
    });
    process.stdin.once("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        resolve(JSON.parse(text));
      } catch (error) {
        reject(error instanceof Error ? error : new Error("要求のJSONまたは文字コードが不正です。", { cause: error }));
      }
    });
  });
}

function validateResponse(value, requestId) {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== protocolVersion
    || value.requestId !== requestId
    || typeof value.ok !== "boolean"
  ) {
    throw new Error("応答の形式が不正です。");
  }
  if (!value.ok) {
    const error = value.error;
    if (error == null || typeof error !== "object" || Array.isArray(error) || typeof error.code !== "string" || typeof error.message !== "string") {
      throw new Error("エラー応答の形式が不正です。");
    }
  }
  return value;
}

function request(descriptor, input) {
  const requestId = crypto.randomBytes(16).toString("hex");
  const envelope = {
    version: protocolVersion,
    endpoint: descriptor.endpoint,
    instanceId: descriptor.instanceId,
    capability: descriptor.capability,
    requestId,
    input,
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") + 1 > maxRequestBytes) {
    throw new Error("要求がサイズ上限を超えています。");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(descriptor.endpoint);
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve(value);
    };
    socket.setTimeout(requestTimeoutMilliseconds, () => {
      finish(new Error("応答が時間内に返りませんでした。"));
    });
    socket.once("error", (error) => {
      finish(new Error("TaskHubへ接続できません。", { cause: error }));
    });
    socket.once("close", () => {
      if (!settled) {
        finish(new Error("TaskHubが応答前に終了しました。"));
      }
    });
    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > maxResponseBytes) {
        finish(new Error("応答がサイズ上限を超えています。"));
        return;
      }
      const newlineIndex = buffer.indexOf(10);
      if (newlineIndex < 0) {
        return;
      }
      if (buffer.byteLength !== newlineIndex + 1) {
        finish(new Error("応答が一行ではありません。"));
        return;
      }
      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newlineIndex));
        const response = validateResponse(JSON.parse(line), requestId);
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error("応答を読み取れません。"));
      }
    });
    socket.once("connect", () => {
      socket.end(serialized + "\n");
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (args[0] !== "agent-info" && args[0] !== "request")) {
    throw new Error("agent-infoまたはrequestだけを指定できます。");
  }
  const descriptor = verifyDescriptorFile();
  const input = await readRequest(args[0]);
  const response = await request(descriptor, input);
  process.stdout.write(JSON.stringify(response) + "\n");
  if (response.ok !== true || (response.output !== null && typeof response.output === "object" && response.output.kind === "error")) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  writeFailure("client_error", error instanceof Error ? error.message : "外部連携に失敗しました。");
});
`;
}

/** Skillから呼び出す固定引数のランチャーを生成します。 */
export function createExternalAgentLauncherScript(target: ExternalAgentLaunchTarget): string {
  const parsedTarget = z.object({
    mode: z.enum(["wsl", "native"]),
    executablePath: absolutePathSchema,
    clientPath: absolutePathSchema,
  }).strict().parse(target);
  const executablePath = bashLiteral(parsedTarget.executablePath);
  const clientPath = bashLiteral(parsedTarget.clientPath);
  if (parsedTarget.mode === "native") {
    return String.raw`#!/usr/bin/env bash
set -eu
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'agent-infoまたはrequestだけを指定してください。' >&2
  exit 2
fi
case "$1" in
  agent-info|request) ;;
  *)
    printf '%s\n' 'agent-infoまたはrequestだけを指定してください。' >&2
    exit 2
    ;;
esac
taskhub_executable=${executablePath}
taskhub_client=${clientPath}
export ELECTRON_RUN_AS_NODE=1
exec "$taskhub_executable" "$taskhub_client" "$1"
`;
  }
  return String.raw`#!/usr/bin/env bash
set -eu
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'agent-infoまたはrequestだけを指定してください。' >&2
  exit 2
fi
case "$1" in
  agent-info|request) ;;
  *)
    printf '%s\n' 'agent-infoまたはrequestだけを指定してください。' >&2
    exit 2
    ;;
esac
taskhub_electron_windows=${executablePath}
taskhub_client_windows=${clientPath}
if ! taskhub_electron_linux=$(wslpath -u "$taskhub_electron_windows"); then
  printf '%s\n' 'Windows ElectronのパスをWSL形式へ変換できません。' >&2
  exit 1
fi
if [ -z "$taskhub_electron_linux" ]; then
  printf '%s\n' 'Windows Electronのパスが空です。' >&2
  exit 1
fi
case ":${"$"}{WSLENV-}:" in
  *:ELECTRON_RUN_AS_NODE/w:*) ;;
  *:ELECTRON_RUN_AS_NODE/*:*)
    printf '%s\n' '既存WSLENVのELECTRON_RUN_AS_NODE指定が競合しています。' >&2
    exit 1
    ;;
  *)
    if [ -n "${"$"}{WSLENV-}" ]; then
      export WSLENV="ELECTRON_RUN_AS_NODE/w:${"$"}WSLENV"
    else
      export WSLENV='ELECTRON_RUN_AS_NODE/w'
    fi
    ;;
esac
export ELECTRON_RUN_AS_NODE=1
exec "$taskhub_electron_linux" "$taskhub_client_windows" "$1"
`;
}

/** 初回登録に使うシェルインストーラーを生成します。 */
export function createExternalAgentInstallerScript(): string {
  return String.raw`#!/usr/bin/env bash
set -eu
if [ "$#" -gt 1 ]; then
  printf '%s\n' 'オプションは--allow-executionだけです。' >&2
  exit 2
fi
allow_execution=0
if [ "$#" -eq 1 ]; then
  if [ "$1" != '--allow-execution' ]; then
    printf '%s\n' 'オプションは--allow-executionだけです。' >&2
    exit 2
  fi
  allow_execution=1
fi
script_directory=$(CDPATH= cd -- "$(dirname -- "${"$"}{BASH_SOURCE[0]}")" && pwd -P)
skill_source="$script_directory/skill"
if [ ! -d "$skill_source" ]; then
  printf '%s\n' 'TaskHub Skillの配置先がありません。' >&2
  exit 1
fi
link_parent="$HOME/.agents/skills"
link_path="$link_parent/taskhub"
mkdir -p "$link_parent"
if [ -L "$link_path" ]; then
  current_target=$(readlink "$link_path")
  if [ "$current_target" != "$skill_source" ]; then
    printf '%s\n' '既存のTaskHub Skillが別の参照先です。上書きしません。' >&2
    exit 1
  fi
elif [ -e "$link_path" ]; then
  printf '%s\n' '既存のTaskHub Skillがシンボリックリンクではありません。上書きしません。' >&2
  exit 1
else
  ln -s "$skill_source" "$link_path"
fi
if [ "$allow_execution" -eq 1 ]; then
  rules_directory="${"$"}{CODEX_HOME:-$HOME/.codex}/rules"
  rules_file="$rules_directory/taskhub.rules"
  mkdir -p "$rules_directory"
  rules_quote() {
    rules_value=$1
    rules_value=${"$"}{rules_value//\\/\\\\}
    rules_value=${"$"}{rules_value//\"/\\\"}
    printf '"%s"' "$rules_value"
  }
  launcher_path=$(rules_quote "$link_path/scripts/taskhub")
  marker='# TaskHub external-agent rules v1'
  rule_block=$(cat <<RULES
$marker
prefix_rule(
    pattern = ["bash", $launcher_path, "agent-info"],
    decision = "allow",
)
prefix_rule(
    pattern = ["bash", $launcher_path, "request"],
    decision = "allow",
)
RULES
)
  if [ -e "$rules_file" ]; then
    if [ ! -f "$rules_file" ]; then
      printf '%s\n' 'TaskHub rulesの保存先が通常ファイルではありません。' >&2
      exit 1
    fi
    existing_rules=$(cat "$rules_file")
    if [ "$existing_rules" != "$rule_block" ]; then
      printf '%s\n' '既存のTaskHub rulesが別内容です。上書きしません。' >&2
      exit 1
    fi
  else
    umask 077
    printf '%s\n' "$rule_block" > "$rules_file"
  fi
  printf '%s\n' 'Codexのrulesを有効にするにはCodexを再起動してください。' >&2
fi
printf '%s\n' 'TaskHub Skillの登録が完了しました。'
`;
}
