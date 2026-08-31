import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  type AccountReadParams,
  type AccountReadResult,
  type CodexDynamicToolHandler,
  type CodexDiagnostic,
  type ChatGptLoginStartParams,
  type ChatGptLoginStartResult,
  type CodexConnectionOptions,
  type ModelListParams,
  type ModelListResult,
  type McpServerStatusListParams,
  type McpServerStatusListResult,
  type PermissionProfileListParams,
  type PermissionProfileListResult,
  type ExperimentalFeatureListParams,
  type ExperimentalFeatureListResult,
  type SkillsListParams,
  type SkillsListResult,
  type ThreadStartParams,
  type ThreadStartResult,
  type TurnInterruptParams,
  type TurnInterruptResult,
  type TurnStartParams,
  type TurnStartResult,
} from "../app-server";
import type {
  CodexDiagnosticListener,
  CodexNotificationListener,
} from "../app-server";
import {
  type TaskctlSnapshotProvider,
} from "../taskctl";
import { createUtf8ByteLimitedStringSchema } from "../../../shared/domain";
import { codexResponseSchema } from "../../../shared/ai";

const maximumPathLength = 4_096;
const maximumModelLength = 200;
const maximumTextBytes = 200_000;
const maximumDeltaBytes = 200_000;
const maximumInputItems = 100;
const maximumSkillNameLength = 200;
const maximumDiagnostics = 256;
const maximumVaultPaths = 32;
const maximumAdditionalUnixSocketPaths = 32;

const absolutePathSchema = z
  .string()
  .min(1)
  .max(maximumPathLength)
  .refine(isAbsolute, "パスは絶対パスで指定してください。")
  .refine((value) => !value.includes("\0"), "パスに使用できない文字が含まれています。")
  .refine((value) => !value.includes("\n") && !value.includes("\r"), "パスに改行を指定できません。");

const modelSchema = z
  .string()
  .min(1, "モデルIDを空にできません。")
  .max(maximumModelLength)
  .refine((value) => !value.includes("\0"), "モデルIDに使用できない文字が含まれています。");

const utf8TextSchema = createUtf8ByteLimitedStringSchema(maximumTextBytes).min(1);
const utf8DeltaSchema = createUtf8ByteLimitedStringSchema(maximumDeltaBytes);

const connectionFactorySchema = z.custom<CodexSessionConnectionFactory>(
  (value) => typeof value === "function",
  "Codex接続ファクトリが必要です。",
);

type CodexHomePathProvider = () => string;

const codexHomePathProviderSchema = z.custom<CodexHomePathProvider>(
  (value) => typeof value === "function",
  "Codexホームパス供給関数が必要です。",
);

const syncBeforeTurnSchema = z.custom<CodexSessionSyncFunction>(
  (value) => typeof value === "function",
  "AIターン前同期関数が必要です。",
);

const turnInputFactorySchema = z.custom<CodexSessionTurnInputFactory>(
  (value) => typeof value === "function",
  "同期後ターン入力関数が必要です。",
);

const snapshotProviderSchema = z.custom<TaskctlSnapshotProvider>(
  (value) => typeof value === "function",
  "taskctlスナップショット供給関数が必要です。",
);

/** Codex app-serverをセッションから利用する接続境界です。 */
export interface CodexSessionConnection {
  start(signal: AbortSignal): Promise<void>;
  readAccount(params: AccountReadParams, signal: AbortSignal): Promise<AccountReadResult>;
  startChatGptLogin(
    params: ChatGptLoginStartParams,
    signal: AbortSignal,
  ): Promise<ChatGptLoginStartResult>;
  listModels(params: ModelListParams, signal: AbortSignal): Promise<ModelListResult>;
  listSkills(params: SkillsListParams, signal: AbortSignal): Promise<SkillsListResult>;
  listPermissionProfiles(
    params: PermissionProfileListParams,
    signal: AbortSignal,
  ): Promise<PermissionProfileListResult>;
  listMcpServerStatuses(
    params: McpServerStatusListParams,
    signal: AbortSignal,
  ): Promise<McpServerStatusListResult>;
  listExperimentalFeatures(
    params: ExperimentalFeatureListParams,
    signal: AbortSignal,
  ): Promise<ExperimentalFeatureListResult>;
  getCodexHome(): string;
  startThread(params: ThreadStartParams, signal: AbortSignal): Promise<ThreadStartResult>;
  startTurn(params: TurnStartParams, signal: AbortSignal): Promise<TurnStartResult>;
  interruptTurn(params: TurnInterruptParams, signal: AbortSignal): Promise<TurnInterruptResult>;
  onNotification(listener: CodexNotificationListener): () => void;
  onDiagnostic(listener: CodexDiagnosticListener): () => void;
  onDynamicToolCall(handler: CodexDynamicToolHandler): () => void;
  getDiagnostics(): readonly CodexDiagnostic[];
  stop(): Promise<void>;
}

