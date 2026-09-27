type ExternalToolChoice =
  | { readonly kind: "skip" }
  | {
      readonly kind: "configure_discord";
      readonly bot_token: string;
      readonly allowed_channel_ids: readonly string[];
    };

type ExternalToolConfigurationResult =
  | {
      readonly kind: "configured";
      readonly tool_id: "discord-context";
      readonly allowed_channel_ids: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason_code: string };

type ExternalToolDeactivationResult =
  | { readonly kind: "deactivated" }
  | { readonly kind: "unavailable"; readonly reason_code: string };

type ExternalToolSelection =
  | { readonly kind: "skipped" }
  | {
      readonly kind: "configured";
      readonly tool_id: "discord-context";
      readonly allowed_channel_ids: readonly string[];
    }
  | { readonly kind: "unavailable"; readonly reason_code: string };

type SelectionState<TSelection extends ExternalToolSelection> =
  | { readonly kind: "external_tool_skipped" }
  | {
      readonly kind: "external_tool_configured";
      readonly tool_id: "discord-context";
      readonly allowed_channel_ids: readonly string[];
    }
  | { readonly kind: "external_tool_unavailable"; readonly reason_code: string }
  | {
      readonly kind: "full_sync_required" | "codex_capability_required" | "ready";
      readonly external_tool: TSelection;
    };

/** 保存済み初期設定状態から外部ツール選択を取得します。 */
export function externalToolSelectionFromState<TSelection extends ExternalToolSelection>(
  state: SelectionState<TSelection>,
  parseSelection: (value: unknown) => TSelection,
): TSelection {
  switch (state.kind) {
    case "external_tool_skipped":
      return parseSelection({ kind: "skipped" });
    case "external_tool_configured":
      return parseSelection({
        kind: "configured",
        tool_id: state.tool_id,
        allowed_channel_ids: state.allowed_channel_ids,
      });
    case "external_tool_unavailable":
      return parseSelection({
        kind: "unavailable",
        reason_code: state.reason_code,
      });
    case "full_sync_required":
    case "codex_capability_required":
    case "ready":
      return parseSelection(state.external_tool);
  }
}

/** Discord設定の確定と失敗時の安全な無効化を実行します。 */
export async function chooseSetupExternalTool<
  TState extends { readonly kind: string },
  TContext,
  TConfiguration,
  TConfigurationResult extends ExternalToolConfigurationResult,
  TDeactivationResult extends ExternalToolDeactivationResult,
>(
  previousState: {
    readonly kind: "vault_skipped" | "vault_configured";
    readonly context: TContext;
  },
  choice: ExternalToolChoice,
  signal: AbortSignal,
  dependencies: {
    readonly parseConfiguration: (value: unknown) => TConfiguration;
    readonly configureDiscord: (
      input: TConfiguration,
      signal: AbortSignal,
    ) => Promise<TConfigurationResult>;
    readonly parseConfigurationResult: (value: unknown) => TConfigurationResult;
    readonly deactivateDiscord: (signal: AbortSignal) => Promise<TDeactivationResult>;
    readonly parseDeactivationResult: (value: unknown) => TDeactivationResult;
    readonly parseState: (value: unknown) => TState;
    readonly saveCheckpoint: (state: TState) => void;
  },
): Promise<TState> {
  let nextState: TState;
  if (choice.kind === "configure_discord") {
    const configuration = dependencies.parseConfiguration({
      bot_token: choice.bot_token,
      allowed_channel_ids: choice.allowed_channel_ids,
    });
    const result = dependencies.parseConfigurationResult(
      await dependencies.configureDiscord(configuration, signal),
    );
    if (result.kind === "configured") {
      nextState = dependencies.parseState({
        kind: "external_tool_configured",
        step: "full_sync",
        context: previousState.context,
        tool_id: result.tool_id,
        allowed_channel_ids: result.allowed_channel_ids,
      });
    } else {
      const deactivation = dependencies.parseDeactivationResult(
        await dependencies.deactivateDiscord(signal),
      );
      const reasonCode = deactivation.kind === "unavailable"
        ? deactivation.reason_code
        : result.reason_code;
      nextState = dependencies.parseState({
        kind: "external_tool_unavailable",
        step: "full_sync",
        context: previousState.context,
        reason_code: reasonCode,
      });
    }
  } else {
    nextState = dependencies.parseState({
      kind: "external_tool_skipped",
      step: "full_sync",
      context: previousState.context,
    });
  }
  if (
    nextState.kind !== "external_tool_skipped"
    && nextState.kind !== "external_tool_configured"
    && nextState.kind !== "external_tool_unavailable"
  ) {
    throw new Error("初期設定の手順順序が不正です。");
  }
  try {
    signal.throwIfAborted();
    dependencies.saveCheckpoint(nextState);
  } catch (error: unknown) {
    if (nextState.kind === "external_tool_skipped") {
      throw error;
    }
    const deactivationSignal = new AbortController().signal;
    let deactivation: TDeactivationResult;
    try {
      deactivation = dependencies.parseDeactivationResult(
        await dependencies.deactivateDiscord(deactivationSignal),
      );
    } catch (deactivationError: unknown) {
      throw new AggregateError(
        [error, deactivationError],
        "外部ツール選択を確定できず安全な無効化も失敗しました。",
        { cause: error },
      );
    }
    if (deactivation.kind === "unavailable") {
      throw new AggregateError(
        [error, new Error("外部ツール選択の確定失敗後にDiscord連携を無効化できませんでした。")],
        "外部ツール選択を確定できず安全な無効化も完了しませんでした。",
        { cause: error },
      );
    }
    throw error;
  }
  return nextState;
}
