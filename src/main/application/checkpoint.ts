import { z } from "zod";
import { setupStateSchema, type SetupState } from "../../shared/setup";
import {
  captureSecurePersistentFile,
  normalizeSecurePersistentFilePath,
  readSecurePersistentTextFile,
  writeSecurePersistentTextFileAtomically,
} from "../local-storage-path";

const checkpointVersion = 2;
const legacyCheckpointVersion = 1;
const checkpointStateSchema = setupStateSchema.refine(
  (state) => state.kind !== "asana_authorization_pending",
  "OAuth認可待機中の初回設定状態は保存できません。",
);

const checkpointSchema = z
  .object({
    version: z.literal(checkpointVersion),
    state: checkpointStateSchema,
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

function migrateLegacyState(state: LegacySetupState): SetupState {
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
  return checkpointStateSchema.parse(stateWithoutRedirectUri);
}

function serializeCheckpoint(state: SetupState): string {
  return JSON.stringify(
    checkpointSchema.parse({ version: checkpointVersion, state }),
  );
}

/** 初回設定状態を秘密なしのJSONとして原子的に保存します。 */
export class SetupCheckpointStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = normalizeSecurePersistentFilePath(filePath);
    captureSecurePersistentFile(this.filePath, "初回設定チェックポイント");
  }

  /** 保存済み初回設定状態を検証して読み出します。 */
  public load(): SetupState | undefined {
    const serialized = readSecurePersistentTextFile(
      this.filePath,
      "初回設定チェックポイント",
    );
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
        return checkpointSchema.parse(parsed).state;
      } catch (error: unknown) {
        throw new Error("初回設定チェックポイントの内容が不正です。", { cause: error });
      }
    }
    if (versionEnvelope.version !== legacyCheckpointVersion) {
      throw new Error("初回設定チェックポイントのバージョンが不明です。");
    }
    let legacyState: LegacySetupState;
    try {
      legacyState = legacyCheckpointSchema.parse(parsed).state;
    } catch (error: unknown) {
      throw new Error("旧初回設定チェックポイントの内容が不正です。", { cause: error });
    }
    let migratedState: SetupState;
    try {
      migratedState = migrateLegacyState(legacyState);
    } catch (error: unknown) {
      throw new Error("旧初回設定チェックポイントを移行できません。", { cause: error });
    }
    try {
      writeSecurePersistentTextFileAtomically(
        this.filePath,
        serializeCheckpoint(migratedState),
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
    const validatedState = checkpointStateSchema.parse(state);
    writeSecurePersistentTextFileAtomically(
      this.filePath,
      serializeCheckpoint(validatedState),
      "初回設定チェックポイント",
    );
  }
}
