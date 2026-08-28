import { z } from "zod";

function hasControlCharacter(value: string): boolean {
  return value.split("").some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (
      codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)
    );
  });
}

const maximumDiscordBotTokenBytes = 4_096;

const secretValueSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "秘密値を空にできません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "秘密値に制御文字を指定できません。",
  });

const credentialReferenceSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "資格情報参照を空にできません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "資格情報参照に制御文字を指定できません。",
  });

const discordBotTokenSchema = secretValueSchema
  .regex(
    /^[A-Za-z0-9._-]+$/u,
    "Discord Bot Tokenの形式が不正です。",
  )
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= maximumDiscordBotTokenBytes,
    "Discord Bot Tokenが長すぎます。",
  )
  .refine(
    (value) => value === value.trim(),
    "Discord Bot Tokenの前後に空白を含めることはできません。",
  )
  .refine(
    (value) => !/\s/u.test(value),
    "Discord Bot Tokenに空白を含めることはできません。",
  );

const externalCredentialReferencesSchema = z.record(
  credentialReferenceSchema,
  credentialReferenceSchema,
);

/** Electronの保護ストレージへ保存する秘密情報を検証するスキーマです。 */
export const secretStorageSchema = z
  .object({
    asana_client_secret: secretValueSchema.optional(),
    access_token: secretValueSchema.optional(),
    refresh_token: secretValueSchema.optional(),
    discord_bot_token: discordBotTokenSchema.optional(),
    external_credential_references: externalCredentialReferencesSchema.optional(),
  })
  .strict();

/** 暗号化済み秘密情報ファイルを検証するスキーマです。 */
export const encryptedSecretStorageSchema = z
  .object({
    version: z.literal(1),
    ciphertext: z.base64(),
  })
  .strict();

export type SecretStorageData = z.infer<typeof secretStorageSchema>;
