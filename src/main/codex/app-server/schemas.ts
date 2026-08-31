import { isAbsolute } from "node:path";
import { z } from "zod";

const nonEmptyTextSchema = z.string().min(1);
const boundedTextSchema = nonEmptyTextSchema.max(200_000);
const pathSchema = nonEmptyTextSchema.max(4_096);
const absolutePathSchema = pathSchema.refine(
  isAbsolute,
  "パスは絶対パスでなければなりません。",
);
const modelIdSchema = nonEmptyTextSchema.max(200);
const threadIdSchema = nonEmptyTextSchema.max(200);
const turnIdSchema = nonEmptyTextSchema.max(200);
const maxJsonValueBytes = 128 * 1024;
const maxJsonValueDepth = 32;
const maxCodexConfigOverrideCount = 64;
const maxCodexConfigOverrideCodeUnits = 16 * 1024;
const maxCodexConfigOverrideBytes = 16 * 1024;
const maxCodexConfigOverrideTotalCodeUnits = 8 * 1024;
const maxCodexExecutableCodeUnits = 4_096;
const maxWindowsCommandLineCodeUnits = 32_767;
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

class CodexConfigOverride {
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

const codexConfigOverridesSchema = z
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

function windowsCommandLineCodeUnits(
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return false;
  }
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype == null;
}

function addJsonValueIssue(context: { addIssue: (issue: { code: "custom"; message: string }) => void }, message: string): void {
  context.addIssue({ code: "custom", message });
}

function validateJsonValue(
  value: unknown,
  depth: number,
  ancestors: WeakSet<object>,
  context: { addIssue: (issue: { code: "custom"; message: string }) => void },
): void {
  type Frame = {
    readonly value: unknown;
    readonly depth: number;
    readonly exiting: boolean;
  };
  const pending: Frame[] = [{ value, depth, exiting: false }];
  while (pending.length > 0) {
    const frame = pending.pop();
    if (frame == null) {
      throw new Error("JSON検証のスタックが不正です。");
    }
    if (frame.exiting) {
      if (typeof frame.value !== "object" || frame.value == null) {
        throw new Error("JSON検証の状態が不正です。");
      }
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.depth > maxJsonValueDepth) {
      addJsonValueIssue(context, "JSON値の深度が上限を超えています。");
      continue;
    }
    if (frame.value == null || typeof frame.value === "string" || typeof frame.value === "boolean") {
      continue;
    }
    if (typeof frame.value === "number") {
      if (!Number.isFinite(frame.value)) {
        addJsonValueIssue(context, "JSON値の数値は有限でなければなりません。");
      }
      continue;
    }
    if (typeof frame.value !== "object") {
      addJsonValueIssue(context, "JSON値に対応しない型です。");
      continue;
    }
    if (ancestors.has(frame.value)) {
      addJsonValueIssue(context, "JSON値に循環参照があります。");
      continue;
    }
    ancestors.add(frame.value);
    pending.push({ value: frame.value, depth: frame.depth, exiting: true });
    if (Array.isArray(frame.value)) {
      for (const item of frame.value) {
        pending.push({ value: item, depth: frame.depth + 1, exiting: false });
      }
    } else if (isJsonObject(frame.value)) {
      for (const item of Object.values(frame.value)) {
        pending.push({ value: item, depth: frame.depth + 1, exiting: false });
      }
    } else {
      addJsonValueIssue(context, "JSON値はプレーンなオブジェクトでなければなりません。");
    }
  }
}

const jsonValueSchema = z.unknown().superRefine((value, context) => {
  validateJsonValue(value, 0, new WeakSet<object>(), context);
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    addJsonValueIssue(context, "JSON値を文字列化できません。");
    return;
  }
  if (serialized == null) {
    addJsonValueIssue(context, "JSON値を文字列化できません。");
    return;
  }
  if (Buffer.byteLength(serialized, "utf8") > maxJsonValueBytes) {
    addJsonValueIssue(context, "JSON値のサイズが上限を超えています。");
  }
});

const jsonObjectSchema = jsonValueSchema.superRefine((value, context) => {
  if (!isJsonObject(value)) {
    addJsonValueIssue(context, "JSONスキーマはオブジェクトでなければなりません。");
  }
});

