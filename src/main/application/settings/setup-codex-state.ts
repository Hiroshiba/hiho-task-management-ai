/** 保存済み初期設定状態からCodex利用可能状態を取得します。 */
export function stateCodexAvailability<TAvailability>(
  state: { readonly kind: string },
  parseAvailability: (value: unknown) => TAvailability,
): TAvailability | undefined {
  if ("context" in state && typeof state.context === "object" && state.context != null) {
    if ("codex" in state.context) {
      return parseAvailability(state.context.codex);
    }
  }
  if ("codex" in state) {
    return parseAvailability(state.codex);
  }
  if (state.kind === "created") {
    return undefined;
  }
  throw new Error("保存済みCodex状態がありません。");
}

/** Codex利用可能状態を現在の初期設定状態へ反映します。 */
export function updateStateCodexAvailability<TState extends { readonly kind: string }, TAvailability>(
  state: TState,
  availability: TAvailability,
  dependencies: {
    readonly parseAvailability: (value: unknown) => TAvailability;
    readonly parseState: (value: unknown) => TState;
  },
): TState {
  const validatedAvailability = dependencies.parseAvailability(availability);
  switch (state.kind) {
    case "created":
    case "codex_cli_ready":
      throw new Error("現在の初回設定状態ではCodex認証を完了できません。");
    case "codex_authentication_required":
      return dependencies.parseState({
        kind: "credentials_required",
        step: "credentials",
        codex: validatedAvailability,
      });
    case "credentials_required":
    case "asana_authorization_pending":
    case "workspace_listing_required":
    case "workspace_selection_required":
    case "project_selection_required":
    case "project_requires_action":
    case "resources_requires_action":
      return dependencies.parseState({
        ...state,
        codex: validatedAvailability,
      });
    case "resources_ready":
    case "asana_capability_failed":
    case "vault_choice_required":
    case "full_sync_required":
    case "codex_capability_required":
    case "ready": {
      if (!("context" in state) || typeof state.context !== "object" || state.context == null) {
        throw new Error("保存済みCodex状態がありません。");
      }
      return dependencies.parseState({
        ...state,
        context: {
          ...state.context,
          codex: validatedAvailability,
        },
      });
    }
  }
  throw new Error("保存済みCodex状態がありません。");
}
