import { z } from "zod";
import { identifierSchema } from "./common";

const maximumPathBytes = 4_096;

function isAbsoluteVaultPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint != null && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

export const vaultMappingSchema = z
  .object({
    vault_id: identifierSchema,
    absolute_path: z
      .string()
      .min(1)
      .refine((value) => new TextEncoder().encode(value).byteLength <= maximumPathBytes, "Vaultの絶対パスが長さ上限を超えています。")
      .refine((value) => !value.includes("\0"), "Vaultの絶対パスにNUL文字を指定できません。")
      .refine(isAbsoluteVaultPath, "Vaultのパスは絶対パスで指定してください。"),
  })
  .strict();

export const relativeMarkdownPathSchema = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= maximumPathBytes, "ノートパスが長さ上限を超えています。")
  .refine((value) => !value.includes("\0") && !hasControlCharacter(value), "ノートパスに制御文字を指定できません。")
  .refine(
    (value) => value.endsWith(".md") && !value.startsWith("/") && !value.includes("\\")
      && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
    "Vault内のMarkdownノートへの相対パスを指定してください。",
  );
