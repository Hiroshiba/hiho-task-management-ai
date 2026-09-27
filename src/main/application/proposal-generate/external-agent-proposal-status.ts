import { externalAgentProposalStatusSummary } from "./external-agent-response";

/** 外部提案の現行状態または保存済み操作結果を返します。 */
export function externalAgentProposalStatus<
  TRecord extends Parameters<typeof externalAgentProposalStatusSummary>[0],
  TSavedResult,
  TResponse,
>(
  proposalId: string,
  operationIds: readonly string[],
  ports: {
    readonly parseIdentifier: (value: string) => string;
    readonly getProposal: (proposalId: string) => TRecord | undefined;
    readonly getSavedResult: (proposalId: string, operationId: string) => TSavedResult | undefined;
    readonly createConflictError: () => Error;
    readonly parseCurrentResult: (value: unknown) => unknown;
    readonly parseResponse: (value: unknown) => TResponse;
  },
): TResponse {
  const parsedProposalId = ports.parseIdentifier(proposalId);
  const parsedOperationIds = operationIds.map((operationId) => ports.parseIdentifier(operationId));
  const current = ports.getProposal(parsedProposalId);
  if (current != null) {
    if (
      current.operation_ids.length !== parsedOperationIds.length
      || current.operation_ids.some((operationId, index) => operationId !== parsedOperationIds[index])
    ) {
      throw ports.createConflictError();
    }
    return ports.parseResponse({
      operation: "proposals.status",
      proposal_id: parsedProposalId,
      operation_ids: parsedOperationIds,
      result: ports.parseCurrentResult({
        kind: "current",
        proposal: externalAgentProposalStatusSummary(current),
      }),
    });
  }
  const results = parsedOperationIds.map((operationId) => {
    const savedResult = ports.getSavedResult(parsedProposalId, operationId);
    if (savedResult != null) {
      return {
        operation_id: operationId,
        result: savedResult,
      };
    }
    return {
      operation_id: operationId,
      result: {
        kind: "unknown",
        reason_code: "journal_not_found",
        message: "指定操作の適用ジャーナルを確認できません。",
      },
    };
  });
  return ports.parseResponse({
    operation: "proposals.status",
    proposal_id: parsedProposalId,
    operation_ids: parsedOperationIds,
    result: { kind: "journals", results },
  });
}
