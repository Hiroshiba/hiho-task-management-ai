import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, join, parse, relative, resolve, sep } from "node:path";
import {
  codexWorkspaceInitializationInputSchema,
  codexWorkspaceInitializationResultSchema,
  type CodexWorkspaceInitializationInput,
  type CodexWorkspaceInitializationResult,
} from "./schemas";
import { CodexWorkspaceError } from "./errors";
import {
  taskctlClientScript,
  taskctlWindowsLauncherScript,
} from "../taskctl/client-script";

const workspaceDirectoryName = "codex-workspace";
const codexHomeDirectoryName = "codex-home";
const agentsDirectoryName = ".agents";
const skillsDirectoryName = "skills";
const agentsFileName = "AGENTS.md";
const binDirectoryName = "bin";
const tmpDirectoryName = "tmp";
const directoryMode = 0o700;
const fileMode = 0o600;
const executableFileMode = 0o700;

const agentsFileContent = `# TaskHub Codex 作業指示

あなたはTaskHubの変更案作成を支援するCodexです。

- TaskHubの構造化変更案だけを検討し、messageには利用者への説明だけを入れてください。承認前の変更を直接適用しないでください。
- タスク情報と登録済みの読み取り専用情報源だけを参照してください。
- AsanaやObsidianなどの外部情報源へ書き込まないでください。
- 認証情報、トークン、Client Secret、キーチェーンの内容を読まないでください。
- この作業ディレクトリではtmp/だけへ書き込んでください。
- タスク全件スナップショット、会話、本文、外部取得結果を永続化しないでください。
- taskctl、Obsidian、外部ツールのスキルは必要なときだけ読み取り専用で使用し、情報質問ではno_proposalを返してください。
- \`<pending_proposal>\` が提示された場合は、利用者が明示的に変更または撤回した操作を除き、その変更案の全操作を引き継いで改訂してください。承認前の操作を更新済みと説明しないでください。
- 1回の応答で複数の項目を依頼された場合は、1つの変更案にまとめ、項目ごとに必要な操作を含めてください。
- \`operation_id\` と \`group_id\` は今回の変更案の中だけ一意にしてください。別の変更案との重複は問題ありません。
- 変更前値と基準ハッシュは今回の基準スナップショットに合わせて再生成し、推測は明示してください。
- 前案を保ったまま質問または情報回答を返す場合は、no_proposalのpending_proposal_actionをkeepにしてください。前案の全操作を利用者が明示的に撤回して残す操作がない場合だけdiscardにしてください。前案がなければkeepにしてください。
- 前案の完了、取り下げ、分割操作の根拠が現在の固定検証済み一覧で再確認できない場合は、操作を黙って外さず、質問とpending_proposal_action=keepを返してください。
- 変更は検証済みoperationsだけで表し、全操作へ今回の基準スナップショットのbaseline_snapshot_hashを設定してください。
- 新規タスクのcreate_taskにはタイトルと要求内容から見積もったdurationを含め、minute、hour、day、week、monthのいずれか一つの粗い単位で表してください。minuteは15以上、それ以外は1以上とし、durationは作業量だけを表してください。返答待ちなどの待機期間は含めないでください。既存タスクのdurationが未設定なら必要に応じてset_durationの推定案を提示できます。設定済みdurationは明示的な変更依頼または再推定依頼がある場合だけ変更してください。
- 完了・取り下げ操作のuser_explicitは、固定検証済み根拠一覧にあるkind=user_message、対象GID、allowed_operationが一致するreferenceだけを使ってください。一般のlocatorや未検証のObsidian本文は根拠に使わないでください。
- 完了・取り下げの根拠種別は、explicit_textをtask_or_note_explicit、children_only_all_completedを同名の構造的根拠として使ってください。外部ツールの状態は応答が返したevidence locator、status、target_task_gidだけを使ってください。
- 取り下げ確認は取り下げ依頼で候補が1件に定まるときだけ、no_proposalの単一質問にwithdraw_confirmationを設定してください。
- split_childのinstruction_referenceには固定検証済みの分割依頼locatorだけを使い、一覧が空なら提案しないでください。
`;

