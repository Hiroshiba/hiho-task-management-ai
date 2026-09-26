import { join } from "node:path";
import {
  accountReadParamsSchema,
  accountReadResultSchema,
  modelListParamsSchema,
  modelListResultSchema,
  permissionProfileListParamsSchema,
  permissionProfileListResultSchema,
  skillsListParamsSchema,
  skillsListResultSchema,
  type ModelListResult,
  type PermissionProfileListResult,
} from "../codex-app-server";
import type { CodexRpcEndpoint } from "../codex-app-server/rpc-endpoint";
import { CodexSessionAbortedError, CodexSessionCapabilityError } from "./errors";
import { compareStrings, isRequiredSkillName, permissionProfileId, requiredSkillNames } from "./capability-policy";

type CapabilityConnection = Pick<
  CodexRpcEndpoint,
  "readAccount" | "listModels" | "listSkills" | "listPermissionProfiles"
>;

export type AccountInspectionResult =
  | { readonly kind: "authenticated" }
  | { readonly kind: "authentication_pending" }
  | { readonly kind: "wrong_account_type" };

const maximumModelRecords = 10_000;
const accountReadRetryDelaysMilliseconds: readonly [number, number, number, number] = [
  250,
  500,
  750,
  1_000,
];

/** Codexアカウントの認証種別を確認します。 */
export async function inspectCodexAccount(
  connection: CapabilityConnection,
  signal: AbortSignal,
): Promise<AccountInspectionResult> {
  const params = accountReadParamsSchema.parse({ refreshToken: false });
  const result = accountReadResultSchema.parse(await connection.readAccount(params, signal));
  if (result.account != null && result.account.type !== "chatgpt") {
    return { kind: "wrong_account_type" };
  }
  if (result.account == null) {
    return { kind: "authentication_pending" };
  }
  return { kind: "authenticated" };
}

/** Codexアカウントを一時的な失敗だけ再試行して確認します。 */
export async function inspectCodexAccountWithRetry(
  connection: CapabilityConnection,
  signal: AbortSignal,
  assertSafetyIntact: () => void,
): Promise<AccountInspectionResult> {
  let inspection = await inspectCodexAccount(connection, signal);
  for (const delayMilliseconds of accountReadRetryDelaysMilliseconds) {
    if (inspection.kind !== "authentication_pending") {
      return inspection;
    }
    await waitForAccountReadRetry(delayMilliseconds, signal);
    assertSafetyIntact();
    inspection = await inspectCodexAccount(connection, signal);
  }
  return inspection;
}

function waitForAccountReadRetry(
  delayMilliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new CodexSessionAbortedError();
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, delayMilliseconds);
    const onAbort = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      rejectPromise(new CodexSessionAbortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

/** 利用可能なCodexモデルを確認します。 */
export async function inspectCodexModel(
  connection: CapabilityConnection,
  signal: AbortSignal,
): Promise<string> {
  const models: ModelListResult["data"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const params = modelListParamsSchema.parse(
      cursor == null
        ? { limit: 1_000, includeHidden: false }
        : { limit: 1_000, includeHidden: false, cursor },
    );
    const result = modelListResultSchema.parse(
      await connection.listModels(params, signal),
    );
    models.push(...result.data);
    if (models.length > maximumModelRecords) {
      throw new CodexSessionCapabilityError("Codexモデル一覧が上限を超えています。");
    }
    const nextCursor = result.nextCursor;
    if (nextCursor == null) {
      break;
    }
    if (seenCursors.has(nextCursor)) {
      throw new CodexSessionCapabilityError("Codexモデル一覧のページングが進みません。");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) {
      throw new CodexSessionCapabilityError("Codexモデル一覧に重複したモデルがあります。");
    }
    modelIds.add(model.id);
  }
  const defaults = models.filter(
    (model) => model.hidden !== true && model.isDefault === true,
  );
  if (defaults.length !== 1) {
    throw new CodexSessionCapabilityError("利用可能な既定Codexモデルを一つに確定できません。");
  }
  const selected = defaults[0];
  if (selected == null) {
    throw new CodexSessionCapabilityError("利用可能な既定Codexモデルを取得できません。");
  }
  return selected.id;
}

/** 専用ワークスペースのCodexスキルを確認します。 */
export async function inspectCodexSkills(
  connection: CapabilityConnection,
  signal: AbortSignal,
  workspacePath: string,
): Promise<Array<{ path: string; enabled: boolean }>> {
  const params = skillsListParamsSchema.parse({
    cwds: [workspacePath],
    forceReload: true,
  });
  const result = skillsListResultSchema.parse(await connection.listSkills(params, signal));
  const workspace = result.data.find((entry) => entry.cwd === workspacePath);
  if (workspace == null) {
    throw new CodexSessionCapabilityError("専用ワークスペースのスキル一覧を取得できません。");
  }

  const seenNames = new Set<string>();
  const seenPaths = new Set<string>();
  const configuration = workspace.skills.map((skill) => {
    if (seenNames.has(skill.name) || seenPaths.has(skill.path)) {
      throw new CodexSessionCapabilityError("Codexスキル一覧に重複した項目があります。");
    }
    seenNames.add(skill.name);
    seenPaths.add(skill.path);
    const required = isRequiredSkillName(skill.name);
    const expectedPath = join(
      workspacePath,
      ".agents",
      "skills",
      skill.name,
      "SKILL.md",
    );
    const allowed = required && skill.path === expectedPath;
    if (required && !allowed) {
      throw new CodexSessionCapabilityError("必要なCodexスキルを利用できません。");
    }
    return { path: skill.path, enabled: allowed };
  });
  for (const requiredSkillName of requiredSkillNames()) {
    const expectedPath = join(
      workspacePath,
      ".agents",
      "skills",
      requiredSkillName,
      "SKILL.md",
    );
    const requiredSkill = workspace.skills.find(
      (skill) => skill.name === requiredSkillName && skill.path === expectedPath,
    );
    if (requiredSkill == null || requiredSkill.enabled !== true) {
      throw new CodexSessionCapabilityError("必要なCodexスキルを利用できません。");
    }
  }
  return configuration.sort((left, right) => compareStrings(left.path, right.path));
}

/** Codex権限プロファイルを確認します。 */
export async function inspectCodexPermissionProfile(
  connection: CapabilityConnection,
  signal: AbortSignal,
  workspacePath: string,
): Promise<void> {
  if (process.platform === "win32") {
    throw new CodexSessionCapabilityError(
      "WindowsではTaskHub用権限プロファイルを検査できません。",
    );
  }
  const params = permissionProfileListParamsSchema.parse({
    cwd: workspacePath,
    limit: 1_000,
  });
  const result: PermissionProfileListResult = permissionProfileListResultSchema.parse(
    await connection.listPermissionProfiles(params, signal),
  );
  if (result.nextCursor != null) {
    throw new CodexSessionCapabilityError("権限プロファイル一覧を全件確認できません。");
  }
  const selected = result.data.find((profile) => profile.id === permissionProfileId);
  if (selected == null || selected.allowed !== true) {
    throw new CodexSessionCapabilityError("TaskHub用権限プロファイルが許可されていません。");
  }
}