/** セッションが新しいapp-server接続を作る関数の型です。 */
export type CodexSessionConnectionFactory =
  (
    configOverrides: CodexConnectionOptions["configOverrides"],
  ) => CodexSessionConnection | PromiseLike<CodexSessionConnection>;

/** セッションがターン開始直前に同期を実行する関数の型です。 */
export type CodexSessionSyncFunction = (signal: AbortSignal) => void | PromiseLike<void>;

/** 同期完了後にCodexターン入力を作成する関数の型です。 */
export type CodexSessionTurnInputFactory = (
  signal: AbortSignal,
) => CodexSessionTurnInput | PromiseLike<CodexSessionTurnInput>;

/** 同期完了後ターン入力関数を検証するスキーマです。 */
export const codexSessionTurnInputFactorySchema = turnInputFactorySchema;

/** Codexセッション初期化の入力を検証するスキーマです。 */
export const codexSessionOptionsSchema = z
  .object({
    workspacePath: absolutePathSchema,
    agentsFilePath: absolutePathSchema,
    tmpDirectoryPath: absolutePathSchema,
    expectedCodexHomePathProvider: codexHomePathProviderSchema,
    readOnlyVaultPaths: z
      .array(absolutePathSchema)
      .max(maximumVaultPaths)
      .superRefine((paths, context) => {
        const seen = new Set<string>();
        paths.forEach((path, index) => {
          const normalizedPath = resolve(path);
          if (seen.has(normalizedPath)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "同じVaultのパスを重複して指定できません。",
            });
            return;
          }
          seen.add(normalizedPath);
        });
      }),
    additionalUnixSocketPaths: z
      .array(absolutePathSchema)
      .max(maximumAdditionalUnixSocketPaths)
      .superRefine((paths, context) => {
        const seen = new Set<string>();
        paths.forEach((path, index) => {
          const normalizedPath = resolve(path);
          if (seen.has(normalizedPath)) {
            context.addIssue({
              code: "custom",
              path: [index],
              message: "同じUnixソケットのパスを重複して指定できません。",
            });
            return;
          }
          seen.add(normalizedPath);
        });
      })
      .optional(),
    connectionFactory: connectionFactorySchema,
    snapshotProvider: snapshotProviderSchema,
    syncBeforeTurn: syncBeforeTurnSchema,
  })
  .strict()
  .superRefine((options, context) => {
    const expectedAgentsPath = join(options.workspacePath, "AGENTS.md");
    const expectedTmpPath = join(options.workspacePath, "tmp");
    if (options.agentsFilePath !== expectedAgentsPath) {
      context.addIssue({
        code: "custom",
        path: ["agentsFilePath"],
        message: "AGENTS.mdのパスが専用ワークスペースと一致しません。",
      });
    }
    if (options.tmpDirectoryPath !== expectedTmpPath) {
      context.addIssue({
        code: "custom",
        path: ["tmpDirectoryPath"],
        message: "一時ディレクトリのパスが専用ワークスペースと一致しません。",
      });
    }
    if (options.agentsFilePath === options.tmpDirectoryPath) {
      context.addIssue({
        code: "custom",
        path: ["tmpDirectoryPath"],
        message: "AGENTS.mdと一時ディレクトリを同じパスにできません。",
      });
    }
    for (const [index, vaultPath] of options.readOnlyVaultPaths.entries()) {
      const workspaceContainsVault = isPathWithin(options.workspacePath, vaultPath);
      const vaultContainsWorkspace = isPathWithin(vaultPath, options.workspacePath);
      if (workspaceContainsVault || vaultContainsWorkspace) {
        context.addIssue({
          code: "custom",
          path: ["readOnlyVaultPaths", index],
          message: "VaultのパスをCodex専用ワークスペースと重ねられません。",
        });
      }
    }
    if (options.additionalUnixSocketPaths != null) {
      const normalizedTmpPath = resolve(options.tmpDirectoryPath);
      for (const [index, socketPath] of options.additionalUnixSocketPaths.entries()) {
        if (parse(resolve(socketPath)).dir !== normalizedTmpPath) {
          context.addIssue({
            code: "custom",
            path: ["additionalUnixSocketPaths", index],
            message: "追加Unixソケットは専用ワークスペースのtmp直下に指定してください。",
          });
        }
      }
    }
  });