/** JSON-RPCの要求識別子を表すスキーマです。 */
export const codexRpcIdSchema = z.union([
  z.string().min(1).max(200),
  z.number().int().nonnegative().refine(Number.isSafeInteger, "JSON-RPC要求IDは安全な整数でなければなりません。"),
]);

/** initialize要求のクライアント情報を表すスキーマです。 */
export const initializeClientInfoSchema = z
  .object({
    name: nonEmptyTextSchema.max(100),
    title: nonEmptyTextSchema.max(200).optional(),
    version: nonEmptyTextSchema.max(100),
  })
  .strict();

/** initialize要求の能力情報を表すスキーマです。 */
export const initializeCapabilitiesSchema = z
  .object({
    experimentalApi: z.boolean().optional(),
    optOutNotificationMethods: z.array(nonEmptyTextSchema.max(200)).max(100).optional(),
    requestAttestation: z.boolean().optional(),
    mcpServerOpenaiFormElicitation: z.boolean().optional(),
  })
  .strict();

/** initialize要求を表す厳格なスキーマです。 */
export const initializeParamsSchema = z
  .object({
    clientInfo: initializeClientInfoSchema,
    capabilities: initializeCapabilitiesSchema.optional(),
  })
  .strict();

/** initialize応答を表す厳格なスキーマです。 */
export const initializeResultSchema = z
  .object({
    userAgent: nonEmptyTextSchema.max(500),
    codexHome: absolutePathSchema,
    platformFamily: nonEmptyTextSchema.max(100),
    platformOs: nonEmptyTextSchema.max(100),
  })
  .strict();

/** account/read要求を表すスキーマです。 */
export const accountReadParamsSchema = z
  .object({
    refreshToken: z.boolean().optional(),
  })
  .strict();

const accountInfoSchema = z
  .object({
    type: nonEmptyTextSchema.max(100),
    email: z.string().email().nullable().optional(),
    planType: nonEmptyTextSchema.max(100).nullable().optional(),
    credentialSource: nonEmptyTextSchema.max(100).optional(),
  })
  .strip();

/** account/read応答を表すスキーマです。 */
export const accountReadResultSchema = z
  .object({
    account: accountInfoSchema.nullable(),
    requiresOpenaiAuth: z.boolean(),
  })
  .strip();

/** ChatGPTブラウザログイン開始要求を表すスキーマです。 */
export const chatGptLoginStartParamsSchema = z
  .object({
    type: z.literal("chatgpt"),
    useHostedLoginSuccessPage: z.boolean().optional(),
    appBrand: z.enum(["codex", "chatgpt"]).optional(),
  })
  .strict();

/** ChatGPTブラウザログイン開始応答を表すスキーマです。 */
export const chatGptLoginStartResultSchema = z
  .object({
    type: z.literal("chatgpt"),
    loginId: nonEmptyTextSchema.max(200),
    authUrl: z.string().url().max(4_096),
  })
  .strip();

/** model/list要求を表すスキーマです。 */
export const modelListParamsSchema = z
  .object({
    limit: z.number().int().positive().max(1_000).optional(),
    includeHidden: z.boolean().optional(),
    cursor: nonEmptyTextSchema.max(500).optional(),
  })
  .strict();

const modelReasoningEffortSchema = z
  .object({
    reasoningEffort: nonEmptyTextSchema.max(100),
    description: nonEmptyTextSchema.max(2_000).optional(),
  })
  .strip();

const modelInfoSchema = z
  .object({
    id: modelIdSchema,
    model: modelIdSchema.optional(),
    displayName: nonEmptyTextSchema.max(200).optional(),
    hidden: z.boolean().optional(),
    defaultReasoningEffort: nonEmptyTextSchema.max(100).optional(),
    supportedReasoningEfforts: z.array(modelReasoningEffortSchema).max(100).optional(),
    inputModalities: z.array(z.enum(["text", "image", "audio"])).max(10).optional(),
    supportsPersonality: z.boolean().optional(),
    isDefault: z.boolean().optional(),
    upgrade: modelIdSchema.nullable(),
  })
  .strip();

