import type { AsanaOperationQueueInput } from "../common/ports/asana-operation-queue";
import type { ProposalApplicationHistoryRepository } from "../common/ports/proposal-application-history";
import type { StoredProposalExecutionPort } from "./apply-stored-proposal";
import { getStoredProposalOperationStatus } from "./stored-proposal-result";

type HistoryEntry =
  | { readonly kind: "history_invalid"; readonly proposal_id: string; readonly operation_id: string; readonly error_id: string }
  | { readonly kind: "confirmation_required"; readonly proposal_id: string; readonly operation_id: string; readonly target_id: string; readonly target_kind: "task" | "temporary" | "new_task"; readonly source_stage: string; readonly source_final_result: "unknown" | null }
  | { readonly kind: "synchronization_required"; readonly proposal_id: string; readonly operation_id: string; readonly target_id: string; readonly target_kind: "task" | "temporary" | "new_task"; readonly confirmed_result: "applied" | "not_applied" | "manually_adjusted" };

export type ProposalHistoryStatus = { readonly entries: readonly HistoryEntry[] };

export type HistoricalProposalOperationStatus =
  | { readonly kind: "legacy_history"; readonly source_stage: string; readonly source_final_result: "applied" | "not_applied" | "unknown" | "failed" | null; readonly confirmation_state: "not_required" | "required" | "confirmed" | "synchronized"; readonly confirmed_result: "applied" | "not_applied" | "manually_adjusted" | null }
  | { readonly kind: "unknown"; readonly reason_code: "journal_result_unknown"; readonly message: string };

type ProposalHistoryDependencies<Context> = {
  readonly repository: ProposalApplicationHistoryRepository & {
    confirm(
      proposalId: string,
      operationId: string,
      checkedTargetId: string,
      confirmedResult: "applied" | "not_applied" | "manually_adjusted",
    ): "confirmed" | "already_confirmed";
    assertSynchronizationReady(): void;
    completeSynchronization(): void;
  };
  readonly getStoredProposalRepository: () => StoredProposalExecutionPort["repository"];
  readonly validateAbortSignal: (signal: AbortSignal) => void;
  readonly assertOperationalReady: () => void;
  readonly assertReauthenticationIdle: () => void;
  readonly isOnline: () => boolean;
  readonly requireContext: () => Context;
  readonly assertContextUnchanged: (context: Context) => void;
  readonly hasPendingJournal: () => boolean;
  readonly queue: { enqueue<T>(input: AsanaOperationQueueInput<T>): Promise<T> };
  readonly coordinateReadOnly: (context: Context, signal: AbortSignal) => Promise<{ readonly synced_at: string }>;
  readonly refreshLocalTaskState: (signal: AbortSignal) => Promise<void>;
  readonly acceptReadOnlySynchronization: (syncedAt: string, signal: AbortSignal) => void;
};

/** 旧適用履歴の表示と読取同期を扱います。 */
export class ProposalHistoryWorkflow<Context> {
  public constructor(private readonly dependencies: ProposalHistoryDependencies<Context>) {}

  /** 保存済み旧履歴の未完了状態を返します。 */
  public getStatus(): ProposalHistoryStatus {
    const entries: HistoryEntry[] = this.dependencies.repository.getIncomplete().flatMap<HistoryEntry>((result) => {
      if (result.kind === "rejected") {
        return [{
          kind: "history_invalid",
          proposal_id: result.proposal_id,
          operation_id: result.operation_id,
          error_id: result.error_id,
        }];
      }
      return result.history.steps.flatMap<HistoryEntry>((step) => {
        if (step.state === "confirmation_required") {
          if (step.final_result != null && step.final_result !== "unknown") {
            throw new Error("旧適用履歴の未確定結果が元の保存結果と一致しません。");
          }
          return [{
            kind: "confirmation_required",
            proposal_id: result.history.proposal_id,
            operation_id: step.operation_id,
            target_id: step.target.kind === "task" ? step.target.gid
              : step.target.kind === "new_task" ? step.target.uuid : step.target.ref,
            target_kind: step.target.kind,
            source_stage: step.stage,
            source_final_result: step.final_result,
          }];
        }
        if (step.state === "synchronization_required") {
          if (step.confirmed_result == null) {
            throw new Error("旧適用履歴の確認済み結果がありません。");
          }
          return [{
            kind: "synchronization_required",
            proposal_id: result.history.proposal_id,
            operation_id: step.operation_id,
            target_id: step.target.kind === "task" ? step.target.gid
              : step.target.kind === "new_task" ? step.target.uuid : step.target.ref,
            target_kind: step.target.kind,
            confirmed_result: step.confirmed_result,
          }];
        }
        return [];
      });
    });
    return { entries };
  }

