type RecoveryJournal = {
  readonly proposal_id: string;
  readonly operation_id: string;
  readonly final_result?: string | null | undefined;
};

type RecoveryResult = {
  readonly unresolved_journals: readonly {
    readonly proposal_id: string;
    readonly operation_id: string;
  }[];
  readonly applications: readonly {
    readonly proposal_id: string;
    readonly operations: readonly {
      readonly operation_id: string;
      readonly reason_code: string | null | undefined;
    }[];
  }[];
};

type JournalRecoveryDependencies<Journal extends RecoveryJournal, Result extends RecoveryResult> = {
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly throwIfAborted: (signal: AbortSignal) => void;
  readonly hasOperationOwner: (signal: AbortSignal) => boolean;
  readonly enqueueRecovery: (signal: AbortSignal, run: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  readonly getIncompleteJournals: () => readonly Journal[];
  readonly hasAdditionalIncomplete: () => boolean;
  readonly hasIncompleteHistory: () => boolean;
  readonly incompleteProposalExecutionIds: () => readonly string[];
  readonly incompleteGuiExecutionIds: () => readonly string[];
  readonly recover: (signal: AbortSignal) => Promise<Result>;
  readonly afterRecovery: (result: Result) => void;
};

/** 未完了のAI適用ジャーナルを排他復旧し結果を照合します。 */
export class JournalRecoveryRuntime<Journal extends RecoveryJournal, Result extends RecoveryResult> {
  private pending: boolean;
  private running = false;
  private recoveryPromise: Promise<void> | undefined;

  public constructor(private readonly dependencies: JournalRecoveryDependencies<Journal, Result>) {
    this.pending = dependencies.getIncompleteJournals().length > 0;
  }

  /** 未完了ジャーナルの復旧が必要かを返します。 */
  public hasPending(): boolean {
    return this.pending || this.dependencies.hasAdditionalIncomplete();
  }

  /** 同期を妨げる未完了履歴またはexecutionがあるか返します。 */
  public hasIncompleteForSynchronization(): boolean {
    return this.dependencies.hasIncompleteHistory() || this.dependencies.hasAdditionalIncomplete();
  }

  /** ジャーナル復旧中かを返します。 */
  public isRunning(): boolean {
    return this.running;
  }

  /** 書込後同期を妨げる別の未完了履歴がないことを確認します。 */
  public assertPostWriteSynchronizationReady(executionId: string): void {
    if (this.dependencies.hasIncompleteHistory()) {
      throw new Error("未確認の旧適用履歴があるため後続同期を開始できません。");
    }
    if (this.dependencies.incompleteProposalExecutionIds().some((id) => id !== executionId)) {
      throw new Error("別の未完了proposal executionがあるため後続同期を開始できません。");
    }
    if (this.dependencies.incompleteGuiExecutionIds().some((id) => id !== executionId)) {
      throw new Error("別の未完了GUI編集executionがあるため後続同期を開始できません。");
    }
  }

  /** 排他実行中の復旧を再利用しながら未完了ジャーナルを復旧します。 */
  public async recover(signal: AbortSignal): Promise<void> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.throwIfAborted(signal);
    if (this.dependencies.hasOperationOwner(signal)) {
      if (this.running) return;
      await this.performRecovery(signal);
      return;
    }
    const runningRecovery = this.recoveryPromise;
    if (runningRecovery != null) {
      await runningRecovery;
      this.dependencies.throwIfAborted(signal);
      return;
    }
    const recovery = this.dependencies.enqueueRecovery(
      signal,
      (operationSignal) => this.performRecovery(operationSignal),
    );
    this.recoveryPromise = recovery;
    try {
      await recovery;
    } finally {
      if (this.recoveryPromise === recovery) {
        this.recoveryPromise = undefined;
      }
    }
  }

  private async performRecovery(signal: AbortSignal): Promise<void> {
    const incomplete = this.dependencies.getIncompleteJournals();
    if (
      !this.pending
      && !this.dependencies.hasAdditionalIncomplete()
      && !incomplete.some((journal) => journal.final_result == null)
    ) {
      return;
    }
    this.pending = true;
    this.running = true;
    try {
      const result = await this.dependencies.recover(signal);
      const remainingJournals = this.dependencies.getIncompleteJournals();
      const unresolvedResultKeys = new Map<string, Set<string>>();
      const localSyncPendingKeys = new Map<string, Set<string>>();
      const includeKey = (
        keys: Map<string, Set<string>>,
        proposalId: string,
        operationId: string,
      ): void => {
        const operationIds = keys.get(proposalId) ?? new Set<string>();
        operationIds.add(operationId);
        keys.set(proposalId, operationIds);
      };
      for (const journal of result.unresolved_journals) {
        includeKey(unresolvedResultKeys, journal.proposal_id, journal.operation_id);
      }
      for (const application of result.applications) {
        for (const operation of application.operations) {
          if (operation.reason_code === "local_resync_required") {
            includeKey(localSyncPendingKeys, application.proposal_id, operation.operation_id);
          }
        }
      }
      const unexpectedRemainingJournals = remainingJournals.filter(
        (journal) => {
          const isReportedUnknown = (journal.final_result === "unknown" || journal.final_result == null)
            && unresolvedResultKeys
              .get(journal.proposal_id)
              ?.has(journal.operation_id) === true;
          const isLocalSyncPending = localSyncPendingKeys
            .get(journal.proposal_id)
            ?.has(journal.operation_id) === true;
          return !isReportedUnknown && !isLocalSyncPending;
        },
      );
      if (unexpectedRemainingJournals.length > 0) {
        throw new Error("復旧結果に含まれない未完了のAI適用ジャーナルが残っています。");
      }
      if (this.dependencies.hasAdditionalIncomplete()) {
        throw new Error("復旧後も未完了のproposal executionが残っています。");
      }
      this.dependencies.validateAbortSignal(signal);
      this.dependencies.throwIfAborted(signal);
      this.dependencies.afterRecovery(result);
      this.pending = remainingJournals.some((journal) => journal.final_result == null);
    } finally {
      this.running = false;
    }
  }
}
