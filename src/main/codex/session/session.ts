import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  CodexAppServerConnection,
  CodexProcessExitError,
  accountReadParamsSchema,
  accountReadResultSchema,
  chatGptLoginStartParamsSchema,
  chatGptLoginStartResultSchema,
  codexConnectionOptionsSchema,
  codexDiagnosticSchema,
  codexNotificationSchema,
  experimentalFeatureListParamsSchema,
  experimentalFeatureListResultSchema,
  mcpServerStatusListParamsSchema,
  mcpServerStatusListResultSchema,
  modelListParamsSchema,
  modelListResultSchema,
  permissionProfileListParamsSchema,
  permissionProfileListResultSchema,
  skillsListParamsSchema,
  skillsListResultSchema,
  threadStartParamsSchema,
  threadStartResultSchema,
  turnInterruptParamsSchema,
  turnInterruptResultSchema,
  turnStartParamsSchema,
  turnStartResultSchema,
  type CodexConnectionOptions,
  type CodexDiagnostic,
  type CodexNotification,
  type ExperimentalFeatureListResult,
  type McpServerStatusListResult,
  type ModelListResult,
  type PermissionProfileListResult,
  type ChatGptLoginStartResult,
  type ThreadStartResult,
} from "../app-server";
import {
  TaskctlBroker,
  taskctlBrokerStartResultSchema,
  taskctlSnapshotSchema,
  type TaskctlBrokerStartResult,
  type TaskctlSnapshot,
} from "../taskctl";
import { createUtf8ByteLimitedStringSchema } from "../../../shared/domain";
import { codexResponseSchema } from "../../../shared/ai";
import {
  CodexSessionAbortedError,
  CodexSessionAuthenticationError,
  CodexSessionCapabilityError,
  CodexSessionDisabledError,
  CodexSessionError,
  CodexSessionOutputValidationError,
  CodexSessionStateError,
  CodexSessionSyncError,
  CodexSessionTurnError,
} from "./errors";
import {
  codexSessionDeltaSchema,
  codexSessionDiagnosticsSchema,
  codexSessionOptionsSchema,
  codexSessionStartResultSchema,
  codexSessionStateSchema,
  codexSessionTurnInputFactorySchema,
  codexSessionTurnInputSchema,
  codexSessionTurnResultSchema,
  type CodexSessionConnection,
  type CodexSessionConnectionFactory,
  type CodexSessionDelta,
  type CodexSessionDeltaListener,
  type CodexSessionDiagnostic,
  type CodexSessionOptions,
  type CodexSessionStartResult,
  type CodexSessionState,
  type CodexSessionTurnInput,
  type CodexSessionTurnInputFactory,
  type CodexSessionTurnResult,
} from "./schemas";

const maximumBufferedNotifications = 128;
const maximumStoredDiagnostics = 256;
const maximumFinalMessageBytes = 256 * 1024;
const maximumModelRecords = 10_000;
const requiredSkillNames = new Set(["taskctl", "obsidian", "external-tools"]);
const permissionProfileId = "taskhub";
const permissionProfileWaitTimeoutMs = 5_000;
const accountReadRetryDelaysMilliseconds: readonly [number, number, number, number] = [
  250,
  500,
  750,
  1_000,
];
const disabledFeatureNames = [
  "apps",
  "plugins",
  "in_app_browser",
  "browser_use",
  "browser_use_full_cdp_access",
  "browser_use_external",
  "computer_use",
  "remote_plugin",
  "image_generation",
  "in_app_local_automation",
  "hooks",
  "multi_agent",
  "multi_agent_v2",
  "skill_mcp_dependency_install",
  "web_search_request",
  "standalone_executable",
  "code_mode_host",
  "tool_suggest",
];

type PermissionProfileNotification = {
  readonly threadId: string;
  readonly profileId: string | undefined;
  readonly profileExtends: string | null | undefined;
  readonly sandboxValid: boolean;
};

type PermissionProfileWaiter = {
  readonly threadId: string;
  readonly resolve: (profileId: string) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly timer: NodeJS.Timeout;
};

type AccountInspectionResult =
  | { readonly kind: "authenticated" }
  | { readonly kind: "authentication_pending" }
  | { readonly kind: "wrong_account_type" };

const finalAgentMessageSchema = z
  .object({
    type: z.literal("agentMessage"),
    id: z.string().min(1).max(200),
    text: createUtf8ByteLimitedStringSchema(maximumFinalMessageBytes),
    phase: z.literal("final_answer"),
  })
  .strict();

const codexHomePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Codex認証領域のパスは絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "Codex認証領域のパスが不正です。");

type InternalDiagnostic = {
  readonly code: CodexSessionDiagnostic["code"];
  readonly cause: unknown;
};

type TurnFinalItem = {
  readonly id: string;
  readonly text: string;
  readonly phase: "final_answer";
};

type TurnCompletion = {
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
  readonly error: unknown;
};

type ActiveTurnStarting = {
  readonly phase: "starting";
  readonly threadId: string;
  readonly resolve: (result: CodexSessionTurnResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly bufferedNotifications: CodexNotification[];
  abortRequested: boolean;
};

type ActiveTurnRunning = {
  readonly phase: "running";
  readonly threadId: string;
  readonly turnId: string;
  readonly resolve: (result: CodexSessionTurnResult) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly abortListener: () => void;
  readonly connection: CodexSessionConnection;
  abortRequested: boolean;
  interruptSent: boolean;
  finalItem: TurnFinalItem | undefined;
  completion: TurnCompletion | undefined;
};

type ActiveTurn = ActiveTurnStarting | ActiveTurnRunning;

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function createOutputSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(codexResponseSchema, { target: "draft-07" });
  const parsed = z.object({}).passthrough().safeParse(generated);
  if (!parsed.success) {
    throw new CodexSessionCapabilityError(
      "構造化出力スキーマをJSONオブジェクトへ変換できません。",
      parsed.error,
    );
  }
  return parsed.data;
}

function isTurnNotification(notification: CodexNotification): boolean {
  return (
    notification.method === "turn/started"
    || notification.method === "turn/completed"
    || notification.method === "item/completed"
    || notification.method === "item/agentMessage/delta"
  );
}

function notificationThreadId(notification: CodexNotification): string | undefined {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
    case "item/completed":
    case "item/agentMessage/delta":
      return notification.params.threadId;
    default:
      return undefined;
  }
}

function notificationTurnId(notification: CodexNotification): string | undefined {
  switch (notification.method) {
    case "turn/started":
    case "turn/completed":
      return notification.params.turn.id;
    case "item/completed":
    case "item/agentMessage/delta":
      return notification.params.turnId;
    default:
      return undefined;
  }
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function canonicalStringArray(values: readonly string[]): string {
  return JSON.stringify([...values].sort(compareStrings));
}

function isSafetyCriticalState(state: CodexSessionState): boolean {
  return (
    state === "starting"
    || state === "authentication_required"
    || state === "ready"
    || state === "turning"
    || state === "restarting"
  );
}

function createSafetyViolationError(cause?: unknown): CodexSessionCapabilityError {
  return new CodexSessionCapabilityError(
    "Codex接続の安全性を確認できないためAIを開始できません。",
    cause,
  );
}

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(candidatePath));
  return (
    relativePath.length === 0
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(sep))
  );
}

function resolveVerifiedReadOnlyDirectory(directoryPath: string): string {
  const normalizedPath = resolve(directoryPath);
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  try {
    const parts = relative(rootPath, normalizedPath)
      .split(sep)
      .filter((part) => part.length > 0);
    for (const part of parts) {
      currentPath = join(currentPath, part);
      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new CodexSessionCapabilityError(
          "Vaultのパスにシンボリックリンクを指定できません。",
        );
      }
    }
    const stats = lstatSync(normalizedPath);
    if (!stats.isDirectory()) {
      throw new CodexSessionCapabilityError(
        "Vaultのパスはディレクトリでなければなりません。",
      );
    }
    return realpathSync.native(normalizedPath);
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(
      "Vaultの実体パスを安全に検証できません。",
      error,
    );
  }
}

function resolveExistingDirectory(directoryPath: string, label: string): string {
  try {
    const realPath = realpathSync.native(directoryPath);
    if (!lstatSync(realPath).isDirectory()) {
      throw new CodexSessionCapabilityError(`${label}はディレクトリでなければなりません。`);
    }
    return realPath;
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(`${label}の実体パスを確認できません。`, error);
  }
}

