/** Codexターンを実行し、固定基準値と応答を返します。 */
export async function runSessionTurn<TPrepared, TWorkspace, TTurnInput, TResponse>(
  input: {
    readonly signal: AbortSignal;
    readonly workspaceState: { value?: TWorkspace };
  },
  dependencies: {
    readonly startTurn: (
      factory: (signal: AbortSignal) => Promise<TTurnInput>,
      signal: AbortSignal,
    ) => Promise<{ readonly turnId: string; readonly response: TResponse }>;
    readonly createTurnInput: (
      signal: AbortSignal,
      markPrepared: (prepared: TPrepared, workspace: TWorkspace) => void,
    ) => Promise<TTurnInput>;
    readonly SyncError: new (cause: unknown) => Error;
    readonly StateError: new (message: string) => Error;
  },
): Promise<{
  readonly prepared: TPrepared;
  readonly turnId: string;
  readonly response: TResponse;
  readonly workspace: TWorkspace;
}> {
  const preparedState: {
    current: { readonly kind: "pending" } | { readonly kind: "ready"; readonly value: TPrepared };
  } = { current: { kind: "pending" } };
  const sessionTurnResult = await dependencies.startTurn(async (turnSignal) => {
    try {
      return await dependencies.createTurnInput(turnSignal, (prepared, workspace) => {
        preparedState.current = { kind: "ready", value: prepared };
        input.workspaceState.value = workspace;
      });
    } catch (error: unknown) {
      if (error instanceof dependencies.SyncError) {
        throw error;
      }
      throw new dependencies.SyncError(error);
    }
  }, input.signal);
  if (preparedState.current.kind !== "ready") {
    throw new dependencies.SyncError(new Error("同期後の基準値が作成されませんでした。"));
  }
  const workspace = input.workspaceState.value;
  if (workspace == null) {
    throw new dependencies.StateError("AI変更案ワークスペースが作成されませんでした。");
  }
  return {
    prepared: preparedState.current.value,
    turnId: sessionTurnResult.turnId,
    response: sessionTurnResult.response,
    workspace,
  };
}
