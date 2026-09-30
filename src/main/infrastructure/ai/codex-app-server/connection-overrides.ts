import { isAbsolute } from "node:path";
import { z } from "zod";
import { pathSchema } from "./common-schemas";

const maxCodexConfigOverrideCount = 64;
const maxCodexConfigOverrideCodeUnits = 16 * 1024;
const maxCodexConfigOverrideBytes = 16 * 1024;
const maxCodexConfigOverrideTotalCodeUnits = 8 * 1024;
export const maxCodexExecutableCodeUnits = 4_096;
export const maxWindowsCommandLineCodeUnits = 32_767;
const maxTaskHubPermissionVaultPaths = 32;
const maxTaskHubPermissionSocketPaths = 33;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return true;
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const tomlBasicStringValueSchema = z
  .string()
  .refine(
    (value) => !value.includes("\0"),
    "TOML文字列にNULを指定できません。",
  )
  .refine(
    (value) => !value.includes("\n") && !value.includes("\r"),
    "TOML文字列に改行を指定できません。",
  )
  .refine(
    (value) => !containsControlCharacter(value),
    "TOML文字列に制御文字を指定できません。",
  )
  .refine(
    (value) => !containsLoneSurrogate(value),
    "TOML文字列に孤立したサロゲートを指定できません。",
  );

const tomlBasicStringSchema = z
  .string()
  .min(2)
  .refine(
    (value) => value.startsWith("\"") && value.endsWith("\""),
    "TOML基本文字列の引用が不正です。",
  );

const taskHubPermissionPathSchema = pathSchema
  .refine(isAbsolute, "TaskHub権限設定のパスは絶対パスでなければなりません。")
  .refine(
    (value) => !value.includes("\0"),
    "TaskHub権限設定のパスにNULを指定できません。",
  )
  .refine(
    (value) => !value.includes("\n") && !value.includes("\r"),
    "TaskHub権限設定のパスに改行を指定できません。",
  )
  .refine(
    (value) => !containsControlCharacter(value),
    "TaskHub権限設定のパスに制御文字を指定できません。",
  )
  .refine(
    (value) => !containsLoneSurrogate(value),
    "TaskHub権限設定のパスに孤立したサロゲートを指定できません。",
  );

const taskHubVerifiedPermissionProfilePathsSchema = z
  .object({
    codexExecutablePath: taskHubPermissionPathSchema,
    workspacePath: taskHubPermissionPathSchema,
    codexHomePath: taskHubPermissionPathSchema,
    readOnlyVaultPaths: z.array(taskHubPermissionPathSchema).max(maxTaskHubPermissionVaultPaths),
    unixSocketPaths: z
      .array(taskHubPermissionPathSchema)
      .min(1, "taskctlのローカルIPCが必要です。")
      .max(maxTaskHubPermissionSocketPaths),
  })
  .strict()
  .superRefine((input, context) => {
    const filesystemKeys = [
      input.codexExecutablePath,
      input.workspacePath,
      input.codexHomePath,
      ...input.readOnlyVaultPaths,
    ];
    if (new Set(filesystemKeys).size !== filesystemKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["readOnlyVaultPaths"],
        message: "TaskHub権限設定のfilesystemキーを重複させられません。",
      });
    }
    if (new Set(input.unixSocketPaths).size !== input.unixSocketPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["unixSocketPaths"],
        message: "TaskHub権限設定のソケットを重複させられません。",
      });
    }
  });

function quoteTomlBasicString(value: string): string {
  const validatedValue = tomlBasicStringValueSchema.parse(value);
  return tomlBasicStringSchema.parse(JSON.stringify(validatedValue));
}

type TomlInlineTableValue =
  | {
      readonly kind: "basic_string";
      readonly value: string;
    }
  | {
      readonly kind: "inline_table";
      readonly value: string;
    }
  | {
      readonly kind: "boolean";
      readonly value: "false";
    };

type TomlInlineTableEntry = readonly [string, TomlInlineTableValue];

function createTomlBasicStringValue(value: string): TomlInlineTableValue {
  return {
    kind: "basic_string",
    value: quoteTomlBasicString(value),
  };
}

function createTomlInlineTable(entries: readonly TomlInlineTableEntry[]): string {
  const serializedEntries = entries
    .map(([key, value]) => `${quoteTomlBasicString(key)}=${value.value}`)
    .join(",");
  return z.string().parse(`{${serializedEntries}}`);
}

function createTomlInlineTableValue(
  entries: readonly TomlInlineTableEntry[],
): TomlInlineTableValue {
  return {
    kind: "inline_table",
    value: createTomlInlineTable(entries),
  };
}

const tomlFalseValue: TomlInlineTableValue = {
  kind: "boolean",
  value: "false",
};

const codexConfigOverrideSchema = z
  .string()
  .min(1, "Codex設定上書きを空にできません。")
  .max(maxCodexConfigOverrideCodeUnits, "Codex設定上書きが大きすぎます。")
  .refine(
    (value) => !value.includes("\0"),
    "Codex設定上書きに使用できない文字が含まれています。",
  )
  .refine(
    (value) => !value.includes("\n") && !value.includes("\r"),
    "Codex設定上書きに改行を指定できません。",
  )
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= maxCodexConfigOverrideBytes,
    "Codex設定上書きが大きすぎます。",
  );