/** model/list応答を表すスキーマです。 */
export const modelListResultSchema = z
  .object({
    data: z.array(modelInfoSchema).max(1_000),
    nextCursor: nonEmptyTextSchema.max(500).nullable().optional(),
  })
  .strip();

const extraRootsSchema = z
  .object({
    cwd: pathSchema,
    extraUserRoots: z.array(pathSchema).max(100),
  })
  .strict();

/** skills/list要求を表すスキーマです。 */
export const skillsListParamsSchema = z
  .object({
    cwds: z.array(pathSchema).min(1).max(100),
    forceReload: z.boolean().optional(),
    perCwdExtraUserRoots: z.array(extraRootsSchema).max(100).optional(),
  })
  .strict();

const skillInterfaceSchema = z
  .object({
    displayName: nonEmptyTextSchema.max(200).nullable().optional(),
    shortDescription: nonEmptyTextSchema.max(2_000).nullable().optional(),
  })
  .strip();

const skillDependencySchema = z
  .object({
    type: nonEmptyTextSchema.max(100),
    value: nonEmptyTextSchema.max(2_000),
    description: nonEmptyTextSchema.max(2_000).optional(),
    transport: nonEmptyTextSchema.max(100).optional(),
    url: z.string().url().max(4_096).optional(),
  })
  .strip();

const skillErrorSchema = z
  .object({
    path: pathSchema,
    message: nonEmptyTextSchema.max(2_000),
  })
  .strip();

const skillInfoSchema = z
  .object({
    name: nonEmptyTextSchema.max(200),
    description: nonEmptyTextSchema.max(2_000),
    path: pathSchema,
    enabled: z.boolean(),
    interface: skillInterfaceSchema.optional(),
    dependencies: z
      .object({
        tools: z.array(skillDependencySchema).max(100),
      })
      .strip()
      .optional(),
  })
  .strip();

const skillsByCwdSchema = z
  .object({
    cwd: pathSchema,
    skills: z.array(skillInfoSchema).max(1_000),
    errors: z.array(skillErrorSchema).max(100),
  })
  .strip();

/** skills/list応答を表すスキーマです。 */
export const skillsListResultSchema = z
  .object({
    data: z.array(skillsByCwdSchema).max(100),
  })
  .strip();

const permissionProfileIdSchema = nonEmptyTextSchema.max(200);

const dynamicToolFunctionSpecSchema = z
  .object({
    type: z.literal("function"),
    name: nonEmptyTextSchema.max(200),
    description: boundedTextSchema,
    inputSchema: jsonValueSchema,
    deferLoading: z.boolean().optional(),
  })
  .strict();

const dynamicToolCallOutputContentItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("inputText"),
      text: boundedTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("inputImage"),
      imageUrl: boundedTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("inputAudio"),
      audioUrl: boundedTextSchema,
    })
    .strict(),
]);

/** dynamic tool呼び出しの引数を表すスキーマです。 */
export const dynamicToolCallParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    callId: nonEmptyTextSchema.max(200),
    namespace: nonEmptyTextSchema.max(200).nullable().optional(),
    tool: nonEmptyTextSchema.max(200),
    arguments: jsonValueSchema,
  })
  .strict();

/** dynamic tool呼び出しの応答を表すスキーマです。 */
export const dynamicToolCallResponseSchema = z
  .object({
    contentItems: z.array(dynamicToolCallOutputContentItemSchema).max(100),
    success: z.boolean(),
  })
  .strict();

const permissionProfileSummarySchema = z
  .object({
    id: permissionProfileIdSchema,
    description: z.string().max(2_000).nullable(),
    allowed: z.boolean(),
  })
  .strip();

/** 権限プロファイル一覧要求を表すスキーマです。 */
export const permissionProfileListParamsSchema = z
  .object({
    cursor: nonEmptyTextSchema.max(500).optional(),
    limit: z.number().int().positive().max(1_000).optional(),
    cwd: pathSchema.optional(),
  })
  .strict();

/** 権限プロファイル一覧応答を表すスキーマです。 */
export const permissionProfileListResultSchema = z
  .object({
    data: z.array(permissionProfileSummarySchema).max(1_000),
    nextCursor: nonEmptyTextSchema.max(500).nullable(),
  })
  .strip();