  /** 確認済みの対象と結果を旧適用履歴へ保存します。 */
  public confirm(input: {
    readonly proposal_id: string;
    readonly operation_id: string;
    readonly checked_target_id: string;
    readonly confirmed_result: "applied" | "not_applied" | "manually_adjusted";
  }): ProposalHistoryStatus {
    this.dependencies.repository.confirm(
      input.proposal_id,
      input.operation_id,
      input.checked_target_id,
      input.confirmed_result,
    );
    return this.getStatus();
  }

  /** 保存済み旧履歴をAsana実状態との読取同期後に確定します。 */
  public async synchronize(signal: AbortSignal): Promise<{ readonly status: ProposalHistoryStatus; readonly synced_at: string }> {
    this.dependencies.validateAbortSignal(signal);
    this.dependencies.assertOperationalReady();
    this.dependencies.assertReauthenticationIdle();
    if (!this.dependencies.isOnline()) {
      throw new Error("オフライン中は旧適用履歴の読取同期を実行できません。");
    }
    const expectedContext = this.dependencies.requireContext();
    this.dependencies.repository.assertSynchronizationReady();
    const result = await this.dependencies.queue.enqueue({
      priority: "user",
      kind: "synchronization",
      signal,
      beforeStart: () => {
        this.dependencies.assertContextUnchanged(expectedContext);
        this.dependencies.repository.assertSynchronizationReady();
        if (this.dependencies.hasPendingJournal()) {
          throw new Error("未完了の新しい適用executionがあるため旧履歴を同期できません。");
        }
      },
      run: async (operationContext) => {
        const synchronized = await this.dependencies.coordinateReadOnly(expectedContext, operationContext.signal);
        operationContext.signal.throwIfAborted();
        await this.dependencies.refreshLocalTaskState(operationContext.signal);
        operationContext.signal.throwIfAborted();
        this.dependencies.acceptReadOnlySynchronization(synchronized.synced_at, operationContext.signal);
        operationContext.signal.throwIfAborted();
        this.dependencies.repository.completeSynchronization();
        return synchronized;
      },
    });
    return { status: this.getStatus(), synced_at: result.synced_at };
  }

  /** 指定操作の旧適用履歴を返します。 */
  public getOperationStatus(proposalId: string, operationId: string): HistoricalProposalOperationStatus | undefined {
    const result = this.dependencies.repository.getByProposal(proposalId);
    if (result == null) return undefined;
    if (result.kind === "rejected") {
      return {
        kind: "unknown",
        reason_code: "journal_result_unknown",
        message: `旧適用履歴を確認できません。エラーID: ${result.error_id}`,
      };
    }
    const step = result.history.steps.find((item) => item.operation_id === operationId);
    if (step == null) return undefined;
    return {
      kind: "legacy_history",
      source_stage: step.stage,
      source_final_result: step.final_result,
      confirmation_state: step.confirmation_state,
      confirmed_result: step.confirmed_result ?? null,
    };
  }

  /** 旧履歴と保存済みexecutionから指定操作の結果を返します。 */
  public getSavedOperationStatus(
    proposalId: string,
    operationId: string,
  ): HistoricalProposalOperationStatus | ({ readonly kind: "execution" } & NonNullable<ReturnType<typeof getStoredProposalOperationStatus>>) | undefined {
    const historical = this.getOperationStatus(proposalId, operationId);
    if (historical != null) return historical;
    const stored = getStoredProposalOperationStatus(
      this.dependencies.getStoredProposalRepository(),
      proposalId,
      operationId,
    );
    if (stored == null) return undefined;
    return { kind: "execution", ...stored };
  }
}
