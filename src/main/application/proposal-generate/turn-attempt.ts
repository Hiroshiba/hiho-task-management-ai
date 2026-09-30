import type { AttemptResourceState } from "./attempt-resources";

/** 状態記録とCodexターンを実行し、固定基準値と応答を返します。 */
export async function runSessionTurn<
  TSnapshot,
  TTrusted,
  TPrepared extends { readonly snapshot: TSnapshot; readonly trusted_status_evidence: readonly TTrusted[] },
  TWorkspace,
  TTurnInput,
  TResponse,
  TExternal,
>(
  input: {
    readonly attemptId: string;
    readonly signal: AbortSignal;
    readonly workspaceState: { value?: TWorkspace };
  },
  dependencies: {
    readonly beginTurn: (attemptId: string, signal: AbortSignal) => void | PromiseLike<void>;
    readonly startTurn: (factory: (signal: AbortSignal) => Promise<TTurnInput>, signal: AbortSignal) => Promise<{ readonly turnId: string; readonly response: TResponse }>;
    readonly createTurnInput: (
      signal: AbortSignal,
      markPrepared: (prepared: TPrepared, workspace: TWorkspace) => void,
    ) => Promise<TTurnInput>;
    readonly finishTurn: (attemptId: string, signal: AbortSignal) => readonly TExternal[] | PromiseLike<readonly TExternal[]>;
    readonly parseExternalEvidence: (value: readonly TExternal[]) => readonly TExternal[];
    readonly createTrustedStatusEvidence: (snapshot: TSnapshot, external: readonly TExternal[]) => readonly TTrusted[];
    readonly updateResources: (resources: AttemptResourceState) => void;
    readonly SyncError: new (cause: unknown) => Error;
    readonly StateError: new (message: string) => Error;
  },
): Promise<{ readonly prepared: TPrepared; readonly turnId: string; readonly response: TResponse; readonly workspace: TWorkspace }> {
  const preparedState: {
    current: { readonly kind: "pending" } | { readonly kind: "ready"; readonly value: TPrepared };
  } = { current: { kind: "pending" } };
  await dependencies.beginTurn(input.attemptId, input.signal);
  dependencies.updateResources({ kind: "collector_active", attemptId: input.attemptId });
  const sessionTurnResult = await dependencies.startTurn(
    async (turnSignal) => {
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
    },
    input.signal,
  );
  if (preparedState.current.kind !== "ready") {
    throw new dependencies.SyncError(new Error("同期後の基準値が作成されませんでした。"));
  }
  const prepared = preparedState.current.value;
  const externalEvidence = dependencies.parseExternalEvidence(
    await dependencies.finishTurn(input.attemptId, input.signal),
  );
  dependencies.updateResources({ kind: "snapshot_frozen", attemptId: input.attemptId });
  const turnPrepared = {
    ...prepared,
    trusted_status_evidence: dependencies.createTrustedStatusEvidence(
      prepared.snapshot, externalEvidence,
    ),
  };
  const workspace = input.workspaceState.value;
  if (workspace == null) {
    throw new dependencies.StateError("AI変更案ワークスペースが作成されませんでした。");
  }
  return { prepared: turnPrepared, turnId: sessionTurnResult.turnId, response: sessionTurnResult.response, workspace };
}
