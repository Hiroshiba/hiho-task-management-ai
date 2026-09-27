import { z } from "zod";
import type { ErrorReporter } from "../../application/common/errors/error-reporter";
import type {
  LegacyProposalExecution,
  LegacyProposalExecutionRead,
  LegacyProposalExecutionRepository,
  LegacyProposalExecutionStep,
} from "../../application/common/ports/proposal-execution-repository";
import { identifierSchema } from "../../domain/task-write-values";
import type { PersistenceRuntime } from "./persistence-runtime";
import { parseLegacyHistoryStep } from "./proposal-application-history-record";

type ProposalIdRow = { readonly proposal_id: string };
type SourceKey = { readonly proposal_id: string; readonly operation_id: string };

/** 旧行と非実行履歴をSELECTだけで復旧表示へ変換します。 */
export class SqliteLegacyProposalExecutionRepository implements LegacyProposalExecutionRepository {
  private readonly rejectionIds = new Map<string, string>();

  public constructor(
    private readonly runtime: PersistenceRuntime,
    private readonly reporter: ErrorReporter,
  ) {}

  private reject(key: SourceKey, message: string): LegacyProposalExecutionRead {
    const cacheKey = `${key.proposal_id}\u0000${key.operation_id}`;
    let errorId = this.rejectionIds.get(cacheKey);
    if (errorId == null) {
      errorId = this.reporter.reportErrorOnce(new Error(message), {
        source: "service",
        diagnosticCode: "proposal.application",
        context: "diagnostic_storage",
        level: "error",
        operationId: key.operation_id,
      });
      this.rejectionIds.set(cacheKey, errorId);
    }
    return {
      kind: "rejected",
      proposal_id: key.proposal_id,
      operation_id: key.operation_id,
      error_id: errorId,
    };
  }

  private getHistoryByProposal(proposalId: string): LegacyProposalExecutionRead | undefined {
    const rows = this.runtime.connection.prepare<[string], unknown>(
      "SELECT * FROM legacy_application_history WHERE proposal_id = ? ORDER BY operation_id",
    ).all(proposalId);
    if (rows.length === 0) return undefined;
    const steps: LegacyProposalExecutionStep[] = [];
    for (const value of rows) {
      const key = z.object({ proposal_id: identifierSchema, operation_id: identifierSchema }).parse(value);
      try {
        steps.push(parseLegacyHistoryStep(value));
      } catch {
        return this.reject(key, "旧適用履歴を検証できません。");
      }
    }
    steps.sort((left, right) => {
      if (left.operation_order == null && right.operation_order != null) return 1;
      if (left.operation_order != null && right.operation_order == null) return -1;
      return (left.operation_order ?? 0) - (right.operation_order ?? 0)
        || left.started_at.localeCompare(right.started_at)
        || left.operation_id.localeCompare(right.operation_id);
    });
    const state: LegacyProposalExecution["state"] = steps.some(
      (step) => step.state === "confirmation_required",
    ) ? "confirmation_required" : steps.some(
      (step) => step.state === "failed",
    ) ? "failed" : "succeeded";
    return {
      kind: "execution",
      execution: {
        format: "application_journal",
        execution_id: `legacy:${proposalId}`,
        proposal_id: proposalId,
        state,
        steps,
      },
    };
  }

  /** 指定proposalの移行済み履歴と残った旧行を復旧表示へ変換します。 */
  public getByProposal(proposalId: string): LegacyProposalExecutionRead | undefined {
    const validatedId = identifierSchema.parse(proposalId);
    const residual = this.runtime.connection.prepare<[string], SourceKey>(
      "SELECT proposal_id, operation_id FROM application_journal WHERE proposal_id = ? ORDER BY operation_id LIMIT 1",
    ).get(validatedId);
    if (residual != null) {
      return this.reject(residual, "移行できない旧適用ジャーナルが残っています。");
    }
    return this.getHistoryByProposal(validatedId);
  }

  /** 未確認の履歴と移行失敗で残った旧行を読み出します。 */
  public getIncomplete(): readonly LegacyProposalExecutionRead[] {
    const residual = this.runtime.connection.prepare<[], SourceKey>(
      "SELECT proposal_id, operation_id FROM application_journal ORDER BY proposal_id, operation_id",
    ).all().map((key) => this.reject(key, "移行できない旧適用ジャーナルが残っています。"));
    const proposals = this.runtime.connection.prepare<[], ProposalIdRow>(
      "SELECT DISTINCT proposal_id FROM legacy_application_history ORDER BY proposal_id",
    ).all();
    const histories = proposals.map((row) => {
      const result = this.getHistoryByProposal(row.proposal_id);
      if (result == null) {
        throw new Error("保存済み旧適用履歴を読み出せません。");
      }
      return result;
    });
    return [...residual, ...histories.filter((result) => result.kind === "rejected"
      || result.execution.state === "confirmation_required")];
  }
}
