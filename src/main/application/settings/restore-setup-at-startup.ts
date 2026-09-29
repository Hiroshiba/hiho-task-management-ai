type SetupRestorationDependencies<State extends { readonly kind: string }> = {
  readonly getSetupState: () => State;
  readonly isOnline: () => boolean;
  readonly restoreReadyDeviceSettings: () => void;
  readonly startSetup: (signal: AbortSignal) => Promise<State>;
  readonly restoreCodexSession: (signal: AbortSignal) => Promise<State>;
  readonly isContextState: (state: State) => boolean;
  readonly resumeSetup: (state: State, signal: AbortSignal) => Promise<State>;
  readonly configureAsanaFromStoredSettings: () => void;
  readonly configureContextFromState: (state: State) => void;
};

/** 起動時の保存済み設定を復元してready状態を判定します。 */
export async function restoreSetupAtStartup<State extends { readonly kind: string }>(
  dependencies: SetupRestorationDependencies<State>,
  signal: AbortSignal,
): Promise<{ readonly state: State; readonly ready: boolean }> {
  let state = dependencies.getSetupState();
  const readyCheckpointOffline = state.kind === "ready" && !dependencies.isOnline();
  if (state.kind === "ready") {
    dependencies.restoreReadyDeviceSettings();
  }
  if (state.kind === "created" || state.kind === "codex_cli_ready") {
    state = await dependencies.startSetup(signal);
  } else if (!readyCheckpointOffline) {
    state = await dependencies.restoreCodexSession(signal);
    if (state.kind === "resources_requires_action" || dependencies.isContextState(state)) {
      state = await dependencies.resumeSetup(state, signal);
    }
  }
  dependencies.configureAsanaFromStoredSettings();
  dependencies.configureContextFromState(state);
  return { state, ready: state.kind === "ready" };
}

/** 保存済み設定の再照合失敗時に表示可能なready状態を判定します。 */
export async function resumeSetupAtStartup<State extends { readonly kind: string }>(
  state: State,
  signal: AbortSignal,
  dependencies: {
    readonly parseState: (value: unknown) => State;
    readonly resume: (signal: AbortSignal) => Promise<State>;
    readonly rethrowAbort: (error: unknown, signal: AbortSignal) => void;
    readonly canResumeReadyStateAfterFailure: (error: unknown) => boolean;
    readonly recordFailure: (error: unknown) => void;
  },
): Promise<State> {
  const validatedState = dependencies.parseState(state);
  try {
    return dependencies.parseState(await dependencies.resume(signal));
  } catch (error: unknown) {
    dependencies.rethrowAbort(error, signal);
    if (
      validatedState.kind !== "ready"
      || !dependencies.canResumeReadyStateAfterFailure(error)
    ) {
      throw error;
    }
    dependencies.recordFailure(error);
    return validatedState;
  }
}
