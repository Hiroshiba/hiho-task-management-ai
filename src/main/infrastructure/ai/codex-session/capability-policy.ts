import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type ThreadStartResult } from "../codex-app-server";
import {
  CodexSessionCapabilityError,
  type CodexThreadStartCapabilityFailureCode,
} from "./errors";

export const permissionProfileId = "taskhub";

type SandboxValidationResult =
  | { readonly kind: "valid" }
  | {
      readonly kind: "invalid";
      readonly failureCode: Extract<
        CodexThreadStartCapabilityFailureCode,
        | "sandbox_invalid"
        | "sandbox_danger_full_access"
        | "sandbox_read_only_network_enabled"
        | "sandbox_external_restricted"
        | "sandbox_external_enabled"
      >;
    };

export type ThreadSettingsNotification = {
  readonly threadId: string;
  readonly profileId: string | undefined;
  readonly profileExtends: string | null | undefined;
  readonly sandboxValidation: SandboxValidationResult;
};

interface VerifiedTaskctlStartResult {
  readonly socketPath: string;
  readonly connectionInfoPath: string;
  readonly localIpcBoundary:
    | { readonly kind: "windows_named_pipe"; readonly access: "current_user" }
    | {
        readonly kind: "unix_socket";
        readonly access: "owner_only";
        readonly socketDirectoryPath: string;
      };
}

/** 候補パスが親ディレクトリ内にあるか判定します。 */
export function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(resolve(parentPath), resolve(candidatePath));
  return (
    relativePath.length === 0
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !relativePath.startsWith(sep))
  );
}

/** 読み取り専用ディレクトリの実体パスを検証します。 */
export function resolveVerifiedReadOnlyDirectory(directoryPath: string): string {
  const normalizedPath = resolve(directoryPath);
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  try {
    const parts = relative(rootPath, normalizedPath)
      .split(sep)
      .filter((part) => part.length > 0);
    for (const part of parts) {
      currentPath = join(currentPath, part);
      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new CodexSessionCapabilityError(
          "Vaultのパスにシンボリックリンクを指定できません。",
        );
      }
    }
    const stats = lstatSync(normalizedPath);
    if (!stats.isDirectory()) {
      throw new CodexSessionCapabilityError(
        "Vaultのパスはディレクトリでなければなりません。",
      );
    }
    return realpathSync.native(normalizedPath);
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(
      "Vaultの実体パスを安全に検証できません。",
      error,
    );
  }
}

/** 存在するディレクトリの実体パスを取得します。 */
export function resolveExistingDirectory(directoryPath: string, label: string): string {
  try {
    const realPath = realpathSync.native(directoryPath);
    if (!lstatSync(realPath).isDirectory()) {
      throw new CodexSessionCapabilityError(`${label}はディレクトリでなければなりません。`);
    }
    return realPath;
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(`${label}の実体パスを確認できません。`, error);
  }
}

function isNoEntryError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

/** Codex認証領域の候補パスを検証します。 */
export function resolveCodexHomeCandidate(directoryPath: string): string {
  const normalizedPath = resolve(directoryPath);
  if (normalizedPath !== directoryPath) {
    throw new CodexSessionCapabilityError(
      "Codex認証領域のパスが正規化されていません。",
    );
  }
  const rootPath = parse(normalizedPath).root;
  const parts = relative(rootPath, normalizedPath)
    .split(sep)
    .filter((part) => part.length > 0);
  let currentPath = rootPath;
  try {
    for (const [index, part] of parts.entries()) {
      currentPath = join(currentPath, part);
      let stats: Stats;
      try {
        stats = lstatSync(currentPath);
      } catch (error: unknown) {
        if (isNoEntryError(error)) {
          if (index === parts.length - 1) {
            return normalizedPath;
          }
          throw new CodexSessionCapabilityError(
            "Codex認証領域の親ディレクトリを確認できません。",
            error,
          );
        }
        throw error;
      }
      if (stats.isSymbolicLink()) {
        throw new CodexSessionCapabilityError(
          "Codex認証領域のパスにシンボリックリンクを指定できません。",
        );
      }
      if (!stats.isDirectory()) {
        throw new CodexSessionCapabilityError(
          "Codex認証領域のパスはディレクトリでなければなりません。",
        );
      }
      const realPath = realpathSync.native(currentPath);
      if (realPath !== currentPath) {
        throw new CodexSessionCapabilityError(
          "Codex認証領域の設定パスと実体パスが一致しません。",
        );
      }
      if (index === parts.length - 1) {
        return realPath;
      }
    }
    return normalizedPath;
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(
      "Codex認証領域を安全に検証できません。",
      error,
    );
  }
}

