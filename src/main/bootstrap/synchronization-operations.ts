type SynchronizationResult =
  | { readonly kind: "synchronized" }
  | { readonly kind: "rejected"; readonly reason: "offline" | "stopped" }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly error_code: string; readonly cause: unknown };

type PostWriteResult = { readonly kind: "synchronized" | "recovery_required" };
class UnreachableError extends Error {}

type SynchronizationDependencies<
  Result extends SynchronizationResult,
  PostResult extends PostWriteResult,
  FailureCode extends string,
> = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly hasOperationOwner: (signal: AbortSignal) => boolean;
  readonly hasPendingJournal: () => boolean;
  readonly hasIncompleteJournal: () => boolean;
  readonly isJournalRecoveryRunning: () => boolean;
  readonly assertPostWriteSynchronizationReady: (executionId: string) => void;
  readonly recoverJournal: (signal: AbortSignal) => Promise<void>;
  readonly afterLocalStateRefresh: (signal: AbortSignal) => Promise<void>;
  readonly synchronizeCodexAfterAsana: (signal: AbortSignal) => Promise<void>;
  readonly afterGuiEdit: (requiredTaskGids: readonly string[], executionId: string, signal: AbortSignal) => Promise<Result>;
  readonly afterAiApply: (requiredTaskGids: readonly string[], executionId: string, signal: AbortSignal) => Promise<Result>;
  readonly beforeAiTurn: (signal: AbortSignal) => Promise<Result>;
  readonly prepareRecoveredSynchronization: (
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ) => () => Promise<unknown>;
  readonly isSynchronizedResult: (
    result: Result,
  ) => result is Extract<Result, { kind: "synchronized" }>;
  readonly abortedCode: FailureCode;
  readonly classifyError: (error: unknown) =>
    | { readonly kind: "recovery_required"; readonly error_code: FailureCode }
    | { readonly kind: "unexpected" };
  readonly isDiagnosticFailure: (error: unknown) => boolean;
  readonly recoveryRequired: (code: FailureCode) => PostResult;
  readonly recoveryRequiredWithCause: (code: FailureCode, cause: unknown) => PostResult;
  readonly synchronizedPostWrite: () => PostResult;
  readonly fromRuntimeResult: (result: Result) => PostResult;
  readonly recordLocalRefreshFailure: (error: unknown) => void;
};

/** 同期の競合、書き込み後の同期結果、診断抑制を管理します。 */
export class SynchronizationOperations<
  Result extends SynchronizationResult,
  PostResult extends PostWriteResult,
  FailureCode extends string,
