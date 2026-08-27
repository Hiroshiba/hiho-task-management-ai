import { z } from "zod";

const nonEmptyTextSchema = z.string().min(1);
const boundedTextSchema = nonEmptyTextSchema.max(200_000);
const pathSchema = nonEmptyTextSchema.max(4_096);
const modelIdSchema = nonEmptyTextSchema.max(200);
const threadIdSchema = nonEmptyTextSchema.max(200);
const turnIdSchema = nonEmptyTextSchema.max(200);
const maxJsonValueBytes = 128 * 1024;
const maxJsonValueDepth = 32;

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
  if (depth > maxJsonValueDepth) {
    addJsonValueIssue(context, "JSON値の深度が上限を超えています。");
    return;
  }
  if (value == null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      addJsonValueIssue(context, "JSON値の数値は有限でなければなりません。");
    }
    return;
  }
  if (typeof value !== "object") {
    addJsonValueIssue(context, "JSON値に対応しない型です。");
    return;
  }
  if (ancestors.has(value)) {
    addJsonValueIssue(context, "JSON値に循環参照があります。");
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      validateJsonValue(item, depth + 1, ancestors, context);
    }
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) {
      validateJsonValue(item, depth + 1, ancestors, context);
    }
  } else {
    addJsonValueIssue(context, "JSON値はプレーンなオブジェクトでなければなりません。");
  }
  ancestors.delete(value);
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

/** Codex CLIの対応版を表すスキーマです。 */
export const codexVersionInfoSchema = z
  .object({
    raw: z.string().regex(/^codex-cli 0\.150\.\d+$/),
    major: z.literal(0),
    minor: z.literal(150),
    patch: z.number().int().nonnegative(),
  })
  .strict();

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
    codexHome: pathSchema,
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

/** thread/start要求を表すスキーマです。 */
export const threadStartParamsSchema = z
  .object({
    model: modelIdSchema.optional(),
    cwd: pathSchema.optional(),
    approvalPolicy: z.literal("never").optional(),
    sandbox: z.enum(["read-only", "workspace-write"]).optional(),
    personality: nonEmptyTextSchema.max(100).optional(),
    serviceName: nonEmptyTextSchema.max(200).optional(),
    ephemeral: z.boolean().optional(),
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
    executable: nonEmptyTextSchema.max(4_096).optional(),
    environment: z.record(z.string().min(1).max(200), z.string()).optional(),
    clientInfo: initializeClientInfoSchema,
    capabilities: initializeCapabilitiesSchema.optional(),
    requestTimeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

export type CodexVersionInfo = z.infer<typeof codexVersionInfoSchema>;
export type CodexRpcId = z.infer<typeof codexRpcIdSchema>;
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
export type ThreadStartParams = z.infer<typeof threadStartParamsSchema>;
export type ThreadStartResult = z.infer<typeof threadStartResultSchema>;
export type TurnStartParams = z.infer<typeof turnStartParamsSchema>;
export type TurnStartResult = z.infer<typeof turnStartResultSchema>;
export type TurnInterruptParams = z.infer<typeof turnInterruptParamsSchema>;
export type TurnInterruptResult = z.infer<typeof turnInterruptResultSchema>;
export type CodexNotification = z.infer<typeof codexNotificationSchema>;
export type CodexDiagnostic = z.infer<typeof codexDiagnosticSchema>;
export type CodexConnectionOptions = z.infer<typeof codexConnectionOptionsSchema>;