/** 設定対象ディレクトリの実体と権限を検証します。 */
export function resolveVerifiedConfigurationDirectory(
  directoryPath: string,
  label: string,
): string {
  const normalizedPath = resolve(directoryPath);
  if (normalizedPath !== directoryPath) {
    throw new CodexSessionCapabilityError(`${label}のパスが正規化されていません。`);
  }
  const rootPath = parse(normalizedPath).root;
  let currentPath = rootPath;
  try {
    const parts = relative(rootPath, normalizedPath)
      .split(sep)
      .filter((part) => part.length > 0);
    for (const part of parts) {
      currentPath = join(currentPath, part);
      const stats = lstatSync(currentPath);
      if (stats.isSymbolicLink()) {
        throw new CodexSessionCapabilityError(`${label}にシンボリックリンクを指定できません。`);
      }
    }
    const stats = lstatSync(normalizedPath);
    if (!stats.isDirectory()) {
      throw new CodexSessionCapabilityError(`${label}はディレクトリでなければなりません。`);
    }
    const realPath = realpathSync.native(normalizedPath);
    if (realPath !== normalizedPath) {
      throw new CodexSessionCapabilityError(`${label}の設定パスと実体パスが一致しません。`);
    }
    return realPath;
  } catch (error: unknown) {
    if (error instanceof CodexSessionCapabilityError) {
      throw error;
    }
    throw new CodexSessionCapabilityError(`${label}を安全に検証できません。`, error);
  }
}

function validateOwnedUnixSocket(socketPath: string, label: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(socketPath);
  } catch (error: unknown) {
    throw new CodexSessionCapabilityError(`${label}を確認できません。`, error);
  }
  if (typeof process.getuid !== "function") {
    throw new CodexSessionCapabilityError(`${label}の所有者を確認できません。`);
  }
  if (
    stats.isSymbolicLink()
    || !stats.isSocket()
    || stats.uid !== process.getuid()
    || (stats.mode & 0o777) !== 0o600
  ) {
    throw new CodexSessionCapabilityError(`${label}の実体または権限が不正です。`);
  }
}

function validateOwnedUnixSocketDirectory(directoryPath: string, label: string): void {
  let stats: Stats;
  try {
    stats = lstatSync(directoryPath);
  } catch (error: unknown) {
    throw new CodexSessionCapabilityError(`${label}を確認できません。`, error);
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CodexSessionCapabilityError(`${label}の実体が不正です。`);
  }
  if (typeof process.getuid !== "function") {
    throw new CodexSessionCapabilityError(`${label}の所有者を確認できません。`);
  }
  if (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o700) {
    throw new CodexSessionCapabilityError(`${label}の所有者または権限が不正です。`);
  }
}

function validateTaskctlConnectionInfoPath(
  connectionInfoPath: string,
  tmpDirectoryPath: string,
): void {
  const expectedPath = join(tmpDirectoryPath, "taskctl-connection.json");
  if (resolve(connectionInfoPath) !== expectedPath) {
    throw new CodexSessionCapabilityError(
      "taskctl接続情報を専用ワークスペースのtmp直下に限定できません。",
    );
  }
  let stats: Stats;
  try {
    stats = lstatSync(connectionInfoPath);
  } catch (error: unknown) {
    throw new CodexSessionCapabilityError("taskctl接続情報を確認できません。", error);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new CodexSessionCapabilityError("taskctl接続情報の実体が不正です。");
  }
  if (process.platform === "win32") {
    return;
  }
  if (typeof process.getuid !== "function") {
    throw new CodexSessionCapabilityError("taskctl接続情報の所有者を確認できません。");
  }
  if (stats.uid !== process.getuid() || (stats.mode & 0o777) !== 0o600) {
    throw new CodexSessionCapabilityError("taskctl接続情報の所有者または権限が不正です。");
  }
}