function resolveVerifiedConfigurationDirectory(
  directoryPath: string,
  label: string,
): string {
  const normalizedPath = resolve(directoryPath);
  if (normalizedPath !== directoryPath) {
    throw new CodexSessionCapabilityError(`${label}のパスが正規化されていません。`);
  }
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  try {
    const parts = relative(rootPath, normalizedPath)
      .split(sep)
      .filter((part) => part.length > 0);
    for (const part of parts) {
      currentPath = join(currentPath, part);
      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new CodexSessionCapabilityError(`${label}にシンボリックリンクを指定できません。`);
      }
    }
    const stats = lstatSync(normalizedPath);
    if (!stats.isDirectory()) {
      throw new CodexSessionCapabilityError(`${label}はディレクトリでなければなりません。`);
    }
    const realPath = realpathSync.native(normalizedPath);
    if (realPath !== normalizedPath) {
      throw new CodexSessionCapabilityError(`${label}の設定パスと実体パスが一致しません。`);
    }
    return realPath;
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(`${label}を安全に検証できません。`, error);
  }
}

function validateOwnedUnixSocket(socketPath: string, label: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(socketPath);
  } catch (error: unknown) {
    throw new CodexSessionCapabilityError(`${label}を確認できません。`, error);
  }
  if (typeof process.getuid !== "function") {
    throw new CodexSessionCapabilityError(`${label}の所有者を確認できません。`);
  }
  if (
    stats.isSymbolicLink()
    || !stats.isSocket()
    || stats.uid !== process.getuid()
    || (stats.mode & 0o777) !== 0o600
  ) {
    throw new CodexSessionCapabilityError(`${label}の実体または権限が不正です。`);
  }
}

function validateTaskctlConnectionInfoPath(
  connectionInfoPath: string,
  tmpDirectoryPath: string,
): void {
  const expectedPath = join(tmpDirectoryPath, "taskctl-connection.json");
  if (resolve(connectionInfoPath) !== expectedPath) {
    throw new CodexSessionCapabilityError(
      "taskctl接続情報を専用ワークスペースのtmp直下に限定できません。",
    );
  }
  let stats: Stats;
  try {
    stats = lstatSync(connectionInfoPath);
  } catch (error: unknown) {
    throw new CodexSessionCapabilityError("taskctl接続情報を確認できません。", error);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexSessionCapabilityError("taskctl接続情報の実体が不正です。");
  }
  if (process.platform === "win32") {
    return;
  }
  if (typeof process.getuid !== "function") {
    throw new CodexSessionCapabilityError("taskctl接続情報の所有者を確認できません。");
  }
  if (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o600) {
    throw new CodexSessionCapabilityError("taskctl接続情報の所有者または権限が不正です。");
  }
}

function validateTaskctlLocalIpc(
  startResult: TaskctlBrokerStartResult,
  tmpDirectoryPath: string,
): string {
  const parsedResult = taskctlBrokerStartResultSchema.safeParse(startResult);
  if (!parsedResult.success) {
    throw new CodexSessionCapabilityError(
      "taskctlローカルIPCの起動結果を検証できません。",
      parsedResult.error,
    );
  }
  const result = parsedResult.data;
  validateTaskctlConnectionInfoPath(result.connectionInfoPath, tmpDirectoryPath);
  if (process.platform === "win32") {
    if (
      result.localIpcBoundary.kind !== "windows_named_pipe"
      || result.localIpcBoundary.access !== "current_user"
      || !/^\\\\\.\\pipe\\taskhub-taskctl-[0-9a-f]{24}$/u.test(result.socketPath)
    ) {
      throw new CodexSessionCapabilityError(
        "taskctl名前付きパイプを現在の利用者向け境界へ限定できません。",
      );
    }
    return result.socketPath;
  }
  if (
    result.localIpcBoundary.kind !== "unix_socket"
    || result.localIpcBoundary.access !== "owner_only"
    || parse(resolve(result.socketPath)).dir !== tmpDirectoryPath
    || !/^taskctl-[0-9a-f]{24}\.sock$/u.test(parse(result.socketPath).base)
  ) {
    throw new CodexSessionCapabilityError(
      "taskctlソケットを専用ワークスペースのtmp直下に限定できません。",
    );
  }
  validateOwnedUnixSocket(result.socketPath, "taskctlソケット");
  return result.socketPath;
}

function validateAdditionalLocalSocketPaths(
  paths: readonly string[],
  tmpDirectoryPath: string,
): readonly string[] {
  const values = z.array(z.string().min(1).max(4_096)).max(32).parse(paths);
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const value of values) {
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new CodexSessionCapabilityError("追加ローカルIPCの接続先が不正です。");
    }
    if (process.platform === "win32") {
      if (!/^\\\\\.\\pipe\\taskhub-contextctl-[0-9a-f]{24}$/u.test(value)) {
        throw new CodexSessionCapabilityError("contextctl名前付きパイプの接続先を限定できません。");
      }
    } else {
      if (!isAbsolute(value) || parse(resolve(value)).dir !== resolve(tmpDirectoryPath)) {
        throw new CodexSessionCapabilityError("contextctlソケットを専用ワークスペースのtmp直下に限定できません。");
      }
      if (!/^contextctl-[0-9a-f]{24}\.sock$/u.test(parse(value).base)) {
        throw new CodexSessionCapabilityError("contextctlソケットの接続先が不正です。");
      }
      validateOwnedUnixSocket(value, "contextctlソケット");
    }
    const key = process.platform === "win32" ? value : resolve(value);
    if (seen.has(key)) {
      throw new CodexSessionCapabilityError("同じ追加ローカルIPCを重複して指定できません。");
    }
    seen.add(key);
    validated.push(value);
  }
  return validated;
}

function validateTurnSkills(
  input: CodexSessionTurnInput,
  workspacePath: string,
): void {
  for (const item of input) {
    if (item.type !== "skill") {
      continue;
    }
    if (!requiredSkillNames.has(item.name)) {
      throw new CodexSessionCapabilityError("Codexターンへ許可されていないスキルを指定できません。");
    }
    const expectedPath = join(workspacePath, ".agents", "skills", item.name, "SKILL.md");
    if (item.path !== expectedPath) {
      throw new CodexSessionCapabilityError("Codexターンへ専用ワークスペース外のスキルを指定できません。");
    }
  }
}

function hasWorkspaceWriteSandbox(
  sandbox: ThreadStartResult["sandbox"],
  workspacePath: string,
  tmpDirectoryPath: string,
): boolean {
  if (sandbox.type !== "workspaceWrite") {
    return false;
  }
  const roots = new Set(sandbox.writableRoots);
  return (
    roots.size === 2
    && roots.has(workspacePath)
    && roots.has(tmpDirectoryPath)
    && sandbox.networkAccess === false
    && sandbox.excludeTmpdirEnvVar === true
    && sandbox.excludeSlashTmp === true
  );
}

function isConnectionShape(value: unknown): value is CodexSessionConnection {
  if (typeof value !== "object" || value == null) {
    return false;
  }
  const functionNames = [
    "start",
    "readAccount",
    "startChatGptLogin",
    "listModels",
    "listSkills",
    "listPermissionProfiles",
    "listMcpServerStatuses",
    "listExperimentalFeatures",
    "getCodexHome",
    "startThread",
    "startTurn",
    "interruptTurn",
    "onNotification",
    "onDiagnostic",
    "getDiagnostics",
    "stop",
  ];
  return functionNames.every((name) => typeof Reflect.get(value, name) === "function");
}

/** Codexセッションで利用する実接続ファクトリを作成します。 */
export function createCodexAppServerConnectionFactory(
  options: CodexConnectionOptions,
): CodexSessionConnectionFactory {
  const validatedOptions = codexConnectionOptionsSchema.parse(options);
  if (validatedOptions.capabilities?.experimentalApi !== true) {
    throw new CodexSessionCapabilityError(
      "Codexの実験APIが有効でないため権限プロファイルを利用できません。",
    );
  }
  return (): CodexSessionConnection => new CodexAppServerConnection(validatedOptions);
}

