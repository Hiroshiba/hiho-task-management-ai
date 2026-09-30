import { isAbsolute } from "node:path";
import { z } from "zod";
import { identifierSchema } from "../domain";
import type { SnapshotHasher } from "../application/common/ports/snapshot-hasher";

const applicationPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "アプリケーションのパスは絶対パスで指定してください。")
  .refine((value) => !value.includes("\0"), "アプリケーションのパスにNUL文字を指定できません。");

const functionSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
  "注入関数が必要です。",
);

const applicationOptionsSchema = z
  .object({
    user_data_path: applicationPathSchema,
    app_version: identifierSchema,
    codex_executable: z.string().min(1).max(4_096),
    read_only_vault_paths: z.array(applicationPathSchema).max(32),
    lifecycle_signal: z.custom<AbortSignal>(
      (value) => value instanceof AbortSignal,
      "アプリケーションのAbortSignalが必要です。",
    ),
    online_provider: functionSchema,
    now_provider: functionSchema,
    create_id: functionSchema,
    snapshot_hasher: z.custom<SnapshotHasher>(
      (value) => typeof value === "object" && value != null
        && "hashBaselineSnapshot" in value && typeof value.hashBaselineSnapshot === "function"
        && "hashGuiEditBaseline" in value && typeof value.hashGuiEditBaseline === "function",
      "スナップショットのハッシュ計算境界が必要です。",
    ),
    open_authorization_url: functionSchema,
    open_codex_authorization_url: functionSchema,
    open_obsidian_url: functionSchema,
    open_path: functionSchema,
    diagnostic: functionSchema,
    unhandled_error_forwarder: functionSchema,
    open_external_agent_review: functionSchema,
  })
  .strict();

export type ApplicationOptions = z.infer<typeof applicationOptionsSchema> & {
  readonly online_provider: () => boolean;
  readonly now_provider: () => Date;
  readonly create_id: () => string;
  readonly open_authorization_url: (
    authorizationUrl: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly open_codex_authorization_url: (
    authorizationUrl: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly open_obsidian_url: (
    obsidianUrl: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly open_path: (
    absolutePath: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly diagnostic: (
    error: unknown,
    channel: string,
    diagnostic: { readonly kind: "service"; readonly severity: "warning" | "error" },
  ) => void;
  readonly unhandled_error_forwarder: (error: unknown) => void;
  readonly open_external_agent_review: () => Promise<void> | void;
};

/** アプリケーションの組み立て入力を検証するスキーマです。 */
export const applicationOptionsSchemaExport = applicationOptionsSchema;
