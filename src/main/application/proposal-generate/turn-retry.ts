type RetryInput<TProposal> = {
  readonly signal: AbortSignal;
  readonly logicalTurnId: string;
  readonly retryProposal: TProposal | undefined;
};

/** AbortSignalを検証して中断を通知する関数を組み立てます。 */
export function createAbortGuard(
  WorkflowError: new (message: string) => Error,
): (signal: AbortSignal) => void {
  return (signal) => {
    if (
      signal == null
      || typeof signal.aborted !== "boolean"
      || typeof signal.addEventListener !== "function"
      || typeof signal.removeEventListener !== "function"
    ) {
      throw new TypeError("AbortSignalが必要です。");
    }
    if (signal.aborted) {
      throw new WorkflowError("AIワークフローが中断されました。");
    }
  };
}

type RetryPromptContext<TValidationErrors> =
  | { readonly kind: "initial" }
  | { readonly kind: "correction"; readonly validationErrors: TValidationErrors; readonly failedAttempt: number };

type RetryAttemptInput<TInput, TProposal, TWorkspace, TValidationErrors> = TInput & {
  readonly retryProposal: TProposal | undefined;
  readonly attempt: number;
  readonly retryPromptContext: RetryPromptContext<TValidationErrors>;
  readonly workspaceState: { value?: TWorkspace };
};

type RetryLogResult =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly error: unknown };

type RetryDependencies<TInput, TCommit, TProposal, TWorkspace, TFailure extends Error & { readonly candidateDigest: TCandidateDigest }, TCandidateDigest, TPreviousDigest, TValidationErrors> = {
  readonly maximumRetryAttempts: number;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly logRetryEvent: (severity: "warning" | "error", logicalTurnId: string, attempt: number, failure: TFailure, previousDigest: TPreviousDigest, decision: "retry" | "stop") => RetryLogResult;
  readonly executeAttempt: (input: RetryAttemptInput<TInput, TProposal, TWorkspace, TValidationErrors>) => Promise<TCommit>;
  readonly responseError: (error: unknown) => unknown;
  readonly isDisposition: (error: unknown) => boolean;
  readonly isSyncError: (error: unknown) => boolean;
  readonly makeSyncError: (error: unknown) => Error;
  readonly classifyRetryFailure: (error: unknown) => { readonly kind: "retryable"; readonly failure: TFailure } | { readonly kind: "not_retryable" };
  readonly initialPreviousDigest: () => TPreviousDigest;
  readonly previousDigestFromCandidate: (digest: TCandidateDigest) => TPreviousDigest;
  readonly createValidationErrorsDocument: (attempt: number, failure: TFailure, previousDigest: TPreviousDigest) => TValidationErrors;
  readonly makeFinalFailure: (failure: TFailure) => Error;
  readonly makeRecordedFailure: (error: Error) => Error;
  readonly readRetryProposal: (workspace: TWorkspace) => TProposal | undefined;
};

/** 訂正再試行を実行し、失敗原因を一つの結果へ保持します。 */
export async function executeTurnWithRetry<
  TInput extends RetryInput<TProposal>,
  TCommit,
  TProposal,
  TWorkspace,
  TFailure extends Error & { readonly candidateDigest: TCandidateDigest },
  TCandidateDigest,
  TPreviousDigest,
  TValidationErrors,
>(
  input: TInput,
  dependencies: RetryDependencies<TInput, TCommit, TProposal, TWorkspace, TFailure, TCandidateDigest, TPreviousDigest, TValidationErrors>,
): Promise<{ readonly kind: "succeeded"; readonly commit: TCommit } | { readonly kind: "failed"; readonly error: unknown }> {
    let retryState:
      | { readonly kind: "initial" }
      | { readonly kind: "pending"; readonly failure: TFailure; readonly previousDigest: TPreviousDigest; readonly validationErrors: TValidationErrors; readonly retryProposal: TProposal | undefined; readonly failedAttempt: number } = { kind: "initial" };
    try {
      for (let attempt = 1; attempt <= dependencies.maximumRetryAttempts; attempt += 1) {
        dependencies.throwIfAborted(input.signal);
        if (retryState.kind === "pending") {
          const logResult = dependencies.logRetryEvent("warning", input.logicalTurnId, attempt,
            retryState.failure, retryState.previousDigest, "retry");
          if (logResult.kind === "failed") {
            throw new AggregateError(
              [retryState.failure, logResult.error],
              "訂正再試行の警告を記録できませんでした。",
              { cause: retryState.failure },
            );
          }
        }
        const retryPromptContext: RetryPromptContext<TValidationErrors> = retryState.kind === "initial"
          ? { kind: "initial" }
          : {
              kind: "correction",
              validationErrors: retryState.validationErrors,
              failedAttempt: retryState.failedAttempt,
            };
        const workspaceState: { value?: TWorkspace } = {};
        try {
          const commit = await dependencies.executeAttempt({
            ...input,
            retryProposal: retryState.kind === "pending"
              ? retryState.retryProposal
              : input.retryProposal,
            attempt,
            retryPromptContext,
            workspaceState,
          });
          return { kind: "succeeded", commit };
        } catch (error: unknown) {
          const responseError = dependencies.responseError(error);
          if (dependencies.isSyncError(responseError)) {
            if (dependencies.isDisposition(error)) {
              throw error;
            }
            throw dependencies.makeSyncError(error);
          }
          const classification = dependencies.classifyRetryFailure(error);
          if (classification.kind === "not_retryable") {
            throw error;
          }
          const failure = classification.failure;
          const previousDigest: TPreviousDigest = retryState.kind === "initial"
            ? dependencies.initialPreviousDigest()
            : dependencies.previousDigestFromCandidate(retryState.failure.candidateDigest);
          const validationErrors = dependencies.createValidationErrorsDocument(
            attempt,
            failure,
            previousDigest,
          );
          if (attempt === dependencies.maximumRetryAttempts) {
            const logResult = dependencies.logRetryEvent("error", input.logicalTurnId, attempt,
              failure, previousDigest, "stop");
            const finalFailure = dependencies.makeFinalFailure(failure);
            if (logResult.kind === "failed") {
              throw new AggregateError(
                [finalFailure, logResult.error],
                "AI変更案の最終検証失敗を記録できませんでした。",
                { cause: finalFailure },
              );
            }
            throw dependencies.makeRecordedFailure(finalFailure);
          }
          const workspace = workspaceState.value;
          let retryProposal: TProposal | undefined;
          const workspaceProposal = workspace == null ? undefined : dependencies.readRetryProposal(workspace);
          if (workspaceProposal != null) {
            retryProposal = workspaceProposal;
          } else if (retryState.kind === "pending") {
            retryProposal = retryState.retryProposal;
          } else {
            retryProposal = input.retryProposal;
          }
          retryState = {
            kind: "pending",
            failure,
            previousDigest,
            validationErrors,
            retryProposal,
            failedAttempt: attempt,
          };
        }
      }
      throw new Error("再試行上限を超えてAI変更案の試行が継続しました。");
    } catch (error: unknown) {
      return { kind: "failed", error };
    }
}