const permissionProfileConfigValueSchema = jsonValueSchema;
const permissionProfileConfigSchema = z
  .record(z.string().min(1).max(200), permissionProfileConfigValueSchema)
  .superRefine((value, context) => {
    if (Object.keys(value).length > 1_000) {
      context.addIssue({
        code: "custom",
        message: "Codex権限プロファイル設定の項目数が上限を超えています。",
      });
    }
  });

/** thread/start要求を表すスキーマです。 */
export const threadStartParamsSchema = z
  .object({
    model: modelIdSchema.optional(),
    cwd: pathSchema.optional(),
    approvalPolicy: z.literal("never").optional(),
    sandbox: z.enum(["read-only", "workspace-write"]).optional(),
    config: permissionProfileConfigSchema.optional(),
    personality: nonEmptyTextSchema.max(100).optional(),
    serviceName: nonEmptyTextSchema.max(200).optional(),
    ephemeral: z.boolean().optional(),
    dynamicTools: z.array(dynamicToolFunctionSpecSchema).max(100).nullable().optional(),
  })
  .strict();

const threadSummarySchema = z
  .object({
    id: threadIdSchema,
    sessionId: threadIdSchema.optional(),
    preview: z.string().max(20_000).optional(),
    ephemeral: z.boolean().optional(),
    modelProvider: nonEmptyTextSchema.max(200).optional(),
    createdAt: z.number().int().nonnegative().optional(),
    instructionSources: z.array(pathSchema).max(100).optional(),
  })
  .strip();

const approvalPolicySchema = z.union([
  z.literal("untrusted"),
  z.literal("on-request"),
  z
    .object({
      granular: z
        .object({
          sandbox_approval: z.boolean(),
          rules: z.boolean(),
          skill_approval: z.boolean(),
          request_permissions: z.boolean(),
          mcp_elicitations: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  z.literal("never"),
]);

const responseSandboxPolicySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("dangerFullAccess"),
    })
    .strict(),
  z
    .object({
      type: z.literal("readOnly"),
      networkAccess: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("externalSandbox"),
      networkAccess: z.enum(["restricted", "enabled"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(pathSchema).min(1).max(100),
      networkAccess: z.literal(false),
      excludeTmpdirEnvVar: z.boolean(),
      excludeSlashTmp: z.boolean(),
    })
    .strict(),
]);

/** thread/start応答を表すスキーマです。 */
export const threadStartResultSchema = z
  .object({
    thread: threadSummarySchema,
    model: modelIdSchema,
    modelProvider: nonEmptyTextSchema.max(200),
    serviceTier: nonEmptyTextSchema.max(100).nullable(),
    cwd: pathSchema,
    instructionSources: z.array(pathSchema).max(100),
    approvalPolicy: approvalPolicySchema,
    approvalsReviewer: z.enum(["user", "auto_review", "guardian_subagent"]),
    sandbox: responseSandboxPolicySchema,
    reasoningEffort: nonEmptyTextSchema.max(100).nullable(),
  })
  .strip();

const sandboxPolicySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("readOnly"),
      networkAccess: z.literal(false),
    })
    .strict(),
  z
    .object({
      type: z.literal("workspaceWrite"),
      writableRoots: z.array(pathSchema).min(1).max(100),
      networkAccess: z.literal(false),
      excludeTmpdirEnvVar: z.boolean(),
      excludeSlashTmp: z.boolean(),
    })
    .strict(),
]);

const turnInputItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      text: boundedTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("skill"),
      name: nonEmptyTextSchema.max(200),
      path: pathSchema,
    })
    .strict(),
]);

/** turn/start要求を表す厳格なスキーマです。 */
export const turnStartParamsSchema = z
  .object({
    threadId: threadIdSchema,
    input: z.array(turnInputItemSchema).min(1).max(100),
    cwd: pathSchema.optional(),
    approvalPolicy: z.literal("never").optional(),
    sandboxPolicy: sandboxPolicySchema.optional(),
    model: modelIdSchema.optional(),
    effort: nonEmptyTextSchema.max(100).optional(),
    summary: z.enum(["auto", "concise", "detailed", "none"]).optional(),
    personality: nonEmptyTextSchema.max(100).optional(),
    outputSchema: jsonObjectSchema.optional(),
  })
  .strict();