/** Codex app-serverと一時taskctlを一つのAIセッションとして管理します。 */
export class CodexSessionService {
  private readonly options: CodexSessionOptions;
  private readonly broker: TaskctlBroker;
  private readonly outputSchema: Record<string, unknown>;
  private readOnlyVaultPaths: readonly string[];
  private additionalLocalSocketPaths: readonly string[];
  private readonly deltaListeners = new Set<CodexSessionDeltaListener>();
  private readonly diagnostics: InternalDiagnostic[] = [];
  private state: CodexSessionState = "created";
  private connection: CodexSessionConnection | undefined;
  private removeNotificationListener: (() => void) | undefined;
  private removeDiagnosticListener: (() => void) | undefined;
  private taskctlStartResult: TaskctlBrokerStartResult | undefined;
  private frozenTaskctlSnapshot: TaskctlSnapshot | undefined;
  private threadId: string | undefined;
  private selectedModel: string | undefined;
  private permissionProfileNotification: PermissionProfileNotification | undefined;
  private permissionProfileWaiter: PermissionProfileWaiter | undefined;
  private mcpServerNames: string[] | undefined;
  private skillConfiguration: Array<{ path: string; enabled: boolean }> = [];
  private threadConfigurationChanged = false;
  private lifecycleSignal: AbortSignal | undefined;
  private lifecycleAbortListener: (() => void) | undefined;
  private recoveryAbortController: AbortController | undefined;
  private activeTurn: ActiveTurn | undefined;
  private restartCount = 0;
  private restartPromise: Promise<void> | undefined;
  private successfullyStarted = false;
  private structuredOutputVerified = false;
  private safetyViolation = false;
  private stopPromise: Promise<void> | undefined;
  private disablePromise: Promise<void> | undefined;

  public constructor(options: CodexSessionOptions) {
    this.options = codexSessionOptionsSchema.parse(options);
    this.readOnlyVaultPaths = [...this.options.readOnlyVaultPaths];
    this.additionalLocalSocketPaths = [...(this.options.additionalUnixSocketPaths ?? [])];
    this.broker = new TaskctlBroker({
      tmpDirectoryPath: this.options.tmpDirectoryPath,
      snapshotProvider: () => {
        if (this.frozenTaskctlSnapshot != null) {
          return this.frozenTaskctlSnapshot;
        }
        return this.options.snapshotProvider();
      },
    });
    this.outputSchema = createOutputSchema();
  }

  /** Codexが読み取り専用で参照できるVaultを更新します。 */
  public setReadOnlyVaultPaths(paths: readonly string[]): void {
    if (
      this.state !== "created"
      && this.state !== "authentication_required"
      && this.state !== "ready"
    ) {
      throw new CodexSessionStateError();
    }
    const validatedPaths = codexSessionOptionsSchema.shape.readOnlyVaultPaths.parse(paths);
    if (canonicalStringArray(validatedPaths) === canonicalStringArray(this.readOnlyVaultPaths)) {
      return;
    }
    this.readOnlyVaultPaths = validatedPaths;
    this.threadConfigurationChanged = true;
  }

  /** Codexが接続できる追加ローカルIPCを更新します。 */
  public setAdditionalLocalSocketPaths(paths: readonly string[]): void {
    if (
      this.state !== "created"
      && this.state !== "authentication_required"
      && this.state !== "ready"
    ) {
      throw new CodexSessionStateError();
    }
    const validatedPaths = validateAdditionalLocalSocketPaths(
      paths,
      this.options.tmpDirectoryPath,
    );
    if (
      canonicalStringArray(validatedPaths)
      === canonicalStringArray(this.additionalLocalSocketPaths)
    ) {
      return;
    }
    this.additionalLocalSocketPaths = validatedPaths;
    this.threadConfigurationChanged = true;
  }

  /** 専用ワークスペースのスキル更新後に新規スレッドを必須化します。 */
  public requireThreadConfigurationRefresh(): void {
    if (
      this.state !== "created"
      && this.state !== "authentication_required"
      && this.state !== "ready"
    ) {
      throw new CodexSessionStateError();
    }
    this.threadConfigurationChanged = true;
  }

  /** Codex認証、能力、スキルを検査して新規スレッドを開始します。 */
  public async start(signal: AbortSignal): Promise<CodexSessionStartResult> {
    validateAbortSignal(signal);
    if (this.state !== "created") {
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    this.state = "starting";
    this.lifecycleSignal = signal;
    this.lifecycleAbortListener = () => {
      void this.stop().catch((error: unknown) => {
        this.recordDiagnostic("connection_stop_error", error);
      });
    };
    signal.addEventListener("abort", this.lifecycleAbortListener, { once: true });

    try {
      this.taskctlStartResult = await this.broker.start(signal);
      await this.connectWithInitialRetry(signal);
      this.assertSafetyIntact();
      this.successfullyStarted = true;
      this.state = "ready";
      return this.createStartResult();
    } catch (error: unknown) {
      if (
        error instanceof CodexSessionAuthenticationError
        && this.connection != null
        && this.taskctlStartResult != null
        && !this.safetyViolation
        && !signal.aborted
      ) {
        this.successfullyStarted = true;
        this.state = "authentication_required";
        return this.createAuthenticationRequiredResult();
      }
      const cleanupErrors = await this.cleanupResources();
      if (cleanupErrors.length > 0) {
        for (const cleanupError of cleanupErrors) {
          this.recordDiagnostic("connection_stop_error", cleanupError);
        }
      }
      if (signal.aborted) {
        this.state = "stopped";
      } else if (this.safetyViolation) {
        this.state = "disabled";
        throw createSafetyViolationError(error);
      } else {
        this.recordDiagnostic("startup_error", error);
        this.state = "disabled";
      }
      throw error;
    }
  }

  /** ChatGPTログイン後に能力検査と新規スレッド開始を再開します。 */
  public async completeAuthentication(signal: AbortSignal): Promise<CodexSessionStartResult> {
    validateAbortSignal(signal);
    if (this.state !== "authentication_required" || this.connection == null) {
      throw new CodexSessionStateError();
    }
    this.assertSafetyIntact();
    const connection = this.connection;
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    this.state = "starting";
    try {
      const accountInspection = await this.inspectAccountWithRetry(connection, signal);
      if (accountInspection.kind === "authentication_pending") {
        this.state = "authentication_required";
        return this.createAuthenticationRequiredResult();
      }
      if (accountInspection.kind === "wrong_account_type") {
        throw new CodexSessionAuthenticationError();
      }
      await this.inspectModel(connection, signal);
      await this.inspectSkills(connection, signal);
      await this.inspectPermissionProfile(connection, signal);
      await this.inspectMcpServers(connection, signal);
      await this.startThreadOnCurrentConnection(signal);
      this.assertSafetyIntact();
      this.state = "ready";
      return this.createStartResult();
    } catch (error: unknown) {
      if (error instanceof CodexSessionAuthenticationError && !this.safetyViolation) {
        this.state = "authentication_required";
        throw error;
      }
      if (this.safetyViolation) {
        throw createSafetyViolationError(error);
      }
      await this.disableAi(error);
      throw error;
    }
  }

  /** GUIの新規セッション用に現在接続で新しいスレッドを開始します。 */
  public async startNewSession(signal: AbortSignal): Promise<CodexSessionStartResult> {
    validateAbortSignal(signal);
    if (this.state !== "ready" || this.activeTurn != null) {
      throw new CodexSessionStateError();
    }
    this.assertSafetyIntact();
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const connection = this.connection;
    if (connection == null) {
      throw new CodexSessionStateError();
    }
    this.state = "starting";
    try {
      await this.inspectSkills(connection, signal);
      await this.inspectPermissionProfile(connection, signal);
      await this.inspectModel(connection, signal);
      await this.inspectMcpServers(connection, signal);
      await this.startThreadOnCurrentConnection(signal);
      this.assertSafetyIntact();
      this.state = "ready";
      return this.createStartResult();
    } catch (error: unknown) {
      await this.disableAi(error);
      throw error;
    }
  }

  /** ChatGPTのブラウザログイン開始要求をCodexへ渡します。 */
  public async startChatGptLogin(signal: AbortSignal): Promise<ChatGptLoginStartResult> {
    validateAbortSignal(signal);
    const connection = this.connection;
    if (
      connection == null
      || this.state !== "authentication_required"
    ) {
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const params = chatGptLoginStartParamsSchema.parse({ type: "chatgpt" });
    return chatGptLoginStartResultSchema.parse(
      await connection.startChatGptLogin(params, signal),
    );
  }

  /** 同期後に構造化出力を指定して一つのCodexターンを開始します。 */
  public async startTurn(
    input: CodexSessionTurnInput,
    signal: AbortSignal,
  ): Promise<CodexSessionTurnResult> {
    validateAbortSignal(signal);
    const validatedInput = codexSessionTurnInputSchema.parse(input);
    validateTurnSkills(validatedInput, this.options.workspacePath);
    return this.startTurnWithPreparation(() => validatedInput, signal);
  }

  /** 同期完了後にターン入力を作成して構造化出力を指定したCodexターンを開始します。 */
  public async startTurnWithPreparation(
    prepareInput: CodexSessionTurnInputFactory,
    signal: AbortSignal,
  ): Promise<CodexSessionTurnResult> {
    validateAbortSignal(signal);
    const validatedPrepareInput = codexSessionTurnInputFactorySchema.parse(prepareInput);
    if (this.threadConfigurationChanged) {
      throw new CodexSessionCapabilityError(
        "Codexスレッド構成が変更されました。新しいセッションを開始してください。",
      );
    }
    if (this.state !== "ready" || this.activeTurn != null) {
      if (this.state === "disabled") {
        throw new CodexSessionDisabledError();
      }
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const connection = this.connection;
    const currentThreadId = this.threadId;
    if (connection == null || currentThreadId == null) {
      throw new CodexSessionStateError();
    }

    let activeTurn: ActiveTurnStarting | undefined;
    const turnPromise = new Promise<CodexSessionTurnResult>((resolve, reject) => {
      const abortListener = (): void => {
        const current = this.activeTurn;
        if (current == null || current.threadId !== currentThreadId) {
          return;
        }
        current.abortRequested = true;
        if (current.phase === "running") {
          void this.interruptAfterAbort(current);
        }
      };
      activeTurn = {
        phase: "starting",
        threadId: currentThreadId,
        resolve,
        reject,
        signal,
        abortListener,
        bufferedNotifications: [],
        abortRequested: false,
      };
    });
    const createdActiveTurn = activeTurn;
    if (createdActiveTurn == null) {
      throw new CodexSessionError("Codexターンの初期化に失敗しました。");
    }
    this.activeTurn = createdActiveTurn;
    this.state = "turning";
    signal.addEventListener("abort", createdActiveTurn.abortListener, { once: true });
    if (signal.aborted) {
      createdActiveTurn.abortListener();
    }

    try {
      await this.options.syncBeforeTurn(signal);
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      } else {
        this.recordDiagnostic("sync_error", error);
        this.finishTurn(createdActiveTurn, new CodexSessionSyncError(error));
      }
      return turnPromise;
    }
    if (createdActiveTurn.abortRequested || signal.aborted) {
      this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      return turnPromise;
    }
    if (this.activeTurn !== createdActiveTurn) {
      return turnPromise;
    }

    let validatedInput: CodexSessionTurnInput;
    try {
      validatedInput = codexSessionTurnInputSchema.parse(
        await Promise.resolve(validatedPrepareInput(signal)),
      );
      validateTurnSkills(validatedInput, this.options.workspacePath);
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      } else {
        this.finishTurn(createdActiveTurn, error);
      }
      return turnPromise;
    }

    let params: ReturnType<typeof turnStartParamsSchema.parse>;
    try {
      params = turnStartParamsSchema.parse({
        threadId: currentThreadId,
        input: validatedInput,
        cwd: this.options.workspacePath,
        approvalPolicy: "never",
        model: this.requireSelectedModel(),
        outputSchema: this.outputSchema,
      });
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        this.finishTurn(createdActiveTurn, new CodexSessionAbortedError());
      } else {
        this.finishTurn(createdActiveTurn, error);
      }
      return turnPromise;
    }

    let started: Awaited<ReturnType<CodexSessionConnection["startTurn"]>>;
    try {
      started = await connection.startTurn(params, signal);
      started = turnStartResultSchema.parse(started);
    } catch (error: unknown) {
      if (createdActiveTurn.abortRequested || signal.aborted) {
        await this.recoverAfterStartingAbort(createdActiveTurn, error);
      } else if (!this.structuredOutputVerified) {
        await this.disableAi(error);
      } else {
        this.finishTurn(
          createdActiveTurn,
          error,
        );
      }
      return turnPromise;
    }
    if (this.activeTurn !== createdActiveTurn) {
      return turnPromise;
    }
    if (createdActiveTurn.abortRequested || signal.aborted) {
      await this.recoverAfterStartingAbort(
        createdActiveTurn,
        new CodexSessionAbortedError(),
      );
      return turnPromise;
    }
    const runningTurn: ActiveTurnRunning = {
      phase: "running",
      threadId: currentThreadId,
      turnId: started.turn.id,
      resolve: createdActiveTurn.resolve,
      reject: createdActiveTurn.reject,
      signal: createdActiveTurn.signal,
      abortListener: createdActiveTurn.abortListener,
      connection,
      abortRequested: createdActiveTurn.abortRequested,
      interruptSent: false,
      finalItem: undefined,
      completion: undefined,
    };
    this.activeTurn = runningTurn;
    if (runningTurn.abortRequested) {
      void this.interruptAfterAbort(runningTurn);
    }
    this.processBufferedNotifications(runningTurn, createdActiveTurn.bufferedNotifications);
    this.completeTurnIfReady(runningTurn);
    return turnPromise;
  }

