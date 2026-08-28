import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { createContextctlClientScript } from "../../external-tools/client-script";
import {
  externalToolDefinitionSchema,
  type ExternalToolDefinition,
} from "../../external-tools/schemas";
import { CodexWorkspaceError } from "./errors";

const directoryMode = 0o700;
const fileMode = 0o600;
const executableFileMode = 0o700;
const workspaceDirectoryName = "codex-workspace";
const maximumPathLength = 4_096;
const maximumRegisteredTools = 32;
const toolIdPattern = /^[a-z][a-z0-9._-]*$/u;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(maximumPathLength)
  .refine(isAbsolute, "パスは絶対パスで指定してください。")
  .refine(
    (value) => ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
    }),
    "パスに制御文字を指定できません。",
  )
  .refine((value) => !value.includes("\0"), "パスにNUL文字を指定できません。");

const toolDefinitionsSchema = z
  .array(externalToolDefinitionSchema)
  .max(maximumRegisteredTools)
  .superRefine((definitions, context) => {
    const seen = new Set<string>();
    for (const [index, definition] of definitions.entries()) {
      if (seen.has(definition.tool_id)) {
        context.addIssue({
          code: "custom",
          path: [index, "tool_id"],
          message: "同じ外部ツールIDを重複して指定できません。",
        });
      }
      seen.add(definition.tool_id);
    }
  });

/** contextctl導入に必要な安全なパスと登録内容を検証するスキーマです。 */
export const contextctlInstallationInputSchema = z
  .object({
    workspacePath: absolutePathSchema,
    connectionInfoPath: absolutePathSchema,
    toolDefinitions: toolDefinitionsSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const workspacePath = resolve(input.workspacePath);
    if (basename(workspacePath) !== workspaceDirectoryName) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "Codex専用ワークスペースのパスが不正です。",
      });
    }
    const tmpPath = join(workspacePath, "tmp");
    const connectionInfoPath = resolve(input.connectionInfoPath);
    const relativePath = relative(tmpPath, connectionInfoPath);
    if (
      relativePath.length === 0
      || relativePath === ".."
      || relativePath.startsWith(`..${sep}`)
      || isAbsolute(relativePath)
    ) {
      context.addIssue({
        code: "custom",
        path: ["connectionInfoPath"],
        message: "外部ツール接続情報はCodex専用ワークスペースのtmp内に指定してください。",
      });
    }
    if (parse(connectionInfoPath).dir !== tmpPath) {
      context.addIssue({
        code: "custom",
        path: ["connectionInfoPath"],
        message: "外部ツール接続情報はtmp直下に指定してください。",
      });
    }
  });

const installationPathSchema = z.object({
  workspacePath: absolutePathSchema,
  externalToolsSkillPath: absolutePathSchema,
});

const readyInstallationSchema = installationPathSchema
  .extend({
    kind: z.literal("ready"),
    contextctlPath: absolutePathSchema,
    toolIds: z.array(z.string().regex(toolIdPattern)).min(1).max(maximumRegisteredTools),
  })
  .strict()
  .superRefine((result, context) => {
    const expectedWorkspacePath = resolve(result.workspacePath);
    if (basename(expectedWorkspacePath) !== workspaceDirectoryName) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "Codex専用ワークスペースのパスが不正です。",
      });
    }
    const expectedContextctlPath = join(expectedWorkspacePath, "bin", "contextctl");
    const expectedSkillPath = join(
      expectedWorkspacePath,
      ".agents",
      "skills",
      "external-tools",
      "SKILL.md",
    );
    if (result.contextctlPath !== expectedContextctlPath) {
      context.addIssue({
        code: "custom",
        path: ["contextctlPath"],
        message: "contextctlの導入先が不正です。",
      });
    }
    if (result.externalToolsSkillPath !== expectedSkillPath) {
      context.addIssue({
        code: "custom",
        path: ["externalToolsSkillPath"],
        message: "外部ツールSkillの導入先が不正です。",
      });
    }
    const sortedToolIds = [...result.toolIds].sort(compareStrings);
    if (sortedToolIds.some((toolId, index) => toolId !== result.toolIds[index])) {
      context.addIssue({
        code: "custom",
        path: ["toolIds"],
        message: "外部ツールIDは決定論的な順序でなければなりません。",
      });
    }
    if (new Set(result.toolIds).size !== result.toolIds.length) {
      context.addIssue({
        code: "custom",
        path: ["toolIds"],
        message: "外部ツールIDを重複して返せません。",
      });
    }
  });

