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
description: TaskHubを明示的に指定した要求でタスクを参照し、変更案を提出して適用結果を確認する。
---

# TaskHub外部連携

このSkillは、明示的にTaskHubを指定した要求だけで使います。

毎回、最初に次のコマンドで現在の仕様と利用可能な操作を取得してください。

\`bash "$HOME/.agents/skills/taskhub/scripts/taskhub" agent-info\`

TaskHubへの要求は、同じランチャーを \`request\` で呼び出し、JSONを標準入力へ渡してください。

\`bash "$HOME/.agents/skills/taskhub/scripts/taskhub" request\`

\`agent-info\` の \`capabilities\` と \`input_schema\` に従って入力を作ってください。利用者の文章をシェルの実行文字列へ埋め込まないでください。

タスク参照には \`tasks.list\`、\`tasks.get\`、\`tasks.rank\`、\`tasks.graph\`、\`tasks.areas\`、\`tasks.search-local\` を使えます。読み取りだけなら \`proposal_context_id\` を省略し、現在の同期済み情報を取得します。応答の同期時刻を確認し、オフラインの情報を最新と断定しないでください。

変更案ではTaskHub内部のAIと同じ17種類のタスク操作を使い、複数のグループと操作を1つの提案にまとめられます。作成、タイトルや説明の変更、期限や状態の変更、親子・依存関係、分割、完了、取り下げなどを扱います。

1. \`proposals.prepare\` へ \`agent-info\` の \`instance_id\` と \`context\` 内の \`context_id\`、\`project_gid\`、新しい \`request_id\`、利用者の依頼原文を表す \`source_text\` を渡します。原文を要約やAI自身の文章に置き換えないでください。
2. 返された \`proposal_context_id\`、\`turn_context\`、\`evidence_locator_prefix\` を保持します。変更案に必要な読み取りには、その \`proposal_context_id\` を指定して固定した基準を使ってください。
3. \`input_schema\` に従って完全な \`proposal\` を作り、\`proposals.create\` へ渡します。準備時と同じ \`instance_id\`、\`context_id\`、\`project_gid\`、\`request_id\` と、返された \`proposal_context_id\` を使ってください。各操作の基準ハッシュには \`turn_context.baseline_snapshot_hash\`、既存タスクの変更前値には固定した読み取り結果を使います。
4. 受付結果の \`proposal_id\` と \`operation_ids\` を保持し、\`review.open\` へ提案IDを渡してTaskHubの確認画面を開きます。利用者へ承認待ちであることを伝えてください。
5. 結果の確認には \`proposals.status\` へ提案IDと受付時の \`operation_ids\` 全件を同じ順序で渡します。部分承認を考慮し、操作ごとの結果を確認してください。

各操作の \`evidence_refs\` には \`kind=external_review\` の根拠を含めます。\`locator\` は返された \`evidence_locator_prefix\` に \`:\` とその操作の \`operation_id\` を付けた \`external-review:<proposal_context_id>:<operation_id>\` とし、\`excerpt\` は保存した \`source_text\` にそのまま含まれる空でない原文抜粋にしてください。

完了と取り下げでは \`status_evidence.kind=external_review_explicit\` とし、\`status_evidence.reference\` をその操作の外部根拠と同じ種類、locator、excerptにします。分割は \`create_task\` の \`creation.kind=split_child\` で表し、\`creation.instruction_reference\` をその子操作の外部根拠と一致させ、親タスクを指定してください。完了、取り下げ、分割には、対象と操作を特定できる利用者の明示的な原文が必要です。内部AIセッションや \`user_message\` の根拠を偽装しないでください。

変更の選択、編集、承認、却下はTaskHubのGUIで行います。CLIからは承認できず、選択された操作だけがGUI承認後にAsanaへ反映されます。

\`proposals.status\` の \`result.kind=current\` では提案の現在状態を確認します。承認結果に含まれる各操作の \`outcome\` が \`applied\` または \`already_applied\` の場合だけ、その操作を反映済みと報告してください。\`result.kind=journals\` では各操作の \`journal.final_result\` が \`applied\` の場合だけ反映済みと扱います。\`unknown\` や記録がない操作を未適用と断定しないでください。

応答喪失時に同じ要求を再送する場合は、同じ \`request_id\` と入力内容を使います。異なる内容へ同じIDを使わず、結果不明を理由に新しいIDで自動再提出しないでください。アプリ終了、接続先変更、連携の無効化で提案基準と未承認案は失効します。再起動後は保持した提案IDと操作IDで結果を照会してください。

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
