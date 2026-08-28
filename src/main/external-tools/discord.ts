import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  gidSchema,
} from "../../shared/domain";
import type { SecretStorage } from "../auth/secret-storage";
import { ExternalToolError } from "./errors";
import {
  discordChannelIdSchema,
  externalToolDefinitionSchema,
  externalToolInvocationSchema,
  externalToolOutputSchema,
  externalToolStatusEvidenceSchema,
  type DiscordCredentialProviderPort,
  type ExternalToolDefinition,
  type ExternalToolInvocation,
  type ExternalToolOutput,
  type ExternalToolStatusEvidence,
} from "./schemas";

const discordOrigin = "https://discord.com";
const discordApiPrefix = "/api/v10";
const discordToolId = "discord-context";
const contextctlExecutable = "contextctl";
const maximumDiscordMessagesPerRequest = 100;
const defaultSearchResultLimit = 25;
const defaultThreadResultLimit = 100;
const maximumSearchQueryBytes = 1_024;
const maximumDiscordContentCharacters = 16_000;
const discordThreadTypes = new Set([10, 11, 12]);

/** SecretStorage内で使う固定Discord資格情報名です。 */
export const discordExternalToolCredentialReferenceName = "discord_bot_token";

const discordSnowflakeSchema = z
  .string()
  .regex(/^[1-9][0-9]{16,19}$/u, "Discord IDが不正です。");

const discordBotTokenSchema = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[A-Za-z0-9._-]+$/u, "Discord Bot Tokenの形式が不正です。");

const discordLimitSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,2}$/u, "Discord取得件数が不正です。")
  .transform((value) => Number(value))
  .pipe(z.number().int().min(1).max(maximumDiscordMessagesPerRequest));

const discordSearchQuerySchema = createUtf8ByteLimitedStringSchema(
  maximumSearchQueryBytes,
)
  .min(1)
  .refine((value) => value.trim().length > 0, "Discord検索文字列を空白だけにできません。")
  .transform((value) => value.trim());

const discordAuthorSchema = z.object({
  id: discordSnowflakeSchema,
  username: z.string().min(1).max(256),
  global_name: z.string().max(256).nullable().optional(),
});

const discordMessageSchema = z.object({
  id: discordSnowflakeSchema,
  channel_id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  content: z.string().max(maximumDiscordContentCharacters),
  timestamp: z.string().min(1).max(64),
  edited_timestamp: z.string().min(1).max(64).nullable().optional(),
  author: discordAuthorSchema,
});

const discordMessagesSchema = z
  .array(discordMessageSchema)
  .max(maximumDiscordMessagesPerRequest);

const discordThreadSchema = z.object({
  id: discordSnowflakeSchema,
  guild_id: discordSnowflakeSchema.optional(),
  parent_id: discordChannelIdSchema.nullable(),
  type: z.number().int(),
});

type DiscordMessage = z.infer<typeof discordMessageSchema>;
type DiscordThread = z.infer<typeof discordThreadSchema>;

type DiscordInvocation =
  | {
    readonly kind: "search";
    readonly channel_id: string | undefined;
    readonly query: string;
    readonly limit: number;
    readonly target_task_gid: string | undefined;
  }
  | {
    readonly kind: "thread";
    readonly thread_id: string;
    readonly limit: number;
    readonly target_task_gid: string | undefined;
  }
  | {
    readonly kind: "message";
    readonly channel_id: string;
    readonly message_id: string;
    readonly target_task_gid: string | undefined;
  };

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function createAbortError(signal: AbortSignal): ExternalToolError {
  try {
    signal.throwIfAborted();
  } catch (error) {
    return new ExternalToolError(
      "aborted",
      "Discord読み取り要求が中断されました。",
      false,
      error,
    );
  }
  throw new Error("中断済みAbortSignalの理由を取得できません。");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw createAbortError(signal);
  }
}

function parseArgument<T>(raw: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(raw);
  } catch (error) {
    throw new ExternalToolError(
      "invalid_request",
      "Discord読み取り引数が不正です。",
      false,
      error,
    );
  }
}