const disabledInstallationSchema = installationPathSchema
  .extend({
    kind: z.literal("disabled"),
    reason: z.enum(["no_registered_tools", "unsupported_platform"]),
  })
  .strict()
  .superRefine((result, context) => {
    const expectedWorkspacePath = resolve(result.workspacePath);
    if (basename(expectedWorkspacePath) !== workspaceDirectoryName) {
      context.addIssue({
        code: "custom",
        path: ["workspacePath"],
        message: "Codex専用ワークスペースのパスが不正です。",
      });
    }
    const expectedSkillPath = join(
      expectedWorkspacePath,
      ".agents",
      "skills",
      "external-tools",
      "SKILL.md",
    );
    if (result.externalToolsSkillPath !== expectedSkillPath) {
      context.addIssue({
        code: "custom",
        path: ["externalToolsSkillPath"],
        message: "外部ツールSkillの導入先が不正です。",
      });
    }
  });

/** contextctl導入の結果を検証するスキーマです。 */
export const contextctlInstallationResultSchema = z.discriminatedUnion("kind", [
  readyInstallationSchema,
  disabledInstallationSchema,
]);

export type ContextctlInstallationInput = z.infer<
  typeof contextctlInstallationInputSchema
>;
export type ContextctlInstallationResult = z.infer<
  typeof contextctlInstallationResultSchema
