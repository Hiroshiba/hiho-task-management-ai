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
import { join, parse, relative, resolve, sep } from "node:path";
import {
  codexWorkspaceInitializationInputSchema,
  codexWorkspaceInitializationResultSchema,
  type CodexWorkspaceInitializationInput,
  type CodexWorkspaceInitializationResult,
} from "./schemas";
import { CodexWorkspaceError } from "./errors";
import { taskctlClientScript } from "../taskctl/client-script";

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

- taskctlは読み取り専用コマンドとして扱ってください。
- 認証情報を引数、環境変数、出力から取得しないでください。
- 出力をファイルへ保存せず、その場の判断材料として使用してください。
- 必要なときだけ taskctl list --json、taskctl get <task-gid> --json、taskctl rank --json、taskctl graph --json、taskctl areas --json、taskctl search-local --query <text> --json を使用してください。
- list は同期状態とGID順のタスク配列、get は指定タスクまたは構造化された不存在エラーを返します。
- rank は同期状態と保存済み順位、graph はタスクと依存、親子の辺、areas は領域名の配列を返します。
- search-local --query は同期状態、検索文字列、タイトルや本文、領域に一致したGID順のタスク配列を返します。
- 成功応答と失敗応答の両方に最新同期状態が含まれます。同期状態がunavailableでもデータ不存在とはみなさず、変更案の根拠に使わないでください。
- 失敗応答は ok:false と固定エラーコードを持ち、コマンドの終了状態も失敗になります。
- タスクを作成、更新、削除するコマンドは実行しないでください。
- Windowsで直接実行できない場合は node bin/taskctl <許可された引数> として呼び出してください。
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

function writeFixedFiles(
  skillsPath: string,
  agentsPath: string,
  taskctlPath: string,
): void {
  writeFileAtomically(agentsPath, agentsFileContent, fileMode);
  for (const [skillName, content] of Object.entries(skillContents)) {
    writeFileAtomically(join(skillsPath, skillName, "SKILL.md"), content, fileMode);
  }
  writeFileAtomically(taskctlPath, taskctlClientScript, executableFileMode);
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
  writeFixedFiles(skillsDirectoryPath, agentsFilePath, taskctlPath);

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