  private async recoverAfterStartingAbort(
    active: ActiveTurnStarting,
    cause: unknown,
  ): Promise<void> {
    if (this.activeTurn !== active) {
      return;
    }
    const abortedError = new CodexSessionAbortedError();
    const lifecycleSignal = this.lifecycleSignal;
    if (lifecycleSignal == null || lifecycleSignal.aborted) {
      await this.disableAi(cause, abortedError);
      return;
    }
    this.state = "restarting";
    const cleanupErrors = await this.cleanupConnection();
    for (const cleanupError of cleanupErrors) {
      this.recordDiagnostic("connection_stop_error", cleanupError);
    }
    if (cleanupErrors.length > 0) {
      await this.disableAi(
        new CodexSessionError(
          "Codex接続を安全に停止できませんでした。",
          new AggregateError(cleanupErrors),
        ),
        abortedError,
      );
      return;
    }
    if (this.activeTurn !== active || this.state !== "restarting") {
      return;
    }
    const recoveryController = new AbortController();
    this.recoveryAbortController = recoveryController;
    const lifecycleAbortListener = (): void => {
      recoveryController.abort();
    };
    lifecycleSignal.addEventListener("abort", lifecycleAbortListener, { once: true });
    try {
      await this.connectAndStartThread(recoveryController.signal);
      if (recoveryController.signal.aborted) {
        throw new CodexSessionAbortedError();
      }
      this.state = "ready";
      this.finishTurn(active, abortedError);
    } catch (error: unknown) {
      await this.disableAi(error, abortedError);
    } finally {
      if (this.recoveryAbortController === recoveryController) {
        this.recoveryAbortController = undefined;
      }
      lifecycleSignal.removeEventListener("abort", lifecycleAbortListener);
    }
  }

  private async interruptAfterAbort(active: ActiveTurnRunning): Promise<void> {
    if (this.activeTurn !== active || active.interruptSent) {
      return;
    }
    active.interruptSent = true;
    const controller = new AbortController();
    const params = turnInterruptParamsSchema.parse({
      threadId: active.threadId,
      turnId: active.turnId,
    });
    try {
      const result = await active.connection.interruptTurn(params, controller.signal);
      turnInterruptResultSchema.parse(result);
    } catch (error: unknown) {
      this.recordDiagnostic("turn_error", error);
      await this.disableAi(error);
    }
  }

  /** 実行中のCodexターンを中断します。 */
  public async interrupt(signal: AbortSignal): Promise<void> {
    validateAbortSignal(signal);
    const current = this.activeTurn;
    if (
      this.state !== "turning"
      || current == null
      || current.phase !== "running"
    ) {
      throw new CodexSessionStateError();
    }
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    const params = turnInterruptParamsSchema.parse({
      threadId: current.threadId,
      turnId: current.turnId,
    });
    const result = await current.connection.interruptTurn(params, signal);
    turnInterruptResultSchema.parse(result);
  }

  /** CodexのagentMessage差分を購読します。 */
  public onDelta(listener: CodexSessionDeltaListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("差分購読関数が必要です。");
    }
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  /** セッションの状態を取得します。 */
  public getState(): CodexSessionState {
    return codexSessionStateSchema.parse(this.state);
  }

  /** ターン中にtaskctlへ返すスナップショットを固定します。 */
  public freezeTaskctlSnapshot(snapshot: TaskctlSnapshot): void {
    if (this.activeTurn == null) {
      throw new CodexSessionStateError();
    }
    this.frozenTaskctlSnapshot = taskctlSnapshotSchema.parse(snapshot);
  }

  /** ターン中に固定したtaskctlスナップショットを解放します。 */
  public releaseTaskctlSnapshot(): void {
    this.frozenTaskctlSnapshot = undefined;
  }