>;

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function currentUserId(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function assertOwned(stats: Stats, label: string): void {
  const userId = currentUserId();
  if (userId != null && stats.uid !== userId) {
    throw new CodexWorkspaceError(`${label}の所有者を確認できません。`);
  }
}

function lstatWithoutSymlink(filePath: string, label: string): Stats {
  const normalizedPath = resolve(filePath);
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  let stats: Stats;
  try {
    stats = lstatSync(currentPath);
  } catch (error: unknown) {
    throw new CodexWorkspaceError(`${label}を確認できません。`, { cause: error });
  }
  if (stats.isSymbolicLink()) {
    throw new CodexWorkspaceError(`${label}の親にシンボリックリンクを指定できません。`);
  }
  const remainingPath = relative(rootPath, normalizedPath);
  for (const part of remainingPath.split(sep).filter((segment) => segment.length > 0)) {
    currentPath = join(currentPath, part);
    try {
      stats = lstatSync(currentPath);
    } catch (error: unknown) {
      throw new CodexWorkspaceError(`${label}を確認できません。`, { cause: error });
    }
    if (stats.isSymbolicLink()) {
      throw new CodexWorkspaceError(`${label}の親にシンボリックリンクを指定できません。`);
    }
  }
  return stats;
}

function verifyDirectory(directoryPath: string, label: string): void {
  const stats = lstatWithoutSymlink(directoryPath, label);
  if (!stats.isDirectory()) {
    throw new CodexWorkspaceError(`${label}はディレクトリでなければなりません。`);
  }
  assertOwned(stats, label);
  chmodSync(directoryPath, directoryMode);
  const securedStats = lstatWithoutSymlink(directoryPath, label);
  if (!securedStats.isDirectory() || (securedStats.mode & 0o777) !== directoryMode) {
    throw new CodexWorkspaceError(`${label}の権限を固定できません。`);
  }
  assertOwned(securedStats, label);
}

function verifySecureFile(filePath: string, label: string, mode: number): void {
  const stats = lstatWithoutSymlink(filePath, label);
  if (!stats.isFile()) {
    throw new CodexWorkspaceError(`${label}が想定外のファイルです。`);
  }
  assertOwned(stats, label);
  if ((stats.mode & 0o777) !== mode) {
    throw new CodexWorkspaceError(`${label}の権限を固定できません。`);
  }
}

function verifyReplacementTarget(filePath: string, label: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(filePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw new CodexWorkspaceError(`${label}を確認できません。`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexWorkspaceError(`${label}が想定外のファイルです。`);
  }
  assertOwned(stats, label);
}

function writeFileAtomically(filePath: string, content: string, mode: number, label: string): void {
  const temporaryFilePath = `${filePath}.${randomUUID()}.tmp`;
  try {
    verifyReplacementTarget(filePath, label);
    writeFileSync(temporaryFilePath, content, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    chmodSync(temporaryFilePath, mode);
    renameSync(temporaryFilePath, filePath);
    verifySecureFile(filePath, label, mode);
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

function removeExistingFile(filePath: string, label: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(filePath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      return;
    }
    throw new CodexWorkspaceError(`${label}を確認できません。`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexWorkspaceError(`${label}が想定外のファイルです。`);
  }
  assertOwned(stats, label);
  unlinkSync(filePath);
}

function verifyWorkspacePaths(workspacePath: string): {
  readonly contextctlPath: string;
  readonly externalToolsSkillPath: string;
  readonly connectionInfoParentPath: string;
} {
  const normalizedWorkspacePath = resolve(workspacePath);
  const binPath = join(normalizedWorkspacePath, "bin");
  const externalToolsSkillDirectoryPath = join(
    normalizedWorkspacePath,
    ".agents",
    "skills",
    "external-tools",
  );
  const connectionInfoParentPath = join(normalizedWorkspacePath, "tmp");
  verifyDirectory(normalizedWorkspacePath, "Codex専用ワークスペース");
  verifyDirectory(join(normalizedWorkspacePath, ".agents"), "Codexエージェントディレクトリ");
  verifyDirectory(join(normalizedWorkspacePath, ".agents", "skills"), "Codexスキルディレクトリ");
  verifyDirectory(externalToolsSkillDirectoryPath, "外部ツールSkillディレクトリ");
  verifyDirectory(binPath, "Codexコマンドディレクトリ");
  verifyDirectory(connectionInfoParentPath, "Codex一時ディレクトリ");
  return {
    contextctlPath: join(binPath, "contextctl"),
    externalToolsSkillPath: join(externalToolsSkillDirectoryPath, "SKILL.md"),
    connectionInfoParentPath,
  };
}

function assertConnectionInfoPath(
  connectionInfoPath: string,
  connectionInfoParentPath: string,
): void {
  const normalizedPath = resolve(connectionInfoPath);
  const relativePath = relative(connectionInfoParentPath, normalizedPath);
  if (
    relativePath.length === 0
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || parse(normalizedPath).dir !== connectionInfoParentPath
  ) {
    throw new CodexWorkspaceError(
      "外部ツール接続情報はCodex専用ワークスペースのtmp内に指定してください。",
    );
  }
  lstatWithoutSymlink(parse(normalizedPath).dir, "外部ツール接続情報の親ディレクトリ");
  let stats: Stats | undefined;
  try {
    stats = lstatSync(normalizedPath);
  } catch (error: unknown) {
    if (isNoEntryError(error)) {
      throw new CodexWorkspaceError("外部ツール接続情報が存在しません。", { cause: error });
    }
    throw new CodexWorkspaceError("外部ツール接続情報を確認できません。", { cause: error });
  }
  if (stats == null) {
    throw new CodexWorkspaceError("外部ツール接続情報が存在しません。");
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexWorkspaceError("外部ツール接続情報が想定外のファイルです。");
  }
  assertOwned(stats, "外部ツール接続情報");
  if ((stats.mode & 0o777) !== fileMode) {
    throw new CodexWorkspaceError("外部ツール接続情報の権限が不正です。");
  }
}

function createExternalToolsSkillContent(
  definitions: readonly ExternalToolDefinition[],
): string {
  const lines = [
    "---",
    "name: external-tools",
    "description: 登録済み外部ツールを必要時だけ読み取る手順です。",
    "---",
    "",
    "# 外部ツール読み取り手順",
    "",
    "登録済みで読み取り専用の外部ツールだけを必要なときに参照します。",
    "",
    "- contextctlは登録内容にある読み取り専用サブコマンドだけを使用してください。",
    "- 入力形式は contextctl <tool-id> <許可サブコマンド> ... --json です。",
    "- 資格情報、実行ファイルのパス、外部本文を取得または保存しないでください。",
    "- 外部サービスへ書き込まず、変更、削除、送信の操作を実行しないでください。",
    "- 出力をファイルや長期メモへ保存せず、その場の判断材料として使用してください。",
    "",
    "## 登録済み外部ツール",
    "",
  ];
  for (const definition of definitions) {
    const subcommands = [...definition.allowed_subcommands].sort(compareStrings).join("、");
    const argumentsList = [...definition.allowed_argument_names].sort(compareStrings).join("、");
    const domains = definition.allowed_domains == null
      ? "なし"
      : [...definition.allowed_domains].sort(compareStrings).join("、");
    const httpMethods = definition.allowed_http_methods == null
      ? "なし"
      : [...definition.allowed_http_methods].sort(compareStrings).join("、");
    lines.push(
      `### ${definition.tool_id}`,
      `- 許可サブコマンド: ${subcommands}`,
      `- 許可引数名: ${argumentsList.length > 0 ? argumentsList : "なし"}`,
      `- 許可ドメイン: ${domains.length > 0 ? domains : "なし"}`,
      `- 許可HTTPメソッド: ${httpMethods.length > 0 ? httpMethods : "なし"}`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function createDisabledExternalToolsSkillContent(reason: "no_registered_tools" | "unsupported_platform"): string {
  const reasonText = reason === "no_registered_tools"
    ? "登録済み外部ツールがないためcontextctlは無効です。"
    : "このOSでは安全なcontextctl権限境界を検証できないため無効です。";
  return `${[
    "---",
    "name: external-tools",
    "description: 登録済み外部ツールを必要時だけ読み取る手順です。",
    "---",
    "",
    "# 外部ツール読み取り手順",
    "",
    reasonText,
    "登録内容がない外部ツールやcontextctlを使用しないでください。",
    "資格情報、実行ファイルのパス、外部本文を取得または保存しないでください。",
    "",
  ].join("\n")}\n`;
}

/** 外部ツールブローカー接続用contextctlと読み取り専用Skillを導入します。 */
export function installContextctlClientScript(
  input: ContextctlInstallationInput,
): ContextctlInstallationResult {
  const validatedInput = contextctlInstallationInputSchema.parse(input);
  const workspacePath = resolve(validatedInput.workspacePath);
  const externalToolsSkillPath = join(
    workspacePath,
    ".agents",
    "skills",
    "external-tools",
    "SKILL.md",
  );
  const paths = verifyWorkspacePaths(workspacePath);
  const definitions = [...validatedInput.toolDefinitions].sort((left, right) =>
    compareStrings(left.tool_id, right.tool_id));
  if (process.platform === "win32") {
    removeExistingFile(paths.contextctlPath, "contextctl");
    writeFileAtomically(
      paths.externalToolsSkillPath,
      createDisabledExternalToolsSkillContent("unsupported_platform"),
      fileMode,
      "外部ツールSkill",
    );
    return contextctlInstallationResultSchema.parse({
      kind: "disabled",
      reason: "unsupported_platform",
      workspacePath,
      externalToolsSkillPath,
    });
  }
  if (definitions.length === 0) {
    removeExistingFile(paths.contextctlPath, "contextctl");
    writeFileAtomically(
      paths.externalToolsSkillPath,
      createDisabledExternalToolsSkillContent("no_registered_tools"),
      fileMode,
      "外部ツールSkill",
    );
    return contextctlInstallationResultSchema.parse({
      kind: "disabled",
      reason: "no_registered_tools",
      workspacePath,
      externalToolsSkillPath: paths.externalToolsSkillPath,
    });
  }
  assertConnectionInfoPath(validatedInput.connectionInfoPath, paths.connectionInfoParentPath);
  const script = createContextctlClientScript(validatedInput.connectionInfoPath);
  writeFileAtomically(paths.contextctlPath, script, executableFileMode, "contextctl");
  writeFileAtomically(
    paths.externalToolsSkillPath,
    createExternalToolsSkillContent(definitions),
    fileMode,
    "外部ツールSkill",
  );
  return contextctlInstallationResultSchema.parse({
    kind: "ready",
    workspacePath,
    contextctlPath: paths.contextctlPath,
    externalToolsSkillPath: paths.externalToolsSkillPath,
    toolIds: definitions.map((definition) => definition.tool_id),
  });
}