const textInputItemSchema = z
  .object({
    type: z.literal("text"),
    text: utf8TextSchema,
  })
  .strict();

const skillInputItemSchema = z
  .object({
    type: z.literal("skill"),
    name: z.string().min(1).max(maximumSkillNameLength),
    path: absolutePathSchema,
  })
  .strict();

/** Codexターンへ渡す入力項目の配列を検証するスキーマです。 */
export const codexSessionTurnInputSchema = z
  .array(z.discriminatedUnion("type", [textInputItemSchema, skillInputItemSchema]))
  .min(1)
  .max(maximumInputItems);

const readySessionCapabilitiesSchema = z
  .object({
    authentication: z.literal("chatgpt"),
    structuredOutput: z.enum(["unverified", "verified"]),
    instructionSources: z.literal(true),
    skills: z.literal(true),
  })
  .strict();

const authenticationRequiredCapabilitiesSchema = z
  .object({
    authentication: z.literal("required"),
    structuredOutput: z.literal("unverified"),
    instructionSources: z.literal(false),
    skills: z.literal(false),
  })
  .strict();

const startResultPathShape = {
  workspacePath: absolutePathSchema,
  agentsFilePath: absolutePathSchema,
  taskctlConnectionInfoPath: absolutePathSchema,
};

/** Codexセッションの起動結果を検証するスキーマです。 */
export const codexSessionStartResultSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("ready"),
        threadId: z.string().min(1).max(200),
        model: modelSchema,
        ...startResultPathShape,
        capabilities: readySessionCapabilitiesSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("authentication_required"),
        ...startResultPathShape,
        capabilities: authenticationRequiredCapabilitiesSchema,
      })
      .strict(),
  ]);

/** Codexターンの最終結果を検証するスキーマです。 */
export const codexSessionTurnResultSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    response: codexResponseSchema,
  })
  .strict();

/** Codexターンの差分イベントを検証するスキーマです。 */
export const codexSessionDeltaSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    turnId: z.string().min(1).max(200),
    itemId: z.string().min(1).max(200),
    delta: utf8DeltaSchema,
  })
  .strict();

const sessionDiagnosticCodeSchema = z.enum([
  "connection_unknown_notification",
  "connection_server_request_rejected",
  "connection_protocol_error",
  "connection_process_exit",
  "connection_listener_error",
  "connection_stderr",
  "connection_stop_error",
  "startup_error",
  "sync_error",
  "turn_error",
  "output_validation_error",
  "listener_error",
  "restart_started",
  "restart_completed",
  "ai_disabled",
]);

/** Codexセッション診断の安全な形式を検証するスキーマです。 */
export const codexSessionDiagnosticSchema = z
  .object({
    code: sessionDiagnosticCodeSchema,
    cause_present: z.boolean(),
  })
  .strict();

/** Codexセッション診断の配列を検証するスキーマです。 */
export const codexSessionDiagnosticsSchema = z
  .array(codexSessionDiagnosticSchema)
  .max(maximumDiagnostics);

/** Codexセッションの状態を検証するスキーマです。 */
export const codexSessionStateSchema = z.enum([
  "created",
  "starting",
  "authentication_required",
  "ready",
  "turning",
  "restarting",
  "disabled",
  "stopping",
  "stopped",
  "failed",
]);

export type CodexSessionOptions = z.infer<typeof codexSessionOptionsSchema>;
export type CodexSessionTurnInput = z.infer<typeof codexSessionTurnInputSchema>;
export type CodexSessionStartResult = z.infer<typeof codexSessionStartResultSchema>;
export type CodexSessionTurnResult = z.infer<typeof codexSessionTurnResultSchema>;
export type CodexSessionDelta = z.infer<typeof codexSessionDeltaSchema>;
export type CodexSessionDiagnostic = z.infer<typeof codexSessionDiagnosticSchema>;
export type CodexSessionState = z.infer<typeof codexSessionStateSchema>;
export type CodexSessionDeltaListener =
  (delta: CodexSessionDelta) => void | PromiseLike<void>;
function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(candidatePath));
  return (
    relativePath.length === 0
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}
