import { z } from "zod";
import { createUtf8ByteLimitedStringSchema, isoDateTimeSchema } from "../../../shared/domain";

const outOfBandRedirectUri = "urn:ietf:wg:oauth:2.0:oob";
const maximumOutOfBandAuthorizationCodeBytes = 8 * 1024;

export const asanaOAuthOutOfBandRedirectUri = outOfBandRedirectUri;

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint != null
      && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    );
  });
}

/** OAuthの認可状態を検証するスキーマです。 */
export const oauthStateSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u, {
    message: "OAuthのstateは43文字のbase64url形式で指定してください。",
  });

/** OAuth取引の識別子を検証するスキーマです。 */
export const oauthAuthorizationIdSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u, {
    message: "OAuth取引の識別子は43文字のbase64url形式で指定してください。",
  });

/** OAuth Out-of-Band認可コードを検証するスキーマです。 */
export const oauthOutOfBandAuthorizationCodeSchema = createUtf8ByteLimitedStringSchema(
  maximumOutOfBandAuthorizationCodeBytes,
)
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "OAuth認可コードを空白だけにできません。",
  })
  .refine((value) => value.trim() === value, {
    message: "OAuth認可コードの前後に空白を指定できません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "OAuth認可コードに制御文字を指定できません。",
  });

/** PKCEのcode_verifierを検証するスキーマです。 */
export const codeVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/u, {
    message: "PKCEのcode_verifierが不正です。",
  });

/** OAuthトークン応答の利用者情報を検証するスキーマです。 */
const oauthUserDataSchema = z
  .object({
    id: z.union([z.string(), z.number().int()]).optional(),
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .strip();

const tokenValueSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: "OAuthトークンを空にできません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "OAuthトークンに制御文字を指定できません。",
  });

/** OAuthトークンエラーコードを検証するスキーマです。 */
export const oauthTokenErrorCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_]*$/u, {
    message: "OAuthトークンエラーコードが不正です。",
  });

/** OAuthトークンエラー応答を検証するスキーマです。 */
export const oauthTokenErrorResponseSchema = z
  .object({
    error: oauthTokenErrorCodeSchema,
  })
  .strip();

/** OAuthトークン応答を検証するスキーマです。 */
export const oauthTokenResponseSchema = z
  .object({
    access_token: tokenValueSchema,
    token_type: z.literal("bearer"),
    expires_in: z.number().int().positive(),
    refresh_token: tokenValueSchema.optional(),
    data: oauthUserDataSchema.optional(),
  })
  .strip();

/** OAuth認可要求を検証するスキーマです。 */
export const oauthAuthorizationRequestSchema = z
  .object({
    authorization_url: z.url(),
    state: oauthStateSchema,
  })
  .strict();

/** OAuth Out-of-Band開始結果を検証するスキーマです。 */
export const oauthOutOfBandBeginResultSchema = z
  .object({
    authorization_id: oauthAuthorizationIdSchema,
    expires_at: isoDateTimeSchema,
  })
  .strict();

/** OAuth Out-of-Band取引の公開状態を検証するスキーマです。 */
export const oauthOutOfBandStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("idle") }).strict(),
  z
    .object({
      kind: z.literal("opening"),
      authorization_id: oauthAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("authorization_pending"),
      authorization_id: oauthAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("completing"),
      authorization_id: oauthAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("expired"),
      authorization_id: oauthAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancelled"),
      authorization_id: oauthAuthorizationIdSchema,
      expires_at: isoDateTimeSchema,
    })
    .strict(),
]);

export type OAuthAuthorizationId = z.infer<typeof oauthAuthorizationIdSchema>;
export type OAuthOutOfBandBeginResult = z.infer<
  typeof oauthOutOfBandBeginResultSchema
>;
export type OAuthOutOfBandState = z.infer<typeof oauthOutOfBandStateSchema>;

export type OAuthTokenResponse = z.infer<typeof oauthTokenResponseSchema>;
export type OAuthTokenErrorCode = z.infer<typeof oauthTokenErrorCodeSchema>;
export type OAuthAuthorizationRequest = z.infer<
  typeof oauthAuthorizationRequestSchema
>;