function parseArgumentMap(
  args: readonly string[],
  allowedNames: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  if (args.length % 2 !== 0) {
    throw new ExternalToolError(
      "invalid_request",
      "Discord読み取り引数は名前と値の組で指定してください。",
      false,
    );
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name == null || value == null) {
      throw new Error("Discord読み取り引数の位置が不正です。");
    }
    if (!allowedNames.has(name)) {
      throw new ExternalToolError(
        "invalid_request",
        "このDiscord読み取り操作で許可されていない引数です。",
        false,
      );
    }
    if (values.has(name)) {
      throw new ExternalToolError(
        "invalid_request",
        "同じDiscord読み取り引数を重複指定できません。",
        false,
      );
    }
    values.set(name, value);
  }
  return values;
}

function requireArgument<T>(
  values: ReadonlyMap<string, string>,
  name: string,
  schema: z.ZodType<T>,
): T {
  const raw = values.get(name);
  if (raw == null) {
    throw new ExternalToolError(
      "invalid_request",
      "Discord読み取りに必要な引数がありません。",
      false,
    );
  }
  return parseArgument(raw, schema);
}

function optionalArgument<T>(
  values: ReadonlyMap<string, string>,
  name: string,
  schema: z.ZodType<T>,
): T | undefined {
  const raw = values.get(name);
  if (raw == null) {
    return undefined;
  }
  return parseArgument(raw, schema);
}

function parseSearchInvocation(args: readonly string[]): DiscordInvocation {
  const values = parseArgumentMap(
    args,
    new Set(["--channel-id", "--limit", "--query", "--target-task-gid"]),
  );
  return {
    kind: "search",
    channel_id: optionalArgument(values, "--channel-id", discordChannelIdSchema),
    query: requireArgument(values, "--query", discordSearchQuerySchema),
    limit: optionalArgument(values, "--limit", discordLimitSchema)
      ?? defaultSearchResultLimit,
    target_task_gid: optionalArgument(values, "--target-task-gid", gidSchema),
  };
}

function parseThreadInvocation(args: readonly string[]): DiscordInvocation {
  const values = parseArgumentMap(
    args,
    new Set(["--limit", "--target-task-gid", "--thread-id"]),
  );
  return {
    kind: "thread",
    thread_id: requireArgument(values, "--thread-id", discordSnowflakeSchema),
    limit: optionalArgument(values, "--limit", discordLimitSchema)
      ?? defaultThreadResultLimit,
    target_task_gid: optionalArgument(values, "--target-task-gid", gidSchema),
  };
}

function parseMessageInvocation(args: readonly string[]): DiscordInvocation {
  const values = parseArgumentMap(
    args,
    new Set(["--channel-id", "--message-id", "--target-task-gid"]),
  );
  return {
    kind: "message",
    channel_id: requireArgument(values, "--channel-id", discordChannelIdSchema),
    message_id: requireArgument(values, "--message-id", discordSnowflakeSchema),
    target_task_gid: optionalArgument(values, "--target-task-gid", gidSchema),
  };
}

function parseDiscordInvocation(invocation: ExternalToolInvocation): DiscordInvocation {
  switch (invocation.subcommand) {
    case "search":
      return parseSearchInvocation(invocation.args);
    case "thread":
      return parseThreadInvocation(invocation.args);
    case "message":
      return parseMessageInvocation(invocation.args);
    default:
      throw new ExternalToolError(
        "forbidden_subcommand",
        "許可されていないDiscord読み取り操作です。",
        false,
      );
  }
}

function readBotToken(credentialProvider: DiscordCredentialProviderPort): string {
  try {
    return discordBotTokenSchema.parse(credentialProvider.getBotToken());
  } catch (error) {
    if (error instanceof ExternalToolError) {
      throw error;
    }
    throw new ExternalToolError(
      "credential_unavailable",
      "Discord資格情報を利用できません。",
      false,
      error,
    );
  }
}

function requireAllowedChannel(
  tool: ExternalToolDefinition,
  channelId: string,
): void {
  if (!tool.allowed_channel_ids.includes(channelId)) {
    throw new ExternalToolError(
      "forbidden_network",
      "許可されていないDiscordチャンネルです。",
      false,
    );
  }
}

function createDiscordApiUrl(
  path: string,
  searchParameters: Readonly<Record<string, string>>,
): URL {
  if (!path.startsWith("/") || path.includes("..")) {
    throw new Error("Discord APIパスが不正です。");
  }
  const url = new URL(`${discordApiPrefix}${path}`, discordOrigin);
  for (const [name, value] of Object.entries(searchParameters)) {
    url.searchParams.set(name, value);
  }
  if (url.origin !== discordOrigin || url.protocol !== "https:") {
    throw new Error("Discord APIの接続先が不正です。");
  }
  return url;
}

