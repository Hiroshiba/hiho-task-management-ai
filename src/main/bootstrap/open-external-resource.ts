import { shell } from "electron";
import { isAbsolute } from "node:path";
import { z } from "zod";

const resolvedAbsolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(isAbsolute, "解決済みパスは絶対パスでなければなりません。")
  .refine((value) => !value.includes("\0"), "解決済みパスにNUL文字を指定できません。");

/** 検証済みの外部URLを開きます。 */
export async function openAuthorizedExternalUrl(
  rawUrl: string,
  signal: AbortSignal,
  validate: (value: string) => URL,
): Promise<void> {
  signal.throwIfAborted();
  const validatedUrl = validate(rawUrl);
  await shell.openExternal(validatedUrl.href);
  signal.throwIfAborted();
}

/** 検証済みの絶対パスを開きます。 */
export async function openResolvedPath(rawPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const absolutePath = resolvedAbsolutePathSchema.parse(rawPath);
  const result = await shell.openPath(absolutePath);
  if (result !== "") {
    throw new Error("ローカルパスを開けませんでした。");
  }
  signal.throwIfAborted();
}

function validateObsidianOpenUri(
  rawUri: string,
  validateInput: (vaultId: string, relativePath: string) => void,
): URL {
  const parsedUrl = new URL(rawUri);
  if (
    parsedUrl.protocol !== "obsidian:"
    || parsedUrl.host !== "open"
    || parsedUrl.username !== ""
    || parsedUrl.password !== ""
    || parsedUrl.port !== ""
    || parsedUrl.pathname !== ""
    || parsedUrl.hash !== ""
  ) {
    throw new Error("Obsidian URIが不正です。");
  }
  const entries = [...parsedUrl.searchParams.entries()];
  const keys = new Set(entries.map(([key]) => key));
  if (
    entries.length !== 2
    || keys.size !== 2
    || !keys.has("vault")
    || !keys.has("file")
  ) {
    throw new Error("Obsidian URIのqueryが不正です。");
  }
  const vaultValues = parsedUrl.searchParams.getAll("vault");
  const fileValues = parsedUrl.searchParams.getAll("file");
  if (vaultValues.length !== 1 || fileValues.length !== 1) {
    throw new Error("Obsidian URIのqueryが重複しています。");
  }
  const vaultId = vaultValues[0];
  const relativePath = fileValues[0];
  if (vaultId == null || relativePath == null) {
    throw new Error("Obsidian URIのquery値が不正です。");
  }
  validateInput(vaultId, relativePath);
  return parsedUrl;
}

/** 検証済みのObsidian URIを開きます。 */
export async function openObsidianUrl(
  rawUrl: string,
  signal: AbortSignal,
  validateInput: (vaultId: string, relativePath: string) => void,
): Promise<void> {
  signal.throwIfAborted();
  const validatedUrl = validateObsidianOpenUri(rawUrl, validateInput);
  await shell.openExternal(validatedUrl.href);
  signal.throwIfAborted();
}