const codexErrorInfoSchema = z.union([
  z.enum([
    "contextWindowExceeded",
    "sessionBudgetExceeded",
    "usageLimitExceeded",
    "serverOverloaded",
    "cyberPolicy",
    "misalignmentPolicyViolation",
    "internalServerError",
    "unauthorized",
    "badRequest",
    "threadRollbackFailed",
    "sandboxError",
    "other",
  ]),
  z
    .object({
      httpConnectionFailed: z
        .object({
          httpStatusCode: z.number().int().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      responseStreamConnectionFailed: z
        .object({
          httpStatusCode: z.number().int().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      responseStreamDisconnected: z
        .object({
          httpStatusCode: z.number().int().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      responseTooManyFailedAttempts: z
        .object({
          httpStatusCode: z.number().int().nullable(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      activeTurnNotSteerable: z
        .object({
          turnKind: z.enum(["review", "compact"]),
        })
        .strict(),
    })
    .strict(),
]);

const turnErrorSchema = z
  .object({
    message: z.string().max(200_000),
    codexErrorInfo: codexErrorInfoSchema.nullable(),
    additionalDetails: z.string().max(200_000).nullable(),
  })
  .strip();

const turnItemSummarySchema = z
  .object({
    id: nonEmptyTextSchema.max(200),
    type: nonEmptyTextSchema.max(100),
  })
  .strip();

const turnSummarySchema = z
  .object({
    id: turnIdSchema,
    items: z.array(turnItemSummarySchema).max(10_000),
    itemsView: z.enum(["notLoaded", "summary", "full"]),
    status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
    error: turnErrorSchema.nullable(),
    startedAt: z.number().finite().nullable(),
    completedAt: z.number().finite().nullable(),
    durationMs: z.number().finite().nullable(),
  })
  .strip();

/** turn/start応答を表すスキーマです。 */
export const turnStartResultSchema = z
  .object({
    turn: turnSummarySchema,
  })
  .strip();

/** turn/interrupt要求を表す厳格なスキーマです。 */
export const turnInterruptParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turnId: turnIdSchema,
  })
  .strict();

/** turn/interrupt応答を表す厳格なスキーマです。 */
export const turnInterruptResultSchema = z.object({}).strict();

const threadStartedParamsSchema = z
  .object({
    thread: threadSummarySchema,
  })
  .strict();

const turnStartedParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turn: turnSummarySchema,
  })
  .strict();

const turnCompletedParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turn: turnSummarySchema,
  })
  .strict();

const agentMessageItemSchema = z
  .object({
    type: z.literal("agentMessage"),
    id: nonEmptyTextSchema.max(200),
    text: z.string().max(200_000),
    phase: z.enum(["commentary", "final_answer"]).nullable(),
  })
  .strip();

const otherCompletedItemSchema = z
  .object({
    type: nonEmptyTextSchema.max(100).refine((value) => value !== "agentMessage"),
    id: nonEmptyTextSchema.max(200),
  })
  .passthrough()
  .transform((item) => ({ type: item.type, id: item.id }));

const completedItemSchema = z.union([agentMessageItemSchema, otherCompletedItemSchema]);

const itemCompletedParamsSchema = z
  .object({
    item: completedItemSchema,
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    completedAtMs: z.number().finite(),
  })
  .strict();

const threadSettingsUpdatedParamsSchema = z
  .object({
    threadId: threadIdSchema,
    threadSettings: z
      .object({
        sandboxPolicy: responseSandboxPolicySchema,
        activePermissionProfile: z
          .object({
            id: permissionProfileIdSchema,
            extends: permissionProfileIdSchema.nullable(),
          })
          .strict()
          .nullable(),
      })
      .strip(),
  })
  .strict();

const mcpServerConnectionStatusSchema = z.enum([
  "notStarted",
  "starting",
  "connected",
  "authenticationRequired",
  "failed",
  "cancelled",
  "disabled",
]);

const mcpServerAuthStatusSchema = z.enum([
  "unknown",
  "unsupported",
  "notLoggedIn",
  "bearerToken",
  "oAuth",
]);

const mcpServerStatusSchema = z
  .object({
    name: nonEmptyTextSchema.max(200),
    runtimeStatus: mcpServerConnectionStatusSchema.nullable(),
    pluginId: nonEmptyTextSchema.max(200).nullable(),
    serverInfo: jsonValueSchema.nullable(),
    tools: z.record(z.string().min(1).max(300), jsonValueSchema),
    resources: z.array(jsonValueSchema).max(10_000),
    resourceTemplates: z.array(jsonValueSchema).max(10_000),
    authStatus: mcpServerAuthStatusSchema,
  })
  .strip();

/** MCPサーバー状態一覧要求を表すスキーマです。 */
export const mcpServerStatusListParamsSchema = z
  .object({
    cursor: nonEmptyTextSchema.max(500).optional(),
    limit: z.number().int().positive().max(1_000).optional(),
    detail: z.literal("toolsAndAuthOnly").optional(),
    threadId: threadIdSchema.optional(),
  })
  .strict();

/** MCPサーバー状態一覧応答を表すスキーマです。 */
export const mcpServerStatusListResultSchema = z
  .object({
    data: z.array(mcpServerStatusSchema).max(1_000),
    nextCursor: nonEmptyTextSchema.max(500).nullable(),
  })
  .strip();

const experimentalFeatureSchema = z
  .object({
    name: nonEmptyTextSchema.max(200),
    stage: z.enum(["beta", "underDevelopment", "stable", "deprecated", "removed"]),
    displayName: z.string().max(500).nullable(),
    description: z.string().max(2_000).nullable(),
    announcement: z.string().max(2_000).nullable(),
    enabled: z.boolean(),
    defaultEnabled: z.boolean(),
  })
  .strip();

/** 実効機能一覧要求を表すスキーマです。 */
export const experimentalFeatureListParamsSchema = z
  .object({
    cursor: nonEmptyTextSchema.max(500).optional(),
    limit: z.number().int().positive().max(1_000).optional(),
    threadId: threadIdSchema.optional(),
  })
  .strict();

/** 実効機能一覧応答を表すスキーマです。 */
export const experimentalFeatureListResultSchema = z
  .object({
    data: z.array(experimentalFeatureSchema).max(1_000),
    nextCursor: nonEmptyTextSchema.max(500).nullable(),
  })
  .strip();

const accountUpdatedParamsSchema = z
  .object({
    authMode: z
      .enum([
        "apikey",
        "chatgpt",
        "chatgptAuthTokens",
        "headers",
        "agentIdentity",
        "personalAccessToken",
        "bedrockApiKey",
        "bedrockAccessKeys",
      ])
      .nullable(),
    planType: nonEmptyTextSchema.max(100).nullable(),
  })
  .strict();

const loginCompletedParamsSchema = z
  .object({
    loginId: nonEmptyTextSchema.max(200).nullable(),
    success: z.boolean(),
    error: nonEmptyTextSchema.max(2_000).nullable(),
    onboardingEntrypoint: z.literal("life_sciences").nullable(),
  })
  .strict();

const agentMessageDeltaParamsSchema = z
  .object({
    threadId: threadIdSchema,
    turnId: turnIdSchema,
    itemId: nonEmptyTextSchema.max(200),
    delta: z.string().max(200_000),
  })
  .strict();

const emptyNotificationParamsSchema = z.object({}).strict();

/** 受け渡しを許可する既知通知を表すスキーマです。 */
export const codexNotificationSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("thread/started"),
      params: threadStartedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("turn/started"),
      params: turnStartedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("turn/completed"),
      params: turnCompletedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("item/completed"),
      params: itemCompletedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("thread/settings/updated"),
      params: threadSettingsUpdatedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("account/updated"),
      params: accountUpdatedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("account/login/completed"),
      params: loginCompletedParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("skills/changed"),
      params: emptyNotificationParamsSchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("item/agentMessage/delta"),
      params: agentMessageDeltaParamsSchema,
    })
    .strict(),
]);

