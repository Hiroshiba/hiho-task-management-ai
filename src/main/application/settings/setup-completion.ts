type SetupContext<TSectionGids, TCodex> = {
  readonly device_id: string;
  readonly client_id: string;
  readonly workspace_gid: string;
  readonly project_gid: string;
  readonly section_gids: TSectionGids;
  readonly codex: TCodex;
};

/** Vault選択を保存し外部ツール設定へ進む状態を生成します。 */
export async function chooseSetupVault<
  TState,
  TMapping,
  TVault extends { readonly vault_id: string; readonly real_path: string },
  TContext,
>(
  input: { readonly kind: "skip" } | { readonly kind: "configure"; readonly mapping: TMapping },
  context: TContext,
  signal: AbortSignal,
  dependencies: {
    readonly validatePath: (mapping: TMapping, signal: AbortSignal) => Promise<TVault>;
    readonly parseMapping: (value: unknown) => {
      readonly vault_id: string;
      readonly absolute_path: string;
    };
    readonly saveMapping: (mapping: { readonly vault_id: string; readonly absolute_path: string }) => void;
    readonly parseState: (value: unknown) => TState;
  },
): Promise<TState> {
  if (input.kind === "configure") {
    const validatedVault = await dependencies.validatePath(input.mapping, signal);
    signal.throwIfAborted();
    const mapping = dependencies.parseMapping({
      vault_id: validatedVault.vault_id,
      absolute_path: validatedVault.real_path,
    });
    dependencies.saveMapping(mapping);
    return dependencies.parseState({
      kind: "vault_configured",
      step: "external_tool",
      context,
      vault_id: mapping.vault_id,
    });
  }
  return dependencies.parseState({
    kind: "vault_skipped",
    step: "external_tool",
    context,
  });
}

/** フル同期の前後の状態を保存してCodex能力検査へ進みます。 */
export async function runSetupFullSync<
  TState,
  TSelectionState extends { readonly context: TContext },
  TContext extends SetupContext<{
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  }, { readonly kind: string }>,
  TExternalTool,
  TFullSyncInput,
>(
  state: TSelectionState,
  signal: AbortSignal,
  dependencies: {
    readonly selectExternalTool: (state: TSelectionState) => TExternalTool;
    readonly parseState: (value: unknown) => TState;
    readonly setState: (state: TState) => void;
    readonly saveCheckpoint: (state: TState) => void;
    readonly parseFullSyncInput: (value: unknown) => TFullSyncInput;
    readonly fullSync: (input: TFullSyncInput, signal: AbortSignal) => Promise<void>;
    readonly getState: () => TState;
  },
): Promise<TState> {
  const externalTool = dependencies.selectExternalTool(state);
  const runningState = dependencies.parseState({
    kind: "full_sync_required",
    step: "full_sync",
    context: state.context,
    external_tool: externalTool,
  });
  dependencies.setState(runningState);
  dependencies.saveCheckpoint(runningState);
  const fullSyncInput = dependencies.parseFullSyncInput({
    device_id: state.context.device_id,
    client_id: state.context.client_id,
    workspace_gid: state.context.workspace_gid,
    project_gid: state.context.project_gid,
    section_gids: state.context.section_gids,
  });
  await dependencies.fullSync(fullSyncInput, signal);
  dependencies.setState(dependencies.parseState({
    kind: "codex_capability_required",
    step: "codex_capability",
    context: state.context,
    external_tool: externalTool,
  }));
  return dependencies.getState();
}

/** Codex能力検査を実行して端末設定とready状態を保存します。 */
export async function completeSetupCodexCapability<
  TState,
  TContext extends SetupContext<{
    readonly not_started: string;
    readonly in_progress: string;
    readonly completed: string;
    readonly withdrawn: string;
  }, TCodex>,
  TCodex extends { readonly kind: string },
  TExternalTool,
>(
  state: { readonly context: TContext; readonly external_tool: TExternalTool },
  signal: AbortSignal,
  dependencies: {
    readonly checkCapabilities: (signal: AbortSignal) => Promise<TCodex>;
    readonly parseAvailability: (value: unknown) => TCodex;
    readonly saveDeviceSettings: (settings: {
      readonly device_id: string;
      readonly client_id: string;
      readonly workspace_gid: string;
      readonly project_gid: string;
      readonly section_gids: TContext["section_gids"];
    }) => void;
    readonly parseState: (value: unknown) => TState;
  },
): Promise<TState> {
  const availability = state.context.codex.kind === "unavailable"
    ? state.context.codex
    : dependencies.parseAvailability(await dependencies.checkCapabilities(signal));
  dependencies.saveDeviceSettings({
    device_id: state.context.device_id,
    client_id: state.context.client_id,
    workspace_gid: state.context.workspace_gid,
    project_gid: state.context.project_gid,
    section_gids: state.context.section_gids,
  });
  return dependencies.parseState({
    kind: "ready",
    step: "ready",
    context: { ...state.context, codex: availability },
    external_tool: state.external_tool,
  });
}