  /** 本文を含まないセッション診断を取得します。 */
  public getDiagnostics(): CodexSessionDiagnostic[] {
    return codexSessionDiagnosticsSchema.parse(
      this.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        cause_present: diagnostic.cause != null,
      })),
    );
  }

  /** 接続、taskctl、保留ターンを停止します。 */
  public stop(): Promise<void> {
    if (this.stopPromise != null) {
      return this.stopPromise;
    }
    this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    if (this.state === "stopped") {
      return;
    }
    this.state = "stopping";
    if (this.lifecycleSignal != null && this.lifecycleAbortListener != null) {
      this.lifecycleSignal.removeEventListener("abort", this.lifecycleAbortListener);
    }
    this.lifecycleSignal = undefined;
    this.lifecycleAbortListener = undefined;
    this.recoveryAbortController?.abort();
    this.recoveryAbortController = undefined;
    const active = this.activeTurn;
    if (active != null) {
      this.finishTurn(active, new CodexSessionError("Codexセッションを停止しました。"));
    }
    const errors = await this.cleanupResources();
    if (errors.length > 0) {
      for (const error of errors) {
        this.recordDiagnostic("connection_stop_error", error);
      }
      this.state = "failed";
      throw new CodexSessionError(
        "Codexセッションの停止に失敗しました。",
        new AggregateError(errors),
      );
    }
    this.state = "stopped";
  }

  private async connectWithInitialRetry(signal: AbortSignal): Promise<void> {
    this.assertSafetyIntact();
    try {
      await this.connectAndStartThread(signal);
      this.assertSafetyIntact();
    } catch (error: unknown) {
      if (this.safetyViolation) {
        throw createSafetyViolationError(error);
      }
      if (!(error instanceof CodexProcessExitError) || this.restartCount > 0 || signal.aborted) {
        throw error;
      }
      this.restartCount += 1;
      this.recordDiagnostic("restart_started", error);
      const cleanupErrors = await this.cleanupConnection();
      for (const cleanupError of cleanupErrors) {
        this.recordDiagnostic("connection_stop_error", cleanupError);
      }
      try {
        await this.connectAndStartThread(signal);
        this.assertSafetyIntact();
        this.recordDiagnostic("restart_completed", error);
      } catch (retryError: unknown) {
        await this.disableAi(retryError);
        throw retryError;
      }
    }
  }

  private async connectAndStartThread(signal: AbortSignal): Promise<void> {
    this.assertSafetyIntact();
    const candidate = await Promise.resolve(this.options.connectionFactory());
    if (!isConnectionShape(candidate)) {
      throw new CodexSessionCapabilityError("Codex接続ファクトリが不正な接続を返しました。");
    }
    this.structuredOutputVerified = false;
    this.connection = candidate;
    this.removeNotificationListener = candidate.onNotification((notification) => {
      this.receiveNotification(notification);
    });
    this.removeDiagnosticListener = candidate.onDiagnostic((diagnostic) => {
      this.receiveDiagnostic(diagnostic);
    });
    try {
      await candidate.start(signal);
      this.assertSafetyIntact();
      const accountInspection = await this.inspectAccount(candidate, signal);
      if (accountInspection.kind !== "authenticated") {
        throw new CodexSessionAuthenticationError();
      }
      this.assertSafetyIntact();
      await this.inspectModel(candidate, signal);
      this.assertSafetyIntact();
      await this.inspectSkills(candidate, signal);
      this.assertSafetyIntact();
      await this.inspectPermissionProfile(candidate, signal);
      this.assertSafetyIntact();
      await this.inspectMcpServers(candidate, signal);
      this.assertSafetyIntact();
      await this.startThreadOnCurrentConnection(signal);
      this.assertSafetyIntact();
    } catch (error: unknown) {
      if (error instanceof CodexSessionAuthenticationError && !this.safetyViolation) {
        this.state = "authentication_required";
        throw error;
      }
      const cleanupErrors = await this.cleanupConnection();
      for (const cleanupError of cleanupErrors) {
        this.recordDiagnostic("connection_stop_error", cleanupError);
      }
      if (this.safetyViolation) {
        throw createSafetyViolationError(error);
      }
      throw error;
    }
  }

  private async inspectAccount(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<AccountInspectionResult> {
    const params = accountReadParamsSchema.parse({ refreshToken: false });
    const result = accountReadResultSchema.parse(await connection.readAccount(params, signal));
    if (result.account != null && result.account.type !== "chatgpt") {
      return { kind: "wrong_account_type" };
    }
    if (result.account == null) {
      return { kind: "authentication_pending" };
    }
    return { kind: "authenticated" };
  }

  private async inspectAccountWithRetry(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<AccountInspectionResult> {
    let inspection = await this.inspectAccount(connection, signal);
    for (const delayMilliseconds of accountReadRetryDelaysMilliseconds) {
      if (inspection.kind !== "authentication_pending") {
        return inspection;
      }
      await this.waitForAccountReadRetry(delayMilliseconds, signal);
      this.assertSafetyIntact();
      inspection = await this.inspectAccount(connection, signal);
    }
    return inspection;
  }

  private waitForAccountReadRetry(
    delayMilliseconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new CodexSessionAbortedError();
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolvePromise();
      }, delayMilliseconds);
      const onAbort = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        rejectPromise(new CodexSessionAbortedError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  private async inspectModel(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    this.selectedModel = undefined;
    const models: ModelListResult["data"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const params = modelListParamsSchema.parse(
        cursor == null
          ? { limit: 1_000, includeHidden: false }
          : { limit: 1_000, includeHidden: false, cursor },
      );
      const result = modelListResultSchema.parse(
        await connection.listModels(params, signal),
      );
      models.push(...result.data);
      if (models.length > maximumModelRecords) {
        throw new CodexSessionCapabilityError("Codexモデル一覧が上限を超えています。");
      }
      const nextCursor = result.nextCursor;
      if (nextCursor == null) {
        break;
      }
      if (seenCursors.has(nextCursor)) {
        throw new CodexSessionCapabilityError("Codexモデル一覧のページングが進みません。");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    const modelIds = new Set<string>();
    for (const model of models) {
      if (modelIds.has(model.id)) {
        throw new CodexSessionCapabilityError("Codexモデル一覧に重複したモデルがあります。");
      }
      modelIds.add(model.id);
    }
    const defaults = models.filter(
      (model) => model.hidden !== true && model.isDefault === true,
    );
    if (defaults.length !== 1) {
      throw new CodexSessionCapabilityError("利用可能な既定Codexモデルを一つに確定できません。");
    }
    const selected = defaults[0];
    if (selected == null) {
      throw new CodexSessionCapabilityError("利用可能な既定Codexモデルを取得できません。");
    }
    this.selectedModel = selected.id;
  }

  private async inspectSkills(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    const params = skillsListParamsSchema.parse({
      cwds: [this.options.workspacePath],
      forceReload: true,
    });
    const result = skillsListResultSchema.parse(await connection.listSkills(params, signal));
    const workspace = result.data.find((entry) => entry.cwd === this.options.workspacePath);
    if (workspace == null) {
      throw new CodexSessionCapabilityError("専用ワークスペースのスキル一覧を取得できません。");
    }

    const seenNames = new Set<string>();
    const seenPaths = new Set<string>();
    const configuration = workspace.skills.map((skill) => {
      if (seenNames.has(skill.name) || seenPaths.has(skill.path)) {
        throw new CodexSessionCapabilityError("Codexスキル一覧に重複した項目があります。");
      }
      seenNames.add(skill.name);
      seenPaths.add(skill.path);
      const required = requiredSkillNames.has(skill.name);
      const expectedPath = join(
        this.options.workspacePath,
        ".agents",
        "skills",
        skill.name,
        "SKILL.md",
      );
      const allowed = required && skill.path === expectedPath;
      if (required && !allowed) {
        throw new CodexSessionCapabilityError("必要なCodexスキルを利用できません。");
      }
      return { path: skill.path, enabled: allowed };
    });
    for (const requiredSkillName of requiredSkillNames) {
      const expectedPath = join(
        this.options.workspacePath,
        ".agents",
        "skills",
        requiredSkillName,
        "SKILL.md",
      );
      const requiredSkill = workspace.skills.find(
        (skill) => skill.name === requiredSkillName && skill.path === expectedPath,
      );
      if (requiredSkill == null || requiredSkill.enabled !== true) {
        throw new CodexSessionCapabilityError("必要なCodexスキルを利用できません。");
      }
    }
    this.skillConfiguration = configuration.sort((left, right) => compareStrings(left.path, right.path));
    this.threadConfigurationChanged = false;
  }

  private async inspectPermissionProfile(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    const params = permissionProfileListParamsSchema.parse({
      cwd: this.options.workspacePath,
      limit: 1_000,
    });
    const result: PermissionProfileListResult = permissionProfileListResultSchema.parse(
      await connection.listPermissionProfiles(params, signal),
    );
    if (result.nextCursor != null) {
      throw new CodexSessionCapabilityError("権限プロファイル一覧を全件確認できません。");
    }
    const selected = result.data.find((profile) => profile.id === permissionProfileId);
    if (selected != null && selected.allowed !== true) {
      throw new CodexSessionCapabilityError("TaskHub用権限プロファイルが許可されていません。");
    }
  }

  private async inspectMcpServers(
    connection: CodexSessionConnection,
    signal: AbortSignal,
  ): Promise<void> {
    const params = mcpServerStatusListParamsSchema.parse({
      detail: "toolsAndAuthOnly",
      limit: 1_000,
    });
    const result: McpServerStatusListResult = mcpServerStatusListResultSchema.parse(
      await connection.listMcpServerStatuses(params, signal),
    );
    if (result.nextCursor != null) {
      throw new CodexSessionCapabilityError("MCPサーバー一覧を全件確認できません。");
    }
    const names = result.data.map((server) => server.name);
    if (new Set(names).size !== names.length) {
      throw new CodexSessionCapabilityError("MCPサーバー一覧に重複した名前があります。");
    }
    this.mcpServerNames = names.sort(compareStrings);
  }

  private async inspectMcpServersAfterThread(
    connection: CodexSessionConnection,
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const expectedNames = this.mcpServerNames;
    if (expectedNames == null) {
      throw new CodexSessionStateError();
    }
    const params = mcpServerStatusListParamsSchema.parse({
      detail: "toolsAndAuthOnly",
      limit: 1_000,
      threadId,
    });
    const result: McpServerStatusListResult = mcpServerStatusListResultSchema.parse(
      await connection.listMcpServerStatuses(params, signal),
    );
    if (result.nextCursor != null) {
      throw new CodexSessionCapabilityError("スレッドのMCPサーバー一覧を全件確認できません。");
    }
    const actualNames = result.data.map((server) => server.name).sort(compareStrings);
    if (
      actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])
    ) {
      throw new CodexSessionCapabilityError("スレッドのMCPサーバー構成を確認できません。");
    }
    for (const server of result.data) {
      if (
        Object.keys(server.tools).length > 0
        || server.resources.length > 0
        || server.resourceTemplates.length > 0
      ) {
        throw new CodexSessionCapabilityError("MCPサーバーの外部機能を無効化できません。");
      }
    }
  }

  private async inspectExperimentalFeatures(
    connection: CodexSessionConnection,
    threadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const params = experimentalFeatureListParamsSchema.parse({
      limit: 1_000,
      threadId,
    });
    const result: ExperimentalFeatureListResult = experimentalFeatureListResultSchema.parse(
      await connection.listExperimentalFeatures(params, signal),
    );
    if (result.nextCursor != null) {
      throw new CodexSessionCapabilityError("Codex機能一覧を全件確認できません。");
    }
    const seen = new Set<string>();
    for (const feature of result.data) {
      if (seen.has(feature.name)) {
        throw new CodexSessionCapabilityError("Codex機能一覧に重複した名前があります。");
      }
      seen.add(feature.name);
    }
    for (const featureName of disabledFeatureNames) {
      const feature = result.data.find((candidate) => candidate.name === featureName);
      if (feature == null || feature.enabled !== false) {
        throw new CodexSessionCapabilityError("Codexの外部機能を無効化できません。");
      }
    }
  }

  private createThreadConfiguration(
    codexHome: string,
    taskctlStartResult: TaskctlBrokerStartResult,
  ): Record<string, unknown> {
    const realCodexHome = resolveExistingDirectory(codexHome, "Codex認証領域");
    const realWorkspacePath = resolveVerifiedConfigurationDirectory(
      this.options.workspacePath,
      "Codex専用ワークスペース",
    );
    const realTmpDirectoryPath = resolveVerifiedConfigurationDirectory(
      this.options.tmpDirectoryPath,
      "Codex専用ワークスペースのtmp",
    );
    if (
      isPathWithin(realWorkspacePath, realCodexHome)
      || isPathWithin(realCodexHome, realWorkspacePath)
    ) {
      throw new CodexSessionCapabilityError("Codex認証領域と専用ワークスペースの範囲が重なっています。");
    }
    const socketPath = validateTaskctlLocalIpc(taskctlStartResult, realTmpDirectoryPath);
    const verifiedVaultPaths = this.readOnlyVaultPaths.map(resolveVerifiedReadOnlyDirectory);
    if (new Set(verifiedVaultPaths).size !== verifiedVaultPaths.length) {
      throw new CodexSessionCapabilityError("同じVaultの実体パスを重複して指定できません。");
    }
    for (const vaultPath of verifiedVaultPaths) {
      if (
        isPathWithin(vaultPath, realCodexHome)
        || isPathWithin(realCodexHome, vaultPath)
      ) {
        throw new CodexSessionCapabilityError("Codex認証領域とVaultの範囲が重なっています。");
      }
      if (
        isPathWithin(vaultPath, realWorkspacePath)
        || isPathWithin(realWorkspacePath, vaultPath)
      ) {
        throw new CodexSessionCapabilityError("Codex専用ワークスペースとVaultの範囲が重なっています。");
      }
    }
    const filesystem: Record<string, unknown> = {
      ":root": "deny",
      ":minimal": "read",
      ":tmpdir": "deny",
      ":slash_tmp": "deny",
      [realWorkspacePath]: {
        ".": "read",
        tmp: "write",
      },
      [realCodexHome]: "deny",
    };
    for (const vaultPath of verifiedVaultPaths) {
      filesystem[vaultPath] = "read";
    }
    const disabledFeatures: Record<string, unknown> = {};
    for (const featureName of disabledFeatureNames) {
      disabledFeatures[featureName] = false;
    }
    const mcpServerNames = this.mcpServerNames;
    if (mcpServerNames == null) {
      throw new CodexSessionStateError();
    }
    const mcpServers = Object.fromEntries(
      mcpServerNames.map((serverName) => [serverName, { enabled: false }]),
    );
    const unixSocketPaths = [
      socketPath,
      ...validateAdditionalLocalSocketPaths(
        this.additionalLocalSocketPaths,
        realTmpDirectoryPath,
      ),
    ];
    const unixSockets = Object.fromEntries(
      [...new Set(unixSocketPaths)].map((path) => [path, "allow"]),
    );
    return {
      default_permissions: permissionProfileId,
      permissions: {
        [permissionProfileId]: {
          filesystem,
          network: {
            enabled: false,
            unix_sockets: unixSockets,
          },
        },
      },
      features: disabledFeatures,
      web_search: "disabled",
      tools: { web_search: false },
      skills: { config: this.skillConfiguration },
      mcp_servers: mcpServers,
    };
  }

  private async startThreadOnCurrentConnection(signal: AbortSignal): Promise<void> {
    const connection = this.connection;
    const taskctlStartResult = this.taskctlStartResult;
    if (connection == null || taskctlStartResult == null) {
      throw new CodexSessionStateError();
    }
    if (this.threadConfigurationChanged) {
      throw new CodexSessionCapabilityError("Codexスレッド構成が変更されたためAIを開始できません。");
    }
    const codexHome = codexHomePathSchema.parse(connection.getCodexHome());
    const config = this.createThreadConfiguration(codexHome, taskctlStartResult);
    const params = {
      model: this.requireSelectedModel(),
      cwd: this.options.workspacePath,
      approvalPolicy: "never",
      permissions: permissionProfileId,
      config,
    };
    const validatedParams = threadStartParamsSchema.parse(params);
    this.permissionProfileNotification = undefined;
    const result = threadStartResultSchema.parse(
      await connection.startThread(validatedParams, signal),
    );
    const hasUnexpectedWorkspaceInstructionSource = result.instructionSources.some(
      (source) => isPathWithin(this.options.workspacePath, source)
        && source !== this.options.agentsFilePath,
    );
    if (
      result.model !== this.requireSelectedModel()
      || result.cwd !== this.options.workspacePath
      || result.approvalPolicy !== "never"
      || !result.instructionSources.includes(this.options.agentsFilePath)
      || hasUnexpectedWorkspaceInstructionSource
      || !hasWorkspaceWriteSandbox(
        result.sandbox,
        this.options.workspacePath,
        this.options.tmpDirectoryPath,
      )
    ) {
      throw new CodexSessionCapabilityError("Codexスレッドの権限制約を確認できません。");
    }
    this.threadId = result.thread.id;
    const activePermissionProfile = await this.waitForPermissionProfile(result.thread.id, signal);
    if (activePermissionProfile !== permissionProfileId) {
      throw new CodexSessionCapabilityError("TaskHub用権限プロファイルが有効化されませんでした。");
    }
    await this.inspectMcpServersAfterThread(connection, result.thread.id, signal);
    await this.inspectExperimentalFeatures(connection, result.thread.id, signal);
    if (this.threadConfigurationChanged) {
      throw new CodexSessionCapabilityError("Codexスレッド構成が変更されたためAIを開始できません。");
    }
  }

  private waitForPermissionProfile(
    threadId: string,
    signal: AbortSignal,
  ): Promise<string> {
    validateAbortSignal(signal);
    const notification = this.permissionProfileNotification;
    if (notification != null && notification.threadId === threadId) {
      if (
        notification.profileId == null
        || notification.profileExtends !== null
        || !notification.sandboxValid
      ) {
        return Promise.reject(
          new CodexSessionCapabilityError("有効な権限プロファイルを確認できません。"),
        );
      }
      return Promise.resolve(notification.profileId);
    }
    return new Promise<string>((resolvePromise, rejectPromise) => {
      const abortListener = (): void => {
        const waiter = this.permissionProfileWaiter;
        if (waiter == null || waiter.threadId !== threadId) {
          return;
        }
        this.clearPermissionProfileWaiter();
        rejectPromise(new CodexSessionAbortedError());
      };
      const timer = setTimeout(() => {
        const waiter = this.permissionProfileWaiter;
        if (waiter == null || waiter.threadId !== threadId) {
          return;
        }
        this.clearPermissionProfileWaiter();
        rejectPromise(new CodexSessionCapabilityError("有効な権限プロファイル通知を受信できません。"));
      }, permissionProfileWaitTimeoutMs);
      this.permissionProfileWaiter = {
        threadId,
        resolve: resolvePromise,
        reject: rejectPromise,
        signal,
        abortListener,
        timer,
      };
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) {
        abortListener();
      }
    });
  }

  private clearPermissionProfileWaiter(): PermissionProfileWaiter | undefined {
    const waiter = this.permissionProfileWaiter;
    if (waiter == null) {
      return undefined;
    }
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.abortListener);
    this.permissionProfileWaiter = undefined;
    return waiter;
  }

  private createStartResult(): CodexSessionStartResult {
    this.assertSafetyIntact();
    const threadId = this.threadId;
    const taskctlStartResult = this.taskctlStartResult;
    if (threadId == null || taskctlStartResult == null) {
      throw new CodexSessionStateError();
    }
    return codexSessionStartResultSchema.parse({
      state: "ready",
      threadId,
      model: this.requireSelectedModel(),
      workspacePath: this.options.workspacePath,
      agentsFilePath: this.options.agentsFilePath,
      taskctlConnectionInfoPath: taskctlStartResult.connectionInfoPath,
      capabilities: {
        authentication: "chatgpt",
        structuredOutput: this.structuredOutputVerified ? "verified" : "unverified",
        instructionSources: true,
        skills: true,
      },
    });
  }

  private requireSelectedModel(): string {
    const model = this.selectedModel;
    if (model == null) {
      throw new CodexSessionStateError();
    }
    return model;
  }

  private createAuthenticationRequiredResult(): CodexSessionStartResult {
    this.assertSafetyIntact();
    const taskctlStartResult = this.taskctlStartResult;
    if (taskctlStartResult == null) {
      throw new CodexSessionStateError();
    }
    return codexSessionStartResultSchema.parse({
      state: "authentication_required",
      workspacePath: this.options.workspacePath,
      agentsFilePath: this.options.agentsFilePath,
      taskctlConnectionInfoPath: taskctlStartResult.connectionInfoPath,
      capabilities: {
        authentication: "required",
        structuredOutput: "unverified",
        instructionSources: false,
        skills: false,
      },
    });
  }

  private receiveNotification(notification: CodexNotification): void {
    const parsed = codexNotificationSchema.safeParse(notification);
    if (!parsed.success) {
      this.recordDiagnostic("connection_protocol_error", parsed.error);
      if (isSafetyCriticalState(this.state)) {
        this.markSafetyViolation(parsed.error);
      } else {
        const active = this.activeTurn;
        if (active != null) {
          this.finishTurn(active, new CodexSessionTurnError(parsed.error));
        }
      }
      return;
    }
    try {
      this.handleNotification(parsed.data);
    } catch (error: unknown) {
      this.recordDiagnostic("connection_protocol_error", error);
      if (isSafetyCriticalState(this.state)) {
        this.markSafetyViolation(error);
      } else {
        const active = this.activeTurn;
        if (active != null) {
          this.finishTurn(active, new CodexSessionTurnError(error));
        }
      }
    }
  }

  private receiveDiagnostic(diagnostic: CodexDiagnostic): void {
    const parsed = codexDiagnosticSchema.safeParse(diagnostic);
    if (!parsed.success) {
      this.recordDiagnostic("connection_protocol_error", parsed.error);
      if (isSafetyCriticalState(this.state)) {
        this.markSafetyViolation(parsed.error);
      }
      return;
    }
    this.handleConnectionDiagnostic(parsed.data);
  }

  private handleConnectionDiagnostic(diagnostic: CodexDiagnostic): void {
    switch (diagnostic.kind) {
      case "unknown_notification":
        this.recordDiagnostic("connection_unknown_notification", undefined);
        break;
      case "server_request_rejected":
        this.recordDiagnostic("connection_server_request_rejected", undefined);
        break;
      case "protocol_error":
        this.recordDiagnostic("connection_protocol_error", undefined);
        if (isSafetyCriticalState(this.state)) {
          this.markSafetyViolation(undefined);
        }
        break;
      case "stderr":
        this.recordDiagnostic("connection_stderr", undefined);
        break;
      case "listener_error":
        this.recordDiagnostic("connection_listener_error", undefined);
        break;
      case "stop_error":
        this.recordDiagnostic("connection_stop_error", undefined);
        break;
      case "process_exit":
        this.recordDiagnostic("connection_process_exit", undefined);
        this.handleProcessExit(diagnostic);
        break;
    }
  }

  private handleProcessExit(diagnostic: Extract<CodexDiagnostic, { kind: "process_exit" }>): void {
    if (
      !this.successfullyStarted
      || (
        this.state !== "ready"
        && this.state !== "turning"
        && this.state !== "authentication_required"
      )
    ) {
      return;
    }
    const active = this.activeTurn;
    if (active != null) {
      this.finishTurn(
        active,
        new CodexProcessExitError(diagnostic.exitCode, diagnostic.signal),
      );
    }
    if (this.restartPromise != null) {
      return;
    }
    if (this.restartCount > 0) {
      void this.disableAi(new CodexProcessExitError(diagnostic.exitCode, diagnostic.signal));
      return;
    }
    const signal = this.lifecycleSignal;
    if (signal == null || signal.aborted) {
      void this.disableAi(new CodexProcessExitError(diagnostic.exitCode, diagnostic.signal));
      return;
    }
    this.restartCount += 1;
    this.restartPromise = this.restartConnection(signal).finally(() => {
      this.restartPromise = undefined;
    });
  }

  private async restartConnection(signal: AbortSignal): Promise<void> {
    this.assertSafetyIntact();
    this.state = "restarting";
    this.recordDiagnostic("restart_started", undefined);
    const cleanupErrors = await this.cleanupConnection();
    for (const cleanupError of cleanupErrors) {
      this.recordDiagnostic("connection_stop_error", cleanupError);
    }
    try {
      await this.connectAndStartThread(signal);
      this.assertSafetyIntact();
      this.state = "ready";
      this.recordDiagnostic("restart_completed", undefined);
    } catch (error: unknown) {
      if (
        error instanceof CodexSessionAuthenticationError
        && this.connection != null
        && !this.safetyViolation
      ) {
        this.state = "authentication_required";
        return;
      }
      await this.disableAi(error);
    }
  }

  private assertSafetyIntact(): void {
    if (this.safetyViolation) {
      throw createSafetyViolationError();
    }
  }

  private markSafetyViolation(cause: unknown): void {
    this.safetyViolation = true;
    void this.disableAi(createSafetyViolationError(cause));
  }

  private disableAi(cause: unknown, activeTurnError?: unknown): Promise<void> {
    if (this.disablePromise != null) {
      return this.disablePromise;
    }
    if (this.state === "stopping" || this.state === "stopped") {
      return Promise.resolve();
    }
    if (this.state === "disabled") {
      return Promise.resolve();
    }
    this.disablePromise = this.disableAiInternal(cause, activeTurnError);
    return this.disablePromise;
  }

  private async disableAiInternal(cause: unknown, activeTurnError?: unknown): Promise<void> {
    this.state = "disabled";
    this.recordDiagnostic("ai_disabled", cause);
    const active = this.activeTurn;
    if (active != null) {
      this.finishTurn(active, activeTurnError ?? new CodexSessionDisabledError(cause));
    }
    const cleanupErrors = await this.cleanupResources();
    for (const cleanupError of cleanupErrors) {
      this.recordDiagnostic("connection_stop_error", cleanupError);
    }
  }

  private handleNotification(notification: CodexNotification): void {
    if (notification.method === "thread/settings/updated") {
      const activeProfile = notification.params.threadSettings.activePermissionProfile;
      const profileId = activeProfile == null ? undefined : activeProfile.id;
      const profileExtends = activeProfile == null ? undefined : activeProfile.extends;
      const sandboxValid = hasWorkspaceWriteSandbox(
        notification.params.threadSettings.sandboxPolicy,
        this.options.workspacePath,
        this.options.tmpDirectoryPath,
      );
      this.permissionProfileNotification = {
        threadId: notification.params.threadId,
        profileId,
        profileExtends,
        sandboxValid,
      };
      const currentThreadId = this.threadId;
      if (
        currentThreadId === notification.params.threadId
        && (this.state === "ready" || this.state === "turning")
        && (profileId !== permissionProfileId || profileExtends !== null || !sandboxValid)
      ) {
        void this.disableAi(
          new CodexSessionCapabilityError("Codexスレッドの権限制約が変更されました。"),
        );
      }
      const waiter = this.permissionProfileWaiter;
      if (waiter != null && waiter.threadId === notification.params.threadId) {
        this.clearPermissionProfileWaiter();
        if (profileId == null || profileExtends !== null || !sandboxValid) {
          waiter.reject(new CodexSessionCapabilityError("有効な権限プロファイルを確認できません。"));
        } else {
          waiter.resolve(profileId);
        }
      }
      return;
    }
    if (notification.method === "skills/changed") {
      this.threadConfigurationChanged = true;
      return;
    }
    const active = this.activeTurn;
    if (active == null) {
      return;
    }
    if (!isTurnNotification(notification)) {
      return;
    }
    const threadId = notificationThreadId(notification);
    if (threadId !== active.threadId) {
      return;
    }
    if (active.phase === "starting") {
      if (active.abortRequested) {
        return;
      }
      if (active.bufferedNotifications.length >= maximumBufferedNotifications) {
        active.abortRequested = true;
        void this.recoverAfterStartingAbort(active, new CodexSessionTurnError());
        return;
      }
      active.bufferedNotifications.push(notification);
      return;
    }
    if (notificationTurnId(notification) !== active.turnId) {
      return;
    }
    this.handleRunningTurnNotification(active, notification);
  }

  private processBufferedNotifications(
    active: ActiveTurnRunning,
    notifications: readonly CodexNotification[],
  ): void {
    for (const notification of notifications) {
      if (this.activeTurn !== active) {
        return;
      }
      if (notificationTurnId(notification) !== active.turnId) {
        continue;
      }
      this.handleRunningTurnNotification(active, notification);
    }
  }

  private handleRunningTurnNotification(
    active: ActiveTurnRunning,
    notification: CodexNotification,
  ): void {
    switch (notification.method) {
      case "turn/started":
        return;
      case "turn/completed":
        active.completion = {
          status: notification.params.turn.status,
          error: notification.params.turn.error,
        };
        this.completeTurnIfReady(active);
        return;
      case "item/completed":
        {
          const finalItem = finalAgentMessageSchema.safeParse(notification.params.item);
          if (finalItem.success) {
            active.finalItem = finalItem.data;
          }
        }
        this.completeTurnIfReady(active);
        return;
      case "item/agentMessage/delta":
        this.emitDelta({
          threadId: notification.params.threadId,
          turnId: notification.params.turnId,
          itemId: notification.params.itemId,
          delta: notification.params.delta,
        });
        return;
      default:
        return;
    }
  }

  private completeTurnIfReady(active: ActiveTurnRunning): void {
    if (this.activeTurn !== active || active.completion == null) {
      return;
    }
    if (active.abortRequested) {
      this.finishTurn(active, new CodexSessionAbortedError());
      return;
    }
    if (active.completion.status !== "completed") {
      this.recordDiagnostic("turn_error", undefined);
      this.finishTurn(active, new CodexSessionTurnError(active.completion.error));
      return;
    }
    const finalItem = active.finalItem;
    if (finalItem == null || finalItem.phase !== "final_answer") {
      const error = new CodexSessionOutputValidationError(
        new Error("最終agentMessageがありません。"),
      );
      this.recordDiagnostic("output_validation_error", error);
      this.finishTurn(active, error);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(finalItem.text);
    } catch (error: unknown) {
      const validationError = new CodexSessionOutputValidationError(error);
      this.recordDiagnostic("output_validation_error", validationError);
      this.finishTurn(active, validationError);
      return;
    }
    const response = codexResponseSchema.safeParse(parsed);
    if (!response.success) {
      const validationError = new CodexSessionOutputValidationError(response.error);
      this.recordDiagnostic("output_validation_error", validationError);
      this.finishTurn(active, validationError);
      return;
    }
    this.structuredOutputVerified = true;
    const result = codexSessionTurnResultSchema.parse({
      threadId: active.threadId,
      turnId: active.turnId,
      response: response.data,
    });
    this.finishTurn(active, result);
  }

  private emitDelta(delta: CodexSessionDelta): void {
    const parsed = codexSessionDeltaSchema.safeParse(delta);
    if (!parsed.success) {
      this.recordDiagnostic("connection_protocol_error", parsed.error);
      return;
    }
    for (const listener of this.deltaListeners) {
      try {
        const result = listener(parsed.data);
        if (result != null) {
          void Promise.resolve(result).catch((error: unknown) => {
            this.recordDiagnostic("listener_error", error);
          });
        }
      } catch (error: unknown) {
        this.recordDiagnostic("listener_error", error);
      }
    }
  }

  private finishTurn(active: ActiveTurn, value: unknown): void {
    if (this.activeTurn !== active) {
      return;
    }
    this.activeTurn = undefined;
    active.signal.removeEventListener("abort", active.abortListener);
    if (this.state === "turning") {
      this.state = "ready";
    }
    if (isSessionTurnResult(value)) {
      active.resolve(value);
      return;
    }
    active.reject(value);
  }

  private async cleanupConnection(): Promise<unknown[]> {
    const errors: unknown[] = [];
    const permissionProfileWaiter = this.clearPermissionProfileWaiter();
    if (permissionProfileWaiter != null) {
      permissionProfileWaiter.reject(new CodexSessionError("Codex接続を停止しました。"));
    }
    const removeNotificationListener = this.removeNotificationListener;
    const removeDiagnosticListener = this.removeDiagnosticListener;
    this.removeNotificationListener = undefined;
    this.removeDiagnosticListener = undefined;
    if (removeNotificationListener != null) {
      try {
        removeNotificationListener();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (removeDiagnosticListener != null) {
      try {
        removeDiagnosticListener();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    const connection = this.connection;
    this.connection = undefined;
    this.threadId = undefined;
    this.permissionProfileNotification = undefined;
    this.mcpServerNames = undefined;
    this.skillConfiguration = [];
    this.threadConfigurationChanged = false;
    this.frozenTaskctlSnapshot = undefined;
    if (connection != null) {
      try {
        await connection.stop();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    return errors;
  }

  private async cleanupResources(): Promise<unknown[]> {
    const errors = await this.cleanupConnection();
    try {
      await this.broker.stop();
    } catch (error: unknown) {
      errors.push(error);
    }
    return errors;
  }

  private recordDiagnostic(
    code: CodexSessionDiagnostic["code"],
    cause: unknown,
  ): void {
    if (this.diagnostics.length >= maximumStoredDiagnostics) {
      this.diagnostics.shift();
    }
    this.diagnostics.push({ code, cause });
  }

}

function isSessionTurnResult(value: unknown): value is CodexSessionTurnResult {
  return codexSessionTurnResultSchema.safeParse(value).success;
}
