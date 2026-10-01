import { z } from "zod";
import type { SetupState } from "../../domain/setup-state";
import type { PersistentTextFile } from "./persistent-text-file";
import {
  checkpointV2Schema,
  checkpointV2StateSchema,
  type CheckpointV2State,
} from "./setup-checkpoint-v2-schema";

const checkpointVersion = 3;
const legacyCheckpointVersion = 1;
const checkpointSchema = z
  .object({
    version: z.literal(checkpointVersion),
    state: z.unknown(),
  })
  .strict();

const legacyRedirectUriSchema = z
  .string()
  .url()
  .max(2_048)
  .refine(
    (value) => !hasControlCharacter(value),
    "リダイレクトURIに制御文字を含めることはできません。",
  );

const legacySetupContextSchema = z
  .object({
    redirect_uri: legacyRedirectUriSchema.optional(),
  })
  .passthrough();

const legacySetupStateSchema = z
  .object({
    kind: z.string(),
    step: z.string(),
    redirect_uri: legacyRedirectUriSchema.optional(),
    client_id: z.unknown().optional(),
    authorization_id: z.unknown().optional(),
    expires_at: z.unknown().optional(),
    codex: z.unknown().optional(),
    workspaces: z.unknown().optional(),
    workspace: z.unknown().optional(),
    projects: z.unknown().optional(),
    reason_code: z.unknown().optional(),
    project: z.unknown().optional(),
    issues: z.unknown().optional(),
    context: legacySetupContextSchema.optional(),
    test_task_gid: z.unknown().optional(),
    external_tool: z.unknown().optional(),
    tool_id: z.unknown().optional(),
    allowed_channel_ids: z.unknown().optional(),
    vault_id: z.unknown().optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const contextStateKinds = new Set([
      "resources_ready",
      "asana_capability_failed",
      "vault_choice_required",
      "vault_skipped",
      "vault_configured",
      "external_tool_skipped",
      "external_tool_configured",
      "external_tool_unavailable",
      "full_sync_required",
      "codex_capability_required",
      "ready",
    ]);
    if (contextStateKinds.has(state.kind)) {
      if (state.context == null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["context"],
          message: "旧初回設定状態の文脈がありません。",
        });
      } else if (state.context.redirect_uri == null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["context", "redirect_uri"],
          message: "旧初回設定状態の文脈にリダイレクトURIがありません。",
        });
      }
      if (state.redirect_uri != null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["redirect_uri"],
          message: "旧初回設定状態のリダイレクトURIの位置が不正です。",
        });
      }
      return;
    }
    if (state.context != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["context"],
        message: "旧初回設定状態の文脈の位置が不正です。",
      });
    }
    if (state.redirect_uri == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redirect_uri"],
        message: "旧初回設定状態のリダイレクトURIがありません。",
      });
    }
  });

const legacyCheckpointSchema = z
  .object({
    version: z.literal(legacyCheckpointVersion),
    state: legacySetupStateSchema,
  })
  .strict();

const checkpointVersionEnvelopeSchema = z
  .object({ version: z.unknown() })
  .passthrough();

type LegacySetupState = z.infer<typeof legacySetupStateSchema>;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint == null) {
      throw new Error("文字列を検証できません。");
    }
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function migrateLegacyState(
  state: LegacySetupState,
): unknown {
  if (state.kind === "asana_authorization_pending") {
    throw new Error("OAuth認可待機中の旧初回設定状態は移行できません。");
  }
  const stateWithoutRedirectUri = { ...state };
  delete stateWithoutRedirectUri.redirect_uri;
  if (stateWithoutRedirectUri.context != null) {
    const contextWithoutRedirectUri = { ...stateWithoutRedirectUri.context };
    delete contextWithoutRedirectUri.redirect_uri;
    stateWithoutRedirectUri.context = contextWithoutRedirectUri;
  }
  return stateWithoutRedirectUri;
}

function projectV2State(
  state: CheckpointV2State,
  parseState: (value: unknown) => SetupState,
): SetupState {
  switch (state.kind) {
    case "asana_authorization_pending":
      throw new Error("OAuth認可待機中の旧初回設定状態は移行できません。");
    case "vault_skipped":
    case "vault_configured":
    case "external_tool_skipped":
    case "external_tool_configured":
    case "external_tool_unavailable":
    case "full_sync_required":
      return parseState({ kind: "full_sync_required", step: "full_sync", context: state.context });
    case "codex_capability_required":
      return parseState({ kind: "codex_capability_required", step: "codex_capability", context: state.context });
    case "ready":
      return parseState({ kind: "ready", step: "ready", context: state.context });
    default:
      return parseState(state);
  }
}

/** 初回設定状態を秘密なしのJSONとして原子的に保存します。 */
export class SetupCheckpointStore {
  public constructor(
    private readonly file: PersistentTextFile,
    private readonly parseState: (value: unknown) => SetupState,
  ) {}

  private parsePersistableState(value: unknown): SetupState {
    const state = this.parseState(value);
    if (state.kind === "asana_authorization_pending") {
      throw new Error("OAuth認可待機中の初回設定状態は保存できません。");
    }
    return state;
  }

  private serializeCheckpoint(state: SetupState): string {
    return JSON.stringify(checkpointSchema.parse({
      version: checkpointVersion,
      state: this.parsePersistableState(state),
    }));
  }

  /** 保存済み初回設定状態を検証して読み出します。 */
  public load(): SetupState | undefined {
    const serialized = this.file.read();
    if (serialized == null) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch (error: unknown) {
      throw new Error("初回設定チェックポイントのJSONが不正です。", { cause: error });
    }
    let versionEnvelope: z.infer<typeof checkpointVersionEnvelopeSchema>;
    try {
      versionEnvelope = checkpointVersionEnvelopeSchema.parse(parsed);
    } catch (error: unknown) {
      throw new Error("初回設定チェックポイントの内容が不正です。", { cause: error });
    }
    if (versionEnvelope.version === checkpointVersion) {
      try {
        return this.parsePersistableState(checkpointSchema.parse(parsed).state);
      } catch (error: unknown) {
        throw new Error("初回設定チェックポイントの内容が不正です。", { cause: error });
      }
    }
    if (versionEnvelope.version !== legacyCheckpointVersion && versionEnvelope.version !== 2) {
      throw new Error("初回設定チェックポイントのバージョンが不明です。");
    }
    let legacyState: CheckpointV2State;
    try {
      const v2Source = versionEnvelope.version === legacyCheckpointVersion
        ? migrateLegacyState(legacyCheckpointSchema.parse(parsed).state)
        : checkpointV2Schema.parse(parsed).state;
      legacyState = checkpointV2StateSchema.parse(v2Source);
    } catch (error: unknown) {
      throw new Error("旧初回設定チェックポイントの内容が不正です。", { cause: error });
    }
    let migratedState: SetupState;
    try {
      migratedState = this.parsePersistableState(projectV2State(legacyState, this.parseState));
    } catch (error: unknown) {
      throw new Error("旧初回設定チェックポイントを移行できません。", { cause: error });
    }
    try {
      this.file.replaceAtomically(
        this.serializeCheckpoint(migratedState),
        "初回設定チェックポイントの移行",
      );
    } catch (error: unknown) {
      throw new Error("初回設定チェックポイントの移行結果を保存できません。", {
        cause: error,
      });
    }
    return migratedState;
  }

  /** 初回設定状態を一時ファイルから原子的に保存します。 */
  public save(state: SetupState): void {
    this.file.replaceAtomically(this.serializeCheckpoint(state), "初回設定チェックポイント");
  }
}