const skillContents: Readonly<Record<string, string>> = {
  taskctl: `---
name: taskctl
description: 同期済みTaskHubタスク情報を必要時だけ読み取る手順です。
---

# taskctl読み取り手順

同期済みのTaskHubデータを必要なときだけ読み取ります。

- taskctlは読み取り専用情報源として扱ってください。
- 認証情報を引数、環境変数、出力から取得しないでください。
- 出力をファイルへ保存せず、その場の判断材料として使用してください。
- Codexのdynamic tool taskctl を必要なときだけ呼び出し、commandに list、get、rank、graph、areas、search-local のいずれかを指定してください。
- get では gid、search-local では query を指定し、それ以外のcommandでは追加項目を指定しないでください。
- list は完了・取り下げを含む管理対象全件を同期状態とGID順で返し、get は指定タスクまたは構造化された不存在エラーを返します。
- rank は同期状態と保存済み順位を返し、ranking.cache.ranked_tasks が画面の通常一覧に表示される現在のタスクです。
- ユーザーが単に「タスク何個」「現在のタスク数」と尋ねたときは taskctl の command rank を呼び出して data.ranking.cache.ranked_tasks.length を答え、順位情報が利用不能なら件数を推測せず、その状態を伝えてください。
- ユーザーが全管理対象、完了、取り下げを含む件数を明示したときだけ taskctl の command list を呼び出して件数を数えてください。
- graph はタスクと依存、親子の辺、areas は領域名の配列を返します。
- search-local は query に一致する同期済みタスクをGID順で返します。
- 成功応答と失敗応答の両方に最新同期状態が含まれます。同期状態がunavailableでもデータ不存在とはみなさず、変更案の根拠に使わないでください。
- 失敗応答は ok:false と固定エラーコードを持ちます。
- タスクを作成、更新、削除する操作は実行しないでください。
- 読み取り質問では必要なtaskctl dynamic toolを呼び出してください。応答が失敗しただけでデータアクセスが拒否されたと断定しないでください。
`,
  obsidian: `---
name: obsidian
description: 登録済みObsidian Vaultを必要時だけ読み取る手順です。
---

# Obsidian読み取り手順

登録済みで読み取り専用のVaultだけを必要なときに参照します。

- Vaultの本文と相対リンクを判断材料として読み取れます。
- Vaultへ書き込まず、ファイルを作成、更新、削除しないでください。
- 認証情報や未登録のパスを読まないでください。
- 読み取った本文をファイルや長期メモへ保存しないでください。
- Codexのdynamic tool obsidianを必要なときだけ呼び出してください。
- 最初にcommand vaultsで登録済みVault IDを確認し、以降はそのIDだけを指定してください。
- ノート一覧はcommand list、検索はcommand search、本文の確認はcommand readを使ってください。
- command searchのqueryは検索文字列、command readのrelative_pathは検索結果にあるMarkdownの相対パスだけを指定してください。
- 最近更新されたノートはcommand recentで取得し、vault_idと1以上100以下のlimitを指定してください。
- 情報の確認だけを求められた場合は、読み取り結果を返して変更案を作成しないでください。
- Obsidian本文や検索抜粋は完了・取り下げの根拠に使用しないでください。
`,
  "external-tools": `---
name: external-tools
description: 安全なOS実行境界がないため無効化された外部ツール連携です。
---

# 外部ツール読み取り手順

安全なOS実行境界を提供できないため外部ツール連携は無効です。
外部ツールやcontextctlを使用しないでください。
資格情報、実行ファイルのパス、外部本文を取得または保存しないでください。
`,
};

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function assertNoSymlinkPath(directoryPath: string): void {
  const normalizedPath = resolve(directoryPath);
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  const remainingPath = relative(rootPath, normalizedPath);
  for (const part of remainingPath.split(sep).filter((segment) => segment.length > 0)) {
    currentPath = join(currentPath, part);
    const stats = lstatSync(currentPath);
    if (stats.isSymbolicLink()) {
      throw new CodexWorkspaceError(
        "Codex専用ワークスペースの親ディレクトリにシンボリックリンクを指定できません。",
      );
    }
  }
}

