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
  externalAgentProtocolVersion,
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
description: TaskHubを明示的に指定した要求でタスクを参照し、変更案を作成・編集・提出して適用結果を確認する。
---

# TaskHub外部連携

このSkillは、明示的にTaskHubを指定した要求だけで使います。
外部連携プロトコルは ${externalAgentProtocolVersion} です。

毎回、最初に次のコマンドで現在の仕様と利用可能な操作を取得してください。

\`bash "$HOME/.agents/skills/taskhub/scripts/taskhub" agent-info\`

TaskHubへの要求は、同じランチャーを \`request\` で呼び出し、JSONを標準入力へ渡してください。

\`bash "$HOME/.agents/skills/taskhub/scripts/taskhub" request\`

標準出力はJSONで、操作結果は \`output\` に入ります。以下の応答項目は \`output\` 内を指します。\`ok=false\` または \`output.kind=error\` は失敗で、終了コードも非ゼロになります。診断は標準エラーへ出ます。

\`agent-info\` の \`capabilities\` と \`input_schema\` に従い、JSONの \`operation\` で操作を指定してください。準備や提出によって利用可能な操作が増えるため、必要に応じて \`agent-info\` を再取得します。利用者の文章をシェルの実行文字列へ埋め込まないでください。

タスク参照には \`tasks.list\`、\`tasks.get\`、\`tasks.rank\`、\`tasks.graph\`、\`tasks.areas\`、\`tasks.search-local\` を使えます。読み取りだけなら \`proposal_context_id\` を省略し、現在の同期済み情報を取得します。応答の同期時刻を確認し、オフラインの情報を最新と断定しないでください。

変更案ではTaskHub内部のAIと同じ17種類のタスク操作を使い、複数のグループと操作を1つの提案にまとめられます。作成、タイトルや説明の変更、期限や状態の変更、親子・依存関係、分割、完了、取り下げなどを扱います。

1. \`proposals.prepare\` へ \`agent-info\` の \`instance_id\` と \`context\` 内の \`context_id\`、\`project_gid\`、新しい \`request_id\`、利用者の依頼原文を表す \`source_text\` を渡します。原文を要約やAI自身の文章に置き換えないでください。
2. 返された \`proposal_context_id\`、\`workspace_id\`、初期値0の \`revision\`、\`turn_context\`、\`evidence_locator_prefix\` を保持します。変更案に必要なタスク参照には、その \`proposal_context_id\` を指定して固定した基準を使ってください。各操作の基準ハッシュには \`turn_context.baseline_snapshot_hash\`、既存タスクの変更前値には固定した読み取り結果を使います。
3. \`proposals.read\` で現在の案を読み、\`proposals.apply-edits\` で編集します。初回は \`edits\` 配列の1要素に \`kind=replace_all\` と完全な \`proposal\` を指定できます。大きな案は \`set_title\`、\`insert_group\`、\`insert_operation\` で分割して作成してください。追加編集では既存の \`group_id\` と \`operation_id\` を指定し、操作の置換・移動でIDを変えないでください。
4. \`proposals.diff\` で指定した改訂番号からの変更を読み、\`proposals.validate\` で提出条件と操作ごとの検証結果を確認します。\`can_submit=false\` の場合は構造や原文根拠の不備を修正してください。\`can_submit=true\` の \`review.entries\` には、\`kind=operation\` の操作判定と \`kind=diagnostic\` の診断が入ります。操作判定の \`basic.kind\`、\`graph.kind\`、\`eligible\` を確認し、不適合の操作はGUIでの部分採用や編集が必要なことを利用者へ伝えてください。診断の \`phase\` は \`basic\` または \`graph\` です。
5. 提出前に \`proposals.read\` の \`target.kind=summary\` で全グループを読み、グループ順・各グループ内の操作順に \`operation_ids\` 全件を保持します。\`proposals.submit\` へ、準備に使ったIDとは別の新しい \`request_id\` と、提出する \`expected_revision\` を渡します。提出成功の判定は \`result.kind=submitted\` で行い、\`result.proposal_id\` を保持してください。提出応答は \`result.operation_count\` を返します。
6. 受付結果の \`result.state_kind=pending_approval\` を確認し、\`review.open\` へ \`proposal_id\` を渡してTaskHubの確認画面を開きます。利用者へ承認待ちであることを伝えてください。
7. 結果の確認には \`proposals.status\` へ \`proposal_id\` と提出前に保持した \`operation_ids\` 全件を同じ順序で渡します。部分承認を考慮し、操作ごとの結果を確認してください。

\`proposals.read\`、\`proposals.apply-edits\`、\`proposals.diff\`、\`proposals.validate\`、\`proposals.submit\` には、準備時の \`instance_id\`、\`context_id\`、\`project_gid\` と、返された \`proposal_context_id\`、\`workspace_id\` を毎回指定します。別の基準やワークスペースのIDを組み合わせないでください。

\`proposals.read\` の \`target.kind\` は \`summary\`、\`proposal\`、\`group\`、\`operation\` です。グループや操作の部分読み取りでは対象IDも指定します。\`read\` と \`diff\` は現在の \`revision\`、\`diff\` は差分の開始位置を表す \`from_revision\` も必要です。\`apply-edits\`、\`validate\`、\`submit\` は現在の \`expected_revision\` を指定します。

\`code=stale_revision\` が返った場合は、\`current_revision\` を \`proposals.read\` の \`revision\` に指定して現在の案を読み直してください。読み直した内容に合わせて追加編集を組み立て、新しい \`edit_batch_id\` と現在の \`expected_revision\` を使います。

編集ごとに新しい \`edit_batch_id\` を発行し、\`edits\` 配列へ編集をまとめます。バッチは全体が成功した場合だけ反映され、\`revision\` が1増えます。以後は編集応答の \`revision\` を使ってください。\`issue_count\` が1以上なら \`proposals.validate\` で不備を確認します。タイトル未設定、空グループ、一時参照の未解決は編集中に保持できますが、提出までに完成させてください。

\`read\` と \`diff\` の応答はJSONを分割した \`content\` 文字列です。\`next_offset\` があれば、同じ改訂番号と読み取り対象のまま、次の要求の \`offset\` に指定します。全ページの \`content\` を順番に連結してJSONとして読んでください。ワークスペース応答は63 KiB、編集バッチは128 KiBの上限に従って分割してください。

\`validate\` の \`review.kind=operations\` は、操作判定と診断を合わせた \`entry_count\` と \`entries\` を返します。\`operation_count\` は操作数です。\`review.kind=issues\` は \`issue_count\` と \`issues\` を返します。いずれも \`review.offset\` から最大50項目を返し、続きは同じ \`expected_revision\` と、\`review.next_offset\` を指定した \`offset\` で取得してください。操作判定とその診断が別ページになる場合もあるため、全ページを読み、\`group_id\` と \`operation_id\` で対応付けます。不備と診断の長文メッセージは省略されることがあり、\`message_truncated=true\` で示します。

各操作の \`evidence_refs\` には \`kind=external_review\` の根拠を含めます。\`locator\` は返された \`evidence_locator_prefix\` に \`:\` とその操作の \`operation_id\` を付けた \`external-review:<proposal_context_id>:<operation_id>\` とし、\`excerpt\` は保存した \`source_text\` にそのまま含まれる空でない原文抜粋にしてください。

完了と取り下げでは \`status_evidence.kind=external_review_explicit\` とし、\`status_evidence.reference\` をその操作の外部根拠と同じ種類、locator、excerptにします。分割は \`create_task\` の \`creation.kind=split_child\` で表し、\`creation.instruction_reference\` をその子操作の外部根拠と一致させ、親タスクを指定してください。完了、取り下げ、分割には、対象と操作を特定できる利用者の明示的な原文が必要です。内部AIセッションや \`user_message\` の根拠を偽装しないでください。

提出には、完成形の変更案と全操作の原文根拠が必要です。\`proposals.submit\` が \`result.kind=invalid\` を返した場合は、\`proposals.validate\` で不備を確認し、同じワークスペースを編集してください。訂正した改訂番号の提出には新しい \`request_id\` を使います。

提出に成功したワークスペースは封印されます。以後の変更の選択、編集、承認、却下はTaskHubのGUIで行います。基本検証やグラフ検証が不適合の操作もレビューへ残し、利用者が適用可能なグループや非一括の操作を選べます。CLIからは承認できず、選択された操作だけがGUI承認後にAsanaへ反映されます。

\`proposals.status\` の \`result.kind=current\` は、\`result.proposal\` に提案や文脈のID、改訂番号、出所、\`operation_ids\`、\`state\` を返します。\`state.kind=finished\` の \`state.result.application.operations\` で各操作の \`outcome\` を確認し、\`applied\` または \`already_applied\` の場合だけ反映済みと報告してください。\`result.kind=journals\` では各操作の \`journal.final_result\` が \`applied\` の場合だけ反映済みと扱います。\`unknown\` や記録がない操作を未適用と断定しないでください。

応答喪失時は、準備と提出には同じ \`request_id\`、編集には同じ \`edit_batch_id\` を使い、入力内容を変えずに再送します。同じ編集を二重適用せず、提出済みの要求は同じ提案IDと現在状態を返します。異なる内容へ同じIDを使わず、結果不明を理由に新しいIDで自動再提出しないでください。

アプリ終了、接続先変更、Asana再認証、連携の無効化で提案基準、ワークスペース、未承認案は失効します。再起動後は保持した提案IDと操作IDで結果を照会してください。

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