function assertDiscordResponseUrl(response: Response, requestUrl: URL): void {
  let responseUrl: URL;
  try {
    responseUrl = new URL(response.url);
  } catch (error) {
    throw new ExternalToolError(
      "forbidden_network",
      "Discord API応答の接続先を検証できません。",
      false,
      error,
    );
  }
  if (responseUrl.href !== requestUrl.href || responseUrl.origin !== discordOrigin) {
    throw new ExternalToolError(
      "forbidden_network",
      "Discord APIのリダイレクトは許可されていません。",
      false,
    );
  }
}

function throwForDiscordStatus(response: Response): void {
  if (response.ok) {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new ExternalToolError(
      "credential_unavailable",
      "Discord資格情報を利用できません。",
      false,
    );
  }
  if (response.status === 429 || response.status >= 500) {
    throw new ExternalToolError(
      "tool_execution_failed",
      "Discord APIの読み取りに一時的に失敗しました。",
      true,
    );
  }
  throw new ExternalToolError(
    "tool_execution_failed",
    "Discord APIの読み取りに失敗しました。",
    false,
  );
}

async function cancelOversizedResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limitError: ExternalToolError,
): Promise<never> {
  try {
    await reader.cancel();
  } catch (error) {
    throw new ExternalToolError(
      "output_too_large",
      "Discord API応答がサイズ上限を超え、受信停止にも失敗しました。",
      false,
      new AggregateError(
        [limitError, error],
        "Discord API応答の受信停止に失敗しました。",
        { cause: limitError },
      ),
    );
  }
  throw limitError;
}

async function readResponseBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength != null) {
    if (!/^[0-9]+$/u.test(contentLength)) {
      throw new ExternalToolError(
        "invalid_output",
        "Discord API応答のContent-Lengthが不正です。",
        false,
      );
    }
    if (Number(contentLength) > maximumBytes) {
      throw new ExternalToolError(
        "output_too_large",
        "Discord API応答がサイズ上限を超えました。",
        false,
      );
    }
  }
  if (response.body == null) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord API応答の本文がありません。",
      false,
    );
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    throwIfAborted(signal);
    const chunk = await reader.read();
    if (chunk.done) {
      return Buffer.concat(chunks, totalBytes);
    }
    totalBytes += chunk.value.byteLength;
    if (totalBytes > maximumBytes) {
      return cancelOversizedResponse(
        reader,
        new ExternalToolError(
          "output_too_large",
          "Discord API応答がサイズ上限を超えました。",
          false,
        ),
      );
    }
    chunks.push(Buffer.from(chunk.value));
  }
}

function parseResponseJson(bytes: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ExternalToolError(
      "invalid_utf8",
      "Discord API応答をUTF-8として読み取れません。",
      false,
      error,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord API応答のJSONが不正です。",
      false,
      error,
    );
  }
}

async function requestDiscordJson(
  url: URL,
  botToken: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        accept: "application/json",
        authorization: `Bot ${botToken}`,
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw createAbortError(signal);
    }
    throw new ExternalToolError(
      "tool_execution_failed",
      "Discord APIへ接続できません。",
      true,
      error,
    );
  }
  assertDiscordResponseUrl(response, url);
  throwForDiscordStatus(response);
  let bytes: Buffer;
  try {
    bytes = await readResponseBytes(response, maximumBytes, signal);
  } catch (error) {
    if (error instanceof ExternalToolError) {
      throw error;
    }
    if (signal.aborted) {
      throw createAbortError(signal);
    }
    throw new ExternalToolError(
      "tool_execution_failed",
      "Discord API応答を受信できません。",
      true,
      error,
    );
  }
  return parseResponseJson(bytes);
}

function parseDiscordResponse<T>(value: unknown, schema: z.ZodType<T>): T {
  try {
    return schema.parse(value);
  } catch (error) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord API応答の形式が不正です。",
      false,
      error,
    );
  }
}

async function readDiscordMessage(
  channelId: string,
  messageId: string,
  botToken: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<DiscordMessage> {
  const value = await requestDiscordJson(
    createDiscordApiUrl(
      `/channels/${channelId}/messages/${messageId}`,
      {},
    ),
    botToken,
    maximumBytes,
    signal,
  );
  const message = parseDiscordResponse(value, discordMessageSchema);
  if (message.channel_id !== channelId || message.id !== messageId) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord API応答のメッセージIDが要求と一致しません。",
      false,
    );
  }
  return message;
}

