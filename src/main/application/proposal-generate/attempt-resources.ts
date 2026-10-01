export type AttemptResourceState =
  | { readonly kind: "inactive" }
  | { readonly kind: "snapshot_frozen" };

type AttemptDependencies<TInput, TCommit> = {
  readonly performTurnAttempt: (
    input: TInput,
    updateResources: (resources: AttemptResourceState) => void,
  ) => Promise<TCommit>;
  readonly releaseTaskctlSnapshot: () => void;
  readonly WorkflowError: new (message: string, cause?: unknown) => Error;
};

/** ターン資源の解放を待って実行結果を返します。 */
export async function runTurnAttemptWithResources<TInput, TCommit>(
  input: TInput,
  dependencies: AttemptDependencies<TInput, TCommit>,
): Promise<TCommit> {
  const resources: { current: AttemptResourceState } = { current: { kind: "inactive" } };
  let execution:
    | { readonly kind: "succeeded"; readonly commit: TCommit }
    | { readonly kind: "failed"; readonly error: unknown };
  try {
    execution = {
      kind: "succeeded",
      commit: await dependencies.performTurnAttempt(input, (nextResources) => {
        resources.current = nextResources;
      }),
    };
  } catch (error: unknown) {
    execution = { kind: "failed", error };
  }
  let cleanupError: unknown;
  if (resources.current.kind === "snapshot_frozen") {
    try {
      dependencies.releaseTaskctlSnapshot();
    } catch (error: unknown) {
      cleanupError = error;
    }
  }
  if (execution.kind === "failed") {
    if (cleanupError == null) {
      throw execution.error;
    }
    throw new dependencies.WorkflowError(
      "AIターンの失敗後にターン資源を解放できませんでした。",
      new AggregateError(
        [execution.error, cleanupError],
        "AIターンとターン資源の解放に失敗しました。",
        { cause: execution.error },
      ),
    );
  }
  if (cleanupError != null) {
    throw new dependencies.WorkflowError("AIターン資源を解放できませんでした。", cleanupError);
  }
  return execution.commit;
}