/** 接続診断の種類を表すスキーマです。 */
export const codexDiagnosticSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("unknown_notification"),
      code: z.literal("unknown_notification"),
      method: nonEmptyTextSchema.max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("server_request_rejected"),
      code: z.literal("server_request_rejected"),
      method: nonEmptyTextSchema.max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stderr"),
      code: z.literal("stderr_output"),
      lineCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("protocol_error"),
      code: z.literal("protocol_error"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("process_exit"),
      code: z.literal("process_exit"),
      exitCode: z.number().int().nullable(),
      signal: nonEmptyTextSchema.max(100).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("listener_error"),
      code: z.literal("listener_error"),
      source: z.enum(["notification", "diagnostic"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("stop_error"),
      code: z.literal("stop_error"),
    })
    .strict(),
]);

/** Codex接続の生成設定を表すスキーマです。 */
export const codexConnectionOptionsSchema = z
  .object({
    executable: nonEmptyTextSchema.max(maxCodexExecutableCodeUnits).optional(),
    environment: z.record(z.string().min(1).max(200), z.string()).optional(),
    clientInfo: initializeClientInfoSchema,
    capabilities: initializeCapabilitiesSchema.optional(),
    requestTimeoutMs: z.number().int().positive().max(120_000).optional(),
    configOverrides: codexConfigOverridesSchema,
  })
  .strict()
  .superRefine((options, context) => {
    const executable = options.executable ?? "codex";
    if (
      windowsCommandLineCodeUnits(executable, options.configOverrides)
      >= maxWindowsCommandLineCodeUnits
    ) {
      context.addIssue({
        code: "custom",
        path: ["configOverrides"],
        message: "WindowsのCodex起動引数が32767 UTF-16単位以上になります。",
      });
    }
  });