function ensureDirectory(directoryPath: string, label: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(directoryPath);
  } catch (error: unknown) {
    if (!isNoEntryError(error)) {
      throw error;
    }
    mkdirSync(directoryPath, { mode: directoryMode });
    stats = lstatSync(directoryPath);
  }
  if (stats.isSymbolicLink()) {
    throw new CodexWorkspaceError(`${label}にシンボリックリンクを指定できません。`);
  }
  if (!stats.isDirectory()) {
    throw new CodexWorkspaceError(`${label}はディレクトリでなければなりません。`);
  }
  chmodSync(directoryPath, directoryMode);
}

function removeTemporaryEntry(entryPath: string): void {
  const stats = lstatSync(entryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    unlinkSync(entryPath);
    return;
  }
  clearTemporaryDirectory(entryPath);
  rmdirSync(entryPath);
}

function clearTemporaryDirectory(directoryPath: string): void {
  const entries = readdirSync(directoryPath);
  for (const entry of entries) {
    removeTemporaryEntry(join(directoryPath, entry));
  }
}

/** AI依頼用ワークスペースの親ディレクトリを初期化します。 */
export function initializeCodexSessionWorkspaceParent(
  parentPath: string,
): string {
  const normalizedParentPath = resolve(parentPath);
  assertNoSymlinkPath(parse(normalizedParentPath).dir);
  ensureDirectory(normalizedParentPath, "AIセッション用ワークスペースの親ディレクトリ");
  for (const entry of readdirSync(normalizedParentPath)) {
    if (!entry.startsWith("ai-session-")) {
      throw new CodexWorkspaceError(
        "AIセッション用ワークスペースの親ディレクトリに不正な項目があります。",
      );
    }
    removeCodexSessionWorkspace(
      join(normalizedParentPath, entry),
      normalizedParentPath,
    );
  }
  return normalizedParentPath;
}

function writeFileAtomically(filePath: string, content: string, mode: number): void {
  const temporaryFilePath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryFilePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    chmodSync(temporaryFilePath, mode);
    renameSync(temporaryFilePath, filePath);
  } catch (error: unknown) {
    try {
      unlinkSync(temporaryFilePath);
    } catch (cleanupError: unknown) {
      if (!isNoEntryError(cleanupError)) {
        throw new CodexWorkspaceError(
          "Codex専用ワークスペースの一時ファイルを削除できません。",
          { cause: new AggregateError([error, cleanupError]) },
        );
      }
    }
    throw error;
  }
}

