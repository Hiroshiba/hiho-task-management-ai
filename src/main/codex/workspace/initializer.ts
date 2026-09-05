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

- タスク情報と登録済みの読み取り専用情報源だけを参照してください。
- AsanaやObsidianなどの外部情報源へ書き込まないでください。
- 認証情報、トークン、Client Secret、キーチェーンの内容を読まないでください。
- 承認前の変更を直接適用せず、AI変更案プロトコルに従う構造化変更案だけを返してください。
- この作業ディレクトリではtmp/だけへ書き込んでください。
- タスク全件スナップショット、会話、本文、外部取得結果を永続化しないでください。
- taskctl、Obsidian、外部ツールのスキルは必要なときだけ読み取り専用で使用してください。
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
