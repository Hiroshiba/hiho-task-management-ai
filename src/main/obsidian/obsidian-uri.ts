import { z } from "zod";
import {
  createUtf8ByteLimitedStringSchema,
  getUtf8ByteLength,
} from "../../shared/domain";
import {
  obsidianRelativeMarkdownPathSchema,
  obsidianVaultIdSchema,
} from "./obsidian-read-service";

const maximumObsidianUriValueCharacters = 4_096;
const maximumObsidianUriValueBytes = 4_096;
const maximumObsidianUriCharacters = 32_768;
const maximumObsidianUriBytes = 32_768;

const obsidianUriValueSchema = createUtf8ByteLimitedStringSchema(
  maximumObsidianUriValueBytes,
)
  .min(1)
  .max(maximumObsidianUriValueCharacters)
  .refine(
    (value) => !value.includes("\0"),
    "Obsidian URIの値にNUL文字を指定できません。",
  );

export const obsidianOpenUriInputSchema = z
  .object({
    vault_id: obsidianUriValueSchema.pipe(obsidianVaultIdSchema),
    relative_path: obsidianUriValueSchema.pipe(obsidianRelativeMarkdownPathSchema),
  })
  .strict();

type ObsidianOpenUriInput = z.infer<typeof obsidianOpenUriInputSchema>;

function isCanonicalObsidianOpenUri(value: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return false;
  }
  if (
    parsedUrl.protocol !== "obsidian:"
    || parsedUrl.host !== "open"
    || parsedUrl.username !== ""
    || parsedUrl.password !== ""
    || parsedUrl.port !== ""
    || parsedUrl.pathname !== ""
    || parsedUrl.hash !== ""
  ) {
    return false;
  }
  const entries = [...parsedUrl.searchParams.entries()];
  const keys = new Set(entries.map(([key]) => key));
  if (
    entries.length !== 2
    || keys.size !== 2
    || !keys.has("vault")
    || !keys.has("file")
  ) {
    return false;
  }
  const vaultValues = parsedUrl.searchParams.getAll("vault");
  const fileValues = parsedUrl.searchParams.getAll("file");
  if (vaultValues.length !== 1 || fileValues.length !== 1) {
    return false;
  }
  const vaultId = vaultValues[0];
  const relativePath = fileValues[0];
  if (vaultId == null || relativePath == null) {
    return false;
  }
  return obsidianOpenUriInputSchema.safeParse({
    vault_id: vaultId,
    relative_path: relativePath,
  }).success;
}

const obsidianOpenUriSchema = z
  .string()
  .min(1)
  .max(maximumObsidianUriCharacters)
  .refine(
    (value) => getUtf8ByteLength(value) <= maximumObsidianUriBytes,
    "Obsidian URIが長さ上限を超えています。",
  )
  .refine(
    (value) => !value.includes("\0"),
    "Obsidian URIにNUL文字を指定できません。",
  )
  .refine(isCanonicalObsidianOpenUri, "Obsidian URIが不正です。");

/** Vault内のMarkdownノートを開くObsidian URIを生成します。 */
export function createObsidianOpenUri(
  input: ObsidianOpenUriInput,
): string {
  const validatedInput = obsidianOpenUriInputSchema.parse(input);
  const url = new URL("obsidian://open");
  url.searchParams.set("vault", validatedInput.vault_id);
  url.searchParams.set("file", validatedInput.relative_path);
  return obsidianOpenUriSchema.parse(url.href);
}