/** taskctlローカルIPCの境界を検証します。 */
export function validateVerifiedTaskctlLocalIpc(
  result: VerifiedTaskctlStartResult,
  tmpDirectoryPath: string,
): string {
  validateTaskctlConnectionInfoPath(result.connectionInfoPath, tmpDirectoryPath);
  if (process.platform === "win32") {
    if (
      result.localIpcBoundary.kind !== "windows_named_pipe"
      || result.localIpcBoundary.access !== "current_user"
      || !/^\\\\\.\\pipe\\taskhub-taskctl-[0-9a-f]{24}$/u.test(result.socketPath)
    ) {
      throw new CodexSessionCapabilityError(
        "taskctl名前付きパイプを現在の利用者向け境界へ限定できません。",
      );
    }
    return result.socketPath;
  }
  if (
    result.localIpcBoundary.kind !== "unix_socket"
    || result.localIpcBoundary.access !== "owner_only"
    || !/^taskctl-[0-9a-f]{24}\.sock$/u.test(parse(result.socketPath).base)
  ) {
    throw new CodexSessionCapabilityError(
      "taskctlソケットの形式を専用境界へ限定できません。",
    );
  }
  const socketDirectoryPath = process.platform === "darwin"
    ? resolveVerifiedConfigurationDirectory(
      result.localIpcBoundary.socketDirectoryPath,
      "taskctlソケット用一時ディレクトリ",
    )
    : tmpDirectoryPath;
  if (
    result.localIpcBoundary.socketDirectoryPath !== socketDirectoryPath
    || parse(resolve(result.socketPath)).dir !== socketDirectoryPath
    || (process.platform === "darwin"
      && (
        parse(socketDirectoryPath).dir !== "/private/tmp"
        || !/^taskhub-taskctl-[A-Za-z0-9]{6}$/u.test(parse(socketDirectoryPath).base)
      ))
  ) {
    throw new CodexSessionCapabilityError(
      "taskctlソケットを専用一時ディレクトリ直下に限定できません。",
    );
  }
  if (process.platform === "darwin") {
    validateOwnedUnixSocketDirectory(socketDirectoryPath, "taskctlソケット用一時ディレクトリ");
  }
  validateOwnedUnixSocket(result.socketPath, "taskctlソケット");
  return result.socketPath;
}

/** 追加ローカルソケットのパスを検証します。 */
export function validateAdditionalLocalSocketPaths(
  paths: readonly string[],
  tmpDirectoryPath: string,
): readonly string[] {
  const values = z.array(z.string().min(1).max(4_096)).max(32).parse(paths);
  const seen = new Set<string>();
  const validated: string[] = [];
  for (const value of values) {
    if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
      throw new CodexSessionCapabilityError("追加ローカルIPCの接続先が不正です。");
    }
    if (process.platform === "win32") {
      if (!/^\\\\\.\\pipe\\taskhub-contextctl-[0-9a-f]{24}$/u.test(value)) {
        throw new CodexSessionCapabilityError("contextctl名前付きパイプの接続先を限定できません。");
      }
    } else {
      if (!isAbsolute(value) || parse(resolve(value)).dir !== resolve(tmpDirectoryPath)) {
        throw new CodexSessionCapabilityError("contextctlソケットを専用ワークスペースのtmp直下に限定できません。");
      }
      if (!/^contextctl-[0-9a-f]{24}\.sock$/u.test(parse(value).base)) {
        throw new CodexSessionCapabilityError("contextctlソケットの接続先が不正です。");
      }
      validateOwnedUnixSocket(value, "contextctlソケット");
    }
    const key = process.platform === "win32" ? value : resolve(value);
    if (seen.has(key)) {
      throw new CodexSessionCapabilityError("同じ追加ローカルIPCを重複して指定できません。");
    }
    seen.add(key);
    validated.push(value);
  }
  return validated;
}

