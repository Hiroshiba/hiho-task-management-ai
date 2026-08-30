import { basename, isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";

const maxPathLength = 4_096;
const workspaceDirectoryName = "codex-workspace";
const codexHomeDirectoryName = "codex-home";
const skillNamesSchema = z.tuple([
  z.literal("taskctl"),
  z.literal("obsidian"),
  z.literal("external-tools"),
]);

const absolutePathSchema = z
  .string()
  .min(1)
  .max(maxPathLength)
  .refine(isAbsolute, "パスは絶対パスで指定してください。")
  .refine((value) => !value.includes("\0"), "パスに使用できない文字が含まれています。");

const userDataPathSchema = absolutePathSchema.superRefine((value, context) => {
  const normalizedPath = resolve(value);
  if (normalizedPath === parse(normalizedPath).root) {
    context.addIssue({
      code: "custom",
      message: "ユーザーデータ領域にファイルシステムのルートを指定できません。",
    });
  }
  if (basename(normalizedPath) === workspaceDirectoryName) {
    context.addIssue({
      code: "custom",
      message: "Codex専用ワークスペース自身をユーザーデータ領域に指定できません。",
    });
  }
});

/** Codex専用ワークスペース初期化の入力を表すスキーマです。 */
export const codexWorkspaceInitializationInputSchema = z
  .object({
    userDataPath: userDataPathSchema,
  })
  .strict();

/** Codex専用ワークスペース初期化の結果を表すスキーマです。 */
export const codexWorkspaceInitializationResultSchema = z
  .object({
    userDataPath: userDataPathSchema,
    codexHomePath: absolutePathSchema,
    workspacePath: absolutePathSchema,
    agentsFilePath: absolutePathSchema,
    skillsDirectoryPath: absolutePathSchema,
    binDirectoryPath: absolutePathSchema,
    taskctlPath: absolutePathSchema,
    tmpDirectoryPath: absolutePathSchema,
    skillNames: skillNamesSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const expectedWorkspacePath = join(result.userDataPath, workspaceDirectoryName);
    const expectedCodexHomePath = join(result.userDataPath, codexHomeDirectoryName);
    const expectedAgentsFilePath = join(expectedWorkspacePath, "AGENTS.md");
    const expectedSkillsDirectoryPath = join(
      expectedWorkspacePath,
      ".agents",
      "skills",
    );
    const expectedBinDirectoryPath = join(expectedWorkspacePath, "bin");
    const expectedTaskctlPath = join(expectedBinDirectoryPath, "taskctl");
    const expectedTmpDirectoryPath = join(expectedWorkspacePath, "tmp");
    const expectedPaths: readonly [string, string, string][] = [
      ["codexHomePath", expectedCodexHomePath, result.codexHomePath],
      ["workspacePath", expectedWorkspacePath, result.workspacePath],
      ["agentsFilePath", expectedAgentsFilePath, result.agentsFilePath],
      ["skillsDirectoryPath", expectedSkillsDirectoryPath, result.skillsDirectoryPath],
      ["binDirectoryPath", expectedBinDirectoryPath, result.binDirectoryPath],
      ["taskctlPath", expectedTaskctlPath, result.taskctlPath],
      ["tmpDirectoryPath", expectedTmpDirectoryPath, result.tmpDirectoryPath],
    ];

    for (const [field, expectedPath, actualPath] of expectedPaths) {
      if (actualPath !== expectedPath) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "初期化結果のパス構成が不正です。",
        });
      }
    }
  });

export type CodexWorkspaceInitializationInput = z.infer<
  typeof codexWorkspaceInitializationInputSchema
>;
export type CodexWorkspaceInitializationResult = z.infer<
  typeof codexWorkspaceInitializationResultSchema
>;
