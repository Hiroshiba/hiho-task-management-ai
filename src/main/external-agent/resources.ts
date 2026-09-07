import { join } from "node:path";
import { z } from "zod";
import {
  ensureSecureUserDataDirectory,
  readSecurePersistentTextFile,
  removeSecurePersistentFile,
  writeSecurePersistentTextFileAtomically,
} from "../local-storage-path";
import {
  externalAgentConfigSchema,
  externalAgentDescriptorSchema,
  type ExternalAgentConfig,
  type ExternalAgentDescriptor,
} from "./transport-schemas";
import {
  createExternalAgentClientScript,
  createExternalAgentInstallerScript,
  createExternalAgentLauncherScript,
} from "./client-script";

const externalAgentPathSchema = z.string().min(1).refine((value) => {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}, "絶対パスが必要です。");

export type ExternalAgentResourcePaths = {
  readonly managementDirectoryPath: string;
  readonly skillDirectoryPath: string;
  readonly skillAgentsDirectoryPath: string;
  readonly skillScriptsDirectoryPath: string;
  readonly launcherScriptPath: string;
  readonly clientScriptPath: string;
  readonly installerScriptPath: string;
  readonly connectionInfoPath: string;
  readonly configPath: string;
};

export type ExternalAgentRegistration = {
  readonly symlinkCommand: string;
  readonly allowExecutionCommand: string;
};

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value);
}

