import { z } from "zod";
import { isAbsolute } from "node:path";
import { codexConnectionOptionsSchema, type CodexConnectionOptions, type CodexDiagnostic, type CodexNotification, type DynamicToolCallParams, type DynamicToolCallResponse } from "../codex-app-server";
import {
  resolveExistingDirectory,
  resolveVerifiedConfigurationDirectory,
} from "./capability-policy";
import {
  CodexSessionAuthenticationError,
  CodexSessionCapabilityError,
  CodexSessionStateError,
} from "./errors";

const codexHomePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "Codex認証領域のパスは絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "Codex認証領域のパスが不正です。");

type ConnectionPort = {
  start(signal: AbortSignal): Promise<void>;
  getCodexHome(): string;
  onNotification(listener: (notification: CodexNotification) => void): () => void;
  onDiagnostic(listener: (diagnostic: CodexDiagnostic) => void): () => void;
  onDynamicToolCall(handler: (params: DynamicToolCallParams, signal: AbortSignal) => Promise<DynamicToolCallResponse>): () => void;
};

type ConnectionStartOptions<Connection extends ConnectionPort> = {
  readonly expectedCodexHomePathProvider: () => string;
  readonly hasTaskctlStartResult: () => boolean;
  readonly createConnectionOverrides: (expectedCodexHomePath: string) => CodexConnectionOptions["configOverrides"];
  readonly connectionFactory: (overrides: CodexConnectionOptions["configOverrides"]) => Connection | PromiseLike<Connection>;
  readonly clearStructuredOutputVerified: () => void;
  readonly setConnection: (connection: Connection) => void;
  readonly setRemoveNotificationListener: (remove: () => void) => void;
  readonly setRemoveDiagnosticListener: (remove: () => void) => void;
  readonly setRemoveDynamicToolListener: (remove: () => void) => void;
  readonly receiveNotification: (notification: CodexNotification) => void;
  readonly receiveDiagnostic: (diagnostic: CodexDiagnostic) => void;
  readonly handleDynamicTool: (params: DynamicToolCallParams, signal: AbortSignal) => Promise<DynamicToolCallResponse>;
  readonly clearConnectionConfigurationChanged: () => void;
  readonly inspectAccount: (connection: Connection, signal: AbortSignal) => Promise<{ kind: string }>;
  readonly inspectModel: (connection: Connection, signal: AbortSignal) => Promise<void>;
  readonly inspectSkills: (connection: Connection, signal: AbortSignal) => Promise<void>;
  readonly inspectPermissionProfile: (connection: Connection, signal: AbortSignal) => Promise<void>;
  readonly startThreadOnCurrentConnection: (signal: AbortSignal) => Promise<void>;
  readonly assertSafetyIntact: () => void;
  readonly isSafetyViolation: () => boolean;
  readonly setAuthenticationRequired: () => void;
  readonly cleanupConnection: () => Promise<unknown[]>;
  readonly createSafetyViolationError: (error: unknown) => unknown;
};

/** Codexセッション接続の必須操作を検証します。 */
export function isCodexSessionConnectionShape(value: unknown): boolean {
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
    "getCodexHome",
    "startThread",
    "startTurn",
    "interruptTurn",
    "onNotification",
    "onDiagnostic",
    "onDynamicToolCall",
    "getDiagnostics",
    "stop",
  ];
  return functionNames.every((name) => typeof Reflect.get(value, name) === "function");
}

/** Codexセッション向けの接続設定を検証して接続ファクトリを作成します。 */
export function createCodexSessionConnectionFactory<Connection>(
  options: CodexConnectionOptions,
  createConnection: (options: CodexConnectionOptions) => Connection,
): (overrides: CodexConnectionOptions["configOverrides"]) => Connection {
  const validatedOptions = codexConnectionOptionsSchema.parse(options);
  if (validatedOptions.configOverrides.length !== 0) {
    throw new CodexSessionCapabilityError(
      "Codex接続ファクトリの初期設定へ設定上書きを指定できません。",
    );
  }
  if (validatedOptions.capabilities?.experimentalApi !== true) {
    throw new CodexSessionCapabilityError(
      "Codexの実験APIが有効でないため権限プロファイルを利用できません。",
    );
  }
  return (configOverrides): Connection => {
    const connectionOptions = codexConnectionOptionsSchema.parse({
      ...validatedOptions,
      configOverrides,
    });
    return createConnection(connectionOptions);
  };
}

/** Codex接続を開始して認証領域と能力を検証し、スレッドを開始します。 */
export async function connectAndStartCodexSession<Connection extends ConnectionPort>(
  options: ConnectionStartOptions<Connection>,
  signal: AbortSignal,
): Promise<void> {
  options.assertSafetyIntact();
  try {
    const expectedCodexHomePath = codexHomePathSchema.parse(
      options.expectedCodexHomePathProvider(),
    );
    const taskctlStartResult = options.hasTaskctlStartResult();
    if (!taskctlStartResult) {
      throw new CodexSessionStateError();
    }
    const configOverrides = options.createConnectionOverrides(expectedCodexHomePath);
    const candidate = await Promise.resolve(options.connectionFactory(configOverrides));
    if (!isCodexSessionConnectionShape(candidate)) {
      throw new CodexSessionCapabilityError("Codex接続ファクトリが不正な接続を返しました。");
    }
    options.clearStructuredOutputVerified();
    options.setConnection(candidate);
    options.setRemoveNotificationListener(candidate.onNotification(options.receiveNotification));
    options.setRemoveDiagnosticListener(candidate.onDiagnostic(options.receiveDiagnostic));
    options.setRemoveDynamicToolListener(candidate.onDynamicToolCall(options.handleDynamicTool));
    await candidate.start(signal);
    options.assertSafetyIntact();
    const expectedCodexHomeRealPath = resolveVerifiedConfigurationDirectory(
      expectedCodexHomePath,
      "期待するCodex認証領域",
    );
    const initializedCodexHomePath = resolveExistingDirectory(
      candidate.getCodexHome(),
      "Codex認証領域",
    );
    if (initializedCodexHomePath !== expectedCodexHomeRealPath) {
      throw new CodexSessionCapabilityError(
        "Codex認証領域が期待するパスと一致しません。",
      );
    }
    options.clearConnectionConfigurationChanged();
    const accountInspection = await options.inspectAccount(candidate, signal);
    if (accountInspection.kind !== "authenticated") {
      throw new CodexSessionAuthenticationError();
    }
    options.assertSafetyIntact();
    await options.inspectModel(candidate, signal);
    options.assertSafetyIntact();
    await options.inspectSkills(candidate, signal);
    options.assertSafetyIntact();
    if (process.platform !== "win32") {
      await options.inspectPermissionProfile(candidate, signal);
    }
    options.assertSafetyIntact();
    await options.startThreadOnCurrentConnection(signal);
    options.assertSafetyIntact();
  } catch (error: unknown) {
    if (error instanceof CodexSessionAuthenticationError && !options.isSafetyViolation()) {
      options.setAuthenticationRequired();
      throw error;
    }
    const cleanupErrors = await options.cleanupConnection();
    if (options.isSafetyViolation()) {
      throw new AggregateError(
        [options.createSafetyViolationError(error), ...cleanupErrors],
        "Codex接続の安全性検証と後処理に失敗しました。",
        { cause: error },
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Codex接続の開始と後処理に失敗しました。",
        { cause: error },
      );
    }
    throw error;
  }
}