async function readDiscordMessages(
  channelId: string,
  limit: number,
  botToken: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<readonly DiscordMessage[]> {
  const value = await requestDiscordJson(
    createDiscordApiUrl(
      `/channels/${channelId}/messages`,
      { limit: String(limit) },
    ),
    botToken,
    maximumBytes,
    signal,
  );
  const messages = parseDiscordResponse(value, discordMessagesSchema);
  if (messages.some((message) => message.channel_id !== channelId)) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord API応答に要求外チャンネルのメッセージがあります。",
      false,
    );
  }
  return messages;
}

async function readDiscordThread(
  threadId: string,
  botToken: string,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<DiscordThread> {
  const value = await requestDiscordJson(
    createDiscordApiUrl(`/channels/${threadId}`, {}),
    botToken,
    maximumBytes,
    signal,
  );
  const thread = parseDiscordResponse(value, discordThreadSchema);
  if (thread.id !== threadId || !discordThreadTypes.has(thread.type)) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord API応答は要求したスレッドではありません。",
      false,
    );
  }
  return thread;
}

function sanitizeDiscordText(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0);
      if (codePoint == null) {
        throw new Error("Discord文字列を検証できません。");
      }
      return codePoint > 31 && (codePoint < 127 || codePoint > 159);
    })
    .join("");
}

function detectExplicitStatus(
  content: string,
  targetTaskGid: string | undefined,
): ExternalToolStatusEvidence["status"] | undefined {
  if (targetTaskGid == null) {
    return undefined;
  }
  const statuses: ExternalToolStatusEvidence["status"][] = [];
  for (const line of content.split(/\r?\n/u)) {
    const match = /^TaskHub status task:([1-9][0-9]*) (completed|closed|cancelled)$/u
      .exec(line);
    if (match == null || match[1] !== targetTaskGid) {
      continue;
    }
    const status = externalToolStatusEvidenceSchema.shape.status.safeParse(match[2]);
    if (status.success) {
      statuses.push(status.data);
    }
  }
  return statuses.length === 1 ? statuses[0] : undefined;
}

function createMessageLocator(
  message: DiscordMessage,
  guildId: string | undefined,
): string {
  const guildSegment = message.guild_id ?? guildId ?? "@me";
  return `${discordOrigin}/channels/${guildSegment}/${message.channel_id}/${message.id}`;
}

function normalizeMessage(
  message: DiscordMessage,
  guildId: string | undefined,
  targetTaskGid: string | undefined,
): Record<string, string> {
  const content = sanitizeDiscordText(message.content);
  const baseRecord = {
    source: "discord",
    locator: createMessageLocator(message, guildId),
    channel_id: message.channel_id,
    message_id: message.id,
    author_id: message.author.id,
    author_name: sanitizeDiscordText(
      message.author.global_name ?? message.author.username,
    ),
    timestamp: message.timestamp,
    content,
  };
  const status = detectExplicitStatus(message.content, targetTaskGid);
  if (status == null || targetTaskGid == null) {
    return baseRecord;
  }
  return {
    ...baseRecord,
    target_task_gid: targetTaskGid,
    status,
  };
}