> {
  private applicationState: "idle" | "applying" | "synchronizing" = "idle";
  private failureDiagnosticSuppressionCount = 0;

  public constructor(
    private readonly dependencies: SynchronizationDependencies<Result, PostResult, FailureCode>,
  ) {}

  /** 同期失敗の既知診断を呼び出し元で記録すべきかを返します。 */
  public shouldReportKnownFailure(): boolean {
    return this.failureDiagnosticSuppressionCount === 0;
  }

  /** AI変更案の適用状態を保持し、適用結果の競合を反映します。 */
  public async applyProposal<ResultValue>(
    signal: AbortSignal,
    apply: () => Promise<ResultValue>,
    replaceConflicts: (result: ResultValue) => void,
  ): Promise<ResultValue> {
    if (this.applicationState !== "idle") {
      throw new Error("変更案を同時に適用できません。");
    }
    if (!this.dependencies.hasOperationOwner(signal)) {
      throw new Error("変更案適用の実行権を所有していません。");
    }
    this.applicationState = "applying";
    try {
      const result = await apply();
      replaceConflicts(result);
      return result;
    } finally {
      this.applicationState = "idle";
    }
  }

  /** AI適用とジャーナル復旧の状態を確認して同期開始を許可します。 */
  public async beforeSynchronization(signal: AbortSignal, executionId?: string): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    if (executionId != null) {
      if (!this.dependencies.hasOperationOwner(signal)) {
        throw new Error("書き込み後同期の実行権を所有していません。");
      }
      this.dependencies.assertPostWriteSynchronizationReady(executionId);
      return;
    }
    if (this.applicationState === "applying") {
      throw new Error("AI変更案の適用完了前に別の同期を開始できません。");
    }
    if (this.applicationState === "synchronizing") {
      throw new Error("書き込み後の同期中に別の同期を開始できません。");
    }
    await this.dependencies.recoverJournal(signal);
    this.dependencies.throwIfAborted(signal);
    if (this.dependencies.hasPendingJournal() || this.dependencies.hasIncompleteJournal()) {
      throw new Error("未完了のAI適用ジャーナルを復旧するまで同期を開始できません。");
    }
  }

  /** 同期結果の失敗診断を抑えながら成功結果を要求します。 */
  public async requireSynchronizedResult(
    resultPromise: Promise<Result>,
  ): Promise<Extract<Result, { kind: "synchronized" }>> {
    const result = await this.awaitSyncResult(resultPromise);
    if (this.dependencies.isSynchronizedResult(result)) {
      return result;
    }
    if (result.kind === "rejected") {
      throw new Error(
        result.reason === "offline"
          ? "オフライン中はAsana同期を実行できません。"
          : "停止済みのAsana同期ランタイムは実行できません。",
      );
    }
    if (result.kind === "aborted") {
      throw new Error("Asana同期が中断されました。");
    }
    if (result.kind === "failed") {
      throw new Error(`Asana同期に失敗しました。エラーコード: ${result.error_code}`, {
        cause: result.cause,
      });
    }
    throw new UnreachableError("Asana同期結果が不正です。");
  }

  private async awaitSyncResult(resultPromise: Promise<Result>): Promise<Result> {
    this.failureDiagnosticSuppressionCount += 1;
    try {
      return await resultPromise;
    } finally {
      this.failureDiagnosticSuppressionCount -= 1;
    }
  }

  /** 同期成功後にジャーナル、ローカル状態、Codexを更新します。 */
  public async afterSynchronizedState(
    result: Extract<Result, { kind: "synchronized" }>,
    signal: AbortSignal,
  ): Promise<void> {
    void result;
    await this.dependencies.recoverJournal(signal);
    await this.dependencies.afterLocalStateRefresh(signal);
    await this.dependencies.synchronizeCodexAfterAsana(signal);
  }

  /** GUI編集後の同期結果を適用側へ返します。 */
  public async afterGuiEdit(
    requiredTaskGids: readonly string[],
    executionId: string,
    signal: AbortSignal,
  ): Promise<PostResult> {
    if (this.dependencies.isJournalRecoveryRunning()) {
      this.dependencies.assertPostWriteSynchronizationReady(executionId);
      return this.synchronizeRecoveredExecutions(requiredTaskGids, signal);
    }
    return this.resolvePostWriteSynchronization(
      this.dependencies.afterGuiEdit(requiredTaskGids, executionId, signal),
      signal,
    );
  }

  /** AI適用後の同期と適用状態の復元を管理します。 */
  public async afterAiApply(
    requiredTaskGids: readonly string[],
    executionId: string,
    signal: AbortSignal,
  ): Promise<PostResult> {
    if (this.dependencies.isJournalRecoveryRunning()) {
      this.dependencies.assertPostWriteSynchronizationReady(executionId);
      return this.synchronizeRecoveredExecutions(requiredTaskGids, signal);
    }
    if (this.applicationState !== "applying") {
      throw new Error("AI変更案の適用状態が同期開始条件を満たしません。");
    }
    this.applicationState = "synchronizing";
    this.failureDiagnosticSuppressionCount += 1;
    try {
      return await this.resolvePostWriteSynchronization(
        this.dependencies.afterAiApply(requiredTaskGids, executionId, signal),
        signal,
      );
    } finally {
      this.failureDiagnosticSuppressionCount -= 1;
      this.applicationState = "applying";
    }
  }

  private async synchronizeRecoveredExecutions(
    requiredTaskGids: readonly string[],
    signal: AbortSignal,
  ): Promise<PostResult> {
    const coordinate = this.dependencies.prepareRecoveredSynchronization(requiredTaskGids, signal);
    try {
      await coordinate();
    } catch (error: unknown) {
      if (this.dependencies.isDiagnosticFailure(error)) {
        throw error;
      }
      if (signal.aborted) {
        return this.dependencies.recoveryRequired(this.dependencies.abortedCode);
      }
      const classification = this.dependencies.classifyError(error);
      if (classification.kind === "recovery_required") {
        return this.dependencies.recoveryRequiredWithCause(classification.error_code, error);
      }
      throw new Error("AI適用ジャーナル復旧後の同期に失敗しました。", { cause: error });
    }
    const synchronization = this.dependencies.synchronizedPostWrite();
    await this.refreshAuxiliaryStateAfterPostWrite(signal);
    return synchronization;
  }

  private async resolvePostWriteSynchronization(
    resultPromise: Promise<Result>,
    signal: AbortSignal,
  ): Promise<PostResult> {
    let runtimeResult: Result;
    try {
      runtimeResult = await resultPromise;
    } catch (error: unknown) {
      if (this.dependencies.isDiagnosticFailure(error)) {
        throw error;
      }
      if (signal.aborted) {
        return this.dependencies.recoveryRequired(this.dependencies.abortedCode);
      }
      const classification = this.dependencies.classifyError(error);
      if (classification.kind === "recovery_required") {
        return this.dependencies.recoveryRequiredWithCause(classification.error_code, error);
      }
      throw new Error("書き込み後の同期で想定外エラーが発生しました。", { cause: error });
    }
    const synchronization = this.dependencies.fromRuntimeResult(runtimeResult);
    if (synchronization.kind === "recovery_required") {
      return synchronization;
    }
    await this.refreshAuxiliaryStateAfterPostWrite(signal);
    return synchronization;
  }

  private async refreshAuxiliaryStateAfterPostWrite(signal: AbortSignal): Promise<void> {
    try {
      await this.dependencies.afterLocalStateRefresh(signal);
    } catch (error: unknown) {
      this.dependencies.recordLocalRefreshFailure(error);
    }
  }

  /** AIターン前の同期とローカル状態更新を完了します。 */
  public async requireSynchronizedBeforeAi(signal: AbortSignal): Promise<void> {
    const result = await this.requireSynchronizedResult(this.dependencies.beforeAiTurn(signal));
    void result;
    await this.dependencies.afterLocalStateRefresh(signal);
  }
}