/** AI依頼ごとのCodex専用ワークスペースを削除します。 */
export function removeCodexSessionWorkspace(
  userDataPath: string,
  parentPath: string,
): void {
  const normalizedUserDataPath = resolve(userDataPath);
  const normalizedParentPath = resolve(parentPath);
  if (
    parse(normalizedUserDataPath).dir !== normalizedParentPath
    || !/^ai-session-[0-9a-f-]+$/u.test(basename(normalizedUserDataPath))
  ) {
    throw new CodexWorkspaceError("AIセッションのワークスペースパスが不正です。");
  }
  assertNoSymlinkPath(normalizedParentPath);
  let stats: Stats;
  try {
    stats = lstatSync(normalizedUserDataPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw new CodexWorkspaceError(
      "AIセッションのワークスペースを確認できません。",
      { cause: error },
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CodexWorkspaceError("AIセッションのワークスペースが不正です。");
  }
  assertNoSymlinkPath(normalizedUserDataPath);
  clearTemporaryDirectory(normalizedUserDataPath);
  rmdirSync(normalizedUserDataPath);
}

/** AI依頼用のユーザーデータ領域を作成します。 */
export function createCodexSessionWorkspaceUserDataPath(
  parentPath: string,
  sessionId: string,
): string {
  const normalizedParentPath = resolve(parentPath);
  if (!/^[0-9a-f-]+$/u.test(sessionId)) {
    throw new CodexWorkspaceError("AIセッションIDが不正です。");
  }
  assertNoSymlinkPath(normalizedParentPath);
  ensureDirectory(normalizedParentPath, "AIセッション用ワークスペースの親ディレクトリ");
  const userDataPath = join(normalizedParentPath, `ai-session-${sessionId}`);
  mkdirSync(userDataPath, { mode: directoryMode });
  return resolve(userDataPath);
}

function writeFixedFiles(
  skillsPath: string,
  agentsPath: string,
  taskctlPath: string,
  taskctlWindowsLauncherPath: string,
): void {
  writeFileAtomically(agentsPath, agentsFileContent, fileMode);
  for (const [skillName, content] of Object.entries(skillContents)) {
    writeFileAtomically(join(skillsPath, skillName, "SKILL.md"), content, fileMode);
  }
  writeFileAtomically(taskctlPath, taskctlClientScript, executableFileMode);
  writeFileAtomically(
    taskctlWindowsLauncherPath,
    taskctlWindowsLauncherScript,
    executableFileMode,
  );
}

/** Codex専用ワークスペースを安全に初期化します。 */
export function initializeCodexWorkspace(
  input: CodexWorkspaceInitializationInput,
): CodexWorkspaceInitializationResult {
  const validatedInput = codexWorkspaceInitializationInputSchema.parse(input);
  const userDataPath = resolve(validatedInput.userDataPath);
  assertNoSymlinkPath(userDataPath);
  ensureDirectory(userDataPath, "ユーザーデータ領域");

  const workspacePath = join(userDataPath, workspaceDirectoryName);
  const codexHomePath = join(userDataPath, codexHomeDirectoryName);
  const agentsDirectoryPath = join(workspacePath, agentsDirectoryName);
  const skillsDirectoryPath = join(agentsDirectoryPath, skillsDirectoryName);
  const agentsFilePath = join(workspacePath, agentsFileName);
  const binDirectoryPath = join(workspacePath, binDirectoryName);
  const taskctlPath = join(binDirectoryPath, "taskctl");
  const taskctlWindowsLauncherPath = join(binDirectoryPath, "taskctl.cmd");
  const tmpDirectoryPath = join(workspacePath, tmpDirectoryName);

  ensureDirectory(codexHomePath, "TaskHub専用Codexホーム");
  ensureDirectory(workspacePath, "Codex専用ワークスペース");
  ensureDirectory(agentsDirectoryPath, "Codexスキル設定ディレクトリ");
  ensureDirectory(skillsDirectoryPath, "Codexスキルディレクトリ");
  for (const skillName of Object.keys(skillContents)) {
    ensureDirectory(join(skillsDirectoryPath, skillName), "Codexスキルディレクトリ");
  }
  ensureDirectory(binDirectoryPath, "Codexコマンドディレクトリ");
  ensureDirectory(tmpDirectoryPath, "Codex一時ディレクトリ");
  clearTemporaryDirectory(tmpDirectoryPath);
  writeFixedFiles(
    skillsDirectoryPath,
    agentsFilePath,
    taskctlPath,
    taskctlWindowsLauncherPath,
  );

  return codexWorkspaceInitializationResultSchema.parse({
    userDataPath,
    codexHomePath,
    workspacePath,
    agentsFilePath,
    skillsDirectoryPath,
    binDirectoryPath,
    taskctlPath,
    tmpDirectoryPath,
    skillNames: ["taskctl", "obsidian", "external-tools"],
  });
}