/** 検証済みCodex設定上書きを表します。 */
export class CodexConfigOverride {
  private readonly argument: string;

  private constructor(argument: string) {
    this.argument = codexConfigOverrideSchema.parse(argument);
    Object.freeze(this);
  }

  /** 検証済みのCodex設定上書きを作成します。 */
  public static create(argument: string): CodexConfigOverride {
    return new CodexConfigOverride(argument);
  }

  /** 検証済みのCodex設定上書きを起動引数へ変換します。 */
  public toArgument(): string {
    return this.argument;
  }
}

export type CodexConfigOverrideValue = CodexConfigOverride;

export const codexConfigOverridesSchema = z
  .array(
    z.custom<CodexConfigOverride>(
      (value) => value instanceof CodexConfigOverride,
      "Codex設定上書きの型が不正です。",
    ),
  )
  .max(maxCodexConfigOverrideCount, "Codex設定上書きの件数が上限を超えています。")
  .superRefine((overrides, context) => {
    const totalCodeUnits = overrides.reduce(
      (length, override) => length + override.toArgument().length,
      0,
    );
    if (totalCodeUnits > maxCodexConfigOverrideTotalCodeUnits) {
      context.addIssue({
        code: "custom",
        message: "Codex設定上書きの合計UTF-16長が上限を超えています。",
      });
    }
  });

function windowsCommandLineArgumentCodeUnits(value: string): number {
  return value.length * 2 + 2;
}

export function windowsCommandLineCodeUnits(
  executable: string,
  overrides: readonly CodexConfigOverride[],
): number {
  const argumentCount = overrides.length * 2 + 2;
  return (
    windowsCommandLineArgumentCodeUnits(executable)
    + overrides.length * windowsCommandLineArgumentCodeUnits("-c")
    + overrides.reduce(
      (length, override) => length + windowsCommandLineArgumentCodeUnits(override.toArgument()),
      0,
    )
    + windowsCommandLineArgumentCodeUnits("app-server")
    + argumentCount - 1
    + 1
  );
}

function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 検証済みの実体パスをTaskHub接続用のTOML上書きへ変換します。 */
export function createTaskHubConnectionOverridesFromVerifiedPaths(
  input: TaskHubVerifiedPermissionProfilePaths,
): readonly CodexConfigOverrideValue[] {
  const validatedInput = taskHubVerifiedPermissionProfilePathsSchema.parse(input);
  const readOnlyVaultPaths = [...validatedInput.readOnlyVaultPaths].sort(
    compareUtf16CodeUnits,
  );
  const unixSocketPaths = [...validatedInput.unixSocketPaths].sort(
    compareUtf16CodeUnits,
  );
  const filesystem = createTomlInlineTableValue([
    [":root", createTomlBasicStringValue("deny")],
    [":minimal", createTomlBasicStringValue("read")],
    [":tmpdir", createTomlBasicStringValue("deny")],
    [":slash_tmp", createTomlBasicStringValue("deny")],
    [validatedInput.codexExecutablePath, createTomlBasicStringValue("read")],
    [
      validatedInput.workspacePath,
      createTomlInlineTableValue([
        [".", createTomlBasicStringValue("read")],
        ["tmp", createTomlBasicStringValue("write")],
      ]),
    ],
    [validatedInput.codexHomePath, createTomlBasicStringValue("deny")],
    ...readOnlyVaultPaths.map(
      (path): TomlInlineTableEntry => [path, createTomlBasicStringValue("read")],
    ),
  ]);
  const network = createTomlInlineTableValue([
    ["enabled", tomlFalseValue],
    [
      "unix_sockets",
      createTomlInlineTableValue(
        unixSocketPaths.map(
          (path): TomlInlineTableEntry => [path, createTomlBasicStringValue("allow")],
        ),
      ),
    ],
  ]);
  const profile = createTomlInlineTableValue([
    ["filesystem", filesystem],
    ["network", network],
  ]);
  const overrides = codexConfigOverridesSchema.parse([
    CodexConfigOverride.create(
      `default_permissions=${createTomlBasicStringValue("taskhub").value}`,
    ),
    CodexConfigOverride.create(`permissions.taskhub=${profile.value}`),
    CodexConfigOverride.create("features.apps=false"),
    CodexConfigOverride.create("features.plugins=false"),
  ]);
  return Object.freeze(overrides);
}

/** Codex接続でAppsとPluginsを無効化する上書きを作成します。 */
export function createTaskHubConnectionFeatureOverrides(): readonly CodexConfigOverrideValue[] {
  const overrides = codexConfigOverridesSchema.parse([
    CodexConfigOverride.create("features.apps=false"),
    CodexConfigOverride.create("features.plugins=false"),
  ]);
  return Object.freeze(overrides);
}


export type TaskHubVerifiedPermissionProfilePaths = z.infer<
  typeof taskHubVerifiedPermissionProfilePathsSchema
>;
