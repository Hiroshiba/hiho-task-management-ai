export type AttemptResourceState =
  | { readonly kind: "inactive" }
  | { readonly kind: "collector_active"; readonly attemptId: string }
  | {
      readonly kind: "collector_active_snapshot_frozen";
      readonly attemptId: string;
    }
  | { readonly kind: "snapshot_frozen"; readonly attemptId: string };

type AttemptExecution<TCommit> =
  | { readonly kind: "succeeded"; readonly commit: TCommit }
  | { readonly kind: "failed"; readonly error: unknown };

type AttemptDependencies<TInput, TCommit> = {
  readonly performTurnAttempt: (input: TInput, updateResources: (resources: AttemptResourceState) => void) => Promise<TCommit>;
  readonly cancelTurn: (attemptId: string) => void | PromiseLike<void>;
  readonly releaseTaskctlSnapshot: () => void;
  readonly WorkflowError: new (message: string, cause?: unknown) => Error;
};

/** ターン資源の解放を待って実行結果を返します。 */
export async function runTurnAttemptWithResources<TInput, TCommit>(
  input: TInput,
  dependencies: AttemptDependencies<TInput, TCommit>,
): Promise<TCommit> {

    let resources: AttemptResourceState = { kind: "inactive" };
    let execution: AttemptExecution<TCommit>;
    try {
      execution = {
        kind: "succeeded",
        commit: await dependencies.performTurnAttempt(input, (nextResources) => {
          resources = nextResources;
        }),
      };
    } catch (error: unknown) {
      execution = { kind: "failed", error };
    }
    const cleanupErrors = await releaseAttemptResources(resources, dependencies);
    if (execution.kind === "failed") {
      if (cleanupErrors.length === 0) {
        throw execution.error;
      }
      throw new dependencies.WorkflowError(
        "AIターンの失敗後にターン資源を解放できませんでした。",
        new AggregateError(
          [execution.error, ...cleanupErrors],
          "AIターンとターン資源の解放に失敗しました。",
          { cause: execution.error },
        ),
      );
    }
    if (cleanupErrors.length === 1) {
      const cleanupError = cleanupErrors[0];
      if (cleanupError == null) {
        throw new Error("ターン資源の解放エラーを取得できません。");
      }
      throw new dependencies.WorkflowError("AIターン資源を解放できませんでした。", cleanupError);
    }
    if (cleanupErrors.length > 1) {
      const cleanupError = cleanupErrors[0];
      if (cleanupError == null) {
        throw new Error("ターン資源の解放エラーを取得できません。");
      }
      throw new AggregateError(
        cleanupErrors,
        "ターン資源の解放に失敗しました。",
        { cause: cleanupError },
      );
    }
    return execution.commit;
}

async function releaseAttemptResources<TInput, TCommit>(
  resources: AttemptResourceState,
  dependencies: AttemptDependencies<TInput, TCommit>,
): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (
      resources.kind === "collector_active"
      || resources.kind === "collector_active_snapshot_frozen"
    ) {
      try {
        await dependencies.cancelTurn(
          resources.attemptId,
        );
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (
      resources.kind === "snapshot_frozen"
      || resources.kind === "collector_active_snapshot_frozen"
    ) {
      try {
        dependencies.releaseTaskctlSnapshot();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    return errors;
}
