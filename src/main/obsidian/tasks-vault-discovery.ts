import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  vaultMappingSchema,
  type VaultMapping,
} from "../../shared/storage";
import { ObsidianReadError, validateVaultMappingPath } from "./obsidian-read-service";

const tasksVaultId = "tasks";
const tasksVaultMappingSchema = vaultMappingSchema.extend({
  vault_id: z.literal(tasksVaultId),
}).strict();

const tasksVaultDiscoveryFoundSchema = z
  .object({
    kind: z.literal("found"),
    mapping: tasksVaultMappingSchema,
  })
  .strict();

const tasksVaultDiscoveryNotFoundSchema = z
  .object({
    kind: z.literal("not_found"),
  })
  .strict();

const tasksVaultDiscoveryUnsupportedSchema = z
  .object({
    kind: z.literal("unsupported"),
  })
  .strict();

const tasksVaultDiscoveryResultSchema = z.discriminatedUnion("kind", [
  tasksVaultDiscoveryFoundSchema,
  tasksVaultDiscoveryNotFoundSchema,
  tasksVaultDiscoveryUnsupportedSchema,
]);

type TasksVaultDiscoveryResult = z.infer<
  typeof tasksVaultDiscoveryResultSchema
>;

function validateAbortSignal(signal: AbortSignal): void {
  if (
    signal == null
    || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function"
    || typeof signal.removeEventListener !== "function"
    || typeof signal.throwIfAborted !== "function"
  ) {
    throw new TypeError("AbortSignalが必要です。");
  }
}

function throwIfAborted(signal: AbortSignal): void {
  signal.throwIfAborted();
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

async function inspectDirectory(
  path: string,
  signal: AbortSignal,
): Promise<"missing" | "existing"> {
  throwIfAborted(signal);
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  throwIfAborted(signal);
  if (stats.isSymbolicLink()) {
    throw new ObsidianReadError(
      "symlink_rejected",
      "tasks Vaultの候補パスにシンボリックリンクは指定できません。",
    );
  }
  if (!stats.isDirectory()) {
    throw new ObsidianReadError(
      "vault_not_directory",
      "tasks Vaultの候補パスはディレクトリではありません。",
    );
  }
  return "existing";
}

/** Windows環境のtasks Vaultを検出して実体パスを返します。 */
export async function discoverTasksVault(
  signal: AbortSignal,
): Promise<TasksVaultDiscoveryResult> {
  validateAbortSignal(signal);
  throwIfAborted(signal);
  if (platform() !== "win32") {
    return tasksVaultDiscoveryResultSchema.parse({ kind: "unsupported" });
  }

  const rootPath = join(homedir(), "Github", "tasks");
  const rootInspection = await inspectDirectory(rootPath, signal);
  if (rootInspection === "missing") {
    return tasksVaultDiscoveryResultSchema.parse({ kind: "not_found" });
  }
  const obsidianInspection = await inspectDirectory(join(rootPath, ".obsidian"), signal);
  if (obsidianInspection === "missing") {
    return tasksVaultDiscoveryResultSchema.parse({ kind: "not_found" });
  }

  const validatedVault = await validateVaultMappingPath(
    { vault_id: tasksVaultId, absolute_path: rootPath },
    signal,
  );
  const mapping: VaultMapping = vaultMappingSchema.parse({
    vault_id: tasksVaultId,
    absolute_path: validatedVault.real_path,
  });
  return tasksVaultDiscoveryResultSchema.parse({
    kind: "found",
    mapping,
  });
}
