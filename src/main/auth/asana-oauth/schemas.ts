import { isIP } from "node:net";
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

function isValidHost(hostname: string): boolean {
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (unbracketedHostname.length === 0) {
    return false;
  }
  if (isIP(unbracketedHostname) !== 0) {
    return true;
  }
  if (unbracketedHostname === "localhost" || unbracketedHostname === "localhost.") {
    return true;
  }
  if (unbracketedHostname.length > 253) {
    return false;
  }
  return unbracketedHostname.split(".").every((label) => {
    return (
      label.length > 0
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label)
    );
  });
}

function isLoopbackHost(hostname: string): boolean {
  const unbracketedHostname = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (unbracketedHostname === "localhost" || unbracketedHostname === "localhost.") {
    return true;
  }
  if (isIP(unbracketedHostname) === 4) {
    const octets = unbracketedHostname.split(".");
    return octets[0] === "127";
  }
  return isIP(unbracketedHostname) === 6 && unbracketedHostname === "::1";
}

function hasAuthorityUserInfo(value: string): boolean {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator < 0) {
    return false;
  }
  const authority = value
    .slice(schemeSeparator + 3)
    .split(/[/?#]/u, 1)[0];
  return authority != null && authority.includes("@");
}

function readExplicitPort(value: string): number | undefined {
  const schemeSeparator = value.indexOf("://");
  if (schemeSeparator < 0) {
    return undefined;
  }
  const authority = value
    .slice(schemeSeparator + 3)
    .split(/[/?#]/u, 1)[0];
  if (authority == null) {
    return undefined;
  }
  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0 || authority[closingBracket + 1] !== ":") {
      return undefined;
    }
    const port = authority.slice(closingBracket + 2);
    return /^\d+$/u.test(port) ? Number(port) : undefined;
  }
  const portSeparator = authority.lastIndexOf(":");
  if (portSeparator < 0) {
    return undefined;
  }
  const port = authority.slice(portSeparator + 1);
  return /^\d+$/u.test(port) ? Number(port) : undefined;
}

function isValidLoopbackPort(value: string): boolean {
  const port = readExplicitPort(value);
  return port != null && Number.isSafeInteger(port) && port >= 1024 && port <= 65535;
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

/** OAuthのOut-of-BandリダイレクトURIを検証するスキーマです。 */
export const oauthOutOfBandRedirectUriSchema = z.literal(outOfBandRedirectUri);

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

/** OAuth認可コードを検証するスキーマです。 */
export const authorizationCodeSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.trim().length > 0, {
    message: "OAuth認可コードを空白だけにできません。",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "OAuth認可コードに制御文字を指定できません。",
  });

/** OAuthのリダイレクトURIを検証するスキーマです。 */
export const redirectUriSchema = z
  .string()
  .min(1)
  .refine((value) => !hasControlCharacter(value), {
    message: "OAuthのredirect URIに制御文字を指定できません。",
  })
  .refine((value) => value.trim() === value, {
    message: "OAuthのredirect URIの前後に空白を指定できません。",
  })
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "http:" || url.protocol === "https:") &&
        isValidHost(url.hostname) &&
        !hasAuthorityUserInfo(value) &&
        url.username.length === 0 &&
        url.password.length === 0 &&
        !value.includes("#") &&
        !value.includes("?") &&
        (
          url.protocol === "https:"
          || (isLoopbackHost(url.hostname) && isValidLoopbackPort(value))
        )
      );
    } catch {
      return false;
    }
  }, {
    message: "OAuthのredirect URIが不正です。",
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
  .strict();

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