/** ターン入力のスキルが専用ワークスペースに属するか検証します。 */
export function validateTurnSkills(
  input: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "skill"; readonly name: string; readonly path: string })[],
  workspacePath: string,
): void {
  for (const item of input) {
    if (item.type !== "skill") {
      continue;
    }
    if (!isRequiredSkillName(item.name)) {
      throw new CodexSessionCapabilityError("Codexターンへ許可されていないスキルを指定できません。");
    }
    const expectedPath = join(workspacePath, ".agents", "skills", item.name, "SKILL.md");
    if (item.path !== expectedPath) {
      throw new CodexSessionCapabilityError("Codexターンへ専用ワークスペース外のスキルを指定できません。");
    }
  }
}


/** 文字列を決定論的に比較します。 */
export function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** 文字列の集合を順序によらず比較できる表現へ変換します。 */
export function canonicalStringArray(values: readonly string[]): string {
  return JSON.stringify([...values].sort(compareStrings));
}

/** TaskHubのCodexスキル名を判定します。 */
export function isRequiredSkillName(name: string): boolean {
  return name === "taskctl" || name === "obsidian" || name === "external-tools";
}

/** TaskHubで必須のCodexスキル名を返します。 */
export function requiredSkillNames(): readonly string[] {
  return ["taskctl", "obsidian", "external-tools"];
}

/** Codexスレッドのサンドボックス権限を検証します。 */
export function validateSandboxPolicy(
  sandbox: ThreadStartResult["sandbox"],
  tmpDirectoryPath: string,
): SandboxValidationResult {
  switch (sandbox.type) {
    case "dangerFullAccess":
      return {
        kind: "invalid",
        failureCode: process.platform === "win32"
          ? "sandbox_danger_full_access"
          : "sandbox_invalid",
      };
    case "readOnly":
      if (sandbox.networkAccess) {
        return {
          kind: "invalid",
          failureCode: process.platform === "win32"
            ? "sandbox_read_only_network_enabled"
            : "sandbox_invalid",
        };
      }
      if (process.platform === "win32") {
        return { kind: "valid" };
      }
      return { kind: "invalid", failureCode: "sandbox_invalid" };
    case "externalSandbox":
      if (process.platform === "win32") {
        return {
          kind: "invalid",
          failureCode: sandbox.networkAccess === "restricted"
            ? "sandbox_external_restricted"
            : "sandbox_external_enabled",
        };
      }
      return { kind: "invalid", failureCode: "sandbox_invalid" };
    case "workspaceWrite":
      if (process.platform === "win32") {
        return sandbox.networkAccess === false
          ? { kind: "valid" }
          : { kind: "invalid", failureCode: "sandbox_invalid" };
      }
      {
        const roots = new Set(sandbox.writableRoots);
        const isValid =
          sandbox.writableRoots.length === 1
          && roots.size === 1
          && roots.has(tmpDirectoryPath)
          && sandbox.networkAccess === false
          && sandbox.excludeTmpdirEnvVar === true
          && sandbox.excludeSlashTmp === true;
        return isValid
          ? { kind: "valid" }
          : { kind: "invalid", failureCode: "sandbox_invalid" };
      }
    default:
      throw new Error("sandbox種別が想定外です。");
  }
}

/** 通知されたスレッド設定が要求した権限と一致するか判定します。 */
export function isValidThreadSettingsNotification(
  notification: ThreadSettingsNotification,
): boolean {
  if (notification.sandboxValidation.kind !== "valid") {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  return (
    notification.profileId === permissionProfileId
    && notification.profileExtends === null
  );
}