export type CodexRpcId = z.infer<typeof codexRpcIdSchema>;
export type DynamicToolCallParams = z.infer<typeof dynamicToolCallParamsSchema>;
export type DynamicToolCallResponse = z.infer<typeof dynamicToolCallResponseSchema>;
export type InitializeClientInfo = z.infer<typeof initializeClientInfoSchema>;
export type InitializeCapabilities = z.infer<typeof initializeCapabilitiesSchema>;
export type InitializeParams = z.infer<typeof initializeParamsSchema>;
export type InitializeResult = z.infer<typeof initializeResultSchema>;
export type AccountReadParams = z.infer<typeof accountReadParamsSchema>;
export type AccountReadResult = z.infer<typeof accountReadResultSchema>;
export type ChatGptLoginStartParams = z.infer<typeof chatGptLoginStartParamsSchema>;
export type ChatGptLoginStartResult = z.infer<typeof chatGptLoginStartResultSchema>;
export type ModelListParams = z.infer<typeof modelListParamsSchema>;
export type ModelListResult = z.infer<typeof modelListResultSchema>;
export type SkillsListParams = z.infer<typeof skillsListParamsSchema>;
export type SkillsListResult = z.infer<typeof skillsListResultSchema>;
export type PermissionProfileListParams = z.infer<typeof permissionProfileListParamsSchema>;
export type PermissionProfileListResult = z.infer<typeof permissionProfileListResultSchema>;
export type ExperimentalFeatureListParams = z.infer<typeof experimentalFeatureListParamsSchema>;
export type ExperimentalFeatureListResult = z.infer<typeof experimentalFeatureListResultSchema>;
export type ThreadStartParams = z.infer<typeof threadStartParamsSchema>;
export type ThreadStartResult = z.infer<typeof threadStartResultSchema>;
export type McpServerStatusListParams = z.infer<typeof mcpServerStatusListParamsSchema>;
export type McpServerStatusListResult = z.infer<typeof mcpServerStatusListResultSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type TurnStartResult = z.infer<typeof turnStartResultSchema>;
export type TurnInterruptParams = z.infer<typeof turnInterruptParamsSchema>;
export type TurnInterruptResult = z.infer<typeof turnInterruptResultSchema>;
export type CodexNotification = z.infer<typeof codexNotificationSchema>;
export type CodexDiagnostic = z.infer<typeof codexDiagnosticSchema>;
export type CodexConnectionOptions = Omit<
  z.infer<typeof codexConnectionOptionsSchema>,
  "configOverrides"
> & {
  configOverrides: readonly CodexConfigOverrideValue[];
};
export type TaskHubVerifiedPermissionProfilePaths = z.infer<
  typeof taskHubVerifiedPermissionProfilePathsSchema
>;