function createJsonOutput(value: unknown, maximumBytes: number): ExternalToolOutput {
  const serialized = JSON.stringify(value);
  if (serialized == null) {
    throw new ExternalToolError(
      "invalid_output",
      "Discord読み取り結果をJSON化できません。",
      false,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new ExternalToolError(
      "output_too_large",
      "Discord読み取り結果がサイズ上限を超えました。",
      false,
    );
  }
  return externalToolOutputSchema.parse({ format: "json", value });
}

async function executeSearch(
  tool: ExternalToolDefinition,
  invocation: Extract<DiscordInvocation, { readonly kind: "search" }>,
  botToken: string,
  signal: AbortSignal,
): Promise<ExternalToolOutput> {
  const channelIds = invocation.channel_id == null
    ? tool.allowed_channel_ids
    : [invocation.channel_id];
  if (invocation.channel_id != null) {
    requireAllowedChannel(tool, invocation.channel_id);
  }
  const normalizedQuery = invocation.query.toLowerCase();
  const records: Array<Record<string, string>> = [];
  for (const channelId of channelIds) {
    throwIfAborted(signal);
    const messages = await readDiscordMessages(
      channelId,
      maximumDiscordMessagesPerRequest,
      botToken,
      tool.max_output_bytes,
      signal,
    );
    for (const message of messages) {
      if (!message.content.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      records.push(normalizeMessage(message, undefined, invocation.target_task_gid));
      if (records.length >= invocation.limit) {
        return createJsonOutput(records, tool.max_output_bytes);
      }
    }
  }
  return createJsonOutput(records, tool.max_output_bytes);
}

async function executeThread(
  tool: ExternalToolDefinition,
  invocation: Extract<DiscordInvocation, { readonly kind: "thread" }>,
  botToken: string,
  signal: AbortSignal,
): Promise<ExternalToolOutput> {
  const thread = await readDiscordThread(
    invocation.thread_id,
    botToken,
    tool.max_output_bytes,
    signal,
  );
  if (thread.parent_id == null) {
    throw new ExternalToolError(
      "forbidden_network",
      "親チャンネルを確認できないDiscordスレッドは読み取れません。",
      false,
    );
  }
  requireAllowedChannel(tool, thread.parent_id);
  const messages = await readDiscordMessages(
    thread.id,
    invocation.limit,
    botToken,
    tool.max_output_bytes,
    signal,
  );
  return createJsonOutput(
    messages.map((message) =>
      normalizeMessage(message, thread.guild_id, invocation.target_task_gid)),
    tool.max_output_bytes,
  );
}

async function executeMessage(
  tool: ExternalToolDefinition,
  invocation: Extract<DiscordInvocation, { readonly kind: "message" }>,
  botToken: string,
  signal: AbortSignal,
): Promise<ExternalToolOutput> {
  requireAllowedChannel(tool, invocation.channel_id);
  const message = await readDiscordMessage(
    invocation.channel_id,
    invocation.message_id,
    botToken,
    tool.max_output_bytes,
    signal,
  );
  return createJsonOutput(
    normalizeMessage(message, undefined, invocation.target_task_gid),
    tool.max_output_bytes,
  );
}

/** 固定Discord読み取りツール定義を作成します。 */
export function createDiscordExternalToolDefinition(
  allowedChannelIds: readonly string[],
): ExternalToolDefinition {
  return externalToolDefinitionSchema.parse({
    adapter: "discord",
    tool_id: discordToolId,
    executable: contextctlExecutable,
    allowed_subcommands: ["search", "thread", "message"],
    timeout_ms: 30_000,
    max_output_bytes: 1_048_576,
    read_only: true,
    allowed_argument_names: [
      "--channel-id",
      "--limit",
      "--message-id",
      "--query",
      "--target-task-gid",
      "--thread-id",
    ],
    allowed_domains: ["discord.com"],
    allowed_http_methods: ["GET"],
    allowed_channel_ids: [...allowedChannelIds].sort(compareStrings),
  });
}

/** SecretStorage内のDiscord資格情報だけをadapterへ提供します。 */
export class SecretStorageDiscordCredentialProvider implements DiscordCredentialProviderPort {
  public constructor(private readonly secretStorage: SecretStorage) {}

  /** Discord Bot Tokenの保存有無だけを返します。 */
  public hasBotToken(): boolean {
    return this.secretStorage.load()?.discord_bot_token != null;
  }

  /** 保存済みDiscord Bot Tokenを固定adapterへ提供します。 */
  public getBotToken(): string {
    const token = this.secretStorage.load()?.discord_bot_token;
    if (token == null) {
      throw new ExternalToolError(
        "credential_unavailable",
        "Discord資格情報を利用できません。",
        false,
      );
    }
    return token;
  }
}

/** 固定Discord adapterで読み取り操作を実行します。 */
export async function executeDiscordReadInvocation(
  tool: ExternalToolDefinition,
  invocation: ExternalToolInvocation,
  credentialProvider: DiscordCredentialProviderPort,
  signal: AbortSignal,
): Promise<ExternalToolOutput> {
  validateAbortSignal(signal);
  throwIfAborted(signal);
  const validatedTool = externalToolDefinitionSchema.parse(tool);
  const validatedInvocation = externalToolInvocationSchema.parse(invocation);
  const discordInvocation = parseDiscordInvocation(validatedInvocation);
  const botToken = readBotToken(credentialProvider);
  switch (discordInvocation.kind) {
    case "search":
      return executeSearch(validatedTool, discordInvocation, botToken, signal);
    case "thread":
      return executeThread(validatedTool, discordInvocation, botToken, signal);
    case "message":
      return executeMessage(validatedTool, discordInvocation, botToken, signal);
  }
}
