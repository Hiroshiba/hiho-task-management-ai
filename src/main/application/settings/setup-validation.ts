export type ResourceCheck =
  | { readonly kind: "duplicate"; readonly required: { readonly name: string } }
  | {
      readonly kind: "renamed";
      readonly required: { readonly name: string };
      readonly configured_gid: string;
    }
  | {
      readonly kind: "missing";
      readonly required: { readonly name: string };
      readonly configured_gid?: string | undefined;
    }
  | { readonly kind: "matched"; readonly required: { readonly name: string } };

type ResourceIssue = {
  readonly resource: "section" | "tag";
  readonly name: string;
  readonly reason: "duplicate" | "renamed" | "configured_missing";
  readonly configured_gid?: string;
};

/** 初期設定の中断シグナルを検証します。 */
export function validateAbortSignal(signal: AbortSignal): void {
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

/** 初期設定portの関数を検証します。 */
export function validateFunction(value: unknown, message: string): void {
  if (typeof value !== "function") {
    throw new TypeError(message);
  }
}

/** 初期設定に必要なportの関数を順に検証します。 */
export function validateSetupPorts(options: {
  readonly codex: {
    readonly detectCli: unknown;
    readonly getAuthenticationState: unknown;
    readonly completeAuthentication: unknown;
    readonly checkCapabilities: unknown;
  };
  readonly oauth: {
    readonly beginInitialOutOfBandAuthorization: unknown;
    readonly completeOutOfBandAuthorization: unknown;
    readonly cancelOutOfBandAuthorization: unknown;
    readonly getOutOfBandState: unknown;
  };
  readonly asana: {
    readonly listCurrentUserWorkspaces: unknown;
    readonly listWorkspaceProjects: unknown;
    readonly createProject: unknown;
  };
  readonly resources: { readonly coordinate: unknown };
  readonly capability: { readonly check: unknown };
  readonly reportCapabilityFailure: unknown;
  readonly database: {
    readonly saveDeviceSettings: unknown;
    readonly getDeviceSettings: unknown;
    readonly saveVaultMapping: unknown;
    readonly getVaultMappings: unknown;
  };
  readonly checkpoint: { readonly load: unknown; readonly save: unknown };
  readonly externalTool: {
    readonly configureDiscord: unknown;
    readonly deactivateDiscord: unknown;
  };
  readonly fullSync: unknown;
}): void {
  validateFunction(options.codex.detectCli, "Codex CLI検出関数が必要です。");
  validateFunction(options.codex.getAuthenticationState, "Codex認証状態関数が必要です。");
  validateFunction(options.codex.completeAuthentication, "Codex認証完了関数が必要です。");
  validateFunction(options.codex.checkCapabilities, "Codex能力検査関数が必要です。");
  validateFunction(
    options.oauth.beginInitialOutOfBandAuthorization,
    "Asana OAuth開始関数が必要です。",
  );
  validateFunction(
    options.oauth.completeOutOfBandAuthorization,
    "Asana OAuth完了関数が必要です。",
  );
  validateFunction(
    options.oauth.cancelOutOfBandAuthorization,
    "Asana OAuth取消関数が必要です。",
  );
  validateFunction(
    options.oauth.getOutOfBandState,
    "Asana OAuth状態取得関数が必要です。",
  );
  validateFunction(options.asana.listCurrentUserWorkspaces, "ワークスペース取得関数が必要です。");
  validateFunction(options.asana.listWorkspaceProjects, "プロジェクト取得関数が必要です。");
  validateFunction(options.asana.createProject, "プロジェクト作成関数が必要です。");
  validateFunction(options.resources.coordinate, "リソース調整関数が必要です。");
  validateFunction(options.capability.check, "能力検査関数が必要です。");
  validateFunction(options.reportCapabilityFailure, "能力検査失敗の診断関数が必要です。");
  validateFunction(options.database.saveDeviceSettings, "端末設定保存関数が必要です。");
  validateFunction(options.database.getDeviceSettings, "端末設定取得関数が必要です。");
  validateFunction(options.database.saveVaultMapping, "Vault保存関数が必要です。");
  validateFunction(options.database.getVaultMappings, "Vault一覧取得関数が必要です。");
  validateFunction(options.checkpoint.load, "初回設定チェックポイント取得関数が必要です。");
  validateFunction(options.checkpoint.save, "初回設定チェックポイント保存関数が必要です。");
  validateFunction(options.externalTool.configureDiscord, "Discord外部ツール設定関数が必要です。");
  validateFunction(options.externalTool.deactivateDiscord, "Discord外部ツール無効化関数が必要です。");
  validateFunction(options.fullSync, "フル同期関数が必要です。");
}

/** 初期設定状態が指定した手順にあることを検証します。 */
export function assertStateKindTyped<TState extends { readonly kind: string }, K extends TState["kind"]>(
  state: TState,
  kinds: readonly K[],
): asserts state is Extract<TState, { kind: K }> {
  for (const kind of kinds) {
    if (kind === state.kind) {
      return;
    }
  }
  throw new Error("初期設定の手順順序が不正です。");
}

/** ワークスペース応答を検証し、GIDの重複を拒否します。 */
export function parseWorkspaces<TWorkspace extends { readonly gid: string }>(
  values: readonly unknown[],
  parseWorkspace: (value: unknown) => TWorkspace,
): TWorkspace[] {
  const workspaces = values.map((value) => parseWorkspace(value));
  const gids = new Set<string>();
  for (const workspace of workspaces) {
    if (gids.has(workspace.gid)) {
      throw new Error("ワークスペースGIDが重複しています。");
    }
    gids.add(workspace.gid);
  }
  if (workspaces.length === 0) {
    throw new Error("利用可能なワークスペースがありません。");
  }
  return workspaces;
}

/** プロジェクト応答を検証し、GIDの重複を拒否します。 */
export function parseProjects<TProject extends { readonly gid: string }>(
  values: readonly unknown[],
  parseProject: (value: unknown) => TProject,
): TProject[] {
  const projects = values.map((value) => parseProject(value));
  const gids = new Set<string>();
  for (const project of projects) {
    if (gids.has(project.gid)) {
      throw new Error("プロジェクトGIDが重複しています。");
    }
    gids.add(project.gid);
  }
  return projects;
}

/** Asanaリソース照合の要対応結果を画面用の理由へ変換します。 */
export function mapResourceIssues(
  reconciliation: {
    readonly kind: "requires_action" | "ready";
    readonly sections: readonly ResourceCheck[];
    readonly tags: readonly ResourceCheck[];
  },
): ResourceIssue[] {
  if (reconciliation.kind !== "requires_action") {
    throw new Error("初期設定リソースの要対応結果が不正です。");
  }
  const issues: ResourceIssue[] = [];
  for (const check of reconciliation.sections) {
    if (check.kind === "duplicate") {
      issues.push({ resource: "section", name: check.required.name, reason: "duplicate" });
    } else if (check.kind === "renamed") {
      issues.push({
        resource: "section",
        name: check.required.name,
        reason: "renamed",
        configured_gid: check.configured_gid,
      });
    } else if (check.kind === "missing" && check.configured_gid != null) {
      issues.push({
        resource: "section",
        name: check.required.name,
        reason: "configured_missing",
        configured_gid: check.configured_gid,
      });
    }
  }
  for (const check of reconciliation.tags) {
    if (check.kind === "duplicate") {
      issues.push({ resource: "tag", name: check.required.name, reason: "duplicate" });
    } else if (check.kind === "renamed") {
      issues.push({
        resource: "tag",
        name: check.required.name,
        reason: "renamed",
        configured_gid: check.configured_gid,
      });
    } else if (check.kind === "missing" && check.configured_gid != null) {
      issues.push({
        resource: "tag",
        name: check.required.name,
        reason: "configured_missing",
        configured_gid: check.configured_gid,
      });
    }
  }
  if (issues.length === 0) {
    throw new Error("初期設定リソースの要対応理由を確定できません。");
  }
  return issues;
}

/** 保存済みリソースのセクションGIDが一致するか検査します。 */
export function sameSectionGids(
  first: {
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  },
  second: {
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  },
): boolean {
  return (
    first.not_started === second.not_started
    && first.in_progress === second.in_progress
    && first.completed === second.completed
    && first.withdrawn === second.withdrawn
  );
}

/** 保存済みリソースのタグGIDが一致するか検査します。 */
export function sameTagGids(
  first: {
    readonly importance_1: string;
    readonly importance_2: string;
    readonly importance_3: string;
    readonly importance_4: string;
    readonly importance_5: string;
    readonly area_unclassified: string;
    readonly block_none: string;
    readonly block_partial: string;
    readonly block_full: string;
  },
  second: {
    readonly importance_1: string;
    readonly importance_2: string;
    readonly importance_3: string;
    readonly importance_4: string;
    readonly importance_5: string;
    readonly area_unclassified: string;
    readonly block_none: string;
    readonly block_partial: string;
    readonly block_full: string;
  },
): boolean {
  return (
    first.importance_1 === second.importance_1
    && first.importance_2 === second.importance_2
    && first.importance_3 === second.importance_3
    && first.importance_4 === second.importance_4
    && first.importance_5 === second.importance_5
    && first.area_unclassified === second.area_unclassified
    && first.block_none === second.block_none
    && first.block_partial === second.block_partial
    && first.block_full === second.block_full
  );
}

/** 保存済み状態のAsanaリソース再照合が必要か判定します。 */
export function requiresContextRevalidation(state: { readonly kind: string }): boolean {
  return [
    "resources_requires_action",
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
  ].includes(state.kind);
}