function assertPath(value: string, label: string): void {
  externalAgentPathSchema.parse(value);
  if (hasControlCharacters(value)) {
    throw new Error(`${label}に制御文字を指定できません。`);
  }
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

function assertAbsolutePath(value: string, label: string): void {
  assertPath(value, label);
  if (!value.startsWith("/") && !isWindowsAbsolutePath(value)) {
    throw new Error(`${label}は絶対パスでなければなりません。`);
  }
}

function bashLiteral(value: string): string {
  assertAbsolutePath(value, "外部連携のパス");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function createResourcePaths(userDataPath: string): ExternalAgentResourcePaths {
  assertAbsolutePath(userDataPath, "userDataのパス");
  const managementDirectoryPath = join(userDataPath, "external-agent");
  const skillDirectoryPath = join(managementDirectoryPath, "skill");
  const skillAgentsDirectoryPath = join(skillDirectoryPath, "agents");
  const skillScriptsDirectoryPath = join(skillDirectoryPath, "scripts");
  return {
    managementDirectoryPath,
    skillDirectoryPath,
    skillAgentsDirectoryPath,
    skillScriptsDirectoryPath,
    launcherScriptPath: join(skillScriptsDirectoryPath, "taskhub"),
    clientScriptPath: join(managementDirectoryPath, "client.cjs"),
    installerScriptPath: join(managementDirectoryPath, "installer.sh"),
    connectionInfoPath: join(managementDirectoryPath, "connection.json"),
    configPath: join(managementDirectoryPath, "config.json"),
  };
}

/** 外部連携管理資源の配置先を返します。 */
export function getExternalAgentResourcePaths(userDataPath: string): ExternalAgentResourcePaths {
  return createResourcePaths(userDataPath);
}

function createSkillDocument(): string {
  return `---
name: taskhub
description: TaskHubを明示的に指定した要求で一覧確認と承認済みの変更結果を取得する。
---

# TaskHub外部連携

このSkillは、明示的にTaskHubを指定した要求だけで使います。

毎回、最初に次のコマンドで現在の仕様と利用可能な操作を取得してください。

\`bash "$HOME/.agents/skills/taskhub/scripts/taskhub" agent-info\`

TaskHubへの要求は、同じランチャーを \`request\` で呼び出し、JSONを標準入力へ渡してください。

\`bash "$HOME/.agents/skills/taskhub/scripts/taskhub" request\`

agent-infoの応答に従って入力を作り、承認待ちの変更を適用済みとして扱わないでください。
変更結果で \`outcome\` が \`applied\` または \`already_applied\` の場合だけ対象を登録済みと扱ってください。
それ以外の結果は登録済みと報告せず、承認待ち、未適用、失敗または不明として扱ってください。
期限を指定する場合は、そのタスク自身の確定した期限だけを指定し、関連する予定や不確かな日付は説明に残してください。

TaskHubが起動していない場合や応答が失敗した場合は、応答を推測せず利用できないことを返してください。
`;
}

function createAgentMetadata(): string {
  return `policy:
  allow_implicit_invocation: false
`;
}

function writeManagedTextFile(
  filePath: string,
  content: string,
  label: string,
): void {
  assertAbsolutePath(filePath, label);
  writeSecurePersistentTextFileAtomically(filePath, content, label);
}

/** 外部連携の管理資源を起動時の実行先で更新します。 */
export function writeExternalAgentResources(
  userDataPath: string,
  processExecPath: string,
): ExternalAgentResourcePaths {
  assertAbsolutePath(processExecPath, "Electron実行ファイルのパス");
  const normalizedUserDataPath = ensureSecureUserDataDirectory(userDataPath);
  const paths = createResourcePaths(normalizedUserDataPath);
  ensureSecureUserDataDirectory(paths.managementDirectoryPath);
  ensureSecureUserDataDirectory(paths.skillDirectoryPath);
  ensureSecureUserDataDirectory(paths.skillAgentsDirectoryPath);
  ensureSecureUserDataDirectory(paths.skillScriptsDirectoryPath);
  const mode = process.platform === "win32" ? "wsl" : "native";
  writeManagedTextFile(join(paths.skillDirectoryPath, "SKILL.md"), createSkillDocument(), "SKILL.md");
  writeManagedTextFile(join(paths.skillAgentsDirectoryPath, "openai.yaml"), createAgentMetadata(), "agents/openai.yaml");
  writeManagedTextFile(
    paths.launcherScriptPath,
    createExternalAgentLauncherScript({ mode, executablePath: processExecPath, clientPath: paths.clientScriptPath }),
    "scripts/taskhub",
  );
  writeManagedTextFile(paths.clientScriptPath, createExternalAgentClientScript(paths.connectionInfoPath), "client.cjs");
  writeManagedTextFile(paths.installerScriptPath, createExternalAgentInstallerScript(), "installer.sh");
  return paths;
}

/** 外部連携設定を読み込み、初回だけ無効状態を保存します。 */
export function readExternalAgentConfig(paths: ExternalAgentResourcePaths): ExternalAgentConfig {
  const raw = readSecurePersistentTextFile(paths.configPath, "外部連携設定");
  if (raw == null) {
    const config = externalAgentConfigSchema.parse({ enabled: false });
    writeExternalAgentConfig(paths, config);
    return config;
  }
  return externalAgentConfigSchema.parse(JSON.parse(raw));
}

/** 外部連携設定を厳密なJSONとして置き換えます。 */
export function writeExternalAgentConfig(paths: ExternalAgentResourcePaths, config: ExternalAgentConfig): void {
  const validatedConfig = externalAgentConfigSchema.parse(config);
  writeManagedTextFile(
    paths.configPath,
    `${JSON.stringify(validatedConfig)}\n`,
    "外部連携設定",
  );
}

/** 外部連携の接続情報を待受開始後に公開します。 */
export function writeExternalAgentConnectionInfo(
  paths: ExternalAgentResourcePaths,
  descriptor: ExternalAgentDescriptor,
): void {
  const validatedDescriptor = externalAgentDescriptorSchema.parse(descriptor);
  writeManagedTextFile(
    paths.connectionInfoPath,
    `${JSON.stringify(validatedDescriptor)}\n`,
    "外部連携接続情報",
  );
}

/** 外部連携の接続情報を削除します。 */
export function removeExternalAgentConnectionInfo(paths: ExternalAgentResourcePaths): void {
  removeSecurePersistentFile(paths.connectionInfoPath, "外部連携接続情報");
}

/** 外部連携登録用の非秘密コマンドを返します。 */
export function getExternalAgentRegistration(paths: ExternalAgentResourcePaths): ExternalAgentRegistration {
  const installerPath = bashLiteral(paths.installerScriptPath);
  const baseCommand = process.platform === "win32"
    ? `bash "$(wslpath -u ${installerPath})"`
    : `bash ${installerPath}`;
  return {
    symlinkCommand: baseCommand,
    allowExecutionCommand: `${baseCommand} --allow-execution`,
  };
}
