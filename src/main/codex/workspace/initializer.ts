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
- \`<pending_proposal>\` が提示された場合は、利用者が明示的に変更、取消し、または対象訂正をした操作を除き、その変更案の全操作を引き継いで改訂してください。承認前の操作を更新済みと説明しないでください。
- 利用者の現在の明示的な取消しまたは対象訂正は前案の保持より優先し、利用者の変更を妨げるためにkeepを強制しないでください。過去の表現だけから取消しや訂正を推測しないでください。
- 1回の応答で複数の項目を依頼された場合は、1つの変更案にまとめ、項目ごとに必要な操作を含めてください。
- \`operation_id\` と \`group_id\` は今回の変更案の中だけ一意にしてください。別の変更案との重複は問題ありません。
- 変更前値と基準ハッシュは今回の基準スナップショットに合わせて再生成し、推測は明示してください。
- 前案を保ったまま質問または情報回答を返す場合は、no_proposalのpending_proposal_actionをkeepにしてください。前案の全操作を利用者が明示的に撤回して残す操作がない場合だけdiscardにしてください。前案がなければkeepにしてください。
- 完了、取り下げ、分割の正規locatorを前案から再利用する場合だけ、継承aliasのlocator、source_id、excerpt、対象、操作、親をすべて一致させてください。aliasのsource_idはアプリが元sourceへ解決する値であり、AIはaliasの正規locatorを返してください。現在の利用者原文、対象タスク自身のnotes、children_only_all_completed、external_structured_statusから現在ターンの根拠を再生成する通常経路は維持してください。
- 前案の根拠を現在のsource一覧または現在ターンの構造化根拠で再確認できない場合は操作を黙って外さず、利用者へ質問しpending_proposal_action=keepを返してください。ただし現在の明示的な取消しや対象訂正がある場合はその指示に従ってください。
- 完了のuser_explicitは、利用者が対象作業を完了したという事実を報告している場合だけ提案してください。単なる状態変更要求、将来の完了、推測、対象の一部だけの完了は完了事実として扱わないでください。完了事実と対象が明白ならcompletedへの変更意図を別途要求せず、確認質問も追加しないでください。
- 取り下げは、利用者が対象作業を不要、中止、または取り下げる現在の意思を示し、対象が一つに定まる場合だけ提案してください。単なる削除方法の質問、将来の判断、仮定、引用、伝聞は取り下げの意思として扱わないでください。
- split_childは、対象成果を複数の子タスクへ分解して作成することを利用者が明示的に求めた場合だけ提案してください。親は既存タスクでもこの提案で作成する一時参照でも構いません。手順の列挙、例示、条件付きの提案、既存子タスクの再配置だけでは明示依頼にしないでください。
- 否定、引用、伝聞、仮定の文は、利用者本人の完了事実、取り下げ意思、分割依頼として扱わないでください。対象名や代名詞が複数候補になる場合は質問し、部分完了を全体完了へ拡張しないでください。同じ要求内または会話中の最新の明示的な訂正や撤回を優先してください。
- 意味または対象が不明な場合だけ判断に必要な質問を行い、推測で変更案を作らないでください。
- raw sourceのlocatorにはsource IDをそのまま使い、操作名や対象GIDのsuffixを付加しないでください。excerptには原文の正確な非空部分文字列を指定してください。
- task_or_note_explicitのtask sourceは対象タスク自身のnotes sourceだけを指定してください。Obsidian本文や検索抜粋は完了・取り下げの根拠に使用しないでください。
- children_only_all_completedとexternal_structured_statusは、当該ターンでアプリが提供した構造化根拠のlocator、対象、許可操作だけを使用してください。
- 取り下げの確認を求める場合は、取り下げ依頼で候補が1件に定まり、no_proposalの単一質問に候補1件のtarget_task_gidとallowed_operation=withdrawを持つwithdraw_confirmationを設定してください。質問が複数、候補が複数、対象が不明、または取り下げ依頼でない場合は設定しないでください。
- 確認回答用sourceは、そのsourceが保持する対象GID、基準status、基準completedへの明白なwithdraw同意だけに使用してください。直接の新規指示や訂正には確認回答用sourceを使わないでください。
- 外部ツールの構造化状態は、当該ターンの応答が返したevidence locator、status、target_task_gidだけを根拠に使用してください。
- split_childのinstruction_referenceはraw sourceまたは全拘束条件が一致する継承aliasを使ってください。アプリは原文、対象、操作、親、構造根拠を検証して正規locatorを生成しますが、自然言語の意味を再判定しません。
- 変更は検証済みoperationsだけで表し、全操作へ今回の基準スナップショットのbaseline_snapshot_hashを設定してください。
- 新規タスクのcreate_taskにはタイトルと要求内容から見積もったdurationを含め、minute、hour、day、week、monthのいずれか一つの粗い単位で表してください。minuteは15以上、それ以外は1以上とし、durationは作業量だけを表してください。返答待ちなどの待機期間は含めないでください。既存タスクのdurationが未設定なら必要に応じてset_durationの推定案を提示できます。設定済みdurationは明示的な変更依頼または再推定依頼がある場合だけ変更してください。
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
