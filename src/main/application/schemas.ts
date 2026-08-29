import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  deviceSettingsSchema,
  type DeviceSettings,
} from "../../shared/storage";
import {
  setupStateSchema,
  type SetupState,
} from "../../shared/setup";
import { identifierSchema } from "../../shared/domain";

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

const applicationStateSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("unconfigured"),
      setup_state: setupStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("configured"),
      setup_state: setupStateSchema,
      settings: deviceSettingsSchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.setup_state.kind !== "ready") {
        context.addIssue({
          code: "custom",
          path: ["setup_state"],
          message: "設定済み状態にはready状態が必要です。",
        });
      }
      if (value.setup_state.kind === "ready") {
        const stateContext = value.setup_state.context;
        if (
          value.settings.device_id !== stateContext.device_id
          || value.settings.client_id !== stateContext.client_id
          || value.settings.workspace_gid !== stateContext.workspace_gid
          || value.settings.project_gid !== stateContext.project_gid
          || value.settings.section_gids.not_started !== stateContext.section_gids.not_started
          || value.settings.section_gids.in_progress !== stateContext.section_gids.in_progress
          || value.settings.section_gids.completed !== stateContext.section_gids.completed
          || value.settings.section_gids.withdrawn !== stateContext.section_gids.withdrawn
        ) {
          context.addIssue({
            code: "custom",
            path: ["settings"],
            message: "端末設定と初回設定状態が一致しません。",
          });
        }
      }
    }),
]);

const applicationOptionsSchema = z
  .object({
    user_data_path: applicationPathSchema,
    database_path: applicationPathSchema,
    secret_storage_path: applicationPathSchema,
    checkpoint_path: applicationPathSchema,
    app_version: identifierSchema,
    codex_executable: z.string().min(1).max(4_096),
    read_only_vault_paths: z.array(applicationPathSchema).max(32),
    lifecycle_signal: z.custom<AbortSignal>(
      (value) => value instanceof AbortSignal,
      "アプリケーションのAbortSignalが必要です。",
    ),
    online_provider: functionSchema,
    now_provider: functionSchema,
    open_authorization_url: functionSchema,
    open_codex_authorization_url: functionSchema,
    open_path: functionSchema,
    notify_unexpected_error: functionSchema,
    diagnostic: functionSchema,
  })
  .strict();

export type ApplicationState = z.infer<typeof applicationStateSchema>;
export type ApplicationOptions = z.infer<typeof applicationOptionsSchema> & {
  readonly online_provider: () => boolean;
  readonly now_provider: () => Date;
  readonly open_authorization_url: (
    authorizationUrl: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly open_codex_authorization_url: (
    authorizationUrl: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly open_path: (
    absolutePath: string,
    signal: AbortSignal,
  ) => Promise<void> | void;
  readonly notify_unexpected_error: (error: unknown) => void;
  readonly diagnostic: (error: unknown, channel: string) => void;
};

/** アプリケーションの状態を検証するスキーマです。 */
export const applicationStateSchemaExport = applicationStateSchema;

/** アプリケーションの組み立て入力を検証するスキーマです。 */
export const applicationOptionsSchemaExport = applicationOptionsSchema;

export type { DeviceSettings, SetupState };
